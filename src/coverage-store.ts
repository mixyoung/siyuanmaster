import type * as kernel from "siyuan/kernel";
import { CURRENT_STORAGE_DIR } from "./migration";
import { KERNEL_POLICY_TIMEOUT_MS, PolicyTaskQueue, type PolicyTask } from "./policy-sync";
import { confirmStorageFileMissing } from "./storage-state";
import {
  MAX_ACTIVE_SCOPE_SESSIONS,
  type ScopeDocumentState,
  type ScopeMember,
  type ScopeSession,
  documentComplete,
  mergeCoverage,
  newSessionId,
  parseScopeSession,
  pruneScopeSessions,
  scopeComplete,
} from "./scope-read";

export const COVERAGE_STORAGE_KEY = "coverage.json";

export class CoverageCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageCapacityError";
  }
}

interface CoverageFileState {
  sessions: ScopeSession[];
  schemaVersion: 1;
}

/**
 * Read-coverage ledger for "read the whole authorized directory" tasks.
 *
 * Concurrency contract: this store owns its own single-writer lane. Only
 * ledger writes are serialized here — note reads and policy saves never queue
 * behind them and vice versa. In-memory state is authoritative for the kernel
 * lifetime; every mutation is persisted write-through. A persistence failure
 * never fails the triggering read: the session is flagged `persistDegraded`,
 * surfaced through scope_read_status, and blocks overall completion.
 *
 * Durability contract mirrors the audit store: only a confirmed-missing file
 * may start an empty ledger; an unreadable or corrupt existing payload never
 * triggers a write-back, so progress history is never replaced by a fresh
 * session list.
 */
export class CoverageStore {
  private readonly queue = new PolicyTaskQueue(KERNEL_POLICY_TIMEOUT_MS);
  private sessions: ScopeSession[] | undefined;
  private loadError: string | undefined;

  constructor(private readonly api: kernel.ISiyuan) {}

  /** Sessions as currently known; empty before the first successful load. */
  snapshot(): ScopeSession[] {
    return (this.sessions ?? []).map(cloneSession);
  }

  loadErrorState(): string | undefined {
    return this.loadError;
  }

  getSession(sessionId: string): ScopeSession | undefined {
    return this.sessions?.find((session) => session.sessionId === sessionId);
  }

  /**
   * Creates a session, or resumes the existing one when the scope and its
   * full member fingerprint still match. Resumption re-verifies every
   * already-completed document against the fresh member list and demotes
   * mismatches to `changed` (coverage reset), so stale tiling can never
   * count. Rejects when the active-session capacity is exhausted.
   */
  async openScope(input: {
    notebookId: string;
    rootDocumentId: string | null;
    scopeFingerprint: string;
    members: readonly ScopeMember[];
  }): Promise<{ session: ScopeSession; resumed: boolean }> {
    await this.ensureLoaded();
    // A ledger we could not safely read must never be replaced by a fresh
    // open: refuse until the operator resolves the storage problem.
    if (this.loadError) {
      throw new Error(this.loadError);
    }
    const existing = this.sessions!.find(
      (session) =>
        session.notebookId === input.notebookId &&
        session.rootDocumentId === input.rootDocumentId &&
        session.scopeFingerprint === input.scopeFingerprint,
    );
    if (existing) {
      this.applyMemberReverification(existing, input.members);
      await this.persist();
      return { session: cloneSession(existing), resumed: true };
    }
    const incomplete = this.sessions!.filter(
      (session) => !isSessionComplete(session),
    ).length;
    if (incomplete >= MAX_ACTIVE_SCOPE_SESSIONS) {
      throw new CoverageCapacityError(
        `scope session capacity reached (${MAX_ACTIVE_SCOPE_SESSIONS} incomplete sessions); finish or shard existing scopes before opening another`,
      );
    }
    const documents: Record<string, ScopeDocumentState> = {};
    for (const member of input.members) {
      documents[member.id] = {
        status: "pending",
        path: member.path,
        updated: member.updated,
        contentMark: member.contentMark,
        coverage: [],
      };
    }
    const session: ScopeSession = {
      sessionId: newSessionId(),
      createdAt: new Date().toISOString(),
      notebookId: input.notebookId,
      rootDocumentId: input.rootDocumentId,
      scopeFingerprint: input.scopeFingerprint,
      enumerationCompleted: true,
      documents,
    };
    this.sessions!.push(session);
    this.sessions = pruneScopeSessions(this.sessions!);
    await this.persist();
    return { session: cloneSession(session), resumed: false };
  }

