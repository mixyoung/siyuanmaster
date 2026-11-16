import type * as kernel from "siyuan/kernel";
import { CURRENT_STORAGE_DIR } from "./migration";
import { KERNEL_POLICY_TIMEOUT_MS, PolicyTaskQueue, type PolicyTask } from "./policy-sync";
import { confirmStorageFileMissing } from "./storage-state";
import {
  MAX_ACTIVE_SCOPE_SESSIONS, MAX_STORED_SCOPE_SESSIONS, MAX_PENDING_PAGE_RECEIPTS,
  SCOPE_SESSION_TTL_MS, SCOPE_VERIFY_BATCH, documentComplete, mergeCoverage,
  newSessionId, parseScopeSession,
  type ScopeDocumentState, type ScopeMember, type ScopeSession, type ScopePageReceipt,
} from "./scope-read";

export const COVERAGE_STORAGE_KEY = "coverage.json";
export class CoverageCapacityError extends Error {
  constructor(message: string) { super(message); this.name = "CoverageCapacityError"; }
}
export interface VerificationObservation {
  documentId: string;
  contentHash?: string;
  contentLength?: number;
  error?: string;
  blocked?: boolean;
}

/** Metadata transactions share one bounded lane. Body exports and policy saves run outside it. */
export class CoverageStore {
  private readonly queue = new PolicyTaskQueue(KERNEL_POLICY_TIMEOUT_MS);
  private sessions?: ScopeSession[];
  private loadError?: string;

  constructor(private readonly api: kernel.ISiyuan) {}

  snapshot(): ScopeSession[] { return clone(this.sessions ?? []); }
  loadErrorState(): string | undefined { return this.loadError; }
  getSession(id: string): ScopeSession | undefined {
    const session = this.sessions?.find(item => item.sessionId === id);
    return session ? clone(session) : undefined;
  }
  async load(): Promise<void> { await this.queue.run(task => this.ensureLoaded(task)); }

