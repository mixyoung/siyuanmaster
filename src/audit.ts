import type * as kernel from "siyuan/kernel";
import type { AuditEntry, PluginPolicy } from "./types";

const AUDIT_STORAGE_KEY = "audit.json";
const MAX_AUDIT_ENTRIES = 2000;

function normalizeEntries(value: unknown): AuditEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is AuditEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as AuditEntry).timestamp === "string" &&
      typeof (entry as AuditEntry).operation === "string",
  );
}

export class AuditStore {
  constructor(
    private readonly api: kernel.ISiyuan,
    private readonly getPolicy: () => PluginPolicy,
  ) {}

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
    try {
      const now = Date.now();
      const cutoff =
        now - policy.audit.retentionDays * 24 * 60 * 60 * 1000;
      const entries = (await this.readAll())
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
      await this.api.logger.warn(
        "Unable to persist Agent Access audit entry",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async list(limit: number): Promise<AuditEntry[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.round(limit)));
    return (await this.readAll()).slice(-safeLimit).reverse();
  }

  private async readAll(): Promise<AuditEntry[]> {
    try {
      const stored = await this.api.storage.get(AUDIT_STORAGE_KEY);
      return normalizeEntries(await stored.json());
    } catch {
      return [];
    }
  }
}
