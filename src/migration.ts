// Technical-ID storage migration (0.5.0 phase 2).
//
// Runtime technical id is `siyuanmaster`. On first load after upgrade this
// module copies policy/audit from the legacy petal directory
// `data/storage/petal/siyuan-agent-access/` into the current scoped storage
// when (and only when) the new side is missing. Rules:
//
// - New policy always wins; never overwrite with legacy.
// - Legacy is read-only; never delete/move/write the old directory.
// - Corrupt/missing legacy → fail closed to safe default empty allowlist.
// - New audit non-empty → no audit copy; empty → bounded metadata-only copy.
// - Migration marker makes repeated startups idempotent.
//
// Tag compatibility (once mode): read both old and new attrs; write only the
// new attr going forward.

import { clonePolicy, normalizePolicy } from "./config";
import type { AuditEntry, PluginPolicy } from "./types";

/** Current technical plugin ID (matches plugin.json name). */
export const CURRENT_TECHNICAL_ID = "siyuanmaster";

/** Brand / package slug (same as technical id since 0.5.0). */
export const BRAND_SLUG = "siyuanmaster";

/**
 * Legacy technical ID from pre-0.5.0 installs. Used only for read-only
 * petal fallback and tests — never for MCP registration.
 */
export const LEGACY_TECHNICAL_ID = "siyuan-agent-access";

/** @deprecated Prefer CURRENT_TECHNICAL_ID. */
export const FUTURE_TECHNICAL_ID = CURRENT_TECHNICAL_ID;

/** Current petal storage directory under the technical ID. */
export const CURRENT_STORAGE_DIR = `data/storage/petal/${CURRENT_TECHNICAL_ID}`;

/** Legacy petal path from pre-0.5.0 installs (read-only source). */
export const LEGACY_STORAGE_DIR = `data/storage/petal/${LEGACY_TECHNICAL_ID}`;

/** @deprecated Prefer CURRENT_STORAGE_DIR. */
export const FUTURE_STORAGE_DIR = CURRENT_STORAGE_DIR;

/** Policy storage key (same under either petal path). */
export const POLICY_STORAGE_KEY = "policy.json";

/** Audit storage key (same under either petal path). */
export const AUDIT_STORAGE_KEY = "audit.json";

/** Written under the new petal after a migration pass (idempotency). */
export const MIGRATION_MARKER_KEY = "migration-from-siyuan-agent-access.json";

/** Matches AuditStore retention cap (metadata-only entries). */
export const MAX_AUDIT_ENTRIES = 2000;

/**
 * Document attr written for tagging mode `once` (current product).
 */
export const TAGGED_ONCE_ATTR = "custom-siyuanmaster-tagged";

/**
 * Legacy once-mode attr from Agent Access / pre-0.5.0 installs.
 * Still recognized on read so previously tagged docs are not re-tagged.
 */
export const LEGACY_TAGGED_ONCE_ATTR = "custom-agent-access-tagged";

/** @deprecated Prefer LEGACY_TECHNICAL_ID. */
export const OLD_PLUGIN_NAME = LEGACY_TECHNICAL_ID;

/** @deprecated Prefer LEGACY_STORAGE_DIR. */
export const OLD_STORAGE_DIR = LEGACY_STORAGE_DIR;

/** @deprecated Prefer POLICY_STORAGE_KEY. */
export const OLD_POLICY_STORAGE_KEY = POLICY_STORAGE_KEY;

/** @deprecated Prefer AUDIT_STORAGE_KEY. */
export const OLD_AUDIT_STORAGE_KEY = AUDIT_STORAGE_KEY;

/**
 * Display / docs petal path (no leading slash), e.g.
 * `data/storage/petal/siyuanmaster/policy.json`.
 * Pure string helper — does not touch the filesystem.
 */
export function petalFilePath(technicalId: string, key: string): string {
  const safeKey = key.replace(/[\\/]/g, "").trim();
  if (!safeKey) {
    throw new Error("storage key must not be empty");
  }
  const safeId = technicalId.replace(/[\\/]/g, "").trim();
  if (!safeId) {
    throw new Error("technical id must not be empty");
  }
  return `data/storage/petal/${safeId}/${safeKey}`;
}

/**
 * Path for SiYuan `/api/file/getFile` (and official Plugin.loadData), which
 * require a leading slash: `/data/storage/petal/<name>/<key>`
 * (see app/src/plugin/index.ts).
 */
export function petalApiFilePath(technicalId: string, key: string): string {
  return `/${petalFilePath(technicalId, key)}`;
}

/**
 * Legacy petal path for read-only API access (leading slash, official format).
 */
export function legacyPetalFilePath(key: string): string {
  return petalApiFilePath(LEGACY_TECHNICAL_ID, key);
}

/**
 * Current petal path for API access (leading slash, official format).
 */
export function currentPetalFilePath(key: string): string {
  return petalApiFilePath(CURRENT_TECHNICAL_ID, key);
}

