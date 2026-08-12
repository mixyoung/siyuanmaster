import { describe, expect, it } from "vitest";
import {
  emptyKnowledgeRegistry,
  findWikiCandidates,
  KnowledgeRegistryError,
  KnowledgeRegistryStore,
  KNOWLEDGE_REGISTRY_STORAGE_KEY,
  normalizeKnowledgeRegistry,
  refreshAccessibleKnowledgeRegistry,
  summarizeKnowledgeRegistry,
  type KnowledgeRegistry,
  type KnowledgeRegistryStorage,
  type RegisterAuthorityInput,
  type RegisterSourceInput,
} from "../src/knowledge-registry";

class MemoryStorage implements KnowledgeRegistryStorage {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<{ json(): Promise<unknown> }> {
    if (!this.values.has(key)) {
      throw new Error("missing");
    }
    const value = this.values.get(key)!;
    return { json: async () => JSON.parse(value) };
  }

  async put(key: string, content: string): Promise<void> {
    this.values.set(key, content);
  }

  raw(key = KNOWLEDGE_REGISTRY_STORAGE_KEY): string | undefined {
    return this.values.get(key);
  }
}

let sequence = 0;
function clock(): string {
  sequence += 1;
  return new Date(sequence * 1_000).toISOString();
}

function source(
  overrides: Partial<RegisterSourceInput> = {},
): RegisterSourceInput {
  return {
    sourceId: "source:one",
    documentId: "20260812000001-aaaaaaa",
    notebookId: "20260812000000-nb00001",
    title: "Raw Source One",
    hPath: "/Topic-raw/Raw Source One",
    state: "registered",
    accessibleDocumentIds: ["20260812000001-aaaaaaa"],
    ...overrides,
  };
}

function authority(
  overrides: Partial<RegisterAuthorityInput> = {},
): RegisterAuthorityInput {
  return {
    documentId: "20260812000002-bbbbbbb",
    notebookId: "20260812000000-nb00001",
    title: "Agent Memory",
    hPath: "/AI/Agent Memory",
    aliases: ["Memory System", "智能体记忆"],
    pageType: "concept",
    knowledgeRole: "synthesis",
    accessibleDocumentIds: [
      "20260812000001-aaaaaaa",
      "20260812000002-bbbbbbb",
    ],
    ...overrides,
  };
}

async function linkedRegistry(): Promise<KnowledgeRegistry> {
  const storage = new MemoryStorage();
  const store = new KnowledgeRegistryStore(storage, clock);
  await store.registerSource(source());
  await store.registerAuthority(
    authority({ sourceIds: ["source:one"] }),
  );
  return store.snapshot();
}

