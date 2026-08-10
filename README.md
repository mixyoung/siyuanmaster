# SiYuanMaster

SiYuanMaster is a native SiYuan plugin that lets trusted local AI assistants read, write, and manage SiYuan notes safely and under user control.

| | |
|---|---|
| **Brand** | SiYuanMaster / 思源大师 |
| **Package** | `siyuanmaster` |
| **Version** | `0.5.0` |
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
| `read_note_segments` | Outline + hard-capped full-block windows for long notes |
| `edit_block` | Exact block ID, expected content/hash, reference impact, Safe Write Transaction |

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

## Current limitations

- **Permissions:** Effective model is notebook decision inherited by descendants. Document-level read/write/hidden overrides are **not** wired into the plugin.
- **Write confirm retry:** For `update_note` / `edit_block`, a confirmation retry starts a **new** transaction and snapshot. There is no persistent cross-call preview token and no user-visible full diff.
- **Gateway / E2E:** Gateway outbound proxy toward the SiYuan kernel and full end-to-end SiYuan runtime behavior are **not** production-verified in this release.
- **Scope:** This is not a claim of complete SiYuan feature coverage (no attribute-view database tooling, flashcards, timeline, Docker/remote deployment, multi-block table editors, asset upload, and similar backlog items).

## Development and build

```bash
pnpm build          # generate catalog, freshness check, typecheck, vitest, package
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

- Node `>= 24` (see `package.json` engines)
- Capability source of truth: `catalog/capabilities.json` → `src/generated/capabilities.ts`
- Plugin package output: `dist/` and `package.zip`

```text
Install path:
<workspace>/data/plugins/siyuanmaster
```
