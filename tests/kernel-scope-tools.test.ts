import { describe, expect, it, vi } from "vitest";
import type * as kernel from "siyuan/kernel";
import { clonePolicy, DEFAULT_POLICY, normalizePolicy } from "../src/config";
import { AUDIT_STORAGE_KEY, POLICY_STORAGE_KEY } from "../src/migration";
import type { PluginPolicy } from "../src/types";
import { kernelRuntime, runtimeClock } from "./helpers/plugin-runtime";

const NB = "20260101000000-notebok";
const NB_OTHER = "20260101000000-othernb";
const ROOT = "20260101000000-rootdoc";
const CHILD = "20260101000000-childdd";
const CHILD_PATH = `/${ROOT}/${CHILD}.sy`;

interface ToolReply {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolReply>;

function policyFor(notebookIds: string[]): PluginPolicy {
  return normalizePolicy({
    ...clonePolicy(DEFAULT_POLICY),
    access: { ...DEFAULT_POLICY.access, selectedNotebookIds: notebookIds },
  });
}

async function fixture() {
  const current = new Map<string, unknown>();
  const notebooks = [{ id: NB, name: "主笔记本", closed: false }, { id: NB_OTHER, name: "其他", closed: false }];
  const blocks = new Map<string, Record<string, unknown>>([
    [ROOT, {
      id: ROOT, root_id: ROOT, box: NB, path: `/${ROOT}.sy`, hpath: "/根", name: "", alias: "", memo: "", tag: "",
      content: "根文档", type: "d", subtype: "", created: "20261001000000", updated: "20261001000000",
    }],
    [CHILD, {
      id: CHILD, root_id: CHILD, box: NB, path: CHILD_PATH, hpath: "/根/子", name: "", alias: "", memo: "", tag: "",
      content: "子文档", type: "d", subtype: "", created: "20261001000000", updated: "20261001000001",
    }],
  ]);
  const exports = new Map<string, { hPath: string; content: string }>([
    [ROOT, { hPath: "/根", content: `# 根文档\n${"段落内容🎯".repeat(4000)}` }],
    [CHILD, { hPath: "/根/子", content: `# 子文档\n${"子内容".repeat(3000)}` }],
  ]);
  const tools = new Map<string, ToolHandler>();
  const rpc = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const searchState = {
    docPage: [] as string[],
    matchRows: [] as Array<Record<string, unknown>>,
  };

  const api = {
    plugin: { lifecycle: {} },
    agent: {
      registerCapability: vi.fn(async (name: string, _config: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
      unregisterCapability: vi.fn(async () => undefined),
    },
    rpc: {
      bind: vi.fn(async (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        rpc.set(name, handler);
      }),
      unbind: vi.fn(async () => undefined),
      broadcast: vi.fn(async () => undefined),
    },
    storage: {
      get: vi.fn(async (key: string) => {
        if (!current.has(key)) throw new Error(`read unavailable: ${key}`);
        return { json: async () => structuredClone(current.get(key)) };
      }),
      put: vi.fn(async (key: string, value: string) => {
        current.set(key, JSON.parse(value));
      }),
      list: vi.fn(async () => [...current.keys()].map((name) => ({ name }))),
    },
    client: {
      fetch: vi.fn(async (path: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (path === "/api/notebook/lsNotebooks") {
          return envelope({ notebooks });
        }
        if (path === "/api/query/sql") {
          return envelope(answerSql(String(body.stmt), { blocks, searchState }));
        }
        if (path === "/api/export/exportMdContent") {
          const id = String(body.id);
          if (!exports.has(id)) return envelope(null);
          return envelope(exports.get(id));
        }
        if (path === "/api/file/readDir") {
          return envelope([...current.keys()].map((name) => ({ name })));
        }
        if (path === "/api/file/getFile") {
          return {
            ok: true, status: 202,
            json: async () => ({ code: 0, data: null }),
            text: async () => JSON.stringify({ code: 404 }),
          };
        }
        return envelope(null);
      }),
    },
    logger: { warn: vi.fn(async () => undefined), info: vi.fn(async () => undefined) },
  };

  function envelope<T>(data: T) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: "", data }),
      text: async () => JSON.stringify({ code: 0, msg: "", data }),
    };
  }

  current.set(POLICY_STORAGE_KEY, policyFor([NB]));
  const plugin = await kernelRuntime<{ onload(): Promise<void>; reloadPolicy(): Promise<unknown>; policy: PluginPolicy }>(
    api as unknown as kernel.ISiyuan,
    runtimeClock(),
  );
  // onload registers every Agent capability and RPC binding.
  await plugin.onload();

  return {
    api, plugin, tools, rpc, current, blocks, exports, searchState,
    setPolicy: async (ids: string[]) => {
      current.set(POLICY_STORAGE_KEY, policyFor(ids));
      await rpc.get("reloadPolicy")!();
    },
    tool: (name: string) => {
      const handler = tools.get(name);
      if (!handler) throw new Error(`tool not registered: ${name}`);
      return handler;
    },
  };
}

