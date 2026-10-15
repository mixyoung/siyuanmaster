import { describe, expect, it } from "vitest";
import {
  BRAND_SLUG,
  CURRENT_TECHNICAL_ID,
  isAlreadyTaggedOnce,
  isPlausiblePolicy,
  LEGACY_TAGGED_ONCE_ATTR,
  LEGACY_TECHNICAL_ID,
  legacyPetalFilePath,
  MAX_AUDIT_ENTRIES,
  migrateLegacyAuditEntries,
  MIGRATION_MARKER_KEY,
  parseWorkspaceJsonPayload,
  petalFilePath,
  POLICY_STORAGE_KEY,
  AUDIT_STORAGE_KEY,
  resolvePolicyAfterUpgrade,
  runStorageMigration,
  TAGGED_ONCE_ATTR,
  type MigrationStorageIO,
} from "../src/migration";

function memoryIO(seed?: {
  current?: Record<string, unknown>;
  legacy?: Record<string, unknown>;
  failLegacyKeys?: string[];
}): {
  io: MigrationStorageIO;
  current: Record<string, unknown>;
  legacy: Record<string, unknown>;
  deletedLegacy: string[];
  writtenLegacy: string[];
} {
  const current: Record<string, unknown> = { ...(seed?.current ?? {}) };
  const legacy: Record<string, unknown> = { ...(seed?.legacy ?? {}) };
  const deletedLegacy: string[] = [];
  const writtenLegacy: string[] = [];
  const failLegacy = new Set(seed?.failLegacyKeys ?? []);
  const io: MigrationStorageIO = {
    readCurrent: async (key) => current[key],
    writeCurrent: async (key, value) => {
      current[key] = value;
    },
    readLegacy: async (key) => {
      if (failLegacy.has(key)) {
        throw new Error(`legacy read failed: ${key}`);
      }
      return legacy[key];
    },
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  };
  // Guard: tests must never mutate legacy via io. Capture any accidental writes.
  const originalLegacy = { ...legacy };
  return {
    io,
    current,
    legacy,
    deletedLegacy,
    writtenLegacy,
    // after each op, verify legacy unchanged
    assertLegacyUntouched() {
      expect(legacy).toEqual(originalLegacy);
      expect(deletedLegacy).toEqual([]);
      expect(writtenLegacy).toEqual([]);
    },
  } as {
    io: MigrationStorageIO;
    current: Record<string, unknown>;
    legacy: Record<string, unknown>;
    deletedLegacy: string[];
    writtenLegacy: string[];
    assertLegacyUntouched(): void;
  };
}

