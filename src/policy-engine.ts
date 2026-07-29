import type {
  OperationDecision,
  PluginPolicy,
  TaggingRequest,
} from "./types";

export type ControlledOperation =
  keyof PluginPolicy["operations"];
export type TaggableOperation =
  keyof PluginPolicy["tagging"]["operations"];

export interface OperationGuard {
  allowed: boolean;
  requiresConfirmation: boolean;
  decision: OperationDecision;
  reason?: string;
}

export interface TagPlan {
  action: "skip" | "confirm" | "apply";
  tags: string[];
  reason: string;
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().replace(/^#+|#+$/g, ""))
        .filter((tag) => tag.length > 0 && tag.length <= 32),
    ),
  ];
}

export function evaluateOperation(
  policy: PluginPolicy,
  operation: ControlledOperation,
  confirmed: boolean,
): OperationGuard {
  const decision = policy.operations[operation];
  if (decision === "deny") {
    return {
      allowed: false,
      requiresConfirmation: false,
      decision,
      reason: `Operation '${operation}' is denied by the active policy`,
    };
  }
  if (decision === "confirm" && !confirmed) {
    return {
      allowed: false,
      requiresConfirmation: true,
      decision,
      reason:
        `Operation '${operation}' requires explicit user confirmation. ` +
        "Ask the user, then retry with confirmed=true.",
    };
  }
  return {
    allowed: true,
    requiresConfirmation: false,
    decision,
  };
}

export function parseTaggingRequest(value: unknown): TaggingRequest {
  if (!value || typeof value !== "object") {
    return { decision: "use_default", tags: [] };
  }
  const source = value as Record<string, unknown>;
  const decision =
    source.decision === "add" ||
    source.decision === "skip" ||
    source.decision === "propose"
      ? source.decision
      : "use_default";
  return {
    decision,
    tags: normalizeTags(source.tags),
  };
}

export function planTags(
  policy: PluginPolicy,
  operation: TaggableOperation,
  requestValue: unknown,
  existingTags: string[] = [],
  alreadyTagged = false,
): TagPlan {
  const request = parseTaggingRequest(requestValue);
  if (!policy.tagging.operations[operation]) {
    return {
      action: "skip",
      tags: [],
      reason: `Tagging is disabled for '${operation}' operations`,
    };
  }
  if (policy.tagging.mode === "off" || request.decision === "skip") {
    return {
      action: "skip",
      tags: [],
      reason:
        policy.tagging.mode === "off"
          ? "Tagging mode is off"
          : "Caller explicitly skipped tags",
    };
  }
  if (policy.tagging.mode === "once" && alreadyTagged) {
    return {
      action: "skip",
      tags: [],
      reason: "This document was already tagged by the plugin",
    };
  }
  if (
    request.decision === "propose" ||
    (policy.tagging.mode === "ask" &&
      request.decision !== "add")
  ) {
    return {
      action: "confirm",
      tags: normalizeTags(request.tags),
      reason:
        "The active tag policy requires a per-operation choice. " +
        "Present candidates to the user, then retry with decision='add' or decision='skip'.",
    };
  }

  const tags = normalizeTags([
    ...(policy.tagging.sources.fixed
      ? policy.tagging.fixedTags
      : []),
    ...request.tags,
  ]).filter((tag) => !existingTags.includes(tag));

  return {
    action: tags.length > 0 ? "apply" : "skip",
    tags,
    reason:
      tags.length > 0
        ? "Tags are ready to append without replacing existing tags"
        : "No new tags were supplied by the active sources",
  };
}
