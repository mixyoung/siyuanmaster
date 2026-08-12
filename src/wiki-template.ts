import { WIKI_TEMPLATE_CATALOG } from "./generated/wiki-templates";
import {
  KNOWLEDGE_ROLES,
  WIKI_PAGE_TYPES,
  type KnowledgeRole,
  type WikiPageType,
} from "./knowledge-registry";

export const WIKI_TEMPLATE_LOCALES = ["zh-CN", "en"] as const;
export const WIKI_STATUSES = [
  "draft",
  "active",
  "deprecated",
  "archived",
] as const;
export const WIKI_EVIDENCE_STATUSES = [
  "supported",
  "mixed",
  "disputed",
  "insufficient",
] as const;

export type WikiTemplateLocale = (typeof WIKI_TEMPLATE_LOCALES)[number];
export type WikiStatus = (typeof WIKI_STATUSES)[number];
export type WikiEvidenceStatus =
  (typeof WIKI_EVIDENCE_STATUSES)[number];

interface LocalizedText {
  "zh-CN": string;
  en: string;
}

export interface WikiTemplateHeading {
  key: string;
  label: LocalizedText;
}

export interface WikiTemplateDefinition {
  pageType: WikiPageType;
  titlePlaceholder: LocalizedText;
  titleSuffix?: LocalizedText;
  purpose: LocalizedText;
  creationGate: LocalizedText;
  headings: WikiTemplateHeading[];
}

export interface WikiTemplateCatalog {
  schemaVersion: 1;
  templateVersion: string;
  locales: readonly WikiTemplateLocale[];
  defaults: {
    locale: WikiTemplateLocale;
    status: WikiStatus;
    evidenceStatus: WikiEvidenceStatus;
  };
  metadata: {
    knowledgeRoles: readonly KnowledgeRole[];
    statuses: readonly WikiStatus[];
    evidenceStatuses: readonly WikiEvidenceStatus[];
  };
  templates: readonly WikiTemplateDefinition[];
}

export interface RenderWikiTemplateInput {
  pageType: WikiPageType;
  title: string;
  locale?: WikiTemplateLocale;
  knowledgeRole: KnowledgeRole;
  aliases?: string[];
  canonicalDocumentId?: string;
  authorityDocumentId?: string;
  sourceContainerDocumentId?: string;
  sourceIds?: string[];
  status?: WikiStatus;
  evidenceStatus?: WikiEvidenceStatus;
  reviewedAt?: string;
  includeMetadata?: boolean;
}

export interface WikiTemplateValidationIssue {
  code:
    | "missing_h1"
    | "title_mismatch"
    | "duplicate_h1"
    | "missing_heading"
    | "duplicate_heading"
    | "heading_out_of_order"
    | "unexpected_h2"
    | "metadata_missing"
    | "metadata_mismatch"
    | "invalid_metadata";
  severity: "error" | "warning";
  field?: string;
  headingKey?: string;
  message: string;
}

export interface ValidateWikiTemplateInput {
  pageType: WikiPageType;
  markdown: string;
  locale?: WikiTemplateLocale;
  expectedTitle?: string;
  expectedKnowledgeRole?: KnowledgeRole;
  requireMetadata?: boolean;
  allowAdditionalHeadings?: boolean;
}

const catalog = WIKI_TEMPLATE_CATALOG as unknown as WikiTemplateCatalog;

function plainTitle(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function metadataLines(input: RenderWikiTemplateInput): string[] {
  const aliases = unique(input.aliases ?? []);
  const sourceIds = unique(input.sourceIds ?? []);
  return [
    `knowledge_role: ${input.knowledgeRole}`,
    `page_type: ${input.pageType}`,
    `canonical_document: ${yamlScalar(input.canonicalDocumentId ?? "")}`,
    `aliases: [${aliases.map(yamlScalar).join(", ")}]`,
    `authority_document: ${yamlScalar(input.authorityDocumentId ?? "")}`,
    `source_container: ${yamlScalar(input.sourceContainerDocumentId ?? "")}`,
    `source_ids: [${sourceIds.map(yamlScalar).join(", ")}]`,
    `status: ${input.status ?? catalog.defaults.status}`,
    `evidence_status: ${
      input.evidenceStatus ?? catalog.defaults.evidenceStatus
    }`,
    `reviewed_at: ${yamlScalar(input.reviewedAt ?? "")}`,
  ];
}

function normalizedHeading(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function parseHeadingLine(line: string): { level: number; text: string } | null {
  const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(
    line,
  );
  return match
    ? { level: match[1].length, text: match[2].trim() }
    : null;
}

function markdownHeadings(
  markdown: string,
): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  let fence: { character: "`" | "~"; length: number } | undefined;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (fence) {
      const closingFence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closingFence &&
        closingFence[1][0] === fence.character &&
        closingFence[1].length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    const openingFence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      const marker = openingFence[1];
      const character = marker[0] as "`" | "~";
      fence = { character, length: marker.length };
      continue;
    }
    const heading = parseHeadingLine(line);
    if (heading) {
      headings.push(heading);
    }
  }
  return headings;
}

