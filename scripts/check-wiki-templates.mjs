import { readFile } from "node:fs/promises";
import {
  renderWikiTemplateModule,
  wikiTemplateCatalogPath,
  wikiTemplateOutPath,
} from "./generate-wiki-templates.mjs";

const catalog = JSON.parse(await readFile(wikiTemplateCatalogPath, "utf8"));
const rendered = renderWikiTemplateModule(catalog);
const committed = await readFile(wikiTemplateOutPath, "utf8");

if (rendered === committed) {
  console.log("generated wiki-templates.ts is fresh");
  process.exit(0);
}

console.error(
  "generated wiki-templates.ts is STALE — run `pnpm run generate` and commit the result.",
);
process.exit(1);
