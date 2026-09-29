#!/usr/bin/env python3
"""Convert a text-based PDF into fidelity-first Markdown without summarizing."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

try:
    import pymupdf
except ImportError:  # PyMuPDF still exposes the legacy module in some runtimes.
    import fitz as pymupdf


COMPATIBILITY_GLYPHS = str.maketrans({"⻛": "风", "⻔": "门", "⻓": "长"})
NUMBERED_HEADING = re.compile(r"^\d+\.\d+(?:\.\d+)?\s+")
CHINESE_HEADING = re.compile(r"^[一二三四五六七八九十]+、")
LIST_ITEM = re.compile(r"^\d+\.\s+")
COMMAND = re.compile(
    r"^(?:/[a-z][a-z0-9:_-]*(?:\s|$)|![a-z][a-z0-9_-]*(?:\s|$)|(?:npm|npx)\s)"
)
INLINE_LITERAL = re.compile(
    r"(?<![`A-Za-z0-9_./@-])(?:[A-Z][A-Z0-9_-]{2,}\.md|\.[a-z0-9_-]+/config\.toml|[a-z][a-z0-9_-]*\.toml|(?:session|thread)[Ii]d|/[a-z][a-z0-9_-]*:[a-z-]+(?:\s+--[a-z-]+)?|npm\s+(?:install|i)\s+-g\s+@[a-z0-9_-]+/[a-z0-9_-]+|[a-z][a-z0-9_-]*\s+mcp-server|![a-z][a-z0-9_-]*|[a-z][a-z0-9_]*(?:_code|_completion)|[a-z][a-z0-9_-]*-[0-9]+(?:\.[0-9]+)+|worker_done|merge_ready|@all|@builders|localhost:3000)(?![`A-Za-z0-9_/@-])(?!\.[\w-])"
)
# Common-English event words: wrapped as code only on lines that already
# contain an unambiguous INLINE_LITERAL hit, so plain prose stays untouched.
INLINE_LITERAL_CONTEXT = re.compile(
    r"(?<![`A-Za-z0-9_./@-])(?:dispatch|escalation|websearch|clink)(?![`A-Za-z0-9_/@-])(?!\.[\w-])"
)


@dataclass(frozen=True)
class Line:
    page: int
    order: int
    page_height: float
    x0: float
    x1: float
    y0: float
    y1: float
    size: float
    text: str
    markdown: str
    bullet_start: bool


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text).translate(COMPATIBILITY_GLYPHS)
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"(?<=[A-Za-z])\s+([A-Za-z])(?=\s*(?:\[|[),.;:]))", r"\1", text)


def is_cjk(character: str) -> bool:
    return "\u4e00" <= character <= "\u9fff"


def is_external_link(uri: str | None) -> bool:
    if not uri:
        return False
    parsed = urlparse(uri)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    return not (parsed.scheme == "http" and parsed.hostname and parsed.hostname.endswith(".md"))


def normalize_cjk_compatibility(text: str) -> str:
    """Repair CJK compatibility glyphs without converting full-width punctuation."""
    result: list[str] = []
    for character in text:
        codepoint = ord(character)
        if (
            0x2E80 <= codepoint <= 0x2EFF
            or 0x2F00 <= codepoint <= 0x2FDF
            or 0xF900 <= codepoint <= 0xFAFF
        ):
            result.append(unicodedata.normalize("NFKC", character))
        else:
            result.append(character)
    return "".join(result)


def annotation_urls(pdf_path: Path) -> list[str]:
    document = pymupdf.open(pdf_path)
    urls = {
        link["uri"]
        for page in document
        for link in page.get_links()
        if is_external_link(link.get("uri"))
    }
    document.close()
    return sorted(urls, key=len, reverse=True)


def wrapped_url_pattern(uri: str) -> str:
    """Match a PDF URL even when visual extraction split it across lines."""
    pieces: list[str] = []
    for character in uri:
        if character == "-":
            # PDF text extraction can drop a visual hyphen or duplicate it at
            # a line break, while the annotation retains the canonical URL.
            pieces.append(r"-?\s*(?:-\s*)?")
        else:
            pieces.append(re.escape(character) + r"\s*")
    return "".join(pieces).removesuffix(r"\s*")


def linkify_annotation_urls(markdown: str, urls: list[str]) -> tuple[str, int]:
    """Turn only verified PDF link annotations into Markdown links.

    The layout converter can preserve the printed URL while omitting its PDF
    annotation. Using the annotation list avoids inventing links from prose.
    """
    converted = 0
    pieces = re.split(
        r"(```.*?```|(?<!!)\[[^\]]+\]\([^)]+\))",
        markdown,
        flags=re.DOTALL,
    )
    for index, piece in enumerate(pieces):
        if piece.startswith("```") or re.fullmatch(
            r"(?<!!)\[[^\]]+\]\([^)]+\)", piece
        ):
            continue
        for uri in urls:
            pattern = wrapped_url_pattern(uri)

            def replace(match: re.Match[str], target: str = uri) -> str:
                nonlocal converted
                converted += 1
                return f"[{target}]({target})"

            piece = re.sub(pattern, replace, piece)
        pieces[index] = piece
    return "".join(pieces), converted


def conversion_metrics(markdown: str) -> dict[str, int | bool]:
    links = re.findall(r"(?<!!)\[[^\]]+\]\(([^)]+)\)", markdown)
    external_links = {url for url in links if is_external_link(url)}
    tables = re.findall(r"^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$", markdown, re.MULTILINE)
    return {
        "boldSpans": markdown.count("**") // 2,
        "headings": len(re.findall(r"^#{1,6}\s+", markdown, re.MULTILINE)),
        "bulletItems": len(re.findall(r"^-\s+", markdown, re.MULTILINE)),
        "numberedItems": len(re.findall(r"^\d+\.\s+", markdown, re.MULTILINE)),
        "externalLinks": len(external_links),
        "tables": len(tables),
        "codeFences": markdown.count("```") // 2,
        "visibleHtmlComment": "<!--" in markdown,
    }


def span_markdown(span: dict) -> str:
    text = normalize(span.get("text", ""))
    if not text:
        return ""
    # Text spans are not a safe unit for a PDF annotation: a single link can
    # cross several spans or start mid-URL. Preserve visible text here; a
    # later reference-aware pass may create one complete Markdown link.
    result = text
    font = span.get("font", "").lower()
    if span.get("flags", 0) & 16 or any(
        token in font for token in ("bold", "semibold", "demibold", "black", "heavy")
    ):
        result = f"**{result}**"
    return result


def boundary_separator(previous: str, current: str) -> str:
    """Choose spacing from visible text rather than Markdown delimiters."""
    if not previous or not current:
        return ""
    left = previous[-1]
    right = current[0]
    if left == "-" and right.isalnum():
        return ""
    if right in "，。；：！？、（）【】《》“”‘’.,;:!?)]}\"'":
        return ""
    if left in "，。；：！？、（【《“‘\"'":
        return ""
    if is_cjk(left) and is_cjk(right):
        return ""
    if (is_cjk(left) and right.isalnum()) or (left.isalnum() and is_cjk(right)):
        return " "
    if left in "/":
        return ""
    return " "


def join_rich(parts: list[tuple[str, str]]) -> str:
    """Join wrapped text while keeping Markdown strong spans intact."""
    result = ""
    previous_plain = ""
    for plain, markdown in parts:
        plain = normalize(plain)
        markdown = markdown.strip()
        if not plain or not markdown:
            continue
        if result:
            result += boundary_separator(previous_plain, plain)
        result += markdown
        previous_plain = plain
    return result


def join_text(parts: list[str]) -> str:
    normalized = [normalize(item) for item in parts]
    return join_rich([(item, item) for item in normalized if item])


def table_markdown(table: object) -> str:
    rows = []
    for raw_row in table.extract():
        row = [join_text((cell or "").splitlines()).replace("|", "\\|") for cell in raw_row]
        rows.append(row)
    if len(rows) < 2 or not rows[0]:
        return ""
    width = len(rows[0])
    rows = [row + [""] * (width - len(row)) for row in rows]
    header = "| " + " | ".join(rows[0]) + " |"
    separator = "| " + " | ".join("---" for _ in rows[0]) + " |"
    body = ["| " + " | ".join(row) + " |" for row in rows[1:]]
    return "\n".join([header, separator, *body])


def table_rectangles(page: object) -> list[tuple[tuple[float, float, float, float], str]]:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        tables = page.find_tables().tables
    result = []
    for table in tables:
        markdown = table_markdown(table)
        if markdown:
            result.append((tuple(table.bbox), markdown))
    return sorted(result, key=lambda item: (item[0][1], item[0][0]))


def overlaps_table(line: Line, rectangles: list[tuple[tuple[float, float, float, float], str]]) -> bool:
    for (x0, y0, x1, y1), _ in rectangles:
        vertical = min(line.y1, y1) - max(line.y0, y0)
        horizontal = min(line.x1, x1) - max(line.x0, x0)
        if vertical > 0 and horizontal > 0:
            return True
    return False


def bullet_markers(page: object) -> list[tuple[float, float]]:
    """Return centers of small filled vector bullets omitted from PDF text."""
    markers: list[tuple[float, float]] = []
    for drawing in page.get_drawings():
        rectangle = drawing.get("rect")
        if rectangle is None or drawing.get("fill") is None:
            continue
        if not (2.0 <= rectangle.width <= 8.0 and 2.0 <= rectangle.height <= 8.0):
            continue
        if abs(rectangle.width - rectangle.height) > 1.5:
            continue
        markers.append(
            (
                (rectangle.x0 + rectangle.x1) / 2,
                (rectangle.y0 + rectangle.y1) / 2,
            )
        )
    return markers


def source_pdf_metrics(pdf_path: Path) -> dict[str, int]:
    document = pymupdf.open(pdf_path)
    bold_spans = 0
    vector_bullets = 0
    external_links: set[str] = set()
    for page_number, page in enumerate(document, 1):
        vector_bullets += sum(
            line.bullet_start for line in extract_lines(page, page_number)
        )
        external_links.update(
            link["uri"]
            for link in page.get_links()
            if is_external_link(link.get("uri"))
        )
        for block in page.get_text("dict", sort=True).get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    font = span.get("font", "").lower()
                    if span.get("flags", 0) & 16 or any(
                        token in font
                        for token in ("bold", "semibold", "demibold", "black", "heavy")
                    ):
                        if normalize(span.get("text", "")):
                            bold_spans += 1
    document.close()
    return {
        "sourceBoldSpans": bold_spans,
        "sourceVectorBullets": vector_bullets,
        "sourceExternalLinks": len(external_links),
    }


def aligns_with_bullet(
    bbox: tuple[float, float, float, float], markers: list[tuple[float, float]]
) -> bool:
    x0, y0, _, y1 = bbox
    return any(
        4.0 <= x0 - marker_x <= 24.0 and y0 - 2.0 <= marker_y <= y1 + 2.0
        for marker_x, marker_y in markers
    )


def extract_lines(page: object, page_number: int) -> list[Line]:
    markers = bullet_markers(page)
    result: list[Line] = []
    source_order = 0
    for block in page.get_text("dict", sort=True).get("blocks", []):
        if block.get("type") != 0:
            continue
        for raw_line in block.get("lines", []):
            spans = raw_line.get("spans", [])
            text = normalize("".join(span.get("text", "") for span in spans))
            if not text:
                continue
            bbox = raw_line["bbox"]
            rich_spans = [
                (normalize(span.get("text", "")), span_markdown(span))
                for span in spans
                if normalize(span.get("text", ""))
            ]
            markdown = join_rich(rich_spans)
            result.append(
                Line(
                    page_number,
                    source_order,
                    float(page.rect.height),
                    bbox[0],
                    bbox[2],
                    bbox[1],
                    bbox[3],
                    max((span.get("size", 0) for span in spans), default=0),
                    text,
                    markdown or text,
                    aligns_with_bullet(tuple(bbox), markers),
                )
            )
            source_order += 1
    return sorted(result, key=lambda item: (item.y0, item.x0))


def heading_level(text: str, size: float) -> int | None:
    if text in {"Executive Summary", "References"} or CHINESE_HEADING.match(text):
        return 2
    if NUMBERED_HEADING.match(text):
        return 3
    if size >= 18:
        return 2
    if size >= 14 and not LIST_ITEM.match(text):
        return 3
    return None


def starts_shell_block(lines: list[Line], index: int) -> bool:
    if COMMAND.match(lines[index].text):
        return True
    probe = index
    while probe < len(lines) and lines[probe].text.startswith("# "):
        probe += 1
    return probe > index and probe < len(lines) and COMMAND.match(lines[probe].text) is not None


def paragraph_break(previous: Line, current: Line) -> bool:
    """Detect semantic block gaps without treating every visual wrap as a break."""
    if previous.page != current.page:
        if re.search(r"[。！？.!?；;]$", previous.text) is None:
            return False
        usable_bottom = previous.page_height - 32.0
        remaining = usable_bottom - previous.y1
        required = max(previous.size, current.size) * 1.45
        return remaining >= required
    gap = current.y0 - previous.y1
    threshold = max(8.0, min(previous.size, current.size) * 0.65)
    return gap > threshold


def join_lines(lines: list[Line]) -> str:
    return join_rich([(line.text, line.markdown) for line in lines])


def collect_wrapped_item(lines: list[Line], index: int) -> tuple[list[Line], int]:
    """Collect continuation lines belonging to one bullet or numbered item."""
    item = [lines[index]]
    first = lines[index]
    index += 1
    while index < len(lines):
        candidate = lines[index]
        previous = item[-1]
        if candidate.page != first.page:
            break
        if candidate.bullet_start or LIST_ITEM.match(candidate.text):
            break
        if heading_level(candidate.text, candidate.size) is not None:
            break
        if candidate.text.startswith("# ") or COMMAND.match(candidate.text):
            break
        if candidate.x0 + 1.0 < first.x0 or paragraph_break(previous, candidate):
            break
        item.append(candidate)
        index += 1
    return item, index


def convert_fallback(pdf_path: Path) -> str:
    document = pymupdf.open(pdf_path)
    output: list[str] = []
    paragraph: list[Line] = []
    previous: Line | None = None

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            output.append(join_lines(paragraph))
            paragraph = []

    for page_number, page in enumerate(document, 1):
        rectangles = table_rectangles(page)
        table_index = 0
        lines = [line for line in extract_lines(page, page_number) if not overlaps_table(line, rectangles)]
        index = 0
        while index < len(lines):
            line = lines[index]
            while table_index < len(rectangles) and rectangles[table_index][0][1] <= line.y0:
                flush_paragraph()
                output.append(rectangles[table_index][1])
                table_index += 1

            if page_number == 1 and line.y0 < 130 and line.size >= 18:
                # SiYuan already stores the document title separately.
                index += 1
                previous = line
                continue

            if starts_shell_block(lines, index):
                flush_paragraph()
                code_lines: list[Line] = []
                while index < len(lines):
                    candidate = lines[index]
                    if candidate.text.startswith("# ") or COMMAND.match(candidate.text):
                        code_lines.append(candidate)
                        previous = candidate
                        index += 1
                    else:
                        break
                code = [
                    candidate.text
                    for candidate in sorted(code_lines, key=lambda candidate: candidate.order)
                ]
                output.append("```bash\n" + "\n".join(code) + "\n```")
                continue

            level = heading_level(line.text, line.size)
            if level is not None:
                flush_paragraph()
                output.append("#" * level + " " + line.text)
                previous = line
                index += 1
                continue

            if line.bullet_start:
                flush_paragraph()
                item, index = collect_wrapped_item(lines, index)
                output.append("- " + join_lines(item))
                previous = item[-1]
                continue

            if LIST_ITEM.match(line.text):
                flush_paragraph()
                item, index = collect_wrapped_item(lines, index)
                output.append(join_lines(item))
                previous = item[-1]
                continue

            if previous and paragraph_break(previous, line):
                flush_paragraph()
            paragraph.append(line)
            previous = line
            index += 1

        while table_index < len(rectangles):
            flush_paragraph()
            output.append(rectangles[table_index][1])
            table_index += 1

    flush_paragraph()
    document.close()
    markdown = "\n\n".join(part for part in output if part).strip() + "\n"
    markdown = re.sub(r"(?m)^(- .*)\n\n(?=- )", r"\1\n", markdown)
    markdown = re.sub(r"(?m)^(\d+\. .*)\n\n(?=\d+\. )", r"\1\n", markdown)
    return markdown


def convert_pymupdf4llm(pdf_path: Path) -> tuple[str, dict[str, int | str | bool]]:
    try:
        import pymupdf4llm
    except ImportError as error:
        raise SystemExit(
            "pymupdf4llm is not installed. Install it in an isolated converter "
            "environment, then invoke this script with that environment enabled."
        ) from error

    markdown = pymupdf4llm.to_markdown(
        str(pdf_path), write_images=False, page_chunks=False
    )
    markdown = normalize_cjk_compatibility(markdown)
    markdown, linkified = linkify_annotation_urls(markdown, annotation_urls(pdf_path))
    return markdown.rstrip() + "\n", {
        "converter": "pymupdf4llm",
        "converterVersion": getattr(pymupdf4llm, "__version__", "unknown"),
        "annotationLinksLinkified": linkified,
    }


def span_inline_literals(text: str) -> str:
    """Wrap identifier tokens in backticks, line by line.

    Unambiguous identifiers (commands, file names, compound or symbol-led
    event tokens) are always wrapped. Everyday-English event words
    (dispatch/escalation/websearch/clink) are wrapped only on lines that
    already carry one of those identifiers, so ordinary prose keeps its
    normal styling.
    """
    def wrap(match: re.Match[str]) -> str:
        return f"`{match.group(0)}`"

    wrapped_lines = []
    for line in text.split("\n"):
        wrapped = INLINE_LITERAL.sub(wrap, line)
        if "`" in wrapped:
            wrapped = INLINE_LITERAL_CONTEXT.sub(wrap, wrapped)
        wrapped_lines.append(wrapped)
    return "\n".join(wrapped_lines)


def polish_chinese_technical(markdown: str) -> str:
    """Apply presentation-only rules to a Chinese technical source."""
    if markdown.startswith("Date: "):
        metadata, remainder = markdown.split("\n\n", 1)
        metadata = metadata.replace(" Complexity: ", "  \n> Complexity: ")
        markdown = "> " + metadata + "\n\n" + remainder

    marker = "## References\n\n"
    if marker in markdown:
        before, references = markdown.split(marker, 1)
        entries = [
            re.sub(r"^\[(\d+)\]\s*", "", entry).strip()
            for entry in re.split(r"(?=\[\d+\]\s)", references)
            if entry.strip()
        ]
        markdown = before + marker + "\n".join(
            f"{index}. {entry}" for index, entry in enumerate(entries, 1)
        ) + "\n"


    pieces = re.split(r"(```.*?```|`[^`\n]+`)", markdown, flags=re.DOTALL)
    for index, piece in enumerate(pieces):
        if not piece.startswith(("```", "`")):
            pieces[index] = span_inline_literals(piece)
            pieces[index] = re.sub(r"([\u4e00-\u9fff])([A-Za-z0-9])", r"\1 \2", pieces[index])
            pieces[index] = re.sub(r"([A-Za-z0-9])([\u4e00-\u9fff])", r"\1 \2", pieces[index])
    polished = "".join(pieces)
    polished = polished.replace("\u200b", "")
    def extend_partial_list_label(match: re.Match[str]) -> str:
        marker, prefix = match.group(1), match.group(2)
        if "**" not in prefix:
            return match.group(0)
        return f"{marker}**{prefix.replace('**', '').strip()}：** "

    polished = re.sub(
        r"(?m)^(- |\d+\. )([^\n：]{1,60})：(?:\*\*)?",
        extend_partial_list_label,
        polished,
    )
    polished = re.sub(
        r"\s*\*\*Confidence:\*\*\s*(High|Medium|Low)\b",
        r"\n\n**Confidence:** \1",
        polished,
    )
    polished = re.sub(r"（\s+`", "（`", polished)
    return re.sub(r"`\s+）", "`）", polished)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", type=Path, help="Write Markdown to this path; default is stdout.")
    parser.add_argument(
        "--engine",
        choices=("fallback", "pymupdf4llm"),
        default="fallback",
        help="Use a mature external layout converter when it is installed separately.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        help="Write conversion identity and rich-feature metrics as JSON.",
    )
    parser.add_argument("--polish-zh", action="store_true", help="Apply Chinese technical-document typography.")
    args = parser.parse_args()
    if args.engine == "pymupdf4llm":
        markdown, details = convert_pymupdf4llm(args.pdf)
    else:
        markdown = convert_fallback(args.pdf)
        markdown, linkified = linkify_annotation_urls(
            markdown, annotation_urls(args.pdf)
        )
        details = {
            "converter": "fallback",
            "converterVersion": "bundled",
            "annotationLinksLinkified": linkified,
        }
    if args.polish_zh:
        markdown = polish_chinese_technical(markdown)
    if args.output:
        args.output.write_text(markdown, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(markdown)
    if args.manifest:
        source_bytes = args.pdf.read_bytes()
        payload = {
            "sourceFile": str(args.pdf),
            "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
            "engine": args.engine,
            **details,
            **source_pdf_metrics(args.pdf),
            **conversion_metrics(markdown),
        }
        args.manifest.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
