import type * as kernel from "siyuan/kernel";
import {
  AUDIT_STORAGE_KEY,
  CURRENT_STORAGE_DIR,
  MAX_AUDIT_ENTRIES,
  isCurrentAuditEntry,
  normalizeAuditEntries,
} from "./migration";
import {
  KERNEL_POLICY_TIMEOUT_MS,
  PolicySyncBlockedError,
  PolicySyncTimeoutError,
  PolicyTaskQueue,
  serializeStorageKey,
  type PolicyTask,
} from "./policy-sync";
import { confirmStorageFileMissing } from "./storage-state";
import type { AuditEntry, PluginPolicy } from "./types";

type AuditFileState = "present" | "missing" | "unknown";
/**
 * Metadata-only audit store.
 *
 * Durability contract (best-effort, explicitly surfaced):
 * - Appends are serialized through this store's OWN single-writer lane so
 *   concurrent tool calls cannot read-modify-write over each other and drop
 *   entries. The lane is deliberately separate from the policy-storage
 *   queue: a slow or hung policy write must never stall (or fail) audited
 *   tool calls, and audit traffic must never queue ahead of a policy save.
 * - Read branches follow the storage contract (`get()` rejects when the
 *   file does not exist): a genuinely absent log is an empty log; a read
 *   failure on an existing file, or an existing-but-corrupt payload, never
 *   triggers a write-back, so history is never replaced by a single entry.
 * - A storage WRITE failure does not fail the audited tool call; the plugin
 *   stays available and the miss is reported via logger.warn plus the
 *   `writeFailures` counter exposed through get_audit_log.
 */
export class AuditStore {
  private readonly queue = new PolicyTaskQueue(KERNEL_POLICY_TIMEOUT_MS);
  private writeFailures = 0;

  constructor(
    private readonly api: kernel.ISiyuan,
    private readonly getPolicy: () => PluginPolicy,
  ) {}

  /** Entries whose persistence failed since plugin start (in-memory). */
  get writeFailureCount(): number {
    return this.writeFailures;
  }

  /**
   * Runs one action against the audit file on this store's own lane plus the
   * shared audit-key mutex. The migration's audit copy routes through here so
   * every writer of audit.json serializes through a single queue without the
   * policy lane ever waiting on audit traffic (or vice versa).
   */
  serializeFileWrite<T>(
    action: (task?: PolicyTask) => Promise<T>,
  ): Promise<T> {
    return this.queue.run(task =>
      serializeStorageKey(AUDIT_STORAGE_KEY, () => action(task)),
    );
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
    let counted = false;
    const failed = () => {
      if (!counted) this.writeFailures += 1;
      counted = true;
    };
    try {
      // Lane serialization (this queue) plus the shared per-key mutex: the
      // migration's audit copy runs on the policy lane and writes the same
      // key, so both read-modify-write cycles must be atomic against each
      // other without coupling the two lanes' queues.
      await this.queue.run(task =>
        serializeStorageKey(AUDIT_STORAGE_KEY, () =>
          this.appendEntry(entry, failed, task),
        ),
      );
    } catch (error) {
      // Deadline/blocked outcomes end the wait without persisting the entry;
      // appendEntry already counted storage failures internally. Either way
      // the audited tool call must not fail because of the audit ledger.
      if (error instanceof PolicySyncTimeoutError || error instanceof PolicySyncBlockedError) failed();
    }
  }

  async list(limit: number): Promise<AuditEntry[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.round(limit)));
    return (await this.readExisting()).slice(-safeLimit).reverse();
  }

  private async appendEntry(
    entry: Omit<AuditEntry, "timestamp">,
    failed: () => void,
    task?: PolicyTask,
  ): Promise<void> {
    const wait = task?.wait ?? (<T>(action: () => Promise<T>) => action());
    try {
      const now = Date.now();
      const cutoff =
        now - this.getPolicy().audit.retentionDays * 24 * 60 * 60 * 1000;
      // readExisting distinguishes "no log yet" from "storage read failed":
      // the latter throws and we skip the write-back entirely.
      const entries = (await this.readExisting(task))
        .filter((item) => Date.parse(item.timestamp) >= cutoff)
        .slice(-(MAX_AUDIT_ENTRIES - 1));
      entries.push({
        ...entry,
        timestamp: new Date(now).toISOString(),
      });
      await wait(() => this.api.storage.put(AUDIT_STORAGE_KEY, JSON.stringify(entries)));
    } catch (error) {
      failed();
      try {
        await wait(() => this.api.logger.warn(
          "SiYuanMaster audit persistence failed; entry not recorded (tool result unaffected)",
          error instanceof Error ? error.message : String(error),
        ));
      } catch {
        // Logging cannot change the persistence outcome or extend an expired task.
      }
    }
  }

  /** Only a successful existence probe may establish an empty first-run log. */
  private async readExisting(task?: PolicyTask): Promise<AuditEntry[]> {
    const wait = task?.wait ?? (<T>(action: () => Promise<T>) => action());
    let stored: Awaited<ReturnType<kernel.ISiyuan["storage"]["get"]>>;
    try {
      stored = await wait(() => this.api.storage.get(AUDIT_STORAGE_KEY));
    } catch {
      const state = await this.auditFileState(task);
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
      parsed = await wait(() => stored.json());
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

  private async auditFileState(task?: PolicyTask): Promise<AuditFileState> {
    try {
      return await confirmStorageFileMissing(this.api, CURRENT_STORAGE_DIR, AUDIT_STORAGE_KEY, task?.wait)
        ? "missing" : "present";
    } catch {
      return "unknown";
    }
  }
}
