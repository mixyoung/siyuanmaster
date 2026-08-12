import type * as kernel from "siyuan/kernel";
import { AuditStore } from "./audit";
import {
  clonePolicy,
  DEFAULT_POLICY,
  isNotebookAllowed,
  normalizePolicy,
} from "./config";
import {
  isAlreadyTaggedOnce,
  LEGACY_TECHNICAL_ID,
  legacyPetalFilePath,
  parseWorkspaceJsonPayload,
  runStorageMigration,
  TAGGED_ONCE_ATTR,
  type MigrationStorageIO,
} from "./migration";
import {
  attachBlockStateHashes,
  blockDisplayText,
  buildOutline,
  resolveDocumentPath,
  windowBlocks,
  type BlockRow,
} from "./document-access";
import { EditBlockError, performEditBlock } from "./edit-block";
import { buildDocumentTree } from "./document-tree";
import {
  assertSiyuanId,
  BlockRecord,
  DocumentContext,
  escapeSqlLiteral,
  KernelApiClient,
  normalizeDocumentTitle,
} from "./kernel-api";
import {
  findWikiCandidates,
  KnowledgeRegistryError,
  KnowledgeRegistryStore,
  KNOWLEDGE_ROLES,
  SOURCE_STATES,
  refreshAccessibleKnowledgeRegistry,
  summarizeKnowledgeRegistry,
  WIKI_PAGE_TYPES,
  type KnowledgeRole,
  type KnowledgeRegistry,
  type SourceState,
  type WikiPageType,
} from "./knowledge-registry";
import {
  CREATION_GATE_DECISIONS,
  INGEST_DISCOVERY_STATES,
  IngestPlanError,
  planSourceIngest,
  type CreationGateDecision,
  type IngestDiscoveryState,
} from "./ingest-plan";
import {
  listWikiTemplates,
  renderWikiTemplate,
  validateWikiTemplate,
  WIKI_EVIDENCE_STATUSES,
  WIKI_STATUSES,
  WIKI_TEMPLATE_LOCALES,
  type WikiEvidenceStatus,
  type WikiStatus,
  type WikiTemplateLocale,
} from "./wiki-template";
import {
  evaluateOperation,
  mergeTags,
  normalizeTags,
  planTags,
  type ControlledOperation,
  type TaggableOperation,
} from "./policy-engine";
import {
  documentDirectory,
  documentParentDirectory,
  documentParentId,
  isSameOrDescendantPath,
  joinHumanPath,
  previewMatchesCurrent,
  replaceHumanPathTitle,
  snapshotDocument,
  STRUCTURE_PREVIEW_TTL_MS,
  type MovePreview,
  type RenamePreview,
  type StructurePreview,
  type StructureSnapshot,
} from "./structure-safety";
import type {
  AuditEntry,
  NotebookSummary,
  PluginPolicy,
} from "./types";
import {
  computeContentHash,
  runWriteTransaction,
} from "./write-transaction";

const MAX_MARKDOWN_LENGTH = 1_000_000;
const STRUCTURE_VERIFY_ATTEMPTS = 8;
const STRUCTURE_VERIFY_DELAY_MS = 125;

class PolicyViolation extends Error {
  constructor(
    readonly code:
      | "operation_denied"
      | "confirmation_required"
      | "notebook_denied"
      | "tag_decision_required"
      | "preview_expired"
      | "state_changed"
      | "name_conflict"
      | "invalid_request",
    message: string,
  ) {
    super(message);
  }
}

interface SearchRow extends Record<string, unknown> {
  matched_id: string;
  document_id: string;
  box: string;
  hpath: string;
  title: string;
  tags: string;
  snippet: string;
  block_type: string;
  updated: string;
}

interface ToolRunMetadata {
  documentId?: string;
  notebookId?: string;
  targetNotebookId?: string;
  confirmed?: boolean;
  contentLength?: number;
  preview?: boolean;
  crossNotebook?: boolean;
}

function boundedInteger(
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

function stringInput(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") {
    throw new PolicyViolation("invalid_request", `${label} is required`);
  }
  const result = value;
  if (!options.allowEmpty && !result.trim()) {
    throw new PolicyViolation(
      "invalid_request",
      `${label} must not be empty`,
    );
  }
  if (
    options.maxLength !== undefined &&
    result.length > options.maxLength
  ) {
    throw new PolicyViolation(
      "invalid_request",
      `${label} must not exceed ${options.maxLength} characters`,
    );
  }
  return result;
}

function splitStoredTags(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return normalizeTags(value.split(/[,，\n]/));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function stringArrayInput(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new PolicyViolation(
      "invalid_request",
      `${label} must be an array with at most ${maximumItems} items`,
    );
  }
  return [
    ...new Set(
      value.map((item, index) =>
        stringInput(item, `${label}[${index}]`, {
          maxLength: maximumLength,
        }).trim(),
      ),
    ),
  ];
}

function enumInput<T extends readonly string[]>(
  value: unknown,
  label: string,
  options: T,
): T[number] {
  const result = stringInput(value, label, { maxLength: 64 }).trim();
  if (!options.includes(result)) {
    throw new PolicyViolation(
      "invalid_request",
      `${label} must be one of: ${options.join(", ")}`,
    );
  }
  return result as T[number];
}

function optionalSha256(value: unknown): string | undefined {
  const result = optionalString(value)?.toLowerCase();
  if (result && !/^[a-f0-9]{64}$/.test(result)) {
    throw new PolicyViolation(
      "invalid_request",
      "sha256 must contain exactly 64 hexadecimal characters",
    );
  }
  return result;
}

function optionalCanonicalUrl(value: unknown): string | undefined {
  const result = optionalString(value);
  if (!result) {
    return undefined;
  }
  if (result.length > 2_048) {
    throw new PolicyViolation(
      "invalid_request",
      "canonicalUrl must not exceed 2048 characters",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new PolicyViolation(
      "invalid_request",
      "canonicalUrl must be a valid HTTP or HTTPS URL",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new PolicyViolation(
      "invalid_request",
      "canonicalUrl must be an HTTP(S) URL without embedded credentials",
    );
  }
  parsed.hash = "";
  return parsed.toString();
}

function optionalIsoDate(value: unknown): string | undefined {
  const result = optionalString(value);
  if (!result) {
    return undefined;
  }
  if (
    result.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      result,
    ) ||
    Number.isNaN(Date.parse(result))
  ) {
    throw new PolicyViolation(
      "invalid_request",
      "reviewedAt must be an ISO date or timestamp",
    );
  }
  return result;
}

function sourceIdInput(value: unknown, documentId: string): string {
  const result = optionalString(value) ?? `siyuan:${documentId}`;
  if (
    result.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result)
  ) {
    throw new PolicyViolation(
      "invalid_request",
      "sourceId must be 1-128 URL-safe identifier characters",
    );
  }
  return result;
}

