import { describe, expect, it, vi } from "vitest";
import type { NotebookSummary } from "../src/types";
import { frontendRuntime, runtimeClock } from "./helpers/plugin-runtime";

interface Runtime {
  notebooks: NotebookSummary[];
  refreshNotebooks(): Promise<void>;
}
type Callback = (value: unknown) => void;

describe("notebook refresh transport", () => {
  it("bounds a missing callback and ignores its late result", async () => {
    const clock = runtimeClock();
    let callback!: Callback;
    const fetchPost = vi.fn((_path: string, _body: unknown, done: Callback) => { callback = done; });
    const { plugin } = await frontendRuntime<Runtime>(clock, { fetchPost });
    plugin.notebooks = [{ id: "existing", name: "Existing" }];
    await expect(plugin.refreshNotebooks()).rejects.toThrow("timed out");
    callback({ code: 0, data: { notebooks: [{ id: "late", name: "Late" }] } });
    expect(plugin.notebooks[0].id).toBe("existing");
    expect(clock.pending()).toBe(0);
  });

  it.each([1, 500, -1])("rejects fulfilled error code %s", async code => {
    const clock = runtimeClock();
    const fetchPost = vi.fn((_path: string, _body: unknown, done: Callback) => done({ code, msg: "read rejected" }));
    const { plugin } = await frontendRuntime<Runtime>(clock, { fetchPost });
    await expect(plugin.refreshNotebooks()).rejects.toThrow("read rejected");
    expect(clock.pending()).toBe(0);
  });

  it("handles the host failure callback and clears the timer", async () => {
    const clock = runtimeClock();
    const fetchPost = vi.fn((_path: string, _body: unknown, _done: Callback, _headers: unknown, failed: Callback) => {
      failed({ code: 500, msg: "transport failed" });
    });
    const { plugin } = await frontendRuntime<Runtime>(clock, { fetchPost });
    await expect(plugin.refreshNotebooks()).rejects.toThrow("transport failed");
    expect(clock.pending()).toBe(0);
  });

  it("clears the timer after a synchronous host error", async () => {
    const clock = runtimeClock();
    const { plugin } = await frontendRuntime<Runtime>(clock, { fetchPost: () => { throw new Error("host unavailable"); } });
    await expect(plugin.refreshNotebooks()).rejects.toThrow("host unavailable");
    expect(clock.pending()).toBe(0);
  });

  it("publishes a successful notebook response", async () => {
    const clock = runtimeClock();
    const fetchPost = vi.fn((_path: string, _body: unknown, done: Callback) => {
      done({ code: 0, data: { notebooks: [{ id: "b", name: "B" }, { id: "a", name: "A" }] } });
    });
    const { plugin } = await frontendRuntime<Runtime>(clock, { fetchPost });
    await plugin.refreshNotebooks();
    expect(plugin.notebooks.map(item => item.id)).toEqual(["a", "b"]);
    expect(clock.pending()).toBe(0);
  });
});
