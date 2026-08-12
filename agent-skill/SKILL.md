---
name: siyuanmaster
description: Use a user's SiYuan notes through the SiYuanMaster (technical id siyuanmaster) policy-aware plugin tools for bounded document-tree browsing, path lookup, segmented long reads, scoped search, reading, writing, safe block edit, safe two-stage rename and move, source-grounded knowledge ingest and compounding with A/A-raw topic units, query promotion, layered Error Book recording and linting, summarization, optional tagging, memory persistence, metadata-only audit review, and user-authorized offline webpage archiving with native attachment upload and sandboxed local preview.
---

# SiYuanMaster (technical id: siyuanmaster)

Use only `plugin__siyuanmaster__*` tools when the user expects notebook access controls to apply. Brand name is SiYuanMaster / 思源大师; MCP namespace is plugin__siyuanmaster__* (technical id siyuanmaster).

## Required start

1. Call `plugin__siyuanmaster__get_policy`.
2. Call `plugin__siyuanmaster__list_accessible_notebooks`.
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

## Controlled knowledge compounding

For source ingest, A/A-raw compilation, Wiki page selection, query promotion, knowledge lint, Error Book handling, or planning the compounding product, read [references/knowledge-compounding.md](references/knowledge-compounding.md) completely before acting.

The classification Skill remains authoritative for semantic placement, knowledge role, page type, and taxonomy. This Skill is authoritative for bounded discovery, safe execution, source preservation, write confirmation, state checks, readback, and plugin capability boundaries.

Core invariants:

- do not create a universal literal `Raw/Wiki/Schema` directory tree;
- check for an existing Wiki authority before creating one, using indexed search before broad traversal;
- keep captured originals immutable and distinguish facts, inference, judgment, uncertainty, and contradiction;
- keep Query and Lint read-only unless the user separately authorizes promotion or fixes;
- use one writer and preserve snapshot, state-recheck, execute-once, and readback gates; and
- never let knowledge compounding override access policy, confirmation requirements, tagging policy, or uncertain-outcome handling.

## Offline webpage archive

Use this workflow when the user wants a webpage to remain visually available after the source link changes or disappears.

1. Resolve and freshly read the exact target document through the policy-aware plugin tools. Treat browser capture and native SiYuan asset upload as separate actions. Use the administrator-level native upload interface only after the user authorizes it for the exact document and file; never broaden that authorization to native note, tree, or arbitrary file writes.
2. Capture with SingleFile or another true single-file archiver only after the page has settled. Scroll through the complete page to trigger lazy images and scroll-entry content before capture. Prefer an ephemeral invocation over a global install unless the user requests installation.
3. Record the source URL, page title, capture time and timezone, viewport, byte size, and SHA-256. A successful capture command is not acceptance evidence.
4. Inspect the saved HTML for active external resource dependencies. Images, fonts, styles, and CSS backgrounds needed for the visual snapshot should be embedded. Ordinary outbound hyperlinks may remain, but loading the archive must not require the source site.
5. When the goal is a static visual record, remove scripts and inline event handlers and reveal elements left at animation-entry states such as `opacity: 0` or translated/scaled transforms. If interactive fidelity matters, keep the raw capture download-only and create a separate sanitized preview copy; state clearly that offline network features will not work.
6. Upload the canonical downloadable copy with the current runtime's native attachment tool or `/api/asset/upload` multipart interface. Keep the token secret, scope the request to the resolved document, and use the exact path returned by `succMap`; never predict SiYuan's timestamped filename. Verify the uploaded bytes or SHA-256 against the local file.
7. Probe the installed SiYuan runtime before embedding HTML. `/assets/*.html` response and download behavior is version-dependent. If the asset downloads or fails inside an iframe, keep it as the download link. Only with explicit inline-preview authorization, and only when the current runtime accepts it, upload a sanitized mirror to a controlled local web path such as `/widgets/<stable-slug>/`. Give the mirror a distinct upload filename to avoid hash/name deduplication, and use the returned path.
8. Embed an external-page archive with a restrictive iframe such as `<iframe src="/widgets/..." sandbox=""></iframe>`. Never grant `allow-scripts` or `allow-same-origin` to archived external HTML. Preserve a normal `assets/...` link so the user can download or open the canonical file separately.
9. Validate the served preview in a browser: HTTP 200, correct title, all intended sections/images/cards visible after a full-page scroll, no animation-hidden content, and no unapproved network requests. Save a full-page screenshot when visual evidence matters.
10. Freshly read the note, add or replace only the intended archive references, then write with `update_note` under the active tagging policy. If the tool reports a readback mismatch or ambiguous outcome, do not retry; read the note again and verify the returned paths, old-reference absence, unrelated content, live preview/PDF preservation, and existing tags.

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

Native `/mcp` is administrator-authenticated. Prefer the plugin tools above when the user asked for access control. Do not claim dual MCP namespaces. Storage from siyuan-agent-access is auto-copied into siyuanmaster on first load when the new side is missing; the old petal directory is retained. External configs must use plugin__siyuanmaster__* tool names.
