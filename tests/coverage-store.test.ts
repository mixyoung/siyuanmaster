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

function member(id: string, path: string, updated = "20261001000000", contentMark = "1:20261001000000"): ScopeMember {
  return { id, path, updated, contentMark };
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

async function receive(store: CoverageStore, input: Parameters<CoverageStore["recordReadPage"]>[0]) {
  const receipt = await store.recordReadPage(input);
  await store.acknowledge(input.sessionId, [receipt.receiptId]);
}

const hashOf = computeContentHash;

const members = [member(DOC, `/${DOC}.sy`)];

describe("coverage store", () => {
  it("accepts host JSON readback that reorders object keys recursively", async () => {
    const { api } = makeApi();
    const originalGet = api.storage.get.bind(api.storage);
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) :
      value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    api.storage.get = vi.fn(async key => {
      const stored = await originalGet(key);
      return { json: async () => reorder(await stored.json()) };
    }) as never;
    const store = new CoverageStore(api);
    const { session } = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
    await receive(store, { sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("body"), contentLength: 4, start: 0, end: 4 });
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(true);
    expect(store.getSession(session.sessionId)!.persistDegraded).toBeUndefined();
  });
  it("expires inactive sessions and frees their active slots", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
      const { api } = makeApi(); const store = new CoverageStore(api);
      const opened = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
      vi.setSystemTime(new Date("2026-11-24T00:00:00Z"));
      const fresh = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
      expect(fresh.resumed).toBe(false);
      expect(store.getSession(opened.session.sessionId)?.state).toBe("expired");
    } finally { vi.useRealTimers(); }
  });

  it("invalidates an in-flight verification when new read progress arrives", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const { session } = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
    const input = { sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("a"), contentLength: 1, start: 0, end: 1 };
    await receive(store, input);
    const batch = await store.beginVerification(session.sessionId);
    await store.recordReadPage(input);
    await expect(store.finishVerificationBatch(session.sessionId, batch.token, [{ documentId: DOC, contentHash: input.contentHash, contentLength: 1 }])).rejects.toThrow("changed during verification");
    expect(scopeComplete(store.getSession(session.sessionId)!)).toBe(false);
  });
  it("prunes closed history at the stored limit without dropping active work", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const active = (await store.openScope({ notebookId: NB, rootDocumentId: "active-root", scopeFingerprint: "active", members })).session;
    for (let i = 0; i < 15; i++) {
      const { session } = await store.openScope({ notebookId: NB, rootDocumentId: `old-${i}`, scopeFingerprint: `f${i}`, members });
      await store.close(session.sessionId);
    }
    expect(store.snapshot()).toHaveLength(12);
    expect(store.getSession(active.sessionId)?.state).toBe("active");
    expect(store.getSession(active.sessionId)?.documents).toEqual(active.documents);
  });
  it("rejects stale receipts and makes a mixed valid/invalid acknowledgement atomic", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const { session } = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
    const input = { sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("a"), contentLength: 1, start: 0, end: 1 };
    const a = await store.recordReadPage(input);
    await expect(store.acknowledge(session.sessionId, [a.receiptId, "forged"])).rejects.toThrow("receipt");
    expect(store.getSession(session.sessionId)!.documents[DOC].coverage).toEqual([]);
    await store.recordReadPage({ ...input, contentHash: await hashOf("b") });
    await expect(store.acknowledge(session.sessionId, [a.receiptId])).rejects.toThrow("receipt");
  });

  it("requires acknowledgement even for an empty document", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const { session } = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
    const receipt = await store.recordReadPage({ sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf(""), contentLength: 0, start: 0, end: 0 });
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(false);
    await store.acknowledge(session.sessionId, [receipt.receiptId]);
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(true);
  });

  it("does not turn completed history into active-capacity exhaustion on restart", async () => {
    const { api } = makeApi(); let store = new CoverageStore(api);
    const hash = await hashOf("a");
    for (let i = 0; i < 6; i++) {
      const { session } = await store.openScope({ notebookId: NB, rootDocumentId: `root-${i}`, scopeFingerprint: `f${i}`, members });
      await receive(store, { sessionId: session.sessionId, documentId: DOC, updated: members[0].updated, contentHash: hash, contentLength: 1, start: 0, end: 1 });
      const batch = await store.beginVerification(session.sessionId);
      await store.finishVerificationBatch(session.sessionId, batch.token, [{ documentId: DOC, contentHash: hash, contentLength: 1 }]);
    }
    store = new CoverageStore(api);
    const opened = await store.openScope({ notebookId: NB, rootDocumentId: "new-root", scopeFingerprint: "new", members });
    expect(opened.resumed).toBe(false);
    expect(store.snapshot().filter(session => session.completedAt)).toHaveLength(6);
  });

  it("rejects fulfilled writes whose readback does not contain the progress", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const { session } = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
    api.storage.put = vi.fn(async () => undefined) as never;
    await expect(store.recordReadPage({ sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("body"), contentLength: 4, start: 0, end: 4 })).rejects.toThrow("readback mismatch");
    expect(store.getSession(session.sessionId)!.persistDegraded).toBe(true);
  });
  it("does not count an exported but unacknowledged page as received", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const { session } = await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members });
    const receipt = await store.recordReadPage({ sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("body"), contentLength: 4, start: 0, end: 4 });
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(false);
    await store.acknowledge(session.sessionId, [receipt.receiptId]);
    await store.acknowledge(session.sessionId, [receipt.receiptId]);
    expect(store.getSession(session.sessionId)!.documents[DOC].coverage).toEqual([[0, 4]]);
    expect(scopeComplete(store.getSession(session.sessionId)!)).toBe(false); // Still needs a fresh hash check.
  });

  it("preserves acknowledged progress and contentMark across restart but requires fresh verification", async () => {
    const { api } = makeApi(); let store = new CoverageStore(api);
    const input = { notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members };
    const { session } = await store.openScope(input);
    await receive(store, { sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("body"), contentLength: 4, start: 0, end: 4 });
    store = new CoverageStore(api);
    const resumed = await store.openScope(input);
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.documents[DOC].contentMark).toBe(members[0].contentMark);
    expect(documentComplete(resumed.session.documents[DOC])).toBe(true);
    expect(scopeComplete(resumed.session)).toBe(false);
  });

  it("migrates v1 server coverage without forging receiver confirmation", async () => {
    const { api, current } = makeApi(); const store = new CoverageStore(api);
    const input = { notebookId: NB, rootDocumentId: null, scopeFingerprint: "f1", members };
    const { session } = await store.openScope(input);
    await receive(store, { sessionId: session.sessionId, documentId: DOC, updated: members[0].updated,
      contentHash: await hashOf("body"), contentLength: 4, start: 0, end: 4 });
    (current.get(COVERAGE_STORAGE_KEY) as { schemaVersion: number }).schemaVersion = 1;
    const recovered = await new CoverageStore(api).openScope(input);
    expect(recovered.session.documents[DOC].coverage).toEqual([]);
    expect(recovered.session.documents[DOC].servedCoverage).toEqual([[0, 4]]);
    expect(documentComplete(recovered.session.documents[DOC])).toBe(false);
  });

  it("reopening changed membership supersedes abandoned snapshots instead of exhausting capacity", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    for (let i = 0; i < 8; i++) await store.openScope({ notebookId: NB, rootDocumentId: null, scopeFingerprint: `f${i}`, members });
    expect(store.snapshot().filter(session => session.state === "active")).toHaveLength(1);
    expect(store.snapshot().filter(session => session.state === "superseded")).toHaveLength(7);
  });

  it("explicit close frees a slot and retains other active work", async () => {
    const { api } = makeApi(); const store = new CoverageStore(api);
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push((await store.openScope({ notebookId: NB, rootDocumentId: `root-${i}`, scopeFingerprint: `f${i}`, members })).session);
    await store.close(sessions[0].sessionId);
    await store.openScope({ notebookId: NB, rootDocumentId: "new-root", scopeFingerprint: "f5", members });
    expect(store.getSession(sessions[0].sessionId)?.state).toBe("closed");
    expect(store.snapshot().filter(session => session.state === "active")).toHaveLength(4);
    expect(store.getSession(sessions[1].sessionId)?.documents[DOC]).toEqual(sessions[1].documents[DOC]);
  });
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
    await receive(store, {
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash, contentLength: 30_000, start: 0, end: 20_000,
    });
    await receive(store, {
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
    await receive(store, {
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
    await receive(store, {
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash: hashA, contentLength: 30_000, start: 0, end: 30_000,
    });
    expect(documentComplete(store.getSession(session.sessionId)!.documents[DOC])).toBe(true);
    // Edit lands; the agent restarts the document from offset 0 under a new hash.
    await receive(store, {
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
    await receive(store, {
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
        notebookId: NB, rootDocumentId: `root-${i}`, scopeFingerprint: `f${i}`, members,
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
    await expect(store.recordReadPage({
      sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
      contentHash, contentLength: 100, start: 0, end: 100,
    })).rejects.toThrow("disk full");
    const stored = store.getSession(session.sessionId)!;
    expect(documentComplete(stored.documents[DOC])).toBe(false);
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
    const record = async (start: number, end: number) =>
      await receive(store, {
        sessionId: session.sessionId, documentId: DOC, updated: "20261001000000",
        contentHash, contentLength: 10_000, start, end,
      });
    // Interleave interval writes from disjoint pages.
    await Promise.all([record(0, 3_000), record(6_000, 9_000), record(3_000, 6_000), record(9_000, 10_000)]);
    await new Promise((resolve) => setImmediate(resolve));
    const doc = store.getSession(session.sessionId)!.documents[DOC];
    expect(doc.coverage).toEqual([[0, 10_000]]);
    expect(documentComplete(doc)).toBe(true);
  });
});
