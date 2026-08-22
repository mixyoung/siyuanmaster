# SiYuan knowledge compounding execution

This reference defines the executable Raw → existing Wiki discovery → update/create → verify loop, deterministic Wiki templates, operation triggers, and the product capability ladder for SiYuanMaster. The classification Skill remains authoritative for semantic placement and naming.

## Contents

1. Layer mapping and responsibility
2. Deterministic Wiki templates
3. Low-token existing-Wiki discovery
4. Ingest and A/A-raw compilation
5. Query, Promote, and Lint
6. Error Book routing
7. Trigger matrix
8. Plugin capability ladder
9. Quality, safety, and evaluation

## 1. Layer mapping and responsibility

Map the three logical layers to SiYuan without forcing three literal top-level folders:

- **Raw sources**: canonical external references and authorized attachments. Preserve source title, author or organization, publication date, capture date, URL, original path, and hash when available. Captured originals are immutable evidence.
- **Wiki**: canonical content documents that synthesize topics, concepts, entities, comparisons, insights, and source summaries. Wiki pages are editable and evolve with evidence.
- **Schema**: the live SiYuanMaster policy, the applicable classification/naming Skill, this reference, and any explicitly settled notebook-level governance rules. Schema constrains operations; it is not a copy of every source or page.

Responsibility boundary:

- The classification Skill decides canonical home, knowledge role, page type, exclusive/shared source status, and whether compilation is justified.
- The SiYuanMaster Skill decides bounded retrieval, safe mutation sequence, confirmation, readback, and failure handling.
- The plugin enforces policy, exposes deterministic tools, holds operation state, audits mutations, and may maintain manifests, indexes, jobs, and previews.
- The model proposes semantic changes and writes source-grounded content. It must not bypass plugin policy or present probabilistic guesses as deterministic plugin state.

Keep personal memory separate from external knowledge. `save_memory` is for durable user/project context, not a replacement for filing source-grounded subject knowledge.

## 2. Deterministic Wiki templates

Every generated Wiki page uses a fixed template selected by `page_type`. Keep every required heading in its registered order; when a section is genuinely inapplicable, leave an explicit brief note instead of omitting or freely renaming the heading.

When the installed plugin exposes `wikiTemplates`, use `list_wiki_templates` as the versioned runtime contract, call `render_wiki_template` only after the creation gate passes, fill the returned draft, then call `validate_wiki_template` before any real write. These tools are read-only: render returns `previewOnly=true` / `writeExecuted=false`, and validation returns `checkedOnly=true` / `writeExecuted=false`. Real creation or update remains a separate authorized operation followed by readback. When the capability is absent, use the templates below and validate them manually.

Common properties, used only when applicable. The deterministic renderer keeps them in a fenced `yaml` metadata block so they remain ordinary SiYuan document content rather than depending on Markdown front-matter semantics:

```yaml
knowledge_role: synthesis | chapter | governance
page_type: topic | concept | entity | comparison | insight | source_summary
canonical_document:
aliases:
authority_document:
source_container:
source_ids:
status: draft | active | deprecated | archived
evidence_status: supported | mixed | disputed | insufficient
reviewed_at:
```

### Topic page

```markdown
# <stable topic>

## Scope and boundaries
## Executive summary
## Core concepts
## How it works / structure
## Evidence-backed conclusions
## Alternatives or comparisons
## Contradictions and open questions
## Sources
## Revision notes
```

Use for one stable subject that integrates several source types. Do not create it merely because two notes share a keyword.

### Concept page

```markdown
# <concept>

## Definition
## What it is not
## Mechanism or principles
## Related concepts
## Examples and counterexamples
## Evidence and limitations
## Sources
```

Use when the concept has a reusable definition, clear boundary, and meaningful relations. Prefer a section in a topic page for minor terms.

### Entity page

```markdown
# <canonical entity name>

## Identity and aliases
## Current state
## Timeline
## Relationships
## Evidence-backed claims
## Disputes and unknowns
## Sources
```

Use for a person, organization, project, product, standard, place, or other object that will be updated independently over time.

### Comparison page

