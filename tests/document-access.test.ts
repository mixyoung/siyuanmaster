import { describe, expect, it } from "vitest";
import {
  blockDisplayText,
  buildOutline,
  classifyReferenceRisk,
  parseWriteTarget,
  referenceAllows,
  resolveDocumentPath,
  snippet,
  windowBlocks,
  type BlockRow,
  type DocumentLookupClient,
} from "../src/document-access";

const rows: BlockRow[] = [
  { blockId: "20260101000000-aaaaaaa", blockType: "h1", content: "Title", sort: 1 },
  { blockId: "20260101000000-bbbbbbb", blockType: "p", content: "A".repeat(200), sort: 2 },
  { blockId: "20260101000000-ccccccc", blockType: "h2", content: "Section", sort: 3 },
  { blockId: "20260101000000-ddddddd", blockType: "p", content: "Body", sort: 4 },
  { blockId: "20260101000000-eeeeeee", blockType: "p", content: "More", sort: 5 },
];

describe("long-document windowing", () => {
  it("applies hard window limits and nextOffset", () => {
    const page = windowBlocks(rows, 0, 2);
    expect(page.page).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
    const last = windowBlocks(rows, 4, 10);
    expect(last.page).toHaveLength(1);
    expect(last.nextOffset).toBeNull();
  });

  it("builds outline from heading blocks only", () => {
    expect(buildOutline(rows)).toEqual([
      { blockId: "20260101000000-aaaaaaa", level: 1, text: "Title" },
      { blockId: "20260101000000-ccccccc", level: 2, text: "Section" },
    ]);
  });

  it("prefers markdown for display text", () => {
    expect(
      blockDisplayText({
        blockId: "x",
        blockType: "p",
        content: "plain",
        markdown: " **md** ",
        sort: 0,
      }),
    ).toBe("**md**");
  });
});

describe("path lookup is read-only", () => {
  it("resolves absolute human paths via lookup client only", async () => {
    const calls: string[] = [];
    const client: DocumentLookupClient = {
      async findDocumentByHPath(notebookId, hPath) {
        calls.push(`${notebookId}:${hPath}`);
        return {
          id: "20260101000000-docdoc1",
          root_id: "20260101000000-docdoc1",
          box: notebookId,
          path: "/20260101000000-docdoc1.sy",
          hpath: hPath,
          name: "",
          alias: "",
          memo: "",
          tag: "",
          content: "note",
          type: "d",
          subtype: "",
          created: "20260101000000",
          updated: "20260101000000",
        };
      },
    };
    const resolved = await resolveDocumentPath(
      client,
      "20260101000000-notebook",
      "/AI/Memory/note/",
    );
    expect(resolved.documentId).toBe("20260101000000-docdoc1");
    expect(calls).toEqual([
      "20260101000000-notebook:/AI/Memory/note",
    ]);
  });

  it("rejects non-absolute paths", async () => {
    const client: DocumentLookupClient = {
      async findDocumentByHPath() {
        return undefined;
      },
    };
    await expect(
      resolveDocumentPath(client, "20260101000000-notebook", "relative"),
    ).rejects.toThrow(/absolute human-readable path/);
  });
});

describe("write targets and references", () => {
  it("accepts only exact SiYuan IDs for writes", () => {
    expect(parseWriteTarget("20260101000000-abcdefg").id).toBe(
      "20260101000000-abcdefg",
    );
    expect(() => parseWriteTarget("/AI/Memory/note")).toThrow(/exact SiYuan IDs/);
    expect(() =>
      parseWriteTarget("20260101000000-abcdefg", "not-a-hash"),
    ).toThrow(/64-character hex/);
  });

  it("classifies reference risk and deny mode", () => {
    const sameDoc = [
      {
        blockId: "20260101000000-refref1",
        documentId: "20260101000000-docdoc1",
        notebookId: "20260101000000-notebook",
        contentSnippet: "see above",
      },
    ];
    const cross = [
      {
        blockId: "20260101000000-refref2",
        documentId: "20260101000000-other01",
        notebookId: "20260101000000-notebook",
        contentSnippet: "from elsewhere",
      },
    ];
    expect(classifyReferenceRisk([], "20260101000000-docdoc1")).toBe("none");
    expect(classifyReferenceRisk(sameDoc, "20260101000000-docdoc1")).toBe(
      "some",
    );
    expect(classifyReferenceRisk(cross, "20260101000000-docdoc1")).toBe(
      "critical",
    );
    expect(referenceAllows(cross, "warn")).toBe(true);
    expect(referenceAllows(cross, "deny")).toBe(false);
    expect(referenceAllows([], "deny")).toBe(true);
  });

  it("bounds snippets without returning full bodies", () => {
    expect(snippet("a".repeat(500), 20).endsWith("…")).toBe(true);
    expect(snippet("a".repeat(500), 20).length).toBeLessThanOrEqual(21);
  });
});