describe("KnowledgeRegistryStore", () => {
  it("fails closed to an empty registry when storage is unavailable", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await expect(store.snapshot()).resolves.toEqual(
      emptyKnowledgeRegistry(),
    );
  });

  it("registers a source without storing note content", async () => {
    const storage = new MemoryStorage();
    const store = new KnowledgeRegistryStore(storage, clock);
    const result = await store.registerSource(
      source({
        sha256: "a".repeat(64),
        canonicalUrl: "https://example.com/paper",
        operationId: "ingest-1",
      }),
    );
    expect(result.created).toBe(true);
    expect(result.record.state).toBe("registered");
    expect(storage.raw()).not.toContain("markdown");
    expect(storage.raw()).not.toContain("content");
  });

  it("serializes concurrent writes without losing records", async () => {
    const storage = new MemoryStorage();
    const store = new KnowledgeRegistryStore(storage, clock);
    await Promise.all([
      store.registerSource(source()),
      store.registerSource(
        source({
          sourceId: "source:two",
          documentId: "20260812000003-ccccccc",
          title: "Raw Source Two",
          hPath: "/Topic-raw/Raw Source Two",
        }),
      ),
    ]);
    const snapshot = await store.snapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.sources.map((item) => item.sourceId).sort()).toEqual([
      "source:one",
      "source:two",
    ]);
  });

  it("deduplicates by hash and retains the first canonical document", async () => {
    const storage = new MemoryStorage();
    const store = new KnowledgeRegistryStore(storage, clock);
    await store.registerSource(source({ sha256: "b".repeat(64) }));
    const duplicate = await store.registerSource(
      source({
        sourceId: "source:duplicate",
        documentId: "20260812000004-ddddddd",
        title: "Duplicate",
        hPath: "/Duplicate",
        sha256: "b".repeat(64),
      }),
    );
    expect(duplicate.created).toBe(false);
    expect(duplicate.deduplicatedBy).toBe("sha256");
    expect(duplicate.record.sourceId).toBe("source:one");
    expect((await store.snapshot()).sources).toHaveLength(1);
  });

  it("rejects remapping an existing source ID to another document", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await store.registerSource(source());
    await expect(
      store.registerSource(
        source({ documentId: "20260812000004-ddddddd" }),
      ),
    ).rejects.toMatchObject<Partial<KnowledgeRegistryError>>({
      code: "source_identity_conflict",
    });
  });

  it("does not mark a source ingested before an authority is linked", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await expect(
      store.registerSource(source({ state: "ingested" })),
    ).rejects.toMatchObject<Partial<KnowledgeRegistryError>>({
      code: "invalid_source_state",
    });
  });

  it("waits for queued writes before returning a snapshot", async () => {
    class DelayedStorage extends MemoryStorage {
      override async put(key: string, content: string): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return super.put(key, content);
      }
    }
    const store = new KnowledgeRegistryStore(new DelayedStorage(), clock);
    const pending = store.registerSource(source());
    const snapshot = await store.snapshot();
    await pending;
    expect(snapshot.sources.map((item) => item.sourceId)).toEqual([
      "source:one",
    ]);
  });

  it("fails closed when a future registry schema is present", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KNOWLEDGE_REGISTRY_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 2, revision: 9 }),
    );
    const store = new KnowledgeRegistryStore(storage, clock);
    await expect(store.snapshot()).rejects.toMatchObject<
      Partial<KnowledgeRegistryError>
    >({ code: "unsupported_schema" });
  });

  it("does not expose cross-boundary hash matches during scoped registration", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await store.registerSource(
      source({
        notebookId: "20260812000000-secret1",
        accessibleDocumentIds: ["20260812000001-aaaaaaa"],
        sha256: "c".repeat(64),
      }),
    );
    const result = await store.registerSource(
      source({
        sourceId: "source:public",
        documentId: "20260812000004-ddddddd",
        sha256: "c".repeat(64),
        accessibleDocumentIds: ["20260812000004-ddddddd"],
      }),
    );
    expect(result).toMatchObject({
      created: true,
      deduplicatedBy: undefined,
      record: { sourceId: "source:public" },
    });
    expect((await store.snapshot()).sources).toHaveLength(2);
  });

  it("links sources and authorities bidirectionally", async () => {
    const registry = await linkedRegistry();
    expect(registry.sources[0].authorityDocumentIds).toEqual([
      "20260812000002-bbbbbbb",
    ]);
    expect(registry.authorities[0].sourceIds).toEqual(["source:one"]);
  });

  it("rejects links to missing sources", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await expect(
      store.registerAuthority(
        authority({ sourceIds: ["source:missing"] }),
      ),
    ).rejects.toMatchObject<Partial<KnowledgeRegistryError>>({
      code: "source_reference_missing",
    });
  });

  it("rejects using one document as both Raw source and Wiki authority", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await store.registerSource(source());
    await expect(
      store.registerAuthority(
        authority({
          documentId: "20260812000001-aaaaaaa",
          hPath: "/Topic-raw/Raw Source One",
          sourceIds: [],
        }),
      ),
    ).rejects.toMatchObject<Partial<KnowledgeRegistryError>>({
      code: "invalid_role_overlap",
    });
  });

  it("does not remove the final authority from an ingested source", async () => {
    const storage = new MemoryStorage();
    const store = new KnowledgeRegistryStore(storage, clock);
    await store.registerSource(source());
    await store.registerAuthority(
      authority({ sourceIds: ["source:one"] }),
    );
    await store.registerSource(
      source({
        state: "ingested",
        authorityDocumentIds: ["20260812000002-bbbbbbb"],
        accessibleDocumentIds: [
          "20260812000001-aaaaaaa",
          "20260812000002-bbbbbbb",
        ],
      }),
    );
    await expect(
      store.registerAuthority(authority({ sourceIds: [] })),
    ).rejects.toMatchObject<Partial<KnowledgeRegistryError>>({
      code: "invalid_source_state",
    });
  });

  it("reports competing authorities without silently merging them", async () => {
    const store = new KnowledgeRegistryStore(new MemoryStorage(), clock);
    await store.registerAuthority(authority());
    const result = await store.registerAuthority(
      authority({
        documentId: "20260812000005-eeeeeee",
        title: "智能体记忆",
        hPath: "/Research/智能体记忆",
        aliases: [],
      }),
    );
    expect(result.created).toBe(true);
    expect(result.competingAuthorityDocumentIds).toEqual([
      "20260812000002-bbbbbbb",
    ]);
    expect((await store.snapshot()).authorities).toHaveLength(2);
  });
});

