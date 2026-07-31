# Agent Access

A native SiYuan plugin for trusted local agents.

The plugin provides a sidebar, notebook allow/deny policy, per-operation permissions, optional custom/AI tagging rules, audit metadata, and 16 policy-aware tools registered into SiYuan's built-in `/mcp` endpoint. Its text, form controls, and buttons follow SiYuan's editor font-size setting, with a readable floor for supporting text. It does not start a separate Node or Python service.

The safe default is an empty allowlist, so no note is accessible until the user selects notebooks in the GUI. Tagging never requires or forces a `siyuanMCP` tag; existing tags are preserved and new tags are appended and de-duplicated.

Agents should call `plugin__siyuan_agent_access__get_policy` and `plugin__siyuan_agent_access__list_accessible_notebooks` before using the remaining tools.

`list_document_tree` provides bounded, metadata-only hierarchy browsing inside one accessible notebook. It requires `notebookId`, optionally scopes to `parentDocumentId`, defaults to 3 levels and 200 nodes, and reports whether depth or node limits truncated the result. It never returns document bodies.

## Structural changes

`rename_note` and `move_note` use a two-step, one-time preview token. The first call validates the current document state, access boundaries, subtree size, destination, and name conflicts without mutating data. Execution must repeat the same request with the returned token and, when policy requires it, `confirmed=true`.

Both source and destination notebooks must be allowed. Moving a document into itself or a descendant is rejected. Cross-notebook moves have an independent permission and are denied by default. Every execution is revalidated and verified after the SiYuan API call.

## Security boundary

SiYuan's native `/mcp` endpoint currently requires administrator-level authentication. This plugin can enforce policy inside its own tools, but it cannot prevent a client holding the full SiYuan API token from calling native high-privilege tools.
