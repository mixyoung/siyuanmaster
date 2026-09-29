# Local PDF to Markdown fidelity

Use this workflow when converting a local PDF into a Markdown note without summarizing or rewriting its claims.

## Converter decision

- Classify the source first. Prefer Marker for scanned or layout-heavy PDFs and PyMuPDF4LLM for local digital PDFs. Pandoc is not a PDF-to-Markdown reader.
- Probe the selected converter before use. Never silently install a dependency, runtime, browser, converter, model, or language pack.
- If the preferred converter is absent but the bundled deterministic fallback plus visual repair can meet the requested fidelity, disclose the fallback and continue. Ask permission to install only when the missing converter is actually required to reach the requested result; do not pause a recoverable conversion merely to offer an installation.
- `scripts/pdf_to_markdown.py --engine pymupdf4llm` is a thin adapter for an already installed environment. Its `fallback` engine is a deterministic draft generator and postprocessor, not self-sufficient acceptance proof.
- Run converters outside the plugin. When the freshly discovered controlled tool list exposes `validate_pdf_conversion`, call it before any note write with the real converter identity and grounded minimums. Do not rely only on a capability flag, and never invent or call an unavailable tool.
- Treat validation as metadata-only evidence. It never converts, installs, uploads, registers a source, authorizes a write, or proves visual fidelity.

## Evidence model

Use four evidence streams together:

1. Text and content-stream order for words, commands, references, and cross-page continuation.
2. Geometry and vector drawings for headings, paragraph gaps, list markers, indentation, columns, code regions, and table rectangles.
3. Typography for font size, weight, inline code, labels, and heading hierarchy.
4. PDF annotations for real link targets.

Treat extracted Markdown as a draft. PDF text lines are visual wrapping units, not semantic paragraphs, and their text layer or bounding boxes can occasionally disagree with the rendered glyphs or order. Resolve the difference from the rendered page; do not silently spell-correct without page evidence.

## Line-break mode

- Select the line-break mode from the user's requested outcome before conversion.
- Use **source-semantic reflow mode** by default, and whenever the user asks for semantic paragraph reflow. Join page-width wraps inside the same original block, but preserve paragraph, heading, list-item, code, table, label, and reference boundaries proven by the source's structure. Derive those boundaries from source evidence such as block spacing, indentation, markers, typography, table rectangles, or source HTML/DOM when available; do not split paragraphs from the model's interpretation of sentence meaning.
- Use **source-line preservation mode** only when the user explicitly asks to preserve every displayed line or soft wrap as layout data. Keep each visible PDF line as a Markdown hard break inside its semantic block (`two spaces + newline`), while using a blank line only for a real paragraph or block boundary. For list continuations, keep the hard break inside the same item with continuation indentation.
- Requests to follow the original, compare page by page, or preserve the original semantics do not by themselves select source-line preservation. Page-by-page comparison is an acceptance method, not a line-break mode.
- Never split Markdown strong spans, inline code, or link syntax to reproduce a visual wrap. Move that break to the nearest safe token boundary and verify the rendered result.
- The user's explicit and unambiguous line-break preference overrides the default mode. When it is not explicit, use source-semantic reflow.

## Semantic blocks and line breaks

