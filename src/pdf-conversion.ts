export const PDF_CONVERTERS = [
  "marker",
  "pymupdf4llm",
  "markitdown",
  "external",
] as const;
export const PDF_TEXT_PROFILES = ["preserve", "zh-technical"] as const;

export type PdfConverter = (typeof PDF_CONVERTERS)[number];
export type PdfTextProfile = (typeof PDF_TEXT_PROFILES)[number];

export interface PdfConversionValidationInput {
  converter: PdfConverter;
  converterVersion?: string;
  markdown: string;
  profile?: PdfTextProfile;
  sourceSha256?: string;
  minimumBoldSpans?: number;
  minimumExternalLinks?: number;
  minimumTables?: number;
  minimumCodeBlocks?: number;
}

type IssueSeverity = "error" | "warning";

export interface PdfConversionIssue {
  code:
    | "transport_artifact"
    | "visible_html_comment"
    | "unclosed_code_fence"
    | "pseudo_filename_link"
    | "missing_bold_spans"
    | "missing_external_links"
    | "missing_tables"
    | "missing_code_blocks"
    | "zh_ascii_punctuation"
    | "zh_punctuation_spacing";
  severity: IssueSeverity;
  message: string;
}

export class PdfConversionValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_converter"
      | "invalid_profile"
      | "invalid_expectation",
    message: string,
  ) {
    super(message);
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function markdownWithoutFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function countGfmTables(markdown: string): number {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let total = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      /\|/.test(lines[index]) &&
      /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(
        lines[index + 1],
      )
    ) {
      total += 1;
    }
  }
  return total;
}

function countReferenceEntries(markdown: string): number {
  const match = markdown.match(
    /^#{1,6}\s+(?:References|参考文献|来源)\s*$(?<body>[\s\S]*)/im,
  );
  return match ? countMatches(match.groups?.body ?? "", /^\d+\.\s+/gm) : 0;
}

function ensureMinimum(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100_000
  ) {
    throw new PdfConversionValidationError(
      "invalid_expectation",
      `${label} must be an integer from 0 to 100000`,
    );
  }
  return value;
}

function issue(
  issues: PdfConversionIssue[],
  code: PdfConversionIssue["code"],
  severity: IssueSeverity,
  message: string,
): void {
  issues.push({ code, severity, message });
}

export function validatePdfConversion(input: PdfConversionValidationInput) {
  if (!PDF_CONVERTERS.includes(input.converter)) {
    throw new PdfConversionValidationError(
      "invalid_converter",
      "converter must be marker, pymupdf4llm, markitdown, or external",
    );
  }
  const profile = input.profile ?? "preserve";
  if (!PDF_TEXT_PROFILES.includes(profile)) {
    throw new PdfConversionValidationError(
      "invalid_profile",
      "profile must be preserve or zh-technical",
    );
  }

  const minima = {
    boldSpans: ensureMinimum(input.minimumBoldSpans, "minimumBoldSpans"),
    externalLinks: ensureMinimum(
      input.minimumExternalLinks,
      "minimumExternalLinks",
    ),
    tables: ensureMinimum(input.minimumTables, "minimumTables"),
    codeBlocks: ensureMinimum(input.minimumCodeBlocks, "minimumCodeBlocks"),
  };
  const withoutCode = markdownWithoutFencedCode(input.markdown);
  const codeFenceMarkers = countMatches(input.markdown, /```/g);
  const summary = {
    markdownCharacters: input.markdown.length,
    headings: countMatches(input.markdown, /^#{1,6}\s+/gm),
    boldSpans: countMatches(withoutCode, /\*\*[^*\n][\s\S]*?\*\*/g),
    externalLinks: countMatches(
      withoutCode,
      /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g,
    ),
    tables: countGfmTables(withoutCode),
    codeBlocks: Math.floor(codeFenceMarkers / 2),
    referenceEntries: countReferenceEntries(withoutCode),
  };
  const issues: PdfConversionIssue[] = [];

  if (/Warning:\s*truncated output|pymupdf_layout package/i.test(input.markdown)) {
    issue(
      issues,
      "transport_artifact",
      "error",
      "Markdown contains converter or transport output rather than source content.",
    );
  }
  if (/<!--/.test(withoutCode)) {
    issue(
      issues,
      "visible_html_comment",
      "warning",
      "Markdown contains HTML comments that may render visibly in SiYuan.",
    );
  }
  if (codeFenceMarkers % 2 !== 0) {
    issue(
      issues,
      "unclosed_code_fence",
      "error",
      "Markdown has an unmatched fenced code block delimiter.",
    );
  }
  if (/\[[^\]\n]+\]\(http:\/\/[A-Za-z0-9-]+\.md\/?\)/i.test(withoutCode)) {
    issue(
      issues,
      "pseudo_filename_link",
      "warning",
      "Markdown contains a likely PDF-generated filename pseudo-link; preserve it as inline code instead.",
    );
  }
  if (minima.boldSpans !== undefined && summary.boldSpans < minima.boldSpans) {
    issue(
      issues,
      "missing_bold_spans",
      "error",
      `Expected at least ${minima.boldSpans} bold spans but found ${summary.boldSpans}.`,
    );
  }
  if (
    minima.externalLinks !== undefined &&
    summary.externalLinks < minima.externalLinks
  ) {
    issue(
      issues,
      "missing_external_links",
      "error",
      `Expected at least ${minima.externalLinks} external Markdown links but found ${summary.externalLinks}.`,
    );
  }
  if (minima.tables !== undefined && summary.tables < minima.tables) {
    issue(
      issues,
      "missing_tables",
      "error",
      `Expected at least ${minima.tables} tables but found ${summary.tables}.`,
    );
  }
  if (minima.codeBlocks !== undefined && summary.codeBlocks < minima.codeBlocks) {
    issue(
      issues,
      "missing_code_blocks",
      "error",
      `Expected at least ${minima.codeBlocks} fenced code blocks but found ${summary.codeBlocks}.`,
    );
  }
  if (profile === "zh-technical") {
    if (/[\u4e00-\u9fff][,:;!?]|[,:;!?][\u4e00-\u9fff]/.test(withoutCode)) {
      issue(
        issues,
        "zh_ascii_punctuation",
        "warning",
        "Chinese prose still contains adjacent ASCII punctuation.",
      );
    }
    if (/[，。；：！？）、”]\s+[\u4e00-\u9fff]/.test(withoutCode)) {
      issue(
        issues,
        "zh_punctuation_spacing",
        "warning",
        "Chinese punctuation is followed by an unnecessary space before Chinese text.",
      );
    }
  }

  return {
    checkedOnly: true,
    writeExecuted: false,
    valid: !issues.some((item) => item.severity === "error"),
    converter: {
      id: input.converter,
      version: input.converterVersion ?? null,
    },
    profile,
    sourceSha256: input.sourceSha256 ?? null,
    minimums: minima,
    summary,
    issues,
  };
}
