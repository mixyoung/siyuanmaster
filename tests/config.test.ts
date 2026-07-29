import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  isNotebookAllowed,
  normalizePolicy,
} from "../src/config";
import { normalizeDocumentPath } from "../src/kernel-api";

describe("access policy", () => {
  it("defaults to a deny-by-default empty allowlist", () => {
    const policy = normalizePolicy(undefined);
    expect(policy.access).toEqual(DEFAULT_POLICY.access);
    expect(policy.operations).toMatchObject({
      rename: "confirm",
      move: "confirm",
      moveAcrossNotebooks: "deny",
    });
    expect(isNotebookAllowed("20260101000000-abcdefg", policy)).toBe(
      false,
    );
  });

  it("supports denylist semantics", () => {
    const policy = normalizePolicy({
      access: {
        mode: "denylist",
        selectedNotebookIds: ["20260101000000-abcdefg"],
        defaultDecision: "allow",
      },
    });
    expect(
      isNotebookAllowed("20260101000000-abcdefg", policy),
    ).toBe(false);
    expect(
      isNotebookAllowed("20260101000000-hijklmn", policy),
    ).toBe(true);
  });
});

describe("document path normalization", () => {
  it("builds a safe human path", () => {
    expect(normalizeDocumentPath("/AI/Memory/", " Weekly / Review "))
      .toBe("/AI/Memory/Weekly Review");
  });

  it("rejects relative path traversal", () => {
    expect(() => normalizeDocumentPath("../secret", "note")).toThrow(
      /relative path/,
    );
  });
});