/**
 * True when attrs mark the document as already once-tagged.
 * Accepts legacy or current attr; never writes the legacy key.
 */
export function isAlreadyTaggedOnce(
  attrs: Record<string, string | undefined> | null | undefined,
): boolean {
  if (!attrs) {
    return false;
  }
  return (
    attrs[TAGGED_ONCE_ATTR] === "true" ||
    attrs[LEGACY_TAGGED_ONCE_ATTR] === "true"
  );
}

export interface MigrationDecision {
  source: "new" | "old" | "default";
  migrateOld: boolean;
  policy: PluginPolicy;
  reason: string;
}

/**
 * Pure policy decision (no I/O):
 * - Prefer plausible new storage.
 * - Else accept plausible old policy (caller may copy).
 * - Else safe default empty allowlist.
 */
export function resolvePolicyAfterUpgrade(
  newStoredValue: unknown,
  oldStoredValue: unknown,
): MigrationDecision {
  if (isPlausiblePolicy(newStoredValue)) {
    return {
      source: "new",
      migrateOld: false,
      policy: normalizePolicy(newStoredValue),
      reason: "new storage already has a policy; keep current technical-id store",
    };
  }
  if (isPlausiblePolicy(oldStoredValue)) {
    return {
      source: "old",
      migrateOld: true,
      policy: normalizePolicy(oldStoredValue),
      reason:
        "legacy siyuan-agent-access storage has a usable policy; copy into siyuanmaster",
    };
  }
  return {
    source: "default",
    migrateOld: false,
    policy: normalizePolicy(undefined),
    reason: "no policy found; safe default empty allowlist",
  };
}

export function isPlausiblePolicy(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "access" in (value as Record<string, unknown>)
  );
}

/**
 * Pure audit merge: only when current is empty. Metadata-shaped entries only.
 * Does not delete either side. Caps at maxEntries (newest kept after sort).
 */
export function migrateLegacyAuditEntries(
  currentEntries: AuditEntry[],
  legacyEntries: unknown,
  maxEntries = MAX_AUDIT_ENTRIES,
): AuditEntry[] {
  if (currentEntries.length > 0) {
    return currentEntries;
  }
  return normalizeAuditEntries(legacyEntries, maxEntries);
}

export function normalizeAuditEntries(
  value: unknown,
  maxEntries = MAX_AUDIT_ENTRIES,
): AuditEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const legacy = value.filter(
    (entry): entry is AuditEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as AuditEntry).timestamp === "string" &&
      typeof (entry as AuditEntry).operation === "string",
  );
  // Drop accidental body/content fields if any slipped into storage.
  const cleaned = legacy.map((entry) => sanitizeAuditEntry(entry));
  return [...cleaned]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-maxEntries);
}

function sanitizeAuditEntry(entry: AuditEntry): AuditEntry {
  const safe: AuditEntry = {
    timestamp: entry.timestamp,
    operation: entry.operation,
    outcome: entry.outcome,
  };
  if (typeof entry.documentId === "string") {
    safe.documentId = entry.documentId;
  }
  if (typeof entry.notebookId === "string") {
    safe.notebookId = entry.notebookId;
  }
  if (typeof entry.confirmed === "boolean") {
    safe.confirmed = entry.confirmed;
  }
  if (typeof entry.contentLength === "number") {
    safe.contentLength = entry.contentLength;
  }
  if (typeof entry.tagCount === "number") {
    safe.tagCount = entry.tagCount;
  }
  if (typeof entry.targetNotebookId === "string") {
    safe.targetNotebookId = entry.targetNotebookId;
  }
  if (typeof entry.preview === "boolean") {
    safe.preview = entry.preview;
  }
  if (typeof entry.crossNotebook === "boolean") {
    safe.crossNotebook = entry.crossNotebook;
  }
  if (typeof entry.message === "string") {
    safe.message = entry.message.slice(0, 500);
  }
  return safe;
}

export interface MigrationMarker {
  schemaVersion: 1;
  from: typeof LEGACY_TECHNICAL_ID;
  to: typeof CURRENT_TECHNICAL_ID;
  completedAt: string;
  policySource: "new" | "old" | "default";
  policyCopied: boolean;
  auditCopied: boolean;
}

export function isMigrationMarker(value: unknown): value is MigrationMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    record.from === LEGACY_TECHNICAL_ID &&
    record.to === CURRENT_TECHNICAL_ID &&
    typeof record.completedAt === "string" &&
    (record.policySource === "new" ||
      record.policySource === "old" ||
      record.policySource === "default") &&
    typeof record.policyCopied === "boolean" &&
    typeof record.auditCopied === "boolean"
  );
}

/**
 * Injected I/O for storage migration. Implementations must:
 * - map current keys to scoped storage (petal/siyuanmaster)
 * - map legacy keys via /api/file/getFile using official paths
 *   `/data/storage/petal/siyuan-agent-access/<key>` (read-only)
 * - never delete or write legacy paths
 */
