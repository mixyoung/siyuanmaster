import { computeContentHash } from "./write-transaction";

/** Hard cap on documents per scope session. Larger scopes must be sharded
 * by opening child-root scopes instead; a session is never silently trimmed. */
export const MAX_SCOPE_DOCUMENTS = 2000;
/** Incomplete sessions allowed at once; older complete sessions are pruned first. */
export const MAX_ACTIVE_SCOPE_SESSIONS = 4;
/** Total sessions kept in plugin storage (oldest pruned first, complete before incomplete). */
export const MAX_STORED_SCOPE_SESSIONS = 12;
/** Pending documents returned per open_scope_read / scope_read_status page. */
export const SCOPE_NEXT_DOCUMENTS = 50;
/** Hard cap on documents listed by scope_read_status with includeDocuments. */
export const SCOPE_STATUS_DOCUMENTS = 200;

export interface ScopeMember {
  id: string;
  path: string;
  updated: string;
}

export type ScopeDocumentStatus =
  | "pending"
  | "failed"
  | "truncated"
  | "changed"
  | "blocked";

export interface ScopeDocumentState {
  status: ScopeDocumentStatus;
  path: string;
  updated: string;
  /** SHA-256 of the full export every returned page of this document agreed on. */
  contentHash?: string;
  /** Full-export length in UTF-16 code units. */
  contentLength?: number;
  /** Merged half-open [start, end) intervals of page content actually returned. */
  coverage: Array<[number, number]>;
  lastError?: string;
}

export interface ScopeSession {
  sessionId: string;
  createdAt: string;
  notebookId: string;
  rootDocumentId: string | null;
  scopeFingerprint: string;
  /** The full member list was enumerated without a cap rejection or read error. */
  enumerationCompleted: boolean;
  /** A coverage persistence write failed; state is memory-only until recovered. */
  persistDegraded?: boolean;
  documents: Record<string, ScopeDocumentState>;
}

export interface ScopeCounts {
  total: number;
  pending: number;
  complete: number;
  failed: number;
  truncated: number;
  changed: number;
  blocked: number;
}

/**
 * Fingerprint over the scope descriptor plus the complete ordered member list
 * (id, physical path, updated). A count-preserving membership swap, an
 * in-scope move (path change), or a member replacement with identical
 * max(updated) all change this value; `totalCount + max(updated)` alone would
 * not. Members are sorted by path internally; callers cannot skew the hash
 * by passing an unsorted list.
 */
export async function computeScopeFingerprint(
  scope: { notebookId: string; rootDocumentId: string | null },
  members: readonly ScopeMember[],
): Promise<string> {
  const ordered = [...members].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const canonical = JSON.stringify({
    notebookId: scope.notebookId,
    rootDocumentId: scope.rootDocumentId,
    members: ordered.map((member) => [member.id, member.path, member.updated]),
  });
  return computeContentHash(canonical);
}

