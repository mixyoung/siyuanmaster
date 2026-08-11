# SiYuanMaster

SiYuanMaster is a native SiYuan plugin that lets trusted local AI assistants read, write, and manage SiYuan notes safely and under user control.

| | |
|---|---|
| **Brand** | SiYuanMaster / 思源大师 |
| **Package** | `siyuanmaster` |
| **Version** | `0.5.2` |
| **Technical plugin ID** | `siyuanmaster` |
| **MCP namespace** | `plugin__siyuanmaster__*` |
| **Repository** | https://github.com/mixyoung/siyuanmaster |

**Breaking change (0.5.0):** The technical plugin ID is now `siyuanmaster`. Install path is `data/plugins/siyuanmaster`; MCP tools are `plugin__siyuanmaster__*`. Previous `plugin__siyuan_agent_access__*` names are gone — **update external agent/skill configs manually**. On first load, policy/audit are **auto-copied** from `data/storage/petal/siyuan-agent-access/` into `data/storage/petal/siyuanmaster/` when the new side is missing (new always wins; fail-closed). The legacy petal directory is **kept and never deleted**.

## Overview

SiYuanMaster runs inside SiYuan as a desktop plugin. It registers policy-aware tools on SiYuan’s built-in `/mcp` endpoint, exposes a sidebar for connection status and safety policy, and does not start a separate Node or Python service.

- Notebook allow/deny access with per-operation allow / confirm / deny
- Safe Write Transaction for `update_note` and `edit_block`
- Two-step rename/move with one-time preview tokens
- Optional tagging rules; AI tag suggestions default to proposals
- Metadata-only audit log (no note bodies)
- UI text follows SiYuan’s editor font size

## Implemented capabilities

- Sidebar: connection status, safety policy, and P1 capability status
- GUI configuration for notebook access, operations, tagging, and write safety
- **19** tools on `/mcp` (original 16 + 3 P1): fully-qualified names are `plugin__siyuanmaster__*`
- Bounded document-tree browsing (`list_document_tree`; metadata only, never full bodies)
- Path lookup (`resolve_document`, read-only), long-note windows (`read_note_segments`), block edit (`edit_block`)
- Kernel-enforced notebook boundaries; notebook decisions apply to descendants
- Capability catalog: `catalog/capabilities.json` (build fails if generated sources are stale)

## Quick start

1. Build or obtain the plugin package (`pnpm build` produces `package.zip` / `dist/`).
2. Install into the SiYuan workspace:

```text
<workspace>/data/plugins/siyuanmaster
```

3. Enable the plugin in SiYuan and open the **SiYuanMaster** dock on the right.
4. Select notebooks to allow. Default access is allowlist mode with an **empty** selection — nothing is accessible until you choose notebooks.

Minimum SiYuan version: `3.7.0` (see `plugin.json`).

## Connect an AI assistant (MCP)

Point a local MCP client at SiYuan’s built-in endpoint. Use your own API token; never commit real credentials.

```json
{
  "mcpServers": {
    "siyuan": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:6806/mcp",
      "headers": {
        "Authorization": "Token ${SIYUAN_API_TOKEN}"
      }
    }
  }
}
```

Recommended first calls:

1. `plugin__siyuanmaster__get_policy`
2. `plugin__siyuanmaster__list_accessible_notebooks`
3. Then browse with `list_document_tree`, resolve paths with `resolve_document`, read long notes with `read_note_segments`, or edit blocks with `edit_block`.

When policy requires confirmation, obtain user approval, then retry with `confirmed=true`. Never set `confirmed=true` without real approval.

## Tools (19 = original 16 + 3 P1)

All tools are registered as `plugin__siyuanmaster__<name>`.

**Original 16** (names unchanged):

`get_policy`, `list_accessible_notebooks`, `list_document_tree`, `search_notes`, `read_note`, `create_note`, `append_note`, `update_note`, `rename_note`, `move_note`, `delete_note`, `suggest_tags`, `apply_tags`, `prepare_summary`, `save_memory`, `get_audit_log`

**P1 additions:**

