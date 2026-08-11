import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  attachBlockStateHashes,
  blockDisplayText,
  buildOutline,
  classifyReferenceRisk,
  isStateHash,
  mapWithConcurrency,
  parseWriteTarget,
  referenceAllows,
  resolveDocumentPath,
  snippet,
  windowBlocks,
  type BlockRow,
  type DocumentLookupClient,
  type SegmentBlockView,
} from "../src/document-access";
import { computeContentHash } from "../src/write-transaction";

function nodeSha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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

describe("mapWithConcurrency", () => {
  it("preserves order and bounds in-flight work", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return item * 2;
    });
    expect(results).toEqual(items.map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("returns empty for empty input without calling mapper", async () => {
    const mapper = vi.fn(async () => 1);
    await expect(mapWithConcurrency([], 8, mapper)).resolves.toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });
});

describe("attachBlockStateHashes", () => {
  const page: SegmentBlockView[] = [
    {
      blockId: "20260101000000-aaaaaaa",
      blockType: "p",
      text: "sql-display-text",
      truncated: false,
    },
    {
      blockId: "20260101000000-bbbbbbb",
      blockType: "p",
      text: "other-sql",
      truncated: false,
    },
  ];

  it("hashes getBlockKramdown output, not SQL display text", async () => {
    const kramdownById: Record<string, string> = {
      "20260101000000-aaaaaaa": "exact kramdown A",
      "20260101000000-bbbbbbb": "exact kramdown B",
    };
    const getBlockKramdown = vi.fn(async (id: string) => kramdownById[id] ?? "");
    const hashed = await attachBlockStateHashes(
      page,
      getBlockKramdown,
      computeContentHash,
      2,
    );
    expect(getBlockKramdown).toHaveBeenCalledTimes(2);
    expect(getBlockKramdown).toHaveBeenCalledWith("20260101000000-aaaaaaa");
    expect(getBlockKramdown).toHaveBeenCalledWith("20260101000000-bbbbbbb");
    expect(hashed[0]?.stateHash).toBe(nodeSha256Hex("exact kramdown A"));
    expect(hashed[1]?.stateHash).toBe(nodeSha256Hex("exact kramdown B"));
    // Must not equal hash of SQL/display text
    expect(hashed[0]?.stateHash).not.toBe(nodeSha256Hex("sql-display-text"));
    expect(isStateHash(hashed[0]?.stateHash)).toBe(true);
    // Display fields unchanged; no raw kramdown body added
    expect(hashed[0]).toMatchObject({
      blockId: "20260101000000-aaaaaaa",
      text: "sql-display-text",
      truncated: false,
    });
    expect(hashed[0]).not.toHaveProperty("kramdown");
    expect(hashed[0]).not.toHaveProperty("content");
  });

  it("only touches the provided window (caller must not pass full list)", async () => {
    const getBlockKramdown = vi.fn(async () => "k");
    await attachBlockStateHashes(
      page.slice(0, 1),
      getBlockKramdown,
      computeContentHash,
    );
    expect(getBlockKramdown).toHaveBeenCalledTimes(1);
    expect(getBlockKramdown).toHaveBeenCalledWith("20260101000000-aaaaaaa");
  });
});