  /**
   * Records one successfully returned page. A content-hash or updated change
   * resets prior coverage for that document (the old version's pages no
   * longer tile the new export). Throws synchronously on unknown sessions or
   * documents so the caller can fail the request before it is served.
   */
  recordReadPage(input: {
    sessionId: string;
    documentId: string;
    updated: string;
    contentHash: string;
    contentLength: number;
    start: number;
    end: number;
  }): void {
    const session = this.requireSession(input.sessionId);
    const document = session.documents[input.documentId];
    if (!document) {
      throw new Error(
        `document is not part of scope session ${input.sessionId}`,
      );
    }
    const versionChanged =
      (document.contentHash !== undefined &&
        document.contentHash !== input.contentHash) ||
      (document.contentLength !== undefined &&
        document.contentLength !== input.contentLength) ||
      document.updated !== input.updated;
    if (versionChanged) {
      // The document moved to a different version: pages of the old export no
      // longer tile the new one, so prior coverage is discarded.
      document.contentHash = input.contentHash;
      document.contentLength = input.contentLength;
      document.updated = input.updated;
      document.coverage = [];
      if (document.status !== "blocked") document.status = "pending";
    } else if (document.contentHash === undefined) {
      document.contentHash = input.contentHash;
      document.contentLength = input.contentLength;
      // First page of a fresh version self-heals a stale attention state;
      // without this a demoted document could never become complete again.
      // `blocked` is policy state and is cleared only by an explicit retry.
      if (
        document.status === "changed" ||
        document.status === "failed" ||
        document.status === "truncated"
      ) {
        document.status = "pending";
      }
    }
    document.coverage = mergeCoverage(document.coverage, input.start, input.end);
    void this.persistBestEffort(session.sessionId);
  }

  /** Marks one document's attention state. `changed` drops stale coverage. */
  markDocument(
    sessionId: string,
    documentId: string,
    status: "failed" | "truncated" | "changed" | "blocked",
    error?: string,
  ): void {
    const session = this.requireSession(sessionId);
    const document = session.documents[documentId];
    if (!document) return;
    document.status = status;
    document.lastError = error;
    if (status === "changed") {
      document.coverage = [];
      document.contentHash = undefined;
      document.contentLength = undefined;
    }
    void this.persistBestEffort(sessionId);
  }

  /** Clears an attention state back to pending after a successful retry. */
  clearAttention(sessionId: string, documentId: string): void {
    const session = this.requireSession(sessionId);
    const document = session.documents[documentId];
    if (!document) return;
    if (document.status !== "pending") {
      document.status = "pending";
      document.lastError = undefined;
    }
    void this.persistBestEffort(sessionId);
  }

  /**
   * Re-applies a fresh member list to a stored session: every completed or
   * attention-marked document whose `updated` moved is demoted to `changed`
   * with coverage reset, so completion can only be claimed against the
   * documents as they exist now.
   */
  async resyncSession(
    sessionId: string,
    members: readonly ScopeMember[],
  ): Promise<ScopeSession> {
    const session = this.requireSession(sessionId);
    this.applyMemberReverification(session, members);
    await this.persistBestEffort(sessionId);
    return cloneSession(session);
  }

