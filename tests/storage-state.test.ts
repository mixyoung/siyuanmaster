import { describe, expect, it } from "vitest";
import { equalStoredJson } from "../src/storage-state";

describe("host JSON readback", () => {
  it("accepts reordered nested fields without discarding values", () => {
    expect(equalStoredJson({ b: [{ y: 2, x: 1 }], a: true }, { a: true, b: [{ x: 1, y: 2 }] })).toBe(true);
  });
  it("rejects changed values, array order and primitive types", () => {
    expect(equalStoredJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(equalStoredJson([1, 2], [2, 1])).toBe(false);
    expect(equalStoredJson({ a: 1 }, { a: "1" })).toBe(false);
    expect(equalStoredJson({}, { a: null })).toBe(false);
  });
});
