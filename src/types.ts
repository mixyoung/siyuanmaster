export type AccessMode = "allowlist" | "denylist";
export type OperationDecision = "allow" | "confirm" | "deny";
export type TaggingMode = "off" | "ask" | "always" | "once";
export type TagDecision = "use_default" | "add" | "skip" | "propose";
export type TagAiProvider = "calling_agent" | "siyuan_ai";
export type TagApplyMode = "propose" | "auto";

export interface NotebookSummary {
  id: string;
  name: string;
  icon?: string;
  sort?: number;
  closed?: boolean;
  encrypted?: boolean;
}

export interface AccessPolicy {
  mode: AccessMode;
  selectedNotebookIds: string[];
  defaultDecision: "allow" | "deny";
}

export interface OperationPolicy {
  search: OperationDecision;
  read: OperationDecision;
  create: OperationDecision;
  append: OperationDecision;
  update: OperationDecision;
  rename: OperationDecision;
  move: OperationDecision;
  moveAcrossNotebooks: OperationDecision;
  delete: OperationDecision;
  export: OperationDecision;
}

export interface TaggingOperations {
  create: boolean;
  append: boolean;
  update: boolean;
  summarize: boolean;
  memory: boolean;
  batchOrganize: boolean;
}

export interface TaggingPolicy {
  mode: TaggingMode;
  operations: TaggingOperations;
  sources: {
    fixed: boolean;
    manual: boolean;
    aiSuggested: boolean;
  };
  fixedTags: string[];
  ai: {
    enabled: boolean;
    provider: TagAiProvider;
    applyMode: TagApplyMode;
    maxTags: number;
    preferExistingTags: boolean;
    deduplicateSynonyms: boolean;
  };
}

export interface AuditPolicy {
  enabled: boolean;
  retentionDays: number;
  recordReadOperations: boolean;
  redactContent: boolean;
}

export type ReferenceProtectionMode = "warn" | "deny";

export interface LongDocumentPolicy {
  maxBlocksPerWindow: number;
  maxCharsPerBlock: number;
  maxOutlineBlocks: number;
}

export interface BlockEditPolicy {
  requireExpectedState: boolean;
  defaultConfirm: boolean;
  maxBlocks: number;
}

export interface SafetyPolicy {
  snapshotBeforeWrite: boolean;
  referenceProtection: ReferenceProtectionMode;
  permissionInheritance: boolean;
  longDocument: LongDocumentPolicy;
  blockEdit: BlockEditPolicy;
}

export interface PluginPolicy {
  schemaVersion: 1;
  access: AccessPolicy;
  operations: OperationPolicy;
  tagging: TaggingPolicy;
  audit: AuditPolicy;
  safety: SafetyPolicy;
}

export interface TaggingRequest {
  decision: TagDecision;
  tags: string[];
}

export interface AuditEntry {
  timestamp: string;
  operation: string;
  outcome: "allowed" | "denied" | "confirmation_required" | "failed";
  documentId?: string;
  notebookId?: string;
  confirmed?: boolean;
  contentLength?: number;
  tagCount?: number;
  targetNotebookId?: string;
  preview?: boolean;
  crossNotebook?: boolean;
  message?: string;
}
