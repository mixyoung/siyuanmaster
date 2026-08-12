import { describe, expect, it } from "vitest";
import {
  IngestPlanError,
  planSourceIngest,
  type PlanSourceIngestInput,
} from "../src/ingest-plan";
import type { KnowledgeRegistry } from "../src/knowledge-registry";

const NOTEBOOK_ID = "20260812000000-nb00001";
const OTHER_NOTEBOOK_ID = "20260812000000-nb00002";
const SOURCE_DOCUMENT_ID = "20260812000001-aaaaaaa";
const AUTHORITY_DOCUMENT_ID = "20260812000002-bbbbbbb";

function registry(options: {
  source?: boolean;
  sourceState?: "new" | "registered" | "ingested" | "failed" | "stale";
  authority?: boolean;
  linked?: boolean;
} = {}): KnowledgeRegistry {
  const linked = options.linked === true;
  return {
    schemaVersion: 1,
    revision: 1,
    sources:
      options.source === false
        ? []
        : [
            {
              sourceId: "source:one",
              documentId: SOURCE_DOCUMENT_ID,
              notebookId: NOTEBOOK_ID,
              title: "Raw source",
              hPath: "/Raw source",
              sha256: "a".repeat(64),
              canonicalUrl: "https://example.com/source",
              state: options.sourceState ?? "registered",
              authorityDocumentIds: linked ? [AUTHORITY_DOCUMENT_ID] : [],
              createdAt: "2026-08-12T00:00:00.000Z",
              updatedAt: "2026-08-12T00:00:00.000Z",
            },
          ],
    authorities:
      options.authority === false
        ? []
        : [
            {
              documentId: AUTHORITY_DOCUMENT_ID,
              notebookId: NOTEBOOK_ID,
              title: "Agent Memory",
              hPath: "/AI/Agent Memory",
              aliases: ["智能体记忆"],
              pageType: "concept",
              knowledgeRole: "synthesis",
              sourceIds: linked ? ["source:one"] : [],
              createdAt: "2026-08-12T00:00:00.000Z",
              updatedAt: "2026-08-12T00:00:00.000Z",
            },
          ],
  };
}

function input(
  overrides: Partial<PlanSourceIngestInput> = {},
): PlanSourceIngestInput {
  return {
    registry: registry(),
    allowedNotebookIds: [NOTEBOOK_ID],
    source: {
      documentId: SOURCE_DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      title: "Raw source",
      hPath: "/Raw source",
    },
    sourceId: "source:one",
    sha256: "a".repeat(64),
    canonicalUrl: "https://example.com/source",
    query: "Agent Memory",
    targetNotebookId: NOTEBOOK_ID,
    ...overrides,
  };
}

function asPlan(value: Record<string, unknown>) {
  return value as {
    state: string;
    readyForWorkflow: boolean;
    readyForMutation: boolean;
    previewOnly: boolean;
    writeExecuted: boolean;
    blockers: string[];
    nextTools: string[];
    discovery: { candidates: Array<{ documentId: string }> };
    selectedTarget: Record<string, unknown> | null;
    templatePreview: Record<string, unknown> | null;
    impact: {
      affectedExistingWikiDocumentIds: string[];
      proposesNewWikiDocument: boolean;
      sourceRegistrationPlanned: boolean;
      plannedMutationCount: number;
      writeExecuted: boolean;
    };
    plannedOperations: Array<{
      kind: string;
      tool: string | null;
      mutation: boolean;
    }>;
  };
}