describe("technical-ID migration (phase 2 storage)", () => {
  it("aligns brand slug with current technical id; keeps legacy id for bridge", () => {
    expect(BRAND_SLUG).toBe("siyuanmaster");
    expect(CURRENT_TECHNICAL_ID).toBe("siyuanmaster");
    expect(LEGACY_TECHNICAL_ID).toBe("siyuan-agent-access");
    expect(CURRENT_TECHNICAL_ID).toBe(BRAND_SLUG);
    expect(LEGACY_TECHNICAL_ID).not.toBe(CURRENT_TECHNICAL_ID);
  });

  it("prefers new storage when both exist", () => {
    const decision = resolvePolicyAfterUpgrade(
      {
        access: {
          mode: "allowlist",
          selectedNotebookIds: ["20260101000000-newbook1"],
          defaultDecision: "deny",
        },
      },
      {
        access: {
          mode: "denylist",
          selectedNotebookIds: ["20260101000000-oldbook1"],
          defaultDecision: "allow",
        },
      },
    );
    expect(decision.source).toBe("new");
    expect(decision.migrateOld).toBe(false);
    expect(decision.policy.access.selectedNotebookIds).toEqual([
      "20260101000000-newbook1",
    ]);
  });

  it("selects old policy only when new is missing", () => {
    const decision = resolvePolicyAfterUpgrade(undefined, {
      access: {
        mode: "allowlist",
        selectedNotebookIds: ["20260101000000-oldbook1"],
        defaultDecision: "deny",
      },
    });
    expect(decision.source).toBe("old");
    expect(decision.migrateOld).toBe(true);
    expect(decision.policy.access.selectedNotebookIds).toEqual([
      "20260101000000-oldbook1",
    ]);
  });

  it("falls back to safe default empty allowlist", () => {
    const decision = resolvePolicyAfterUpgrade(undefined, undefined);
    expect(decision.source).toBe("default");
    expect(decision.migrateOld).toBe(false);
    expect(decision.policy.access.selectedNotebookIds).toEqual([]);
    expect(decision.policy.access.mode).toBe("allowlist");
    expect(decision.policy.access.defaultDecision).toBe("deny");
  });

  it("builds display paths and official API paths (leading slash for getFile)", () => {
    expect(petalFilePath(CURRENT_TECHNICAL_ID, "policy.json")).toBe(
      "data/storage/petal/siyuanmaster/policy.json",
    );
    expect(petalFilePath(LEGACY_TECHNICAL_ID, "audit.json")).toBe(
      "data/storage/petal/siyuan-agent-access/audit.json",
    );
    // Official Plugin.loadData / getFile format (app/src/plugin/index.ts).
    expect(legacyPetalFilePath(POLICY_STORAGE_KEY)).toBe(
      "/data/storage/petal/siyuan-agent-access/policy.json",
    );
    expect(legacyPetalFilePath(AUDIT_STORAGE_KEY)).toBe(
      "/data/storage/petal/siyuan-agent-access/audit.json",
    );
  });

  it("merges legacy audit only when current is empty", () => {
    const legacy = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        operation: "read",
        outcome: "allowed" as const,
      },
    ];
    expect(migrateLegacyAuditEntries([], legacy)).toHaveLength(1);
    expect(
      migrateLegacyAuditEntries(
        [
          {
            timestamp: "2026-02-01T00:00:00.000Z",
            operation: "update",
            outcome: "allowed",
          },
        ],
        legacy,
      ),
    ).toHaveLength(1);
  });

  it("copies old policy once into new storage and never overwrites new", async () => {
    const oldPolicy = {
      access: {
        mode: "allowlist",
        selectedNotebookIds: ["20260101000000-oldbook1"],
        defaultDecision: "deny",
      },
    };
    const store = memoryIO({ legacy: { [POLICY_STORAGE_KEY]: oldPolicy } });
    const first = await runStorageMigration(store.io);
    expect(first.policySource).toBe("old");
    expect(first.policyCopied).toBe(true);
    expect(first.markerWritten).toBe(true);
    expect(store.current[POLICY_STORAGE_KEY]).toBeDefined();
    expect(first.policy.access.selectedNotebookIds).toEqual([
      "20260101000000-oldbook1",
    ]);
    expect(store.current[MIGRATION_MARKER_KEY]).toBeDefined();
    // legacy untouched
    expect(store.legacy[POLICY_STORAGE_KEY]).toEqual(oldPolicy);

    // Second start: marker present, new wins, no re-copy
    const second = await runStorageMigration(store.io);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.policyCopied).toBe(false);
    expect(second.markerWritten).toBe(false);
    expect(second.policy.access.selectedNotebookIds).toEqual([
      "20260101000000-oldbook1",
    ]);
    expect(store.legacy[POLICY_STORAGE_KEY]).toEqual(oldPolicy);
  });

  it("never lets old policy overwrite existing new policy", async () => {
    const newPolicy = {
      access: {
        mode: "allowlist",
        selectedNotebookIds: ["20260101000000-newbook1"],
        defaultDecision: "deny",
      },
    };
    const oldPolicy = {
      access: {
        mode: "denylist",
        selectedNotebookIds: ["20260101000000-oldbook1"],
        defaultDecision: "allow",
      },
    };
    const store = memoryIO({
      current: { [POLICY_STORAGE_KEY]: newPolicy },
      legacy: { [POLICY_STORAGE_KEY]: oldPolicy },
    });
    const result = await runStorageMigration(store.io);
    expect(result.policySource).toBe("new");
    expect(result.policyCopied).toBe(false);
    expect(result.policy.access.selectedNotebookIds).toEqual([
      "20260101000000-newbook1",
    ]);
    expect(store.current[POLICY_STORAGE_KEY]).toEqual(newPolicy);
    expect(store.legacy[POLICY_STORAGE_KEY]).toEqual(oldPolicy);
  });

  it("fail-closes on corrupt old policy without widening access", async () => {
    const store = memoryIO({
      legacy: {
        [POLICY_STORAGE_KEY]: "not-json-object",
      },
    });
    // also reject non-plausible
    expect(isPlausiblePolicy("not-json-object")).toBe(false);
    await expect(runStorageMigration(store.io)).rejects.toThrow("Legacy policy is invalid");
    expect(store.current).toEqual({});
    expect(store.legacy[POLICY_STORAGE_KEY]).toBe("not-json-object");
  });

  it("fail-closes when legacy read throws", async () => {
    const store = memoryIO({
      failLegacyKeys: [POLICY_STORAGE_KEY],
      legacy: {
        [POLICY_STORAGE_KEY]: {
          access: {
            mode: "allowlist",
            selectedNotebookIds: ["should-not-apply"],
            defaultDecision: "deny",
          },
        },
      },
    });
    await expect(runStorageMigration(store.io)).rejects.toThrow("legacy read failed");
    expect(store.current).toEqual({});
  });

  it("copies old audit only when new audit is empty (bounded metadata-only)", async () => {
    const legacyAudit = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        operation: "read",
        outcome: "allowed",
        body: "SECRET_NOTE_BODY",
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        operation: "update",
        outcome: "allowed",
      },
    ];
    const store = memoryIO({
      legacy: {
        [POLICY_STORAGE_KEY]: {
          access: {
            mode: "allowlist",
            selectedNotebookIds: ["nb1"],
            defaultDecision: "deny",
          },
        },
        [AUDIT_STORAGE_KEY]: legacyAudit,
      },
    });
    const result = await runStorageMigration(store.io);
    expect(result.auditCopied).toBe(true);
    const copied = store.current[AUDIT_STORAGE_KEY] as Array<
      Record<string, unknown>
    >;
    expect(copied).toHaveLength(2);
    expect(copied[0]).not.toHaveProperty("body");
    expect(JSON.stringify(copied)).not.toContain("SECRET_NOTE_BODY");

    // New non-empty audit: no re-copy even without reusing marker path after wipe of marker only — use second store
    const store2 = memoryIO({
      current: {
        [POLICY_STORAGE_KEY]: {
          access: {
            mode: "allowlist",
            selectedNotebookIds: ["nb1"],
            defaultDecision: "deny",
          },
        },
        [AUDIT_STORAGE_KEY]: [
          {
            timestamp: "2026-03-01T00:00:00.000Z",
            operation: "create",
            outcome: "allowed",
          },
        ],
      },
      legacy: { [AUDIT_STORAGE_KEY]: legacyAudit },
    });
    const noCopy = await runStorageMigration(store2.io);
    expect(noCopy.auditCopied).toBe(false);
    expect(store2.current[AUDIT_STORAGE_KEY]).toHaveLength(1);
  });

  it("bounds migrated audit to MAX_AUDIT_ENTRIES", () => {
    const many = Array.from({ length: MAX_AUDIT_ENTRIES + 50 }, (_, i) => ({
      timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      operation: "read",
      outcome: "allowed" as const,
    }));
    const merged = migrateLegacyAuditEntries([], many);
    expect(merged.length).toBe(MAX_AUDIT_ENTRIES);
  });

  it("marker makes repeated startup idempotent without deleting old data", async () => {
    const store = memoryIO({
      legacy: {
        [POLICY_STORAGE_KEY]: {
          access: {
            mode: "allowlist",
            selectedNotebookIds: ["nb-old"],
            defaultDecision: "deny",
          },
        },
        [AUDIT_STORAGE_KEY]: [
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            operation: "read",
            outcome: "allowed",
          },
        ],
      },
    });
    await runStorageMigration(store.io);
    const snapshotLegacy = JSON.parse(JSON.stringify(store.legacy));
    const snapshotCurrent = JSON.parse(JSON.stringify(store.current));
    const again = await runStorageMigration(store.io);
    expect(again.alreadyMigrated).toBe(true);
    expect(again.policyCopied).toBe(false);
    expect(again.auditCopied).toBe(false);
    expect(again.writtenKeys).toEqual([]);
    expect(store.legacy).toEqual(snapshotLegacy);
    expect(store.current[POLICY_STORAGE_KEY]).toEqual(
      snapshotCurrent[POLICY_STORAGE_KEY],
    );
  });

  it.each([MIGRATION_MARKER_KEY, POLICY_STORAGE_KEY, AUDIT_STORAGE_KEY])(
    "does not write anything when current %s cannot be read", async failedKey => {
      const store = memoryIO({ legacy: {
        [POLICY_STORAGE_KEY]: { access: { mode: "allowlist", selectedNotebookIds: ["old"], defaultDecision: "deny" } },
      } });
      const read = store.io.readCurrent;
      store.io.readCurrent = async key => {
        if (key === failedKey) throw new Error("current read unavailable");
        return read(key);
      };
      await expect(runStorageMigration(store.io)).rejects.toThrow("current read unavailable");
      expect(store.current).toEqual({});
    },
  );

  it.each([
    [MIGRATION_MARKER_KEY, {}],
    [POLICY_STORAGE_KEY, { access: null }],
    [AUDIT_STORAGE_KEY, {}],
    [AUDIT_STORAGE_KEY, [{ timestamp: "invalid", operation: "read", outcome: "allowed" }]],
  ])("preserves invalid current data at %s", async (key, value) => {
    const store = memoryIO({ current: { [key as string]: value }, legacy: {
      [POLICY_STORAGE_KEY]: { access: { mode: "allowlist", selectedNotebookIds: ["old"], defaultDecision: "deny" } },
      [AUDIT_STORAGE_KEY]: [{ timestamp: "2026-01-01T00:00:00.000Z", operation: "read", outcome: "allowed" }],
    } });
    const before = JSON.stringify(store.current);
    await expect(runStorageMigration(store.io)).rejects.toThrow(/invalid/);
    expect(JSON.stringify(store.current)).toBe(before);
  });

  it("does not copy policy before a required legacy audit read succeeds", async () => {
    const store = memoryIO({ failLegacyKeys: [AUDIT_STORAGE_KEY], legacy: {
      [POLICY_STORAGE_KEY]: { access: { mode: "allowlist", selectedNotebookIds: ["old"], defaultDecision: "deny" } },
    } });
    await expect(runStorageMigration(store.io)).rejects.toThrow("legacy read failed");
    expect(store.current).toEqual({});
  });

  it("keeps marker-only initial defaults healthy on later startups", async () => {
    const store = memoryIO();
    const first = await runStorageMigration(store.io);
    expect(first.policySource).toBe("default");
    expect(store.current[POLICY_STORAGE_KEY]).toBeDefined();
    delete store.current[POLICY_STORAGE_KEY];
    delete (store.current[MIGRATION_MARKER_KEY] as Record<string, unknown>).policyInitialized;
    const again = await runStorageMigration(store.io);
    expect(again.alreadyMigrated).toBe(true);
    expect(again.policySource).toBe("default");
    expect(store.current[POLICY_STORAGE_KEY]).toBeDefined();
    expect(store.current[MIGRATION_MARKER_KEY]).toMatchObject({ policyInitialized: true });
  });

  it("does not re-import old policy if the migrated current policy disappears", async () => {
    const store = memoryIO({ legacy: {
      [POLICY_STORAGE_KEY]: { access: { mode: "allowlist", selectedNotebookIds: ["old"], defaultDecision: "deny" } },
    } });
    await runStorageMigration(store.io);
    delete store.current[POLICY_STORAGE_KEY];
    const marker = store.current[MIGRATION_MARKER_KEY];
    await expect(runStorageMigration(store.io)).rejects.toThrow("Previously migrated policy is missing");
    expect(store.current[POLICY_STORAGE_KEY]).toBeUndefined();
    expect(store.current[MIGRATION_MARKER_KEY]).toBe(marker);
  });

  it("only migrates legacy audit entries satisfying the current audit schema", () => {
    const valid = { timestamp: "2026-01-01T00:00:00.000Z", operation: "read", outcome: "allowed" };
    expect(migrateLegacyAuditEntries([], [valid, { ...valid, outcome: "unknown" }, { ...valid, timestamp: "bad" }]))
      .toEqual([valid]);
  });

  it("loads a valid policy without sealing when the store is read-only", async () => {
    const oldMarker = {
      schemaVersion: 1, from: "siyuan-agent-access", to: "siyuanmaster",
      completedAt: "2026-01-01T00:00:00.000Z", policySource: "new", policyCopied: true, auditCopied: false,
    };
    const policy = { access: { mode: "allowlist", selectedNotebookIds: ["20260101000000-nb1"], defaultDecision: "deny" } };
    const store = memoryIO({ current: { [MIGRATION_MARKER_KEY]: oldMarker, [POLICY_STORAGE_KEY]: policy } });
    store.io.writeCurrent = async () => { throw new Error("read-only"); };
    const result = await runStorageMigration(store.io);
    expect(result.alreadyMigrated).toBe(true);
    expect(result.policySource).toBe("new");
    expect(result.policy.access.selectedNotebookIds).toEqual(["20260101000000-nb1"]);
    expect(result.writtenKeys).toEqual([]);
    expect(store.current[MIGRATION_MARKER_KEY]).toEqual(oldMarker);
    expect(store.current[POLICY_STORAGE_KEY]).toEqual(policy);
  });

  it("seals an unsealed marker when writes succeed and keeps the policy untouched", async () => {
    const oldMarker = {
      schemaVersion: 1, from: "siyuan-agent-access", to: "siyuanmaster",
      completedAt: "2026-01-01T00:00:00.000Z", policySource: "new", policyCopied: true, auditCopied: false,
    };
    const policy = { access: { mode: "allowlist", selectedNotebookIds: ["20260101000000-nb1"], defaultDecision: "deny" } };
    const store = memoryIO({ current: { [MIGRATION_MARKER_KEY]: oldMarker, [POLICY_STORAGE_KEY]: policy } });
    const result = await runStorageMigration(store.io);
    expect(result.writtenKeys).toEqual([MIGRATION_MARKER_KEY]);
    expect(store.current[MIGRATION_MARKER_KEY]).toMatchObject({ policyInitialized: true, policySource: "new" });
    expect(store.current[POLICY_STORAGE_KEY]).toEqual(policy);
  });

  it("reads legacy once-tag attr and writes only the new attr name", () => {
    expect(
      isAlreadyTaggedOnce({ [LEGACY_TAGGED_ONCE_ATTR]: "true" }),
    ).toBe(true);
    expect(isAlreadyTaggedOnce({ [TAGGED_ONCE_ATTR]: "true" })).toBe(true);
    expect(isAlreadyTaggedOnce({})).toBe(false);
    expect(TAGGED_ONCE_ATTR).toBe("custom-siyuanmaster-tagged");
    expect(LEGACY_TAGGED_ONCE_ATTR).toBe("custom-agent-access-tagged");
    expect(TAGGED_ONCE_ATTR).not.toBe(LEGACY_TAGGED_ONCE_ATTR);
  });

  it("parseWorkspaceJsonPayload fail-closes on error envelopes and corrupt text", () => {
    expect(parseWorkspaceJsonPayload({ code: 404, msg: "not found" })).toBe(
      undefined,
    );
    expect(parseWorkspaceJsonPayload("{not json")).toBe(undefined);
    expect(parseWorkspaceJsonPayload('{"access":{}}')).toEqual({ access: {} });
    expect(parseWorkspaceJsonPayload({ access: {} })).toEqual({ access: {} });
  });
});