| Tool | Role |
|---|---|
| `resolve_document` | Read-only lookup by notebook + human path (`hPath`); writes still require exact IDs |
| `read_note_segments` | Outline + hard-capped full-block windows for long notes. Optional `includeStateHash=true` attaches a 64-char lowercase SHA-256 `stateHash` per **returned window** block from exact `getBlockKramdown` (not SQL text; never hashes the full document). Use those hashes as `edit_block.expectedHash`. |
| `edit_block` | Exact block ID; `expectedContent` or `expectedHash`; reference impact; Safe Write Transaction (snapshot → confirm → recheck → execute once → readback; never retries a failed write). `validateOnly=true` runs the full preflight and returns `mode=validated` / `writeExecuted=false` without any write API (even if `confirmed=true`). Audit metadata sets `preview=true` for validateOnly and `preview=false` for a real edit (metadata only; no bodies/hashes). |

Structural tools `rename_note` / `move_note` use a two-step, one-time `previewToken`. Cross-notebook moves are a separate permission and are denied by default.

## Safety and tagging

| Rule | Behavior |
|---|---|
| Default access | Empty allowlist — deny until notebooks are selected |
| Writes | Follow per-operation policy (`allow` / `confirm` / `deny`); several writes default to confirm; delete defaults to deny and always needs confirmation |
| `snapshotBeforeWrite` | Mandatory `true` (normalized even if stored as false); not a user toggle |
| `permissionInheritance` | Mandatory `true`; notebook decision applies to all descendants |
| Tags | Existing tags are read first, then appended, trimmed, and de-duplicated — never overwritten |
| Auto-tag | No automatic tag without an explicit choice or a saved strategy; AI suggestions are **proposals** unless automatic application is enabled |
| Audit | Metadata only; content redaction on |
| Writes transport | SiYuan Kernel APIs only — never direct `.sy` file I/O |

Safe Write Transaction (`update_note`, `edit_block`): pre-write snapshot (failure stops) → confirm when required → state recheck → execute once → readback. Result `unknown` is never auto-retried. Audit records omit bodies.

**Boundary:** Plugin policy applies only to tools this plugin registers. SiYuan’s native `/mcp` is administrator-authenticated; a client with the full API token can still call other native high-privilege tools. That boundary is known and not hidden by this plugin.

## Optional Rust components

| Crate | Role |
|---|---|
| `siyuanmaster-core` | Shared catalog, token, permission primitives, transaction helpers |
| `siyuanmasterd` | Local HTTP gateway (scoped tokens, health, catalog, txn endpoints) |
| `siyuanmaster` | CLI |

These are optional local helpers. They do not replace the TypeScript plugin path for everyday SiYuan use.

## Verified on SiYuan 3.8.0-alpha.2 (local)

Evidence from a **real local SiYuan 3.8.0-alpha.2** instance (dedicated disposable notebook; plugin tools only):

- MCP `initialize` negotiated protocol **`2025-03-26`**
- `tools/list`: **51** tools total — **19** `plugin__siyuanmaster__*`, **0** legacy `plugin__siyuan_agent_access__*`
- Read smoke: `get_policy`, `list_accessible_notebooks`
- Full write smoke (writes never retried): `create_note` → visibility `read_note` → `resolve_document` → `read_note_segments(includeStateHash=true)` → `edit_block validateOnly=true` (no write) → **one** confirmed `edit_block` committed and verified → post-edit `read_note` → **one** `update_note` → final `read_note` → `delete_note` cleanup
- Audit metadata distinguishes validateOnly (`preview=true`) from real edit (`preview=false`)

This is **not** a claim of full external-project parity (Bridge / Sisyphus) or of every tool combination under every policy.

## Current limitations

- **Permissions:** Effective model is notebook decision inherited by descendants. Document-level read/write/hidden overrides are **not** wired into the plugin.
- **Write confirm retry:** For `update_note` / `edit_block`, a confirmation retry starts a **new** transaction and snapshot. There is no persistent cross-call preview token and no user-visible full diff.
- **Still unverified on a real instance (unless separate evidence exists):** non-empty block-reference scenarios (`referenceProtection` with real refs), very long-document `read_note_segments` performance/sorting, Dock/settings **GUI visual** behavior, and gateway outbound proxy toward the SiYuan kernel.
- **Scope:** This is not a claim of complete SiYuan feature coverage (no attribute-view database tooling, flashcards, timeline, Docker/remote deployment, multi-block table editors, asset upload, and similar backlog items).

