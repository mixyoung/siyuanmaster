import { describe, expect, it } from "vitest";
import { clonePolicy, DEFAULT_POLICY } from "../src/config";
import {
  evaluateOperation,
  mergeTags,
  normalizeTags,
  planTags,
} from "../src/policy-engine";

describe("operation policy", () => {
  it("blocks denied operations", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    const result = evaluateOperation(policy, "delete", true);
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("deny");
  });

  it("requires explicit confirmation when configured", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    expect(evaluateOperation(policy, "update", false)).toMatchObject({
      allowed: false,
      requiresConfirmation: true,
    });
    expect(evaluateOperation(policy, "update", true)).toMatchObject({
      allowed: true,
      requiresConfirmation: false,
    });
  });

  it("denies cross-notebook moves independently", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    expect(
      evaluateOperation(policy, "moveAcrossNotebooks", true),
    ).toMatchObject({
      allowed: false,
      decision: "deny",
    });
  });
});

describe("tag policy", () => {
  it("never forces a source tag when tagging is off", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    policy.tagging.mode = "off";
    policy.tagging.fixedTags = ["siyuanMCP"];
    expect(
      planTags(
        policy,
        "create",
        { decision: "add", tags: ["custom"] },
        [],
      ),
    ).toMatchObject({ action: "skip", tags: [] });
  });

  it("requires a per-operation decision in ask mode", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    expect(
      planTags(policy, "append", undefined, [], false),
    ).toMatchObject({ action: "confirm" });
  });

  it("appends only new normalized tags", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    policy.tagging.mode = "always";
    policy.tagging.fixedTags = ["AI整理", "已有"];
    const result = planTags(
      policy,
      "update",
      { decision: "add", tags: ["#候选", "候选", ""] },
      ["已有"],
      false,
    );
    expect(result).toMatchObject({
      action: "apply",
      tags: ["AI整理", "候选"],
    });
  });

  it("skips documents already tagged in once mode", () => {
    const policy = clonePolicy(DEFAULT_POLICY);
    policy.tagging.mode = "once";
    expect(
      planTags(
        policy,
        "memory",
        { decision: "add", tags: ["记忆"] },
        [],
        true,
      ),
    ).toMatchObject({ action: "skip", tags: [] });
  });

  it("normalizes and de-duplicates arbitrary AI candidates", () => {
    expect(
      normalizeTags(["#AI", "AI", " 知识 ", "x".repeat(33), 1]),
    ).toEqual(["AI", "知识"]);
  });

  it("mergeTags never overwrites existing tags", () => {
    expect(mergeTags(["已有", "保留"], ["#新增", "已有", ""])).toEqual([
      "已有",
      "保留",
      "新增",
    ]);
    expect(mergeTags(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeTags(["alpha"], undefined)).toEqual(["alpha"]);
  });
});
