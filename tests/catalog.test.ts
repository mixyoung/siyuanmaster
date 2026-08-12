import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CATALOG_TOOLS,
  ORIGINAL_TOOL_COUNT,
  PLUGIN_NAMESPACE,
  PLUGIN_TOOL_NAMES,
  PRODUCT_ID,
  PRODUCT_VERSION,
  TECHNICAL_ID,
  TOOL_NAMES,
  TXN_NAME,
} from "../src/generated/capabilities";
import { renderCatalogModule } from "../scripts/generate-capabilities.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(rootDir, "catalog", "capabilities.json");
const generatedPath = path.join(
  rootDir,
  "src",
  "generated",
  "capabilities.ts",
);

const ORIGINAL_16 = [
  "get_policy",
  "list_accessible_notebooks",
  "list_document_tree",
  "search_notes",
  "read_note",
  "create_note",
  "append_note",
  "update_note",
  "rename_note",
  "move_note",
  "delete_note",
  "suggest_tags",
  "apply_tags",
  "prepare_summary",
  "save_memory",
  "get_audit_log",
] as const;

describe("capability catalog freshness and identity", () => {
  it("keeps generated capabilities.ts fresh with the catalog", () => {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const rendered = renderCatalogModule(catalog);
    const committed = readFileSync(generatedPath, "utf8");
    expect(committed).toBe(rendered);
  });

  it("declares brand and technical id as siyuanmaster at 0.6.0", () => {
    expect(PRODUCT_ID).toBe("siyuanmaster");
    expect(TECHNICAL_ID).toBe("siyuanmaster");
    expect(PRODUCT_VERSION).toBe("0.6.0");
    expect(PLUGIN_NAMESPACE).toBe("plugin__siyuanmaster__");
    expect(TXN_NAME).toBe("SafeWriteTxn");
  });

  it("exposes 27 tools including the original 16 under siyuanmaster namespace", () => {
    expect(TOOL_NAMES).toHaveLength(27);
    expect(CATALOG_TOOLS).toHaveLength(27);
    expect(ORIGINAL_TOOL_COUNT).toBe(16);
    for (const name of ORIGINAL_16) {
      expect(TOOL_NAMES).toContain(name);
    }
    expect(TOOL_NAMES).toContain("resolve_document");
    expect(TOOL_NAMES).toContain("read_note_segments");
    expect(TOOL_NAMES).toContain("edit_block");
    expect(TOOL_NAMES).toContain("register_knowledge_source");
    expect(TOOL_NAMES).toContain("register_wiki_authority");
    expect(TOOL_NAMES).toContain("knowledge_status");
    expect(TOOL_NAMES).toContain("find_wiki_candidates");
    expect(TOOL_NAMES).toContain("list_wiki_templates");
    expect(TOOL_NAMES).toContain("render_wiki_template");
    expect(TOOL_NAMES).toContain("validate_wiki_template");
    expect(TOOL_NAMES).toContain("plan_source_ingest");
    expect(PLUGIN_TOOL_NAMES).toHaveLength(27);
    for (const fq of PLUGIN_TOOL_NAMES) {
      expect(fq.startsWith("plugin__siyuanmaster__")).toBe(true);
      expect(fq.startsWith("plugin__siyuan_agent_access__")).toBe(false);
    }
    for (const name of ORIGINAL_16) {
      expect(PLUGIN_TOOL_NAMES).toContain(`plugin__siyuanmaster__${name}`);
    }
  });

  it("catalog stores only bare tool names and current namespace", () => {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    expect(catalog.namespaces.plugin).toBe("plugin__siyuanmaster__");
    expect(catalog.namespaces.legacyPlugin).toBeUndefined();
    expect(catalog.product.technicalId).toBe("siyuanmaster");
    expect(catalog.compatibility.technicalIdPolicy).toBe(
      "siyuanmaster-with-storage-migration",
    );
    for (const tool of catalog.pluginTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.legacy).toBeUndefined();
    }
  });
});
