# SiYuanMaster（思源大师）

A native SiYuan plugin for trusted local agents. **Brand slug:** `siyuanmaster`. **Technical plugin ID (transition):** `siyuan-agent-access`.

The plugin provides a sidebar, notebook allow/deny policy, per-operation permissions, Safe Write Transaction paths for updates and block edits, optional custom/AI tagging rules, audit metadata, and **19** policy-aware tools registered into SiYuan's built-in `/mcp` endpoint. UI text and controls follow SiYuan's editor font-size setting. It does not start a separate Node or Python service.

## Identity policy

| Surface | Value | Why |
|---|---|---|
| Display name | SiYuanMaster / 思源大师 | Brand |
| npm / package name | `siyuanmaster` | Brand slug |
| `plugin.json` `name` | `siyuan-agent-access` | Keeps install path, petal storage, and the original 16 fully-qualified tool names |
| MCP namespace | `plugin__siyuan_agent_access__*` | Derived by the SiYuan kernel from the technical plugin name; a single plugin cannot register two native namespaces |
| Dock type key | `siyuan-agent-access-dock` | Avoid resetting user dock layouts |
| Once-tag attribute | `custom-agent-access-tagged` | Avoid re-tagging after upgrade |
| Version | `0.4.0` | Unified across package, plugin, catalog, Rust workspace |

Switching the technical ID to `siyuanmaster` later requires a dual-plugin or migration bridge. This release does **not** auto-migrate petal storage and does **not** claim dual namespaces.

Install path remains:

```text
<workspace>/data/plugins/siyuan-agent-access
```

## Defaults

Empty allowlist (nothing accessible until notebooks are selected). Tagging never forces a fixed source tag; existing tags are preserved and new tags are appended and de-duplicated via `mergeTags`.

Agents should call `plugin__siyuan_agent_access__get_policy` and `plugin__siyuan_agent_access__list_accessible_notebooks` before other tools.

## Tools (19 = original 16 + 3)

Original 16 (names unchanged under `plugin__siyuan_agent_access__*`):

`get_policy`, `list_accessible_notebooks`, `list_document_tree`, `search_notes`, `read_note`, `create_note`, `append_note`, `update_note`, `rename_note`, `move_note`, `delete_note`, `suggest_tags`, `apply_tags`, `prepare_summary`, `save_memory`, `get_audit_log`

P1 additions:

- `resolve_document` — read-only human-path lookup
- `read_note_segments` — outline + full-block windows with hard limits
- `edit_block` — exact block ID, expected content/hash, reference impact, Safe Write Transaction

`list_document_tree` provides bounded, metadata-only hierarchy browsing. It never returns document bodies.

## Structural changes

`rename_note` and `move_note` use a two-step, one-time preview token. Execution revalidates and verifies after the SiYuan Kernel API call. Cross-notebook moves are denied by default.

## Safe writes

`update_note` and `edit_block` run through Safe Write Transaction: pre-write snapshot (failure stops), confirmation when required, pre-execute state recheck, single execute, readback verification, audit without body. Result `unknown` is never auto-retried. Writes use SiYuan Kernel APIs only — never direct `.sy` file I/O.

## Security boundary

SiYuan's native `/mcp` endpoint currently requires administrator-level authentication. This plugin can enforce policy inside its own tools, but it cannot prevent a client holding the full SiYuan API token from calling native high-privilege tools.

Optional local Rust components (`siyuanmasterd` gateway, `siyuanmaster` CLI, `siyuanmaster-core`) provide scoped tokens and catalog/txn helpers. Gateway → kernel outbound proxy is not production-verified in this release.

## Build

```bash
pnpm build          # generate catalog, freshness check, typecheck, vitest, package.zip
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

Capability catalog: `catalog/capabilities.json` (single source of truth). Build fails if `src/generated/capabilities.ts` is stale.
