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
export const SCOPE_VERIFY_BATCH = 8;
export const MAX_PENDING_PAGE_RECEIPTS = 128;
export const SCOPE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScopePageReceipt {
  receiptId: string;
  documentId: string;
  contentHash: string;
  contentLength: number;
  start: number;
  end: number;
}

export interface ScopeVerification {
  token: string;
  revision: number;
  nextIndex: number;
  startedAt: string;
  verifiedAt?: string;
}

export interface ScopeMember {
  id: string;
  path: string;
  updated: string;
  /**
   * Content-change signal: child-block count plus the newest child-block
   * updated timestamp. SiYuan bumps the document block's own `updated` only
   * for structural changes; in-place content edits touch child blocks alone,
   * so coverage re-verification needs this marker to notice them. Not part of
   * the (structural) scope fingerprint.
   */
  contentMark: string;
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
  /** Enumeration-time content-change marker (see ScopeMember.contentMark). */
  contentMark?: string;
  /** SHA-256 of the full export every returned page of this document agreed on. */
  contentHash?: string;
  /** Full-export length in UTF-16 code units. */
  contentLength?: number;
  /** True only after the caller acknowledges a receipt, including empty documents. */
  deliveryConfirmed?: boolean;
  /** Issued/exported ranges, including legacy v1 coverage; never prove delivery. */
  servedCoverage?: Array<[number, number]>;
  /** Merged half-open [start, end) intervals explicitly acknowledged by the caller. */
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
  state?: "active" | "closed" | "superseded" | "expired";
  updatedAt?: string;
  /** Historical completion frees capacity; never substitutes for a fresh verification. */
  completedAt?: string;
  revision?: number;
  receipts?: ScopePageReceipt[];
  acknowledgedReceiptIds?: string[];
  verification?: ScopeVerification;
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
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.length) {
    throw new Error("offset must be a non-negative integer within the full export length");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("page size must be a positive integer");
  if (offset > 0 && isHighSurrogate(full.charCodeAt(offset - 1)) && isLowSurrogate(full.charCodeAt(offset))) {
    throw new Error("offset splits a UTF-16 surrogate pair; use the preceding page's nextOffset");
  }
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
    document.deliveryConfirmed === true &&
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
  if (!session.enumerationCompleted || session.persistDegraded ||
    (session.state ?? "active") !== "active" ||
    session.verification?.revision !== (session.revision ?? 0) ||
    !session.verification?.verifiedAt) return false;
  const counts = scopeCounts(session);
  return (
    session.verification.nextIndex === counts.total &&
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

/** Parses and validates a stored session payload; returns undefined on any structural doubt. */
export function parseScopeSession(raw: unknown, schemaVersion = 2): ScopeSession | undefined {
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
    (record.state !== undefined && !["active", "closed", "superseded", "expired"].includes(String(record.state))) ||
    (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0)) ||
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
          !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) ||
          range[0] < 0 || range[1] < range[0],
      ) ||
      (doc.contentHash !== undefined && typeof doc.contentHash !== "string") ||
      (doc.contentLength !== undefined && (!Number.isSafeInteger(doc.contentLength) || Number(doc.contentLength) < 0)) ||
      (doc.contentMark !== undefined && typeof doc.contentMark !== "string") ||
      (doc.deliveryConfirmed !== undefined && typeof doc.deliveryConfirmed !== "boolean")
    ) {
      return undefined;
    }
    const served = schemaVersion === 1 ? doc.coverage : doc.servedCoverage ?? [];
    if (!Array.isArray(served) || served.some(range => !Array.isArray(range) || range.length !== 2 ||
      !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] < range[0])) return undefined;
    documents[id] = {
      status: doc.status as ScopeDocumentStatus,
      path: doc.path,
      updated: doc.updated,
      contentMark: doc.contentMark as string | undefined,
      contentHash: doc.contentHash as string | undefined,
      contentLength: doc.contentLength as number | undefined,
      deliveryConfirmed: schemaVersion === 2 && doc.deliveryConfirmed === true,
      servedCoverage: served as Array<[number, number]>,
      coverage: (schemaVersion === 1 ? [] : doc.coverage as Array<[number, number]>).map((range) => [
        range[0],
        range[1],
      ]),
      lastError: typeof doc.lastError === "string" ? doc.lastError : undefined,
    };
  }
  const receipts = schemaVersion === 2 ? record.receipts ?? [] : [];
  if (!Array.isArray(receipts) || receipts.length > MAX_PENDING_PAGE_RECEIPTS || receipts.some(receipt =>
    !receipt || typeof receipt !== "object" || typeof receipt.receiptId !== "string" ||
    typeof receipt.documentId !== "string" || !documents[receipt.documentId] ||
    typeof receipt.contentHash !== "string" || !Number.isSafeInteger(receipt.contentLength) ||
    !Number.isSafeInteger(receipt.start) || !Number.isSafeInteger(receipt.end) ||
    receipt.start < 0 || receipt.end < receipt.start || receipt.end > receipt.contentLength)) return undefined;
  const acknowledged = schemaVersion === 2 ? record.acknowledgedReceiptIds ?? [] : [];
  if (!Array.isArray(acknowledged) || acknowledged.length > 256 || acknowledged.some(id => typeof id !== "string")) return undefined;
  return {
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    notebookId: record.notebookId,
    rootDocumentId: (record.rootDocumentId as string | null) ?? null,
    scopeFingerprint: record.scopeFingerprint,
    enumerationCompleted: record.enumerationCompleted,
    persistDegraded: record.persistDegraded === true || undefined,
    state: (record.state as ScopeSession["state"]) ?? "active",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : record.createdAt,
    completedAt: schemaVersion === 2 && typeof record.completedAt === "string" ? record.completedAt : undefined,
    revision: Number(record.revision ?? 0),
    receipts: receipts as ScopePageReceipt[],
    acknowledgedReceiptIds: acknowledged as string[],
    // A restart preserves acknowledgements but always requires a fresh hash verification cycle.
    verification: undefined,
    documents,
  };
}
