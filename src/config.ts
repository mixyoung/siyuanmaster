import type {
  AccessMode,
  NotebookSummary,
  OperationDecision,
  PluginPolicy,
  TagAiProvider,
  TagApplyMode,
  TaggingMode,
} from "./types";

export const POLICY_STORAGE_KEY = "policy.json";

export const DEFAULT_POLICY: PluginPolicy = {
  schemaVersion: 1,
  access: {
    mode: "allowlist",
    selectedNotebookIds: [],
    defaultDecision: "deny",
  },
  operations: {
    search: "allow",
    read: "allow",
    create: "allow",
    append: "allow",
    update: "confirm",
    rename: "confirm",
    move: "confirm",
    moveAcrossNotebooks: "deny",
    delete: "deny",
    export: "deny",
  },
  tagging: {
    mode: "ask",
    operations: {
      create: true,
      append: true,
      update: true,
      summarize: true,
      memory: true,
      batchOrganize: false,
    },
    sources: {
      fixed: true,
      manual: true,
      aiSuggested: true,
    },
    fixedTags: [],
    ai: {
      enabled: true,
      provider: "calling_agent",
      applyMode: "propose",
      maxTags: 5,
      preferExistingTags: true,
      deduplicateSynonyms: true,
    },
  },
  audit: {
    enabled: true,
    retentionDays: 30,
    recordReadOperations: true,
    redactContent: true,
  },
};

const ACCESS_MODES = new Set<AccessMode>(["allowlist", "denylist"]);
const OPERATION_DECISIONS = new Set<OperationDecision>([
  "allow",
  "confirm",
  "deny",
]);
const TAGGING_MODES = new Set<TaggingMode>(["off", "ask", "always", "once"]);
const TAG_AI_PROVIDERS = new Set<TagAiProvider>([
  "calling_agent",
  "siyuan_ai",
]);
const TAG_APPLY_MODES = new Set<TagApplyMode>(["propose", "auto"]);

export function clonePolicy(policy: PluginPolicy): PluginPolicy {
  return JSON.parse(JSON.stringify(policy)) as PluginPolicy;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function enumOr<T extends string>(
  value: unknown,
  allowed: Set<T>,
  fallback: T,
): T {
  return typeof value === "string" && allowed.has(value as T)
    ? (value as T)
    : fallback;
}

export function normalizePolicy(value: unknown): PluginPolicy {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const access =
    source.access && typeof source.access === "object"
      ? (source.access as Record<string, unknown>)
      : {};
  const operations =
    source.operations && typeof source.operations === "object"
      ? (source.operations as Record<string, unknown>)
      : {};
  const tagging =
    source.tagging && typeof source.tagging === "object"
      ? (source.tagging as Record<string, unknown>)
      : {};
  const taggingOperations =
    tagging.operations && typeof tagging.operations === "object"
      ? (tagging.operations as Record<string, unknown>)
      : {};
  const sources =
    tagging.sources && typeof tagging.sources === "object"
      ? (tagging.sources as Record<string, unknown>)
      : {};
  const ai =
    tagging.ai && typeof tagging.ai === "object"
      ? (tagging.ai as Record<string, unknown>)
      : {};
  const audit =
    source.audit && typeof source.audit === "object"
      ? (source.audit as Record<string, unknown>)
      : {};

  const operation = (name: keyof PluginPolicy["operations"]) =>
    enumOr(
      operations[name],
      OPERATION_DECISIONS,
      DEFAULT_POLICY.operations[name],
    );

  return {
    schemaVersion: 1,
    access: {
      mode: enumOr(
        access.mode,
        ACCESS_MODES,
        DEFAULT_POLICY.access.mode,
      ),
      selectedNotebookIds: normalizeStringList(
        access.selectedNotebookIds,
      ),
      defaultDecision:
        access.defaultDecision === "allow" ? "allow" : "deny",
    },
    operations: {
      search: operation("search"),
      read: operation("read"),
      create: operation("create"),
      append: operation("append"),
      update: operation("update"),
      rename: operation("rename"),
      move: operation("move"),
      moveAcrossNotebooks: operation("moveAcrossNotebooks"),
      delete: operation("delete"),
      export: operation("export"),
    },
    tagging: {
      mode: enumOr(
        tagging.mode,
        TAGGING_MODES,
        DEFAULT_POLICY.tagging.mode,
      ),
      operations: {
        create: booleanOr(
          taggingOperations.create,
          DEFAULT_POLICY.tagging.operations.create,
        ),
        append: booleanOr(
          taggingOperations.append,
          DEFAULT_POLICY.tagging.operations.append,
        ),
        update: booleanOr(
          taggingOperations.update,
          DEFAULT_POLICY.tagging.operations.update,
        ),
        summarize: booleanOr(
          taggingOperations.summarize,
          DEFAULT_POLICY.tagging.operations.summarize,
        ),
        memory: booleanOr(
          taggingOperations.memory,
          DEFAULT_POLICY.tagging.operations.memory,
        ),
        batchOrganize: booleanOr(
          taggingOperations.batchOrganize,
          DEFAULT_POLICY.tagging.operations.batchOrganize,
        ),
      },
      sources: {
        fixed: booleanOr(
          sources.fixed,
          DEFAULT_POLICY.tagging.sources.fixed,
        ),
        manual: booleanOr(
          sources.manual,
          DEFAULT_POLICY.tagging.sources.manual,
        ),
        aiSuggested: booleanOr(
          sources.aiSuggested,
          DEFAULT_POLICY.tagging.sources.aiSuggested,
        ),
      },
      fixedTags: normalizeStringList(tagging.fixedTags),
      ai: {
        enabled: booleanOr(ai.enabled, DEFAULT_POLICY.tagging.ai.enabled),
        provider: enumOr(
          ai.provider,
          TAG_AI_PROVIDERS,
          DEFAULT_POLICY.tagging.ai.provider,
        ),
        applyMode: enumOr(
          ai.applyMode,
          TAG_APPLY_MODES,
          DEFAULT_POLICY.tagging.ai.applyMode,
        ),
        maxTags: numberInRange(
          ai.maxTags,
          DEFAULT_POLICY.tagging.ai.maxTags,
          1,
          12,
        ),
        preferExistingTags: booleanOr(
          ai.preferExistingTags,
          DEFAULT_POLICY.tagging.ai.preferExistingTags,
        ),
        deduplicateSynonyms: booleanOr(
          ai.deduplicateSynonyms,
          DEFAULT_POLICY.tagging.ai.deduplicateSynonyms,
        ),
      },
    },
    audit: {
      enabled: booleanOr(audit.enabled, DEFAULT_POLICY.audit.enabled),
      retentionDays: numberInRange(
        audit.retentionDays,
        DEFAULT_POLICY.audit.retentionDays,
        1,
        365,
      ),
      recordReadOperations: booleanOr(
        audit.recordReadOperations,
        DEFAULT_POLICY.audit.recordReadOperations,
      ),
      redactContent: booleanOr(
        audit.redactContent,
        DEFAULT_POLICY.audit.redactContent,
      ),
    },
  };
}

export function isNotebookAllowed(
  notebookId: string,
  policy: PluginPolicy,
): boolean {
  const selected = policy.access.selectedNotebookIds.includes(notebookId);
  return policy.access.mode === "allowlist" ? selected : !selected;
}

export function countAccessibleNotebooks(
  notebooks: NotebookSummary[],
  policy: PluginPolicy,
): number {
  return notebooks.filter((notebook) =>
    isNotebookAllowed(notebook.id, policy),
  ).length;
}