describe("knowledge registry normalization and queries", () => {
  it("drops malformed records, duplicate IDs, and dangling links", () => {
    const normalized = normalizeKnowledgeRegistry({
      schemaVersion: 999,
      revision: -1,
      sources: [
        {
          sourceId: "source:one",
          documentId: "doc-1",
          notebookId: "nb-1",
          title: "Source",
          hPath: "/Source",
          state: "unknown",
          authorityDocumentIds: ["missing"],
          createdAt: "bad",
          updatedAt: "bad",
        },
        { sourceId: "source:one" },
      ],
      authorities: [{ documentId: "broken" }],
    });
    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.revision).toBe(0);
    expect(normalized.sources).toHaveLength(1);
    expect(normalized.sources[0].state).toBe("registered");
    expect(normalized.sources[0].authorityDocumentIds).toEqual([]);
    expect(normalized.authorities).toEqual([]);
  });

  it("computes access-filtered coverage and state counts", async () => {
    const registry = await linkedRegistry();
    registry.sources.push({
      ...registry.sources[0],
      sourceId: "source:secret",
      documentId: "20260812000006-fffffff",
      notebookId: "20260812000000-secret1",
      authorityDocumentIds: [],
    });
    const status = summarizeKnowledgeRegistry(registry, [
      "20260812000000-nb00001",
    ]);
    expect(status.sourceCount).toBe(1);
    expect(status.authorityCount).toBe(1);
    expect(status.linkedSourceCount).toBe(1);
    expect(status.coveragePercent).toBe(100);
    expect(status.sourceStates).toMatchObject({ registered: 1 });
    expect(status.authorityPageTypes).toMatchObject({ concept: 1 });
  });

  it("refreshes live paths and drops deleted or newly denied documents", async () => {
    const registry = await linkedRegistry();
    registry.authorities[0].sourceContainerDocumentId =
      "20260812000008-hhhhhhh";
    const refreshed = refreshAccessibleKnowledgeRegistry(
      registry,
      [
        {
          id: registry.sources[0].documentId,
          box: "20260812000000-nb00001",
          content: "Renamed Raw Source",
          hpath: "/Moved/Renamed Raw Source",
        },
        {
          id: registry.authorities[0].documentId,
          box: "20260812000000-secret1",
          content: "Denied Authority",
          hpath: "/Secret/Denied Authority",
        },
      ],
      ["20260812000000-nb00001"],
    );
    expect(refreshed.sources).toHaveLength(1);
    expect(refreshed.sources[0]).toMatchObject({
      title: "Renamed Raw Source",
      hPath: "/Moved/Renamed Raw Source",
    });
    expect(refreshed.authorities).toEqual([]);
  });

  it("ranks exact aliases and title matches deterministically", async () => {
    const registry = await linkedRegistry();
    registry.authorities.push({
      ...registry.authorities[0],
      documentId: "20260812000007-ggggggg",
      title: "Agent Memory Engineering",
      hPath: "/AI/Agent Memory Engineering",
      aliases: [],
      sourceIds: [],
    });
    const result = findWikiCandidates(registry, {
      query: "智能体记忆",
      limit: 5,
      allowedNotebookIds: ["20260812000000-nb00001"],
    }) as { candidates: Array<{ documentId: string; matchedOn: string[] }> };
    expect(result.candidates[0].documentId).toBe(
      "20260812000002-bbbbbbb",
    );
    expect(result.candidates[0].matchedOn).toContain("alias:exact");
  });

  it("prioritizes direct source-to-authority links", async () => {
    const registry = await linkedRegistry();
    const result = findWikiCandidates(registry, {
      sourceId: "source:one",
      limit: 5,
      allowedNotebookIds: ["20260812000000-nb00001"],
    }) as {
      sourceFound: boolean;
      candidates: Array<{ score: number; matchedOn: string[] }>;
    };
    expect(result.sourceFound).toBe(true);
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(1_000);
    expect(result.candidates[0].matchedOn).toContain("source:linked");
  });

  it("returns a bounded fallback signal without note bodies", async () => {
    const registry = await linkedRegistry();
    const result = findWikiCandidates(registry, {
      query: "unrelated quantum topic",
      limit: 5,
      allowedNotebookIds: ["20260812000000-nb00001"],
    });
    expect(result).toMatchObject({
      candidates: [],
      fallbackRecommended: true,
      fallbackTool: "search_notes",
    });
    expect(JSON.stringify(result)).not.toContain("markdown");
    expect(JSON.stringify(result)).not.toContain("content");
  });

  it("does not reveal source existence outside the active boundary", async () => {
    const registry = await linkedRegistry();
    registry.sources[0].notebookId = "20260812000000-secret1";
    const result = findWikiCandidates(registry, {
      sourceId: "source:one",
      limit: 5,
      allowedNotebookIds: ["20260812000000-nb00001"],
    });
    expect(result).toMatchObject({
      sourceFound: false,
      candidates: [],
      fallbackRecommended: true,
    });
  });
});
