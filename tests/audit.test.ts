import { describe, expect, it, vi } from "vitest";
import { AuditStore } from "../src/audit";
import { DEFAULT_POLICY, clonePolicy } from "../src/config";
import type * as kernel from "siyuan/kernel";
import type { AuditEntry, PluginPolicy } from "../src/types";

interface MockStorage {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

function mockApi(options: {
  stored?: string;
  getImpl?: (key: string) => Promise<{ json: () => Promise<unknown> }>;
  putImpl?: (key: string, value: string) => Promise<void>;
}): { api: kernel.ISiyuan; storage: MockStorage; warn: ReturnType<typeof vi.fn> } {
  const storedPayload = options.stored;
  const storage: MockStorage = {
    get: vi.fn(
      options.getImpl ??
        (async () => ({
          json: async () => {
            if (storedPayload === undefined) {
              throw new Error("missing key");
            }
            return JSON.parse(storedPayload) as unknown;
          },
        })),
    ),
    put: vi.fn(
      options.putImpl ?? (async () => undefined),
    ),
  };
  const warn = vi.fn(async () => undefined);
  const api = {
    storage,
    logger: { warn },
  } as unknown as kernel.ISiyuan;
  return { api, storage, warn };
}

function auditEnabledPolicy(): PluginPolicy {
  const policy = clonePolicy(DEFAULT_POLICY);
  policy.audit.enabled = true;
  policy.audit.recordReadOperations = true;
  return policy;
}

function entry(operation: string): Omit<AuditEntry, "timestamp"> {
  return { operation, outcome: "allowed" };
}

describe("AuditStore durability contract", () => {
  it("serializes concurrent records so no entry is lost", async () => {
    const { api, storage } = mockApi({});
    const store = new AuditStore(api, auditEnabledPolicy);
    // Read-modify-write state: get returns whatever put last persisted, with
    // a delay on the first read so both records overlap in time.
    let payload: string | undefined;
    storage.put.mockImplementation(async (_key: string, value: string) => {
      payload = value;
    });
    let getCalls = 0;
    storage.get.mockImplementation(async () => {
      getCalls += 1;
      const seq = getCalls;
      await new Promise((resolve) => setTimeout(resolve, seq === 1 ? 20 : 1));
      return {
        json: async () => {
          if (payload === undefined) {
            throw new Error("missing key");
          }
          return JSON.parse(payload) as unknown;
        },
      };
    });
    await Promise.all([
      store.record(entry("create")),
      store.record(entry("append")),
    ]);
    expect(storage.put).toHaveBeenCalledTimes(2);
    const lastPut = storage.put.mock.calls.at(-1)![1] as string;
    const persisted = JSON.parse(lastPut) as AuditEntry[];
    expect(persisted.map((item) => item.operation).sort()).toEqual([
      "append",
      "create",
    ]);
  });

  it("treats a missing log as empty and writes the first entry", async () => {
    const { api, storage } = mockApi({ stored: undefined });
    const store = new AuditStore(api, auditEnabledPolicy);
    await store.record(entry("create"));
    expect(storage.put).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(
      storage.put.mock.calls[0]![1] as string,
    ) as AuditEntry[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.operation).toBe("create");
  });

  it("does not overwrite history when the storage read fails", async () => {
    const { api, storage, warn } = mockApi({});
    storage.get.mockImplementation(async () => {
      throw new Error("storage transport failure");
    });
    const store = new AuditStore(api, auditEnabledPolicy);
    await store.record(entry("create"));
    // Read failure ≠ empty log: nothing may be written back, otherwise a
    // transient fault would replace the whole history with one entry.
    expect(storage.put).not.toHaveBeenCalled();
    expect(store.writeFailureCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the tool call succeeding when persistence fails, and counts it", async () => {
    const { api, storage, warn } = mockApi({
      putImpl: async () => {
        throw new Error("disk full");
      },
    });
    const store = new AuditStore(api, auditEnabledPolicy);
    await expect(store.record(entry("create"))).resolves.toBeUndefined();
    expect(store.writeFailureCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips records entirely when audit is disabled", async () => {
    const { api, storage } = mockApi({});
    const policy = clonePolicy(DEFAULT_POLICY);
    policy.audit.enabled = false;
    const store = new AuditStore(api, () => policy);
    await store.record(entry("create"));
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("caps retained entries at the storage maximum", async () => {
    const seeded: AuditEntry[] = Array.from(
      { length: 1999 },
      (_, index) => ({
        operation: `seed-${index}`,
        outcome: "allowed" as const,
        timestamp: new Date(Date.now() - 3_600_000 + index).toISOString(),
      }),
    );
    let payload: string | undefined = JSON.stringify(seeded);
    const { api, storage } = mockApi({});
    storage.put.mockImplementation(async (_key: string, value: string) => {
      payload = value;
    });
    storage.get.mockImplementation(async () => ({
      json: async () => JSON.parse(payload!) as unknown,
    }));
    const store = new AuditStore(api, auditEnabledPolicy);
    for (let index = 0; index < 5; index += 1) {
      await store.record(entry(`new-${index}`));
    }
    const persisted = JSON.parse(payload!) as AuditEntry[];
    expect(persisted).toHaveLength(2000);
    expect(persisted.at(-1)!.operation).toBe("new-4");
    expect(persisted.some((item) => item.operation === "seed-0")).toBe(false);
  });
});
