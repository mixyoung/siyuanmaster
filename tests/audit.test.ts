import { describe, expect, it, vi } from "vitest";
import { AuditStore } from "../src/audit";
import { DEFAULT_POLICY, clonePolicy } from "../src/config";
import type * as kernel from "siyuan/kernel";
import type { AuditEntry, PluginPolicy } from "../src/types";

const AUDIT_FILE = {
  name: "audit.json",
  isDir: false,
  isSymlink: false,
  updated: 1,
};

/**
 * Contract-shaped storage mock (per siyuan/kernel.d.ts):
 * - `get()` rejects while the file does not exist;
 * - readDir confirms file existence without silently omitting stat failures;
 * - `put()` persists the payload (optionally failing).
 */
function mockApi(options: {
  putImpl?: (key: string, value: string) => Promise<void>;
} = {}): {
  api: kernel.ISiyuan;
  setPayload: (value: string | undefined) => void;
  getPayload: () => string | undefined;
  storage: {
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
  warn: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
} {
  let payload: string | undefined;
  const get = vi.fn(async () => {
    if (payload === undefined) {
      throw new Error("file does not exist");
    }
    return {
      json: async () => JSON.parse(payload!) as unknown,
    };
  });
  const list = vi.fn(async () =>
    payload === undefined ? [] : [AUDIT_FILE],
  );
  const put = vi.fn(
    options.putImpl ??
      (async (_key: string, value: string) => {
        payload = value;
      }),
  );
  const warn = vi.fn(async () => undefined);
  const probe = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: payload === undefined ? [] : [AUDIT_FILE] }),
  }));
  const api = {
    storage: { get, list, put },
    client: { fetch: probe },
    logger: { warn },
  } as unknown as kernel.ISiyuan;
  return { api, setPayload: (v) => (payload = v), getPayload: () => payload, storage: { get, list, put }, warn, probe };
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
  it("writes the first entry when the log file does not exist yet", async () => {
    const { api, storage, warn } = mockApi();
    const store = new AuditStore(api, auditEnabledPolicy);
    await store.record(entry("create"));
    expect(storage.put).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(
      storage.put.mock.calls[0]![1] as string,
    ) as AuditEntry[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.operation).toBe("create");
    expect(store.writeFailureCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("serializes concurrent records so no entry is lost", async () => {
    const { api, storage } = mockApi();
    const store = new AuditStore(api, auditEnabledPolicy);
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

  it("does not overwrite history when the read fails but the file exists", async () => {
    const { api, storage, getPayload, warn } = mockApi();
    const store = new AuditStore(api, auditEnabledPolicy);
    // Seed one real entry so the file exists on "disk".
    await store.record(entry("seed"));
    const onDisk = getPayload();
    expect(onDisk).toBeDefined();
    // Now the read itself fails although the file exists (transport fault).
    storage.get.mockImplementation(async () => {
      throw new Error("storage transport failure");
    });
    await store.record(entry("create"));
    expect(storage.put).toHaveBeenCalledTimes(1); // only the seed write
    expect(store.writeFailureCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getPayload()).toBe(onDisk); // history untouched
  });

  it("does not overwrite history when both the read and existence probe fail", async () => {
    const { api, storage, setPayload, getPayload, warn, probe } = mockApi();
    const onDisk = JSON.stringify([
      { ...entry("seed"), timestamp: new Date().toISOString() },
    ]);
    setPayload(onDisk);
    storage.get.mockRejectedValue(new Error("storage read unavailable"));
    probe.mockRejectedValue(new Error("directory probe unavailable"));
    const store = new AuditStore(api, auditEnabledPolicy);

    await store.record(entry("create"));

    expect(storage.put).not.toHaveBeenCalled();
    expect(getPayload()).toBe(onDisk);
    expect(store.writeFailureCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(["present", "unknown"])("does not trust an incomplete storage.list when readDir is %s", async state => {
    const { api, storage, setPayload, getPayload, probe } = mockApi();
    const onDisk = JSON.stringify([{ ...entry("seed"), timestamp: new Date().toISOString() }]);
    setPayload(onDisk);
    storage.get.mockRejectedValue(new Error("read failed"));
    storage.list.mockResolvedValue([]);
    if (state === "unknown") probe.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ code: 500 }) });
    const store = new AuditStore(api, auditEnabledPolicy);
    await store.record(entry("create"));
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.list).not.toHaveBeenCalled();
    expect(getPayload()).toBe(onDisk);
    expect(store.writeFailureCount).toBe(1);
  });

  it.each([
    ["null", null],
    ["object", { entries: [] }],
    ["non-record array item", [null]],
    ["missing timestamp", [{ operation: "seed", outcome: "allowed" }]],
    ["invalid timestamp", [{ timestamp: "not-a-date", operation: "seed", outcome: "allowed" }]],
    ["missing operation", [{ timestamp: "2026-10-04T00:00:00.000Z", outcome: "allowed" }]],
    ["empty operation", [{ timestamp: "2026-10-04T00:00:00.000Z", operation: " ", outcome: "allowed" }]],
    ["missing outcome", [{ timestamp: "2026-10-04T00:00:00.000Z", operation: "seed" }]],
    ["invalid outcome", [{ timestamp: "2026-10-04T00:00:00.000Z", operation: "seed", outcome: "unknown" }]],
    ["partially invalid array", [
      { timestamp: "2026-10-04T00:00:00.000Z", operation: "seed", outcome: "allowed" },
      { operation: "broken" },
    ]],
  ])("preserves a parseable log with an invalid structure: %s", async (_name, payload) => {
    const { api, storage, setPayload, getPayload, warn } = mockApi();
    const onDisk = JSON.stringify(payload);
    setPayload(onDisk);
    const store = new AuditStore(api, auditEnabledPolicy);

    await store.record(entry("create"));

    expect(storage.put).not.toHaveBeenCalled();
    expect(getPayload()).toBe(onDisk);
    expect(store.writeFailureCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("preserves a corrupt existing log instead of replacing it", async () => {
    const { api, storage, setPayload, getPayload, warn } = mockApi();
    setPayload("{ this is not json");
    const store = new AuditStore(api, auditEnabledPolicy);
    await store.record(entry("create"));
    expect(storage.put).not.toHaveBeenCalled();
    expect(store.writeFailureCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getPayload()).toBe("{ this is not json"); // untouched
  });

  it("keeps the tool call succeeding when persistence fails, and counts it", async () => {
    const { api, warn } = mockApi({
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
    const { api, storage } = mockApi();
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
    const { api, setPayload, getPayload } = mockApi();
    setPayload(JSON.stringify(seeded));
    const store = new AuditStore(api, auditEnabledPolicy);
    for (let index = 0; index < 5; index += 1) {
      await store.record(entry(`new-${index}`));
    }
    const persisted = JSON.parse(getPayload()!) as AuditEntry[];
    expect(persisted).toHaveLength(2000);
    expect(persisted.at(-1)!.operation).toBe("new-4");
    expect(persisted.some((item) => item.operation === "seed-0")).toBe(false);
  });
});