  async openScope(input: {
    notebookId: string; rootDocumentId: string | null; scopeFingerprint: string; members: readonly ScopeMember[];
  }): Promise<{ session: ScopeSession; resumed: boolean }> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      this.expireInactive();
      const existing = this.sessions!.find(session => session.state === "active" &&
        session.notebookId === input.notebookId && session.rootDocumentId === input.rootDocumentId &&
        session.scopeFingerprint === input.scopeFingerprint);
      if (existing) {
        if (existing.completedAt) this.assertAvailableSlot(existing);
        this.applyMembers(existing, input.members);
        this.touch(existing); // Resume never reuses an earlier verification certificate.
        await this.persist(task);
        return { session: clone(existing), resumed: true };
      }
      // An explicitly reopened scope supersedes older membership snapshots, retaining their history.
      const superseded = this.sessions!.filter(session => session.state === "active" &&
        session.notebookId === input.notebookId && session.rootDocumentId === input.rootDocumentId);
      const active = this.sessions!.filter(session => session.state === "active" &&
        !session.completedAt && !superseded.includes(session));
      if (active.length >= MAX_ACTIVE_SCOPE_SESSIONS) {
        throw new CoverageCapacityError(`scope session capacity reached (${MAX_ACTIVE_SCOPE_SESSIONS}); close an abandoned session with close_scope_read`);
      }
      for (const session of superseded) { session.state = "superseded"; this.touch(session); }
      const documents: Record<string, ScopeDocumentState> = {};
      for (const member of input.members) documents[member.id] = {
        status: "pending", path: member.path, updated: member.updated, contentMark: member.contentMark,
        coverage: [], servedCoverage: [], deliveryConfirmed: false,
      };
      const session: ScopeSession = {
        sessionId: newSessionId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        notebookId: input.notebookId, rootDocumentId: input.rootDocumentId, scopeFingerprint: input.scopeFingerprint,
        enumerationCompleted: true, state: "active", revision: 0, documents, receipts: [], acknowledgedReceiptIds: [],
      };
      this.sessions!.push(session);
      this.prune();
      await this.persist(task);
      return { session: clone(session), resumed: false };
    });
  }

  /** Issues a durable receipt. Merely exporting a page never increments acknowledged coverage. */
  async recordReadPage(input: {
    sessionId: string; documentId: string; updated: string; contentHash: string;
    contentLength: number; start: number; end: number;
  }): Promise<ScopePageReceipt> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireActive(input.sessionId);
      if (session.completedAt) this.assertAvailableSlot(session);
      const document = session.documents[input.documentId];
      if (!document) throw new Error("document is not part of this scope session");
      if (![input.start, input.end, input.contentLength].every(Number.isSafeInteger) ||
        input.start < 0 || input.end < input.start || input.end > input.contentLength) throw new Error("invalid page interval");
      const changed = document.contentHash !== undefined &&
        (document.contentHash !== input.contentHash || document.contentLength !== input.contentLength || document.updated !== input.updated);
      if (changed) this.resetDocument(session, input.documentId, "changed", "document version changed");
      document.contentHash = input.contentHash;
      document.contentLength = input.contentLength;
      document.updated = input.updated;
      // Only a successful authorized body read clears attention, including a restored permission.
      document.status = "pending";
      delete document.lastError;
      const receipts = session.receipts!;
      let receipt = receipts.find(item => item.documentId === input.documentId && item.contentHash === input.contentHash &&
        item.start === input.start && item.end === input.end);
      if (!receipt) {
        if (receipts.length >= MAX_PENDING_PAGE_RECEIPTS) throw new CoverageCapacityError("acknowledge outstanding pages before reading more pages");
        receipt = { receiptId: newSessionId(), documentId: input.documentId, contentHash: input.contentHash,
          contentLength: input.contentLength, start: input.start, end: input.end };
        receipts.push(receipt);
      }
      document.servedCoverage = mergeCoverage(document.servedCoverage ?? [], input.start, input.end);
      this.touch(session);
      await this.persist(task);
      return clone(receipt);
    });
  }

  async acknowledge(sessionId: string, receiptIds: string[]): Promise<ScopeSession> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireActive(sessionId);
      const ids = [...new Set(receiptIds)];
      const receipts = ids.filter(id => !session.acknowledgedReceiptIds!.includes(id)).map(id => {
        const receipt = session.receipts!.find(item => item.receiptId === id);
        const document = receipt && session.documents[receipt.documentId];
        if (!receipt || !document || document.status !== "pending" || document.contentHash !== receipt.contentHash ||
          document.contentLength !== receipt.contentLength) throw new Error("unknown, stale, or blocked page receipt; re-read the page");
        return receipt;
      });
      for (const receipt of receipts) {
        const document = session.documents[receipt.documentId];
        document.coverage = mergeCoverage(document.coverage, receipt.start, receipt.end);
        document.deliveryConfirmed = true;
        session.acknowledgedReceiptIds!.push(receipt.receiptId);
      }
      session.receipts = session.receipts!.filter(receipt => !ids.includes(receipt.receiptId));
      session.acknowledgedReceiptIds = session.acknowledgedReceiptIds!.slice(-256);
      if (receipts.length) this.touch(session);
      await this.persist(task);
      return clone(session);
    });
  }

  async markDocument(sessionId: string, documentId: string, status: "failed" | "truncated" | "changed" | "blocked", error?: string): Promise<void> {
    await this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireActive(sessionId);
      if (!session.documents[documentId]) return;
      if (status === "changed") this.resetDocument(session, documentId, status, error);
      else { session.documents[documentId].status = status; session.documents[documentId].lastError = error; }
      this.touch(session);
      await this.persist(task);
    });
  }

  async resyncSession(sessionId: string, members: readonly ScopeMember[]): Promise<ScopeSession> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireActive(sessionId);
      if (this.applyMembers(session, members)) this.touch(session);
      await this.persist(task);
      return clone(session);
    });
  }

  async close(sessionId: string, state: "closed" | "superseded" = "closed"): Promise<ScopeSession> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireSession(sessionId);
      session.state = state; session.receipts = [];
      this.touch(session);
      await this.persist(task);
      return clone(session);
    });
  }

  async beginVerification(sessionId: string, cursor?: string): Promise<{ session: ScopeSession; token: string; documentIds: string[] }> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireActive(sessionId);
      if (!session.enumerationCompleted || Object.values(session.documents).some(document => !documentComplete(document))) {
        throw new Error("acknowledge all document pages before final verification");
      }
      if (cursor) {
        if (!session.verification || session.verification.token !== cursor || session.verification.revision !== session.revision || session.verification.verifiedAt) {
          throw new Error("verification cursor is stale; restart verification without a cursor");
        }
      } else {
        if (session.completedAt) this.assertAvailableSlot(session);
        delete session.completedAt;
        session.verification = { token: newSessionId(), revision: session.revision!, nextIndex: 0, startedAt: new Date().toISOString() };
      }
      session.updatedAt = new Date().toISOString();
      await this.persist(task);
      return { session: clone(session), token: session.verification.token,
        documentIds: Object.keys(session.documents).slice(session.verification.nextIndex, session.verification.nextIndex + SCOPE_VERIFY_BATCH) };
    });
  }

  async finishVerificationBatch(sessionId: string, token: string, observations: VerificationObservation[]): Promise<ScopeSession> {
    return this.queue.run(async task => {
      await this.ensureLoaded(task);
      const session = this.requireActive(sessionId);
      const verification = session.verification;
      if (!verification || verification.token !== token || verification.revision !== session.revision) throw new Error("scope progress changed during verification; restart verification");
      const expected = Object.keys(session.documents).slice(verification.nextIndex, verification.nextIndex + SCOPE_VERIFY_BATCH);
      if (expected.length !== observations.length || expected.some((id, i) => id !== observations[i].documentId)) throw new Error("incomplete verification batch");
      let invalid = false;
      for (const observation of observations) {
        const document = session.documents[observation.documentId];
        if (observation.error || observation.blocked) {
          document.status = observation.blocked ? "blocked" : "failed";
          document.lastError = observation.error;
          invalid = true;
        } else if (observation.contentHash !== document.contentHash || observation.contentLength !== document.contentLength) {
          this.resetDocument(session, observation.documentId, "changed", "full export hash changed; re-read this document");
          invalid = true;
        }
      }
      if (invalid) this.touch(session);
      else {
        session.updatedAt = new Date().toISOString();
        verification.nextIndex += observations.length;
        verification.token = newSessionId();
        if (verification.nextIndex === Object.keys(session.documents).length) {
          verification.verifiedAt = new Date().toISOString();
          session.completedAt = verification.verifiedAt;
        }
      }
      await this.persist(task);
      return clone(session);
    });
  }

  private touch(session: ScopeSession): void {
    session.revision = (session.revision ?? 0) + 1;
    session.updatedAt = new Date().toISOString();
    delete session.verification;
    delete session.completedAt;
  }
  private resetDocument(session: ScopeSession, id: string, status: ScopeDocumentState["status"], error?: string): void {
    const doc = session.documents[id];
    doc.status = status; doc.lastError = error; doc.coverage = []; doc.servedCoverage = []; doc.deliveryConfirmed = false;
    delete doc.contentHash; delete doc.contentLength;
    session.receipts = session.receipts!.filter(receipt => receipt.documentId !== id);
  }
  private applyMembers(session: ScopeSession, members: readonly ScopeMember[]): boolean {
    let changed = false;
    const byId = new Map(members.map(member => [member.id, member]));
    for (const [id, doc] of Object.entries(session.documents)) {
      const member = byId.get(id);
      if (!member || member.path !== doc.path) { session.state = "superseded"; changed = true; continue; }
      if (member.updated === doc.updated && (member.contentMark ?? "") === (doc.contentMark ?? "")) continue;
      this.resetDocument(session, id, "changed", "document metadata changed; re-read this document");
      doc.updated = member.updated; doc.contentMark = member.contentMark;
      changed = true;
    }
    return changed;
  }
  private requireSession(id: string): ScopeSession {
    const session = this.sessions?.find(item => item.sessionId === id);
    if (!session) throw new Error(`unknown scope session: ${id}`);
    return session;
  }
  private assertAvailableSlot(session: ScopeSession): void {
    if (this.sessions!.filter(item => item !== session && item.state === "active" && !item.completedAt).length >= MAX_ACTIVE_SCOPE_SESSIONS) {
      throw new CoverageCapacityError("close an abandoned session before resuming completed work");
    }
  }
  private requireActive(id: string): ScopeSession {
    this.expireInactive();
    const session = this.requireSession(id);
    if (session.state !== "active") throw new Error(`scope session is ${session.state}; open a new scope`);
    return session;
  }
  private expireInactive(): void {
    for (const session of this.sessions ?? []) if (session.state === "active" &&
      Date.now() - Date.parse(session.updatedAt ?? session.createdAt) > SCOPE_SESSION_TTL_MS) {
      session.state = "expired"; session.receipts = []; this.touch(session);
    }
  }
  private prune(): void {
    while (this.sessions!.length > MAX_STORED_SCOPE_SESSIONS) {
      const candidate = this.sessions!.filter(session => session.state !== "active" || session.completedAt)
        .sort((a, b) => Date.parse(a.updatedAt ?? a.createdAt) - Date.parse(b.updatedAt ?? b.createdAt))[0];
      if (!candidate) throw new CoverageCapacityError("no inactive session can be pruned");
      this.sessions = this.sessions!.filter(session => session !== candidate);
    }
  }
  private async ensureLoaded(task: PolicyTask): Promise<void> {
    if (this.loadError) throw new Error(this.loadError);
    if (this.sessions) return;
    try {
      let stored: Awaited<ReturnType<kernel.ISiyuan["storage"]["get"]>>;
      try { stored = await task.wait(() => this.api.storage.get(COVERAGE_STORAGE_KEY)); }
      catch (error) {
        task.check();
        if (await confirmStorageFileMissing(this.api, CURRENT_STORAGE_DIR, COVERAGE_STORAGE_KEY, task.wait)) { this.sessions = []; return; }
        throw error;
      }
      const value = await task.wait(() => stored.json()) as { schemaVersion?: number; sessions?: unknown[] };
      if (!value || ![1, 2].includes(value.schemaVersion ?? 0) || !Array.isArray(value.sessions)) throw new Error("invalid coverage ledger");
      const sessions = value.sessions.map(raw => parseScopeSession(raw, value.schemaVersion));
      if (sessions.some(session => !session)) throw new Error("invalid coverage session");
      this.sessions = sessions as ScopeSession[];
    } catch (error) {
      this.loadError = `coverage storage is unreadable or invalid: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.loadError);
    }
  }
  private async persist(task: PolicyTask): Promise<void> {
    // Mark dirty before IO so concurrent status readers cannot report memory-only progress complete.
    for (const session of this.sessions ?? []) session.persistDegraded = true;
    const payload = JSON.stringify({ schemaVersion: 2, sessions: this.sessions!.map(session => ({ ...session, persistDegraded: undefined })) });
    try {
      await task.wait(() => this.api.storage.put(COVERAGE_STORAGE_KEY, payload));
      const stored = await task.wait(() => this.api.storage.get(COVERAGE_STORAGE_KEY));
      const observed = await task.wait(() => stored.json());
      if (JSON.stringify(observed) !== payload) throw new Error("coverage write readback mismatch");
      for (const session of this.sessions!) delete session.persistDegraded;
    } catch (error) {
      throw new Error(`coverage persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
