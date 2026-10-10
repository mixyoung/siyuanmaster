import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { vi } from "vitest";
import type * as kernel from "siyuan/kernel";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bundles = new Map<string, Promise<string>>();

// Execute the real plugin classes with an in-memory host; never write bundles
// or add exports to the production kernel entrypoint.
function bundle(name: "index" | "kernel"): Promise<string> {
  let pending = bundles.get(name);
  if (!pending) {
    pending = build({
      absWorkingDir: rootDir,
      entryPoints: [`src/${name}.ts`],
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "es2022",
      external: ["siyuan"],
      outfile: `${name}.runtime-test.js`,
      write: false,
    }).then((result) => {
      const script = result.outputFiles.find((file) => file.path.endsWith(".js"));
      if (!script) {
        throw new Error("Plugin test bundle has no JavaScript output");
      }
      return script.text;
    });
    bundles.set(name, pending);
  }
  return pending;
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function frontendRuntime<T>(clock?: RuntimeClock, hostOverrides: Record<string, unknown> = {}) {
  const warnings = vi.fn();
  const errors = vi.fn();
  const messages = vi.fn();
  const host = {
    Plugin: class {
      name = "siyuanmaster";
    },
    Dialog: class {},
    Setting: class {},
    showMessage: messages,
    ...hostOverrides,
  };
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(await bundle("index"), {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name !== "siyuan") {
        throw new Error(`Unexpected test module: ${name}`);
      }
      return host;
    },
    console: { ...console, warn: warnings, error: errors },
    Date: clock ? class extends Date { static now() { return clock.now(); } } : Date,
    setTimeout: clock?.setTimeout ?? setTimeout,
    clearTimeout: clock?.clearTimeout ?? clearTimeout,
  });
  const PluginClass = module.exports.default as new () => T;
  return { plugin: new PluginClass(), warnings, errors, messages };
}

export interface RuntimeClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

export function runtimeClock(start = Date.now()) {
  let now = start;
  let handle = 0;
  let scheduled = false;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const flush = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].callback();
      if (timers.size > 0) flush();
    });
  };
  return {
    now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
    pending: () => timers.size,
    setTimeout: (callback: () => void, milliseconds: number) => {
      const id = ++handle;
      timers.set(id, { at: now + milliseconds, callback });
      flush();
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
}

export async function kernelRuntime<T>(
  api: kernel.ISiyuan,
  clock: RuntimeClock = runtimeClock(),
): Promise<T> {
  class RuntimeDate extends Date {
    static now() { return clock.now(); }
  }
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    `${await bundle("kernel")}\nmodule.exports.Runtime = SiYuanMasterKernelPlugin;`,
    {
      module,
      exports: module.exports,
      siyuan: api,
      console,
      // Advance virtual time only after pending promise continuations settle.
      Date: RuntimeDate,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );
  const PluginClass = module.exports.Runtime as new () => T;
  return new PluginClass();
}
