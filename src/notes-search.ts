import { assertSiyuanId, escapeSqlLiteral } from "./kernel-api";

/** LIKE escape character; every wildcard-bearing pattern ships with `ESCAPE '\'`. */
const LIKE_ESCAPE = "\\";

/**
 * Escapes LIKE wildcards and the escape character itself so user text (search
 * queries) matches literally. Apply BEFORE quote-doubling via escapeSqlLiteral.
 */
export function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/** Builds the literal for a substring match with literal wildcard semantics. */
export function likeSubstringLiteral(query: string): string {
  return escapeSqlLiteral(`%${escapeLikePattern(query)}%`);
}

export interface SearchSqlInput {
  query: string;
  /** Accessible notebook IDs (policy-filtered before ranking or paging). */
  notebookIds: readonly string[];
  /** Keyset cursor: only documents after this ID (root_id ASC ordering). */
  afterDocumentId?: string;
  /** Documents per page; the query fetches limit + 1 to detect more. */
  limit: number;
  /** Optional exact subtree scope (root doc ID + its physical directory). */
  scope?: { rootDocumentId: string; directory: string; notebookId: string };
}

function boxesLiteral(notebookIds: readonly string[]): string {
  return notebookIds
    .map((id) => `'${escapeSqlLiteral(assertSiyuanId(id, "notebookId"))}'`)
    .join(",");
}

/**
 * Document-page SQL: aggregates matches per document (GROUP BY root_id),
 * orders by root_id ASC, and pages with a keyset predicate. Policy box and
 * scope filters sit in WHERE — before grouping, ordering, and limiting.
 */
export function buildSearchDocumentPageSql(input: SearchSqlInput): string {
  const boxes = boxesLiteral(input.notebookIds);
  const pattern = likeSubstringLiteral(input.query);
  const match = `(COALESCE(b.content, '') LIKE '${pattern}' ESCAPE '${LIKE_ESCAPE}'
                 OR COALESCE(b.name, '') LIKE '${pattern}' ESCAPE '${LIKE_ESCAPE}'
                 OR COALESCE(b.tag, '') LIKE '${pattern}' ESCAPE '${LIKE_ESCAPE}')`;
  const scope = input.scope
    ? `AND b.root_id IN (
         SELECT scope_doc.id FROM blocks scope_doc
         WHERE scope_doc.type = 'd'
           AND scope_doc.id = scope_doc.root_id
           AND scope_doc.box = '${escapeSqlLiteral(input.scope.notebookId)}'
           AND (
             scope_doc.id = '${escapeSqlLiteral(assertSiyuanId(input.scope.rootDocumentId, "rootDocumentId"))}'
             OR scope_doc.path LIKE '${escapeSqlLiteral(`${input.scope.directory}/%`)}' ESCAPE '${LIKE_ESCAPE}'
           )
       )`
    : "";
  const after = input.afterDocumentId
    ? `AND b.root_id > '${escapeSqlLiteral(assertSiyuanId(input.afterDocumentId, "afterDocumentId"))}'`
    : "";
  return `SELECT b.root_id AS document_id
     FROM blocks b
     WHERE b.box IN (${boxes})
       AND ${match}
       ${scope}
       ${after}
     GROUP BY b.root_id
     ORDER BY b.root_id ASC
     LIMIT ${input.limit + 1}`;
}

/** Best-block SQL for one page of documents; the caller picks the first row per document. */
export function buildSearchMatchedBlocksSql(
  input: Pick<SearchSqlInput, "query" | "notebookIds"> & {
    documentIds: readonly string[];
  },
): string {
  const boxes = boxesLiteral(input.notebookIds);
  const pattern = likeSubstringLiteral(input.query);
  const match = `(COALESCE(b.content, '') LIKE '${pattern}' ESCAPE '${LIKE_ESCAPE}'
                 OR COALESCE(b.name, '') LIKE '${pattern}' ESCAPE '${LIKE_ESCAPE}'
                 OR COALESCE(b.tag, '') LIKE '${pattern}' ESCAPE '${LIKE_ESCAPE}')`;
  const ids = input.documentIds
    .map((id) => `'${escapeSqlLiteral(assertSiyuanId(id, "documentId"))}'`)
    .join(",");
  return `SELECT
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
   WHERE b.root_id IN (${ids})
     AND b.box IN (${boxes})
     AND ${match}
   ORDER BY b.root_id ASC, b.updated DESC, b.id ASC`;
}

export interface SearchMatchRow {
  matched_id: string;
  document_id: string;
  box: string;
  hpath: string;
  title: string;
  tags: string | null;
  snippet: string;
  block_type: string;
  updated: string;
}

/** Picks the best block per document from matched-rows ordered by
 * (root_id ASC, updated DESC, id ASC): the first row per document wins. */
export function pickBestMatchPerDocument(
  rows: readonly SearchMatchRow[],
): SearchMatchRow[] {
  const seen = new Set<string>();
  const picked: SearchMatchRow[] = [];
  for (const row of rows) {
    if (seen.has(row.document_id)) continue;
    seen.add(row.document_id);
    picked.push(row);
  }
  return picked;
}

export interface SearchCursor {
  q: string;
  notebookId?: string;
  rootDocumentId?: string;
  accessSha: string;
  afterDocumentId: string;
}

/** Opaque cursor: binds the keyset position to the query text, scope, and
 * accessible-notebook fingerprint so a stale cursor can never page a
 * different query or policy scope. */
export function encodeSearchCursor(cursor: SearchCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

export function decodeSearchCursor(raw: string): SearchCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.q !== "string" ||
      typeof record.accessSha !== "string" ||
      typeof record.afterDocumentId !== "string" ||
      (record.notebookId !== undefined && typeof record.notebookId !== "string") ||
      (record.rootDocumentId !== undefined &&
        typeof record.rootDocumentId !== "string")
    ) {
      return undefined;
    }
    return {
      q: record.q,
      notebookId: record.notebookId as string | undefined,
      rootDocumentId: record.rootDocumentId as string | undefined,
      accessSha: record.accessSha,
      afterDocumentId: record.afterDocumentId,
    };
  } catch {
    return undefined;
  }
}
