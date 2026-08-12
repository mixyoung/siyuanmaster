export const KNOWLEDGE_REGISTRY_STORAGE_KEY =
  "knowledge-registry.json";
export const KNOWLEDGE_REGISTRY_SCHEMA_VERSION = 1;

export const SOURCE_STATES = [
  "new",
  "registered",
  "ingested",
  "failed",
  "stale",
] as const;

export const WIKI_PAGE_TYPES = [
  "topic",
  "concept",
  "entity",
  "comparison",
  "insight",
  "source_summary",
] as const;

export const KNOWLEDGE_ROLES = [
  "synthesis",
  "chapter",
  "governance",
] as const;

export type SourceState = (typeof SOURCE_STATES)[number];
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];
export type KnowledgeRole = (typeof KNOWLEDGE_ROLES)[number];

export interface KnowledgeSourceRecord {
  sourceId: string;
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
  sha256?: string;
  canonicalUrl?: string;
  state: SourceState;
  authorityDocumentIds: string[];
  operationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiAuthorityRecord {
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
  aliases: string[];
  pageType: WikiPageType;
  knowledgeRole: KnowledgeRole;
  sourceContainerDocumentId?: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRegistry {
  schemaVersion: 1;
  revision: number;
  sources: KnowledgeSourceRecord[];
  authorities: WikiAuthorityRecord[];
}

export interface KnowledgeRegistryStorage {
  get(key: string): Promise<{ json(): Promise<unknown> }>;
  put(key: string, content: string): Promise<unknown>;
}

export interface RegisterSourceInput {
  sourceId: string;
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
  sha256?: string;
  canonicalUrl?: string;
  state: SourceState;
  authorityDocumentIds?: string[];
  operationId?: string;
  accessibleDocumentIds?: string[];
}

export interface RegisterAuthorityInput {
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
  aliases: string[];
  pageType: WikiPageType;
  knowledgeRole: KnowledgeRole;
  sourceContainerDocumentId?: string;
  sourceIds?: string[];
  accessibleDocumentIds?: string[];
}

export interface SourceRegistrationResult {
  record: KnowledgeSourceRecord;
  created: boolean;
  deduplicatedBy?: "documentId" | "sha256" | "canonicalUrl";
}

export interface AuthorityRegistrationResult {
  record: WikiAuthorityRecord;
  created: boolean;
  competingAuthorityDocumentIds: string[];
}

export class KnowledgeRegistryError extends Error {
  constructor(
    readonly code:
      | "source_identity_conflict"
      | "source_reference_missing"
      | "authority_reference_missing"
      | "record_outside_access"
      | "invalid_source_state"
      | "invalid_role_overlap"
      | "unsupported_schema",
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const result = value.trim();
  return result && result.length <= maximum ? result : undefined;
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .map((item) => boundedText(item, maximumLength))
      .filter((item): item is string => Boolean(item))
      .slice(0, maximumItems),
  );
}

function timestamp(value: unknown, fallback: string): string {
  const candidate = boundedText(value, 64);
  return candidate && Number.isFinite(Date.parse(candidate))
    ? candidate
    : fallback;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  options: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && options.includes(value)
    ? (value as T[number])
    : fallback;
}

function normalizeSourceRecord(
  value: unknown,
): KnowledgeSourceRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sourceId = boundedText(value.sourceId, 128);
  const documentId = boundedText(value.documentId, 64);
  const notebookId = boundedText(value.notebookId, 64);
  const title = boundedText(value.title, 512);
  const hPath = boundedText(value.hPath, 2048);
  const fallbackTime = new Date(0).toISOString();
  if (!sourceId || !documentId || !notebookId || !title || !hPath) {
    return undefined;
  }
  const createdAt = timestamp(value.createdAt, fallbackTime);
  return {
    sourceId,
    documentId,
    notebookId,
    title,
    hPath,
    sha256: boundedText(value.sha256, 64),
    canonicalUrl: boundedText(value.canonicalUrl, 2048),
    state: enumValue(value.state, SOURCE_STATES, "registered"),
    authorityDocumentIds: stringArray(
      value.authorityDocumentIds,
      256,
      64,
    ),
    operationId: boundedText(value.operationId, 128),
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  };
}

function normalizeAuthorityRecord(
  value: unknown,
): WikiAuthorityRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const documentId = boundedText(value.documentId, 64);
  const notebookId = boundedText(value.notebookId, 64);
  const title = boundedText(value.title, 512);
  const hPath = boundedText(value.hPath, 2048);
  const fallbackTime = new Date(0).toISOString();
  if (!documentId || !notebookId || !title || !hPath) {
    return undefined;
  }
  const createdAt = timestamp(value.createdAt, fallbackTime);
  return {
    documentId,
    notebookId,
    title,
    hPath,
    aliases: stringArray(value.aliases, 32, 128),
    pageType: enumValue(value.pageType, WIKI_PAGE_TYPES, "topic"),
    knowledgeRole: enumValue(
      value.knowledgeRole,
      KNOWLEDGE_ROLES,
      "synthesis",
    ),
    sourceContainerDocumentId: boundedText(
      value.sourceContainerDocumentId,
      64,
    ),
    sourceIds: stringArray(value.sourceIds, 1024, 128),
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  };
}

