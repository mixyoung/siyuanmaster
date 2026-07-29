import { describe, expect, it } from "vitest";
import type { BlockRecord } from "../src/kernel-api";
import {
  documentDirectory,
  documentParentDirectory,
  documentParentId,
  isSameOrDescendantPath,
  joinHumanPath,
  previewMatchesCurrent,
  replaceHumanPathTitle,
  snapshotDocument,
} from "../src/structure-safety";

function document(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    id: "20260101000000-abcdefg",
    root_id: "20260101000000-abcdefg",
    box: "20260101000001-hijklmn",
    path: "/20260101000002-opqrstu/20260101000000-abcdefg.sy",
    hpath: "/父文档/原标题",
    name: "",
    alias: "",
    memo: "",
    tag: "",
    content: "原标题",
    type: "d",
    subtype: "",
    created: "20260101000000",
    updated: "20260102000000",
    ...overrides,
  };
}

describe("structural path safety", () => {
  it("derives the current parent target ID", () => {
    expect(documentParentId(document())).toBe(
      "20260101000002-opqrstu",
    );
    expect(
      documentParentId(
        document({ path: "/20260101000000-abcdefg.sy" }),
      ),
    ).toBe("20260101000001-hijklmn");
  });

  it("recognizes self and descendant targets", () => {
    const source = "/20260101000000-abcdefg.sy";
    expect(isSameOrDescendantPath(source, source)).toBe(true);
    expect(
      isSameOrDescendantPath(
        "/20260101000000-abcdefg/20260101000003-vwxyzab.sy",
        source,
      ),
    ).toBe(true);
    expect(
      isSameOrDescendantPath(
        "/20260101000004-cdefghi.sy",
        source,
      ),
    ).toBe(false);
  });

  it("builds deterministic destination paths", () => {
    expect(joinHumanPath("", "标题")).toBe("/标题");
    expect(joinHumanPath("/父文档/", "标题")).toBe(
      "/父文档/标题",
    );
    expect(replaceHumanPathTitle("/父文档/旧标题", "新标题")).toBe(
      "/父文档/新标题",
    );
    expect(
      documentDirectory(
        "/20260101000002-opqrstu/20260101000000-abcdefg.sy",
      ),
    ).toBe(
      "/20260101000002-opqrstu/20260101000000-abcdefg",
    );
    expect(
      documentParentDirectory(
        "/20260101000002-opqrstu/20260101000000-abcdefg.sy",
      ),
    ).toBe("/20260101000002-opqrstu");
  });
});

describe("preview drift detection", () => {
  it("accepts an unchanged document snapshot", () => {
    const current = document();
    expect(
      previewMatchesCurrent(snapshotDocument(current), current),
    ).toBe(true);
  });

  it("rejects title, path, notebook, or updated-time drift", () => {
    const current = document();
    const preview = snapshotDocument(current);
    expect(
      previewMatchesCurrent(preview, {
        ...current,
        updated: "20260103000000",
      }),
    ).toBe(false);
    expect(
      previewMatchesCurrent(preview, {
        ...current,
        path: "/20260101000000-abcdefg.sy",
      }),
    ).toBe(false);
  });
});