function parseMetadata(markdown: string): Map<string, string> | undefined {
  const lines = markdown
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  const firstContent = lines.findIndex((line) => Boolean(line.trim()));
  const first = lines[firstContent]?.trim();
  const fenced = /^(`{3,}|~{3,})ya?ml(?:[ \t].*)?$/i.exec(first ?? "");
  const legacyFrontMatter = first === "---";
  if (!fenced && !legacyFrontMatter) {
    return undefined;
  }
  const closing = lines.findIndex((line, index) => {
    if (index <= firstContent) {
      return false;
    }
    if (legacyFrontMatter) {
      return line.trim() === "---";
    }
    const closingFence = /^(`{3,}|~{3,})[ \t]*$/.exec(line.trim());
    return Boolean(
      closingFence &&
        closingFence[1][0] === fenced?.[1][0] &&
        closingFence[1].length >= (fenced?.[1].length ?? 0),
    );
  });
  if (closing < 0) {
    return undefined;
  }
  const result = new Map<string, string>();
  for (const line of lines.slice(firstContent + 1, closing)) {
    const match = /^([a-z_]+):[ \t]*(.*)$/.exec(line);
    if (match) {
      result.set(match[1], match[2].trim());
    }
  }
  return result;
}

export function wikiTemplateCatalog(): WikiTemplateCatalog {
  return catalog;
}

export function wikiTemplateDefinition(
  pageType: WikiPageType,
): WikiTemplateDefinition {
  const template = catalog.templates.find(
    (candidate) => candidate.pageType === pageType,
  );
  if (!template) {
    throw new Error(`No Wiki template is registered for '${pageType}'`);
  }
  return template;
}

export function listWikiTemplates(
  locale: WikiTemplateLocale = catalog.defaults.locale,
): Record<string, unknown> {
  return {
    schemaVersion: catalog.schemaVersion,
    templateVersion: catalog.templateVersion,
    locale,
    defaults: catalog.defaults,
    metadata: catalog.metadata,
    templates: catalog.templates.map((template) => ({
      pageType: template.pageType,
      titlePlaceholder: template.titlePlaceholder[locale],
      titleSuffix: template.titleSuffix?.[locale],
      purpose: template.purpose[locale],
      creationGate: template.creationGate[locale],
      requiredHeadings: template.headings.map((heading) => ({
        key: heading.key,
        label: heading.label[locale],
      })),
    })),
  };
}

export function renderWikiTemplate(
  input: RenderWikiTemplateInput,
): Record<string, unknown> {
  const locale = input.locale ?? catalog.defaults.locale;
  const template = wikiTemplateDefinition(input.pageType);
  const title = plainTitle(input.title);
  if (!title) {
    throw new Error("title must not be empty");
  }
  if (title.length > 256) {
    throw new Error("title must not exceed 256 characters");
  }
  const renderedTitle = `${title}${template.titleSuffix?.[locale] ?? ""}`;
  const includeMetadata = input.includeMetadata !== false;
  const markdown = [
    ...(includeMetadata
      ? ["```yaml", ...metadataLines(input), "```", ""]
      : []),
    `# ${renderedTitle}`,
    "",
    ...template.headings.flatMap((heading) => [
      `## ${heading.label[locale]}`,
      "",
    ]),
  ].join("\n");
  return {
    schemaVersion: catalog.schemaVersion,
    templateVersion: catalog.templateVersion,
    pageType: input.pageType,
    locale,
    title: renderedTitle,
    knowledgeRole: input.knowledgeRole,
    purpose: template.purpose[locale],
    creationGate: template.creationGate[locale],
    status: input.status ?? catalog.defaults.status,
    evidenceStatus:
      input.evidenceStatus ?? catalog.defaults.evidenceStatus,
    requiredHeadingKeys: template.headings.map((heading) => heading.key),
    markdown,
    previewOnly: true,
    writeExecuted: false,
  };
}