export function emptyKnowledgeRegistry(): KnowledgeRegistry {
  return {
    schemaVersion: KNOWLEDGE_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    sources: [],
    authorities: [],
  };
}

export function normalizeKnowledgeRegistry(
  value: unknown,
): KnowledgeRegistry {
  if (!isRecord(value)) {
    return emptyKnowledgeRegistry();
  }
  const sources: KnowledgeSourceRecord[] = [];
  const seenSourceIds = new Set<string>();
  const seenSourceDocuments = new Set<string>();
  for (const candidate of Array.isArray(value.sources)
    ? value.sources.slice(0, 20_000)
    : []) {
    const record = normalizeSourceRecord(candidate);
    if (
      !record ||
      seenSourceIds.has(record.sourceId) ||
      seenSourceDocuments.has(record.documentId)
    ) {
      continue;
    }
    sources.push(record);
    seenSourceIds.add(record.sourceId);
    seenSourceDocuments.add(record.documentId);
  }

  const authorities: WikiAuthorityRecord[] = [];
  const seenAuthorityDocuments = new Set<string>();
  for (const candidate of Array.isArray(value.authorities)
    ? value.authorities.slice(0, 20_000)
    : []) {
    const record = normalizeAuthorityRecord(candidate);
    if (!record || seenAuthorityDocuments.has(record.documentId)) {
      continue;
    }
    authorities.push(record);
    seenAuthorityDocuments.add(record.documentId);
  }

  const sourceById = new Map(sources.map((item) => [item.sourceId, item]));
  const authorityById = new Map(
    authorities.map((item) => [item.documentId, item]),
  );
  for (const source of sources) {
    source.authorityDocumentIds = source.authorityDocumentIds.filter((id) =>
      authorityById.has(id),
    );
    for (const documentId of source.authorityDocumentIds) {
      const authority = authorityById.get(documentId);
      if (authority) {
        authority.sourceIds = uniqueStrings([
          ...authority.sourceIds,
          source.sourceId,
        ]);
      }
    }
  }
  for (const authority of authorities) {
    authority.sourceIds = authority.sourceIds.filter((id) =>
      sourceById.has(id),
    );
    for (const sourceId of authority.sourceIds) {
      const source = sourceById.get(sourceId);
      if (source) {
        source.authorityDocumentIds = uniqueStrings([
          ...source.authorityDocumentIds,
          authority.documentId,
        ]);
      }
    }
  }

  return {
    schemaVersion: KNOWLEDGE_REGISTRY_SCHEMA_VERSION,
    revision:
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0
        ? value.revision
        : 0,
    sources,
    authorities,
  };
}

function competingAuthorities(
  registry: KnowledgeRegistry,
  record: WikiAuthorityRecord,
  accessibleDocumentIds?: string[],
): string[] {
  const names = new Set(
    [record.title, ...record.aliases].map(normalizeSearchText),
  );
  return registry.authorities
    .filter(
      (candidate) =>
        candidate.documentId !== record.documentId &&
        candidate.notebookId === record.notebookId &&
        (!accessibleDocumentIds ||
          accessibleDocumentIds.includes(candidate.documentId)) &&
        [candidate.title, ...candidate.aliases]
          .map(normalizeSearchText)
          .some((name) => names.has(name)),
    )
    .map((candidate) => candidate.documentId)
    .sort();
}

