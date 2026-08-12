import {
  findWikiCandidates,
  normalizeKnowledgeRegistry,
  type KnowledgeRegistry,
  type KnowledgeRole,
  type KnowledgeSourceRecord,
  type WikiAuthorityRecord,
  type WikiCandidate,
  type WikiPageType,
} from "./knowledge-registry";
import {
  renderWikiTemplate,
  type WikiTemplateLocale,
} from "./wiki-template";

export const INGEST_PLAN_SCHEMA_VERSION = 1;
export const INGEST_PLAN_VERSION = "1.0.0";
export const INGEST_DISCOVERY_STATES = [
  "registry_only",
  "bounded_search_no_match",
] as const;
export const CREATION_GATE_DECISIONS = [
  "undecided",
  "passed",
  "failed",
] as const;
export const INGEST_PLAN_STATES = [
  "duplicate_source",
  "source_review_required",
  "already_ingested",
  "update_existing",
  "select_existing",
  "fallback_search_required",
  "creation_gate_required",
  "creation_details_required",
  "create_new",
  "keep_raw",
] as const;

export type IngestDiscoveryState =
  (typeof INGEST_DISCOVERY_STATES)[number];
export type CreationGateDecision =
  (typeof CREATION_GATE_DECISIONS)[number];
export type IngestPlanState = (typeof INGEST_PLAN_STATES)[number];

export interface IngestDocumentMetadata {
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
}

export interface SelectedIngestAuthority extends IngestDocumentMetadata {
  registeredAuthority?: WikiAuthorityRecord;
}

export interface PlanSourceIngestInput {
  registry: unknown;
  allowedNotebookIds: Iterable<string>;
  source: IngestDocumentMetadata;
  sourceId: string;
  sha256?: string;
  canonicalUrl?: string;
  query?: string;
  targetNotebookId: string;
  selectedAuthority?: SelectedIngestAuthority;
  proposedWikiTitle?: string;
  pageType?: WikiPageType;
  knowledgeRole?: KnowledgeRole;
  locale?: WikiTemplateLocale;
  targetParentPath?: string;
  discoveryState?: IngestDiscoveryState;
  creationGateDecision?: CreationGateDecision;
  candidateLimit?: number;
}

export interface PlannedIngestOperation {
  kind:
    | "register_source"
    | "read_authority"
    | "draft_authority_update"
    | "update_authority"
    | "render_template"
    | "validate_template"
    | "create_authority"
    | "readback_authority"
    | "register_authority"
    | "mark_source_ingested";
  tool: string | null;
  mutation: boolean;
  targetDocumentId?: string;
  dependsOn?: string[];
  reason: string;
}

export class IngestPlanError extends Error {
  constructor(
    readonly code:
      | "source_outside_access"
      | "source_role_conflict"
      | "source_identity_conflict"
      | "target_outside_access"
      | "target_matches_source"
      | "target_metadata_mismatch",
    message: string,
  ) {
    super(message);
  }
}

function sourceSummary(record: KnowledgeSourceRecord | undefined) {
  return record
    ? {
        sourceId: record.sourceId,
        documentId: record.documentId,
        notebookId: record.notebookId,
        title: record.title,
        hPath: record.hPath,
        registered: true,
        state: record.state,
        authorityDocumentIds: record.authorityDocumentIds,
      }
    : undefined;
}

function authoritySummary(record: WikiAuthorityRecord) {
  return {
    documentId: record.documentId,
    notebookId: record.notebookId,
    title: record.title,
    hPath: record.hPath,
    aliases: record.aliases,
    pageType: record.pageType,
    knowledgeRole: record.knowledgeRole,
    sourceCount: record.sourceIds.length,
    registered: true,
  };
}

function candidateFromAuthority(
  authority: WikiAuthorityRecord,
  sourceId: string,
): WikiCandidate {
  return {
    documentId: authority.documentId,
    notebookId: authority.notebookId,
    title: authority.title,
    hPath: authority.hPath,
    aliases: authority.aliases,
    pageType: authority.pageType,
    knowledgeRole: authority.knowledgeRole,
    sourceCount: authority.sourceIds.length,
    score: 1_000,
    matchedOn: authority.sourceIds.includes(sourceId)
      ? ["source:linked"]
      : ["document:selected"],
  };
}

