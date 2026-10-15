import { describe, expect, it } from "vitest";
import {
  computeScopeFingerprint,
  coverageIsExact,
  documentComplete,
  mergeCoverage,
  parseScopeSession,
  pruneScopeSessions,
  scopeComplete,
  scopeCounts,
  slicePage,
  MAX_ACTIVE_SCOPE_SESSIONS,
  MAX_STORED_SCOPE_SESSIONS,
  type ScopeMember,
  type ScopeSession,
} from "../src/scope-read";

function member(id: string, path: string, updated = "20261001000000"): ScopeMember {
  return { id, path, updated };
}

function session(partial: Partial<ScopeSession> = {}): ScopeSession {
  return {
    sessionId: "s1",
    createdAt: "2026-10-01T00:00:00.000Z",
    notebookId: "20260101000000-notebook",
    rootDocumentId: null,
    scopeFingerprint: "f",
    enumerationCompleted: true,
    documents: {},
    ...partial,
  };
}

describe("scope fingerprint binds the full member list", () => {
  const scope = { notebookId: "20260101000000-notebook", rootDocumentId: null };
  const base = [
    member("20260101000000-aaaaaaa", "/20260101000000-aaaaaaa.sy", "20261001000000"),
    member("20260101000000-bbbbbbb", "/20260101000000-bbbbbbb.sy", "20261001000000"),
  ];

  it("is stable for identical members and independent of input order", async () => {
    const a = await computeScopeFingerprint(scope, base);
    const b = await computeScopeFingerprint(scope, [...base].reverse());
    const c = await computeScopeFingerprint(scope, base);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("detects a count-preserving membership swap with identical updated values", async () => {
    // One document replaced by another; count, max(updated) unchanged.
    const swapped = [
      base[0],
      member("20260101000000-ccccccc", "/20260101000000-ccccccc.sy", "20261001000000"),
    ];
    expect(await computeScopeFingerprint(scope, swapped)).not.toBe(
      await computeScopeFingerprint(scope, base),
    );
  });

  it("detects a move that keeps count and max(updated) unchanged", async () => {
    const moved = [
      base[0],
      member(
        "20260101000000-bbbbbbb",
        "/20260101000000-aaaaaaa/20260101000000-bbbbbbb.sy",
        "20261001000000",
      ),
    ];
    expect(await computeScopeFingerprint(scope, moved)).not.toBe(
      await computeScopeFingerprint(scope, base),
    );
  });

  it("detects a same-count update within one second-precision timestamp bucket boundary", async () => {
    // Same ID and path, different updated: a rename or edit without a move.
    const edited = [
      base[0],
      member("20260101000000-bbbbbbb", "/20260101000000-bbbbbbb.sy", "20261001000001"),
    ];
    expect(await computeScopeFingerprint(scope, edited)).not.toBe(
      await computeScopeFingerprint(scope, base),
    );
  });

  it("separates scopes by notebook and root document", async () => {
    const same = await computeScopeFingerprint(scope, base);
    expect(await computeScopeFingerprint({ ...scope, notebookId: "20260101000000-other" }, base)).not.toBe(same);
    expect(
      await computeScopeFingerprint({ ...scope, rootDocumentId: "20260101000000-aaaaaaa" }, base),
    ).not.toBe(same);
  });
});

describe("coverage intervals", () => {
  it("merges touching pages into one exact range", () => {
    let coverage = mergeCoverage([], 0, 20000);
    coverage = mergeCoverage(coverage, 20000, 40000);
    expect(coverage).toEqual([[0, 40000]]);
    expect(coverageIsExact(coverage, 40000)).toBe(true);
  });

  it("keeps a hole when only the tail was read", () => {
    const coverage = mergeCoverage([], 49990, 50000);
    expect(coverageIsExact(coverage, 50000)).toBe(false);
    expect(coverage).toEqual([[49990, 50000]]);
  });

  it("duplicate and overlapping reads cannot close a hole", () => {
    let coverage = mergeCoverage([], 0, 10000);
    coverage = mergeCoverage(coverage, 0, 10000);
    coverage = mergeCoverage(coverage, 5000, 12000);
    // Gap (12000, 40000): reading the tail directly must not fill it.
    coverage = mergeCoverage(coverage, 40000, 50000);
    expect(coverageIsExact(coverage, 50000)).toBe(false);
    // Closing the remaining hole completes the tiling.
    coverage = mergeCoverage(coverage, 12000, 40000);
    expect(coverageIsExact(coverage, 50000)).toBe(true);
  });

  it("treats an empty document as exactly covered by nothing", () => {
    expect(coverageIsExact([], 0)).toBe(true);
    expect(coverageIsExact(mergeCoverage([], 0, 0), 0)).toBe(true);
  });

  it("ignores empty ranges", () => {
    expect(mergeCoverage([[0, 10]], 10, 10)).toEqual([[0, 10]]);
  });
});

describe("page slicing never splits a surrogate pair", () => {
  const full = [
    "# 标题\n",
    "正文".repeat(400),
    "\n```code block with 简体 & émojis 🎯🎯\n",
    "x".repeat(300),
    "```\n",
    "| a | b |\n|---|---|\n| 1 | 2 |\n",
    "🎯".repeat(600),
    "trailing whitespace   \n",
  ].join("");
  const emoji = "🎯";

  it("reassembles pages into the exact original string", () => {
    const pages: string[] = [];
    let offset = 0;
    for (let i = 0; i < 40; i += 1) {
      const page = slicePage(full, offset, 1000);
      pages.push(page.content);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(pages.join("")).toBe(full);
  });

  it("extends a page that would end inside a surrogate pair", () => {
    const pairStart = full.indexOf(emoji);
    // Cut exactly between the high and low surrogate.
    const page = slicePage(full, 0, pairStart + 1);
    expect(page.content.length).toBe(pairStart + 2);
    expect(page.content.endsWith(emoji)).toBe(true);
    expect([...page.content].at(-1)).toBe(emoji);
  });

  it("returns an empty terminal page at content end", () => {
    const page = slicePage(full, full.length, 1000);
    expect(page.content).toBe("");
    expect(page.nextOffset).toBeNull();
  });

  it("reports nextOffset while content remains", () => {
    const page = slicePage(full, 0, 500);
    expect(page.nextOffset).toBeGreaterThanOrEqual(500);
    expect(typeof page.nextOffset).toBe("number");
  });
});

describe("derived completion", () => {
  const docId = "20260101000000-aaaaaaa";

  function coveredDocument(coverage: Array<[number, number]>, length: number) {
    return {
      status: "pending" as const,
      path: `/${docId}.sy`,
      updated: "20261001000000",
      contentHash: "h".repeat(64),
      contentLength: length,
      coverage,
    };
  }

  it("marks a fully tiled single-version document complete", () => {
    expect(documentComplete(coveredDocument([[0, 50000]], 50000))).toBe(true);
  });

  it("rejects tail-only, duplicated, or overlapping coverage", () => {
    expect(documentComplete(coveredDocument([[49990, 50000]], 50000))).toBe(false);
    expect(documentComplete(coveredDocument([[0, 10000], [12000, 50000]], 50000))).toBe(false);
    expect(documentComplete(coveredDocument([], 50000))).toBe(false);
  });

  it("requires a recorded hash", () => {
    const doc = coveredDocument([[0, 50000]], 50000);
    delete doc.contentHash;
    expect(documentComplete(doc)).toBe(false);
  });

  it("scopeComplete enforces every conjunct", () => {
    const complete = session({
      documents: { [docId]: coveredDocument([[0, 50000]], 50000) },
    });
    expect(scopeComplete(complete)).toBe(true);
    expect(scopeCounts(complete)).toMatchObject({ total: 1, complete: 1, pending: 0 });

    expect(scopeComplete(session({ enumerationCompleted: false, documents: complete.documents }))).toBe(false);
    expect(scopeComplete(session({ persistDegraded: true, documents: complete.documents }))).toBe(false);
    expect(
      scopeComplete(
        session({
          documents: {
            [docId]: coveredDocument([[0, 50000]], 50000),
            failed: { status: "failed", path: "/x", updated: "u", coverage: [] },
          },
        }),
      ),
    ).toBe(false);
    expect(
      scopeComplete(
        session({
          documents: {
            [docId]: { ...coveredDocument([[0, 50000]], 50000), status: "changed" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      scopeComplete(
        session({
          documents: {
            [docId]: { ...coveredDocument([[0, 50000]], 50000), status: "blocked" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      scopeComplete(
        session({
          documents: {
            [docId]: coveredDocument([[0, 50000]], 50000),
            second: { status: "pending", path: "/y", updated: "u", coverage: [] },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("session pruning", () => {
  function completeSession(id: string, createdAt: string): ScopeSession {
    return session({
      sessionId: id,
      createdAt,
      scopeFingerprint: `f-${id}`,
      documents: {
        "20260101000000-aaaaaaa": {
          status: "pending",
          path: "/20260101000000-aaaaaaa.sy",
          updated: "20261001000000",
          contentHash: "h".repeat(64),
          contentLength: 10,
          coverage: [[0, 10]],
        },
      },
    });
  }

  function incompleteSession(id: string, createdAt: string): ScopeSession {
    return session({
      sessionId: id,
      createdAt,
      scopeFingerprint: `f-${id}`,
      documents: {
        "20260101000000-aaaaaaa": {
          status: "pending",
          path: "/20260101000000-aaaaaaa.sy",
          updated: "20261001000000",
          coverage: [],
        },
      },
    });
  }

  it("keeps sessions up to the stored cap without dropping live work", () => {
    const sessions = [
      completeSession("old-complete", "2026-10-01T00:00:00.000Z"),
      incompleteSession("old-incomplete", "2026-10-02T00:00:00.000Z"),
      ...Array.from({ length: MAX_STORED_SCOPE_SESSIONS - 2 }, (_, i) =>
        completeSession(`bulk-${i}`, new Date(Date.parse("2026-10-03T00:00:00.000Z") + i * 1000).toISOString()),
      ),
    ];
    const pruned = pruneScopeSessions(sessions);
    expect(pruned.length).toBeLessThanOrEqual(
      Math.max(MAX_STORED_SCOPE_SESSIONS, MAX_ACTIVE_SCOPE_SESSIONS),
    );
    // Oldest complete session dropped first; incomplete kept.
    expect(pruned.some((s) => s.sessionId === "old-incomplete")).toBe(true);
  });
});

describe("stored session validation", () => {
  it("parses a well-formed session", () => {
    const parsed = parseScopeSession(
      JSON.parse(
        JSON.stringify({
          sessionId: "s1",
          createdAt: "2026-10-01T00:00:00.000Z",
          notebookId: "nb",
          rootDocumentId: null,
          scopeFingerprint: "f",
          enumerationCompleted: true,
          documents: {
            d1: {
              status: "pending",
              path: "/d1.sy",
              updated: "u",
              coverage: [[0, 5]],
            },
          },
        }),
      ),
    );
    expect(parsed?.documents.d1.coverage).toEqual([[0, 5]]);
  });

  it.each([
    [null],
    [{}],
    [{ sessionId: "s1", createdAt: "x", notebookId: "n", scopeFingerprint: "f", enumerationCompleted: true, documents: {} }],
    [{
      sessionId: "s1", createdAt: "x", notebookId: "n", scopeFingerprint: "f",
      enumerationCompleted: true,
      documents: { d1: { status: "weird", path: "/d", updated: "u", coverage: [] } },
    }],
    [{
      sessionId: "s1", createdAt: "x", notebookId: "n", scopeFingerprint: "f",
      enumerationCompleted: true,
      documents: { d1: { status: "pending", path: "/d", updated: "u", coverage: [["a", "b"]] } },
    }],
  ])("rejects malformed payload %#", raw => {
    expect(parseScopeSession(raw)).toBeUndefined();
  });
});