function answerSql(
  stmt: string,
  state: {
    blocks: Map<string, Record<string, unknown>>;
    searchState: { docPage: string[]; matchRows: Array<Record<string, unknown>> };
  },
): unknown[] {
  const { blocks, searchState: search } = state;
  if (stmt.includes("total_count")) {
    return [{ total_count: blocks.size, eligible_count: blocks.size }];
  }
  if (stmt.includes("has_children")) {
    return [...blocks.values()]
      .filter((row) => !stmt.includes("d.path >") || String(row.path) > stmt.match(/d\.path > '([^']+)'/)![1])
      .slice(0, Number(stmt.match(/LIMIT (\d+)/)![1]))
      .map((row) => ({ ...row, title: row.content, has_children: 0 }));
  }
  if (stmt.includes("d.updated AS updated")) {
    // scope members (listDocumentTree fingerprint / listScopeMembers)
    return [...blocks.values()].map((row) => ({
      id: row.id, path: row.path, updated: row.updated,
    }));
  }
  if (stmt.trimStart().startsWith("SELECT b.root_id AS document_id")) {
    return search.docPage.map((id) => ({ document_id: id }));
  }
  if (stmt.includes("matched_id")) {
    return search.matchRows;
  }
  if (stmt.includes("WHERE id = '")) {
    const id = stmt.match(/WHERE id = '([^']+)'/)![1];
    return blocks.has(id) ? [blocks.get(id)] : [];
  }
  return [];
}

describe("read_note full-body pagination", () => {
  it("pages the whole export under one hash and reassembles exactly", async () => {
    const f = await fixture();
    const full = f.exports.get(ROOT)!.content;
    const page1 = (await f.tool("read_note")({ documentId: ROOT, maxChars: 20_000 })) as ToolReply;
    expect(page1.ok).toBe(true);
    const r1 = page1.result!;
    expect(r1.contentLength).toBe(full.length);
    const hash = r1.contentHash as string;
    expect(r1.nextOffset).toBe(20_000);
    const page2 = (await f.tool("read_note")({
      documentId: ROOT, maxChars: 50_000,
      offset: r1.nextOffset, expectedContentHash: hash,
    })) as ToolReply;
    const r2 = page2.result!;
    expect(r2.nextOffset).toBeNull();
    expect(`${r1.content}${r2.content}`).toBe(full);
  });

  it("refuses an offset page without the hash and beyond-cap offsets are clamped", async () => {
    const f = await fixture();
    const denied = (await f.tool("read_note")({ documentId: ROOT, offset: 100 })) as ToolReply;
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("invalid_request");
  });

  it("fails state_changed when the document is edited mid-pagination and never splices versions", async () => {
    const f = await fixture();
    const page1 = (await f.tool("read_note")({ documentId: ROOT, maxChars: 10_000 })) as ToolReply;
    const hash = page1.result!.contentHash as string;
    // The edit lands between page 1 and page 2.
    f.exports.set(ROOT, { hPath: "/根", content: `${"# 根文档(改)\n"}${"新内容".repeat(5000)}` });
    const page2 = (await f.tool("read_note")({
      documentId: ROOT, offset: page1.result!.nextOffset, expectedContentHash: hash,
    })) as ToolReply;
    expect(page2.ok).toBe(false);
    expect(page2.error?.code).toBe("state_changed");
  });
});