export function validateWikiTemplate(
  input: ValidateWikiTemplateInput,
): Record<string, unknown> {
  const locale = input.locale ?? catalog.defaults.locale;
  const template = wikiTemplateDefinition(input.pageType);
  const headings = markdownHeadings(input.markdown);
  const h1 = headings.filter((heading) => heading.level === 1);
  const h2 = headings.filter((heading) => heading.level === 2);
  const issues: WikiTemplateValidationIssue[] = [];

  if (h1.length === 0) {
    issues.push({
      code: "missing_h1",
      severity: "error",
      message: "The document is missing its level-1 title.",
    });
  } else if (h1.length > 1) {
    issues.push({
      code: "duplicate_h1",
      severity: "error",
      message: "The document contains more than one level-1 title.",
    });
  }

  if (input.expectedTitle && h1.length > 0) {
    const expected = `${plainTitle(input.expectedTitle)}${
      template.titleSuffix?.[locale] ?? ""
    }`;
    if (normalizedHeading(h1[0].text) !== normalizedHeading(expected)) {
      issues.push({
        code: "title_mismatch",
        severity: "error",
        field: "title",
        message: "The level-1 title does not match expectedTitle.",
      });
    }
  }

  const expectedHeadings = template.headings.map((heading) => ({
    ...heading,
    normalized: normalizedHeading(heading.label[locale]),
  }));
  const actualNormalized = h2.map((heading) => normalizedHeading(heading.text));
  let previousIndex = -1;
  for (const expected of expectedHeadings) {
    const indexes = actualNormalized.flatMap((value, index) =>
      value === expected.normalized ? [index] : [],
    );
    if (indexes.length === 0) {
      issues.push({
        code: "missing_heading",
        severity: "error",
        headingKey: expected.key,
        message: `Required heading '${expected.label[locale]}' is missing.`,
      });
      continue;
    }
    if (indexes.length > 1) {
      issues.push({
        code: "duplicate_heading",
        severity: "error",
        headingKey: expected.key,
        message: `Required heading '${expected.label[locale]}' appears more than once.`,
      });
    }
    if (indexes[0] < previousIndex) {
      issues.push({
        code: "heading_out_of_order",
        severity: "error",
        headingKey: expected.key,
        message: `Required heading '${expected.label[locale]}' is out of order.`,
      });
    }
    previousIndex = Math.max(previousIndex, indexes[0]);
  }

  if (!input.allowAdditionalHeadings) {
    const expectedSet = new Set(
      expectedHeadings.map((heading) => heading.normalized),
    );
    for (const heading of h2) {
      if (!expectedSet.has(normalizedHeading(heading.text))) {
        issues.push({
          code: "unexpected_h2",
          severity: "warning",
          message: `Additional level-2 heading '${heading.text}' is outside the selected template.`,
        });
      }
    }
  }

  const metadata = parseMetadata(input.markdown);
  if (input.requireMetadata && !metadata) {
    issues.push({
      code: "metadata_missing",
      severity: "error",
      message: "The deterministic metadata block is missing.",
    });
  }
  if (metadata) {
    for (const field of [
      "knowledge_role",
      "page_type",
      "status",
      "evidence_status",
    ]) {
      if (!metadata.get(field)) {
        issues.push({
          code: "metadata_missing",
          severity: "error",
          field,
          message: `Required metadata field '${field}' is missing.`,
        });
      }
    }
    const pageType = metadata.get("page_type");
    if (pageType && pageType !== input.pageType) {
      issues.push({
        code: "metadata_mismatch",
        severity: "error",
        field: "page_type",
        message: "page_type does not match the selected template.",
      });
    }
    const knowledgeRole = metadata.get("knowledge_role");
    if (
      knowledgeRole &&
      !KNOWLEDGE_ROLES.includes(knowledgeRole as KnowledgeRole)
    ) {
      issues.push({
        code: "invalid_metadata",
        severity: "error",
        field: "knowledge_role",
        message: "knowledge_role contains an unsupported value.",
      });
    }
    if (
      input.expectedKnowledgeRole &&
      knowledgeRole !== input.expectedKnowledgeRole
    ) {
      issues.push({
        code: "metadata_mismatch",
        severity: "error",
        field: "knowledge_role",
        message: "knowledge_role does not match the expected role.",
      });
    }
    const status = metadata.get("status");
    if (status && !WIKI_STATUSES.includes(status as WikiStatus)) {
      issues.push({
        code: "invalid_metadata",
        severity: "error",
        field: "status",
        message: "status contains an unsupported value.",
      });
    }
    const evidenceStatus = metadata.get("evidence_status");
    if (
      evidenceStatus &&
      !WIKI_EVIDENCE_STATUSES.includes(
        evidenceStatus as WikiEvidenceStatus,
      )
    ) {
      issues.push({
        code: "invalid_metadata",
        severity: "error",
        field: "evidence_status",
        message: "evidence_status contains an unsupported value.",
      });
    }
    const reviewedAt = metadata.get("reviewed_at");
    if (reviewedAt) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(reviewedAt);
      } catch {
        decoded = undefined;
      }
      if (
        decoded !== "" &&
        (typeof decoded !== "string" ||
          !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
            decoded,
          ) ||
          Number.isNaN(Date.parse(decoded)))
      ) {
        issues.push({
          code: "invalid_metadata",
          severity: "error",
          field: "reviewed_at",
          message: "reviewed_at must be empty or an ISO date/timestamp.",
        });
      }
    }
  }

  const errorCount = issues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const warningCount = issues.length - errorCount;
  return {
    schemaVersion: catalog.schemaVersion,
    templateVersion: catalog.templateVersion,
    pageType: input.pageType,
    locale,
    valid: errorCount === 0,
    errorCount,
    warningCount,
    issues,
    expectedHeadingKeys: template.headings.map((heading) => heading.key),
    observedHeadingCount: headings.length,
    checkedOnly: true,
    writeExecuted: false,
  };
}

