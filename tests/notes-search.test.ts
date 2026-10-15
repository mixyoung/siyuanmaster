import { describe, expect, it } from "vitest";
import {
  buildSearchDocumentPageSql,
  buildSearchMatchedBlocksSql,
  decodeSearchCursor,
  encodeSearchCursor,
  escapeLikePattern,
  likeSubstringLiteral,
  pickBestMatchPerDocument,
  type SearchMatchRow,
} from "../src/notes-search";

const NB = "20260101000000-notebok";

describe("LIKE escaping", () => {
  it("escapes wildcards and the escape character literally", () => {
    expect(escapeLikePattern("100%_done\\off")).toBe("100\\%\\_done\\\\off");
  });

  it("doubles single quotes after wildcard escaping", () => {
    expect(likeSubstringLiteral("it's 100%")).toBe("%it''s 100\\%%");
  });

  it("leaves ordinary CJK and emoji text untouched", () => {
    expect(escapeLikePattern("思源笔记🎯")).toBe("思源笔记🎯");
  });
});

describe("document-page SQL", () => {
  const base = {
    query: "deadline",
    notebookIds: [NB],
    limit: 20,
  };

  it("aggregates per document and pages by stable document-ID keyset", () => {
    const sql = buildSearchDocumentPageSql(base);
    expect(sql).toContain("GROUP BY b.root_id");
    expect(sql).toContain("ORDER BY b.root_id ASC");
    expect(sql).toContain("LIMIT 21");
    expect(sql).not.toContain("b.updated DESC");
    expect(sql).toContain("b.box IN ('20260101000000-notebok')");
  });

  it("applies the keyset predicate only when continuing", () => {
    const first = buildSearchDocumentPageSql(base);
    expect(first).not.toContain("b.root_id >");
    const next = buildSearchDocumentPageSql({
      ...base,
      afterDocumentId: "20260101000000-abcdefg",
    });
    expect(next).toContain("b.root_id > '20260101000000-abcdefg'");
  });

  it("puts policy and scope filters in WHERE before grouping and ordering", () => {
    const sql = buildSearchDocumentPageSql({
      ...base,
      scope: {
        rootDocumentId: "20260101000000-rootdoc",
        directory: "/20260101000000-rootdoc",
        notebookId: NB,
      },
    });
    const whereIndex = sql.indexOf("WHERE");
    const groupIndex = sql.indexOf("GROUP BY");
    const orderIndex = sql.indexOf("ORDER BY");
    expect(whereIndex).toBeGreaterThan(-1);
    expect(groupIndex).toBeGreaterThan(whereIndex);
    expect(orderIndex).toBeGreaterThan(groupIndex);
    expect(sql).toContain("scope_doc.id = '20260101000000-rootdoc'");
    // Boundary-safe subtree predicate: prefix anchored with a slash.
    expect(sql).toContain("scope_doc.path LIKE '/20260101000000-rootdoc/%'");
  });

  it("rejects malformed IDs instead of interpolating them", () => {
    expect(() =>
      buildSearchDocumentPageSql({ ...base, afterDocumentId: "x'; DROP TABLE blocks;--" }),
    ).toThrow(/valid SiYuan ID/);
    expect(() =>
      buildSearchMatchedBlocksSql({ ...base, documentIds: ["%"] }),
    ).toThrow(/valid SiYuan ID/);
  });

  it("escapes wildcard-bearing queries and ships an ESCAPE clause", () => {
    const sql = buildSearchDocumentPageSql({ ...base, query: "100%_done" });
    expect(sql).toContain("LIKE '%100\\%\\_done%' ESCAPE '\\'");
    expect(sql).not.toMatch(/LIKE '%100%_done%/);
  });
});

describe("per-document best-block selection", () => {
  function row(documentId: string, blockId: string, updated: string): SearchMatchRow {
    return {
      matched_id: blockId,
      document_id: documentId,
      box: NB,
      hpath: "/doc",
      title: "t",
      tags: null,
      snippet: "s",
      block_type: "p",
      updated,
    };
  }

  it("keeps the freshest block per document regardless of how many blocks one document contributed", () => {
    const docA = "20260101000000-aaaaaaa";
    const docB = "20260101000000-bbbbbbb";
    const picked = pickBestMatchPerDocument([
      row(docA, "b1", "20261002"),
      row(docA, "b2", "20261001"),
      row(docB, "b3", "20260930"),
    ]);
    expect(picked.map((r) => r.document_id)).toEqual([docA, docB]);
    expect(picked[0].matched_id).toBe("b1");
  });
});

describe("search cursor binding", () => {
  const cursor = {
    q: "思源 deadline",
    notebookId: NB,
    rootDocumentId: "20260101000000-rootdoc",
    accessSha: "a".repeat(64),
    afterDocumentId: "20260101000000-abcdefg",
  };

  it("round-trips the bound query, scope, and keyset position", () => {
    expect(decodeSearchCursor(encodeSearchCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed tokens without throwing", () => {
    expect(decodeSearchCursor("not-a-cursor")).toBeUndefined();
    expect(decodeSearchCursor(encodeURIComponent(JSON.stringify({ q: 1 })))).toBeUndefined();
  });
});
