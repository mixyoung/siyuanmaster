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

  /**
   * Reads the stored log. Branches follow the storage contract
   * (`get()` rejects when the file does not exist):
   * - `get()` rejects and the file is genuinely absent → empty log
   *   (legitimate first run; the caller may create the log).
   * - `get()` rejects but the file exists (directory listing) → transport
   *   failure; throws so nothing is written back over the history.
   * - `get()` resolves but the payload cannot be parsed → the existing log
   *   is corrupt; throws so it is preserved rather than replaced.
   */
  private async readExisting(): Promise<AuditEntry[]> {
    let stored: Awaited<ReturnType<kernel.ISiyuan["storage"]["get"]>>;
    try {
      stored = await this.api.storage.get(AUDIT_STORAGE_KEY);
    } catch {
      if (await this.auditFileExists()) {
        throw new Error(
          "audit storage read failed while the log file exists",
        );
      }
      return [];
    }
    let parsed: unknown;
    try {
      parsed = await stored.json();
    } catch {
      throw new Error(
        "stored audit log is unreadable (corrupt); refusing to overwrite",
      );
    }
    return normalizeAuditEntries(parsed);
  }

  /** Best-effort existence probe used to separate "missing" from "read
   * failure". Falls back to "missing" when listing is unavailable. */
  private async auditFileExists(): Promise<boolean> {
    try {
      const entries = await this.api.storage.list(".");
      return entries.some((entry) => entry.name === AUDIT_STORAGE_KEY);
    } catch {
      return false;
    }
  }
}