function duplicateSource(
  registry: KnowledgeRegistry,
  input: PlanSourceIngestInput,
): { record: KnowledgeSourceRecord; matchedBy: string[] } | undefined {
  const allowed = new Set(input.allowedNotebookIds);
  const candidates = registry.sources.filter(
    (record) =>
      allowed.has(record.notebookId) &&
      record.documentId !== input.source.documentId,
  );
  for (const record of candidates) {
    const matchedBy: string[] = [];
    if (record.sourceId === input.sourceId) {
      matchedBy.push("sourceId");
    }
    if (input.sha256 && record.sha256 === input.sha256) {
      matchedBy.push("sha256");
    }
    if (input.canonicalUrl && record.canonicalUrl === input.canonicalUrl) {
      matchedBy.push("canonicalUrl");
    }
    if (matchedBy.length > 0) {
      return { record, matchedBy };
    }
  }
  return undefined;
}

function registrationOperation(
  sourceRegistered: boolean,
): PlannedIngestOperation[] {
  return sourceRegistered
    ? []
    : [
        {
          kind: "register_source",
          tool: "register_knowledge_source",
          mutation: true,
          reason:
            "Register the exact immutable Raw document before semantic synthesis; this remains a separately authorized metadata mutation.",
        },
      ];
}

function updateOperations(
  target: SelectedIngestAuthority,
  sourceRegistered: boolean,
): PlannedIngestOperation[] {
  return [
    ...registrationOperation(sourceRegistered),
    {
      kind: "read_authority",
      tool: "read_note_segments",
      mutation: false,
      targetDocumentId: target.documentId,
      reason:
        "Read the selected authority selectively before drafting any change.",
    },
    {
      kind: "draft_authority_update",
      tool: null,
      mutation: false,
      targetDocumentId: target.documentId,
      dependsOn: ["read_authority"],
      reason:
        "The model drafts the smallest source-grounded update and keeps fact, inference, judgment, uncertainty, and contradiction distinct.",
    },
    {
      kind: "update_authority",
      tool: "update_note",
      mutation: true,
      targetDocumentId: target.documentId,
      dependsOn: ["draft_authority_update"],
      reason:
        "Apply only after policy, confirmation, tagging, expected-state, and readback gates pass.",
    },
    {
      kind: "readback_authority",
      tool: "read_note",
      mutation: false,
      targetDocumentId: target.documentId,
      dependsOn: ["update_authority"],
      reason: "Verify the real SiYuan document after the write.",
    },
    ...(!target.registeredAuthority
      ? [
          {
            kind: "register_authority" as const,
            tool: "register_wiki_authority",
            mutation: true,
            targetDocumentId: target.documentId,
            dependsOn: ["readback_authority"],
            reason:
              "Register the selected existing Wiki page only after its exact content and classification are verified.",
          },
        ]
      : []),
    {
      kind: "mark_source_ingested",
      tool: "register_knowledge_source",
      mutation: true,
      dependsOn: [
        target.registeredAuthority
          ? "readback_authority"
          : "register_authority",
      ],
      reason:
        "Mark the source ingested only after a verified authority link exists.",
    },
  ];
}

function createOperations(sourceRegistered: boolean): PlannedIngestOperation[] {
  return [
    ...registrationOperation(sourceRegistered),
    {
      kind: "render_template",
      tool: "render_wiki_template",
      mutation: false,
      reason: "Start from the selected deterministic template preview.",
    },
    {
      kind: "validate_template",
      tool: "validate_wiki_template",
      mutation: false,
      dependsOn: ["render_template"],
      reason:
        "Validate the completed source-grounded draft before any real write.",
    },
    {
      kind: "create_authority",
      tool: "create_note",
      mutation: true,
      dependsOn: ["validate_template"],
      reason:
        "Create one canonical page only after the creation and write gates pass.",
    },
    {
      kind: "readback_authority",
      tool: "read_note",
      mutation: false,
      dependsOn: ["create_authority"],
      reason: "Verify the exact new document and its source section.",
    },
    {
      kind: "register_authority",
      tool: "register_wiki_authority",
      mutation: true,
      dependsOn: ["readback_authority"],
      reason:
        "Register the new exact authority ID and link it to the source after readback.",
    },
    {
      kind: "mark_source_ingested",
      tool: "register_knowledge_source",
      mutation: true,
      dependsOn: ["register_authority"],
      reason:
        "Mark the source ingested only after the bidirectional link exists.",
    },
  ];
}