```markdown
# <comparison question>

## Decision context
## Candidates and scope
## Comparison dimensions
## Comparison matrix
## Analysis by condition
## Conclusion and exceptions
## Evidence freshness and gaps
## Sources
```

Use only when the objects, decision question, and comparison dimensions are stable. Avoid generic feature dumps without a decision context.

### Insight page

```markdown
# <falsifiable insight>

## Claim
## Supporting evidence
## Reasoning chain
## Boundary conditions
## Counterevidence and alternatives
## Confidence and update triggers
## Implications
## Sources
```

Use for a reusable conclusion derived from multiple sources. Keep facts and inference visibly separate.

### Source summary page

```markdown
# <source title>：摘要

## Source metadata
## Central thesis
## Method or evidence base
## Key claims
## Limitations and disputes
## Links to affected Wiki pages
## Raw source
```

This is an editable LLM-created Wiki artifact for one source. It never replaces or mutates the Raw original.

### Generated topic index and health view

An index or health dashboard is a deterministic system view, not a second authority page. It may contain page counts by type, source coverage, stale reviews, disputed claims, orphan pages, broken links, and pending ingest items. Regenerate it from manifests and links; do not hand-maintain duplicate totals.

## 3. Low-token existing-Wiki discovery

Checking for an existing Wiki is a staged hybrid, not a choice between full search and full traversal.

### Stage 0: direct lookup

Use the cheapest known locator first:

1. when `get_policy.capabilities.knowledgeRegistry` is available, call `find_wiki_candidates` with a known `sourceId`, or with the normalized title/alias when the source ID is unknown;
2. a document ID already recorded in the Source Manifest or `authority_document`;
3. an exact `notebookId` + `hPath` resolved read-only with `resolve_document`;
4. an existing A-raw manifest link to its A.

Do not search when an exact current locator is already known. Re-read the target before mutation.

The registry is metadata-only. `find_wiki_candidates` returns registered IDs, titles, paths, aliases, types, roles, source counts, deterministic scores, and match reasons; it does not read or return note bodies. Treat `fallbackRecommended=true` as an explicit transition to Stage 1. When the installed capability set lacks the registry, start directly with the older Stage 1 fallback.

### Stage 1: indexed candidate recall

When the authority target is unknown, use `search_notes` in the narrowest allowed notebook. The current tool searches SiYuan's indexed block data through the kernel, filters allowed notebooks, de-duplicates by document, and returns at most 360 characters of snippet per result. Kernel-side scanning does not itself consume model context; returned results do.

Use at most a small sequence of focused queries by default:

1. normalized proposed topic/entity title;
2. one important alias or distinctive phrase;
3. source identifier such as DOI, canonical URL, or stable project name when checking duplicate ingestion;
4. at most one or two core concepts if the title search is insufficient.

Use a result limit of about 5–10 per query. Do not search every noun, and do not treat the newest match as the authority merely because results are sorted by update time.

### Stage 2: bounded structural fallback

Use `list_document_tree` only when:

- classification has identified a likely branch but title search is ambiguous;
- search returns no useful result despite a known subject area;
- parent/child relationships are required for A/A-raw placement; or
- duplicate titles need path disambiguation.

Inspect only the relevant `parentDocumentId` branch, normally depth 2–3 and tens rather than hundreds of nodes. A whole-notebook traversal is a last-resort audit operation, not an ingest prerequisite. Tree results contain structure rather than bodies but can still consume substantial context when broad.

### Stage 3: selective reading

Rank candidates by title/alias match, knowledge role, scope, source links, and canonical uniqueness. Then:

1. inspect no more than about 3–5 plausible candidates by default;
2. use `read_note_segments` for outline and relevant bounded block windows on long documents;
3. use `read_note` only when the complete bounded body is necessary for a safe merge or update; and
4. follow only links that can materially change the authority decision.

Stop when one authority page clearly covers the intended scope, no candidate does, or competing authorities require a lint/merge proposal. Never create a new page solely because the retrieval budget was exhausted.

### Authority decision

