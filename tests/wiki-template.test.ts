import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderWikiTemplateModule } from "../scripts/generate-wiki-templates.mjs";
import {
  KNOWLEDGE_ROLES,
  WIKI_PAGE_TYPES,
  type WikiPageType,
} from "../src/knowledge-registry";
import {
  listWikiTemplates,
  renderWikiTemplate,
  validateWikiTemplate,
  wikiTemplateCatalog,
  wikiTemplateDefinition,
  WIKI_TEMPLATE_LOCALES,
} from "../src/wiki-template";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(rootDir, "catalog", "wiki-templates.json");
const generatedPath = path.join(
  rootDir,
  "src",
  "generated",
  "wiki-templates.ts",
);
const skillReferencePath = path.join(
  rootDir,
  "agent-skill",
  "references",
  "knowledge-compounding.md",
);

function render(pageType: WikiPageType, locale: "zh-CN" | "en" = "zh-CN") {
  return renderWikiTemplate({
    pageType,
    title: "测试标题",
    locale,
    knowledgeRole: "synthesis",
    aliases: ["别名", "别名", "second alias"],
    sourceIds: ["source:1", "source:1", "source:2"],
  }) as {
    markdown: string;
    previewOnly: boolean;
    writeExecuted: boolean;
  };
}

describe("deterministic Wiki template catalog", () => {
  it("keeps the generated module fresh with the JSON source of truth", () => {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    expect(readFileSync(generatedPath, "utf8")).toBe(
      renderWikiTemplateModule(catalog),
    );
  });

  it("defines every page type exactly once and keeps registry enums aligned", () => {
    const catalog = wikiTemplateCatalog();
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.templateVersion).toBe("1.0.0");
    expect(catalog.templates.map((item) => item.pageType)).toEqual([
      ...WIKI_PAGE_TYPES,
    ]);
    expect(catalog.metadata.knowledgeRoles).toEqual([...KNOWLEDGE_ROLES]);
    expect(listWikiTemplates("zh-CN")).toMatchObject({
      locale: "zh-CN",
      templateVersion: "1.0.0",
    });
  });

  it("keeps the English Skill reference aligned with catalog headings", () => {
    const reference = readFileSync(skillReferencePath, "utf8");
    for (const template of wikiTemplateCatalog().templates) {
      for (const heading of template.headings) {
        expect(reference).toContain(`## ${heading.label.en}`);
      }
    }
  });
});

describe("deterministic Wiki template rendering", () => {
  it.each(WIKI_PAGE_TYPES)(
    "renders all required headings for %s in both locales",
    (pageType) => {
      for (const locale of WIKI_TEMPLATE_LOCALES) {
        const first = render(pageType, locale);
        const second = render(pageType, locale);
        expect(first).toEqual(second);
        expect(first.previewOnly).toBe(true);
        expect(first.writeExecuted).toBe(false);
        const template = wikiTemplateDefinition(pageType);
        for (const heading of template.headings) {
          expect(first.markdown).toContain(`## ${heading.label[locale]}`);
        }
      }
    },
  );

  it("renders normalized metadata without mutating or duplicating lists", () => {
    const result = render("topic");
    expect(result.markdown.startsWith("```yaml\n")).toBe(true);
    expect(result.markdown).toContain("knowledge_role: synthesis");
    expect(result.markdown).toContain("page_type: topic");
    expect(result.markdown).toContain('aliases: ["别名", "second alias"]');
    expect(result.markdown).toContain('source_ids: ["source:1", "source:2"]');
    expect(result.markdown).toContain("status: draft");
    expect(result.markdown).toContain("evidence_status: insufficient");
  });

  it("uses the localized suffix for source summaries", () => {
    expect(render("source_summary", "zh-CN").markdown).toContain(
      "# 测试标题：摘要",
    );
    expect(render("source_summary", "en").markdown).toContain(
      "# 测试标题: Summary",
    );
  });
});

