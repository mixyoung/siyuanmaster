import { readFile } from "node:fs/promises";
import path from "node:path";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Content-type gate, not a full image decoder. A .png suffix alone is insufficient.
export function assertPngSignature(bytes, name) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${name}: expected PNG bytes matching the .png extension; convert the image instead of renaming it`);
  }
}

export async function validatePackageImages(rootDir) {
  for (const name of ["icon.png", "preview.png"]) {
    assertPngSignature(await readFile(path.join(rootDir, name)), name);
  }
}