- **One matching authority**: update it and link the new Raw source.
- **One related but narrower/broader page**: add a section or propose a scoped child page only if independent maintenance or reuse warrants it.
- **Competing authority pages**: do not choose or merge silently; record/report a duplicate-authority issue.
- **No authority and creation gate satisfied**: create one canonical page with the selected deterministic template.
- **No authority but weak value/evidence**: leave the source in Raw or temporary intake without creating Wiki fan-out.

The plugin-maintained Source Manifest and Authority Registry now provide the first deterministic locator layer when the installed plugin reports the capability. They contain source hash/state, canonical page ID, aliases, page type, knowledge role, source-container ID, and source-to-page links. They do not yet contain claim/block evidence. Continue keeping human-readable source and authority links in A/A-raw pages; plugin-private registry state must not become the only trace visible to the user.

## 4. Ingest and A/A-raw compilation

### Ingest a source

When the installed plugin exposes `sourceIngestPlan`, call `plan_source_ingest` at decision boundaries: first with `registry_only`; again after focused search/bounded structural fallback using `bounded_search_no_match` only when that work is complete; again after selecting an exact existing authority or settling the creation gate. The plan is a deterministic read-only state machine, not a workflow executor. `readyForWorkflow=true` means the returned sequence is sufficiently specified to begin, while `readyForMutation=false` means every listed mutation still needs its normal policy and user gates.

1. Complete the required policy/notebook calls and select one canonical Raw home under the classification rules.
2. Register or preserve the original before synthesis. Keep source metadata and hash when available; upload a local attachment only when authorized for that exact document and file. Use the runtime-returned asset path and verify bytes or hash. When the installed registry capability is available and metadata mutation is authorized, call `register_knowledge_source` after the exact Raw document exists. Default `sourceId` is `siyuan:<documentId>`; provide SHA-256, canonical URL, state, and operation ID only when grounded.
3. Run the existing-Wiki discovery stages above before creating any Wiki page.
4. Discuss or extract the source's durable claims, evidence, method, limitations, entities, concepts, contradictions, and time sensitivity.
5. Update the smallest set of existing authority pages that gain durable source-backed value. Create a new page only after the creation gate passes. When `wikiTemplates` is available, render the selected deterministic draft, fill it, and validate it before calling a write tool; the render/check calls do not create a note. After the exact Wiki document exists and has been read back, call `register_wiki_authority` when available to record its aliases, page type, knowledge role, source container, and complete source link set. Registration never substitutes for writing the user-visible Sources section.
6. Separate source fact, model inference, and user judgment. Preserve uncertainty and conflicting evidence.
7. Re-read every changed page and manifest. Verify links, asset paths, source traceability, unrelated content, tags, and target location.

### Compile an A/A-raw topic unit

`A` is a role name, never a literal required title.

1. Inventory the bounded candidate scope, existing authority syntheses, title variants, references, permissions, duplicate sources, and original parent-child relationships.
2. Decide whether to update an existing A, create a new A, keep sources separate, or use links only. Do not create A/A-raw for a one-off answer or incoherent source pile.
3. Keep A and `<A actual title>-raw` as siblings. Give A durable synthesis. Give A-raw a source manifest, authority-document link, scope, hash or identifier, ingest state, and original path so neither is an empty visual container.
4. Move only exclusive sources into A-raw. When authorized, preserve a source subtree by moving its highest relevant parent; otherwise reconstruct only the minimum meaningful hierarchy and retain original paths.
5. Leave shared sources and established canonical sources in place. Link them from A and the manifest; never duplicate their bodies.
6. Split a chapter into a child document only when size, independent reuse, or continuing maintenance warrants it.
7. Preview every rename or move and execute only after the active policy and user intent authorize the unchanged preview.
8. Re-read A, A-raw, moved subtree roots, and every changed manifest. Verify hierarchy, links, traceability, tags, and canonical uniqueness.

## 5. Query, Promote, and Lint

### Query

Query is read-only by default. Read authority pages first and browse externally only for current or missing evidence. For multi-hop questions, repeat:

`search → selective read → follow material accessible links → test evidence sufficiency`

Stop when material claims are supported, the next hop is inaccessible or irrelevant, or the bounded retrieval budget is exhausted. Report gaps rather than fabricating closure.