describe("single-source Ingest plan state machine", () => {
  it("fails closed when source or target is outside the access boundary", () => {
    expect(() =>
      planSourceIngest(
        input({ source: { ...input().source, notebookId: OTHER_NOTEBOOK_ID } }),
      ),
    ).toThrowError(IngestPlanError);
    expect(() =>
      planSourceIngest(input({ targetNotebookId: OTHER_NOTEBOOK_ID })),
    ).toThrow(/target notebook.*outside/i);
    expect(() =>
      planSourceIngest(
        input({
          allowedNotebookIds: [NOTEBOOK_ID, OTHER_NOTEBOOK_ID],
          selectedAuthority: {
            documentId: "20260812000004-ddddddd",
            notebookId: OTHER_NOTEBOOK_ID,
            title: "Wrong target notebook",
            hPath: "/Wrong target notebook",
          },
        }),
      ),
    ).toThrow(/requested target notebook/i);
  });

  it("fails closed on registered source identity conflicts", () => {
    expect(() =>
      planSourceIngest(input({ sourceId: "source:different" })),
    ).toThrow(/identity conflicts/i);
    expect(() =>
      planSourceIngest(input({ sha256: "b".repeat(64) })),
    ).toThrow(/identity conflicts/i);
  });

  it("detects an accessible duplicate by hash without exposing note bodies", () => {
    const existing = registry({ authority: false });
    existing.sources[0].documentId = "20260812000003-ccccccc";
    existing.sources[0].sourceId = "source:existing";
    const plan = asPlan(
      planSourceIngest(
        input({ registry: existing, sourceId: "source:new" }),
      ),
    );
    expect(plan.state).toBe("duplicate_source");
    expect(plan.plannedOperations).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("markdown");
    expect(JSON.stringify(plan)).not.toContain("content");
  });

  it("stops when a prior source ingest is failed", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ sourceState: "failed", authority: false }),
        }),
      ),
    );
    expect(plan.state).toBe("source_review_required");
    expect(plan.nextTools).toEqual(["get_audit_log", "read_note"]);
    expect(plan.plannedOperations).toEqual([]);
  });

  it("recognizes a linked ingested source as complete without writes", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ sourceState: "ingested", linked: true }),
        }),
      ),
    );
    expect(plan.state).toBe("already_ingested");
    expect(plan.readyForWorkflow).toBe(false);
    expect(plan.plannedOperations).toEqual([]);
  });

  it("builds an update-existing workflow from one direct source link", () => {
    const plan = asPlan(
      planSourceIngest(
        input({ registry: registry({ linked: true }) }),
      ),
    );
    expect(plan.state).toBe("update_existing");
    expect(plan.readyForWorkflow).toBe(true);
    expect(plan.readyForMutation).toBe(false);
    expect(plan.selectedTarget).toMatchObject({
      documentId: AUTHORITY_DOCUMENT_ID,
      registered: true,
    });
    expect(plan.plannedOperations.map((item) => item.kind)).toEqual([
      "read_authority",
      "draft_authority_update",
      "update_authority",
      "readback_authority",
      "mark_source_ingested",
    ]);
    expect(plan.impact).toEqual({
      affectedExistingWikiDocumentIds: [AUTHORITY_DOCUMENT_ID],
      proposesNewWikiDocument: false,
      sourceRegistrationPlanned: false,
      plannedMutationCount: 2,
      writeExecuted: false,
    });
  });

  it("does not auto-select a linked authority outside the requested target notebook", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ linked: true }),
          allowedNotebookIds: [NOTEBOOK_ID, OTHER_NOTEBOOK_ID],
          targetNotebookId: OTHER_NOTEBOOK_ID,
        }),
      ),
    );
    expect(plan.state).toBe("fallback_search_required");
    expect(plan.discovery.candidates).toEqual([]);
    expect(plan.selectedTarget).toBeNull();
  });

  it("returns candidate selection instead of choosing a lexical match", () => {
    const plan = asPlan(planSourceIngest(input()));
    expect(plan.state).toBe("select_existing");
    expect(plan.discovery.candidates[0].documentId).toBe(
      AUTHORITY_DOCUMENT_ID,
    );
    expect(plan.selectedTarget).toBeNull();
    expect(plan.blockers[0]).toMatch(/select.*correct existing authority/i);
  });

  it("accepts a caller-selected existing page but requires classification before registration", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          selectedAuthority: {
            documentId: "20260812000004-ddddddd",
            notebookId: NOTEBOOK_ID,
            title: "Existing unregistered page",
            hPath: "/Existing unregistered page",
          },
        }),
      ),
    );
    expect(plan.state).toBe("creation_details_required");
    expect(plan.blockers.join(" ")).toMatch(/pageType/);
    expect(plan.blockers.join(" ")).toMatch(/knowledgeRole/);
  });

  it("plans registration after updating a selected unregistered existing page", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          selectedAuthority: {
            documentId: "20260812000004-ddddddd",
            notebookId: NOTEBOOK_ID,
            title: "Existing unregistered page",
            hPath: "/Existing unregistered page",
          },
          pageType: "topic",
          knowledgeRole: "synthesis",
        }),
      ),
    );
    expect(plan.state).toBe("update_existing");
    expect(plan.plannedOperations.map((item) => item.kind)).toContain(
      "register_authority",
    );
  });

  it("requires focused fallback search after a registry miss", () => {
    const plan = asPlan(
      planSourceIngest(
        input({ registry: registry({ authority: false }) }),
      ),
    );
    expect(plan.state).toBe("fallback_search_required");
    expect(plan.nextTools).toContain("search_notes");
    expect(plan.nextTools).toContain("list_document_tree");
  });

  it("requires a semantic creation-gate decision after bounded search finds no page", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          discoveryState: "bounded_search_no_match",
        }),
      ),
    );
    expect(plan.state).toBe("creation_gate_required");
    expect(plan.nextTools).toContain("list_wiki_templates");
  });

  it("keeps the source in Raw when the creation gate fails", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          discoveryState: "bounded_search_no_match",
          creationGateDecision: "failed",
        }),
      ),
    );
    expect(plan.state).toBe("keep_raw");
    expect(plan.templatePreview).toBeNull();
    expect(plan.plannedOperations).toEqual([]);
  });

  it("requires title, page type, and role after the creation gate passes", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          discoveryState: "bounded_search_no_match",
          creationGateDecision: "passed",
        }),
      ),
    );
    expect(plan.state).toBe("creation_details_required");
    expect(plan.blockers.join(" ")).toMatch(/proposedWikiTitle/);
    expect(plan.blockers.join(" ")).toMatch(/pageType/);
    expect(plan.blockers.join(" ")).toMatch(/knowledgeRole/);
  });

  it("renders a deterministic create-new preview and ordered operation plan", () => {
    const first = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          discoveryState: "bounded_search_no_match",
          creationGateDecision: "passed",
          proposedWikiTitle: "Agent Memory",
          pageType: "concept",
          knowledgeRole: "synthesis",
          locale: "zh-CN",
          targetParentPath: "/AI",
        }),
      ),
    );
    const second = asPlan(
      planSourceIngest(
        input({
          registry: registry({ authority: false }),
          discoveryState: "bounded_search_no_match",
          creationGateDecision: "passed",
          proposedWikiTitle: "Agent Memory",
          pageType: "concept",
          knowledgeRole: "synthesis",
          locale: "zh-CN",
          targetParentPath: "/AI",
        }),
      ),
    );
    expect(first).toEqual(second);
    expect(first.state).toBe("create_new");
    expect(first.readyForWorkflow).toBe(true);
    expect(first.readyForMutation).toBe(false);
    expect(first.previewOnly).toBe(true);
    expect(first.writeExecuted).toBe(false);
    expect(first.templatePreview).toMatchObject({
      previewOnly: true,
      writeExecuted: false,
    });
    expect(first.plannedOperations.map((item) => item.kind)).toEqual([
      "render_template",
      "validate_template",
      "create_authority",
      "readback_authority",
      "register_authority",
      "mark_source_ingested",
    ]);
    expect(first.plannedOperations.some((item) => item.mutation)).toBe(true);
    expect(first.impact).toEqual({
      affectedExistingWikiDocumentIds: [],
      proposesNewWikiDocument: true,
      sourceRegistrationPlanned: false,
      plannedMutationCount: 3,
      writeExecuted: false,
    });
  });

  it("plans Raw registration first when the exact source is not registered", () => {
    const plan = asPlan(
      planSourceIngest(
        input({
          registry: registry({ source: false, authority: false }),
          discoveryState: "bounded_search_no_match",
          creationGateDecision: "passed",
          proposedWikiTitle: "Agent Memory",
          pageType: "topic",
          knowledgeRole: "synthesis",
        }),
      ),
    );
    expect(plan.state).toBe("create_new");
    expect(plan.plannedOperations[0]).toMatchObject({
      kind: "register_source",
      tool: "register_knowledge_source",
      mutation: true,
    });
    expect(plan.impact.sourceRegistrationPlanned).toBe(true);
    expect(plan.impact.plannedMutationCount).toBe(4);
  });

  it("never executes a write in any planned state", () => {
    const plans = [
      asPlan(planSourceIngest(input())),
      asPlan(
        planSourceIngest(
          input({
            registry: registry({ authority: false }),
            discoveryState: "bounded_search_no_match",
            creationGateDecision: "failed",
          }),
        ),
      ),
    ];
    for (const plan of plans) {
      expect(plan.previewOnly).toBe(true);
      expect(plan.writeExecuted).toBe(false);
      expect(plan.readyForMutation).toBe(false);
    }
  });
});
