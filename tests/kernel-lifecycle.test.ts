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

  it("does not re-register Agent capabilities inside onrunning", () => {
    const onrunningMatch = source.match(
      /private\s+async\s+onrunning\s*\(\s*\)\s*:\s*Promise<void>\s*\{([\s\S]*?)\n  \}/,
    );
    expect(onrunningMatch).not.toBeNull();
    const body = onrunningMatch![1];
    expect(body).not.toMatch(
      /registerCapability|registerPolicyTool|agent\.register/,
    );
  });

  it("registers all 28 tools through the SiYuan 3.8.1 Agent capability API", () => {
    expect(source).toMatch(/this\.api\.agent\.registerCapability\(/);
    expect(source).toMatch(/this\.api\.agent\.unregisterCapability\(/);
    expect(source).not.toMatch(/this\.api\.mcp\.(?:registerTool|unregisterTool)\(/);
    expect(source.match(/await\s+this\.registerTool\(/g)).toHaveLength(28);
  });

  it("declares conservative local effects for read and write capabilities", () => {
    expect(source).toMatch(
      /function\s+genericToolConfig[\s\S]*?:\s*kernel\.IAgentCapabilityConfig/,
    );
    expect(source).toMatch(
      /effects:\s*readOnly\s*\?\s*\{\s*localRead:\s*true\s*\}\s*:\s*\{\s*localRead:\s*true,\s*localWrite:\s*true\s*\}/,
    );
  });
});

/**
 * Structural guard: registerEditBlockTool must deny update before any
 * document resolution or getBlockKramdown, and mark validateOnly as audit preview.
 */
describe("registerEditBlockTool policy-deny priority and audit metadata", () => {
  const source = readFileSync(kernelSourcePath, "utf8");

  function extractRegisterEditBlockBody(): string {
    const start = source.indexOf("private async registerEditBlockTool");
    expect(start).toBeGreaterThanOrEqual(0);
    // Next private method after registerEditBlockTool
    const next = source.indexOf("\n  private async ", start + 1);
    expect(next).toBeGreaterThan(start);
    return source.slice(start, next);
  }

  it("denies update before assertDocumentAllowed or getBlockKramdown", () => {
    const body = extractRegisterEditBlockBody();
    // Match executable statements only (ignore comment mentions).
    const denyIdx = body.search(
      /if\s*\(\s*this\.policy\.operations\.update\s*===\s*"deny"\s*\)/,
    );
    const ensureIdx = body.search(
      /this\.ensureOperation\(\s*"update"\s*,/,
    );
    const assertDocIdx = body.search(
      /await\s+this\.assertDocumentAllowed\s*\(/,
    );
    const kramdownIdx = body.search(
      /this\.client\.getBlockKramdown\s*\(/,
    );

    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(assertDocIdx).toBeGreaterThanOrEqual(0);
    expect(kramdownIdx).toBeGreaterThanOrEqual(0);

    // Deny gate must precede document resolution and kramdown reads.
    expect(denyIdx).toBeLessThan(assertDocIdx);
    expect(ensureIdx).toBeLessThan(assertDocIdx);
    expect(denyIdx).toBeLessThan(kramdownIdx);
    expect(ensureIdx).toBeLessThan(kramdownIdx);
  });

  it("sets AuditEntry.preview from validateOnly without logging bodies/hashes", () => {
    const body = extractRegisterEditBlockBody();
    // runTool metadata object must include preview: validateOnly
    const metaMatch = body.match(
      /return this\.runTool\(\s*"edit_block"\s*,\s*false\s*,\s*\{([\s\S]*?)\}\s*,/,
    );
    expect(metaMatch).not.toBeNull();
    const metadata = metaMatch![1];
    expect(metadata).toMatch(/preview\s*:\s*validateOnly/);
    // Metadata-only: no bodies, hashes, refs, or tokens.
    expect(metadata).not.toMatch(/markdown\s*:/);
    expect(metadata).not.toMatch(/expectedHash\s*:/);
    expect(metadata).not.toMatch(/expectedContent\s*:/);
    expect(metadata).not.toMatch(/body\s*:/);
    expect(metadata).not.toMatch(/token\s*:/);
    expect(metadata).not.toMatch(/referencing\s*:/);
  });
});
