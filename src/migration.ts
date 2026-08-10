// Future technical-ID switch decision helpers.
//
// Current transition policy (0.4.0): keep plugin.json technical name as
// `siyuan-agent-access` so existing installs, petal storage, and the
// original 16 fully-qualified tool names
// (`plugin__siyuan_agent_access__*`) stay intact. A single SiYuan plugin
// cannot register two native MCP namespaces (kernel derives the namespace
// from plugin.json name). Switching the technical ID to `siyuanmaster`
// later requires a dual-plugin or migration-bridge release — not an
// automatic startup rewrite in this version.
//
// This module is pure decision logic only. It does NOT:
// - run at plugin load,
// - delete old storage,
// - rewrite petal paths,
// - claim that a storage migration has already happened.
//
// Callers (future dual-plugin bridge / offline CLI) may use the pure
// functions below to decide which policy/audit wins when both old and
// new storage locations are present.

import { normalizePolicy } from "./config";
import type { AuditEntry, PluginPolicy } from "./types";

/** Current technical plugin ID (transition period). */
export const CURRENT_TECHNICAL_ID = "siyuan-agent-access";

/** Brand / package slug (not the plugin.json technical name yet). */
export const BRAND_SLUG = "siyuanmaster";

/** Future technical ID target when a dual-plugin or migration bridge ships. */
export const FUTURE_TECHNICAL_ID = "siyuanmaster";

/** Current petal storage directory under the retained technical ID. */
export const CURRENT_STORAGE_DIR = `data/storage/petal/${CURRENT_TECHNICAL_ID}`;

/** Future petal path if technical ID is eventually switched. */
export const FUTURE_STORAGE_DIR = `data/storage/petal/${FUTURE_TECHNICAL_ID}`;

/** Policy storage key (same under either petal path). */
export const POLICY_STORAGE_KEY = "policy.json";

/** Audit storage key (same under either petal path). */
export const AUDIT_STORAGE_KEY = "audit.json";

/**
 * @deprecated Prefer CURRENT_TECHNICAL_ID. Kept for tests that name the
 * pre-brand path explicitly.
 */
export const OLD_PLUGIN_NAME = CURRENT_TECHNICAL_ID;

/**
 * @deprecated Prefer CURRENT_STORAGE_DIR.
 */
export const OLD_STORAGE_DIR = CURRENT_STORAGE_DIR;

/**
 * @deprecated Prefer POLICY_STORAGE_KEY.
 */
export const OLD_POLICY_STORAGE_KEY = POLICY_STORAGE_KEY;

/**
 * @deprecated Prefer AUDIT_STORAGE_KEY.
 */
export const OLD_AUDIT_STORAGE_KEY = AUDIT_STORAGE_KEY;

/**
 * Builds a workspace-relative petal file path for a given technical ID.
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
 * Legacy helper name: path under the current technical ID petal.
 */
export function legacyPetalFilePath(key: string): string {
  return petalFilePath(CURRENT_TECHNICAL_ID, key);
}

export interface MigrationDecision {
  /** Which config wins if a future dual-location merge is performed. */
  source: "new" | "old" | "default";
  /** True when the old location should be copied into the new location. */
  migrateOld: boolean;
  /** The effective policy after the pure decision. */
  policy: PluginPolicy;
  /** Human-readable reason (for audit / CLI output, not startup claims). */
  reason: string;
}

/**
 * Pure decision for a future technical-ID switch:
 * - Prefer the new storage location when it already has a plausible policy.
 * - Otherwise accept a plausible old policy (migrateOld = true).
 * - Otherwise fall back to the safe default empty allowlist.
 *
 * Does not perform I/O and is not invoked by plugin onload in 0.4.0.
 */
export function resolvePolicyAfterUpgrade(
  newStoredValue: unknown,
  oldStoredValue: unknown,
): MigrationDecision {
  const hasNew = isPlausiblePolicy(newStoredValue);
  const hasOld = isPlausiblePolicy(oldStoredValue);
  if (hasNew) {
    return {
      source: "new",
      migrateOld: false,
      policy: normalizePolicy(newStoredValue),
      reason:
        "new storage already has a policy; future ID switch would keep it",
    };
  }
  if (hasOld) {
    return {
      source: "old",
      migrateOld: true,
      policy: normalizePolicy(oldStoredValue),
      reason:
        "old storage has a usable policy; future dual-plugin bridge would copy it",
    };
  }
  return {
    source: "default",
    migrateOld: false,
    policy: normalizePolicy(undefined),
    reason: "no policy found; safe default empty allowlist",
  };
}

function isPlausiblePolicy(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "access" in (value as Record<string, unknown>)
  );
}

/**
 * Pure merge decision for audit history when a future ID switch finds an
 * empty new store and a populated old store. Does not delete either side.
 */
export function migrateLegacyAuditEntries(
  currentEntries: AuditEntry[],
  legacyEntries: unknown,
  maxEntries = 2000,
): AuditEntry[] {
  const legacy = Array.isArray(legacyEntries)
    ? legacyEntries.filter(
        (entry): entry is AuditEntry =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as AuditEntry).timestamp === "string" &&
          typeof (entry as AuditEntry).operation === "string",
      )
    : [];
  if (currentEntries.length > 0 || legacy.length === 0) {
    return currentEntries;
  }
  return [...legacy]
    .sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    )
    .slice(-maxEntries);
}