export class KnowledgeRegistryStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: KnowledgeRegistryStorage,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private async readSnapshot(): Promise<KnowledgeRegistry> {
    let value: unknown;
    try {
      const stored = await this.storage.get(KNOWLEDGE_REGISTRY_STORAGE_KEY);
      value = await stored.json();
    } catch {
      return emptyKnowledgeRegistry();
    }
    if (
      isRecord(value) &&
      value.schemaVersion !== undefined &&
      value.schemaVersion !== KNOWLEDGE_REGISTRY_SCHEMA_VERSION
    ) {
      throw new KnowledgeRegistryError(
        "unsupported_schema",
        "The stored knowledge registry uses an unsupported schema version",
      );
    }
    return normalizeKnowledgeRegistry(value);
  }

  async snapshot(): Promise<KnowledgeRegistry> {
    const barrier = this.writeTail;
    await barrier;
    return this.readSnapshot();
  }

  private async mutate<T>(
    mutation: (
      registry: KnowledgeRegistry,
      now: string,
    ) => { registry: KnowledgeRegistry; result: T },
  ): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeTail = this.writeTail
      .then(async () => {
        try {
          const current = await this.readSnapshot();
          const mutated = mutation(current, this.now());
          mutated.registry.revision = current.revision + 1;
          await this.storage.put(
            KNOWLEDGE_REGISTRY_STORAGE_KEY,
            JSON.stringify(mutated.registry),
          );
          resolveResult(mutated.result);
        } catch (error) {
          rejectResult(error);
        }
      })
      .catch(() => undefined);
    return result;
  }

  async registerSource(
    input: RegisterSourceInput,
  ): Promise<SourceRegistrationResult> {
    return this.mutate<SourceRegistrationResult>((current, now) => {
      const registry = normalizeKnowledgeRegistry(current);
      if (
        registry.authorities.some(
          (authority) => authority.documentId === input.documentId,
        )
      ) {
        throw new KnowledgeRegistryError(
          "invalid_role_overlap",
          "One SiYuan document cannot be both a Raw source and a Wiki authority",
        );
      }
      const bySourceId = registry.sources.find(
        (item) => item.sourceId === input.sourceId,
      );
      if (
        bySourceId &&
        input.accessibleDocumentIds &&
        !input.accessibleDocumentIds.includes(bySourceId.documentId)
      ) {
        throw new KnowledgeRegistryError(
          "record_outside_access",
          "Source identity cannot be registered within the active access boundary",
        );
      }
      if (bySourceId && bySourceId.documentId !== input.documentId) {
        throw new KnowledgeRegistryError(
          "source_identity_conflict",
          `sourceId '${input.sourceId}' already identifies another document`,
        );
      }
      const byDocument = registry.sources.find(
        (item) => item.documentId === input.documentId,
      );
      const byHash = input.sha256
        ? registry.sources.find(
            (item) =>
              item.sha256 === input.sha256 &&
              (!input.accessibleDocumentIds ||
                input.accessibleDocumentIds.includes(item.documentId)),
          )
        : undefined;
      const byUrl = input.canonicalUrl
        ? registry.sources.find(
            (item) =>
              item.canonicalUrl === input.canonicalUrl &&
              (!input.accessibleDocumentIds ||
                input.accessibleDocumentIds.includes(item.documentId)),
          )
        : undefined;
      const existing = bySourceId ?? byDocument ?? byHash ?? byUrl;
      const deduplicatedBy = bySourceId
        ? undefined
        : byDocument
          ? "documentId"
          : byHash
            ? "sha256"
            : byUrl
              ? "canonicalUrl"
              : undefined;

      if (
        existing?.sha256 &&
        input.sha256 &&
        existing.sha256 !== input.sha256
      ) {
        throw new KnowledgeRegistryError(
          "source_identity_conflict",
          "The registered document already has a different SHA-256 digest",
        );
      }
      if (
        existing?.canonicalUrl &&
        input.canonicalUrl &&
        existing.canonicalUrl !== input.canonicalUrl
      ) {
        throw new KnowledgeRegistryError(
          "source_identity_conflict",
          "The registered document already has a different canonical URL",
        );
      }

      const authorityDocumentIds = input.authorityDocumentIds
        ? uniqueStrings(input.authorityDocumentIds)
        : existing?.authorityDocumentIds ?? [];
      if (
        existing?.authorityDocumentIds.some(
          (documentId) =>
            input.accessibleDocumentIds &&
            !input.accessibleDocumentIds.includes(documentId),
        )
      ) {
        throw new KnowledgeRegistryError(
          "record_outside_access",
          "The source has an authority link unavailable within the active access boundary",
        );
      }
      for (const documentId of authorityDocumentIds) {
        const authority = registry.authorities.find(
          (candidate) => candidate.documentId === documentId,
        );
        if (!authority) {
          throw new KnowledgeRegistryError(
            "authority_reference_missing",
            `Authority document '${documentId}' is not registered`,
          );
        }
        if (
          input.accessibleDocumentIds &&
          !input.accessibleDocumentIds.includes(authority.documentId)
        ) {
          throw new KnowledgeRegistryError(
            "record_outside_access",
            "The requested authority link is unavailable within the active access boundary",
          );
        }
      }
      if (input.state === "ingested" && authorityDocumentIds.length === 0) {
        throw new KnowledgeRegistryError(
          "invalid_source_state",
          "An ingested source must link to at least one registered authority page",
        );
      }

      const sameDocument = existing?.documentId === input.documentId;

      const record: KnowledgeSourceRecord = {
        sourceId: existing?.sourceId ?? input.sourceId,
        documentId: existing?.documentId ?? input.documentId,
        notebookId: sameDocument ? input.notebookId : existing?.notebookId ?? input.notebookId,
        title: sameDocument ? input.title : existing?.title ?? input.title,
        hPath: sameDocument ? input.hPath : existing?.hPath ?? input.hPath,
        sha256: existing?.sha256 ?? input.sha256,
        canonicalUrl: existing?.canonicalUrl ?? input.canonicalUrl,
        state: input.state,
        authorityDocumentIds,
        operationId: input.operationId ?? existing?.operationId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) {
        registry.sources[registry.sources.indexOf(existing)] = record;
      } else {
        registry.sources.push(record);
      }

      for (const authority of registry.authorities) {
        const shouldLink = authorityDocumentIds.includes(
          authority.documentId,
        );
        authority.sourceIds = shouldLink
          ? uniqueStrings([...authority.sourceIds, record.sourceId])
          : authority.sourceIds.filter((id) => id !== record.sourceId);
      }

      return {
        registry,
        result: {
          record,
          created: !existing,
          deduplicatedBy,
        },
      };
    });
  }

  async registerAuthority(
    input: RegisterAuthorityInput,
  ): Promise<AuthorityRegistrationResult> {
    return this.mutate<AuthorityRegistrationResult>((current, now) => {
      const registry = normalizeKnowledgeRegistry(current);
      if (
        registry.sources.some(
          (source) => source.documentId === input.documentId,
        )
      ) {
        throw new KnowledgeRegistryError(
          "invalid_role_overlap",
          "One SiYuan document cannot be both a Raw source and a Wiki authority",
        );
      }
      const existing = registry.authorities.find(
        (item) => item.documentId === input.documentId,
      );
      const sourceIds = input.sourceIds
        ? uniqueStrings(input.sourceIds)
        : existing?.sourceIds ?? [];
      if (
        existing?.sourceIds.some((sourceId) => {
          const source = registry.sources.find(
            (candidate) => candidate.sourceId === sourceId,
          );
          return (
            source &&
            input.accessibleDocumentIds &&
            !input.accessibleDocumentIds.includes(source.documentId)
          );
        })
      ) {
        throw new KnowledgeRegistryError(
          "record_outside_access",
          "The authority has a source link unavailable within the active access boundary",
        );
      }
      for (const sourceId of sourceIds) {
        const source = registry.sources.find(
          (candidate) => candidate.sourceId === sourceId,
        );
        if (!source) {
          throw new KnowledgeRegistryError(
            "source_reference_missing",
            `Source '${sourceId}' is not registered`,
          );
        }
        if (
          input.accessibleDocumentIds &&
          !input.accessibleDocumentIds.includes(source.documentId)
        ) {
          throw new KnowledgeRegistryError(
            "record_outside_access",
            "The requested source link is unavailable within the active access boundary",
          );
        }
      }

      const record: WikiAuthorityRecord = {
        documentId: input.documentId,
        notebookId: input.notebookId,
        title: input.title,
        hPath: input.hPath,
        aliases: uniqueStrings(input.aliases),
        pageType: input.pageType,
        knowledgeRole: input.knowledgeRole,
        sourceContainerDocumentId:
          input.sourceContainerDocumentId ??
          existing?.sourceContainerDocumentId,
        sourceIds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) {
        registry.authorities[registry.authorities.indexOf(existing)] = record;
      } else {
        registry.authorities.push(record);
      }

      for (const source of registry.sources) {
        const shouldLink = sourceIds.includes(source.sourceId);
        if (
          !shouldLink &&
          source.state === "ingested" &&
          source.authorityDocumentIds.includes(record.documentId) &&
          source.authorityDocumentIds.every(
            (documentId) => documentId === record.documentId,
          )
        ) {
          throw new KnowledgeRegistryError(
            "invalid_source_state",
            `Source '${source.sourceId}' must leave ingested state before its final authority link is removed`,
          );
        }
        source.authorityDocumentIds = shouldLink
          ? uniqueStrings([
              ...source.authorityDocumentIds,
              record.documentId,
            ])
          : source.authorityDocumentIds.filter(
              (id) => id !== record.documentId,
            );
      }

      return {
        registry,
        result: {
          record,
          created: !existing,
          competingAuthorityDocumentIds: competingAuthorities(
            registry,
            record,
            input.accessibleDocumentIds,
          ),
        },
      };
    });
  }
}

