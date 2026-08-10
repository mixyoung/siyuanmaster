import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernelSourcePath = path.join(rootDir, "src", "kernel.ts");
const lifecycleHooks = ["onload", "onrunning", "onunload"] as const;

/**
 * Structural guard for IPluginLifecycle binding on the kernel plugin.
 * Runtime SiYuan 3.8+ errors if any lifecycle field is not a function.
 */
describe("kernel IPluginLifecycle bindings", () => {
  const source = readFileSync(kernelSourcePath, "utf8");

  it("binds all three lifecycle hooks in the constructor", () => {
    for (const hook of lifecycleHooks) {
      expect(source).toMatch(
        new RegExp(
          String.raw`this\.api\.plugin\.lifecycle\.${hook}\s*=\s*this\.${hook}\.bind\(this\)`,
        ),
      );
    }
  });

  it("declares private async methods for each lifecycle hook", () => {
    for (const hook of lifecycleHooks) {
      expect(source).toMatch(
        new RegExp(String.raw`private\s+async\s+${hook}\s*\(\s*\)\s*:\s*Promise<void>`),
      );
    }
  });

  it("does not re-register MCP tools inside onrunning", () => {
    const onrunningMatch = source.match(
      /private\s+async\s+onrunning\s*\(\s*\)\s*:\s*Promise<void>\s*\{([\s\S]*?)\n  \}/,
    );
    expect(onrunningMatch).not.toBeNull();
    const body = onrunningMatch![1];
    expect(body).not.toMatch(/registerTool|registerPolicyTool|mcp\.register/);
  });
});
