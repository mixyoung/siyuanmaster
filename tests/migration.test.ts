import { describe, expect, it } from "vitest";
import {
  BRAND_SLUG,
  CURRENT_TECHNICAL_ID,
  FUTURE_TECHNICAL_ID,
  migrateLegacyAuditEntries,
  petalFilePath,
  resolvePolicyAfterUpgrade,
} from "../src/migration";

describe("future technical-ID migration decisions", () => {
  it("keeps brand slug separate from transition technical id", () => {
    expect(BRAND_SLUG).toBe("siyuanmaster");
    expect(CURRENT_TECHNICAL_ID).toBe("siyuan-agent-access");
    expect(FUTURE_TECHNICAL_ID).toBe("siyuanmaster");
    expect(CURRENT_TECHNICAL_ID).not.toBe(BRAND_SLUG);
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
  });

  it("builds petal paths without deleting anything", () => {
    expect(petalFilePath(CURRENT_TECHNICAL_ID, "policy.json")).toBe(
      "data/storage/petal/siyuan-agent-access/policy.json",
    );
    expect(petalFilePath(FUTURE_TECHNICAL_ID, "audit.json")).toBe(
      "data/storage/petal/siyuanmaster/audit.json",
    );
  });

  it("merges legacy audit only when current is empty", () => {
    const legacy = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        operation: "read",
        outcome: "allowed",
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
});
