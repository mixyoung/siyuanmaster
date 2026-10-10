import { describe, expect, it, vi } from "vitest";
import type * as kernel from "siyuan/kernel";
import { clonePolicy, computePolicyFingerprint, DEFAULT_POLICY, normalizePolicy } from "../src/config";
import { AUDIT_STORAGE_KEY, MIGRATION_MARKER_KEY, POLICY_STORAGE_KEY } from "../src/migration";
import type { PluginPolicy } from "../src/types";
import { deferred, frontendRuntime, kernelRuntime, nextTurn, runtimeClock } from "./helpers/plugin-runtime";

const A = normalizePolicy({
  ...DEFAULT_POLICY,
  access: { ...DEFAULT_POLICY.access, selectedNotebookIds: ["20260101000000-aaaaaaa"] },
});
const B = clonePolicy(DEFAULT_POLICY);
const marker = {
  schemaVersion: 1, from: "siyuan-agent-access", to: "siyuanmaster",
  completedAt: "2026-10-06T00:00:00.000Z", policySource: "new", policyCopied: false, auditCopied: false, policyInitialized: true,
};
const audit = [{ timestamp: "2026-10-06T00:00:00.000Z", operation: "read", outcome: "allowed" }];

type Reply = Record<string, unknown> & { ready: boolean; policy: PluginPolicy; policyFingerprint: string; saveState?: string };
interface KernelRuntime {
  policy: PluginPolicy;
  audit: { record(entry: { operation: string; outcome: "allowed" }): Promise<void> };
  reloadPolicy(): Promise<Reply>;
  savePolicy(policy: PluginPolicy): Promise<Reply>;
  status(): Promise<Reply>;
}
interface FrontendRuntime {
  policy: PluginPolicy;
  bootstrapped: boolean;
  notebooks: unknown[];
  dockElement: { innerHTML: string };
  kernel: { rpc: { call: { reloadPolicy(): Promise<Reply>; savePolicy(policy: PluginPolicy): Promise<Reply> } } };
  saveData: ReturnType<typeof vi.fn>;
  loadData: ReturnType<typeof vi.fn>;
  refreshNotebooks: ReturnType<typeof vi.fn>;
  bootstrap(): Promise<void>;
  refreshAll(): Promise<void>;
  onDataChanged(): Promise<void>;
  persistPolicy(policy: PluginPolicy): Promise<void>;
}

async function fixture(options: { marker?: boolean; empty?: boolean } = {}) {
  const current = new Map<string, unknown>(options.empty ? [] : [
    [POLICY_STORAGE_KEY, clonePolicy(A)], [AUDIT_STORAGE_KEY, structuredClone(audit)],
  ]);
  if (options.marker !== false) current.set(MIGRATION_MARKER_KEY, structuredClone(marker));
  const legacy = new Map<string, unknown>();
  const failures = new Set<string>();
  const clock = runtimeClock();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const api = {
    plugin: { lifecycle: {} },
    agent: { registerCapability: vi.fn(async () => undefined), unregisterCapability: vi.fn(async () => undefined) },
    rpc: {
      bind: vi.fn(async (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers.set(name, handler); }),
      unbind: vi.fn(async (name: string) => { handlers.delete(name); }),
    },
    client: { fetch: vi.fn(async (path: string, init: { body: string }) => {
      const target = (JSON.parse(init.body) as { path: string }).path;
      if (path === "/api/file/readDir") {
        const files = target.endsWith("/siyuanmaster") ? current : legacy;
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: [...files.keys()].map(name => ({ name })) }) };
      }
      const key = target.split("/").at(-1)!;
      if (!legacy.has(key)) return { ok: true, status: 202, text: async () => JSON.stringify({ code: 404 }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(legacy.get(key)) };
    }) },
    storage: {
      get: vi.fn(async (key: string) => {
        if (failures.has(key) || !current.has(key)) throw new Error(`read unavailable: ${key}`);
        return { json: async () => structuredClone(current.get(key)) };
      }),
      put: vi.fn(async (key: string, value: string) => { current.set(key, JSON.parse(value)); }),
      list: vi.fn(async () => [...current.keys()].map(name => ({ name }))),
    },
    logger: { warn: vi.fn(async () => undefined), info: vi.fn(async () => undefined) },
  };
  const backend = await kernelRuntime<KernelRuntime>(api as unknown as kernel.ISiyuan, clock);
  const host = await frontendRuntime<FrontendRuntime>();
  const frontend = host.plugin;
  frontend.notebooks = [];
  frontend.dockElement = { innerHTML: "" };
  frontend.refreshNotebooks = vi.fn(async () => undefined);
  frontend.loadData = vi.fn(async () => { throw new Error("Frontend cache must not load policy"); });
  frontend.saveData = vi.fn(async () => ({ code: 1, msg: "Frontend storage must not be used" }));
  frontend.kernel = { rpc: { call: {
    reloadPolicy: () => backend.reloadPolicy(),
    savePolicy: value => backend.savePolicy(value),
  } } };
  return { current, legacy, failures, api, backend, frontend, handlers, ...host };
}

