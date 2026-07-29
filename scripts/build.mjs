import { createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const distDir = path.join(rootDir, "dist");
const packagePath = path.join(rootDir, "package.zip");

await rm(distDir, { recursive: true, force: true });
await rm(packagePath, { force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src/index.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: path.join(distDir, "index.js"),
  external: ["siyuan"],
  minify: true,
  sourcemap: false,
});

await build({
  entryPoints: [path.join(rootDir, "src/kernel.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(distDir, "kernel.js"),
  external: ["siyuan"],
  minify: true,
  sourcemap: false,
});

for (const name of [
  "plugin.json",
  "README.md",
  "README.zh-CN.md",
  "icon.png",
  "preview.png",
]) {
  await copyFile(path.join(rootDir, name), path.join(distDir, name));
}

await cp(path.join(rootDir, "src/i18n"), path.join(distDir, "i18n"), {
  recursive: true,
});
await cp(
  path.join(rootDir, "agent-skill"),
  path.join(distDir, "agent-skill"),
  { recursive: true },
);

await new Promise((resolve, reject) => {
  const output = createWriteStream(packagePath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(distDir, false);
  void archive.finalize();
});

console.log(`Built ${path.relative(rootDir, packagePath)}`);