### Promote

Chat answers and external search results remain transient unless the user asks to record, save, ingest, settle, or otherwise write them, or the original task already includes filing the result.

Promote only when all are true:

1. the result is non-duplicate;
2. it is useful beyond the current conversation;
3. material claims have traceable note/source links;
4. fact, inference, and judgment are distinguishable;
5. one canonical target is known; and
6. current write policy and user intent authorize mutation.

Write only the durable conclusion and evidence, not the full chat transcript. If evidence conflicts, preserve the conflict state rather than silently overwriting history.

### Lint

Lint is a bounded, read-only review unless exact fixes receive separate authorization. Check for:

- duplicate or competing authority pages;
- unsourced claims, missing evidence, and broken source links;
- stale time-sensitive claims and unmarked projections;
- contradictions, superseded conclusions, and fact/inference mixing;
- orphan pages, missing cross-links, weak titles, and oversized Raw dumps;
- references to inaccessible notebooks; and
- attachment path, byte-size, or hash mismatches when relevant.

Report proposed fixes with exact document IDs/paths and impact. Do not bulk move, merge, rename, delete, retag, or rewrite during lint.

## 6. Error Book routing

Keep error evidence in the narrowest authorized layer:

- Put source conflicts, evidence gaps, and unresolved claims in the affected A's `争议与待验证` section.
- Leave permission denials, state changes, write failures, and readback mismatches in the plugin audit trail.
- Put durable recurring notebook-level issues under an existing metadata/rules/governance document. If none exists, inspect direct-child naming before proposing `知识治理•knowledge_governance/知识质量错误账本`; create it only with the first real issue and authorized write.
- Never pre-create an Error Book in every notebook and never create a cross-permission global Error Book.
- De-duplicate by affected document and issue type. Record issue id, evidence, state, proposed action, recurrence, and resolution without copying sensitive bodies.
- Promote only recurring sanitized patterns into a Skill, and only when the user explicitly asks to settle the rule.

## 7. Trigger matrix

| Operation | Trigger | Default effect | Mutation gate |
| --- | --- | --- | --- |
| Ingest | explicit import/record request, or an authorized Raw scan finds an unregistered source | preserve source, discover existing Wiki, propose/update knowledge | active write policy and current user intent |
| Query | user asks a question | read authority pages and return cited answer | none unless Promote is requested |
| Lint | explicit request or user-configured scheduled check | report health and exact proposals | fixes require separate authorization |
| Promote | durable non-duplicate answer passes all promotion criteria | update one canonical target | active write policy and current user intent |
| Schema read | every Ingest, Promote, Lint, and structural mutation | load current constraints before acting | read-only |
| Schema evolution | repeated real cases show the rule is insufficient and user asks to settle it | smallest compatible Skill/rule update | explicit user request plus validation |

File watching or `scanRaw` detects candidates only. It must not silently trigger semantic creation, source moves, or Wiki rewrites.

## 8. Plugin capability ladder

Continuous plugin evolution is appropriate, but build deterministic substrate before autonomous behavior.

### Phase 1 — deterministic foundation

1. **Template registry and renderer**: expose stable page types, required headings, schema version, and a preview-only render result. Keep semantic template definitions in the Schema/Skill assets; the plugin renders and validates them deterministically.
2. **Raw manifest and hash inventory**: add source ID/hash, canonical URL, capture metadata, ingest state (`new`, `registered`, `ingested`, `failed`, `stale`), affected page IDs, and last operation ID.
3. **Authority/topic registry and candidate discovery**: index canonical page ID, aliases, page type, knowledge role, source container, and notebook scope. Add a compact `find_wiki_candidates` tool so ingest normally avoids broad search.
4. **One-action promotion preview**: turn a query result into a proposed target, patch, citations, and impact preview; preserve the existing explicit write gate.

This phase addresses deterministic templates, duplicate ingest, low-token discovery, and most of the one-click experience.

Current 0.6.1 source status:

- implemented and repository-tested: Source Manifest, Authority Registry, serialized registry writes, source identity de-duplication, bidirectional source/authority links, access-filtered `knowledge_status`, deterministic `find_wiki_candidates`, a versioned six-type bilingual Wiki template catalog with preview rendering and structural/metadata validation, and a read-only single-source Ingest state machine covering duplicate/review/already-ingested/update/select/fallback/gate/create/keep-Raw outcomes;
- exposed tools: `register_knowledge_source`, `register_wiki_authority`, `knowledge_status`, `find_wiki_candidates`, `list_wiki_templates`, `render_wiki_template`, `validate_wiki_template`, and `plan_source_ingest`;
- not yet implemented: Raw scanner, executable multi-step Ingest job, and Promote preview; and
- proven on a live SiYuan 3.8.1 installation: all 27 Agent capabilities were discovered after safe backup/install/reload, and `get_policy` plus `list_accessible_notebooks` passed read-only smoke; not yet proven in this version: template/Ingest calls, registry persistence across reload, policy denial, or destructive write smoke. Do not infer those unrun gates from repository tests.

### Phase 2 — evidence and health

1. **Bidirectional evidence index**: model `source → claim/block → Wiki page` and reverse lookups. Store stable IDs and evidence state rather than relying only on prose links.
2. **Generated index and health tools**: compute coverage, source count, unreviewed pages, stale claims, orphan pages, broken links, and knowledge gaps without asking the model to reread all bodies.
3. **Contradiction state machine**: states such as `detected`, `triaged`, `supported_both`, `resolved`, and `superseded`, with evidence and resolver metadata.
4. **Controlled entity/concept suggestions**: propose pages only when reuse, source coverage, and independence thresholds pass; never fan out every named entity automatically.

This phase addresses evidence traceability, topic indexes, health dashboards, contradictions, broken links, and orphan checks.

### Phase 3 — safe batch and background jobs

1. **Cascade update plan**: calculate affected manifests, claims, Wiki pages, indexes, and links before any write; show ordered patches and expected states.
2. **Recoverable batch execution**: use idempotent operation IDs, per-document expected state, snapshots, checkpoints, partial-failure reporting, and compensating rollback. Do not promise database-level atomicity unless the SiYuan kernel actually provides it.
3. **Cancellable/resumable jobs**: queue Ingest and Lint work, persist cursor/checkpoint/progress, support cancel, and require a fresh state check before resume.
4. **Opt-in Raw watcher and batch scan**: discover additions and enqueue proposals; no silent semantic writes.

This phase addresses cascade preview, reliable batch ingest, failure recovery, cancellation, resume, and file watching.

### Phase 4 — retrieval at scale

1. **Weighted full-text retrieval**: rank title, aliases, page type, headings, body, tags, freshness, and evidence quality differently.
2. **Optional hybrid retrieval**: combine lexical ranking with local embeddings/vector recall and reranking. Apply notebook permission filters before any candidate content reaches the model.
3. **Evaluation harness**: measure authority-page recall, duplicate-creation rate, citation coverage, token/context use, latency, stale detection, and write/readback failures on a representative corpus.

Do not begin with embeddings merely because they are fashionable. At modest scale, the manifest, authority registry, deterministic index, and weighted lexical search may deliver most of the value with simpler failure modes.

## 9. Quality, safety, and evaluation

- Optimize for durable, auditable usefulness, not note count, link count, or automated write volume.
- Do not claim knowledge compounding is inherently cheaper or faster than RAG. Its distinct benefit is a persistent maintained artifact; verification, maintenance, latency, and error propagation remain real costs.
- Use one writer for every mutation sequence. Background workers may analyze in parallel but must converge to one serialized, state-checked write plan.
- Apply notebook policy before retrieval results are returned, including future full-text, vector, and evidence-index tools.
- Every write requires exact targets, expected state where available, execute-once behavior, and readback. Unknown outcomes stop the workflow.
- Treat automated index/status calculations as deterministic only when derived from registered manifests and stable IDs. Model-produced judgments must remain labeled proposals or evidence assessments.
- Release each phase behind feature flags and corpus-level tests. Measure token savings against the current `search_notes → bounded tree → segmented read` baseline rather than assuming improvement.
