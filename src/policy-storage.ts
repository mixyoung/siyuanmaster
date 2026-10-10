import type * as kernel from "siyuan/kernel";
import { clonePolicy, computePolicyFingerprint, DEFAULT_POLICY, normalizePolicy } from "./config";
import {
  CURRENT_STORAGE_DIR,
  isPlausiblePolicy,
  LEGACY_STORAGE_DIR,
  legacyPetalFilePath,
  POLICY_STORAGE_KEY,
  runStorageMigration,
  type MigrationStorageIO,
} from "./migration";
import { KERNEL_POLICY_TIMEOUT_MS, PolicySyncBlockedError, PolicyTaskQueue, type PolicyTask } from "./policy-sync";
import { confirmStorageFileMissing } from "./storage-state";
import type { PluginPolicy } from "./types";

export type PolicyLoadState = "loading" | "loaded" | "initial-default" | "unavailable";
export type PolicySaveState = "not_saved" | "unknown" | "saved";
export interface PolicySnapshot {
  ready: boolean;
  policy: PluginPolicy;
  policyFingerprint: string;
  policyLoadState: PolicyLoadState;
  policyError?: string;
  saveState?: PolicySaveState;
}

/** The kernel is the only policy/migration writer, including calls from other windows. */
export class PolicyStorage {
  private readonly queue = new PolicyTaskQueue(KERNEL_POLICY_TIMEOUT_MS);
  private policy = clonePolicy(DEFAULT_POLICY);
  private loadState: PolicyLoadState = "unavailable";
  private error = "Policy has not been loaded";
  private active?: object;

  constructor(
    private readonly api: kernel.ISiyuan,
    private readonly publish: (policy: PluginPolicy) => void,
  ) {}

  get metadata() {
    return {
      ready: this.loadState === "loaded" || this.loadState === "initial-default",
      policyLoadState: this.loadState,
      policyError: this.error || undefined,
    };
  }

  serializeAuditWrite(action: (task: PolicyTask) => Promise<void>): Promise<void> {
    return this.queue.run(action);
  }

  reload(): Promise<PolicySnapshot> {
    return this.execute(task => this.load(task));
  }

  save(value: unknown): Promise<PolicySnapshot> {
    const valid = isPlausiblePolicy(value);
    const snapshot = clonePolicy(normalizePolicy(value));
    const state: { saveState: PolicySaveState } = { saveState: "not_saved" };
    return this.execute(async task => {
      if (!valid) throw new Error("Policy save rejected: invalid policy");
      await this.load(task);
      task.check();
      this.loadState = "loading";
      state.saveState = "unknown";
      await task.wait(() => this.api.storage.put(POLICY_STORAGE_KEY, JSON.stringify(snapshot)));
      const observed = await this.readCurrent(task, POLICY_STORAGE_KEY);
      if (!isPlausiblePolicy(observed) ||
        await computePolicyFingerprint(normalizePolicy(observed)) !== await computePolicyFingerprint(snapshot)) {
        throw new Error("Policy write readback did not match the requested policy");
      }
      task.check();
      state.saveState = "saved";
      this.commit(snapshot, "loaded");
    }, state);
  }

  private async execute(
    action: (task: PolicyTask) => Promise<void>,
    save?: { saveState: PolicySaveState },
  ): Promise<PolicySnapshot> {
    const token = {};
    try {
      return await this.queue.run(async task => {
        this.active = token;
        this.loadState = "loading";
        this.error = "";
        await action(task);
        task.check();
        return task.wait(() => this.snapshot(save?.saveState));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.active === token || error instanceof PolicySyncBlockedError) {
        this.commit(DEFAULT_POLICY, "unavailable");
        this.error = message;
      }
      return {
        ...await this.snapshot(save?.saveState),
        ready: false,
        policyLoadState: "unavailable",
        policyError: message,
      };
    }
  }

  private commit(policy: PluginPolicy, state: PolicyLoadState): void {
    this.policy = clonePolicy(policy);
    this.loadState = state;
    this.error = "";
    this.publish(clonePolicy(policy));
  }

  private async snapshot(saveState?: PolicySaveState): Promise<PolicySnapshot> {
    const policy = clonePolicy(this.policy);
    const metadata = this.metadata;
    return { ...metadata, policy, policyFingerprint: await computePolicyFingerprint(policy), saveState };
  }

  private async load(task: PolicyTask): Promise<void> {
    const result = await runStorageMigration(this.createIO(task));
    task.check();
    this.commit(result.policy, result.policySource === "default" ? "initial-default" : "loaded");
  }

  private createIO(task: PolicyTask): MigrationStorageIO {
    return {
      readCurrent: key => this.readCurrent(task, key),
      readLegacy: key => this.readLegacy(task, key),
      writeCurrent: async (key, value) => {
        await task.wait(() => this.api.storage.put(key, JSON.stringify(value)));
        const observed = await this.readCurrent(task, key);
        if (JSON.stringify(observed) !== JSON.stringify(value)) {
          throw new Error(`Migration write readback mismatch: ${key}`);
        }
      },
    };
  }

  private async readCurrent(task: PolicyTask, key: string): Promise<unknown | undefined> {
    let stored: Awaited<ReturnType<kernel.ISiyuan["storage"]["get"]>>;
    try {
      stored = await task.wait(() => this.api.storage.get(key));
    } catch (error) {
      task.check();
      if (!await this.confirmMissing(task, CURRENT_STORAGE_DIR, key)) throw error;
      return undefined;
    }
    const value: unknown = await task.wait(() => stored.json());
    if (value === undefined) throw new Error(`Invalid JSON storage payload: ${key}`);
    return value;
  }

  private async readLegacy(task: PolicyTask, key: string): Promise<unknown | undefined> {
    const response = await task.wait(() => this.api.client.fetch("/api/file/getFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: legacyPetalFilePath(key) }),
    }));
    const text = await task.wait(() => response.text());
    if (response.status === 200) return JSON.parse(text) as unknown;
    if (response.status === 202) {
      const payload: unknown = JSON.parse(text);
      if (payload && typeof payload === "object" && !Array.isArray(payload) &&
        (payload as Record<string, unknown>).code === 404 &&
        await this.confirmMissing(task, LEGACY_STORAGE_DIR, key)) return undefined;
    }
    throw new Error(`Legacy storage read failed: ${key} (${response.status})`);
  }

  private confirmMissing(task: PolicyTask, directory: string, key: string): Promise<boolean> {
    return confirmStorageFileMissing(this.api, directory, key, task.wait);
  }
}