export function assertWikiTemplateCatalog(): void {
  if (catalog.schemaVersion !== 1) {
    throw new Error("Wiki template catalog schemaVersion must be 1");
  }
  const pageTypes = catalog.templates.map((template) => template.pageType);
  if (
    pageTypes.length !== WIKI_PAGE_TYPES.length ||
    new Set(pageTypes).size !== WIKI_PAGE_TYPES.length ||
    WIKI_PAGE_TYPES.some((pageType) => !pageTypes.includes(pageType))
  ) {
    throw new Error("Wiki template catalog must define every page type once");
  }
  if (
    catalog.metadata.knowledgeRoles.length !== KNOWLEDGE_ROLES.length ||
    KNOWLEDGE_ROLES.some(
      (role) => !catalog.metadata.knowledgeRoles.includes(role),
    )
  ) {
    throw new Error("Wiki template knowledge roles must match the registry");
  }
  if (
    catalog.locales.length !== WIKI_TEMPLATE_LOCALES.length ||
    catalog.metadata.statuses.length !== WIKI_STATUSES.length ||
    catalog.metadata.evidenceStatuses.length !==
      WIKI_EVIDENCE_STATUSES.length ||
    WIKI_TEMPLATE_LOCALES.some(
      (locale) => !catalog.locales.includes(locale),
    ) ||
    WIKI_STATUSES.some(
      (status) => !catalog.metadata.statuses.includes(status),
    ) ||
    WIKI_EVIDENCE_STATUSES.some(
      (status) => !catalog.metadata.evidenceStatuses.includes(status),
    )
  ) {
    throw new Error("Wiki template locale or metadata enums are incomplete");
  }
  for (const template of catalog.templates) {
    if (
      template.headings.length === 0 ||
      new Set(template.headings.map((heading) => heading.key)).size !==
        template.headings.length
    ) {
      throw new Error(
        `Wiki template '${template.pageType}' has invalid heading keys`,
      );
    }
    for (const locale of WIKI_TEMPLATE_LOCALES) {
      if (
        !template.titlePlaceholder[locale]?.trim() ||
        !template.purpose[locale]?.trim() ||
        !template.creationGate[locale]?.trim() ||
        template.headings.some(
          (heading) => !heading.label[locale]?.trim(),
        )
      ) {
        throw new Error(
          `Wiki template '${template.pageType}' is incomplete for ${locale}`,
        );
      }
      const normalizedLabels = template.headings.map((heading) =>
        normalizedHeading(heading.label[locale]),
      );
      if (new Set(normalizedLabels).size !== normalizedLabels.length) {
        throw new Error(
          `Wiki template '${template.pageType}' has duplicate ${locale} headings`,
        );
      }
    }
  }
}

assertWikiTemplateCatalog();
