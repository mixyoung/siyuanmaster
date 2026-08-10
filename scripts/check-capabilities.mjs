// Freshness gate for src/generated/capabilities.ts.
//
// Re-renders the module from catalog/capabilities.json and compares it to
// the committed generated file. Exits non-zero (and prints the diff path)
// when they diverge, so `pnpm build` cannot pass with a stale generated
// contract. Run `pnpm run generate` to refresh.

import { readFile } from "node:fs/promises";
import { catalogPath, outPath, renderCatalogModule } from "./generate-capabilities.mjs";

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const rendered = renderCatalogModule(catalog);
const committed = await readFile(outPath, "utf8");

if (rendered === committed) {
  console.log("generated capabilities.ts is fresh");
  process.exit(0);
}

console.error(
  "generated capabilities.ts is STALE — run `pnpm run generate` and commit the result.",
);
process.exit(1);