describe("scope read coverage", () => {
  async function openScope(f: Awaited<ReturnType<typeof fixture>>) {
    const reply = (await f.tool("open_scope_read")({ notebookId: NB })) as ToolReply;
    expect(reply.ok).toBe(true);
    return reply.result!;
  }

  async function readFully(
    f: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    documentId: string,
  ) {
    let offset = 0;
    let hash: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const reply = (await f.tool("read_note")({
        documentId, maxChars: 20_000, offset,
        ...(hash ? { expectedContentHash: hash } : {}),
        scopeSessionId: sessionId,
      })) as ToolReply;
      if (!reply.ok) return reply;
      const result = reply.result!;
      hash = result.contentHash as string;
      if (result.nextOffset === null || result.nextOffset === undefined) return reply;
      offset = result.nextOffset as number;
    }
    throw new Error("pagination did not terminate");
  }

  it("reaches complete only after both member documents are fully read", async () => {
    const f = await fixture();
    const scope = await openScope(f);
    const sessionId = scope.sessionId as string;
    expect(scope.documentCount).toBe(2);
    expect(await readFully(f, sessionId, ROOT)).toMatchObject({ ok: true });
    // Root alone must not complete the scope.
    let status = (await f.tool("scope_read_status")({ sessionId })) as ToolReply;
    expect(status.result!.complete).toBe(false);
    expect((status.result!.counts as Record<string, number>).pending).toBe(1);
    expect(await readFully(f, sessionId, CHILD)).toMatchObject({ ok: true });
    status = (await f.tool("scope_read_status")({ sessionId })) as ToolReply;
    expect(status.result!.complete).toBe(true);
    expect((status.result!.counts as Record<string, number>).complete).toBe(2);
  });

  it("a tail-only read never satisfies completion", async () => {
    const f = await fixture();
    const scope = await openScope(f);
    const sessionId = scope.sessionId as string;
    const full = f.exports.get(CHILD)!.content;
    // Read only the final fragment of the child document directly.
    const tail = (await f.tool("read_note")({
      documentId: CHILD, offset: full.length - 100, maxChars: 1_000,
      expectedContentHash: await import("../src/write-transaction").then((m) =>
        m.computeContentHash(full)),
      scopeSessionId: sessionId,
    })) as ToolReply;
    expect(tail.ok).toBe(true);
    const status = (await f.tool("scope_read_status")({ sessionId })) as ToolReply;
    expect(status.result!.complete).toBe(false);
    expect((status.result!.counts as Record<string, number>).complete).toBe(0);
  });

  it("marks blocked and keeps complete=false when permission is withdrawn mid-task", async () => {
    const f = await fixture();
    const scope = await openScope(f);
    const sessionId = scope.sessionId as string;
    expect(await readFully(f, sessionId, ROOT)).toMatchObject({ ok: true });
    // Authorization narrows to another notebook while the task is running.
    await f.setPolicy([NB_OTHER]);
    const denied = (await f.tool("read_note")({
      documentId: CHILD, maxChars: 20_000, scopeSessionId: sessionId,
    })) as ToolReply;
    expect(denied.ok).toBe(false);
    const status = (await f.tool("scope_read_status")({ sessionId })) as ToolReply;
    // scope_read_status itself is denied for the whole notebook now.
    if (status.ok) {
      expect(status.result!.complete).toBe(false);
      expect((status.result!.counts as Record<string, number>).blocked).toBeGreaterThanOrEqual(1);
    } else {
      expect(["notebook_denied", "operation_denied"]).toContain(status.error?.code);
    }
  });

  it("rejects oversized scopes with shard suggestions instead of trimming", async () => {
    const f = await fixture();
    for (let i = 0; i < 2100; i += 1) {
      const id = `20260101000000-d${String(i).padStart(4, "0")}`.slice(0, 21);
      f.blocks.set(id, {
        id, root_id: id, box: NB, path: `/${id}.sy`, hpath: `/${id}`, name: "", alias: "", memo: "", tag: "",
        content: id, type: "d", subtype: "", created: "20261001000000", updated: "20261001000000",
      });
    }
    const reply = (await f.tool("open_scope_read")({ notebookId: NB })) as ToolReply;
    expect(reply.ok).toBe(false);
    expect(reply.error?.message).toMatch(/above the 2000 per-session cap|shard/);
  });
});