function documentTitleInput(value: unknown): string {
  try {
    return normalizeDocumentTitle(value);
  } catch (error) {
    throw new PolicyViolation(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function headingLike(blockType: string): boolean {
  return /^h[1-6]$/.test(blockType);
}

function genericToolConfig(
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
  readOnly: boolean,
): kernel.IMcpToolConfig {
  return {
    title,
    description,
    annotations: {
      readOnlyHint: readOnly,
    },
    inputSchema,
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
  } as kernel.IMcpToolConfig & {
    annotations: { readOnlyHint: boolean };
  };
}

function confirmedProperty(): Record<string, unknown> {
  return {
    type: "boolean",
    description:
      "Set true only after the user explicitly approves an operation whose active policy is 'confirm'.",
  };
}

function taggingProperty(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Optional per-operation tag choice. In ask mode, use decision='add' or decision='skip'. No fixed source tag is required.",
    properties: {
      decision: {
        type: "string",
        enum: ["use_default", "add", "skip", "propose"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Custom or AI-summarized tag names without leading # characters.",
      },
    },
    additionalProperties: false,
  };
}

class SiYuanMasterKernelPlugin {
  private readonly api: kernel.ISiyuan = siyuan;
  private readonly client = new KernelApiClient(this.api);
  private readonly audit = new AuditStore(
    this.api,
    () => this.policy,
  );
  private readonly knowledgeRegistry = new KnowledgeRegistryStore(
    this.api.storage,
  );
  private policy: PluginPolicy = clonePolicy(DEFAULT_POLICY);
  private readonly registeredTools: string[] = [];
  private readonly structurePreviews = new Map<
    string,
    StructurePreview
  >();

  constructor() {
    // SiYuan kernel invokes every IPluginLifecycle field; unbound values
    // (undefined / non-function) surface as "not bound to a function".
    // onrunning is post-onload "running" — no re-init or tool registration.
    this.api.plugin.lifecycle.onload = this.onload.bind(this);
    this.api.plugin.lifecycle.onrunning = this.onrunning.bind(this);
    this.api.plugin.lifecycle.onunload = this.onunload.bind(this);
  }

  private async onload(): Promise<void> {
    await this.reloadPolicy();
    await this.api.rpc.bind(
      "reloadPolicy",
      async () => {
        await this.reloadPolicy();
        return this.status();
      },
      "Reload the SiYuanMaster policy from plugin-private storage.",
    );
    await this.api.rpc.bind(
      "getStatus",
      async () => this.status(),
      "Return SiYuanMaster kernel status.",
    );

    await this.registerPolicyTool();
    await this.registerNotebookTool();
    await this.registerDocumentTreeTool();
    await this.registerSearchTool();
    await this.registerReadTool();
    await this.registerResolveDocumentTool();
    await this.registerReadNoteSegmentsTool();
    await this.registerKnowledgeSourceTool();
    await this.registerWikiAuthorityTool();
    await this.registerKnowledgeStatusTool();
    await this.registerFindWikiCandidatesTool();
    await this.registerListWikiTemplatesTool();
    await this.registerRenderWikiTemplateTool();
    await this.registerValidateWikiTemplateTool();
    await this.registerPlanSourceIngestTool();
    await this.registerCreateTool();
    await this.registerAppendTool();
    await this.registerUpdateTool();
    await this.registerEditBlockTool();
    await this.registerRenameTool();
    await this.registerMoveTool();
    await this.registerDeleteTool();
    await this.registerApplyTagsTool();
    await this.registerTagSuggestionTool();
    await this.registerSummaryTool();
    await this.registerMemoryTool();
    await this.registerAuditTool();

    await this.api.logger.info(
      `SiYuanMaster loaded with ${this.registeredTools.length} MCP tools (technical id siyuanmaster)`,
    );
  }

  /**
   * Kernel "running" transition after onload. Intentionally empty: tools and
   * RPC are registered in onload; re-doing that here would double-register.
   */
  private async onrunning(): Promise<void> {
    // no-op: IPluginLifecycle requires a bound function on SiYuan 3.8+
  }

  private async onunload(): Promise<void> {
    for (const tool of this.registeredTools) {
      await this.api.mcp.unregisterTool(tool);
    }
    await this.api.rpc.unbind("reloadPolicy");
    await this.api.rpc.unbind("getStatus");
    this.structurePreviews.clear();
  }

  private async reloadPolicy(): Promise<void> {
    try {
      const result = await runStorageMigration(this.createMigrationIO());
      this.policy = result.policy;
      if (result.policyCopied || result.auditCopied) {
        await this.api.logger.info(
          `SiYuanMaster migrated storage from ${LEGACY_TECHNICAL_ID} (policyCopied=${result.policyCopied}, auditCopied=${result.auditCopied})`,
        );
      }
    } catch (error) {
      this.policy = clonePolicy(DEFAULT_POLICY);
      await this.api.logger.warn(
        "Policy unavailable; using safe default allowlist with no selected notebooks",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private createMigrationIO(): MigrationStorageIO {
    return {
      readCurrent: async (key) => {
        try {
          const stored = await this.api.storage.get(key);
          return await stored.json();
        } catch {
          return undefined;
        }
      },
      writeCurrent: async (key, value) => {
        const content =
          typeof value === "string" ? value : JSON.stringify(value);
        await this.api.storage.put(key, content);
      },
      readLegacy: async (key) => {
        const path = legacyPetalFilePath(key);
        const raw = await this.client.readWorkspaceJson(path);
        return parseWorkspaceJsonPayload(raw);
      },
    };
  }

  private status(): Record<string, unknown> {
    return {
      ready: true,
      product: "siyuanmaster",
      technicalId: "siyuanmaster",
      toolCount: this.registeredTools.length,
      accessMode: this.policy.access.mode,
      selectedNotebookCount:
        this.policy.access.selectedNotebookIds.length,
      taggingMode: this.policy.tagging.mode,
      safety: this.policy.safety,
      capabilities: {
        resolveDocument: true,
        readNoteSegments: true,
        editBlock: true,
        safeWriteTransaction: true,
        knowledgeRegistry: true,
        authorityLookup: true,
        wikiTemplates: true,
        sourceIngestPlan: true,
        permissionInheritance: this.policy.safety.permissionInheritance,
        referenceProtection: this.policy.safety.referenceProtection,
      },
    };
  }

  private async registerTool(
    name: string,
    config: kernel.IMcpToolConfig,
    handler: (input: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    await this.api.mcp.registerTool(name, config, handler);
    this.registeredTools.push(name);
  }

  private ensureOperation(
    operation: ControlledOperation,
    confirmed: boolean,
  ): void {
    const guard = evaluateOperation(
      this.policy,
      operation,
      confirmed,
    );
    if (guard.allowed) {
      return;
    }
    throw new PolicyViolation(
      guard.requiresConfirmation
        ? "confirmation_required"
        : "operation_denied",
      guard.reason ?? `Operation '${operation}' is unavailable`,
    );
  }

  private ensureOperationCanPreview(
    operation: ControlledOperation,
  ): void {
    if (this.policy.operations[operation] === "deny") {
      throw new PolicyViolation(
        "operation_denied",
        `Operation '${operation}' is denied by the active policy`,
      );
    }
  }

  private async listAllNotebooks(): Promise<NotebookSummary[]> {
    return this.client.listNotebooks();
  }

  private async assertNotebookAllowed(
    notebookIdValue: unknown,
  ): Promise<NotebookSummary> {
    const notebookId = assertSiyuanId(
      notebookIdValue,
      "notebookId",
    );
    const notebook = (await this.listAllNotebooks()).find(
      (item) => item.id === notebookId,
    );
    if (!notebook) {
      throw new PolicyViolation(
        "invalid_request",
        "Notebook was not found",
      );
    }
    if (!isNotebookAllowed(notebookId, this.policy)) {
      throw new PolicyViolation(
        "notebook_denied",
        "The requested notebook is outside the active SiYuanMaster policy",
      );
    }
    return notebook;
  }

  private async assertDocumentAllowed(
    documentIdValue: unknown,
  ): Promise<DocumentContext> {
    const documentId = assertSiyuanId(
      documentIdValue,
      "documentId",
    );
    const context = await this.client.getDocumentContext(documentId);
    // P0/P1 invariant: notebook permission applies to all descendant
    // documents and blocks. No document-level overrides.
    if (!isNotebookAllowed(context.document.box, this.policy)) {
      throw new PolicyViolation(
        "notebook_denied",
        "The requested document is outside the active SiYuanMaster access boundary",
      );
    }
    return context;
  }

  private async assertExactDocumentAllowed(
    documentIdValue: unknown,
    label = "documentId",
  ): Promise<DocumentContext> {
    const documentId = assertSiyuanId(documentIdValue, label);
    const context = await this.assertDocumentAllowed(documentId);
    if (
      context.requested.type !== "d" ||
      context.requested.id !== documentId
    ) {
      throw new PolicyViolation(
        "invalid_request",
        `${label} must identify a document, not a child block`,
      );
    }
    return context;
  }

  private createPreviewToken(): string {
    const values = new Uint32Array(4);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(values);
    } else {
      for (let index = 0; index < values.length; index += 1) {
        values[index] = Math.floor(Math.random() * 0xffffffff);
      }
    }
    return [...values]
      .map((value) => value.toString(36).padStart(7, "0"))
      .join("");
  }

  private saveStructurePreview<T extends StructurePreview>(
    preview: Omit<T, "token" | "expiresAt">,
  ): T {
    const now = Date.now();
    for (const [token, item] of this.structurePreviews.entries()) {
      if (item.expiresAt <= now) {
        this.structurePreviews.delete(token);
      }
    }
    const token = this.createPreviewToken();
    const stored = {
      ...preview,
      token,
      expiresAt: now + STRUCTURE_PREVIEW_TTL_MS,
    } as T;
    this.structurePreviews.set(token, stored);
    return stored;
  }

  private getStructurePreview<T extends StructurePreview>(
    tokenValue: unknown,
    kind: T["kind"],
  ): T {
    const token = stringInput(tokenValue, "previewToken", {
      maxLength: 128,
    }).trim();
    const preview = this.structurePreviews.get(token);
    if (!preview || preview.expiresAt <= Date.now()) {
      this.structurePreviews.delete(token);
      throw new PolicyViolation(
        "preview_expired",
        "The structural preview is missing or expired; request a new preview",
      );
    }
    if (preview.kind !== kind) {
      throw new PolicyViolation(
        "invalid_request",
        `previewToken is not valid for '${kind}'`,
      );
    }
    return preview as T;
  }

  private consumeStructurePreview<T extends StructurePreview>(
    tokenValue: unknown,
    kind: T["kind"],
  ): T {
    const preview = this.getStructurePreview<T>(tokenValue, kind);
    this.structurePreviews.delete(preview.token);
    return preview;
  }

  private async accessibleNotebookIds(): Promise<string[]> {
    return (await this.listAllNotebooks())
      .filter((notebook) =>
        isNotebookAllowed(notebook.id, this.policy),
      )
      .map((notebook) => notebook.id);
  }

  private async runTool<T>(
    operation: string,
    isReadOperation: boolean,
    metadata: ToolRunMetadata,
    task: () => Promise<T>,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await task();
      const tagCount =
        result &&
        typeof result === "object" &&
        "addedTags" in result &&
        Array.isArray((result as { addedTags?: unknown }).addedTags)
          ? (result as { addedTags: unknown[] }).addedTags.length
          : undefined;
      await this.audit.record(
        {
          operation,
          outcome: "allowed",
          ...metadata,
          tagCount,
        },
        isReadOperation,
      );
      return { ok: true, result };
    } catch (error) {
      const violation =
        error instanceof PolicyViolation ? error : undefined;
      const outcome: AuditEntry["outcome"] = violation
        ? violation.code === "confirmation_required" ||
          violation.code === "tag_decision_required"
          ? "confirmation_required"
          : "denied"
        : "failed";
      const message =
        error instanceof Error ? error.message : String(error);
      await this.audit.record(
        {
          operation,
          outcome,
          ...metadata,
          message,
        },
        isReadOperation,
      );
      return {
        ok: false,
        error: {
          code: violation?.code ?? "operation_failed",
          message,
        },
      };
    }
  }

  private async tagState(documentId: string): Promise<{
    attrs: Record<string, string>;
    tags: string[];
    alreadyTagged: boolean;
  }> {
    const attrs = await this.client.getBlockAttrs(documentId);
    return {
      attrs,
      tags: splitStoredTags(attrs.tags),
      alreadyTagged: isAlreadyTaggedOnce(attrs),
    };
  }

  private async ensureTagDecisionReady(
    operation: TaggableOperation,
    taggingInput: unknown,
    documentId?: string,
  ): Promise<void> {
    const state = documentId
      ? await this.tagState(documentId)
      : { tags: [], alreadyTagged: false };
    const plan = planTags(
      this.policy,
      operation,
      taggingInput,
      state.tags,
      state.alreadyTagged,
    );
    if (plan.action === "confirm") {
      throw new PolicyViolation("tag_decision_required", plan.reason);
    }
  }

  private async applyTags(
    documentId: string,
    operation: TaggableOperation,
    taggingInput: unknown,
  ): Promise<{ addedTags: string[]; reason: string }> {
    const state = await this.tagState(documentId);
    const plan = planTags(
      this.policy,
      operation,
      taggingInput,
      state.tags,
      state.alreadyTagged,
    );
    if (plan.action === "confirm") {
      throw new PolicyViolation("tag_decision_required", plan.reason);
    }
    if (plan.action !== "apply") {
      return { addedTags: [], reason: plan.reason };
    }
    const merged = mergeTags(state.tags, plan.tags);
    const attrs: Record<string, string> = {
      tags: merged.join(","),
    };
    if (this.policy.tagging.mode === "once") {
      attrs[TAGGED_ONCE_ATTR] = "true";
    }
    await this.client.setBlockAttrs(documentId, attrs);
    return { addedTags: plan.tags, reason: plan.reason };
  }

  private async registerPolicyTool(): Promise<void> {
    await this.registerTool(
      "get_policy",
      genericToolConfig(
        "Get SiYuanMaster Access Boundary Policy",
        "Call this before any SiYuan operation. Returns the notebook boundary, operation decisions, safety policy (snapshot, reference protection, long-document limits, block edit), optional tagging policy, and the accepted native MCP security boundary. Tool names are under plugin__siyuanmaster__* (technical plugin id siyuanmaster).",
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        true,
      ),
      async () => ({
        product: {
          brand: "siyuanmaster",
          displayName: { default: "SiYuanMaster", "zh-CN": "思源大师" },
          technicalId: "siyuanmaster",
          version: "0.6.0",
          namespace: "plugin__siyuanmaster__",
        },
        access: this.policy.access,
        operations: this.policy.operations,
        tagging: this.policy.tagging,
        safety: this.policy.safety,
        capabilities: {
          resolveDocument: "read-only path lookup; writes require exact IDs",
          readNoteSegments: "outline + full-block windows with hard limits",
          editBlock:
            "exact block ID + expected content/hash + reference impact + Safe Write Transaction",
          safeWriteTransaction:
            "snapshot → confirm → recheck → execute once → readback; no auto-retry on unknown",
          knowledgeRegistry:
            "metadata-only Source Manifest + Authority Registry with access-filtered status and deterministic candidates",
          authorityLookup:
            "registered source/title/alias/type lookup before broad note search",
          originalToolsPreserved: 16,
          totalTools: 27,
          wikiTemplates:
            "versioned catalog + preview-only renderer + structure validator; no note writes",
          sourceIngestPlan:
            "read-only single-source state machine; plans registry, discovery, template, verification, and later gated writes without executing them",
        },
        toolWorkflow: [
          "Call get_policy first.",
          "Use list_accessible_notebooks before choosing a notebook.",
          "Use list_document_tree for bounded structural browsing without note bodies.",
          "Use resolve_document only to look up a human path; never write by path.",
          "Use search_notes / read_note / read_note_segments for retrieval.",
          "When knowledgeRegistry is available, use find_wiki_candidates before broad search and register sources/authorities only when the current task authorizes metadata mutation.",
          "When wikiTemplates is available, list the creation gate, render a preview, fill the draft, validate it, and only then use a separately authorized create/update tool.",
          "Use plan_source_ingest to turn one exact Raw source plus registry/discovery evidence into a read-only state and ordered next-step plan; never treat planned mutations as executed or pre-authorized.",
          "For decisions marked confirm, obtain user approval before retrying with confirmed=true.",
          "In tag mode ask, pass tagging.decision='add' or 'skip' for each write.",
          "Use only plugin__siyuanmaster__* tools when policy enforcement is required.",
        ],
        acceptedRisk:
          "SiYuan native /mcp uses administrator-level authentication and also exposes native high-privilege tools outside this plugin's access boundary.",
      }),
    );
  }

  private async registerNotebookTool(): Promise<void> {
    await this.registerTool(
      "list_accessible_notebooks",
      genericToolConfig(
        "List Accessible SiYuan Notebooks",
        "Lists only notebooks allowed by the current policy. Denied notebook names and metadata are omitted.",
        {
          type: "object",
          properties: {
            includeClosed: {
              type: "boolean",
              description:
                "Include closed notebooks when they are allowed.",
            },
          },
          additionalProperties: false,
        },
        true,
      ),
      async (input) =>
        this.runTool(
          "list_accessible_notebooks",
          true,
          {},
          async () => {
            const includeClosed = input.includeClosed === true;
            const notebooks = (await this.listAllNotebooks()).filter(
              (notebook) =>
                isNotebookAllowed(notebook.id, this.policy) &&
                (includeClosed || !notebook.closed),
            );
            return {
              accessMode: this.policy.access.mode,
              count: notebooks.length,
              notebooks: notebooks.map((notebook) => ({
                id: notebook.id,
                name: notebook.name,
                closed: Boolean(notebook.closed),
                encrypted: Boolean(notebook.encrypted),
              })),
            };
          },
        ),
    );
  }

  private async registerDocumentTreeTool(): Promise<void> {
    await this.registerTool(
      "list_document_tree",
      genericToolConfig(
        "List Allowed Document Tree",
        "Returns a bounded document hierarchy from one allowed notebook or document. Only IDs, titles, paths, depth, update time, and child presence are returned; note bodies are never included.",
        {
          type: "object",
          properties: {
            notebookId: {
              type: "string",
              description: "Allowed notebook ID whose tree should be listed.",
            },
            parentDocumentId: {
              type: "string",
              description:
                "Optional exact document ID to use as the returned tree root.",
            },
            maxDepth: {
              type: "number",
              minimum: 1,
              maximum: 10,
              description:
                "Maximum relative depth, 1-10. Default 3. With a parentDocumentId, the selected root is depth 0.",
            },
            maxNodes: {
              type: "number",
              minimum: 1,
              maximum: 500,
              description: "Maximum returned documents, 1-500. Default 200.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["notebookId"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const notebookId =
          typeof input.notebookId === "string"
            ? input.notebookId
            : undefined;
        const parentDocumentId = optionalString(input.parentDocumentId);
        return this.runTool(
          "list_document_tree",
          true,
          {
            notebookId,
            documentId: parentDocumentId,
            confirmed,
          },
          async () => {
            this.ensureOperation("read", confirmed);
            const notebook = await this.assertNotebookAllowed(
              input.notebookId,
            );
            const parentContext = parentDocumentId
              ? await this.assertExactDocumentAllowed(
                  parentDocumentId,
                  "parentDocumentId",
                )
              : undefined;
            if (
              parentContext &&
              parentContext.document.box !== notebook.id
            ) {
              throw new PolicyViolation(
                "invalid_request",
                "parentDocumentId does not belong to notebookId",
              );
            }
            const maxDepth = boundedInteger(input.maxDepth, 3, 1, 10);
            const maxNodes = boundedInteger(input.maxNodes, 200, 1, 500);
            const listing = await this.client.listDocumentTree({
              notebookId: notebook.id,
              parentDocument: parentContext?.document,
              maxDepth,
              maxNodes,
            });
            const returnedCount = listing.rows.length;
            return {
              notebook: { id: notebook.id, name: notebook.name },
              rootDocumentId: parentContext?.document.id ?? null,
              maxDepth,
              maxNodes,
              totalCount: listing.totalCount,
              eligibleCount: listing.eligibleCount,
              returnedCount,
              truncated: returnedCount < listing.totalCount,
              truncatedByDepth:
                listing.eligibleCount < listing.totalCount,
              truncatedByNodeLimit:
                returnedCount < listing.eligibleCount,
              tree: buildDocumentTree(
                listing.rows,
                parentContext?.document.id,
              ),
            };
          },
        );
      },
    );
  }

  private async registerSearchTool(): Promise<void> {
    await this.registerTool(
      "search_notes",
      genericToolConfig(
        "Search Allowed Notes",
        "Searches only documents and blocks inside notebooks allowed by the active policy. Returns compact document-level matches; use read_note for full content.",
        {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Plain-text query, 1-256 characters.",
            },
            notebookId: {
              type: "string",
              description:
                "Optional allowed notebook ID to narrow the search.",
            },
            limit: {
              type: "number",
              description: "Maximum results, 1-50. Default 20.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["query"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        return this.runTool(
          "search",
          true,
          { confirmed },
          async () => {
            this.ensureOperation("search", confirmed);
            const query = stringInput(input.query, "query", {
              maxLength: 256,
            }).trim();
            const limit = boundedInteger(input.limit, 20, 1, 50);
            let notebookIds = await this.accessibleNotebookIds();
            if (input.notebookId !== undefined) {
              const notebook = await this.assertNotebookAllowed(
                input.notebookId,
              );
              notebookIds = [notebook.id];
            }
            if (notebookIds.length === 0) {
              return { count: 0, matches: [] };
            }

            const boxes = notebookIds
              .map((id) => `'${escapeSqlLiteral(id)}'`)
              .join(",");
            const pattern = `%${escapeSqlLiteral(query)}%`;
            const rows = await this.client.sql<SearchRow>(
              `SELECT
                 b.id AS matched_id,
                 b.root_id AS document_id,
                 b.box AS box,
                 d.hpath AS hpath,
                 d.content AS title,
                 d.tag AS tags,
                 b.content AS snippet,
                 b.type AS block_type,
                 b.updated AS updated
               FROM blocks b
               JOIN blocks d ON d.id = b.root_id
               WHERE b.box IN (${boxes})
                 AND (
                   COALESCE(b.content, '') LIKE '${pattern}'
                   OR COALESCE(b.name, '') LIKE '${pattern}'
                   OR COALESCE(b.tag, '') LIKE '${pattern}'
                 )
               ORDER BY b.updated DESC
               LIMIT ${limit * 3}`,
            );
            const seen = new Set<string>();
            const matches = rows
              .filter((row) => {
                if (seen.has(row.document_id)) {
                  return false;
                }
                seen.add(row.document_id);
                return true;
              })
              .slice(0, limit)
              .map((row) => ({
                documentId: row.document_id,
                matchedBlockId: row.matched_id,
                notebookId: row.box,
                title: row.title,
                hPath: row.hpath,
                tags: splitStoredTags(row.tags),
                snippet: row.snippet.slice(0, 360),
                blockType: row.block_type,
                updated: row.updated,
              }));
            return { count: matches.length, matches };
          },
        );
      },
    );
  }

  private async readDocumentResult(
    documentIdValue: unknown,
    maxCharsValue: unknown,
    confirmed: boolean,
  ): Promise<Record<string, unknown>> {
    this.ensureOperation("read", confirmed);
    const context = await this.assertDocumentAllowed(documentIdValue);
    const maxChars = boundedInteger(
      maxCharsValue,
      20_000,
      1_000,
      50_000,
    );
    const exported = await this.client.exportMarkdown(
      context.document.id,
    );
    const content = exported.content.slice(0, maxChars);
    return {
      documentId: context.document.id,
      notebookId: context.document.box,
      title: context.document.content,
      hPath: exported.hPath || context.document.hpath,
      tags: splitStoredTags(context.document.tag),
      content,
      contentLength: exported.content.length,
      truncated: content.length < exported.content.length,
      created: context.document.created,
      updated: context.document.updated,
    };
  }

  private async registerReadTool(): Promise<void> {
    await this.registerTool(
      "read_note",
      genericToolConfig(
        "Read Allowed Note",
        "Reads Markdown only after resolving the target block to its document and enforcing the notebook policy. Content is bounded for context safety.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description:
                "Document ID or a block ID inside the target document.",
            },
            maxChars: {
              type: "number",
              description:
                "Maximum Markdown characters returned, 1000-50000.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        return this.runTool(
          "read",
          true,
          { documentId, confirmed },
          () =>
            this.readDocumentResult(
              input.documentId,
              input.maxChars,
              confirmed,
            ),
        );
      },
    );
  }

  private async registerCreateTool(): Promise<void> {
    await this.registerTool(
      "create_note",
      genericToolConfig(
        "Create Note in Allowed Notebook",
        "Creates a Markdown document only in an allowed notebook. Tagging is optional and follows off/ask/always/once policy; no siyuanMCP tag is forced.",
        {
          type: "object",
          properties: {
            notebookId: { type: "string" },
            title: { type: "string" },
            parentPath: {
              type: "string",
              description:
                "Optional human-readable parent path such as /AI/Memory.",
            },
            markdown: { type: "string" },
            tagging: taggingProperty(),
            confirmed: confirmedProperty(),
          },
          required: ["notebookId", "title", "markdown"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const notebookId =
          typeof input.notebookId === "string"
            ? input.notebookId
            : undefined;
        const markdown =
          typeof input.markdown === "string"
            ? input.markdown
            : undefined;
        return this.runTool(
          "create",
          false,
          {
            notebookId,
            confirmed,
            contentLength: markdown?.length,
          },
          async () => {
            this.ensureOperation("create", confirmed);
            const notebook = await this.assertNotebookAllowed(
              input.notebookId,
            );
            const title = stringInput(input.title, "title", {
              maxLength: 256,
            });
            const content = stringInput(input.markdown, "markdown", {
              allowEmpty: true,
              maxLength: MAX_MARKDOWN_LENGTH,
            });
            await this.ensureTagDecisionReady(
              "create",
              input.tagging,
            );
            const documentId = await this.client.createDocument({
              notebookId: notebook.id,
              title,
              parentPath:
                typeof input.parentPath === "string"
                  ? input.parentPath
                  : undefined,
              markdown: content,
            });
            const tagResult = await this.applyTags(
              documentId,
              "create",
              input.tagging,
            );
            return {
              documentId,
              notebookId: notebook.id,
              title: title.trim(),
              ...tagResult,
            };
          },
        );
      },
    );
  }

  private async registerAppendTool(): Promise<void> {
    await this.registerTool(
      "append_note",
      genericToolConfig(
        "Append Markdown to Allowed Note",
        "Appends Markdown to an allowed document after operation and tag-policy checks. Existing tags are preserved.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            markdown: { type: "string" },
            tagging: taggingProperty(),
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "markdown"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        const markdown =
          typeof input.markdown === "string"
            ? input.markdown
            : undefined;
        return this.runTool(
          "append",
          false,
          {
            documentId,
            confirmed,
            contentLength: markdown?.length,
          },
          async () => {
            this.ensureOperation("append", confirmed);
            const context = await this.assertDocumentAllowed(
              input.documentId,
            );
            const content = stringInput(input.markdown, "markdown", {
              maxLength: MAX_MARKDOWN_LENGTH,
            });
            await this.ensureTagDecisionReady(
              "append",
              input.tagging,
              context.document.id,
            );
            await this.client.appendMarkdown(
              context.document.id,
              content,
            );
            const tagResult = await this.applyTags(
              context.document.id,
              "append",
              input.tagging,
            );
            return {
              documentId: context.document.id,
              appendedCharacters: content.length,
              ...tagResult,
            };
          },
        );
      },
    );
  }

  private async registerUpdateTool(): Promise<void> {
    await this.registerTool(
      "update_note",
      genericToolConfig(
        "Replace Allowed Note Markdown (Safe Write Transaction)",
        "Replaces the body of an allowed document with supplied Markdown. Runs through Safe Write Transaction: pre-write snapshot, confirmation when required, pre-execute state recheck, single execute, and readback verification. Audit never includes body text. By default this operation requires explicit user confirmation.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            markdown: { type: "string" },
            tagging: taggingProperty(),
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "markdown"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        const markdown =
          typeof input.markdown === "string"
            ? input.markdown
            : undefined;
        return this.runTool(
          "update",
          false,
          {
            documentId,
            confirmed,
            contentLength: markdown?.length,
          },
          async () => {
            // Deny is hard-stopped here; confirm is also enforced by the txn.
            if (this.policy.operations.update === "deny") {
              this.ensureOperation("update", confirmed);
            }
            const context = await this.assertDocumentAllowed(
              input.documentId,
            );
            const content = stringInput(input.markdown, "markdown", {
              allowEmpty: true,
              maxLength: MAX_MARKDOWN_LENGTH,
            });
            await this.ensureTagDecisionReady(
              "update",
              input.tagging,
              context.document.id,
            );
            const requireConfirmation =
              this.policy.operations.update === "confirm";
            const expectedHash = await computeContentHash(content);
            const txn = await runWriteTransaction({
              kind: "update_note",
              confirmed,
              requireConfirmation,
              expectedReadbackHash: expectedHash,
              io: {
                snapshot: async () => {
                  const exported = await this.client.exportMarkdown(
                    context.document.id,
                  );
                  return {
                    hash: await computeContentHash(exported.content),
                    updated: context.document.updated,
                  };
                },
                verifyCurrent: async () => {
                  const exported = await this.client.exportMarkdown(
                    context.document.id,
                  );
                  return computeContentHash(exported.content);
                },
                execute: async () => {
                  await this.client.updateDocument(
                    context.document.id,
                    content,
                  );
                },
                readback: async () => {
                  const exported = await this.client.exportMarkdown(
                    context.document.id,
                  );
                  return computeContentHash(exported.content);
                },
              },
            });
            if (txn.state === "awaiting_confirmation") {
              throw new PolicyViolation(
                "confirmation_required",
                txn.notice ??
                  "update_note requires confirmed=true after user approval",
              );
            }
            if (txn.state !== "committed") {
              throw new PolicyViolation(
                txn.error === "state_changed"
                  ? "state_changed"
                  : "invalid_request",
                txn.notice ??
                  `Safe Write Transaction ended in state ${txn.state}`,
              );
            }
            const tagResult = await this.applyTags(
              context.document.id,
              "update",
              input.tagging,
            );
            return {
              documentId: context.document.id,
              updatedCharacters: content.length,
              txnId: txn.record.id,
              txnState: txn.state,
              verified: true,
              ...tagResult,
            };
          },
        );
      },
    );
  }

  private async registerResolveDocumentTool(): Promise<void> {
    await this.registerTool(
      "resolve_document",
      genericToolConfig(
        "Resolve Document Path (Read-Only Lookup)",
        "Resolves a human-readable path such as /AI/Memory/note to document metadata inside an allowed notebook. Read-only: never mutates notes. Writes must still address targets by exact document/block ID plus expected state.",
        {
          type: "object",
          properties: {
            notebookId: {
              type: "string",
              description: "Allowed notebook ID that owns the path.",
            },
            hPath: {
              type: "string",
              description:
                "Absolute human-readable path such as /AI/Memory/note.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["notebookId", "hPath"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const notebookId =
          typeof input.notebookId === "string"
            ? input.notebookId
            : undefined;
        return this.runTool(
          "resolve_document",
          true,
          { notebookId, confirmed },
          async () => {
            this.ensureOperation("read", confirmed);
            const notebook = await this.assertNotebookAllowed(
              input.notebookId,
            );
            const hPath = stringInput(input.hPath, "hPath", {
              maxLength: 1024,
            }).trim();
            const resolved = await resolveDocumentPath(
              this.client,
              notebook.id,
              hPath,
            );
            // Enforce notebook boundary again on the resolved document.
            await this.assertDocumentAllowed(resolved.documentId);
            return {
              ...resolved,
              lookupOnly: true,
              writeByPath: false,
            };
          },
        );
      },
    );
  }

  private async registerReadNoteSegmentsTool(): Promise<void> {
    await this.registerTool(
      "read_note_segments",
      genericToolConfig(
        "Read Note Segments (Outline + Full Blocks)",
        "Reads an allowed note as an outline plus a hard-capped window of full display blocks. Limits come from safety.longDocument and cannot be exceeded by the caller. Optional includeStateHash attaches exact getBlockKramdown SHA-256 digests only for the returned window (never the full document).",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description:
                "Document ID or a block ID inside the target document.",
            },
            offset: {
              type: "number",
              description: "Block window start offset (0-based).",
            },
            limit: {
              type: "number",
              description:
                "Requested block window size; clamped by policy maxBlocksPerWindow.",
            },
            includeStateHash: {
              type: "boolean",
              description:
                "When true, attach a 64-char lowercase SHA-256 stateHash for each returned window block from getBlockKramdown (not SQL markdown). Default false — zero extra cost.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        return this.runTool(
          "read_note_segments",
          true,
          { documentId, confirmed },
          async () => {
            this.ensureOperation("read", confirmed);
            const context = await this.assertDocumentAllowed(
              input.documentId,
            );
            const limits = this.policy.safety.longDocument;
            const offset = boundedInteger(input.offset, 0, 0, 100_000);
            const requestedLimit = boundedInteger(
              input.limit,
              limits.maxBlocksPerWindow,
              1,
              limits.maxBlocksPerWindow,
            );
            const includeStateHash = input.includeStateHash === true;
            const rawBlocks = await this.client.listDocumentBlocks(
              context.document.id,
            );
            const blocks: BlockRow[] = rawBlocks.map((row) => {
              const blockType =
                row.subtype && /^h[1-6]$/.test(row.subtype)
                  ? row.subtype
                  : row.type;
              const text = (row.markdown || row.content || "").slice(
                0,
                limits.maxCharsPerBlock,
              );
              return {
                blockId: row.id,
                blockType,
                content: text,
                markdown: row.markdown
                  ? row.markdown.slice(0, limits.maxCharsPerBlock)
                  : undefined,
                sort: row.sort,
              };
            });
            const headings = blocks.filter(
              (block) => headingLike(block.blockType),
            );
            const outline = buildOutline(headings).slice(
              0,
              limits.maxOutlineBlocks,
            );
            const window = windowBlocks(blocks, offset, requestedLimit);
            // Window first; stateHash only for returned page (bounded concurrency).
            let pageBlocks = window.page.map((block) => ({
              blockId: block.blockId,
              blockType: block.blockType,
              text: blockDisplayText(block),
              truncated:
                (block.markdown?.length ?? block.content.length) >=
                limits.maxCharsPerBlock,
            }));
            if (includeStateHash) {
              pageBlocks = await attachBlockStateHashes(
                pageBlocks,
                (blockId) => this.client.getBlockKramdown(blockId),
                computeContentHash,
              );
            }
            return {
              documentId: context.document.id,
              notebookId: context.document.box,
              title: context.document.content,
              hPath: context.document.hpath,
              outline,
              outlineTruncated: headings.length > outline.length,
              blocks: pageBlocks,
              offset,
              limit: requestedLimit,
              nextOffset: window.nextOffset,
              totalBlocks: blocks.length,
              limits: {
                maxBlocksPerWindow: limits.maxBlocksPerWindow,
                maxCharsPerBlock: limits.maxCharsPerBlock,
                maxOutlineBlocks: limits.maxOutlineBlocks,
              },
            };
          },
        );
      },
    );
  }

  private async liveAccessibleKnowledgeRegistry(): Promise<KnowledgeRegistry> {
    const registry = await this.knowledgeRegistry.snapshot();
    const allowedNotebookIds = new Set(await this.accessibleNotebookIds());
    const liveDocuments = await this.client.listExactDocumentsByIds([
      ...registry.sources.map((source) => source.documentId),
      ...registry.authorities.map((authority) => authority.documentId),
      ...registry.authorities
        .map((authority) => authority.sourceContainerDocumentId)
        .filter((id): id is string => Boolean(id)),
    ]);
    return refreshAccessibleKnowledgeRegistry(
      registry,
      liveDocuments,
      allowedNotebookIds,
    );
  }

  private registryRequestError(error: unknown): never {
    if (error instanceof KnowledgeRegistryError) {
      throw new PolicyViolation("invalid_request", error.message);
    }
    throw error;
  }

  private ingestPlanRequestError(error: unknown): never {
    if (error instanceof IngestPlanError) {
      throw new PolicyViolation("invalid_request", error.message);
    }
    throw error;
  }

  private async registerKnowledgeSourceTool(): Promise<void> {
    await this.registerTool(
      "register_knowledge_source",
      genericToolConfig(
        "Register a Raw Knowledge Source",
        "Upserts one allowed SiYuan source document in the plugin-private Source Manifest. Stores only source metadata, processing state, hash/URL identity, and authority links; never stores the note body. Governed by update permission.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description: "Exact allowed Raw source document ID.",
            },
            sourceId: {
              type: "string",
              description:
                "Optional stable external identifier. Defaults to siyuan:<documentId>.",
            },
            sha256: {
              type: "string",
              description:
                "Optional lowercase SHA-256 for duplicate detection.",
            },
            canonicalUrl: {
              type: "string",
              description:
                "Optional canonical HTTP(S) source URL; fragments are removed.",
            },
            state: {
              type: "string",
              enum: [...SOURCE_STATES],
              description:
                "Processing state. Defaults to registered.",
            },
            authorityDocumentIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional complete set of already-registered Wiki authority document IDs linked to this source.",
            },
            operationId: {
              type: "string",
              description:
                "Optional idempotency/workflow correlation identifier.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId = optionalString(input.documentId);
        return this.runTool(
          "register_knowledge_source",
          false,
          { documentId, confirmed },
          async () => {
            this.ensureOperation("update", confirmed);
            const context = await this.assertExactDocumentAllowed(
              input.documentId,
            );
            const authorityDocumentIds = stringArrayInput(
              input.authorityDocumentIds,
              "authorityDocumentIds",
              256,
              64,
            );
            for (const authorityId of authorityDocumentIds) {
              await this.assertExactDocumentAllowed(
                authorityId,
                "authorityDocumentIds[]",
              );
            }
            const liveRegistry =
              await this.liveAccessibleKnowledgeRegistry();
            const accessibleDocumentIds = [
              context.document.id,
              ...authorityDocumentIds,
              ...liveRegistry.sources.map((source) => source.documentId),
              ...liveRegistry.authorities.map(
                (authority) => authority.documentId,
              ),
            ];
            try {
              return await this.knowledgeRegistry.registerSource({
                sourceId: sourceIdInput(
                  input.sourceId,
                  context.document.id,
                ),
                documentId: context.document.id,
                notebookId: context.document.box,
                title: context.document.content,
                hPath: context.document.hpath,
                sha256: optionalSha256(input.sha256),
                canonicalUrl: optionalCanonicalUrl(input.canonicalUrl),
                state:
                  input.state === undefined
                    ? "registered"
                    : (enumInput(
                        input.state,
                        "state",
                        SOURCE_STATES,
                      ) as SourceState),
                authorityDocumentIds:
                  input.authorityDocumentIds === undefined
                    ? undefined
                    : authorityDocumentIds,
                operationId:
                  input.operationId === undefined
                    ? undefined
                    : stringInput(input.operationId, "operationId", {
                        maxLength: 128,
                      }).trim(),
                accessibleDocumentIds,
              });
            } catch (error) {
              return this.registryRequestError(error);
            }
          },
        );
      },
    );
  }

  private async registerWikiAuthorityTool(): Promise<void> {
    await this.registerTool(
      "register_wiki_authority",
      genericToolConfig(
        "Register a Wiki Authority Page",
        "Upserts one allowed SiYuan Wiki page in the plugin-private Authority Registry and maintains bidirectional links to registered sources. It does not generate or edit Wiki content. Governed by update permission.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description: "Exact allowed Wiki document ID.",
            },
            aliases: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional retrieval aliases. Re-registration replaces the alias set.",
            },
            pageType: {
              type: "string",
              enum: [...WIKI_PAGE_TYPES],
            },
            knowledgeRole: {
              type: "string",
              enum: [...KNOWLEDGE_ROLES],
            },
            sourceContainerDocumentId: {
              type: "string",
              description:
                "Optional exact A-raw/source-container document ID in the same notebook.",
            },
            sourceIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional complete set of registered source IDs linked to this authority page.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "pageType", "knowledgeRole"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId = optionalString(input.documentId);
        return this.runTool(
          "register_wiki_authority",
          false,
          { documentId, confirmed },
          async () => {
            this.ensureOperation("update", confirmed);
            const context = await this.assertExactDocumentAllowed(
              input.documentId,
            );
            let sourceContainerDocumentId: string | undefined;
            if (input.sourceContainerDocumentId !== undefined) {
              const sourceContainer =
                await this.assertExactDocumentAllowed(
                  input.sourceContainerDocumentId,
                  "sourceContainerDocumentId",
                );
              if (
                sourceContainer.document.box !== context.document.box
              ) {
                throw new PolicyViolation(
                  "invalid_request",
                  "sourceContainerDocumentId must be in the same notebook as the authority page",
                );
              }
              if (
                sourceContainer.document.id === context.document.id
              ) {
                throw new PolicyViolation(
                  "invalid_request",
                  "sourceContainerDocumentId must be different from the authority document",
                );
              }
              sourceContainerDocumentId = sourceContainer.document.id;
            }
            const liveRegistry =
              await this.liveAccessibleKnowledgeRegistry();
            const accessibleDocumentIds = [
              context.document.id,
              ...(sourceContainerDocumentId
                ? [sourceContainerDocumentId]
                : []),
              ...liveRegistry.sources.map((source) => source.documentId),
              ...liveRegistry.authorities.map(
                (authority) => authority.documentId,
              ),
            ];
            try {
              return await this.knowledgeRegistry.registerAuthority({
                documentId: context.document.id,
                notebookId: context.document.box,
                title: context.document.content,
                hPath: context.document.hpath,
                aliases: stringArrayInput(
                  input.aliases,
                  "aliases",
                  32,
                  128,
                ),
                pageType: enumInput(
                  input.pageType,
                  "pageType",
                  WIKI_PAGE_TYPES,
                ) as WikiPageType,
                knowledgeRole: enumInput(
                  input.knowledgeRole,
                  "knowledgeRole",
                  KNOWLEDGE_ROLES,
                ) as KnowledgeRole,
                sourceContainerDocumentId,
                sourceIds:
                  input.sourceIds === undefined
                    ? undefined
                    : stringArrayInput(
                        input.sourceIds,
                        "sourceIds",
                        1024,
                        128,
                      ).map((item) => sourceIdInput(item, "unused")),
                accessibleDocumentIds,
              });
            } catch (error) {
              return this.registryRequestError(error);
            }
          },
        );
      },
    );
  }

  private async registerKnowledgeStatusTool(): Promise<void> {
    await this.registerTool(
      "knowledge_status",
      genericToolConfig(
        "Get Knowledge Registry Status",
        "Returns compact Source Manifest and Authority Registry counts for the active access boundary: source states, page types, linkage coverage, and last update. Never reads note bodies or exposes the global registry revision.",
        {
          type: "object",
          properties: {
            notebookId: {
              type: "string",
              description: "Optional allowed notebook filter.",
            },
            confirmed: confirmedProperty(),
          },
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const notebookId = optionalString(input.notebookId);
        return this.runTool(
          "knowledge_status",
          true,
          { notebookId, confirmed },
          async () => {
            this.ensureOperation("read", confirmed);
            if (notebookId) {
              await this.assertNotebookAllowed(notebookId);
            }
            return summarizeKnowledgeRegistry(
              await this.liveAccessibleKnowledgeRegistry(),
              await this.accessibleNotebookIds(),
              notebookId,
            );
          },
        );
      },
    );
  }

  private async registerFindWikiCandidatesTool(): Promise<void> {
    await this.registerTool(
      "find_wiki_candidates",
      genericToolConfig(
        "Find Registered Wiki Candidates",
        "Performs deterministic, low-context lookup over registered Wiki titles, aliases, types, and source links. It never searches or returns note bodies; empty results explicitly recommend search_notes as fallback.",
        {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Optional title, alias, or topic query. Required unless sourceId is supplied.",
            },
            sourceId: {
              type: "string",
              description:
                "Optional registered source ID for direct source-to-authority lookup.",
            },
            notebookId: {
              type: "string",
              description: "Optional allowed notebook filter.",
            },
            pageTypes: {
              type: "array",
              items: { type: "string", enum: [...WIKI_PAGE_TYPES] },
            },
            limit: {
              type: "number",
              description: "Maximum candidates, 1-20. Default 5.",
            },
            confirmed: confirmedProperty(),
          },
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const notebookId = optionalString(input.notebookId);
        return this.runTool(
          "find_wiki_candidates",
          true,
          { notebookId, confirmed },
          async () => {
            this.ensureOperation("read", confirmed);
            if (notebookId) {
              await this.assertNotebookAllowed(notebookId);
            }
            const query = optionalString(input.query);
            const sourceId = optionalString(input.sourceId);
            if (!query && !sourceId) {
              throw new PolicyViolation(
                "invalid_request",
                "query or sourceId is required",
              );
            }
            if (query && query.length > 256) {
              throw new PolicyViolation(
                "invalid_request",
                "query must not exceed 256 characters",
              );
            }
            const pageTypes = stringArrayInput(
              input.pageTypes,
              "pageTypes",
              WIKI_PAGE_TYPES.length,
              64,
            ).map(
              (item) =>
                enumInput(
                  item,
                  "pageTypes[]",
                  WIKI_PAGE_TYPES,
                ) as WikiPageType,
            );
            return findWikiCandidates(
              await this.liveAccessibleKnowledgeRegistry(),
              {
                query,
                sourceId: sourceId
                  ? sourceIdInput(sourceId, "unused")
                  : undefined,
                notebookId,
                pageTypes:
                  input.pageTypes === undefined ? undefined : pageTypes,
                limit: boundedInteger(input.limit, 5, 1, 20),
                allowedNotebookIds: await this.accessibleNotebookIds(),
              },
            );
          },
        );
      },
    );
  }

  private async registerListWikiTemplatesTool(): Promise<void> {
    await this.registerTool(
      "list_wiki_templates",
      genericToolConfig(
        "List Deterministic Wiki Templates",
        "Returns the versioned Wiki template catalog for one locale: page types, creation gates, purposes, metadata enums, and ordered required headings. It reads no note body and performs no write.",
        {
          type: "object",
          properties: {
            locale: {
              type: "string",
              enum: [...WIKI_TEMPLATE_LOCALES],
              description: "Template locale. Defaults to zh-CN.",
            },
            confirmed: confirmedProperty(),
          },
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        return this.runTool(
          "list_wiki_templates",
          true,
          { confirmed },
          async () => {
            this.ensureOperation("read", confirmed);
            const locale =
              input.locale === undefined
                ? undefined
                : (enumInput(
                    input.locale,
                    "locale",
                    WIKI_TEMPLATE_LOCALES,
                  ) as WikiTemplateLocale);
            return listWikiTemplates(locale);
          },
        );
      },
    );
  }

  private async registerRenderWikiTemplateTool(): Promise<void> {
    await this.registerTool(
      "render_wiki_template",
      genericToolConfig(
        "Render a Wiki Template Preview",
        "Renders a deterministic Markdown draft with metadata and ordered headings. The result is previewOnly/writeExecuted=false and never creates or updates a SiYuan note.",
        {
          type: "object",
          properties: {
            pageType: {
              type: "string",
              enum: [...WIKI_PAGE_TYPES],
            },
            title: { type: "string", maxLength: 256 },
            locale: {
              type: "string",
              enum: [...WIKI_TEMPLATE_LOCALES],
            },
            knowledgeRole: {
              type: "string",
              enum: [...KNOWLEDGE_ROLES],
            },
            aliases: {
              type: "array",
              maxItems: 32,
              items: { type: "string", maxLength: 256 },
            },
            canonicalDocumentId: {
              type: "string",
              description:
                "Optional exact SiYuan ID of the canonical page when it already exists.",
            },
            authorityDocumentId: {
              type: "string",
              description:
                "Optional exact authority-page ID, especially for a source summary.",
            },
            sourceContainerDocumentId: {
              type: "string",
              description: "Optional exact A-raw/source-container document ID.",
            },
            sourceIds: {
              type: "array",
              maxItems: 1024,
              items: { type: "string", maxLength: 128 },
            },
            status: { type: "string", enum: [...WIKI_STATUSES] },
            evidenceStatus: {
              type: "string",
              enum: [...WIKI_EVIDENCE_STATUSES],
            },
            reviewedAt: {
              type: "string",
              maxLength: 64,
              description: "Optional ISO date or timestamp.",
            },
            includeMetadata: {
              type: "boolean",
              description: "Defaults to true.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["pageType", "title", "knowledgeRole"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        return this.runTool(
          "render_wiki_template",
          true,
          { confirmed, preview: true },
          async () => {
            this.ensureOperation("read", confirmed);
            const exactOptionalId = (value: unknown, label: string) => {
              const id = optionalString(value);
              return id ? assertSiyuanId(id, label) : undefined;
            };
            return renderWikiTemplate({
              pageType: enumInput(
                input.pageType,
                "pageType",
                WIKI_PAGE_TYPES,
              ) as WikiPageType,
              title: stringInput(input.title, "title", {
                maxLength: 256,
              }),
              locale:
                input.locale === undefined
                  ? undefined
                  : (enumInput(
                      input.locale,
                      "locale",
                      WIKI_TEMPLATE_LOCALES,
                    ) as WikiTemplateLocale),
              knowledgeRole: enumInput(
                input.knowledgeRole,
                "knowledgeRole",
                KNOWLEDGE_ROLES,
              ) as KnowledgeRole,
              aliases: stringArrayInput(input.aliases, "aliases", 32, 256),
              canonicalDocumentId: exactOptionalId(
                input.canonicalDocumentId,
                "canonicalDocumentId",
              ),
              authorityDocumentId: exactOptionalId(
                input.authorityDocumentId,
                "authorityDocumentId",
              ),
              sourceContainerDocumentId: exactOptionalId(
                input.sourceContainerDocumentId,
                "sourceContainerDocumentId",
              ),
              sourceIds: stringArrayInput(
                input.sourceIds,
                "sourceIds",
                1024,
                128,
              ).map((item) => sourceIdInput(item, "unused")),
              status:
                input.status === undefined
                  ? undefined
                  : (enumInput(
                      input.status,
                      "status",
                      WIKI_STATUSES,
                    ) as WikiStatus),
              evidenceStatus:
                input.evidenceStatus === undefined
                  ? undefined
                  : (enumInput(
                      input.evidenceStatus,
                      "evidenceStatus",
                      WIKI_EVIDENCE_STATUSES,
                    ) as WikiEvidenceStatus),
              reviewedAt: optionalIsoDate(input.reviewedAt),
              includeMetadata: input.includeMetadata !== false,
            });
          },
        );
      },
    );
  }

  private async registerValidateWikiTemplateTool(): Promise<void> {
    await this.registerTool(
      "validate_wiki_template",
      genericToolConfig(
        "Validate a Wiki Template Draft",
        "Checks a Markdown draft against one deterministic Wiki template: H1, required H2 order/uniqueness, optional title, and metadata enums. It returns issues only and never writes a note.",
        {
          type: "object",
          properties: {
            pageType: { type: "string", enum: [...WIKI_PAGE_TYPES] },
            markdown: {
              type: "string",
              maxLength: MAX_MARKDOWN_LENGTH,
            },
            locale: {
              type: "string",
              enum: [...WIKI_TEMPLATE_LOCALES],
            },
            expectedTitle: { type: "string", maxLength: 256 },
            expectedKnowledgeRole: {
              type: "string",
              enum: [...KNOWLEDGE_ROLES],
            },
            requireMetadata: {
              type: "boolean",
              description: "Defaults to true.",
            },
            allowAdditionalHeadings: {
              type: "boolean",
              description:
                "Defaults to false; extra H2 headings are warnings, not errors.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["pageType", "markdown"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const markdown = stringInput(input.markdown, "markdown", {
          maxLength: MAX_MARKDOWN_LENGTH,
        });
        return this.runTool(
          "validate_wiki_template",
          true,
          { confirmed, contentLength: markdown.length, preview: true },
          async () => {
            this.ensureOperation("read", confirmed);
            return validateWikiTemplate({
              pageType: enumInput(
                input.pageType,
                "pageType",
                WIKI_PAGE_TYPES,
              ) as WikiPageType,
              markdown,
              locale:
                input.locale === undefined
                  ? undefined
                  : (enumInput(
                      input.locale,
                      "locale",
                      WIKI_TEMPLATE_LOCALES,
                    ) as WikiTemplateLocale),
              expectedTitle:
                input.expectedTitle === undefined
                  ? undefined
                  : stringInput(input.expectedTitle, "expectedTitle", {
                      maxLength: 256,
                    }),
              expectedKnowledgeRole:
                input.expectedKnowledgeRole === undefined
                  ? undefined
                  : (enumInput(
                      input.expectedKnowledgeRole,
                      "expectedKnowledgeRole",
                      KNOWLEDGE_ROLES,
                    ) as KnowledgeRole),
              requireMetadata: input.requireMetadata !== false,
              allowAdditionalHeadings:
                input.allowAdditionalHeadings === true,
            });
          },
        );
      },
    );
  }

  private async registerPlanSourceIngestTool(): Promise<void> {
    await this.registerTool(
      "plan_source_ingest",
      genericToolConfig(
        "Plan One Raw Source Ingest",
        "Builds a deterministic, read-only state and ordered workflow for one exact Raw document using the Source Manifest, Authority Registry, bounded discovery evidence, and Wiki templates. It never reads source/authority bodies, never calls a write API, and never authorizes the mutations listed in the plan.",
        {
          type: "object",
          properties: {
            sourceDocumentId: {
              type: "string",
              description: "Exact allowed immutable Raw document ID.",
            },
            sourceId: {
              type: "string",
              description:
                "Stable source identifier. Defaults to siyuan:<sourceDocumentId>.",
            },
            sha256: {
              type: "string",
              description: "Optional grounded 64-character SHA-256 digest.",
            },
            canonicalUrl: {
              type: "string",
              description:
                "Optional grounded canonical HTTP(S) URL without credentials.",
            },
            query: {
              type: "string",
              maxLength: 256,
              description:
                "Focused existing-Wiki title or alias query. Defaults to proposedWikiTitle or the Raw title.",
            },
            targetNotebookId: {
              type: "string",
              description:
                "Allowed notebook in which to find or eventually create the Wiki authority.",
            },
            selectedAuthorityDocumentId: {
              type: "string",
              description:
                "Optional exact allowed existing Wiki page selected after semantic review; it may be unregistered.",
            },
            proposedWikiTitle: {
              type: "string",
              maxLength: 256,
              description:
                "Required only for create_new after the creation gate passes.",
            },
            pageType: { type: "string", enum: [...WIKI_PAGE_TYPES] },
            knowledgeRole: {
              type: "string",
              enum: [...KNOWLEDGE_ROLES],
            },
            locale: {
              type: "string",
              enum: [...WIKI_TEMPLATE_LOCALES],
            },
            targetParentPath: {
              type: "string",
              maxLength: 2048,
              description:
                "Optional proposed human parent path for a future create; not resolved or written by this tool.",
            },
            discoveryState: {
              type: "string",
              enum: [...INGEST_DISCOVERY_STATES],
              description:
                "registry_only until focused search and bounded tree fallback have found no authority; use bounded_search_no_match only after that evidence exists.",
            },
            creationGateDecision: {
              type: "string",
              enum: [...CREATION_GATE_DECISIONS],
              description:
                "Semantic classification decision owned by the caller. The plugin never infers that the gate passed.",
            },
            candidateLimit: {
              type: "number",
              description: "Maximum registered candidates, 1-20. Default 5.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["sourceDocumentId", "targetNotebookId"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const sourceDocumentId = optionalString(input.sourceDocumentId);
        const targetNotebookId = optionalString(input.targetNotebookId);
        return this.runTool(
          "plan_source_ingest",
          true,
          {
            documentId: sourceDocumentId,
            targetNotebookId,
            confirmed,
            preview: true,
          },
          async () => {
            this.ensureOperation("read", confirmed);
            const sourceContext = await this.assertExactDocumentAllowed(
              input.sourceDocumentId,
              "sourceDocumentId",
            );
            const targetNotebook = await this.assertNotebookAllowed(
              input.targetNotebookId,
            );
            let selectedAuthority;
            if (input.selectedAuthorityDocumentId !== undefined) {
              const context = await this.assertExactDocumentAllowed(
                input.selectedAuthorityDocumentId,
                "selectedAuthorityDocumentId",
              );
              selectedAuthority = {
                documentId: context.document.id,
                notebookId: context.document.box,
                title: context.document.content,
                hPath: context.document.hpath,
              };
            }
            const registry = await this.liveAccessibleKnowledgeRegistry();
            const registeredSource = registry.sources.find(
              (source) => source.documentId === sourceContext.document.id,
            );
            const registeredAuthority = selectedAuthority
              ? registry.authorities.find(
                  (authority) =>
                    authority.documentId === selectedAuthority.documentId,
                )
              : undefined;
            try {
              return planSourceIngest({
                registry,
                allowedNotebookIds: await this.accessibleNotebookIds(),
                source: {
                  documentId: sourceContext.document.id,
                  notebookId: sourceContext.document.box,
                  title: sourceContext.document.content,
                  hPath: sourceContext.document.hpath,
                },
                sourceId: sourceIdInput(
                  input.sourceId ?? registeredSource?.sourceId,
                  sourceContext.document.id,
                ),
                sha256: optionalSha256(input.sha256),
                canonicalUrl: optionalCanonicalUrl(input.canonicalUrl),
                query:
                  input.query === undefined
                    ? undefined
                    : stringInput(input.query, "query", {
                        maxLength: 256,
                      }).trim(),
                targetNotebookId: targetNotebook.id,
                selectedAuthority: selectedAuthority
                  ? {
                      ...selectedAuthority,
                      registeredAuthority,
                    }
                  : undefined,
                proposedWikiTitle:
                  input.proposedWikiTitle === undefined
                    ? undefined
                    : documentTitleInput(input.proposedWikiTitle),
                pageType:
                  input.pageType === undefined
                    ? undefined
                    : (enumInput(
                        input.pageType,
                        "pageType",
                        WIKI_PAGE_TYPES,
                      ) as WikiPageType),
                knowledgeRole:
                  input.knowledgeRole === undefined
                    ? undefined
                    : (enumInput(
                        input.knowledgeRole,
                        "knowledgeRole",
                        KNOWLEDGE_ROLES,
                      ) as KnowledgeRole),
                locale:
                  input.locale === undefined
                    ? undefined
                    : (enumInput(
                        input.locale,
                        "locale",
                        WIKI_TEMPLATE_LOCALES,
                      ) as WikiTemplateLocale),
                targetParentPath:
                  input.targetParentPath === undefined
                    ? undefined
                    : stringInput(
                        input.targetParentPath,
                        "targetParentPath",
                        { allowEmpty: true, maxLength: 2048 },
                      ).trim(),
                discoveryState:
                  input.discoveryState === undefined
                    ? undefined
                    : (enumInput(
                        input.discoveryState,
                        "discoveryState",
                        INGEST_DISCOVERY_STATES,
                      ) as IngestDiscoveryState),
                creationGateDecision:
                  input.creationGateDecision === undefined
                    ? undefined
                    : (enumInput(
                        input.creationGateDecision,
                        "creationGateDecision",
                        CREATION_GATE_DECISIONS,
                      ) as CreationGateDecision),
                candidateLimit: boundedInteger(
                  input.candidateLimit,
                  5,
                  1,
                  20,
                ),
              });
            } catch (error) {
              return this.ingestPlanRequestError(error);
            }
          },
        );
      },
    );
  }

  private async registerEditBlockTool(): Promise<void> {
    await this.registerTool(
      "edit_block",
      genericToolConfig(
        "Edit Block (Exact ID + Expected State + Safe Write Transaction)",
        "Edits one block by exact SiYuan ID. Requires expectedContent or expectedHash, reports reference impact, requires confirmation by default, snapshots before write, rechecks state, executes once, and verifies via readback. Set validateOnly=true to run the full preflight atomically without any write API. Never writes by human path. Audit never includes body text.",
        {
          type: "object",
          properties: {
            blockId: {
              type: "string",
              description: "Exact SiYuan block ID to edit.",
            },
            markdown: {
              type: "string",
              description: "Replacement Markdown/kramdown for the block.",
            },
            expectedContent: {
              type: "string",
              description:
                "Expected current block content (or kramdown). Required when expectedHash is omitted and requireExpectedState is true.",
            },
            expectedHash: {
              type: "string",
              description:
                "Optional SHA-256 hex of the current block content. Alternative to expectedContent.",
            },
            validateOnly: {
              type: "boolean",
              description:
                "When true, run full expected-state and reference validation then return mode=validated without calling any write API (even if confirmed=true). Default false.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["blockId", "markdown"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const validateOnly = input.validateOnly === true;
        const blockId =
          typeof input.blockId === "string" ? input.blockId : undefined;
        const markdown =
          typeof input.markdown === "string" ? input.markdown : undefined;
        return this.runTool(
          "edit_block",
          false,
          {
            documentId: blockId,
            confirmed,
            contentLength: markdown?.length,
            // Metadata-only: AuditEntry.preview is boolean — mark validateOnly runs.
            // Never log bodies, hashes, refs, or tokens.
            preview: validateOnly,
          },
          async () => {
            // Policy-deny priority: fail before assertDocumentAllowed or any
            // existence/access read (getBlockKramdown, list refs, etc.).
            if (this.policy.operations.update === "deny") {
              this.ensureOperation("update", confirmed);
            }
            const content = stringInput(input.markdown, "markdown", {
              allowEmpty: true,
              maxLength: MAX_MARKDOWN_LENGTH,
            });
            const targetId = stringInput(input.blockId, "blockId");
            // Resolve access boundary only after deny is cleared.
            const context = await this.assertDocumentAllowed(targetId);
            try {
              return await performEditBlock(
                {
                  blockId: targetId,
                  markdown: content,
                  expectedContent:
                    typeof input.expectedContent === "string"
                      ? input.expectedContent
                      : undefined,
                  expectedHash:
                    typeof input.expectedHash === "string"
                      ? input.expectedHash
                      : undefined,
                  confirmed,
                  validateOnly,
                },
                {
                  requestedId: context.requested.id,
                  documentId: context.document.id,
                  notebookId: context.document.box,
                  updated: context.requested.updated,
                },
                {
                  operations: { update: this.policy.operations.update },
                  safety: {
                    blockEdit: this.policy.safety.blockEdit,
                    referenceProtection:
                      this.policy.safety.referenceProtection,
                  },
                },
                {
                  getBlockKramdown: (id) => this.client.getBlockKramdown(id),
                  listReferencingBlocks: async (id) =>
                    this.client.listReferencingBlocks(id),
                  updateBlockMarkdown: (id, md) =>
                    this.client.updateBlockMarkdown(id, md),
                },
              );
            } catch (error) {
              if (error instanceof EditBlockError) {
                throw new PolicyViolation(error.code, error.message);
              }
              throw error;
            }
          },
        );
      },
    );
  }

  private async assertNoNameCollision(
    notebookId: string,
    targetHPath: string,
    sourceDocumentId: string,
  ): Promise<void> {
    const collision = await this.client.findDocumentByHPath(
      notebookId,
      targetHPath,
      sourceDocumentId,
    );
    if (collision) {
      throw new PolicyViolation(
        "name_conflict",
        "A different document already uses the target human-readable path",
      );
    }
  }

  private async waitForStructureState(
    documentId: string,
    predicate: (document: BlockRecord) => boolean,
  ): Promise<BlockRecord> {
    let latest: BlockRecord | undefined;
    for (
      let attempt = 0;
      attempt < STRUCTURE_VERIFY_ATTEMPTS;
      attempt += 1
    ) {
      latest = (await this.client.getDocumentContext(documentId))
        .document;
      if (predicate(latest)) {
        return latest;
      }
      await delay(STRUCTURE_VERIFY_DELAY_MS);
    }
    throw new PolicyViolation(
      "state_changed",
      "SiYuan accepted the operation but the expected document state could not be verified",
    );
  }

  private renamePreviewResult(
    preview: RenamePreview,
  ): Record<string, unknown> {
    return {
      mode: "preview",
      previewToken: preview.token,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      source: preview.source,
      proposed: {
        newTitle: preview.newTitle,
        targetHPath: preview.targetHPath,
        subtreeDocumentCount: preview.subtreeDocumentCount,
      },
      policyDecision: this.policy.operations.rename,
      requiresUserConfirmation:
        this.policy.operations.rename === "confirm",
      nextStep:
        "If approved, call rename_note again with the same documentId and newTitle, this previewToken, and confirmed=true when the policy decision is confirm.",
    };
  }

  private async prepareRename(
    documentIdValue: unknown,
    newTitleValue: unknown,
  ): Promise<RenamePreview> {
    this.ensureOperationCanPreview("rename");
    const context = await this.assertExactDocumentAllowed(
      documentIdValue,
    );
    const newTitle = documentTitleInput(newTitleValue);
    if (newTitle === context.document.content) {
      throw new PolicyViolation(
        "invalid_request",
        "The new title is identical to the current title",
      );
    }
    const targetHPath = replaceHumanPathTitle(
      context.document.hpath,
      newTitle,
    );
    await this.assertNoNameCollision(
      context.document.box,
      targetHPath,
      context.document.id,
    );
    return this.saveStructurePreview<RenamePreview>({
      kind: "rename",
      source: snapshotDocument(context.document),
      newTitle,
      targetHPath,
      subtreeDocumentCount:
        await this.client.countDocumentTree(context.document),
    });
  }

  private async executeRename(
    input: Record<string, unknown>,
    confirmed: boolean,
  ): Promise<Record<string, unknown>> {
    const pending = this.getStructurePreview<RenamePreview>(
      input.previewToken,
      "rename",
    );
    this.ensureOperation("rename", confirmed);
    const documentId = assertSiyuanId(
      input.documentId,
      "documentId",
    );
    const newTitle = documentTitleInput(input.newTitle);
    if (
      pending.source.documentId !== documentId ||
      pending.newTitle !== newTitle
    ) {
      throw new PolicyViolation(
        "invalid_request",
        "The execution request does not match the prepared rename preview",
      );
    }

    const preview = this.consumeStructurePreview<RenamePreview>(
      input.previewToken,
      "rename",
    );
    const context = await this.assertExactDocumentAllowed(documentId);
    if (!previewMatchesCurrent(preview.source, context.document)) {
      throw new PolicyViolation(
        "state_changed",
        "The document changed after preview; request a new rename preview",
      );
    }
    await this.assertNoNameCollision(
      context.document.box,
      preview.targetHPath,
      context.document.id,
    );

    await this.client.renameDocument(context.document.id, newTitle);
    const after = await this.waitForStructureState(
      context.document.id,
      (document) =>
        document.content === newTitle &&
        document.hpath === preview.targetHPath &&
        document.box === preview.source.notebookId,
    );
    return {
      mode: "executed",
      documentId: after.id,
      notebookId: after.box,
      previousTitle: preview.source.title,
      title: after.content,
      previousHPath: preview.source.hPath,
      hPath: after.hpath,
      verified: true,
    };
  }

  private async registerRenameTool(): Promise<void> {
    await this.registerTool(
      "rename_note",
      genericToolConfig(
        "Safely Rename an Allowed Note",
        "Renames an allowed document through a two-step preview token. The preview checks policy, current state, subtree size, and target-name conflicts. Execution revalidates the snapshot and verifies the final title.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description:
                "Exact document ID. Child block IDs are rejected.",
            },
            newTitle: {
              type: "string",
              description: "Proposed document title, 1-256 characters.",
            },
            previewToken: {
              type: "string",
              description:
                "Omit to preview. Supply the one-time token returned by the preview to execute.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "newTitle"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const executing = Boolean(optionalString(input.previewToken));
        const confirmed = input.confirmed === true;
        const documentId = optionalString(input.documentId);
        return this.runTool(
          executing ? "rename" : "rename_preview",
          !executing,
          {
            documentId,
            confirmed,
            preview: !executing,
          },
          async () => {
            if (executing) {
              return this.executeRename(input, confirmed);
            }
            return this.renamePreviewResult(
              await this.prepareRename(
                input.documentId,
                input.newTitle,
              ),
            );
          },
        );
      },
    );
  }

  private movePreviewResult(
    preview: MovePreview,
  ): Record<string, unknown> {
    const moveDecision = this.policy.operations.move;
    const crossDecision = preview.crossNotebook
      ? this.policy.operations.moveAcrossNotebooks
      : undefined;
    return {
      mode: "preview",
      previewToken: preview.token,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      source: preview.source,
      destination: {
        notebookId: preview.targetNotebookId,
        parent: preview.targetParent,
        targetHPath: preview.targetHPath,
        crossNotebook: preview.crossNotebook,
      },
      subtreeDocumentCount: preview.subtreeDocumentCount,
      policyDecisions: {
        move: moveDecision,
        moveAcrossNotebooks: crossDecision,
      },
      requiresUserConfirmation:
        moveDecision === "confirm" || crossDecision === "confirm",
      nextStep:
        "If approved, call move_note again with the same source and destination, this previewToken, and confirmed=true when either active decision is confirm.",
    };
  }

  private async prepareMove(
    input: Record<string, unknown>,
  ): Promise<MovePreview> {
    this.ensureOperationCanPreview("move");
    const sourceContext = await this.assertExactDocumentAllowed(
      input.documentId,
    );
    const targetNotebook = await this.assertNotebookAllowed(
      input.targetNotebookId,
    );
    if (targetNotebook.closed) {
      throw new PolicyViolation(
        "invalid_request",
        "The target notebook is closed",
      );
    }

    const targetParentId = optionalString(
      input.targetParentDocumentId,
    );
    let targetParent: DocumentContext | undefined;
    if (targetParentId) {
      targetParent = await this.assertExactDocumentAllowed(
        targetParentId,
        "targetParentDocumentId",
      );
      if (targetParent.document.box !== targetNotebook.id) {
        throw new PolicyViolation(
          "invalid_request",
          "The target parent does not belong to targetNotebookId",
        );
      }
      if (
        isSameOrDescendantPath(
          targetParent.document.path,
          sourceContext.document.path,
        )
      ) {
        throw new PolicyViolation(
          "invalid_request",
          "A document cannot be moved into itself or its descendants",
        );
      }
    }

    const crossNotebook =
      sourceContext.document.box !== targetNotebook.id;
    if (crossNotebook) {
      this.ensureOperationCanPreview("moveAcrossNotebooks");
    }
    const targetId = targetParent?.document.id ?? targetNotebook.id;
    if (documentParentId(sourceContext.document) === targetId) {
      throw new PolicyViolation(
        "invalid_request",
        "The document is already in the requested parent location",
      );
    }

    const targetHPath = joinHumanPath(
      targetParent?.document.hpath ?? "",
      sourceContext.document.content,
    );
    await this.assertNoNameCollision(
      targetNotebook.id,
      targetHPath,
      sourceContext.document.id,
    );

    return this.saveStructurePreview<MovePreview>({
      kind: "move",
      source: snapshotDocument(sourceContext.document),
      targetNotebookId: targetNotebook.id,
      targetParent: targetParent
        ? snapshotDocument(targetParent.document)
        : undefined,
      targetHPath,
      crossNotebook,
      subtreeDocumentCount:
        await this.client.countDocumentTree(sourceContext.document),
    });
  }

  private async executeMove(
    input: Record<string, unknown>,
    confirmed: boolean,
  ): Promise<Record<string, unknown>> {
    const pending = this.getStructurePreview<MovePreview>(
      input.previewToken,
      "move",
    );
    this.ensureOperation("move", confirmed);
    if (pending.crossNotebook) {
      this.ensureOperation("moveAcrossNotebooks", confirmed);
    }

    const documentId = assertSiyuanId(
      input.documentId,
      "documentId",
    );
    const targetNotebookId = assertSiyuanId(
      input.targetNotebookId,
      "targetNotebookId",
    );
    const targetParentDocumentId = optionalString(
      input.targetParentDocumentId,
    );
    if (
      pending.source.documentId !== documentId ||
      pending.targetNotebookId !== targetNotebookId ||
      pending.targetParent?.documentId !== targetParentDocumentId
    ) {
      throw new PolicyViolation(
        "invalid_request",
        "The execution request does not match the prepared move preview",
      );
    }

    const preview = this.consumeStructurePreview<MovePreview>(
      input.previewToken,
      "move",
    );
    const sourceContext =
      await this.assertExactDocumentAllowed(documentId);
    if (!previewMatchesCurrent(preview.source, sourceContext.document)) {
      throw new PolicyViolation(
        "state_changed",
        "The source document changed after preview; request a new move preview",
      );
    }
    await this.assertNotebookAllowed(preview.targetNotebookId);

    let currentTargetParent: DocumentContext | undefined;
    if (preview.targetParent) {
      currentTargetParent = await this.assertExactDocumentAllowed(
        preview.targetParent.documentId,
        "targetParentDocumentId",
      );
      if (
        !previewMatchesCurrent(
          preview.targetParent,
          currentTargetParent.document,
        )
      ) {
        throw new PolicyViolation(
          "state_changed",
          "The target parent changed after preview; request a new move preview",
        );
      }
      if (
        currentTargetParent.document.box !==
        preview.targetNotebookId
      ) {
        throw new PolicyViolation(
          "state_changed",
          "The target parent is no longer in the prepared notebook",
        );
      }
      if (
        isSameOrDescendantPath(
          currentTargetParent.document.path,
          sourceContext.document.path,
        )
      ) {
        throw new PolicyViolation(
          "invalid_request",
          "A document cannot be moved into itself or its descendants",
        );
      }
    }
    await this.assertNoNameCollision(
      preview.targetNotebookId,
      preview.targetHPath,
      sourceContext.document.id,
    );

    const targetId =
      currentTargetParent?.document.id ?? preview.targetNotebookId;
    await this.client.moveDocument(sourceContext.document.id, targetId);
    const expectedParentDirectory = currentTargetParent
      ? documentDirectory(currentTargetParent.document.path)
      : "/";
    const after = await this.waitForStructureState(
      sourceContext.document.id,
      (document) =>
        document.box === preview.targetNotebookId &&
        documentParentDirectory(document.path) ===
          expectedParentDirectory &&
        document.hpath === preview.targetHPath,
    );
    return {
      mode: "executed",
      documentId: after.id,
      previousNotebookId: preview.source.notebookId,
      notebookId: after.box,
      previousPath: preview.source.path,
      path: after.path,
      previousHPath: preview.source.hPath,
      hPath: after.hpath,
      targetParentDocumentId:
        currentTargetParent?.document.id ?? null,
      crossNotebook: preview.crossNotebook,
      subtreeDocumentCount: preview.subtreeDocumentCount,
      verified: true,
    };
  }

  private async registerMoveTool(): Promise<void> {
    await this.registerTool(
      "move_note",
      genericToolConfig(
        "Safely Move an Allowed Note Tree",
        "Moves one document and its descendants through a two-step preview token. Source and destination notebooks must both be allowed. Cross-notebook moves have a separate policy and are denied by default.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description:
                "Exact source document ID. Its full descendant tree moves with it.",
            },
            targetNotebookId: {
              type: "string",
              description:
                "Allowed destination notebook ID.",
            },
            targetParentDocumentId: {
              type: "string",
              description:
                "Optional exact destination parent document ID. Omit to move to the notebook root.",
            },
            previewToken: {
              type: "string",
              description:
                "Omit to preview. Supply the one-time token returned by the preview to execute.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "targetNotebookId"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const executing = Boolean(optionalString(input.previewToken));
        const confirmed = input.confirmed === true;
        const documentId = optionalString(input.documentId);
        const targetNotebookId = optionalString(
          input.targetNotebookId,
        );
        return this.runTool(
          executing ? "move" : "move_preview",
          !executing,
          {
            documentId,
            targetNotebookId,
            confirmed,
            preview: !executing,
          },
          async () => {
            if (executing) {
              return this.executeMove(input, confirmed);
            }
            return this.movePreviewResult(
              await this.prepareMove(input),
            );
          },
        );
      },
    );
  }

  private async registerDeleteTool(): Promise<void> {
    await this.registerTool(
      "delete_note",
      genericToolConfig(
        "Delete Allowed Note",
        "Deletes an allowed document. This tool always requires confirmed=true and an exact expectedTitle match, even if the operation policy is allow.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            expectedTitle: {
              type: "string",
              description:
                "Exact current title returned by read_note.",
            },
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "expectedTitle", "confirmed"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        return this.runTool(
          "delete",
          false,
          { documentId, confirmed },
          async () => {
            if (!confirmed) {
              throw new PolicyViolation(
                "confirmation_required",
                "Deletion always requires explicit user confirmation",
              );
            }
            this.ensureOperation("delete", confirmed);
            const context = await this.assertDocumentAllowed(
              input.documentId,
            );
            const expectedTitle = stringInput(
              input.expectedTitle,
              "expectedTitle",
              { maxLength: 512 },
            );
            if (expectedTitle !== context.document.content) {
              throw new PolicyViolation(
                "invalid_request",
                "expectedTitle does not match the current document title",
              );
            }
            await this.client.removeDocument(context.document.id);
            return {
              documentId: context.document.id,
              deleted: true,
            };
          },
        );
      },
    );
  }

  private async registerApplyTagsTool(): Promise<void> {
    await this.registerTool(
      "apply_tags",
      genericToolConfig(
        "Apply Optional Tags to Allowed Note",
        "Appends custom or AI-generated tags to an allowed document without replacing existing tags. Obeys update permission and off/ask/always/once tag policy.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            tagging: taggingProperty(),
            confirmed: confirmedProperty(),
          },
          required: ["documentId", "tagging"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        return this.runTool(
          "apply_tags",
          false,
          { documentId, confirmed },
          async () => {
            this.ensureOperation("update", confirmed);
            const context = await this.assertDocumentAllowed(
              input.documentId,
            );
            const tagResult = await this.applyTags(
              context.document.id,
              "update",
              input.tagging,
            );
            return {
              documentId: context.document.id,
              ...tagResult,
            };
          },
        );
      },
    );
  }

  private async registerTagSuggestionTool(): Promise<void> {
    await this.registerTool(
      "suggest_tags",
      genericToolConfig(
        "Prepare or Validate AI Tag Suggestions",
        "Returns active AI-tagging constraints and normalizes candidate tags generated from final note content. It never writes tags.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description:
                "Optional allowed target document ID.",
            },
            title: { type: "string" },
            candidateTags: {
              type: "array",
              items: { type: "string" },
            },
            existingTags: {
              type: "array",
              items: { type: "string" },
            },
          },
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        return this.runTool(
          "suggest_tags",
          true,
          { documentId },
          async () => {
            let existingTags = normalizeTags(input.existingTags);
            if (documentId) {
              const context = await this.assertDocumentAllowed(
                documentId,
              );
              existingTags = (await this.tagState(context.document.id))
                .tags;
            }
            const candidates = normalizeTags(input.candidateTags)
              .filter((tag) => !existingTags.includes(tag))
              .slice(0, this.policy.tagging.ai.maxTags);
            return {
              documentId,
              mode: this.policy.tagging.mode,
              provider: this.policy.tagging.ai.provider,
              applyMode: this.policy.tagging.ai.applyMode,
              maxTags: this.policy.tagging.ai.maxTags,
              fixedTags: this.policy.tagging.fixedTags,
              existingTags,
              candidateTags: candidates,
              requiresConfirmation:
                this.policy.tagging.mode === "ask" ||
                this.policy.tagging.ai.applyMode === "propose",
              instruction:
                candidates.length === 0
                  ? "Generate concise retrieval-oriented tags from the final note content, then call suggest_tags again with candidateTags."
                  : "Use apply_tags or a write tool with tagging.decision='add' after any required user confirmation.",
            };
          },
        );
      },
    );
  }

  private async registerSummaryTool(): Promise<void> {
    await this.registerTool(
      "prepare_summary",
      genericToolConfig(
        "Prepare Allowed Note for AI Summary",
        "Reads an allowed note and returns bounded Markdown plus active summary-tag constraints. The calling Agent produces the summary; use update_note or create_note only after user intent is clear.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            maxChars: { type: "number" },
            confirmed: confirmedProperty(),
          },
          required: ["documentId"],
          additionalProperties: false,
        },
        true,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        return this.runTool(
          "summarize",
          true,
          { documentId, confirmed },
          async () => ({
            note: await this.readDocumentResult(
              input.documentId,
              input.maxChars,
              confirmed,
            ),
            summaryInstructions: [
              "Preserve decisions, unresolved questions, dates, names, links, and explicit action items.",
              "Separate facts from inference.",
              "Do not write the summary back unless the user requested persistence.",
            ],
            tagging: {
              enabled:
                this.policy.tagging.operations.summarize &&
                this.policy.tagging.mode !== "off",
              mode: this.policy.tagging.mode,
              ai: this.policy.tagging.ai,
            },
          }),
        );
      },
    );
  }

  private async registerMemoryTool(): Promise<void> {
    await this.registerTool(
      "save_memory",
      genericToolConfig(
        "Persist an AI Memory Note",
        "Persists a user-approved memory as a new note or appends it to an existing allowed memory document. This is a convenience workflow over create/append with the memory tag policy.",
        {
          type: "object",
          properties: {
            documentId: {
              type: "string",
              description:
                "Existing allowed memory document to append. Omit to create.",
            },
            notebookId: {
              type: "string",
              description:
                "Required when creating a new memory document.",
            },
            title: {
              type: "string",
              description:
                "Required when creating a new memory document.",
            },
            parentPath: { type: "string" },
            markdown: { type: "string" },
            tagging: taggingProperty(),
            confirmed: confirmedProperty(),
          },
          required: ["markdown"],
          additionalProperties: false,
        },
        false,
      ),
      async (input) => {
        const confirmed = input.confirmed === true;
        const content =
          typeof input.markdown === "string"
            ? input.markdown
            : undefined;
        const documentId =
          typeof input.documentId === "string"
            ? input.documentId
            : undefined;
        const notebookId =
          typeof input.notebookId === "string"
            ? input.notebookId
            : undefined;
        return this.runTool(
          "memory",
          false,
          {
            documentId,
            notebookId,
            confirmed,
            contentLength: content?.length,
          },
          async () => {
            const markdown = stringInput(
              input.markdown,
              "markdown",
              { maxLength: MAX_MARKDOWN_LENGTH },
            );
            if (documentId) {
              this.ensureOperation("append", confirmed);
              const context = await this.assertDocumentAllowed(
                documentId,
              );
              await this.ensureTagDecisionReady(
                "memory",
                input.tagging,
                context.document.id,
              );
              await this.client.appendMarkdown(
                context.document.id,
                markdown,
              );
              const tagResult = await this.applyTags(
                context.document.id,
                "memory",
                input.tagging,
              );
              return {
                mode: "append",
                documentId: context.document.id,
                ...tagResult,
              };
            }

            this.ensureOperation("create", confirmed);
            const notebook = await this.assertNotebookAllowed(
              input.notebookId,
            );
            const title = stringInput(input.title, "title", {
              maxLength: 256,
            });
            await this.ensureTagDecisionReady(
              "memory",
              input.tagging,
            );
            const createdId = await this.client.createDocument({
              notebookId: notebook.id,
              title,
              parentPath:
                typeof input.parentPath === "string"
                  ? input.parentPath
                  : undefined,
              markdown,
            });
            const tagResult = await this.applyTags(
              createdId,
              "memory",
              input.tagging,
            );
            return {
              mode: "create",
              documentId: createdId,
              notebookId: notebook.id,
              ...tagResult,
            };
          },
        );
      },
    );
  }

  private async registerAuditTool(): Promise<void> {
    await this.registerTool(
      "get_audit_log",
      genericToolConfig(
        "Get SiYuanMaster Audit Log",
        "Returns recent policy-aware plugin operations. Content is never stored in the audit log; only metadata, outcomes, lengths, and tag counts are recorded.",
        {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of entries, 1-200. Default 50.",
            },
          },
          additionalProperties: false,
        },
        true,
      ),
      async (input) =>
        this.runTool(
          "get_audit_log",
          true,
          {},
          async () => {
            const entries = await this.audit.list(
              boundedInteger(input.limit, 50, 1, 200),
            );
            return { count: entries.length, entries };
          },
        ),
    );
  }
}

new SiYuanMasterKernelPlugin();
