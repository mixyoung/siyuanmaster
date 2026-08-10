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
    expect(policy.safety).toEqual(DEFAULT_POLICY.safety);
    expect(policy.safety.snapshotBeforeWrite).toBe(true);
    expect(policy.safety.referenceProtection).toBe("warn");
    expect(policy.safety.permissionInheritance).toBe(true);
    expect(isNotebookAllowed("20260101000000-abcdefg", policy)).toBe(
      false,
    );
  });

  it("normalizes safety policy with clamps and enums", () => {
    const policy = normalizePolicy({
      safety: {
        snapshotBeforeWrite: false,
        referenceProtection: "deny",
        permissionInheritance: false,
        longDocument: {
          maxBlocksPerWindow: 999,
          maxCharsPerBlock: 10,
          maxOutlineBlocks: 1,
        },
        blockEdit: {
          requireExpectedState: false,
          defaultConfirm: false,
          maxBlocks: 9999,
        },
      },
    });
    // P0/P1 mandatory invariants: always true even if stored false.
    expect(policy.safety.snapshotBeforeWrite).toBe(true);
    expect(policy.safety.permissionInheritance).toBe(true);
    expect(policy.safety.referenceProtection).toBe("deny");
    expect(policy.safety.longDocument.maxBlocksPerWindow).toBe(200);
    expect(policy.safety.longDocument.maxCharsPerBlock).toBe(256);
    expect(policy.safety.longDocument.maxOutlineBlocks).toBe(10);
    expect(policy.safety.blockEdit.maxBlocks).toBe(500);
    expect(policy.safety.blockEdit.requireExpectedState).toBe(false);
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
