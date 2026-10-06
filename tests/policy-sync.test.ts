import { describe, expect, it, vi } from "vitest";
import {
  clonePolicy,
  computePolicyFingerprint,
  DEFAULT_POLICY,
  normalizePolicy,
} from "../src/config";
import type { NotebookSummary, PluginPolicy } from "../src/types";
import { deferred, frontendRuntime, nextTurn } from "./helpers/plugin-runtime";

interface FrontendRuntime {
  policy: PluginPolicy;
  bootstrapped: boolean;
  notebooks: NotebookSummary[];
  dockElement: { innerHTML: string };
  kernel: {
    rpc: { call: { reloadPolicy: ReturnType<typeof vi.fn<() => Promise<Record<string, unknown>>>> } };
  };
  saveData: ReturnType<typeof vi.fn<(key: string, value: PluginPolicy) => Promise<void>>>;
  loadPolicy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  refreshNotebooks: ReturnType<typeof vi.fn<() => Promise<void>>>;
  persistPolicy(policy: PluginPolicy): Promise<void>;
  confirmKernelPolicyReloaded(expected: PluginPolicy): Promise<void>;
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

async function fixture() {
  const host = await frontendRuntime<FrontendRuntime>();
  const { plugin } = host;
  let stored = clonePolicy(A);
  plugin.policy = clonePolicy(A);
  plugin.bootstrapped = true;
  plugin.notebooks = [];
  plugin.dockElement = { innerHTML: "" };
  plugin.saveData = vi.fn(async (_key, value) => {
    stored = clonePolicy(value);
  });
  plugin.loadPolicy = vi.fn(async () => {
    plugin.policy = clonePolicy(stored);
  });
  plugin.refreshNotebooks = vi.fn(async () => undefined);
  plugin.kernel = {
    rpc: { call: { reloadPolicy: vi.fn(async () => ({
      policyFingerprint: await computePolicyFingerprint(stored),
    })) } },
  };
  return {
    ...host,
    getStored: () => stored,
    setStored: (value: PluginPolicy) => { stored = clonePolicy(value); },
  };
}

describe("policy synchronization regression", () => {
  it("binds fingerprint confirmation to the supplied snapshot, not mutable plugin state", async () => {
    const { plugin } = await fixture();
    const entered = deferred();
    const response = deferred<Record<string, unknown>>();
    plugin.kernel.rpc.call.reloadPolicy.mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    const result = Promise.allSettled([
      plugin.confirmKernelPolicyReloaded(clonePolicy(A)),
    ]);
    await entered.promise;
    plugin.policy = clonePolicy(B);
    response.resolve({ policyFingerprint: await computePolicyFingerprint(B) });

    const [confirmation] = await result;
    expect(confirmation.status).toBe("rejected");
    if (confirmation.status === "rejected") {
      expect(confirmation.reason).toMatchObject({ name: "KernelPolicyReloadError" });
    }
  });

  it("serializes each save through reload and confirmation and snapshots a queued draft", async () => {
    const { plugin, getStored, setStored } = await fixture();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    plugin.saveData.mockImplementation(async (_key, value) => {
      setStored(value);
      events.push(`save:${value.access.selectedNotebookIds[0]}`);
    });
    let reloads = 0;
    plugin.kernel.rpc.call.reloadPolicy.mockImplementation(async () => {
      reloads += 1;
      const snapshot = clonePolicy(getStored());
      events.push(`reload:${snapshot.access.selectedNotebookIds[0]}`);
      if (reloads === 1) {
        entered.resolve();
        await release.promise;
      }
      return { policyFingerprint: await computePolicyFingerprint(snapshot) };
    });
    const saveA = plugin.persistPolicy(A);
    await entered.promise;
    const draft = clonePolicy(B);
    const saveB = plugin.persistPolicy(draft);
    const results = Promise.allSettled([saveA, saveB]);
    draft.operations.update = "allow";
    draft.access.selectedNotebookIds[0] = "20260101000000-changed";
    await nextTurn();
    const earlyWrites = plugin.saveData.mock.calls.length;
    release.resolve();

    expect((await results).map((result) => result.status)).toEqual([
      "fulfilled", "fulfilled",
    ]);
    expect(earlyWrites).toBe(1);
    expect(events).toEqual([
      `save:${A.access.selectedNotebookIds[0]}`,
      `reload:${A.access.selectedNotebookIds[0]}`,
      `save:${B.access.selectedNotebookIds[0]}`,
      `reload:${B.access.selectedNotebookIds[0]}`,
    ]);
    expect(getStored()).toEqual(B);
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("coordinates background data changes with a pending save", async () => {
    const { plugin, getStored, setStored } = await fixture();
    const entered = deferred();
    const release = deferred();
    let reloads = 0;
    plugin.kernel.rpc.call.reloadPolicy.mockImplementation(async () => {
      reloads += 1;
      const snapshot = clonePolicy(getStored());
      if (reloads === 1) {
        entered.resolve();
        await release.promise;
      }
      return { policyFingerprint: await computePolicyFingerprint(snapshot) };
    });
    const save = plugin.persistPolicy(A);
    await entered.promise;
    setStored(B);
    const background = plugin.onDataChanged();
    const results = Promise.allSettled([save, background]);
    await nextTurn();
    const earlyLoads = plugin.loadPolicy.mock.calls.length;
    release.resolve();

    expect((await results).map((result) => result.status)).toEqual([
      "fulfilled", "fulfilled",
    ]);
    expect(earlyLoads).toBe(0);
    expect(plugin.policy).toEqual(B);
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it.each(["bootstrap", "onDataChanged", "refreshAll"] as const)(
    "%s displays an unconfirmed policy after a background fingerprint mismatch",
    async (entry) => {
      const { plugin, warnings } = await fixture();
      plugin.policy = clonePolicy(B);
      plugin.loadPolicy.mockImplementation(async () => { plugin.policy = clonePolicy(B); });
      plugin.kernel.rpc.call.reloadPolicy.mockResolvedValue({
        policyFingerprint: await computePolicyFingerprint(A),
      });
      await plugin[entry]();

      expect(warnings).toHaveBeenCalled();
      expect(plugin.dockElement.innerHTML).toContain("已保存，内核未确认");
      expect(plugin.dockElement.innerHTML).not.toContain("策略已就绪");
      expect(plugin.dockElement.innerHTML).toContain("sym-status--danger");
    },
  );

  it("displays synchronizing while a save awaits kernel confirmation", async () => {
    const { plugin } = await fixture();
    const entered = deferred();
    const response = deferred<Record<string, unknown>>();
    plugin.kernel.rpc.call.reloadPolicy.mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    const save = plugin.persistPolicy(A);
    await entered.promise;
    const htmlDuringReload = plugin.dockElement.innerHTML;
    response.resolve({ policyFingerprint: await computePolicyFingerprint(A) });
    await save;

    expect(htmlDuringReload).toContain("正在同步");
    expect(htmlDuringReload).not.toContain("策略已就绪");
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("continues the queue after a failed confirmation", async () => {
    const { plugin } = await fixture();
    plugin.kernel.rpc.call.reloadPolicy.mockResolvedValue({
      policyFingerprint: await computePolicyFingerprint(B),
    });
    const results = await Promise.allSettled([
      plugin.persistPolicy(A), plugin.persistPolicy(B),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect(plugin.dockElement.innerHTML).toContain("策略已就绪");
  });

  it("does not claim a failed storage write was saved or confirmed", async () => {
    const { plugin } = await fixture();
    plugin.renderDock();
    plugin.saveData.mockRejectedValue(new Error("storage write failed"));
    await expect(plugin.persistPolicy(B)).rejects.toThrow("storage write failed");

    expect(plugin.kernel.rpc.call.reloadPolicy).not.toHaveBeenCalled();
    expect(plugin.policy).toEqual(A);
    expect(plugin.dockElement.innerHTML).not.toContain("策略已就绪");
    expect(plugin.dockElement.innerHTML).not.toContain("已保存，内核未确认");
    expect(plugin.dockElement.innerHTML).toContain("同步失败");
  });
});
