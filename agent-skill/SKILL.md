---
name: siyuan-agent-access
description: Use a user's SiYuan notes through the policy-aware Agent Access plugin tools for scoped search, reading, writing, safe two-stage rename and move, summarization, optional tagging, memory persistence, and metadata-only audit review.
---

# SiYuan Agent Access

Use only `plugin__siyuan_agent_access__*` tools when the user expects notebook access controls to apply.

## Required start

1. Call `plugin__siyuan_agent_access__get_policy`.
2. Call `plugin__siyuan_agent_access__list_accessible_notebooks`.
3. Treat every unlisted notebook as inaccessible.

The native SiYuan MCP server may expose other administrator-level tools. Their presence does not mean they satisfy the user's notebook policy.

## Retrieval

1. Use `search_notes` with a focused query.
2. Read only the most relevant results with `read_note`.
3. Respect `truncated=true`; ask for another bounded read only when required.
4. Do not infer the existence or name of inaccessible notebooks from errors.

## Writes

- Use `create_note`, `append_note`, or `update_note`.
- If the active operation decision is `confirm`, ask the user immediately before the write, then retry with `confirmed=true`.
- `delete_note` always requires user confirmation and an exact `expectedTitle`.
- Never set `confirmed=true` without actual user approval.

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
- Apply tags only through `apply_tags` or the `tagging` field of a write tool.
- Existing tags are preserved by the plugin.

## Summary and memory

- Use `prepare_summary` to obtain bounded content and summary guidance.
- Present a summary before persisting it unless the user already requested persistence.
- Use `save_memory` only for durable facts, decisions, preferences, reusable procedures, or important unresolved questions.
- Avoid saving transient chat, speculative conclusions, secrets, or duplicated material.

## Audit review

- Use `get_audit_log` only when the user asks to inspect recent plugin activity, outcomes, or policy enforcement.
- Request the smallest useful `limit`; the accepted range is 1-200 and the default is 50.
- Treat audit entries as metadata, not note content. They record outcomes, lengths, and tag counts but never document bodies.
- Do not infer inaccessible notebook names or note contents from audit metadata.

## Error handling

- `confirmation_required`: ask the user, then retry if approved.
- `tag_decision_required`: present tag candidates and ask whether to add or skip.
- `notebook_denied`: stop; do not attempt native MCP tools as a workaround.
- `operation_denied`: explain that the current GUI policy blocks the operation.
- `preview_expired`: request a new preview and do not reuse the old token.
- `state_changed`: show that the source or destination changed, then preview again.
- `name_conflict`: stop and ask the user to choose another title or destination.