describe("policy storage and recovery", () => {
  it("preserves all current files when marker and policy reads fail", async () => {
    const f = await fixture();
    const before = JSON.stringify([...f.current]);
    f.legacy.set(POLICY_STORAGE_KEY, { ...A, access: { mode: "denylist", selectedNotebookIds: [], defaultDecision: "allow" } });
    f.legacy.set(AUDIT_STORAGE_KEY, [{ ...audit[0], operation: "legacy" }]);
    [MIGRATION_MARKER_KEY, POLICY_STORAGE_KEY, AUDIT_STORAGE_KEY].forEach(key => f.failures.add(key));
    const reply = await f.backend.reloadPolicy();
    expect(reply.ready).toBe(false);
    expect(f.backend.policy.access.selectedNotebookIds).toEqual([]);
    expect(f.api.storage.put).not.toHaveBeenCalled();
    expect(JSON.stringify([...f.current])).toBe(before);
  });

  it("does not confirm a common default fallback or use the frontend cache", async () => {
    const f = await fixture();
    f.failures.add(POLICY_STORAGE_KEY);
    await f.frontend.bootstrap();
    expect(f.frontend.dockElement.innerHTML).not.toContain("策略已就绪");
    expect((await f.backend.status()).ready).toBe(false);
    expect(f.frontend.loadData).not.toHaveBeenCalled();
    f.failures.clear();
    await f.frontend.refreshAll();
    expect(f.frontend.dockElement.innerHTML).toContain("策略已就绪");
    expect(f.frontend.policy).toEqual(A);
  });

  it("uses only the kernel writer for saves, with a persisted readback", async () => {
    const f = await fixture();
    await f.frontend.bootstrap();
    await f.frontend.persistPolicy(B);
    expect(f.frontend.saveData).not.toHaveBeenCalled();
    expect(f.current.get(POLICY_STORAGE_KEY)).toEqual(B);
    expect(f.frontend.policy).toEqual(B);
    expect(f.frontend.dockElement.innerHTML).toContain("策略已就绪");
    expect((await f.backend.status()).policyFingerprint).toBe(await computePolicyFingerprint(B));
  });

  it("reports an uncertain failed write without publishing the draft", async () => {
    const f = await fixture();
    await f.frontend.bootstrap();
    f.api.storage.put.mockRejectedValue(new Error("storage write failed"));
    await expect(f.frontend.persistPolicy(B)).rejects.toThrow();
    expect(f.current.get(POLICY_STORAGE_KEY)).toEqual(A);
    expect(f.frontend.policy).toEqual(A);
    expect(f.frontend.dockElement.innerHTML).not.toContain("已保存，内核未确认");
    expect(f.frontend.dockElement.innerHTML).not.toContain("策略已就绪");
  });

  it("serializes slow migration and a subsequent save across callers", async () => {
    const f = await fixture({ marker: false, empty: true });
    f.legacy.set(POLICY_STORAGE_KEY, A);
    const entered = deferred();
    const release = deferred();
    const fetch = f.api.client.fetch.getMockImplementation()!;
    let first = true;
    f.api.client.fetch.mockImplementation(async (...args) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return fetch(...args);
    });
    const reload = f.backend.reloadPolicy();
    await entered.promise;
    const save = f.backend.savePolicy(B);
    release.resolve();
    const replies = await Promise.all([reload, save]);
    expect(replies.every(reply => reply.ready)).toBe(true);
    expect(f.current.get(POLICY_STORAGE_KEY)).toEqual(B);
    expect(f.backend.policy).toEqual(B);
  });

  it("bounds a hanging write, fences late completion, and recovers on a later explicit request", async () => {
    const f = await fixture();
    await f.backend.reloadPolicy();
    const release = deferred();
    const entered = deferred();
    const put = f.api.storage.put.getMockImplementation()!;
    f.api.storage.put.mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; await put(...args);
    });
    const first = f.backend.savePolicy(B);
    await entered.promise;
    const reply = await first;
    expect(reply.ready).toBe(false);
    expect(reply.saveState).toBe("unknown");
    const blocked = await f.backend.savePolicy(A);
    expect(blocked.ready).toBe(false);
    expect(f.api.storage.put).toHaveBeenCalledTimes(1);
    release.resolve();
    await nextTurn();
    expect((await f.backend.status()).ready).toBe(false);
    const recovered = await f.backend.savePolicy(A);
    expect(recovered.ready).toBe(true);
    expect(f.current.get(POLICY_STORAGE_KEY)).toEqual(A);
  });

  it("registers and unbinds the kernel save RPC without adding agent tools", async () => {
    const f = await fixture();
    const lifecycle = f.api.plugin.lifecycle as { onload(): Promise<void>; onunload(): Promise<void> };
    await lifecycle.onload();
    expect(f.api.agent.registerCapability).toHaveBeenCalledTimes(28);
    expect([...f.handlers.keys()].sort()).toEqual(["getStatus", "reloadPolicy", "savePolicy"]);
    const reply = await f.handlers.get("savePolicy")!(structuredClone(B)) as Reply;
    expect(reply.ready).toBe(true);
    expect(reply.saveState).toBe("saved");
    expect(f.current.get(POLICY_STORAGE_KEY)).toEqual(B);
    await lifecycle.onunload();
    expect(f.handlers.size).toBe(0);
  });

  it.each([A, DEFAULT_POLICY])("does not treat a lost saved policy as a first-run default", async saved => {
    const f = await fixture({ marker: false, empty: true });
    const initial = await f.backend.reloadPolicy();
    expect(initial.ready).toBe(true);
    expect(initial.policyLoadState).toBe("initial-default");
    expect((await f.backend.savePolicy(saved)).ready).toBe(true);
    f.current.delete(POLICY_STORAGE_KEY);
    f.api.storage.put.mockClear();
    const reply = await f.backend.reloadPolicy();
    expect(reply.ready).toBe(false);
    expect(reply.policyLoadState).toBe("unavailable");
    expect(f.api.storage.put).not.toHaveBeenCalled();
  });

  it("keeps corrupt current JSON distinct from a missing file", async () => {
    const f = await fixture();
    const get = f.api.storage.get.getMockImplementation()!;
    f.api.storage.get.mockImplementation(async key => {
      if (key === POLICY_STORAGE_KEY) return { json: async () => { throw new SyntaxError("corrupt JSON"); } };
      return get(key);
    });
    expect((await f.backend.reloadPolicy()).ready).toBe(false);
    expect(f.api.storage.put).not.toHaveBeenCalled();
    expect(f.api.client.fetch).not.toHaveBeenCalled();
  });

  it.each([500, 403, -1])("does not treat readDir error code %s as confirmed absence", async code => {
    const f = await fixture();
    f.failures.add(MIGRATION_MARKER_KEY);
    f.api.storage.list.mockResolvedValue([]);
    f.api.client.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ code }) });
    expect((await f.backend.reloadPolicy()).ready).toBe(false);
    expect(f.api.storage.put).not.toHaveBeenCalled();
    expect(f.api.storage.list).not.toHaveBeenCalled();
  });

  it.each([404, 500])("does not interpret getFile HTTP %s as a missing legacy file", async httpStatus => {
    const f = await fixture({ marker: false, empty: true });
    const fetch = f.api.client.fetch.getMockImplementation()!;
    f.api.client.fetch.mockImplementation(async (path, init) => path === "/api/file/getFile"
      ? { ok: false, status: httpStatus, text: async () => JSON.stringify({ code: 404 }) }
      : fetch(path, init));
    expect((await f.backend.reloadPolicy()).ready).toBe(false);
    expect(f.api.storage.put).not.toHaveBeenCalled();
  });

  it("requires a strict directory probe for a legacy getFile 202/404 response", async () => {
    const f = await fixture({ marker: false, empty: true });
    f.legacy.set(POLICY_STORAGE_KEY, A);
    const fetch = f.api.client.fetch.getMockImplementation()!;
    f.api.client.fetch.mockImplementation(async (path, init) => path === "/api/file/getFile"
      ? { ok: true, status: 202, text: async () => JSON.stringify({ code: 404 }) }
      : fetch(path, init));
    expect((await f.backend.reloadPolicy()).ready).toBe(false);
    expect(f.api.storage.put).not.toHaveBeenCalled();
  });

  it("does not claim a fulfilled write persisted the draft when readback disagrees", async () => {
    const f = await fixture();
    await f.frontend.bootstrap();
    f.api.storage.put.mockImplementation(async () => undefined);
    await expect(f.frontend.persistPolicy(B)).rejects.toThrow("保存结果未知");
    expect(f.frontend.policy).toEqual(A);
    expect(f.current.get(POLICY_STORAGE_KEY)).toEqual(A);
    expect(f.frontend.dockElement.innerHTML).not.toContain("已保存");
  });

  it("stops late read continuations from issuing migration writes", async () => {
    const f = await fixture({ marker: false, empty: true });
    f.legacy.set(POLICY_STORAGE_KEY, A);
    const entered = deferred();
    const release = deferred();
    const fetch = f.api.client.fetch.getMockImplementation()!;
    f.api.client.fetch.mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return fetch(...args);
    });
    const reload = f.backend.reloadPolicy();
    await entered.promise;
    expect((await reload).ready).toBe(false);
    expect((await f.backend.savePolicy(B)).ready).toBe(false);
    release.resolve();
    await nextTurn();
    expect(f.api.storage.put).not.toHaveBeenCalled();
    expect((await f.backend.status()).ready).toBe(false);
    expect((await f.backend.reloadPolicy()).ready).toBe(true);
  });

  it("serializes audit appends with migration copies", async () => {
    const f = await fixture({ marker: false, empty: true });
    f.legacy.set(POLICY_STORAGE_KEY, A);
    f.legacy.set(AUDIT_STORAGE_KEY, [{ ...audit[0], operation: "legacy" }]);
    const entered = deferred();
    const release = deferred();
    const fetch = f.api.client.fetch.getMockImplementation()!;
    f.api.client.fetch.mockImplementation(async (...args) => {
      if (args[0] === "/api/file/getFile" && args[1].body.includes(AUDIT_STORAGE_KEY)) {
        entered.resolve(); await release.promise;
      }
      return fetch(...args);
    });
    const reload = f.backend.reloadPolicy();
    await entered.promise;
    const append = f.backend.audit.record({ operation: "live", outcome: "allowed" });
    release.resolve();
    await Promise.all([reload, append]);
    expect((f.current.get(AUDIT_STORAGE_KEY) as Array<{ operation: string }>).map(item => item.operation))
      .toEqual(["legacy", "live"]);
  });

  it("fail-closes blocked policy changes and prevents an expired audit read from writing", async () => {
    const f = await fixture();
    await f.backend.reloadPolicy();
    const entered = deferred();
    const release = deferred();
    const get = f.api.storage.get.getMockImplementation()!;
    f.api.storage.get.mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return get(...args);
    });
    const append = f.backend.audit.record({ operation: "late", outcome: "allowed" });
    await entered.promise;
    await append;
    expect((await f.backend.savePolicy(B)).ready).toBe(false);
    expect((await f.backend.status()).ready).toBe(false);
    expect(f.backend.policy.access.selectedNotebookIds).toEqual([]);
    release.resolve();
    await nextTurn();
    expect(f.api.storage.put).not.toHaveBeenCalled();
    expect((await f.backend.reloadPolicy()).ready).toBe(true);
  });

  it("recovers data-change synchronization after a failed first bootstrap", async () => {
    const f = await fixture();
    f.frontend.refreshNotebooks.mockRejectedValueOnce(new Error("notebook list failed"));
    await f.frontend.bootstrap();
    await nextTurn();
    expect(f.frontend.bootstrapped).toBe(false);
    await f.frontend.refreshAll();
    expect(f.frontend.bootstrapped).toBe(true);
    f.current.set(POLICY_STORAGE_KEY, B);
    await f.frontend.onDataChanged();
    expect(f.frontend.policy).toEqual(B);
    expect(f.frontend.dockElement.innerHTML).toContain("策略已就绪");
  });
});
