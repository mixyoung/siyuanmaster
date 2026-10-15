import { describe, expect, it, vi } from "vitest";
import type * as kernel from "siyuan/kernel";
import { clonePolicy, DEFAULT_POLICY, normalizePolicy } from "../src/config";
import { CoverageCapacityError, CoverageStore, COVERAGE_STORAGE_KEY } from "../src/coverage-store";
import { AUDIT_STORAGE_KEY } from "../src/migration";
import { AuditStore } from "../src/audit";
import { PolicyStorage } from "../src/policy-storage";
import { documentComplete, scopeComplete, type ScopeMember } from "../src/scope-read";
import { computeContentHash } from "../src/write-transaction";

const NB = "20260101000000-notebok";
const DOC = "20260101000000-aaaaaaa";

function member(id: string, path: string, updated = "20261001000000"): ScopeMember {
  return { id, path, updated };
}

function makeApi(options: {
  stored?: Map<string, unknown>;
  failReads?: Set<string>;
  hangPuts?: Set<string>;
} = {}) {
  const current = options.stored ?? new Map<string, unknown>();
  const legacy = new Map<string, unknown>();
  const puts = vi.fn(async (key: string, value: string) => {
    if (options.hangPuts?.has(key)) {
      await new Promise(() => undefined);
    }
    current.set(key, JSON.parse(value));
  });
  const api = {
    storage: {
      get: vi.fn(async (key: string) => {
        if (options.failReads?.has(key) || !current.has(key)) {
          throw new Error(`read unavailable: ${key}`);
        }
        return { json: async () => structuredClone(current.get(key)) };
      }),
      put: puts,
      list: vi.fn(async () => [...current.keys()].map((name) => ({ name }))),
    },
    // Kernel file API contract: readDir lists one directory; getFile on a
    // missing legacy petal file answers 202 with a code-404 envelope.
    client: {
      fetch: vi.fn(async (endpoint: string, init: { body: string }) => {
        const target = (JSON.parse(init.body) as { path: string }).path;
        if (endpoint === "/api/file/readDir") {
          const dir = target.endsWith("/siyuanmaster") ? current : legacy;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ code: 0, data: [...dir.keys()].map((name) => ({ name })) }),
          };
        }
        const key = target.split("/").at(-1)!;
        if (!legacy.has(key)) {
          return { ok: true, status: 202, text: async () => JSON.stringify({ code: 404 }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(legacy.get(key)) };
      }),
    },
    rpc: { bind: vi.fn(async () => undefined), unbind: vi.fn(async () => undefined), broadcast: vi.fn(async () => undefined) },
    logger: { warn: vi.fn(async () => undefined), info: vi.fn(async () => undefined) },
  };
  return { api: api as unknown as kernel.ISiyuan, current, puts };
}

const hashOf = computeContentHash;

const members = [member(DOC, `/${DOC}.sy`)];

