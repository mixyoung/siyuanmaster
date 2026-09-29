import type * as kernel from "siyuan/kernel";
import {
  AUDIT_STORAGE_KEY,
  MAX_AUDIT_ENTRIES,
  normalizeAuditEntries,
} from "./migration";
import type { AuditEntry, PluginPolicy } from "./types";

/**
 * Metadata-only audit store.
 *
 * Durability contract (best-effort, explicitly surfaced):
 * - Appends are serialized through a single promise chain so concurrent
 *   tool calls cannot read-modify-write over each other and drop entries.
 * - A storage READ failure (transport/API error) is distinct from an empty
 *   log: on read failure nothing is written back, so a transient fault can
 *   never replace the existing history with a single-entry log.
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

  /**
   * Reads the stored log. Throws when the storage read itself fails — the
   * caller must not treat that as an empty log and overwrite history.
   * A missing or non-array payload IS a legitimate empty log.
   */
  private async readExisting(): Promise<AuditEntry[]> {
    const stored = await this.api.storage.get(AUDIT_STORAGE_KEY);
    let parsed: unknown;
    try {
      parsed = await stored.json();
    } catch {
      // Missing key / empty payload → empty log (legitimate first run).
      return [];
    }
    return normalizeAuditEntries(parsed);
  }
}