function withImpact<
  T extends Record<string, unknown> & {
    plannedOperations: PlannedIngestOperation[];
  },
>(plan: T) {
  const affectedExistingWikiDocumentIds = [
    ...new Set(
      plan.plannedOperations.flatMap((operation) =>
        operation.targetDocumentId ? [operation.targetDocumentId] : [],
      ),
    ),
  ];
  return {
    ...plan,
    impact: {
      affectedExistingWikiDocumentIds,
      proposesNewWikiDocument: plan.state === "create_new",
      sourceRegistrationPlanned: plan.plannedOperations.some(
        (operation) => operation.kind === "register_source",
      ),
      plannedMutationCount: plan.plannedOperations.filter(
        (operation) => operation.mutation,
      ).length,
      writeExecuted: false,
    },
  };
}

export function planSourceIngest(
  input: PlanSourceIngestInput,
): Record<string, unknown> {
  const registry = normalizeKnowledgeRegistry(input.registry);
  const allowed = new Set(input.allowedNotebookIds);
  if (!allowed.has(input.source.notebookId)) {
    throw new IngestPlanError(
      "source_outside_access",
      "The Raw source is outside the active access boundary",
    );
  }
  if (!allowed.has(input.targetNotebookId)) {
    throw new IngestPlanError(
      "target_outside_access",
      "The target notebook is outside the active access boundary",
    );
  }
  if (
    registry.authorities.some(
      (authority) => authority.documentId === input.source.documentId,
    )
  ) {
    throw new IngestPlanError(
      "source_role_conflict",
      "The selected Raw document is already registered as a Wiki authority",
    );
  }
  if (input.selectedAuthority?.documentId === input.source.documentId) {
    throw new IngestPlanError(
      "target_matches_source",
      "The Wiki target must be different from the immutable Raw source",
    );
  }

  const sourceRecord = registry.sources.find(
    (source) => source.documentId === input.source.documentId,
  );
  if (
    sourceRecord &&
    (sourceRecord.sourceId !== input.sourceId ||
      (sourceRecord.sha256 &&
        input.sha256 &&
        sourceRecord.sha256 !== input.sha256) ||
      (sourceRecord.canonicalUrl &&
        input.canonicalUrl &&
        sourceRecord.canonicalUrl !== input.canonicalUrl))
  ) {
    throw new IngestPlanError(
      "source_identity_conflict",
      "The supplied source identity conflicts with the registered Raw document",
    );
  }
  const duplicate = sourceRecord ? undefined : duplicateSource(registry, input);
  const discoveryState = input.discoveryState ?? "registry_only";
  const creationGateDecision =
    input.creationGateDecision ?? "undecided";
  const query = input.query ?? input.proposedWikiTitle ?? input.source.title;
  const linkedAuthorities = sourceRecord
    ? sourceRecord.authorityDocumentIds.flatMap((documentId) => {
        const authority = registry.authorities.find(
          (candidate) => candidate.documentId === documentId,
        );
        return authority &&
          allowed.has(authority.notebookId) &&
          authority.notebookId === input.targetNotebookId
          ? [authority]
          : [];
      })
    : [];
  const candidateResult = findWikiCandidates(registry, {
    query,
    sourceId: sourceRecord?.sourceId,
    notebookId: input.targetNotebookId,
    pageTypes: input.pageType ? [input.pageType] : undefined,
    limit: Math.min(20, Math.max(1, Math.trunc(input.candidateLimit ?? 5))),
    allowedNotebookIds: allowed,
  });
  const candidates = linkedAuthorities.length
    ? linkedAuthorities.map((authority) =>
        candidateFromAuthority(authority, sourceRecord?.sourceId ?? input.sourceId),
      )
    : candidateResult.candidates;

  let selectedAuthority = input.selectedAuthority;
  if (!selectedAuthority && linkedAuthorities.length === 1) {
    const authority = linkedAuthorities[0];
    selectedAuthority = {
      documentId: authority.documentId,
      notebookId: authority.notebookId,
      title: authority.title,
      hPath: authority.hPath,
      registeredAuthority: authority,
    };
  }
  if (selectedAuthority) {
    if (!allowed.has(selectedAuthority.notebookId)) {
      throw new IngestPlanError(
        "target_outside_access",
        "The selected Wiki target is outside the active access boundary",
      );
    }
    if (selectedAuthority.notebookId !== input.targetNotebookId) {
      throw new IngestPlanError(
        "target_metadata_mismatch",
        "The selected Wiki target is not in the requested target notebook",
      );
    }
    const registered = registry.authorities.find(
      (authority) => authority.documentId === selectedAuthority?.documentId,
    );
    if (
      selectedAuthority.registeredAuthority &&
      registered?.documentId !== selectedAuthority.registeredAuthority.documentId
    ) {
      throw new IngestPlanError(
        "target_metadata_mismatch",
        "Selected authority metadata does not match the registry",
      );
    }
    selectedAuthority = {
      ...selectedAuthority,
      registeredAuthority: registered,
    };
  }

  const source = sourceRecord
    ? sourceSummary(sourceRecord)
    : {
        sourceId: input.sourceId,
        ...input.source,
        registered: false,
        state: null,
        authorityDocumentIds: [],
      };
  const base = {
    schemaVersion: INGEST_PLAN_SCHEMA_VERSION,
    planVersion: INGEST_PLAN_VERSION,
    source,
    discovery: {
      state: discoveryState,
      query,
      targetNotebookId: input.targetNotebookId,
      candidates,
      linkedAuthorityCount: linkedAuthorities.length,
      registryFallbackRecommended: candidateResult.fallbackRecommended,
    },
    gates: {
      creationGateDecision,
      policyRecheckRequiredBeforeMutation: true,
      semanticSelectionOwnedByCaller: true,
    },
    citationImpact: {
      sourceId: sourceRecord?.sourceId ?? input.sourceId,
      rawDocumentId: input.source.documentId,
      userVisibleSourceLinkRequired: true,
      registryLinksAreNotCitations: true,
      claimLevelEvidenceIndexed: false,
    },
    previewOnly: true,
    writeExecuted: false,
  };

  if (duplicate) {
    return withImpact({
      ...base,
      state: "duplicate_source" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      duplicate: {
        matchedBy: duplicate.matchedBy,
        source: sourceSummary(duplicate.record),
      },
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: [],
      blockers: [
        "Reuse or inspect the registered Raw source; do not create or register a duplicate.",
      ],
      nextTools: ["read_note", "find_wiki_candidates"],
    });
  }

  if (sourceRecord?.state === "failed") {
    return withImpact({
      ...base,
      state: "source_review_required" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: [],
      blockers: [
        "Review the prior ingest failure and current source integrity before producing a new write plan.",
      ],
      nextTools: ["get_audit_log", "read_note"],
    });
  }

  if (selectedAuthority) {
    const linked = sourceRecord?.authorityDocumentIds.includes(
      selectedAuthority.documentId,
    );
    if (sourceRecord?.state === "ingested" && linked) {
      return withImpact({
        ...base,
        state: "already_ingested" satisfies IngestPlanState,
        readyForWorkflow: false,
        readyForMutation: false,
        selectedTarget: selectedAuthority.registeredAuthority
          ? authoritySummary(selectedAuthority.registeredAuthority)
          : selectedAuthority,
        templatePreview: null,
        plannedOperations: [],
        blockers: [],
        nextTools: [],
      });
    }
    const pageType =
      selectedAuthority.registeredAuthority?.pageType ?? input.pageType;
    const knowledgeRole =
      selectedAuthority.registeredAuthority?.knowledgeRole ??
      input.knowledgeRole;
    const missingClassification = [
      ...(!pageType ? ["pageType"] : []),
      ...(!knowledgeRole ? ["knowledgeRole"] : []),
    ];
    if (!selectedAuthority.registeredAuthority && missingClassification.length) {
      return withImpact({
        ...base,
        state: "creation_details_required" satisfies IngestPlanState,
        readyForWorkflow: false,
        readyForMutation: false,
        selectedTarget: {
          ...selectedAuthority,
          registered: false,
        },
        templatePreview: null,
        plannedOperations: [],
        blockers: missingClassification.map(
          (field) =>
            `${field} is required to register the selected existing Wiki page after verification.`,
        ),
        nextTools: ["list_wiki_templates"],
      });
    }
    return withImpact({
      ...base,
      state: "update_existing" satisfies IngestPlanState,
      readyForWorkflow: true,
      readyForMutation: false,
      selectedTarget: selectedAuthority.registeredAuthority
        ? authoritySummary(selectedAuthority.registeredAuthority)
        : {
            ...selectedAuthority,
            pageType,
            knowledgeRole,
            registered: false,
          },
      templatePreview: null,
      plannedOperations: updateOperations(
        selectedAuthority,
        Boolean(sourceRecord),
      ),
      blockers: [],
      nextTools: ["read_note_segments"],
    });
  }

  if (sourceRecord?.state === "ingested" && linkedAuthorities.length > 0) {
    return withImpact({
      ...base,
      state: "already_ingested" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: [],
      blockers: [],
      nextTools: [],
    });
  }

  if (candidates.length > 0) {
    return withImpact({
      ...base,
      state: "select_existing" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: registrationOperation(Boolean(sourceRecord)),
      blockers: [
        "Select and selectively read the correct existing authority; candidate ranking is not a semantic merge decision.",
      ],
      nextTools: ["read_note_segments", "plan_source_ingest"],
    });
  }

  if (discoveryState === "registry_only") {
    return withImpact({
      ...base,
      state: "fallback_search_required" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: registrationOperation(Boolean(sourceRecord)),
      blockers: [
        "A registry miss is not proof that no Wiki exists; complete focused search and bounded structural fallback before creation.",
      ],
      nextTools: ["search_notes", "list_document_tree", "plan_source_ingest"],
    });
  }

  if (creationGateDecision === "failed") {
    return withImpact({
      ...base,
      state: "keep_raw" satisfies IngestPlanState,
      readyForWorkflow: Boolean(!sourceRecord),
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: registrationOperation(Boolean(sourceRecord)),
      blockers: [],
      nextTools: sourceRecord ? [] : ["register_knowledge_source"],
    });
  }

  if (creationGateDecision === "undecided") {
    return withImpact({
      ...base,
      state: "creation_gate_required" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: registrationOperation(Boolean(sourceRecord)),
      blockers: [
        "The classification layer must decide whether the source warrants a durable independent Wiki page.",
      ],
      nextTools: ["list_wiki_templates", "plan_source_ingest"],
    });
  }

  const missingDetails = [
    ...(!input.proposedWikiTitle ? ["proposedWikiTitle"] : []),
    ...(!input.pageType ? ["pageType"] : []),
    ...(!input.knowledgeRole ? ["knowledgeRole"] : []),
  ];
  if (missingDetails.length > 0) {
    return withImpact({
      ...base,
      state: "creation_details_required" satisfies IngestPlanState,
      readyForWorkflow: false,
      readyForMutation: false,
      selectedTarget: null,
      templatePreview: null,
      plannedOperations: registrationOperation(Boolean(sourceRecord)),
      blockers: missingDetails.map(
        (field) => `${field} is required for a deterministic create plan.`,
      ),
      nextTools: ["list_wiki_templates", "plan_source_ingest"],
    });
  }

  const templatePreview = renderWikiTemplate({
    pageType: input.pageType!,
    title: input.proposedWikiTitle!,
    locale: input.locale,
    knowledgeRole: input.knowledgeRole!,
    sourceIds: [sourceRecord?.sourceId ?? input.sourceId],
  });
  return withImpact({
    ...base,
    state: "create_new" satisfies IngestPlanState,
    readyForWorkflow: true,
    readyForMutation: false,
    selectedTarget: {
      documentId: null,
      notebookId: input.targetNotebookId,
      title: input.proposedWikiTitle,
      parentPath: input.targetParentPath ?? null,
      pageType: input.pageType,
      knowledgeRole: input.knowledgeRole,
      registered: false,
    },
    templatePreview,
    plannedOperations: createOperations(Boolean(sourceRecord)),
    blockers: [],
    nextTools: ["validate_wiki_template", "create_note"],
  });
}