## Development and build

```bash
pnpm build          # generate → check → typecheck → build:package → test
pnpm build:package  # esbuild + dist/ + package.zip only
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

### MCP discovery smoke (optional)

Requires a running local SiYuan and `SIYUAN_API_TOKEN`. Loopback only; the token is never printed. Validates the 19 `plugin__siyuanmaster__*` tools against `catalog/capabilities.json` and asserts zero legacy `plugin__siyuan_agent_access__*` names.

- **Default discovery:** zero note writes (initialize → session → tools/list + catalog match only).
- **`--read-smoke`:** sequentially calls the two read-only tools `get_policy` and `list_accessible_notebooks`; prints only `isError`, whether `structuredContent` is present, top-level keys, and top-level array field names/counts — never array elements or values. These calls may write **metadata-only audit** entries.
- **Token:** the script always sends `Authorization: Token …`. On SiYuan `3.8.0-alpha.2` live observation, requests without `Authorization` may still succeed while a wrong token returns `401`. This script does **not** claim that native authentication is required.

```bash
pnpm smoke:mcp
pnpm smoke:mcp -- --read-smoke   # also call get_policy + list_accessible_notebooks (read-only; safe summary only)
```

### MCP destructive write smoke (optional, explicit opt-in)

**Separate from discovery/read smoke.** Default `pnpm smoke:mcp` / `--read-smoke` never create, update, or delete notes. This write smoke is **destructive** and will not run without both a disposable notebook id and an explicit acknowledgement flag.

Preconditions:

- A **disposable allowed notebook** whose id you pass with `--notebook-id` (only that notebook is targeted).
- Plugin policy: `create` / `update` / `read` / `delete` must **not** be `deny`. Delete defaults to `deny` — set delete to **`allow` or `confirm`** so preflight permits cleanup; otherwise the smoke **refuses create**.
- `SIYUAN_API_TOKEN` set (never printed). Loopback MCP URL only.
- Explicit acknowledgement: **`--confirm-destructive-smoke`** (required).

Lifecycle (plugin tools only; no native API / bypass; **writes never retried**):
`get_policy` → `list_accessible_notebooks` (preflight) → `create_note` → readiness `read_note` (bounded poll; capture `hPath`) → `resolve_document` → `read_note_segments` (over-limit clamp + `includeStateHash=true` for marker `stateHash`) → `edit_block validateOnly=true` (full preflight, **no write**) → **one** `edit_block` (`validateOnly=false`, `confirmed=true`, same `blockId`/`markdown`/`expectedHash`) → post-edit `read_note` (edit marker) → **one** `update_note` → final `read_note` → `delete_note` cleanup.

After create, the smoke waits up to a **bounded window** (~5s: 20 × 250ms) for SiYuan index visibility via plugin **`read_note` only** (`confirmed=true`). Only read polls may be retried; **create / edit_block / update / delete are never retried**. `{ok:false}` is treated as not-yet-visible until the bound; malformed MCP/`structuredContent` is a hard failure. `edit_block` uses window `stateHash` from `includeStateHash` — not SQL segment text — as `expectedHash`.
Success leaves **no** smoke note. **Known-ID** post-create failures (validated SiYuan `documentId`) get **exactly one** plugin `delete_note` cleanup attempt; if cleanup fails, a note **may remain** and the error prints **only** that validated `documentId` (no title/body/token/session). **Unknown create outcome** (timeout, missing/malformed envelope, `{ok:false}`, or missing/invalid `documentId`) cannot run cleanup safely — the error reports **`artifactPossiblyCreated=true`** and that manual inspection is required in the selected disposable notebook (**no** `documentId` / title / body / token / session).

```bash
pnpm smoke:mcp:write -- --notebook-id <DISPOSABLE_NOTEBOOK_ID> --confirm-destructive-smoke
# optional: --url http://127.0.0.1:6806/mcp
```

### Local Windows loop (`dev:local`)

One-shot **build → safe install → SiYuan reload → MCP smoke** for desktop development (PowerShell 7+). Install target is always:

```text
<Workspace>/data/plugins/siyuanmaster
```

```bash
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace"
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace" -ReadSmoke
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace" -WhatIf
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace" -SkipBuild -SkipReload   # install only; port must be closed unless overridden
```

| Flag | Behavior |
|---|---|
| `-Workspace` | **Required.** SiYuan workspace root (absolute path recommended). |
| `-SkipBuild` | Use existing `dist/` (skip `pnpm build`). |
| `-SkipReload` | Install only; **no** `setPetalEnabled`, **no** MCP smoke. Prints `manual restart required`. By default **refuses** if the `-ApiBaseUrl` TCP port is reachable (a running SiYuan would keep old plugin bits). Use only when SiYuan is not running or you will restart manually. Default path always reloads + smokes. |
| `-AllowRunningWithoutReload` | **Override for `-SkipReload` only.** Allows install while the API port is open. **Risk:** the running instance may continue serving the previous plugin until a real reload/restart. Prefer leaving the port closed instead of using this flag. |
| `-ReadSmoke` | After reload, run `pnpm smoke:mcp --url <ApiBaseUrl-origin>/mcp --read-smoke` (may write **metadata-only** audit entries). |
| `-WhatIf` | Validate `dist/` + paths and print the plan only — no build, API, TCP, mkdir, move, or env mutation. Does not print credentials. |
| `-ApiBaseUrl` | Default `http://127.0.0.1:6806`. **Strict origin only** (no userinfo/query/fragment; path empty or `/`). Loopback only (`localhost` / `127.0.0.0/8` / `::1`). |