describe("deterministic Wiki template validation", () => {
  it.each(WIKI_PAGE_TYPES)("accepts a rendered %s template", (pageType) => {
    const result = validateWikiTemplate({
      pageType,
      markdown: render(pageType).markdown,
      locale: "zh-CN",
      expectedTitle: "测试标题",
      expectedKnowledgeRole: "synthesis",
      requireMetadata: true,
    }) as {
      valid: boolean;
      errorCount: number;
      checkedOnly: boolean;
      writeExecuted: boolean;
    };
    expect(result).toMatchObject({
      valid: true,
      errorCount: 0,
      checkedOnly: true,
      writeExecuted: false,
    });
  });

  it("detects missing, duplicate, and out-of-order required headings", () => {
    const template = wikiTemplateDefinition("concept");
    const markdown = render("concept").markdown;
    const first = `## ${template.headings[0].label["zh-CN"]}`;
    const second = `## ${template.headings[1].label["zh-CN"]}`;
    const missing = validateWikiTemplate({
      pageType: "concept",
      markdown: markdown.replace(`${first}\n\n`, ""),
    }) as { valid: boolean; issues: Array<{ code: string }> };
    const duplicate = validateWikiTemplate({
      pageType: "concept",
      markdown: markdown.replace(first, `${first}\n\n${first}`),
    }) as { valid: boolean; issues: Array<{ code: string }> };
    const reordered = validateWikiTemplate({
      pageType: "concept",
      markdown: markdown
        .replace(first, "## __swap__")
        .replace(second, first)
        .replace("## __swap__", second),
    }) as { valid: boolean; issues: Array<{ code: string }> };
    expect(missing.valid).toBe(false);
    expect(missing.issues).toContainEqual(
      expect.objectContaining({ code: "missing_heading" }),
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.issues).toContainEqual(
      expect.objectContaining({ code: "duplicate_heading" }),
    );
    expect(reordered.valid).toBe(false);
    expect(reordered.issues).toContainEqual(
      expect.objectContaining({ code: "heading_out_of_order" }),
    );
  });

  it("checks title and required metadata values", () => {
    const markdown = render("topic").markdown;
    const result = validateWikiTemplate({
      pageType: "topic",
      markdown: markdown.replace("status: draft", "status: invented"),
      expectedTitle: "另一个标题",
      expectedKnowledgeRole: "governance",
      requireMetadata: true,
    }) as { valid: boolean; issues: Array<{ code: string; field?: string }> };
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "title_mismatch" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: "knowledge_role" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "invalid_metadata", field: "status" }),
    );
  });

  it("rejects unsupported roles and malformed review dates", () => {
    const markdown = render("topic").markdown
      .replace("knowledge_role: synthesis", "knowledge_role: invented")
      .replace('reviewed_at: ""', 'reviewed_at: "last week"');
    const result = validateWikiTemplate({
      pageType: "topic",
      markdown,
      requireMetadata: true,
    }) as { valid: boolean; issues: Array<{ field?: string }> };
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: "knowledge_role" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: "reviewed_at" }),
    );
  });

  it("requires metadata only when requested", () => {
    const markdown = renderWikiTemplate({
      pageType: "topic",
      title: "测试标题",
      knowledgeRole: "synthesis",
      includeMetadata: false,
    }) as { markdown: string };
    const result = validateWikiTemplate({
      pageType: "topic",
      markdown: markdown.markdown,
      requireMetadata: true,
    }) as { valid: boolean; issues: Array<{ code: string }> };
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "metadata_missing" }),
    );
  });

  it("accepts legacy front matter while rendering SiYuan-safe fenced metadata", () => {
    const markdown = render("topic").markdown;
    const legacy = markdown
      .replace(/^```yaml/, "---")
      .replace(/```\n\n# /, "---\n\n# ");
    const result = validateWikiTemplate({
      pageType: "topic",
      markdown: legacy,
      requireMetadata: true,
    }) as { valid: boolean };
    expect(result.valid).toBe(true);
  });

  it("ignores headings inside fenced code and warns on real extra H2s", () => {
    const markdown = `${render("topic").markdown}\n\n\`\`\`md\n\`\`\`not a closing fence\n## 代码块标题\n\`\`\`\n\n## 自定义附录\n`;
    const result = validateWikiTemplate({
      pageType: "topic",
      markdown,
    }) as {
      valid: boolean;
      warningCount: number;
      issues: Array<{ code: string; message: string }>;
    };
    expect(result.valid).toBe(true);
    expect(result.warningCount).toBe(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "unexpected_h2",
        message: expect.stringContaining("自定义附录"),
      }),
    );
    expect(result.issues.some((issue) => issue.message.includes("代码块标题"))).toBe(
      false,
    );
  });
});
