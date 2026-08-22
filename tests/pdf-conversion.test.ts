import { describe, expect, it } from "vitest";
import {
  PdfConversionValidationError,
  validatePdfConversion,
} from "../src/pdf-conversion";

const GOOD_MARKDOWN = `## Heading

中文说明：在 Claude Code 中使用 \`AGENTS.md\`。

\`\`\`bash
/codex:review
\`\`\`

| 命令 | 功能 |
| --- | --- |
| \`/codex:review\` | 审查 |

**Important** [Official source](https://example.com/source)

## References

1. Example. https://example.com/source. Accessed 2026-08-22.
`;

describe("PDF conversion validation", () => {
  it("returns metadata-only proof for a passing external conversion", () => {
    const result = validatePdfConversion({
      converter: "marker",
      converterVersion: "1.2.3",
      markdown: GOOD_MARKDOWN,
      profile: "zh-technical",
      sourceSha256: "a".repeat(64),
      minimumBoldSpans: 1,
      minimumExternalLinks: 1,
      minimumTables: 1,
      minimumCodeBlocks: 1,
    });
    expect(result.valid).toBe(true);
    expect(result.checkedOnly).toBe(true);
    expect(result.writeExecuted).toBe(false);
    expect(result.summary).toMatchObject({
      headings: 2,
      boldSpans: 1,
      externalLinks: 1,
      tables: 1,
      codeBlocks: 1,
      referenceEntries: 1,
    });
    expect(JSON.stringify(result)).not.toContain("Heading");
  });

  it("fails when required rich source features were lost", () => {
    const result = validatePdfConversion({
      converter: "pymupdf4llm",
      markdown: "plain text",
      minimumBoldSpans: 1,
      minimumExternalLinks: 1,
      minimumTables: 1,
      minimumCodeBlocks: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual([
      "missing_bold_spans",
      "missing_external_links",
      "missing_tables",
      "missing_code_blocks",
    ]);
  });

  it("flags transport noise, unsafe pseudo-links, and Chinese style drift", () => {
    const result = validatePdfConversion({
      converter: "external",
      markdown:
        "Warning: truncated output\n<!-- source -->\n[AGENTS.md](http://agents.md/)\n中文,文本， 有空格",
      profile: "zh-technical",
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual([
      "transport_artifact",
      "visible_html_comment",
      "pseudo_filename_link",
      "zh_ascii_punctuation",
      "zh_punctuation_spacing",
    ]);
  });

  it("rejects invented converter IDs and unsafe expectations", () => {
    expect(() =>
      validatePdfConversion({ converter: "pandoc" as "marker", markdown: "" }),
    ).toThrow(PdfConversionValidationError);
    expect(() =>
      validatePdfConversion({
        converter: "marker",
        markdown: "",
        minimumTables: -1,
      }),
    ).toThrow(/minimumTables/);
  });
});