export function summarizeKnowledgeRegistry(
  registryValue: unknown,
  allowedNotebookIds: Iterable<string>,
  notebookId?: string,
): Record<string, unknown> {
  const registry = normalizeKnowledgeRegistry(registryValue);
  const allowed = new Set(allowedNotebookIds);
  const sources = registry.sources.filter(
    (item) =>
      allowed.has(item.notebookId) &&
      (!notebookId || item.notebookId === notebookId),
  );
  const authorities = registry.authorities.filter(
    (item) =>
      allowed.has(item.notebookId) &&
      (!notebookId || item.notebookId === notebookId),
  );
  const authorityIds = new Set(
    authorities.map((authority) => authority.documentId),
  );
  const sourceStates = Object.fromEntries(
    SOURCE_STATES.map((state) => [
      state,
      sources.filter((source) => source.state === state).length,
    ]),
  );
  const pageTypes = Object.fromEntries(
    WIKI_PAGE_TYPES.map((pageType) => [
      pageType,
      authorities.filter((authority) => authority.pageType === pageType)
        .length,
    ]),
  );
  const linkedSourceCount = sources.filter((source) =>
    source.authorityDocumentIds.some((id) => authorityIds.has(id)),
  ).length;
  const lastUpdatedAt = [...sources, ...authorities]
    .map((item) => item.updatedAt)
    .sort()
    .at(-1);
  return {
    schemaVersion: registry.schemaVersion,
    notebookId: notebookId ?? null,
    sourceCount: sources.length,
    sourceStates,
    authorityCount: authorities.length,
    authorityPageTypes: pageTypes,
    linkedSourceCount,
    unlinkedSourceCount: sources.length - linkedSourceCount,
    coveragePercent:
      sources.length === 0
        ? null
        : Math.round((linkedSourceCount / sources.length) * 10_000) /
          100,
    lastUpdatedAt: lastUpdatedAt ?? null,
  };
}

