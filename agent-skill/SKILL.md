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

When `get_policy.capabilities.knowledgeRegistry` is available:

- call `knowledge_status` for deterministic Source Manifest and Authority Registry counts;
- call `find_wiki_candidates` before `search_notes`; use `sourceId` for direct source-to-authority lookup when known, otherwise use a focused title/alias query;
- if the candidate tool returns `fallbackRecommended=true`, continue with the bounded `search_notes` → relevant tree branch → selective read fallback;
- use `register_knowledge_source` only when the task authorizes metadata mutation and the exact Raw document is already known; it is governed by the active `update` decision;
- use `register_wiki_authority` only for an existing exact Wiki document after semantic classification has selected its page type and knowledge role; competing authorities are a governance issue, never an automatic merge; and
- remember that these registry tools do not create, edit, move, or summarize note content. They do not replace the normal write, confirmation, tagging, and readback steps.

If `knowledgeRegistry` is absent, treat the installed plugin as an older capability set and follow the search/tree/manifest fallback in the reference. Never infer that source or authority registration succeeded merely because a Skill describes the workflow.

When `get_policy.capabilities.wikiTemplates` is available:

- call `list_wiki_templates` before creating a new Wiki page and use the selected page type's purpose and creation gate as a real decision constraint;
- call `render_wiki_template` only after the creation gate passes; treat the returned Markdown as a deterministic draft with `writeExecuted=false`, not as an existing SiYuan document;
- preserve the rendered H1 and ordered required H2 structure while adding source-grounded content; distinguish fact, inference, judgment, uncertainty, and contradiction inside the sections;
- call `validate_wiki_template` on the completed draft with `requireMetadata=true`; resolve every error before proposing a write, and review warnings instead of deleting useful user-authored sections automatically;
- use `create_note` or `update_note` only as a separate step under the active access, confirmation, tagging, expected-state, and readback rules; then re-read the real note and, when authorized, register the exact authority document; and
- never claim that list/render/validate created, updated, registered, or verified a real note. These three tools are read-only catalog/preview/check operations.

If `wikiTemplates` is absent, use the templates in the reference directly and validate their structure manually. Do not call or invent unavailable template tools.

When `get_policy.capabilities.pdfConversionValidation` is available and the user asks to convert a local PDF:

- prefer Marker for complex/scanned PDFs that need rich layout recovery, or PyMuPDF4LLM for local digital PDFs; Pandoc is not a PDF-to-Markdown reader;
- first probe whether the selected external converter is available. If it is absent, tell the user which converter is recommended and request explicit permission to install it; never silently install a dependency, runtime, or model;
- when the user declines installation or the converter cannot run, use the bundled deterministic fallback. A multimodal model may be proposed for visual repair of a scan or complex layout, but it is never presumed exact and must be checked against the PDF text, annotations, and rich-feature acceptance criteria before any write;
- run the external converter outside the plugin and call `validate_pdf_conversion` before any note write with the converter identity and grounded rich-feature minimums;
- treat validation as metadata-only proof, never as conversion, upload, source registration, or write authorization; and
- do not ask the plugin to install dependencies, download models, or execute an arbitrary local command.

If `pdfConversionValidation` is absent, follow the same external-converter-first process and inspect rich features manually.

When `get_policy.capabilities.sourceIngestPlan` is available, use `plan_source_ingest` to keep one-source Ingest decisions explicit:

- start with the exact immutable Raw `sourceDocumentId`, stable source identity when grounded, and the intended allowed Wiki notebook;
- leave `discoveryState="registry_only"` until focused `search_notes` and any necessary bounded `list_document_tree`/selective reads have actually found no authority; a registry miss alone never proves absence;
- pass `selectedAuthorityDocumentId` only after semantic review selects that exact existing page; candidate ranking never selects or merges for you;
- pass `creationGateDecision="passed"` only when the classification layer has decided the source warrants an independently maintained Wiki page, and pass `failed` to keep it in Raw without fan-out;
- treat `readyForWorkflow=true` as permission to begin the returned sequence, never as write authorization. `readyForMutation` remains false, planned mutation entries still require their normal policy, confirmation, tagging, state, and readback gates; and
- inspect the structured `impact` summary for existing Wiki document IDs, proposed creation, Raw registration, and planned mutation count; it is an impact preview, not proof that any operation ran; and
- treat every result as a read-only preview (`previewOnly=true`, `writeExecuted=false`). Re-plan after discovery, selection, source identity, policy, or document state changes.

If `sourceIngestPlan` is absent, follow the reference's staged discovery and Ingest sequence manually. Never claim an Ingest plan was generated or executed by an older plugin.

## Source links and webpage titles

When writing external sources into SiYuan notes, Raw manifests, source
containers, or Wiki `Sources` sections:

- render each HTTP(S) source as a clickable Markdown link whose visible text is
  the freshly verified official webpage title, for example
  `[生成式人工智能服务管理暂行办法](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)`;
- do not leave a bare, non-clickable URL when the page title is available, and
  never guess a title from the URL slug or surrounding discussion;
- when the title cannot be read or verified, use the URL itself as the temporary
  clickable link text and mark the title as pending verification;
- keep the canonical URL in source metadata when the document schema calls for
  it; a rendered link does not replace provenance metadata;
- use SiYuan block references for internal documents instead of treating their
  IDs or paths as external URLs; and
- re-read the written note to verify both the displayed title and the actual
  link target.

## Local PDF to Markdown fidelity

When converting a local PDF into a Markdown note without summarization:

- use a mature layout-aware converter for page order, headings, code, tables, bold spans, and link annotations; `scripts/pdf_to_markdown.py --engine pymupdf4llm` is a thin adapter for an already installed PyMuPDF4LLM environment and restores only verified PDF annotations, while its `fallback` engine remains a fallback/postprocessor; never vendor or auto-install a converter or model inside the Skill;
- never put tool warnings, transport messages, or HTML comments (including provenance and page markers) in the note body; retain source path/hash only through separately authorized metadata or manifest storage;
- reflow visual line wraps only inside the same paragraph, repair cross-line words and URLs, and preserve the source's actual headings and statements;
- fence commands as code, reconstruct detected tables as Markdown tables instead of flattened prose, and never let code comments become document headings; and
- preserve PDF bold spans and valid link annotations when the extractor exposes them. Do not infer links from nearby text; reject pseudo-links generated for file names and render those file names as inline code; and
- for Chinese technical prose, preserve Chinese full-width punctuation; use one space between Chinese and English, Arabic numerals, or inline code, but never before Chinese punctuation. Keep official product spelling; use inline code only for exact commands, identifiers, paths, options, and file names; and
- make each source citation one list item. Apply a descriptive clickable title only after the target page title has been verified; and
- before writing, check for visible comments, truncation text, unfenced commands, and flattened tables; after writing, re-read the first and final source page plus every code/table region.

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
