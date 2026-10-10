import { describe, expect, it, vi } from "vitest";
import { clonePolicy, computePolicyFingerprint, DEFAULT_POLICY, normalizePolicy } from "../src/config";
import type { PolicySnapshot } from "../src/policy-storage";
import type { NotebookSummary, PluginPolicy } from "../src/types";
import { deferred, frontendRuntime, nextTurn, runtimeClock, type RuntimeClock } from "./helpers/plugin-runtime";

interface FrontendRuntime {
  policy: PluginPolicy;
  bootstrapped: boolean;
  notebooks: NotebookSummary[];
  dockElement: { innerHTML: string };
  kernel: { rpc: { call: {
    reloadPolicy: ReturnType<typeof vi.fn<() => Promise<PolicySnapshot>>>;
    savePolicy: ReturnType<typeof vi.fn<(policy: PluginPolicy) => Promise<PolicySnapshot>>>;
  } } };
  saveData: ReturnType<typeof vi.fn>;
  loadData: ReturnType<typeof vi.fn>;
  refreshNotebooks: ReturnType<typeof vi.fn<() => Promise<void>>>;
  persistPolicy(policy: PluginPolicy): Promise<void>;
  confirmKernelPolicyReloaded(expected: PluginPolicy, status: PolicySnapshot, saved?: boolean): Promise<void>;
  bootstrap(): Promise<void>;
  onDataChanged(): Promise<void>;
  refreshAll(): Promise<void>;
  renderDock(): void;
}

function policy(id: string, update: "allow" | "deny" = "allow"): PluginPolicy {
  return normalizePolicy({
    ...DEFAULT_POLICY,
    access: { ...DEFAULT_POLICY.access, selectedNotebookIds: [id] },
    operations: { ...DEFAULT_POLICY.operations, update },
  });
}
const A = policy("20260101000000-aaaaaaa");
const B = policy("20260101000000-bbbbbbb", "deny");
async function status(policy: PluginPolicy): Promise<PolicySnapshot> {
  return { ready: true, policy: clonePolicy(policy), policyLoadState: "loaded", policyFingerprint: await computePolicyFingerprint(policy) };
}
async function fixture(clock?: RuntimeClock) {
  const host = await frontendRuntime<FrontendRuntime>(clock);
  const { plugin } = host;
  let stored = clonePolicy(A);
  plugin.policy = clonePolicy(A);
  plugin.bootstrapped = true;
  plugin.notebooks = [];
  plugin.dockElement = { innerHTML: "" };
  plugin.saveData = vi.fn(async () => ({ code: 1 }));
  plugin.loadData = vi.fn(async () => clonePolicy(B));
  plugin.refreshNotebooks = vi.fn(async () => undefined);
  plugin.kernel = { rpc: { call: {
    reloadPolicy: vi.fn(async () => status(stored)),
    savePolicy: vi.fn(async value => {
      stored = clonePolicy(value);
      return { ...await status(stored), saveState: "saved" };
    }),
  } } };
  return { ...host, getStored: () => stored, setStored: (value: PluginPolicy) => { stored = clonePolicy(value); } };
}

