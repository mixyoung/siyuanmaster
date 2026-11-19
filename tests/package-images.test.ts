import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertPngSignature, validatePackageImages } from "../scripts/check-package-images.mjs";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "siyuan-images-"));
  dirs.push(dir);
  for (const name of ["icon.png", "preview.png"]) await writeFile(path.join(dir, name), png);
  return dir;
}

describe("package image format gate", () => {
  it("accepts the PNG signature", () => expect(() => assertPngSignature(png, "preview.png")).not.toThrow());
  it.each([Buffer.alloc(0), png.subarray(0, 7), jpeg, Buffer.from("not a png image")])("rejects empty, truncated, JPEG or unknown signatures", (bytes) => expect(() => assertPngSignature(bytes, "preview.png")).toThrow(/preview.png.*expected PNG/));
  it("accepts both PNG assets", async () => { await expect(validatePackageImages(await fixture())).resolves.toBeUndefined(); });
  it.each(["icon.png", "preview.png"])("rejects JPEG bytes renamed to %s", async (name) => {
    const dir = await fixture(); await writeFile(path.join(dir, name), jpeg);
    await expect(validatePackageImages(dir)).rejects.toThrow(new RegExp(`${name}.*expected PNG`));
  });
  it("rejects a missing preview", async () => {
    const dir = await fixture(); await rm(path.join(dir, "preview.png"));
    await expect(validatePackageImages(dir)).rejects.toThrow(/ENOENT/);
  });
  it("validates the actual repository images", async () => {
    await expect(validatePackageImages(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))).resolves.toBeUndefined();
  });
});