  private requireSession(sessionId: string): ScopeSession {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`unknown scope session: ${sessionId}`);
    }
    return session;
  }

  private applyMemberReverification(
    session: ScopeSession,
    members: readonly ScopeMember[],
  ): void {
    const fresh = new Map(members.map((member) => [member.id, member]));
    for (const [id, document] of Object.entries(session.documents)) {
      const member = fresh.get(id);
      if (!member) continue;
      // SiYuan bumps the document block's `updated` only on structural
      // changes; in-place content edits leave it untouched, so the child-block
      // contentMark carries the content half of the comparison.
      if (
        member.updated === document.updated &&
        (member.contentMark ?? "") === (document.contentMark ?? "")
      ) {
        continue;
      }
      // A document changed since it was covered or marked: old coverage no
      // longer describes the current export. Demote and reset.
      if (documentComplete(document) || document.status !== "pending") {
        document.status = "changed";
        document.lastError = "document changed since it was last covered";
      }
      document.updated = member.updated;
      document.contentMark = member.contentMark;
      document.coverage = [];
      document.contentHash = undefined;
      document.contentLength = undefined;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.sessions) return;
    this.sessions = await this.queue.run(async (task: PolicyTask) => {
      const wait = task.wait;
      let stored: Awaited<ReturnType<kernel.ISiyuan["storage"]["get"]>>;
      try {
        stored = await wait(() => this.api.storage.get(COVERAGE_STORAGE_KEY));
      } catch {
        const missing = await this.probeMissing(wait);
        if (missing) return [];
        this.loadError = "coverage storage read failed while the file exists";
        return [];
      }
      let parsed: unknown;
      try {
        parsed = await wait(() => stored.json());
      } catch {
        this.loadError = "stored coverage ledger is unreadable (corrupt)";
        return [];
      }
      const record = parsed as Partial<CoverageFileState>;
      if (
        !record ||
        typeof record !== "object" ||
        !Array.isArray(record.sessions) ||
        record.sessions.some(
          (session) =>
            !session ||
            typeof session !== "object" ||
            !session.sessionId,
        )
      ) {
        this.loadError = "stored coverage ledger has an invalid structure";
        return [];
      }
      const sessions: ScopeSession[] = [];
      for (const raw of record.sessions) {
        const session = parseSession(raw);
        if (!session) {
          this.loadError = "stored coverage ledger contains an invalid session";
          return [];
        }
        sessions.push(session);
      }
      return sessions;
    });
  }

  private async probeMissing(
    wait: <T>(action: () => Promise<T>) => Promise<T>,
  ): Promise<boolean | undefined> {
    try {
      return await confirmStorageFileMissing(
        this.api,
        CURRENT_STORAGE_DIR,
        COVERAGE_STORAGE_KEY,
        wait,
      );
    } catch {
      return undefined;
    }
  }

  private async persist(): Promise<void> {
    await this.queue.run(async (task: PolicyTask) => {
      // The flag describes the previous write attempt; a fresh write starts clean.
      for (const session of this.sessions ?? []) {
        delete session.persistDegraded;
      }
      const payload: CoverageFileState = {
        schemaVersion: 1,
        sessions: this.sessions ?? [],
      };
      await task.wait(() =>
        this.api.storage.put(
          COVERAGE_STORAGE_KEY,
          JSON.stringify(payload),
        ),
      );
    });
  }

  private async persistBestEffort(sessionId: string): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      const session = this.getSession(sessionId);
      if (session) session.persistDegraded = true;
      try {
        await this.api.logger.warn(
          "SiYuanMaster coverage persistence failed; progress flagged degraded (tool result unaffected)",
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // Logging cannot change the persistence outcome.
      }
    }
  }
}

function parseSession(raw: unknown): ScopeSession | undefined {
  return parseScopeSession(raw);
}

function isSessionComplete(session: ScopeSession): boolean {
  return scopeComplete(session);
}

function cloneSession(session: ScopeSession): ScopeSession {
  const documents: Record<string, ScopeDocumentState> = {};
  for (const [id, document] of Object.entries(session.documents)) {
    documents[id] = {
      ...document,
      coverage: document.coverage.map(
        (range) => [range[0], range[1]] as [number, number],
      ),
    };
  }
  return { ...session, documents };
}
