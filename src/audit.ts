import type * as kernel from "siyuan/kernel";
import {
  AUDIT_STORAGE_KEY,
  MAX_AUDIT_ENTRIES,
  normalizeAuditEntries,
} from "./migration";
import type { AuditEntry, PluginPolicy } from "./types";

type AuditFileState = "present" | "missing" | "unknown";
const AUDIT_OUTCOMES = new Set<AuditEntry["outcome"]>([
  "allowed", "denied", "confirmation_required", "failed",
]);

function isCurrentAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.timestamp === "string" &&
    Number.isFinite(Date.parse(entry.timestamp)) &&
    typeof entry.operation === "string" &&
    entry.operation.trim().length > 0 &&
    typeof entry.outcome === "string" &&
    AUDIT_OUTCOMES.has(entry.outcome as AuditEntry["outcome"])
  );
}

/**
 * Metadata-only audit store.
 *
 * Durability contract (best-effort, explicitly surfaced):
 * - Appends are serialized through a single promise chain so concurrent
 *   tool calls cannot read-modify-write over each other and drop entries.
 * - Read branches follow the storage contract (`get()` rejects when the
 *   file does not exist): a genuinely absent log is an empty log; a read
 *   failure on an existing file, or an existing-but-corrupt payload, never
 *   triggers a write-back, so history is never replaced by a single entry.
 * - A storage WRITE failure does not fail the audited tool call; the plugin
 *   stays available and the miss is reported via logger.warn plus the
 *   `writeFailures` counter exposed through get_audit_log.
 */
export class AuditStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private writeFailures = 0;

  constructor(
    private readonly api: kernel.ISiyuan,
    private readonly getPolicy: () => PluginPolicy,
  ) {}

  /** Entries whose persistence failed since plugin start (in-memory). */
  get writeFailureCount(): number {
    return this.writeFailures;
  }

  async record(
    entry: Omit<AuditEntry, "timestamp">,
    isReadOperation = false,
  ): Promise<void> {
    const policy = this.getPolicy();
    if (
      !policy.audit.enabled ||
      (isReadOperation && !policy.audit.recordReadOperations)
    ) {
      return;
    }
    // Serialize the whole read-modify-write; a rejected task must not break
    // the chain for subsequent records.
    const task = this.writeQueue.then(() => this.appendEntry(entry));
    this.writeQueue = task.catch(() => undefined);
    await task.catch(() => undefined);
  }

  async list(limit: number): Promise<AuditEntry[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.round(limit)));
    return (await this.readExisting()).slice(-safeLimit).reverse();
  }

  private async appendEntry(
    entry: Omit<AuditEntry, "timestamp">,
  ): Promise<void> {
    try {
      const now = Date.now();
      const cutoff =
        now - this.getPolicy().audit.retentionDays * 24 * 60 * 60 * 1000;
      // readExisting distinguishes "no log yet" from "storage read failed":
      // the latter throws and we skip the write-back entirely.
      const entries = (await this.readExisting())
        .filter((item) => Date.parse(item.timestamp) >= cutoff)
        .slice(-(MAX_AUDIT_ENTRIES - 1));
      entries.push({
        ...entry,
        timestamp: new Date(now).toISOString(),
      });
      await this.api.storage.put(
        AUDIT_STORAGE_KEY,
        JSON.stringify(entries),
      );
    } catch (error) {
      this.writeFailures += 1;
      await this.api.logger.warn(
        "SiYuanMaster audit persistence failed; entry not recorded (tool result unaffected)",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Only a successful existence probe may establish an empty first-run log. */
  private async readExisting(): Promise<AuditEntry[]> {
    let stored: Awaited<ReturnType<kernel.ISiyuan["storage"]["get"]>>;
    try {
      stored = await this.api.storage.get(AUDIT_STORAGE_KEY);
    } catch {
      const state = await this.auditFileState();
      if (state === "missing") {
        return [];
      }
      throw new Error(
        state === "present"
          ? "audit storage read failed while the log file exists"
          : "audit file existence is unknown; refusing to overwrite",
      );
    }
    let parsed: unknown;
    try {
      parsed = await stored.json();
    } catch {
      throw new Error(
        "stored audit log is unreadable (corrupt); refusing to overwrite",
      );
    }
    // Legacy migration normalization is intentionally tolerant. Current
    // history must pass validation before it can be cleaned and written back.
    if (!Array.isArray(parsed) || !parsed.every(isCurrentAuditEntry)) {
      throw new Error(
        "stored audit log has an invalid structure; refusing to overwrite",
      );
    }
    return normalizeAuditEntries(parsed);
  }

  private async auditFileState(): Promise<AuditFileState> {
    try {
      const entries = await this.api.storage.list(".");
      if (
        !Array.isArray(entries) ||
        entries.some((entry) => !entry || typeof entry.name !== "string")
      ) {
        return "unknown";
      }
      return entries.some((entry) => entry.name === AUDIT_STORAGE_KEY)
        ? "present"
        : "missing";
    } catch {
      return "unknown";
    }
  }
}
