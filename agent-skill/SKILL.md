---
name: siyuanmaster
description: Use a user's SiYuan notes through the SiYuanMaster (technical id siyuan-agent-access) policy-aware plugin tools for bounded document-tree browsing, path lookup, segmented long reads, scoped search, reading, writing, safe block edit, safe two-stage rename and move, summarization, optional tagging, memory persistence, and metadata-only audit review.
---

# SiYuanMaster (technical id: siyuan-agent-access)

Use only `plugin__siyuan_agent_access__*` tools when the user expects notebook access controls to apply. Brand name is SiYuanMaster / 思源大师; the MCP namespace stays under the technical id for the transition period.

## Required start

1. Call `plugin__siyuan_agent_access__get_policy`.
2. Call `plugin__siyuan_agent_access__list_accessible_notebooks`.
3. Treat every unlisted notebook as inaccessible.

The native SiYuan MCP server may expose other administrator-level tools. Their presence does not mean they satisfy the user's notebook policy.

## Retrieval

1. Use `list_document_tree` when the user needs notebook hierarchy or must choose a document by location.
2. Start with bounded defaults. If the tree is truncated, use `parentDocumentId` to inspect only the relevant branch instead of broadly increasing limits.
3. Use `resolve_document` only as a **read-only** path lookup (`notebookId` + `hPath`). Never write by human path.
4. Use `search_notes` with a focused query when the user is looking for content rather than structure.
5. Read with `read_note` for full bounded Markdown, or `read_note_segments` for outline + hard-capped full-block windows on long notes.
6. Respect every `truncated=true` result; request another bounded tree or window only when required.
7. Do not infer the existence or name of inaccessible notebooks from errors.

## Writes

- Use `create_note`, `append_note`, or `update_note`.
- `update_note` runs Safe Write Transaction (snapshot → confirm if required → state recheck → execute once → readback). On `state_changed` or `unknown`, stop and re-preview; never auto-retry uncertain outcomes.
- If the active operation decision is `confirm`, ask the user immediately before the write, then retry with `confirmed=true`.
- `delete_note` always requires user confirmation and an exact `expectedTitle`.
- Never set `confirmed=true` without actual user approval.

## Block edit

- Use `edit_block` with an **exact** SiYuan block ID (never a path).
- Provide `expectedContent` or `expectedHash` matching the current block when policy requires expected state.
- Review reference impact (`referenceRisk`, `referencing`). If protection is `deny` and refs exist, do not force the edit.
- Obtain user confirmation when required (default for block edit), then call again with `confirmed=true`.
- On snapshot failure, state drift, or readback mismatch, stop; do not auto-retry.

## Rename and move

- Use only `rename_note` and `move_note`; never use native file-tree tools.
- First call without `previewToken`. This is a non-mutating preview.
- Show the source, destination, affected subtree count, and conflict result to the user.
- If any returned policy decision is `confirm`, obtain explicit approval for that exact preview.
- Execute with unchanged source/destination arguments and the returned one-time `previewToken`. Add `confirmed=true` only after required approval.
- If the preview expires or the state changes, discard it and request a new preview.
- Both source and destination notebooks must be listed as accessible.
- Never move a document into itself or its descendants.
- Cross-notebook movement is a separate permission and is denied by default.

## Tags

- Tagging is optional. Never add `siyuanMCP` unless the user explicitly chooses it.
- In `ask` mode, every write must specify `tagging.decision="add"` or `"skip"`.
- Generate concise, retrieval-oriented candidate tags from the final content with `suggest_tags`.
- Existing tags are preserved; new tags are appended and de-duplicated (never overwrite).

## Memory and summary

- `prepare_summary` is read-only preparation; write only after clear user intent.
- `save_memory` creates or appends under the memory tagging policy.

## Audit

- `get_audit_log` returns metadata only (no note bodies, no tokens).

## Security boundary

Native `/mcp` is administrator-authenticated. Prefer the plugin tools above when the user asked for access control. Do not claim dual MCP namespaces or that storage was auto-migrated to a new technical id.