/** SHA-256 over the sorted accessible-notebook set; binds search cursors to policy scope. */
export async function computeAccessFingerprint(
  notebookIds: readonly string[],
): Promise<string> {
  return computeContentHash([...notebookIds].sort().join("\n"));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export interface PagedSlice {
  content: string;
  /** Position after the last returned character, or null when the end was reached. */
  nextOffset: number | null;
}

/**
 * Extracts [offset, offset + maxChars) as a page without ever splitting a
 * surrogate pair: a boundary landing between a high and low surrogate extends
 * the page by one code unit. Units are UTF-16 code units, matching JS string
 * `slice`/`length` and the reported `contentLength`.
 */
export function slicePage(full: string, offset: number, maxChars: number): PagedSlice {
  let end = Math.min(offset + maxChars, full.length);
  if (
    end < full.length &&
    isHighSurrogate(full.charCodeAt(end - 1)) &&
    isLowSurrogate(full.charCodeAt(end))
  ) {
    end += 1;
  }
  return {
    content: full.slice(offset, end),
    nextOffset: end < full.length ? end : null,
  };
}

/** Merges one half-open interval into a sorted, non-overlapping interval list.
 * Touching intervals merge: consecutive pages [0,20000) and [20000,40000)
 * must fold into [0,40000) for exact-coverage evaluation. */
export function mergeCoverage(
  coverage: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = coverage.map(
    (range) => [range[0], range[1]] as [number, number],
  );
  if (end > start) ranges.push([start, end]);
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to);
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

/** True when merged coverage is exactly [0, contentLength). */
export function coverageIsExact(
  coverage: ReadonlyArray<readonly [number, number]>,
  contentLength: number,
): boolean {
  if (contentLength === 0) return coverage.length === 0;
  return (
    coverage.length === 1 &&
    coverage[0][0] === 0 &&
    coverage[0][1] === contentLength
  );
}

/** Completion is derived from data, never stored as a bare flag. */
export function documentComplete(document: ScopeDocumentState): boolean {
  return (
    document.status === "pending" &&
    document.contentHash !== undefined &&
    document.contentLength !== undefined &&
    coverageIsExact(document.coverage, document.contentLength)
  );
}

export function scopeCounts(session: ScopeSession): ScopeCounts {
  const counts: ScopeCounts = {
    total: 0,
    pending: 0,
    complete: 0,
    failed: 0,
    truncated: 0,
    changed: 0,
    blocked: 0,
  };
  for (const document of Object.values(session.documents)) {
    counts.total += 1;
    if (documentComplete(document)) {
      counts.complete += 1;
      continue;
    }
    counts[document.status] += 1;
  }
  return counts;
}

/**
 * Overall completion. All four conjuncts are required: the enumeration ended
 * by exhaustion against the same member list, coverage writes are persisted,
 * every member's returned pages tile [0, contentLength) under one content
 * hash, and no member is unread or in an attention state. Direct tail reads,
 * duplicate reads, and overlapping reads cannot close a gap, so they can
 * never satisfy this predicate.
 */
export function scopeComplete(session: ScopeSession): boolean {
  if (!session.enumerationCompleted || session.persistDegraded) return false;
  const counts = scopeCounts(session);
  return (
    counts.failed === 0 &&
    counts.truncated === 0 &&
    counts.changed === 0 &&
    counts.blocked === 0 &&
    counts.complete === counts.total
  );
}

export function newSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Sorts prune candidates: complete sessions first, then by age. */
function pruneOrder(a: ScopeSession, b: ScopeSession): number {
  const aComplete = scopeComplete(a);
  const bComplete = scopeComplete(b);
  if (aComplete !== bComplete) return aComplete ? -1 : 1;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/**
 * Bounds stored sessions. Complete sessions are pruned before incomplete
 * ones; the most recent MAX_ACTIVE_SCOPE_SESSIONS incomplete sessions are
 * always kept. Never drops a session that is still within the active window.
 */
export function pruneScopeSessions(
  sessions: readonly ScopeSession[],
): ScopeSession[] {
  const kept = [...sessions].sort(pruneOrder);
  if (kept.length <= MAX_STORED_SCOPE_SESSIONS) {
    return kept.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  const pruned = kept.slice(kept.length - MAX_STORED_SCOPE_SESSIONS);
  const activeIncomplete = pruned.filter((session) => !scopeComplete(session));
  if (activeIncomplete.length > MAX_ACTIVE_SCOPE_SESSIONS) {
    // Keep the newest incomplete sessions even beyond the stored cap boundary
    // when the alternative would be silently dropping live work.
    const protect = new Set(
      [...sessions]
        .filter((session) => !scopeComplete(session))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, MAX_ACTIVE_SCOPE_SESSIONS)
        .map((session) => session.sessionId),
    );
    const result = sessions.filter(
      (session) => protect.has(session.sessionId) || scopeComplete(session),
    );
    return result
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(MAX_STORED_SCOPE_SESSIONS, protect.size));
  }
  return pruned.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Parses and validates a stored session payload; returns undefined on any structural doubt. */
export function parseScopeSession(raw: unknown): ScopeSession | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    typeof record.createdAt !== "string" ||
    typeof record.notebookId !== "string" ||
    (record.rootDocumentId !== null && typeof record.rootDocumentId !== "string") ||
    typeof record.scopeFingerprint !== "string" ||
    typeof record.enumerationCompleted !== "boolean" ||
    !record.documents ||
    typeof record.documents !== "object" ||
    Array.isArray(record.documents)
  ) {
    return undefined;
  }
  const documents: Record<string, ScopeDocumentState> = {};
  for (const [id, value] of Object.entries(record.documents)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const doc = value as Record<string, unknown>;
    if (
      typeof doc.path !== "string" ||
      typeof doc.updated !== "string" ||
      !["pending", "failed", "truncated", "changed", "blocked"].includes(
        String(doc.status),
      ) ||
      !Array.isArray(doc.coverage) ||
      doc.coverage.some(
        (range) =>
          !Array.isArray(range) ||
          range.length !== 2 ||
          typeof range[0] !== "number" ||
          typeof range[1] !== "number",
      ) ||
      (doc.contentHash !== undefined && typeof doc.contentHash !== "string") ||
      (doc.contentLength !== undefined && typeof doc.contentLength !== "number")
    ) {
      return undefined;
    }
    documents[id] = {
      status: doc.status as ScopeDocumentStatus,
      path: doc.path,
      updated: doc.updated,
      contentHash: doc.contentHash as string | undefined,
      contentLength: doc.contentLength as number | undefined,
      coverage: (doc.coverage as Array<[number, number]>).map((range) => [
        range[0],
        range[1],
      ]),
      lastError: typeof doc.lastError === "string" ? doc.lastError : undefined,
    };
  }
  return {
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    notebookId: record.notebookId,
    rootDocumentId: (record.rootDocumentId as string | null) ?? null,
    scopeFingerprint: record.scopeFingerprint,
    enumerationCompleted: record.enumerationCompleted,
    persistDegraded: record.persistDegraded === true || undefined,
    documents,
  };
}