export interface MigrationStorageIO {
  readCurrent(key: string): Promise<unknown | undefined>;
  writeCurrent(key: string, value: unknown): Promise<void>;
  readLegacy(key: string): Promise<unknown | undefined>;
  /** Optional clock for tests. */
  now?: () => Date;
}

export interface StorageMigrationResult {
  policy: PluginPolicy;
  policySource: "new" | "old" | "default";
  policyCopied: boolean;
  auditCopied: boolean;
  markerWritten: boolean;
  alreadyMigrated: boolean;
  /** Keys written under the new technical id during this pass. */
  writtenKeys: string[];
  /** Legacy paths that were read (never written). */
  legacyReads: string[];
  reason: string;
}

/**
 * Real, idempotent, fail-closed storage migration.
 *
 * 1. Marker present → load current policy only (no legacy writes).
 * 2. Else decide policy (new wins / copy old / default), copy audit if needed,
 *    write marker. Never touches the legacy directory for write/delete.
 */
export async function runStorageMigration(
  io: MigrationStorageIO,
): Promise<StorageMigrationResult> {
  const writtenKeys: string[] = [];
  const legacyReads: string[] = [];
  const now = io.now ?? (() => new Date());

  const existingMarkerRaw = await io.readCurrent(MIGRATION_MARKER_KEY);
  if (isMigrationMarker(existingMarkerRaw)) {
    const newPolicyRaw = await io.readCurrent(POLICY_STORAGE_KEY);
    const decision = resolvePolicyAfterUpgrade(newPolicyRaw, undefined);
    return {
      policy: decision.policy,
      policySource: decision.source === "old" ? "default" : decision.source,
      policyCopied: false,
      auditCopied: false,
      markerWritten: false,
      alreadyMigrated: true,
      writtenKeys,
      legacyReads,
      reason: "migration marker present; using current scoped storage only",
    };
  }

  const newPolicyRaw = await io.readCurrent(POLICY_STORAGE_KEY);
  let oldPolicyRaw: unknown;
  if (!isPlausiblePolicy(newPolicyRaw)) {
    legacyReads.push(legacyPetalFilePath(POLICY_STORAGE_KEY));
    oldPolicyRaw = await safeReadLegacy(io, POLICY_STORAGE_KEY);
  }
  const decision = resolvePolicyAfterUpgrade(newPolicyRaw, oldPolicyRaw);

  let policyCopied = false;
  if (decision.migrateOld) {
    await io.writeCurrent(POLICY_STORAGE_KEY, decision.policy);
    writtenKeys.push(POLICY_STORAGE_KEY);
    policyCopied = true;
  }

  let auditCopied = false;
  const newAuditRaw = await io.readCurrent(AUDIT_STORAGE_KEY);
  const newAuditEntries = normalizeAuditEntries(newAuditRaw);
  if (newAuditEntries.length === 0) {
    legacyReads.push(legacyPetalFilePath(AUDIT_STORAGE_KEY));
    const oldAuditRaw = await safeReadLegacy(io, AUDIT_STORAGE_KEY);
    const merged = migrateLegacyAuditEntries([], oldAuditRaw);
    if (merged.length > 0) {
      await io.writeCurrent(AUDIT_STORAGE_KEY, merged);
      writtenKeys.push(AUDIT_STORAGE_KEY);
      auditCopied = true;
    }
  }

  const marker: MigrationMarker = {
    schemaVersion: 1,
    from: LEGACY_TECHNICAL_ID,
    to: CURRENT_TECHNICAL_ID,
    completedAt: now().toISOString(),
    policySource: decision.source,
    policyCopied,
    auditCopied,
  };
  await io.writeCurrent(MIGRATION_MARKER_KEY, marker);
  writtenKeys.push(MIGRATION_MARKER_KEY);

  return {
    policy: decision.policy,
    policySource: decision.source,
    policyCopied,
    auditCopied,
    markerWritten: true,
    alreadyMigrated: false,
    writtenKeys,
    legacyReads,
    reason: decision.reason,
  };
}

async function safeReadLegacy(
  io: MigrationStorageIO,
  key: string,
): Promise<unknown | undefined> {
  try {
    return await io.readLegacy(key);
  } catch {
    // Fail closed: treat unreadable legacy as missing.
    return undefined;
  }
}

/**
 * Parse workspace getFile responses fail-closed.
 * Accepts JSON objects/arrays or JSON text; rejects API error envelopes.
 */
export function parseWorkspaceJsonPayload(
  payload: unknown,
): unknown | undefined {
  if (payload === null || payload === undefined || payload === "") {
    return undefined;
  }
  let value: unknown = payload;
  if (typeof payload === "string") {
    try {
      value = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "code" in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>).code === "number" &&
    (value as Record<string, unknown>).code !== 0
  ) {
    return undefined;
  }
  return value;
}

/**
 * Shared helper when only current scoped storage is available and legacy
 * must be read via workspace path. Used by frontend adapters.
 */
export function createPolicyFromMigrationResult(
  result: StorageMigrationResult,
): PluginPolicy {
  return clonePolicy(result.policy);
}
