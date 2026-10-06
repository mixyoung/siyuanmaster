// SiYuan adds an EOF LF and exports an empty paragraph as U+200D + LF.
// These are document post-write rules only; no body characters are stripped.
const EMPTY_PARAGRAPH_EXPORT = String.fromCharCode(0x200d) + "\n";
export function matchesDocumentReadback(
  expected: string,
  observed: string,
): boolean {
  return (
    observed === expected ||
    (expected === "" && observed === EMPTY_PARAGRAPH_EXPORT) ||
    (!expected.endsWith("\n") &&
      !expected.endsWith("\r") &&
      observed === `${expected}\n`)
  );
}