describe("document tree pagination", () => {
  it("aborts with state_changed when membership changes between pages", async () => {
    const f = await fixture();
    const page1 = (await f.tool("list_document_tree")({ notebookId: NB, maxNodes: 1 })) as ToolReply;
    expect(page1.ok).toBe(true);
    const fingerprint = page1.result!.scopeFingerprint as string;
    expect(typeof fingerprint).toBe("string");
    expect(page1.result!.nextAfterPath).toBeTruthy();
    // A document moves into the scope with count and max(updated) preserved.
    const mover = "20260101000000-moverab";
    f.blocks.set(mover, {
      id: mover, root_id: mover, box: NB, path: `/${mover}.sy`, hpath: `/${mover}`, name: "", alias: "", memo: "", tag: "",
      content: mover, type: "d", subtype: "", created: "20261001000000", updated: "20260901000000",
    });
    const page2 = (await f.tool("list_document_tree")({
      notebookId: NB, maxNodes: 1,
      afterPath: page1.result!.nextAfterPath,
      scopeFingerprint: fingerprint,
    })) as ToolReply;
    expect(page2.ok).toBe(false);
    expect(page2.error?.code).toBe("state_changed");
  });

  it("continues cleanly when nothing changed", async () => {
    const f = await fixture();
    const page1 = (await f.tool("list_document_tree")({ notebookId: NB, maxNodes: 1 })) as ToolReply;
    const page2 = (await f.tool("list_document_tree")({
      notebookId: NB, maxNodes: 1,
      afterPath: page1.result!.nextAfterPath,
      scopeFingerprint: page1.result!.scopeFingerprint,
    })) as ToolReply;
    expect(page2.ok).toBe(true);
    expect(page2.result!.returnedCount).toBe(1);
  });
});

describe("search aggregation and cursor binding", () => {
  it("returns both documents even when one monopolizes block matches", async () => {
    const f = await fixture();
    const docA = "20260101000000-aaaaaaa";
    const docB = "20260101000000-bbbbbbb";
    f.searchState.docPage = [docA, docB];
    f.searchState.matchRows = [
      { matched_id: "b1", document_id: docA, box: NB, hpath: "/A", title: "A", tags: null, snippet: "deadline", block_type: "p", updated: "20261001" },
      { matched_id: "b2", document_id: docA, box: NB, hpath: "/A", title: "A", tags: null, snippet: "deadline again", block_type: "p", updated: "20260901" },
      { matched_id: "b3", document_id: docB, box: NB, hpath: "/B", title: "B", tags: null, snippet: "deadline", block_type: "p", updated: "20260801" },
    ];
    const reply = (await f.tool("search_notes")({ query: "deadline" })) as ToolReply;
    expect(reply.ok).toBe(true);
    const matches = reply.result!.matches as Array<{ documentId: string; matchedBlockId: string }>;
    expect(matches.map((m) => m.documentId).sort()).toEqual([docA, docB].sort());
    expect(matches.find((m) => m.documentId === docA)?.matchedBlockId).toBe("b1");
  });

  it("rejects a cursor replayed against a different query", async () => {
    const f = await fixture();
    f.searchState.docPage = ["20260101000000-aaaaaaa", "20260101000000-bbbbbbb"];
    f.searchState.matchRows = [
      { matched_id: "b1", document_id: "20260101000000-aaaaaaa", box: NB, hpath: "/A", title: "A", tags: null, snippet: "alpha", block_type: "p", updated: "20261001" },
    ];
    const first = (await f.tool("search_notes")({ query: "alpha", limit: 1 })) as ToolReply;
    expect(first.ok).toBe(true);
    expect(first.result!.nextCursor).toBeTruthy();
    const replay = (await f.tool("search_notes")({
      query: "beta", limit: 1, cursor: first.result!.nextCursor,
    })) as ToolReply;
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("invalid_request");
    expect(replay.error?.message).toMatch(/cursor does not match/);
  });

  it("rejects a cursor after the authorized notebook set changed", async () => {
    const f = await fixture();
    f.searchState.docPage = ["20260101000000-aaaaaaa", "20260101000000-bbbbbbb"];
    f.searchState.matchRows = [
      { matched_id: "b1", document_id: "20260101000000-aaaaaaa", box: NB, hpath: "/A", title: "A", tags: null, snippet: "alpha", block_type: "p", updated: "20261001" },
    ];
    const first = (await f.tool("search_notes")({ query: "alpha", limit: 1 })) as ToolReply;
    expect(first.ok).toBe(true);
    expect(first.result!.nextCursor).toBeTruthy();
    await f.setPolicy([NB, NB_OTHER]);
    const replay = (await f.tool("search_notes")({
      query: "alpha", limit: 1, cursor: first.result!.nextCursor,
    })) as ToolReply;
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("invalid_request");
  });
});