export interface KnowledgeDocumentMetadata {
  id: string;
  box: string;
  content: string;
  hpath: string;
}

export function refreshAccessibleKnowledgeRegistry(
  registryValue: unknown,
  documents: Iterable<KnowledgeDocumentMetadata>,
  allowedNotebookIds: Iterable<string>,
): KnowledgeRegistry {
  const registry = normalizeKnowledgeRegistry(registryValue);
  const allowed = new Set(allowedNotebookIds);
  const liveById = new Map(
    [...documents]
      .filter((document) => allowed.has(document.box))
      .map((document) => [document.id, document]),
  );
  return {
    ...registry,
    sources: registry.sources.flatMap((source) => {
      const document = liveById.get(source.documentId);
      return document
        ? [
            {
              ...source,
              notebookId: document.box,
              title: document.content,
              hPath: document.hpath,
            },
          ]
        : [];
    }),
    authorities: registry.authorities.flatMap((authority) => {
      const document = liveById.get(authority.documentId);
      if (!document) {
        return [];
      }
      return [
        {
          ...authority,
          notebookId: document.box,
          title: document.content,
          hPath: document.hpath,
          sourceContainerDocumentId:
            authority.sourceContainerDocumentId &&
            liveById.has(authority.sourceContainerDocumentId)
              ? authority.sourceContainerDocumentId
              : undefined,
        },
      ];
    }),
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function lexicalScore(
  query: string,
  authority: WikiAuthorityRecord,
): { score: number; matchedOn: string[] } {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return { score: 0, matchedOn: [] };
  }
  const title = normalizeSearchText(authority.title);
  const aliases = authority.aliases.map(normalizeSearchText);
  let score = 0;
  const matchedOn: string[] = [];
  if (title === normalizedQuery) {
    score = 100;
    matchedOn.push("title:exact");
  } else if (aliases.includes(normalizedQuery)) {
    score = 95;
    matchedOn.push("alias:exact");
  } else if (title.startsWith(normalizedQuery)) {
    score = 85;
    matchedOn.push("title:prefix");
  } else if (title.includes(normalizedQuery)) {
    score = 75;
    matchedOn.push("title:contains");
  } else if (aliases.some((alias) => alias.includes(normalizedQuery))) {
    score = 70;
    matchedOn.push("alias:contains");
  }
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const searchable = `${title} ${aliases.join(" ")}`;
  const matchedTokens = tokens.filter((token) => searchable.includes(token));
  if (matchedTokens.length > 0) {
    score += Math.round((matchedTokens.length / tokens.length) * 20);
    matchedOn.push("token:overlap");
  }
  return { score, matchedOn };
}

export interface FindWikiCandidatesInput {
  query?: string;
  sourceId?: string;
  notebookId?: string;
  pageTypes?: WikiPageType[];
  limit: number;
  allowedNotebookIds: Iterable<string>;
}

export interface WikiCandidate {
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
  aliases: string[];
  pageType: WikiPageType;
  knowledgeRole: KnowledgeRole;
  sourceCount: number;
  score: number;
  matchedOn: string[];
}

export interface FindWikiCandidatesResult {
  query: string | null;
  sourceId: string | null;
  sourceFound: boolean | null;
  candidates: WikiCandidate[];
  fallbackRecommended: boolean;
  fallbackTool: "search_notes" | null;
}

export function findWikiCandidates(
  registryValue: unknown,
  input: FindWikiCandidatesInput,
): FindWikiCandidatesResult {
  const registry = normalizeKnowledgeRegistry(registryValue);
  const allowed = new Set(input.allowedNotebookIds);
  const requestedTypes = input.pageTypes
    ? new Set(input.pageTypes)
    : undefined;
  const source = input.sourceId
    ? registry.sources.find(
        (item) =>
          item.sourceId === input.sourceId && allowed.has(item.notebookId),
      )
    : undefined;
  const accessibleSourceIds = new Set(
    registry.sources
      .filter((item) => allowed.has(item.notebookId))
      .map((item) => item.sourceId),
  );
  const sourceAuthorities = new Set(
    source && allowed.has(source.notebookId)
      ? source.authorityDocumentIds
      : [],
  );
  const candidates = registry.authorities
    .filter(
      (authority) =>
        allowed.has(authority.notebookId) &&
        (!input.notebookId || authority.notebookId === input.notebookId) &&
        (!requestedTypes || requestedTypes.has(authority.pageType)),
    )
    .map((authority) => {
      const lexical = input.query
        ? lexicalScore(input.query, authority)
        : { score: 0, matchedOn: [] as string[] };
      const linkedToSource = sourceAuthorities.has(authority.documentId);
      return {
        documentId: authority.documentId,
        notebookId: authority.notebookId,
        title: authority.title,
        hPath: authority.hPath,
        aliases: authority.aliases,
        pageType: authority.pageType,
        knowledgeRole: authority.knowledgeRole,
        sourceCount: authority.sourceIds.filter((id) =>
          accessibleSourceIds.has(id),
        ).length,
        score: lexical.score + (linkedToSource ? 1_000 : 0),
        matchedOn: linkedToSource
          ? ["source:linked", ...lexical.matchedOn]
          : lexical.matchedOn,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.title < right.title ? -1 : left.title > right.title ? 1 : 0) ||
        (left.documentId < right.documentId
          ? -1
          : left.documentId > right.documentId
            ? 1
            : 0),
    )
    .slice(0, input.limit);
  return {
    query: input.query ?? null,
    sourceId: input.sourceId ?? null,
    sourceFound: input.sourceId ? Boolean(source) : null,
    candidates,
    fallbackRecommended: candidates.length === 0,
    fallbackTool: candidates.length === 0 ? "search_notes" : null,
  };
}