**Safety / recovery**

- Requires a complete `dist/` (`index.js`, `index.css`, `kernel.js`, `plugin.json`, READMEs, icons, `i18n/`, `agent-skill/`); recursively refuses reparse points under `dist/` and staging.
- Stages under `data/plugins/.siyuanmaster-staging-<guid>/`, then **Move-Item** swaps into the install target (never overwrite-copy onto an existing target; never recursive-delete plugin/backup dirs).
- Prior install is moved to `data/plugins/.siyuanmaster-dev-backups/<timestamp-guid>/siyuanmaster` only when its `plugin.json` `name` is exactly `siyuanmaster` (ordinary same-named dirs are refused). No empty backup root on fresh install.
- Token is read from `<Workspace>/conf/conf.json` → `api.token` into the process env only (never printed or written). Restored in `finally`.
- Before disable/swap, default reload path calls `POST /api/system/getWorkspaceInfo {}` on the same origin+token and requires `data.workspaceDir` to match `-Workspace` (Windows: case-insensitive after normalization). Mismatch fails closed with no directory moves.
- Reload uses `POST /api/petal/setPetalEnabled` with `app=siyuanmaster-dev-local-<guid>`. Here `app` is only the SiYuan **excludeApp** value for that call — it is **not** a login or caller identity. Because it does not match a real frontend app id, official `PushReloadPlugin` still broadcasts to real frontends.
- MCP smoke always passes an explicit `--url <ApiBaseUrl-origin>/mcp` (never inherits `SIYUAN_MCP_URL` or a default host from the ambient environment for this loop).
- On failure after swap: best-effort disable new plugin, move failed target to `data/plugins/.siyuanmaster-failed-<guid>`, restore backup when a prior install existed, re-enable previous plugin **only** when identity is certain (`backupRestored`, or never moved/replaced). If quarantine fails and backup is not restored, re-enable is forbidden and recovery is marked incomplete. If there was no prior install, restore is **not** fabricated.
- Does not modify auth config.

- Node `>= 24` (see `package.json` engines)
- Capability source of truth: `catalog/capabilities.json` → `src/generated/capabilities.ts`
- Plugin package output: `dist/` and `package.zip`

```text
Install path:
<workspace>/data/plugins/siyuanmaster
```
