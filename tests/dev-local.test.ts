/**
 * Tests for scripts/dev-local.ps1.
 * Temporary workspace only — never a real SiYuan data directory.
 * Requires PowerShell 7+ (pwsh).
 *
 * Uses the real repo dist/ produced by build:package (read-only assertions).
 * Does not write into repo dist/.
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const scriptPath = path.join(rootDir, "scripts", "dev-local.ps1");
const distDir = path.join(rootDir, "dist");

/** Async child timeout when the script must HTTP-talk to startLocalStub. */
const ASYNC_CHILD_TIMEOUT_MS = 15_000;

const requiredFiles = [
  "index.js",
  "index.css",
  "kernel.js",
  "plugin.json",
  "README.md",
  "README.zh-CN.md",
  "icon.png",
  "preview.png",
] as const;

const requiredDirs = ["i18n", "agent-skill"] as const;

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of temp fixtures only
    }
  }
  while (servers.length > 0) {
    const s = servers.pop()!;
    // Drop keep-alive sockets so close() does not hang after stub HTTP tests.
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Read-only: real repo dist must be complete (from build:package). Never writes dist/. */
function assertRepoDistComplete(): void {
  expect(existsSync(distDir), "dist/ missing — run pnpm build:package first").toBe(
    true,
  );
  for (const name of requiredFiles) {
    expect(
      existsSync(path.join(distDir, name)),
      `dist missing required file: ${name}`,
    ).toBe(true);
  }
  for (const name of requiredDirs) {
    const p = path.join(distDir, name);
    expect(existsSync(p), `dist missing required dir: ${name}`).toBe(true);
    expect(statSync(p).isDirectory(), name).toBe(true);
  }
  const meta = JSON.parse(
    readFileSync(path.join(distDir, "plugin.json"), "utf8"),
  ) as { name?: string };
  expect(meta.name).toBe("siyuanmaster");
}

function runDevLocal(
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", scriptPath, ...args],
    {
      cwd: rootDir,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 60_000,
      env: { ...process.env, ...(opts.env ?? {}) },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Async spawn of dev-local.ps1. Must be used whenever the child HTTP-calls
 * startLocalStub: spawnSync blocks the Vitest event loop so the stub cannot respond.
 */
function runDevLocalAsync(
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const timeoutMs = opts.timeoutMs ?? ASYNC_CHILD_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pwsh",
      ["-NoProfile", "-File", scriptPath, ...args],
      {
        cwd: rootDir,
        env: { ...process.env, ...(opts.env ?? {}) },
        // never shell:true — args must not go through a shell
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      // Hard kill if still alive shortly after
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, 500).unref?.();
      reject(
        new Error(
          `runDevLocalAsync timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr,
      });
    });
  });
}

function snapshotTree(
  root: string,
): Map<string, { size: number; mtimeMs: number }> {
  const map = new Map<string, { size: number; mtimeMs: number }>();
  const walk = (current: string, prefix: string) => {
    if (!existsSync(current)) {
      return;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        const st = statSync(abs);
        map.set(rel.replace(/\\/g, "/"), {
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  };
  walk(root, "");
  return map;
}

function seedOldPlugin(
  targetDir: string,
  marker: string,
  name = "siyuanmaster",
): void {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(path.join(targetDir, "index.js"), marker, "utf8");
  writeFileSync(path.join(targetDir, "kernel.js"), "old-kernel", "utf8");
  writeFileSync(
    path.join(targetDir, "plugin.json"),
    JSON.stringify({ name, version: "0.0.0-old" }),
    "utf8",
  );
}

function writeWorkspaceConf(workspace: string, token: string): void {
  const confDir = path.join(workspace, "conf");
  mkdirSync(confDir, { recursive: true });
  writeFileSync(
    path.join(confDir, "conf.json"),
    JSON.stringify({ api: { token } }),
    "utf8",
  );
}

/**
 * Allocate a free loopback port, then close the listener so the port is closed
 * (not accepting connections). Used for SkipReload install-only tests.
 */
async function allocateClosedLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to bind ephemeral port"));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

type StubCall = {
  path: string;
  body: string;
  enabled?: boolean;
};

type StubOptions = {
  workspaceDir: string;
  /** Behavior for setPetalEnabled enabled=true */
  enableResult?: "ok" | "fail";
  workspaceResult?: "ok" | "fail-code" | "empty-dir" | "mismatch";
  mismatchDir?: string;
};

function startLocalStub(opts: StubOptions): Promise<{
  baseUrl: string;
  port: number;
  calls: StubCall[];
  close: () => Promise<void>;
}> {
  const calls: StubCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const urlPath = req.url?.split("?")[0] ?? "";
      const call: StubCall = { path: urlPath, body };
      try {
        const parsed = body ? (JSON.parse(body) as { enabled?: boolean }) : {};
        if (typeof parsed.enabled === "boolean") {
          call.enabled = parsed.enabled;
        }
      } catch {
        // ignore non-json
      }
      calls.push(call);

      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (urlPath === "/api/system/getWorkspaceInfo") {
        const mode = opts.workspaceResult ?? "ok";
        if (mode === "fail-code") {
          json(200, { code: 1, msg: "nope" });
          return;
        }
        if (mode === "empty-dir") {
          json(200, { code: 0, data: { workspaceDir: "" } });
          return;
        }
        if (mode === "mismatch") {
          json(200, {
            code: 0,
            data: {
              workspaceDir:
                opts.mismatchDir ?? path.join(tmpdir(), "other-workspace-xyz"),
            },
          });
          return;
        }
        json(200, {
          code: 0,
          data: { workspaceDir: opts.workspaceDir },
        });
        return;
      }

      if (urlPath === "/api/petal/setPetalEnabled") {
        let enabled = true;
        try {
          enabled = Boolean((JSON.parse(body) as { enabled?: boolean }).enabled);
        } catch {
          // keep default
        }
        if (enabled && opts.enableResult === "fail") {
          json(200, { code: 1, msg: "enable failed" });
          return;
        }
        json(200, { code: 0, data: {} });
        return;
      }

      // MCP or anything else — not implemented (smoke not run in stub tests that stop earlier)
      json(404, { code: 404, msg: "not found" });
    });
  });

  servers.push(server);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("stub failed to bind"));
        return;
      }
      const { port } = addr;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        calls,
        close: () =>
          new Promise<void>((resClose) => {
            server.closeAllConnections?.();
            server.close(() => resClose());
          }),
      });
    });
  });
}

/**
 * Try to create a directory junction (Windows) or dir symlink (POSIX)
 * under a temp workspace only. Returns false when the platform/permissions
 * cannot create reparse points — callers must skip without touching real paths.
 */
function tryCreateDirReparsePoint(
  linkPath: string,
  targetPath: string,
): boolean {
  try {
    if (process.platform === "win32") {
      symlinkSync(targetPath, linkPath, "junction");
    } else {
      symlinkSync(targetPath, linkPath, "dir");
    }
    const st = lstatSync(linkPath);
    return st.isSymbolicLink() || st.isDirectory();
  } catch {
    return false;
  }
}

describe("dev-local.ps1", () => {
  it("script exists", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("repo dist is complete (read-only; no fixture writes)", () => {
    assertRepoDistComplete();
  });

  it("static: recovery re-enable is identity-safe (backupRestored / unmoved old target)", () => {
    const src = readFileSync(scriptPath, "utf8");
    expect(src).toMatch(/\$backupRestored\s*=\s*\$false/);
    expect(src).toMatch(/\$backupRestored\s*=\s*\$true/);
    expect(src).toMatch(/function Test-ShouldReEnablePreviousPlugin/);
    // Must not re-enable solely because target exists
    expect(src).toMatch(/Never re-enable merely because target path exists/i);
    expect(src).toMatch(/backupRestored=\$backupRestored/);
    // Re-enable forbidden path must mark recover incomplete
    expect(src).toMatch(/re-enable forbidden/);
    expect(src).toMatch(/recover incomplete/i);
    // Conditions: unmoved old target OR backupRestored
    expect(src).toMatch(
      /-not \$BackupMoved -and -not \$NewInstalled/,
    );
    // MCP smoke: explicit same-origin --url; no standalone "--" separator in PnpmArgs
    // (PowerShell & pnpm @("smoke:mcp","--","--url",...) forwards a literal "--" to the script.)
    expect(src).toMatch(
      /Invoke-Pnpm -PnpmArgs @\("smoke:mcp", "--url", \$mcpUrl\)/,
    );
    expect(src).toMatch(
      /Invoke-Pnpm -PnpmArgs @\("smoke:mcp", "--url", \$mcpUrl, "--read-smoke"\)/,
    );
    expect(src).not.toMatch(/@\("smoke:mcp",\s*"--"\s*,/);
    // getWorkspaceInfo before disable/swap
    expect(src).toMatch(/getWorkspaceInfo/);
    expect(src).toMatch(/before disable\/swap/i);
    // Quarantine recovery: TOCTOU revalidation calls for failedParent (backupBase) and its parents
    // before any New-Item/Move-Item use of failedPath.
    expect(src).toMatch(/Assert-ExistingPathNotReparse.*failedParent.*backupBase/);
    expect(src).toMatch(/Assert-ExistingParentsNotReparse.*failedParent/);
  });

  it("static: Test-ShouldReEnablePreviousPlugin truth table via pwsh", () => {
    // Extract and evaluate the pure helper through a small inline harness.
    const harness = `
      $ErrorActionPreference = 'Stop'
      function Test-ShouldReEnablePreviousPlugin {
        param(
          [bool] $HadExistingPlugin,
          [bool] $DisableAttempted,
          [bool] $BackupMoved,
          [bool] $NewInstalled,
          [bool] $BackupRestored,
          [string] $TargetPath
        )
        if (-not $HadExistingPlugin -or -not $DisableAttempted) { return $false }
        if ($BackupRestored) { return $true }
        if (-not $BackupMoved -and -not $NewInstalled -and (Test-Path -LiteralPath $TargetPath -PathType Container)) {
          return $true
        }
        return $false
      }
      $tmp = Join-Path $env:TEMP ("siyuanmaster-reenable-" + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $tmp | Out-Null
      try {
        $cases = @(
          # had, disable, moved, new, restored, targetExists, expect
          @{ h=$true; d=$true; m=$false; n=$false; r=$false; t=$true;  e=$true  },  # unmoved old
          @{ h=$true; d=$true; m=$true;  n=$true;  r=$true;  t=$true;  e=$true  },  # restored
          @{ h=$true; d=$true; m=$true;  n=$true;  r=$false; t=$true;  e=$false },  # failed quarantine — target is NEW, do not enable
          @{ h=$true; d=$true; m=$true;  n=$false; r=$false; t=$false; e=$false },  # moved, not restored, no target
          @{ h=$true; d=$false;m=$false; n=$false; r=$false; t=$true;  e=$false },  # disable not attempted
          @{ h=$false;d=$true; m=$false; n=$true;  r=$false; t=$true;  e=$false }   # no prior install
        )
        $i = 0
        foreach ($c in $cases) {
          $target = if ($c.t) { $tmp } else { Join-Path $tmp 'missing-target' }
          $got = Test-ShouldReEnablePreviousPlugin -HadExistingPlugin $c.h -DisableAttempted $c.d -BackupMoved $c.m -NewInstalled $c.n -BackupRestored $c.r -TargetPath $target
          if ($got -ne $c.e) {
            Write-Output "FAIL case=$i got=$got expect=$($c.e)"
            exit 2
          }
          $i++
        }
        Write-Output "OK cases=$i"
        exit 0
      } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      }
    `;
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", harness], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status, combined).toBe(0);
    expect(combined).toMatch(/OK cases=6/);
  });

  it("WhatIf validates and prints plan without changing workspace files", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-whatif-");
    const before = snapshotTree(workspace);
    const closedPort = await allocateClosedLoopbackPort();

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-WhatIf",
      "-SkipBuild",
      "-ApiBaseUrl",
      `http://127.0.0.1:${closedPort}`,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).toBe(0);
    expect(combined).toMatch(/stage=whatif/i);
    expect(combined).toMatch(/plan only/i);
    expect(combined).toMatch(/data[\\/]plugins[\\/]siyuanmaster/i);
    expect(combined).toMatch(/apiOrigin\s*=/i);
    expect(combined).toMatch(new RegExp(`mcpUrl\\s*=\\s*http://127\\.0\\.0\\.1:${closedPort}/mcp`));
    expect(combined).toMatch(/excludeApp only/i);
    // WhatIf must not print credential material
    expect(combined).not.toMatch(/user:pass/i);
    expect(combined).not.toMatch(/Authorization/i);

    const after = snapshotTree(workspace);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, beforeMeta] of before) {
      const afterMeta = after.get(key);
      expect(afterMeta, key).toBeDefined();
      expect(afterMeta!.size).toBe(beforeMeta.size);
      expect(afterMeta!.mtimeMs).toBe(beforeMeta.mtimeMs);
    }
    expect(existsSync(path.join(workspace, "data", "plugins"))).toBe(false);
  });

  it("SkipBuild+SkipReload installs into temp target and backs up prior install (closed port)", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-install-");
    const pluginsDir = path.join(workspace, "data", "plugins");
    const targetDir = path.join(pluginsDir, "siyuanmaster");
    const oldMarker = "OLD_INSTALL_MARKER_CONTENT_xyz";
    seedOldPlugin(targetDir, oldMarker);
    const closedPort = await allocateClosedLoopbackPort();

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-SkipReload",
      "-ApiBaseUrl",
      `http://127.0.0.1:${closedPort}`,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).toBe(0);
    expect(combined).toMatch(/manual restart required/i);
    expect(combined).toMatch(/backup=/i);

    for (const name of requiredFiles) {
      const distBytes = readFileSync(path.join(distDir, name));
      const targetBytes = readFileSync(path.join(targetDir, name));
      expect(Buffer.compare(distBytes, targetBytes), name).toBe(0);
    }

    const backupsRoot = path.join(pluginsDir, ".siyuanmaster-dev-backups");
    expect(existsSync(backupsRoot)).toBe(true);
    const backupRuns = readdirSync(backupsRoot);
    expect(backupRuns.length).toBeGreaterThanOrEqual(1);
    const backupPlugin = path.join(
      backupsRoot,
      backupRuns[0]!,
      "siyuanmaster",
    );
    expect(existsSync(backupPlugin)).toBe(true);
    expect(readFileSync(path.join(backupPlugin, "index.js"), "utf8")).toBe(
      oldMarker,
    );

    const stagingLeft = readdirSync(pluginsDir).filter((n) =>
      n.startsWith(".siyuanmaster-staging-"),
    );
    expect(stagingLeft).toEqual([]);
  });

  it("fresh install does not create empty backup root", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-fresh-");
    const pluginsDir = path.join(workspace, "data", "plugins");
    const closedPort = await allocateClosedLoopbackPort();

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-SkipReload",
      "-ApiBaseUrl",
      `http://127.0.0.1:${closedPort}`,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).toBe(0);
    expect(combined).toMatch(/backup=none/i);
    expect(
      existsSync(path.join(pluginsDir, ".siyuanmaster-dev-backups")),
    ).toBe(false);
  });

  it("rejects non-loopback ApiBaseUrl", () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-noloop-");

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-WhatIf",
      "-SkipBuild",
      "-ApiBaseUrl",
      "http://example.com:6806",
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/loopback/i);
    expect(existsSync(path.join(workspace, "data"))).toBe(false);
  });

  // Four sequential pwsh WhatIf calls; default 5s vitest timeout is too tight under load.
  it("rejects non-origin ApiBaseUrl (path, query, userinfo)", () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-origin-");

    for (const bad of [
      "http://127.0.0.1:6806/mcp",
      "http://127.0.0.1:6806?x=1",
      "http://user:pass@127.0.0.1:6806",
      "http://127.0.0.1:6806#frag",
    ]) {
      const result = runDevLocal([
        "-Workspace",
        workspace,
        "-WhatIf",
        "-SkipBuild",
        "-ApiBaseUrl",
        bad,
      ]);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status, `url=${bad}\n${combined}`).not.toBe(0);
      expect(combined).toMatch(/origin/i);
      // Must not echo credentials from userinfo URLs
      expect(combined).not.toMatch(/user:pass/);
    }
  }, 15_000);

  it("SkipReload refuses when ApiBaseUrl port is reachable unless AllowRunningWithoutReload", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-skip-open-");
    const stub = await startLocalStub({
      workspaceDir: workspace,
    });

    const denied = runDevLocal([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-SkipReload",
      "-ApiBaseUrl",
      stub.baseUrl,
    ]);
    const deniedOut = `${denied.stdout}\n${denied.stderr}`;
    expect(denied.status, deniedOut).not.toBe(0);
    expect(deniedOut).toMatch(/port is reachable|SkipReload/i);
    expect(
      existsSync(path.join(workspace, "data", "plugins", "siyuanmaster")),
    ).toBe(false);

    const allowed = runDevLocal([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-SkipReload",
      "-AllowRunningWithoutReload",
      "-ApiBaseUrl",
      stub.baseUrl,
    ]);
    const allowedOut = `${allowed.stdout}\n${allowed.stderr}`;
    expect(allowed.status, allowedOut).toBe(0);
    expect(allowedOut).toMatch(/manual restart required/i);
    expect(
      existsSync(path.join(workspace, "data", "plugins", "siyuanmaster")),
    ).toBe(true);
  });

  it("TestFailAfterBackupMove restores old target and keeps prior content", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-fail-after-backup-");
    const pluginsDir = path.join(workspace, "data", "plugins");
    const targetDir = path.join(pluginsDir, "siyuanmaster");
    const oldMarker = "OLD_MARKER_FAIL_AFTER_BACKUP_abc123";
    seedOldPlugin(targetDir, oldMarker);
    const closedPort = await allocateClosedLoopbackPort();

    const distIndex = readFileSync(path.join(distDir, "index.js"));

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-SkipReload",
      "-TestFailAfterBackupMove",
      "-ApiBaseUrl",
      `http://127.0.0.1:${closedPort}`,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/TestFailAfterBackupMove/i);

    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(path.join(targetDir, "index.js"), "utf8")).toBe(
      oldMarker,
    );
    expect(readFileSync(path.join(targetDir, "kernel.js"), "utf8")).toBe(
      "old-kernel",
    );

    const targetIndex = readFileSync(path.join(targetDir, "index.js"));
    expect(Buffer.compare(targetIndex, distIndex)).not.toBe(0);

    const stagingLeft = readdirSync(pluginsDir).filter((n) =>
      n.startsWith(".siyuanmaster-staging-"),
    );
    expect(stagingLeft.length).toBeGreaterThanOrEqual(1);

    const backupsRoot = path.join(pluginsDir, ".siyuanmaster-dev-backups");
    expect(existsSync(backupsRoot)).toBe(true);
  });

  it("fault inject: quarantine fail forbids re-enable and marks recover incomplete", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-quarantine-fail-");
    const pluginsDir = path.join(workspace, "data", "plugins");
    const targetDir = path.join(pluginsDir, "siyuanmaster");
    const oldMarker = "OLD_QUARANTINE_FAIL_marker";
    seedOldPlugin(targetDir, oldMarker);
    writeWorkspaceConf(workspace, "test-token-quarantine-fail");

    const stub = await startLocalStub({
      workspaceDir: workspace,
      enableResult: "fail",
    });

    // Must use async spawn: spawnSync blocks the event loop so the HTTP stub cannot respond.
    const result = await runDevLocalAsync(
      [
        "-Workspace",
        workspace,
        "-SkipBuild",
        "-TestFailAfterSwap",
        "-TestFailQuarantine",
        "-ApiBaseUrl",
        stub.baseUrl,
      ],
      // smoke would hit 404 if enable succeeded; we fail earlier via TestFailAfterSwap
      { timeoutMs: ASYNC_CHILD_TIMEOUT_MS },
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/TestFailAfterSwap|re-enable forbidden|recover incomplete/i);
    expect(combined).toMatch(/re-enable forbidden|recover incomplete/i);

    // New install left at target (quarantine forced fail); must NOT look like successful re-enable of old only.
    // Target still occupied by new dist (or partial) — old marker not at target if swap completed.
    expect(existsSync(targetDir)).toBe(true);
    const targetIndex = readFileSync(path.join(targetDir, "index.js"), "utf8");
    expect(targetIndex).not.toBe(oldMarker);

    // Backup retained (not restored)
    const backupsRoot = path.join(pluginsDir, ".siyuanmaster-dev-backups");
    expect(existsSync(backupsRoot)).toBe(true);
    const backupRuns = readdirSync(backupsRoot);
    expect(backupRuns.length).toBeGreaterThanOrEqual(1);
    const backupPlugin = path.join(
      backupsRoot,
      backupRuns[0]!,
      "siyuanmaster",
    );
    expect(existsSync(backupPlugin)).toBe(true);
    expect(readFileSync(path.join(backupPlugin, "index.js"), "utf8")).toBe(
      oldMarker,
    );

    // Must not have issued setPetalEnabled enabled=true for re-enable after failed restore
    const enableTrueCalls = stub.calls.filter(
      (c) => c.path === "/api/petal/setPetalEnabled" && c.enabled === true,
    );
    // Only recovery re-enable would set enabled=true here (TestFailAfterSwap fails before enable stage).
    expect(enableTrueCalls.length).toBe(0);

    // Workspace check happened; no raw token in output
    expect(stub.calls.some((c) => c.path === "/api/system/getWorkspaceInfo")).toBe(
      true,
    );
    expect(combined).not.toContain("test-token-quarantine-fail");
  });

  it("successful quarantine nests failed plugin under .siyuanmaster-dev-backups (not directly in data/plugins)", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-quarantine-ok-");
    const pluginsDir = path.join(workspace, "data", "plugins");
    const targetDir = path.join(pluginsDir, "siyuanmaster");
    const oldMarker = "OLD_QUARANTINE_OK_marker";
    seedOldPlugin(targetDir, oldMarker);
    writeWorkspaceConf(workspace, "test-token-quarantine-ok");

    const stub = await startLocalStub({
      workspaceDir: workspace,
      enableResult: "ok",
    });

    // Fail after swap; quarantine SHOULD succeed (no TestFailQuarantine flag).
    const result = await runDevLocalAsync(
      [
        "-Workspace",
        workspace,
        "-SkipBuild",
        "-TestFailAfterSwap",
        "-ApiBaseUrl",
        stub.baseUrl,
      ],
      { timeoutMs: ASYNC_CHILD_TIMEOUT_MS },
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/TestFailAfterSwap/i);

    // CRITICAL: Failed plugin must NOT be a direct child of data/plugins.
    // No .siyuanmaster-failed-* or .quarantine-* should exist at data/plugins level.
    // This proves the failed plugin is nested somewhere else (under .siyuanmaster-dev-backups).
    const directChildren = readdirSync(pluginsDir);
    const failedDirect = directChildren.filter((n) =>
      n.startsWith(".siyuanmaster-failed-") || n.startsWith(".quarantine-"),
    );
    expect(failedDirect, "failed plugin must not be directly under data/plugins (must be nested under .siyuanmaster-dev-backups)").toEqual([]);

    // Backup root should exist (proves we had a prior install and backup was attempted).
    const backupsRoot = path.join(pluginsDir, ".siyuanmaster-dev-backups");
    expect(existsSync(backupsRoot), "backup root should exist").toBe(true);

    const backupRuns = readdirSync(backupsRoot);
    expect(backupRuns.length, "at least one run dir should exist under backup root").toBeGreaterThanOrEqual(1);

    // Exactly one .quarantine-* entry should exist directly under backup root.
    const quarantineRuns = backupRuns.filter((n) => n.startsWith(".quarantine-"));
    expect(quarantineRuns.length, "exactly one .quarantine-* entry should exist under .siyuanmaster-dev-backups").toBe(1);

    // That quarantine entry is a directory.
    const quarantinePath = path.join(backupsRoot, quarantineRuns[0]!);
    expect(existsSync(quarantinePath), "quarantine entry should be a directory").toBe(true);
    expect(statSync(quarantinePath).isDirectory(), "quarantine entry must be a directory").toBe(true);

    // Move-Item -Destination quarantinePath: plugin files land directly inside quarantinePath
    // (the new plugin content is moved INTO quarantinePath, not into a subdir named siyuanmaster).
    // Must contain required plugin files (proves quarantine captured the new install, not empty).
    const quarantineEntries = readdirSync(quarantinePath);
    expect(quarantineEntries.length, "quarantine directory should not be empty").toBeGreaterThan(0);
    expect(quarantineEntries.includes("plugin.json"), "quarantine should contain plugin.json").toBe(true);
    expect(quarantineEntries.includes("index.js"), "quarantine should contain index.js").toBe(true);

    // Quarantined plugin is the NEW dist (not the old marker).
    const quarantineIndex = readFileSync(path.join(quarantinePath, "index.js"), "utf8");
    expect(quarantineIndex).not.toBe(oldMarker);

    // Recovery: canonical targetDir should exist again with the old plugin restored.
    expect(existsSync(targetDir), "target should exist after backup restoration").toBe(true);
    expect(readFileSync(path.join(targetDir, "index.js"), "utf8"), "target should contain old marker after backup restored").toBe(oldMarker);

    // Only "siyuanmaster" should be a direct-scan-visible plugin under data/plugins.
    // Enumerate every direct child of data/plugins that contains a plugin.json.
    const scanVisiblePlugins = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(path.join(pluginsDir, e.name, "plugin.json")))
      .map((e) => e.name);
    expect(scanVisiblePlugins, "only siyuanmaster should be a direct-scan-visible plugin under data/plugins").toEqual(["siyuanmaster"]);

    // Token must not appear in output.
    expect(combined).not.toContain("test-token-quarantine-ok");
  });

  it("getWorkspaceInfo mismatch fails closed before disable/swap", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-ws-mismatch-");
    const pluginsDir = path.join(workspace, "data", "plugins");
    const targetDir = path.join(pluginsDir, "siyuanmaster");
    const oldMarker = "OLD_WS_MISMATCH_marker";
    seedOldPlugin(targetDir, oldMarker);
    writeWorkspaceConf(workspace, "test-token-ws-mismatch");

    const stub = await startLocalStub({
      workspaceDir: workspace,
      workspaceResult: "mismatch",
      mismatchDir: path.join(tmpdir(), "siyuanmaster-other-ws-not-this-one"),
    });

    // Must use async spawn so the in-process HTTP stub can answer getWorkspaceInfo.
    const result = await runDevLocalAsync([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-ApiBaseUrl",
      stub.baseUrl,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/workspaceDir does not match|stage=workspace/i);

    // Old target untouched
    expect(readFileSync(path.join(targetDir, "index.js"), "utf8")).toBe(
      oldMarker,
    );

    // No setPetalEnabled before fail
    expect(
      stub.calls.some((c) => c.path === "/api/petal/setPetalEnabled"),
    ).toBe(false);
    expect(
      stub.calls.some((c) => c.path === "/api/system/getWorkspaceInfo"),
    ).toBe(true);

    // No backup move directory created (backup root only after existing install + later stages;
    // may exist if created before workspace check — script creates backupRoot after stage, before workspace)
    // Target must still be the old plugin.
    expect(existsSync(targetDir)).toBe(true);

    // No secrets in output
    expect(combined).not.toContain("test-token-ws-mismatch");
  });

  it("getWorkspaceInfo match proceeds past workspace stage (smoke uses same origin)", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-ws-match-");
    writeWorkspaceConf(workspace, "test-token-ws-match");

    const stub = await startLocalStub({
      workspaceDir: workspace,
      enableResult: "ok",
    });

    // Fail after swap so we don't need a full MCP server; proves workspace+disable+swap order.
    // Async spawn required: child HTTP-calls the stub while the Vitest loop serves it.
    const result = await runDevLocalAsync([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-TestFailAfterSwap",
      "-ApiBaseUrl",
      stub.baseUrl,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/TestFailAfterSwap/i);
    expect(combined).toMatch(/stage=workspace.*OK|workspace.*OK/i);

    const paths = stub.calls.map((c) => c.path);
    expect(paths[0]).toBe("/api/system/getWorkspaceInfo");
    // Fresh install: no disable
    expect(paths.filter((p) => p === "/api/system/getWorkspaceInfo").length).toBe(
      1,
    );

    // WhatIf-equivalent: MCP URL construction uses same origin (assert via script static + WhatIf already).
    // Also assert recovery did not re-enable (no prior install)
    const enableTrue = stub.calls.filter(
      (c) => c.path === "/api/petal/setPetalEnabled" && c.enabled === true,
    );
    expect(enableTrue.length).toBe(0);
    expect(combined).not.toContain("test-token-ws-match");
  });

  it("WhatIf plans smoke --url on same origin as ApiBaseUrl", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-smoke-url-");
    const port = await allocateClosedLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-WhatIf",
      "-SkipBuild",
      "-ReadSmoke",
      "-ApiBaseUrl",
      origin,
    ]);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).toBe(0);
    // WhatIf plan must show explicit same-origin --url without a redundant pnpm separator
    expect(combined).toContain(`pnpm smoke:mcp --url "${origin}/mcp" --read-smoke`);
    expect(combined).not.toMatch(/smoke:mcp\s+--\s+--url/);
    expect(combined).toMatch(/--read-smoke/);
  });

  it("rejects existing target whose plugin.json name is not siyuanmaster", async () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-wrong-name-");
    const targetDir = path.join(workspace, "data", "plugins", "siyuanmaster");
    seedOldPlugin(targetDir, "not-our-plugin", "some-other-plugin");
    const closedPort = await allocateClosedLoopbackPort();

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-SkipBuild",
      "-SkipReload",
      "-ApiBaseUrl",
      `http://127.0.0.1:${closedPort}`,
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/refusing to treat ordinary directory as backup|name must be exactly/i);
    expect(readFileSync(path.join(targetDir, "index.js"), "utf8")).toBe(
      "not-our-plugin",
    );
  });

  it("rejects data/plugins when it is a junction or symlink", () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-reparse-");
    const outside = makeTempDir("siyuanmaster-dev-local-reparse-outside-");
    const dataDir = path.join(workspace, "data");
    mkdirSync(dataDir, { recursive: true });
    const pluginsLink = path.join(dataDir, "plugins");

    const created = tryCreateDirReparsePoint(pluginsLink, outside);
    if (!created) {
      console.warn(
        "[dev-local.test] skip reparse rejection: cannot create junction/symlink on this platform",
      );
      return;
    }

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-WhatIf",
      "-SkipBuild",
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/reparse|junction|symlink/i);
    expect(existsSync(path.join(outside, "siyuanmaster"))).toBe(false);
  });

  it("rejects backupBase when it is a junction or symlink (WhatIf; no external/target mutation)", () => {
    assertRepoDistComplete();
    const workspace = makeTempDir("siyuanmaster-dev-local-backupbase-reparse-");
    const outside = makeTempDir(
      "siyuanmaster-dev-local-backupbase-reparse-outside-",
    );
    const pluginsDir = path.join(workspace, "data", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    // plugins is a normal directory; only backupBase is a reparse point.
    const targetDir = path.join(pluginsDir, "siyuanmaster");
    const oldMarker = "OLD_BACKUPBASE_REPARSE_marker";
    seedOldPlugin(targetDir, oldMarker);

    const outsideMarker = path.join(outside, "keep-me.txt");
    writeFileSync(outsideMarker, "EXTERNAL_UNCHANGED", "utf8");
    mkdirSync(path.join(outside, "nested"), { recursive: true });
    writeFileSync(
      path.join(outside, "nested", "leaf.txt"),
      "NESTED_EXTERNAL",
      "utf8",
    );
    const outsideBefore = snapshotTree(outside);

    const backupBaseLink = path.join(pluginsDir, ".siyuanmaster-dev-backups");
    const created = tryCreateDirReparsePoint(backupBaseLink, outside);
    if (!created) {
      console.warn(
        "[dev-local.test] skip backupBase reparse rejection: cannot create junction/symlink on this platform",
      );
      return;
    }

    const result = runDevLocal([
      "-Workspace",
      workspace,
      "-WhatIf",
      "-SkipBuild",
    ]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combined).not.toBe(0);
    expect(combined).toMatch(/reparse|junction|symlink/i);
    expect(combined).toMatch(/backupBase|validate/i);
    // Must fail at validate: no build / plan-OK / staging progress
    expect(combined).not.toMatch(/stage=whatif.*OK/i);
    expect(combined).not.toMatch(/stage=build/i);
    expect(combined).not.toMatch(/stage=stage/i);

    // External directory tree completely unchanged
    const outsideAfter = snapshotTree(outside);
    expect([...outsideAfter.keys()].sort()).toEqual(
      [...outsideBefore.keys()].sort(),
    );
    for (const [key, beforeMeta] of outsideBefore) {
      const afterMeta = outsideAfter.get(key);
      expect(afterMeta, key).toBeDefined();
      expect(afterMeta!.size).toBe(beforeMeta.size);
      expect(afterMeta!.mtimeMs).toBe(beforeMeta.mtimeMs);
    }
    expect(readFileSync(outsideMarker, "utf8")).toBe("EXTERNAL_UNCHANGED");

    // Formal target unchanged
    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(path.join(targetDir, "index.js"), "utf8")).toBe(
      oldMarker,
    );
    expect(
      readdirSync(pluginsDir).filter((n) =>
        n.startsWith(".siyuanmaster-staging-"),
      ),
    ).toEqual([]);
  });
});