- In source-semantic reflow mode, join adjacent visual lines only when they belong to the same original semantic block: compatible indentation, small vertical gap, unchanged typography, no intervening marker or table boundary, and source evidence of continuation. In source-line preservation mode, retain those same-block visual lines as hard breaks instead.
- Start a new Markdown block only when the source structure proves a boundary: a heading or font-size shift, a material vertical gap, a vector bullet, a numbered marker, a code region, a table rectangle, a separately positioned label, a confidence/evidence block, or a new reference item.
- Words such as `核心特性：` or another list-introducing phrase are not boundary evidence by themselves. Keep the phrase in the preceding paragraph when the PDF text block, spacing, and typography keep it there; never split it merely because the model considers it a useful label.
- Detect bullets from visible evidence, not text alone. Some PDFs draw bullets as small filled circles that never appear in extracted text. Map each marker to the horizontally aligned first line, join only its wrapped continuation lines, and emit exactly one `- ` item per marker.
- Keep numbered list items separate in the same way. Do not interpret numbered headings such as `3.2` as list items.
- A label such as `核心特性：` that governs the following list may become its own paragraph even when the PDF places it at the end of the preceding sentence. Preserve the wording and order.
- A page break is not a semantic boundary. Join an incomplete word, URL, reference, code block, or continuing paragraph across pages. Split after a completed sentence only when additional source evidence supports a new block, such as remaining usable space on the previous page, changed indentation/typography, or source HTML/DOM boundaries.
- For code, compare content-stream order with the rendered page. If coordinates and the screenshot disagree, the rendered order is authoritative. Fence commands, keep comments inside the fence, and never turn code comments into headings.
- Reconstruct detected tables as Markdown tables. Use the table rectangle and row/column geometry rather than the global text order; never flatten a table into prose.

## Bold, inline code, and links

- Preserve bold using font flags and names such as Bold, Semibold, Black, and Heavy. Map every normalized bold PDF span, page by page, to a Markdown strong span, heading, or table-header cell. A total count match is not sufficient.
- Keep punctuation inside the strong span when it is semantically part of an emphasized label and doing so prevents SiYuan from rendering a visible gap before the punctuation; confirm this from the rendered source and rendered note.
- Preserve Chinese full-width punctuation. Use one space between Chinese and English, Arabic numerals, or inline code, but never before Chinese punctuation. Keep official product spelling.
- Use inline code only for exact commands, identifiers, paths, options, and file names.
- Compound and symbol-led event tokens (`worker_done`, `merge_ready`, `@all`, `@builders`, `localhost:3000`) always render as inline code. Everyday-English event words (`dispatch`, `escalation`, `websearch`, `clink`) render as inline code only when their line already contains one of those unambiguous tokens; standing alone in prose they keep normal text styling.
- Preserve only verified HTTP(S) annotation targets. Reject pseudo-links generated for file names such as `AGENTS.md`; render those names as inline code. Do not infer links from nearby prose.
- Make each source citation one list item. Keep the visible URL clickable when the official page title has not been freshly verified; use a descriptive title only after verification.

## Acceptance before writing

- Never place converter warnings, transport messages, provenance comments, page markers, or hidden tool output in the note body. Store a source path or hash only through separately authorized metadata or a manifest.
- Treat counts for tables, code fences, bold spans, links, and list items as a screen, not acceptance.
- Render the source PDF and the Markdown. Compare at least the opening page, one code/table page, one dense list or multi-column page, and the first and final reference pages.
- Check specifically for flattened lists, run-on labels, reordered commands, flattened tables, cross-page word or URL breaks, unmatched bold spans, pseudo-links, missing annotations, truncation text, and visible comments.
- In source-line preservation mode, count and map visible source-line boundaries, then verify the actual SiYuan rendering rather than accepting raw Markdown that merely contains newline characters.
- In source-semantic reflow mode, compare the final Markdown block boundaries against a source-derived block ledger. Also verify the live SiYuan view at the opening, a dense list/table region, the first references, and the final references.
- Resolve every ambiguous block boundary from page evidence before writing. A few plausible-looking missing line breaks still fail fidelity acceptance.

## Write and canonical readback

- Write only through the normal policy-aware `update_note` flow with the active tagging decision.
- If execution reports a readback mismatch, do not retry. Freshly read the note and compare canonical meaning.
- SiYuan may serialize equivalent Markdown differently by tightening table pipes, changing separator widths, inserting zero-width separators around inline code, or normalizing equivalent whitespace. Ignore only those proven serialization differences.
- Accept the result only when canonicalized text, headings, paragraph/list/table/code structure, link targets, tags, and rendered meaning match the intended Markdown. Otherwise stop and report the exact mismatch.
- After writing, re-read the first and final source sections plus every list, code, table, and reference region that required repair.
