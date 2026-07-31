import { describe, expect, it } from "vitest";
import {
  buildDocumentTree,
  documentTreeParentId,
  documentTreePathDepth,
  type DocumentTreeRow,
} from "../src/document-tree";

const ROOT_A = "20260101000000-abcdefg";
const CHILD_B = "20260101000001-hijklmn";
const GRANDCHILD_C = "20260101000002-opqrstu";
const ROOT_D = "20260101000003-vwxyzab";

function row(
  id: string,
  path: string,
  hpath: string,
  hasChildren = false,
): DocumentTreeRow {
  return {
    id,
    path,
    hpath,
    title: hpath.split("/").filter(Boolean).at(-1) ?? "",
    updated: "20260102000000",
    has_children: hasChildren ? 1 : 0,
  };
}

const rows = [
  row(ROOT_A, `/${ROOT_A}.sy`, "/根文档甲", true),
  row(
    CHILD_B,
    `/${ROOT_A}/${CHILD_B}.sy`,
    "/根文档甲/子文档乙",
    true,
  ),
  row(
    GRANDCHILD_C,
    `/${ROOT_A}/${CHILD_B}/${GRANDCHILD_C}.sy`,
    "/根文档甲/子文档乙/孙文档丙",
  ),
  row(ROOT_D, `/${ROOT_D}.sy`, "/根文档丁"),
];

describe("document tree paths", () => {
  it("derives absolute depth and physical parent IDs", () => {
    expect(documentTreePathDepth(`/${ROOT_A}.sy`)).toBe(1);
    expect(
      documentTreePathDepth(`/${ROOT_A}/${CHILD_B}.sy`),
    ).toBe(2);
    expect(documentTreeParentId(`/${ROOT_A}.sy`)).toBeNull();
    expect(documentTreeParentId(`/${ROOT_A}/${CHILD_B}.sy`)).toBe(
      ROOT_A,
    );
  });
});

describe("document tree shaping", () => {
  it("builds a nested notebook forest without note bodies", () => {
    const tree = buildDocumentTree(rows);
    expect(tree).toHaveLength(2);
    const root = tree.find((node) => node.id === ROOT_A);
    expect(root).toMatchObject({
      title: "根文档甲",
      parentId: null,
      depth: 1,
      hasChildren: true,
    });
    expect(root?.children[0]).toMatchObject({
      id: CHILD_B,
      parentId: ROOT_A,
      depth: 2,
    });
    expect(root?.children[0].children[0]).toMatchObject({
      id: GRANDCHILD_C,
      depth: 3,
      children: [],
    });
    expect(JSON.stringify(tree)).not.toContain("markdown");
  });

  it("rebases a selected document subtree to depth zero", () => {
    const subtree = buildDocumentTree(rows.slice(1, 3), CHILD_B);
    expect(subtree).toHaveLength(1);
    expect(subtree[0]).toMatchObject({
      id: CHILD_B,
      parentId: null,
      depth: 0,
    });
    expect(subtree[0].children[0]).toMatchObject({
      id: GRANDCHILD_C,
      parentId: CHILD_B,
      depth: 1,
    });
  });

  it("keeps an incomplete branch self-contained", () => {
    const tree = buildDocumentTree([rows[2]]);
    expect(tree[0]).toMatchObject({
      id: GRANDCHILD_C,
      parentId: null,
    });
  });
});
