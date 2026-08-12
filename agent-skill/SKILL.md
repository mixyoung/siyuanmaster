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

Use this workflow when the user wants to ingest sources, build or evolve a topic knowledge base, file a useful answer back into SiYuan, or inspect knowledge-base quality. It adapts the LLM Wiki pattern to SiYuan without granting background autonomy.

### Map the layers to SiYuan

- **Source layer**: canonical external references and authorized attachments. Preserve source title, author or organization, publication date, capture date, URL, and attachment path/hash when available. Treat captured originals as immutable evidence.
- **Knowledge layer**: canonical content documents that synthesize facts, concepts, comparisons, contradictions, and conclusions. Update these documents as evidence evolves; do not duplicate one authority page across notebooks.
- **Governance layer**: the live SiYuanMaster policy, the applicable classification/naming Skill, and this workflow. Do not create a universal literal `raw/wiki/schema` tree. Create a topic-local `A-raw` only when the settled classification rules and real sources justify that compilation unit.

Keep personal memory separate from external knowledge: `save_memory` is for durable user/project context, not a substitute for filing source-grounded subject knowledge.

### Ingest a source

1. Complete the required policy/notebook calls and select one canonical home under the applicable classification rules.
2. Search the target scope for the source, title variants, and the main concepts before creating anything. Prefer updating or linking an existing authority document over creating a duplicate.
3. Preserve the source before synthesis: keep the original URL and metadata; upload a local attachment only when the user authorized that exact document and file. Use the runtime-returned asset path and verify bytes or hash.
4. Separate source facts, model inference, and user judgment. Label uncertainty, publication status, time-sensitive claims, and contradictions instead of blending them into one voice.
5. Write the smallest useful synthesis. Do not fan one source out across many documents merely because the model can; touch additional authority pages only when each change adds durable, source-backed value.
6. Re-read every changed document and verify source links, attachment paths, unrelated content, tags, and target location.

### Compile an A/A-raw topic unit

Use `A` as a role name for the authority synthesis, not as its literal title. Use the applicable classification Skill to decide the roles and destination; this Skill owns the safe execution sequence.

1. Inventory the bounded candidate scope, existing authority syntheses, title variants, references, permissions, duplicate sources, and original parent-child relationships.
2. Decide whether to update an existing A, create a new A, keep the sources separate, or use links only. Do not create A/A-raw for a one-off answer or an incoherent source pile.
3. Keep A and `A-raw` as sibling documents. Name the source container `<A's actual title>-raw`. Give A durable synthesized content; give A-raw a source manifest, its authority-document link, scope, and ingestion state so neither is an empty visual container.
4. Move only exclusive sources into A-raw. Preserve an existing source subtree by moving its highest relevant parent when authorized; otherwise retain the original path as metadata and reconstruct only the minimum meaningful relative hierarchy.
5. Leave shared sources and sources with an established canonical home in place. Link them from A and the A-raw manifest; never duplicate their bodies across compilation units.
6. Keep captured originals immutable. In A, distinguish source fact, model inference, user judgment, contradiction, uncertainty, and time-sensitive state. Split a chapter into a child document only when size, independent reuse, or continuing maintenance warrants it.
7. Preview every rename or move. Show the source, destination, subtree, references, conflicts, and original path; execute only after the active policy and user intent authorize the unchanged preview.
8. Re-read A, A-raw, every moved subtree root, and every changed source manifest. Verify hierarchy, links, source traceability, unrelated content, tags, and canonical uniqueness.

### Query and promote

- Querying is read-only by default. Read the existing authority documents first; browse externally only when the task calls for current or missing evidence. For multi-hop questions, repeat `search → read → follow relevant accessible links → test evidence sufficiency`; stop when the material claims are supported, the next hop is inaccessible or irrelevant, or the bounded retrieval budget is exhausted. Report unresolved gaps instead of fabricating closure.
- Treat chat answers and external search results as transient until the user asks to record, save, ingest, settle, or otherwise write them, or the original task explicitly includes filing the result.
- Before promotion, require all of the following:
  1. the result adds non-duplicate knowledge;
  2. it is likely to be useful beyond the current conversation;
  3. material claims have traceable note/source links;
  4. fact, inference, and judgment are distinguishable;
  5. one canonical target document is known; and
  6. the active write policy and user intent authorize the mutation.
- File only the durable conclusion and its evidence, not the whole chat transcript. Link back to supporting source documents or attachments.
- If a new source contradicts an existing claim, preserve the conflict and evidence state. Do not silently overwrite history or declare the newer claim true solely because it is newer.

### Lint the knowledge base

Run lint as a bounded, read-only review unless the user separately authorizes fixes. Check for:

- duplicate or competing authority documents;
- unsourced claims, broken source links, or missing attachment evidence;
- stale time-sensitive claims and unmarked projections;
- contradictions, superseded conclusions, and fact/inference mixing;
- orphan documents, weak titles, missing cross-links, and oversized raw dumps;
- references to inaccessible notebooks; and
- asset-path, byte-size, or hash mismatches when attachments matter.

Report proposed fixes with exact document IDs/paths and impact. Do not bulk move, merge, rename, delete, retag, or rewrite during lint.

### Record and promote errors

Keep error evidence in the narrowest authorized layer:

- Record source conflicts, evidence gaps, and unresolved claims in the affected A's `争议与待验证` section.
- Leave permission denials, state changes, write failures, and readback mismatches in the plugin audit trail; do not present them as knowledge errors.
- Record a durable, recurring notebook-level issue under that notebook's existing metadata, rules, or knowledge-governance document when one exists. Otherwise inspect direct-child names and numbering before creating a non-conflicting `知识治理•knowledge_governance/知识质量错误账本`. Create it only when the first tracked issue and current task authorize the write. Never pre-create it in every notebook and never create a cross-permission global Error Book.
- De-duplicate notebook-level issues by affected document and issue type. Record issue id, evidence, state, proposed action, recurrence, and resolution; do not copy sensitive bodies into the ledger.
- Treat the ledger as evidence and proposals, never as an automatic repair queue. Lint remains read-only until the user separately authorizes exact fixes.
- Promote a pattern to the applicable classification or SiYuanMaster Skill only after it recurs across topics or notebooks and the user explicitly asks to settle or update the rule. Share only sanitized patterns across access boundaries.

### Quality and economics

- Optimize for durable, auditable usefulness rather than the number of notes, links, or automated writes.
- Do not claim that compounding knowledge is inherently cheaper or faster than RAG. Its distinct benefit is the persistent artifact; maintenance, verification, latency, and error-propagation costs remain real.
- Use a single writer for each mutation sequence and keep the existing snapshot, state-recheck, execute-once, and readback gates. Knowledge compounding never overrides access policy, confirmation requirements, tagging policy, or uncertain-outcome handling.

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