describe("policy synchronization regression", () => {
  it("binds confirmation to the supplied snapshot, not mutable plugin state", async () => {
    const { plugin } = await fixture();
    plugin.policy = clonePolicy(B);
    await expect(plugin.confirmKernelPolicyReloaded(A, await status(B), true))
      .rejects.toMatchObject({ name: "KernelPolicyReloadError" });
  });

  it("serializes save through confirmation and snapshots a queued draft", async () => {
    const { plugin, getStored, setStored } = await fixture();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    plugin.kernel.rpc.call.savePolicy.mockImplementation(async value => {
      events.push(`save:${value.access.selectedNotebookIds[0]}`);
      if (events.length === 1) { entered.resolve(); await release.promise; }
      setStored(value);
      return { ...await status(value), saveState: "saved" };
    });
    const saveA = plugin.persistPolicy(A);
    await entered.promise;
    const draft = clonePolicy(B);
    const saveB = plugin.persistPolicy(draft);
    const results = Promise.allSettled([saveA, saveB]);
    draft.operations.update = "allow";
    draft.access.selectedNotebookIds[0] = "changed";
    await nextTurn();
    expect(plugin.kernel.rpc.call.savePolicy).toHaveBeenCalledTimes(1);
    release.resolve();
    expect((await results).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(events).toEqual([`save:${A.access.selectedNotebookIds[0]}`, `save:${B.access.selectedNotebookIds[0]}`]);
    expect(getStored()).toEqual(B);
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("coordinates background data changes with a pending save", async () => {
    const { plugin, setStored } = await fixture();
    const entered = deferred();
    const release = deferred();
    plugin.kernel.rpc.call.savePolicy.mockImplementation(async value => {
      entered.resolve(); await release.promise;
      return { ...await status(value), saveState: "saved" };
    });
    const save = plugin.persistPolicy(A);
    await entered.promise;
    setStored(B);
    const background = plugin.onDataChanged();
    const results = Promise.allSettled([save, background]);
    await nextTurn();
    expect(plugin.kernel.rpc.call.reloadPolicy).not.toHaveBeenCalled();
    release.resolve();
    expect((await results).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(plugin.policy).toEqual(B);
    expect(plugin.loadData).not.toHaveBeenCalled();
  });

  it.each(["bootstrap", "onDataChanged", "refreshAll"] as const)(
    "%s does not acknowledge an unhealthy default even with a matching fingerprint", async entry => {
      const { plugin, warnings } = await fixture();
      plugin.policy = clonePolicy(DEFAULT_POLICY);
      plugin.kernel.rpc.call.reloadPolicy.mockResolvedValue({
        ...await status(DEFAULT_POLICY), ready: false, policyLoadState: "unavailable", policyError: "Storage read failed",
      });
      await plugin[entry]();
      expect(warnings).toHaveBeenCalled();
      expect(plugin.dockElement.innerHTML).not.toContain("策略已就绪");
      expect(plugin.dockElement.innerHTML).not.toContain("已保存，内核未确认");
      expect(plugin.dockElement.innerHTML).toContain("sym-status--danger");
    },
  );

  it("displays synchronizing until the save reply is confirmed", async () => {
    const { plugin } = await fixture();
    const entered = deferred();
    const response = deferred<PolicySnapshot>();
    plugin.kernel.rpc.call.savePolicy.mockImplementation(() => { entered.resolve(); return response.promise; });
    const save = plugin.persistPolicy(A);
    await entered.promise;
    expect(plugin.dockElement.innerHTML).toContain("正在同步");
    response.resolve({ ...await status(A), saveState: "saved" });
    await save;
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("continues the queue after a failed confirmation", async () => {
    const { plugin } = await fixture();
    plugin.kernel.rpc.call.savePolicy.mockResolvedValue({ ...await status(B), saveState: "saved" });
    const results = await Promise.allSettled([plugin.persistPolicy(A), plugin.persistPolicy(B)]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(plugin.kernel.rpc.call.savePolicy).toHaveBeenCalledTimes(2);
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("does not publish a rejected storage write", async () => {
    const { plugin } = await fixture();
    plugin.kernel.rpc.call.savePolicy.mockResolvedValue({
      ...await status(A), ready: false, policyLoadState: "unavailable", saveState: "not_saved", policyError: "storage write failed",
    });
    await expect(plugin.persistPolicy(B)).rejects.toThrow("storage write failed");
    expect(plugin.policy).toEqual(A);
    expect(plugin.kernel.rpc.call.reloadPolicy).not.toHaveBeenCalled();
    expect(plugin.dockElement.innerHTML).toContain("策略保存失败");
    expect(plugin.dockElement.innerHTML).not.toContain("已保存");
  });

  it("treats a lost save RPC response as unknown rather than saved", async () => {
    const { plugin } = await fixture();
    plugin.kernel.rpc.call.savePolicy.mockRejectedValue(new Error("response lost"));
    await expect(plugin.persistPolicy(B)).rejects.toThrow("保存结果未知");
    expect(plugin.policy).toEqual(A);
    expect(plugin.dockElement.innerHTML).not.toContain("已保存");
  });

  it("bounds a stuck RPC and ignores its late reply before explicit recovery", async () => {
    const { plugin, setStored } = await fixture(runtimeClock());
    const entered = deferred();
    const response = deferred<PolicySnapshot>();
    plugin.kernel.rpc.call.savePolicy.mockImplementation(() => { entered.resolve(); return response.promise; });
    const save = plugin.persistPolicy(B);
    const result = Promise.allSettled([save]);
    await entered.promise;
    expect((await result)[0].status).toBe("rejected");
    await nextTurn();
    expect(plugin.dockElement.innerHTML).toContain("保存结果未知");
    await expect(plugin.persistPolicy(A)).rejects.toThrow("尚未结束");
    expect(plugin.kernel.rpc.call.savePolicy).toHaveBeenCalledTimes(1);
    setStored(B);
    response.resolve({ ...await status(B), saveState: "saved" });
    await nextTurn();
    expect(plugin.policy).toEqual(A);
    expect(plugin.dockElement.innerHTML).not.toContain("策略已就绪");
    await plugin.onDataChanged();
    expect(plugin.policy).toEqual(B);
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("fails a queued save whose deadline passes before it starts, without staying on syncing", async () => {
    const clock = runtimeClock();
    const { plugin } = await fixture(clock);
    plugin.kernel.rpc.call.savePolicy.mockImplementation(async value => {
      await new Promise<void>(resolve => clock.setTimeout(() => resolve(), 3500));
      return { ...await status(value), saveState: "saved" };
    });
    const results = await Promise.allSettled([
      plugin.persistPolicy(A), plugin.persistPolicy(A),
      plugin.persistPolicy(A), plugin.persistPolicy(A),
    ]);
    expect(results.map(result => result.status)).toEqual([
      "fulfilled", "fulfilled", "rejected", "rejected",
    ]);
    expect((results[2] as PromiseRejectedResult).reason.message).toContain("保存结果未知");
    expect((results[3] as PromiseRejectedResult).reason.name).toBe("PolicySyncTimeoutError");
    expect(plugin.dockElement.innerHTML).not.toContain("正在同步");
    expect(plugin.dockElement.innerHTML).toContain("sym-status--danger");
    // The timed-out task's underlying request still owns the queue until it settles.
    await nextTurn();
    await nextTurn();
    plugin.kernel.rpc.call.savePolicy.mockImplementation(async value => ({ ...await status(value), saveState: "saved" }));
    await plugin.onDataChanged();
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("requires a recognized load state in addition to ready and fingerprint", async () => {
    const { plugin } = await fixture();
    const reply = await status(A);
    delete (reply as Partial<PolicySnapshot>).policyLoadState;
    await expect(plugin.confirmKernelPolicyReloaded(A, reply)).rejects.toThrow();
  });
});