describe("coverage store", () => {
  it("starts empty on a confirmed-missing ledger and persists sessions", async () => {
    const { api, current } = makeApi();
    const store = new CoverageStore(api);
    const { session, resumed } = await store.openScope({
      notebookId: NB,
      rootDocumentId: null,
      scopeFingerprint: "f1",
      members,
    });
    expect(resumed).toBe(false);
    expect(session.documents[DOC]).toMatchObject({ status: "pending", coverage: [] });
    const stored = current.get(COVERAGE_STORAGE_KEY) as { sessions: unknown[] };
    expect(stored.sessions).toHaveLength(1);
  });

  it("records pages, tiles coverage, and derives completion", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    const { session } = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    const contentHash = await hashOf("x".repeat(30_000));
    store.recordReadPage({
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash, contentLength: 30_000, start: 0, end: 20_000,
    });
    store.recordReadPage({
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash, contentLength: 30_000, start: 20_000, end: 30_000,
    });
    const done = store.getSession(session.sessionId)!;
    expect(documentComplete(done.documents[DOC])).toBe(true);
  });

  it("a tail-only read leaves the document incomplete", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    const { session } = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    const contentHash = await hashOf("y".repeat(30_000));
    store.recordReadPage({
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash, contentLength: 30_000, start: 29_990, end: 30_000,
    });
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(false);
  });

  it("a hash change resets coverage so stale tiling cannot complete", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    const { session } = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    const hashA = await hashOf("a".repeat(30_000));
    const hashB = await hashOf("b".repeat(30_000));
    store.recordReadPage({
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash: hashA, contentLength: 30_000, start: 0, end: 30_000,
    });
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(true);
    // Edit lands; the agent restarts the document from offset 0 under a new hash.
    store.recordReadPage({
      sessionId: session.sessionId, documentId: DOC, updated: "20261002000000",
      contentHash: hashB, contentLength: 30_000, start: 0, end: 10_000,
    });
    const doc = store.getSession(session.sessionId)!.documents[DOC];
    expect(doc.coverage).toEqual([[0, 10_000]]);
    expect(documentComplete(doc)).toBe(false);
  });

  it("resumes an unchanged scope and re-verifies completed documents on resync", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    const contentHash = await hashOf("z".repeat(100));
    const opened = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    store.recordReadPage({
      sessionId: opened.session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash, contentLength: 100, start: 0, end: 100,
    });
    const resumed = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.sessionId).toBe(opened.session.sessionId);
    // Document edited after completion: resync demotes it to changed.
    const resynced = await store.resyncSession(opened.session.sessionId, [
      member(DOC, `/${DOC}.sy`, "20261005000000"),
    ]);
    expect(resynced.documents[DOC].status).toBe("changed");
    expect(resynced.documents[DOC].coverage).toEqual([]);
  });

  it("rejects sessions beyond capacity with an explicit error", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    for (let i = 0; i < 4; i += 1) {
      await store.openScope({
        notebookId: NB, rootDocumentId: null, scopeFingerprint: `f${i}`, members,
      });
    }
    await expect(
      store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f9", members }),
    ).rejects.toBeInstanceOf(CoverageCapacityError);
  });

  it("fails an open loudly when persistence fails", async () => {
    const failing = makeApi();
    failing.api.storage.put = vi.fn(async () => {
      throw new Error("disk full");
    }) as never;
    const store = new CoverageStore(failing.api);
    await expect(
      store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members }),
    ).rejects.toThrow(/disk full|policy/i);
  });

  it("flags persistDegraded on a later write failure without failing the read", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    const { session } = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    const contentHash = await hashOf("x".repeat(100));
    api.storage.put = vi.fn(async () => {
      throw new Error("disk full mid-session");
    }) as never;
    expect(() =>
      store.recordReadPage({
        sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
        contentHash, contentLength: 100, start: 0, end: 100,
      }),
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    const stored = store.getSession(session.sessionId)!;
    expect(documentComplete(stored.documents[DOC])).toBe(true);
    expect(stored.persistDegraded).toBe(true);
    expect(scopeComplete(stored)).toBe(false);
  });

  it("a hung coverage write never blocks a policy save on the same storage", async () => {
    const { api } = makeApi({ hangPuts: new Set([COVERAGE_STORAGE_KEY]) });
    const store = new CoverageStore(api);
    const policyStorage = new PolicyStorage(api, () => undefined);
    const policy = normalizePolicy({
      ...clonePolicy(DEFAULT_POLICY),
      access: { ...DEFAULT_POLICY.access, selectedNotebookIds: [NB] },
    });
    // Coverage lane: an open whose persist hangs forever.
    void store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    // Policy lane: the save must still complete within its own deadline.
    const reply = await policyStorage.save(policy);
    expect(reply.ready).toBe(true);
    expect(reply.saveState).toBe("saved");
  });

  it("a hung audit write never blocks a policy save and degrades at its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const { api } = makeApi({ hangPuts: new Set([AUDIT_STORAGE_KEY]) });
      const audit = new AuditStore(api, () =>
        normalizePolicy({ ...clonePolicy(DEFAULT_POLICY), audit: { ...DEFAULT_POLICY.audit, enabled: true, recordReadOperations: true } }),
      );
      const policyStorage = new PolicyStorage(api, () => undefined);
      const policy = normalizePolicy({
        ...clonePolicy(DEFAULT_POLICY),
        access: { ...DEFAULT_POLICY.access, selectedNotebookIds: [NB] },
      });
      // Audit lane hangs on its put; the policy save on its own lane must not care.
      const record = audit.record({ operation: "read", outcome: "allowed" }, true);
      const reply = await policyStorage.save(policy);
      expect(reply.ready).toBe(true);
      expect(reply.saveState).toBe("saved");
      // The audited caller is released at the audit lane's own deadline,
      // degraded, instead of being failed by the hung write.
      await vi.advanceTimersByTimeAsync(5_200);
      await record;
      expect(audit.writeFailureCount).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to overwrite a corrupt ledger and surfaces a load error", async () => {
    const { api } = makeApi({
      stored: new Map([[COVERAGE_STORAGE_KEY, { schemaVersion: 1, sessions: [{ broken: true }] }]]),
    });
    const store = new CoverageStore(api);
    await expect(
      store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members }),
    ).rejects.toThrow(/invalid|unreadable/);
    expect(store.loadErrorState()).toMatch(/invalid/);
  });
});

describe("coverage store concurrency", () => {
  it("serializes concurrent page records without losing intervals", async () => {
    const { api } = makeApi();
    const store = new CoverageStore(api);
    const { session } = await store.openScope({
      notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members,
    });
    const contentHash = await hashOf("c".repeat(10_000));
    const record = (start: number, end: number) =>
      store.recordReadPage({
        sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
        contentHash, contentLength: 10_000, start, end,
      });
    // Interleave interval writes from disjoint pages.
    record(0, 3_000);
    record(6_000, 9_000);
    record(3_000, 6_000);
    record(9_000, 10_000);
    await new Promise((resolve) => setImmediate(resolve));
    const doc = store.getSession(session.sessionId)!.documents[DOC];
    expect(doc.coverage).toEqual([[0, 10_000]]);
    expect(documentComplete(doc)).toBe(true);
  });
});
