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
COMMAND = re.compile(r"^(?:/|!codex\s|npm\s|npx\s|claude\s|codex\s)")
INLINE_LITERAL = re.compile(
    r"(?<![`A-Za-z0-9_./-])(?:AGENTS\.md|CLAUDE\.md|REQUIREMENTS\.md|\.codex/config\.toml|codex\.toml|sessionId|threadId|/codex:[a-z-]+(?:\s+--[a-z-]+)?|npm\s+(?:install|i)\s+-g\s+@openai/codex|codex\s+mcp-server|!codex|write_code|explain_code|debug_code|codex_completion|o4-mini|gpt-4\.1)(?![`A-Za-z0-9_./-])"
)


@dataclass(frozen=True)
class Line:
    page: int
    x0: float
    y0: float
    y1: float
    size: float
    text: str
    markdown: str


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
    pieces = re.split(r"(```.*?```)", markdown, flags=re.DOTALL)
    for index, piece in enumerate(pieces):
        if piece.startswith("```"):
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
        "externalLinks": len(external_links),
        "tables": len(tables),
        "codeFences": markdown.count("```") // 2,
        "visibleHtmlComment": "<!--" in markdown,
    }


def link_for_span(span_bbox: tuple[float, float, float, float], links: list[tuple[tuple[float, float, float, float], str]]) -> str | None:
    sx0, sy0, sx1, sy1 = span_bbox
    for (lx0, ly0, lx1, ly1), uri in links:
        if min(sx1, lx1) - max(sx0, lx0) > 0.5 and min(sy1, ly1) - max(sy0, ly0) > 0.5:
            return uri
    return None


def span_markdown(span: dict, links: list[tuple[tuple[float, float, float, float], str]]) -> str:
    text = normalize(span.get("text", ""))
    if not text:
        return ""
    uri = link_for_span(tuple(span["bbox"]), links)
    result = f"[{text}]({uri})" if uri else text
    font = span.get("font", "").lower()
    if span.get("flags", 0) & 16 or any(token in font for token in ("bold", "black", "heavy")):
        result = f"**{result}**"
    return result


def join_text(parts: list[str]) -> str:
    result = ""
    for part in (normalize(item) for item in parts):
        if not part:
            continue
        if not result:
            result = part
        elif result.endswith("-") and part[:1].isalnum():
            result += part
        elif is_cjk(result[-1]) and is_cjk(part[0]):
            result += part
        elif result.endswith(("，", "。", "；", "：", "！", "？", "）", "”", "、")):
            result += part
        elif result.endswith(("/", "—", "–")):
            result += " " + part
        else:
            result += " " + part
    return result


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
        horizontal = min(line.x0 + 9999, x1) - max(line.x0, x0)
        if vertical > 0 and horizontal > 0:
            return True
    return False


def extract_lines(page: object, page_number: int) -> list[Line]:
    links = [
        (tuple(link["from"]), link["uri"])
        for link in page.get_links()
        if is_external_link(link.get("uri"))
    ]
    result: list[Line] = []
    for block in page.get_text("dict", sort=True).get("blocks", []):
        if block.get("type") != 0:
            continue
        for raw_line in block.get("lines", []):
            spans = raw_line.get("spans", [])
            text = normalize("".join(span.get("text", "") for span in spans))
            if not text:
                continue
            bbox = raw_line["bbox"]
            markdown = "".join(span_markdown(span, links) for span in spans)
            result.append(
                Line(
                    page_number,
                    bbox[0],
                    bbox[1],
                    bbox[3],
                    max((span.get("size", 0) for span in spans), default=0),
                    text,
                    markdown or text,
                )
            )
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


def convert_fallback(pdf_path: Path) -> str:
    document = pymupdf.open(pdf_path)
    output: list[str] = []
    paragraph: list[str] = []
    previous: Line | None = None

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            output.append(join_text(paragraph))
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
                code: list[str] = []
                while index < len(lines):
                    candidate = lines[index]
                    if candidate.text.startswith("# ") or COMMAND.match(candidate.text):
                        code.append(candidate.text)
                        previous = candidate
                        index += 1
                    else:
                        break
                output.append("```bash\n" + "\n".join(code) + "\n```")
                continue

            level = heading_level(line.text, line.size)
            if level is not None:
                flush_paragraph()
                output.append("#" * level + " " + line.text)
                previous = line
                index += 1
                continue

            if LIST_ITEM.match(line.text):
                flush_paragraph()
                paragraph.append(line.text)
                previous = line
                index += 1
                continue

            if previous and previous.page == line.page and line.y0 - previous.y1 > 22:
                flush_paragraph()
            paragraph.append(line.markdown)
            previous = line
            index += 1

        while table_index < len(rectangles):
            flush_paragraph()
            output.append(rectangles[table_index][1])
            table_index += 1

    flush_paragraph()
    document.close()
    return "\n\n".join(part for part in output if part).strip() + "\n"


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


    pieces = re.split(r"(```.*?```)", markdown, flags=re.DOTALL)
    for index, piece in enumerate(pieces):
        if not piece.startswith("```"):
            pieces[index] = INLINE_LITERAL.sub(lambda match: f"`{match.group(0)}`", piece)
    polished = "".join(pieces)
    polished = polished.replace("\u200b", "")
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
        details = {"converter": "fallback", "converterVersion": "bundled"}
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
