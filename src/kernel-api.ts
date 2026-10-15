import type * as kernel from "siyuan/kernel";
import {
  documentTreePathDepth,
  type DocumentTreeRow,
} from "./document-tree";
import type { NotebookSummary } from "./types";
import type { ScopeMember } from "./scope-read";

interface KernelApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

export interface BlockRecord {
  id: string;
  root_id: string;
  box: string;
  path: string;
  hpath: string;
  name: string;
  alias: string;
  memo: string;
  tag: string;
  content: string;
  type: string;
  subtype: string;
  created: string;
  updated: string;
}

export interface DocumentContext {
  requested: BlockRecord;
  document: BlockRecord;
}

export interface MarkdownExport {
  hPath: string;
  content: string;
}

interface CountRow {
  count: number | string;
}

interface DocumentTreeCountRow {
  total_count: number | string;
  eligible_count: number | string;
}

export interface DocumentTreeQueryResult {
  rows: DocumentTreeRow[];
  totalCount: number;
  eligibleCount: number;
}

const SIYUAN_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

export function assertSiyuanId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SIYUAN_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid SiYuan ID`);
  }
  return value;
}

export function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export function normalizeDocumentPath(
  parentPath: unknown,
  title: unknown,
): string {
  const safeTitle = normalizeDocumentTitle(title);

  const rawParent =
    typeof parentPath === "string" ? parentPath.trim() : "/";
  const segments = rawParent
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("parentPath must not contain relative path segments");
  }
  return `/${[...segments, safeTitle].join("/")}`;
}

export function normalizeDocumentTitle(title: unknown): string {
  if (typeof title !== "string") {
    throw new Error("title is required");
  }
  const safeTitle = title
    .replace(/[\r\n\t/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!safeTitle) {
    throw new Error("title must not be empty");
  }
  if (safeTitle.length > 256) {
    throw new Error("title must not exceed 256 characters");
  }
  return safeTitle;
}

export class KernelApiClient {
  constructor(private readonly api: kernel.ISiyuan) {}

  async post<T>(
    path: kernel.TRequestPath,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.api.client.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `SiYuan API failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as KernelApiEnvelope<T>;
    if (payload.code !== 0) {
      throw new Error(payload.msg || `SiYuan API failed: ${path}`);
    }
    return payload.data;
  }

  /**
   * Read a workspace-relative JSON file (e.g. legacy petal paths).
   * Returns undefined on missing/corrupt/error — fail closed.
   */
  async readWorkspaceJson(path: string): Promise<unknown | undefined> {
    try {
      const response = await this.api.client.fetch("/api/file/getFile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        return undefined;
      }
      const text = await response.text();
      if (!text) {
        return undefined;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          "code" in (parsed as Record<string, unknown>) &&
          typeof (parsed as Record<string, unknown>).code === "number" &&
          (parsed as Record<string, unknown>).code !== 0
        ) {
          return undefined;
        }
        return parsed;
      } catch {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  async sql<T>(statement: string): Promise<T[]> {
    return this.post<T[]>("/api/query/sql", { stmt: statement });
  }

  async listNotebooks(): Promise<NotebookSummary[]> {
    const data = await this.post<{ notebooks?: NotebookSummary[] }>(
      "/api/notebook/lsNotebooks",
      {},
    );
    return data.notebooks ?? [];
  }

  async getBlock(id: string): Promise<BlockRecord> {
    const safeId = assertSiyuanId(id, "id");
    const rows = await this.sql<BlockRecord>(
      `SELECT id, root_id, box, path, hpath, name, alias, memo, tag, content, type, subtype, created, updated
       FROM blocks
       WHERE id = '${escapeSqlLiteral(safeId)}'
       LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new Error("Target block was not found");
    }
    return rows[0];
  }

  async listExactDocumentsByIds(ids: string[]): Promise<BlockRecord[]> {
    const uniqueIds = [
      ...new Set(ids.map((id) => assertSiyuanId(id, "documentId"))),
    ];
    const results: BlockRecord[] = [];
    // Chunk at the SQL API's bare-query row cap (64): an IN-list query without
    // LIMIT is silently truncated to 64 rows, so larger chunks would drop
    // documents.
    for (let offset = 0; offset < uniqueIds.length; offset += 64) {
      const chunk = uniqueIds.slice(offset, offset + 64);
      if (chunk.length === 0) {
        continue;
      }
      const idList = chunk
        .map((id) => `'${escapeSqlLiteral(id)}'`)
        .join(", ");
      results.push(
        ...(await this.sql<BlockRecord>(
          `SELECT id, root_id, box, path, hpath, name, alias, memo, tag, content, type, subtype, created, updated
           FROM blocks
           WHERE type = 'd' AND id IN (${idList})`,
        )),
      );
    }
    return results;
  }

  async getDocumentContext(id: string): Promise<DocumentContext> {
    const requested = await this.getBlock(id);
    const documentId =
      requested.type === "d" ? requested.id : requested.root_id;
    const document =
      requested.id === documentId
        ? requested
        : await this.getBlock(documentId);
    if (document.type !== "d") {
      throw new Error("Target does not resolve to a document");
    }
    return { requested, document };
  }

  async exportMarkdown(documentId: string): Promise<MarkdownExport> {
    return this.post<MarkdownExport>("/api/export/exportMdContent", {
      id: assertSiyuanId(documentId, "documentId"),
      yfm: false,
      addTitle: false,
    });
  }

  async createDocument(input: {
    notebookId: string;
    title: string;
    parentPath?: string;
    markdown: string;
  }): Promise<string> {
    return this.post<string>("/api/filetree/createDocWithMd", {
      notebook: assertSiyuanId(input.notebookId, "notebookId"),
      path: normalizeDocumentPath(input.parentPath, input.title),
      markdown: input.markdown,
    });
  }

  async appendMarkdown(documentId: string, markdown: string): Promise<void> {
    await this.post<unknown>("/api/block/appendBlock", {
      dataType: "markdown",
      data: markdown,
      parentID: assertSiyuanId(documentId, "documentId"),
    });
  }

  async updateDocument(
    documentId: string,
    markdown: string,
  ): Promise<void> {
    await this.updateBlockMarkdown(documentId, markdown);
  }

  /** Updates a single block (or whole-document root) via Kernel API only. */
  async updateBlockMarkdown(
    blockId: string,
    markdown: string,
  ): Promise<void> {
    await this.post<unknown>("/api/block/updateBlock", {
      dataType: "markdown",
      data: markdown,
      id: assertSiyuanId(blockId, "blockId"),
    });
  }

  /** Reads a block's kramdown/markdown via Kernel API (never raw .sy). */
  async getBlockKramdown(blockId: string): Promise<string> {
    const data = await this.post<{ kramdown?: string; id?: string }>(
      "/api/block/getBlockKramdown",
      { id: assertSiyuanId(blockId, "blockId") },
    );
    return typeof data.kramdown === "string" ? data.kramdown : "";
  }

  /** Hard per-document fetch cap. A document with more content blocks than
   * this is reported as truncated — the fetched count must never be treated
   * as the document's true block total. */
  static readonly MAX_DOCUMENT_BLOCK_FETCH = 5000;

  /**
   * Ordered content blocks under a document root, excluding the document
   * row itself. Used by segmented long-document reads. Fetches one extra
   * row beyond the cap to detect database-level truncation; `dbTruncated`
   * is true when the document has more blocks than were returned.
   */
  async listDocumentBlocks(documentId: string): Promise<{
    blocks: Array<{
      id: string;
      type: string;
      subtype: string;
      content: string;
      markdown: string;
      sort: number;
    }>;
    dbTruncated: boolean;
  }> {
    const safeId = assertSiyuanId(documentId, "documentId");
    const rows = await this.sql<{
      id: string;
      type: string;
      subtype: string;
      content: string;
      markdown: string;
      sort: number | string;
    }>(
      `SELECT id, type, subtype, content, markdown, sort
       FROM blocks
       WHERE root_id = '${escapeSqlLiteral(safeId)}'
         AND id != '${escapeSqlLiteral(safeId)}'
       ORDER BY sort ASC, id ASC
       LIMIT ${KernelApiClient.MAX_DOCUMENT_BLOCK_FETCH + 1}`,
    );
    const dbTruncated = rows.length > KernelApiClient.MAX_DOCUMENT_BLOCK_FETCH;
    return {
      blocks: rows.slice(0, KernelApiClient.MAX_DOCUMENT_BLOCK_FETCH).map((row) => ({
        id: row.id,
        type: row.type,
        subtype: row.subtype ?? "",
        content: row.content ?? "",
        markdown: row.markdown ?? "",
        sort: Number(row.sort) || 0,
      })),
      dbTruncated,
    };
  }

  /** Hard per-target reference-fetch cap. More refs than this are reported
   * as truncated — the fetched count is a lower bound, never the true total. */
  static readonly MAX_REFERENCING_FETCH = 200;

  /**
   * Blocks that reference `blockId` as a definition target (`refs` table).
   * Results are metadata-only snippets for impact previews. Fetches one
   * extra row beyond the cap to detect truncation; `dbTruncated` is true
   * when more refs exist than were returned.
   */
  async listReferencingBlocks(blockId: string): Promise<{
    referencing: Array<{
      blockId: string;
      documentId: string;
      notebookId: string;
      contentSnippet: string;
    }>;
    dbTruncated: boolean;
  }> {
    const safeId = assertSiyuanId(blockId, "blockId");
    const rows = await this.sql<{
      block_id: string;
      root_id: string;
      box: string;
      content: string;
    }>(
      `SELECT r.block_id AS block_id,
              b.root_id AS root_id,
              b.box AS box,
              b.content AS content
       FROM refs r
       JOIN blocks b ON b.id = r.block_id
       WHERE r.def_block_id = '${escapeSqlLiteral(safeId)}'
       LIMIT ${KernelApiClient.MAX_REFERENCING_FETCH + 1}`,
    );
    const dbTruncated =
      rows.length > KernelApiClient.MAX_REFERENCING_FETCH;
    return {
      referencing: rows
        .slice(0, KernelApiClient.MAX_REFERENCING_FETCH)
        .map((row) => ({
          blockId: row.block_id,
          documentId: row.root_id,
          notebookId: row.box,
          contentSnippet: (row.content ?? "").slice(0, 120),
        })),
      dbTruncated,
    };
  }

  async removeDocument(documentId: string): Promise<void> {
    await this.post<unknown>("/api/filetree/removeDocByID", {
      id: assertSiyuanId(documentId, "documentId"),
    });
  }

  async renameDocument(
    documentId: string,
    title: string,
  ): Promise<void> {
    await this.post<unknown>("/api/filetree/renameDocByID", {
      id: assertSiyuanId(documentId, "documentId"),
      title: normalizeDocumentTitle(title),
    });
  }

  async moveDocument(
    documentId: string,
    targetId: string,
  ): Promise<void> {
    await this.post<unknown>("/api/filetree/moveDocsByID", {
      fromIDs: [assertSiyuanId(documentId, "documentId")],
      toID: assertSiyuanId(targetId, "targetId"),
    });
  }

  async findDocumentByHPath(
    notebookId: string,
    hPath: string,
    excludeDocumentId?: string,
  ): Promise<BlockRecord | undefined> {
    const safeNotebookId = assertSiyuanId(notebookId, "notebookId");
    const exclusion = excludeDocumentId
      ? `AND id != '${escapeSqlLiteral(
          assertSiyuanId(excludeDocumentId, "excludeDocumentId"),
        )}'`
      : "";
    const rows = await this.sql<BlockRecord>(
      `SELECT id, root_id, box, path, hpath, name, alias, memo, tag, content, type, subtype, created, updated
       FROM blocks
       WHERE type = 'd'
         AND box = '${escapeSqlLiteral(safeNotebookId)}'
         AND hpath = '${escapeSqlLiteral(hPath)}'
         ${exclusion}
       LIMIT 1`,
    );
    return rows[0];
  }

  async countDocumentTree(document: BlockRecord): Promise<number> {
    const documentId = assertSiyuanId(document.id, "documentId");
    const notebookId = assertSiyuanId(document.box, "notebookId");
    const directory = document.path.replace(/\.sy$/i, "");
    const rows = await this.sql<CountRow>(
      `SELECT COUNT(*) AS count
       FROM blocks
       WHERE type = 'd'
         AND box = '${escapeSqlLiteral(notebookId)}'
         AND (
           id = '${escapeSqlLiteral(documentId)}'
           OR path LIKE '${escapeSqlLiteral(directory)}/%'
         )`,
    );
    const count = Number(rows[0]?.count ?? 0);
    return Number.isFinite(count) ? count : 0;
  }

  async listDocumentTree(input: {
    notebookId: string;
    parentDocument?: BlockRecord;
    maxDepth: number;
    maxNodes: number;
    /** Keyset cursor: only documents with a physical path after this value. */
    afterPath?: string;
  }): Promise<DocumentTreeQueryResult> {
    const notebookId = assertSiyuanId(input.notebookId, "notebookId");
    const parent = input.parentDocument;
    const baseDepth = parent ? documentTreePathDepth(parent.path) : 0;
    const depthLimit = baseDepth + input.maxDepth;
    const depthExpression =
      "(LENGTH(d.path) - LENGTH(REPLACE(d.path, '/', '')))";
    const commonWhere = this.documentScopeWhere(notebookId, parent);
    const afterPath = input.afterPath
      ? `AND d.path > '${escapeSqlLiteral(input.afterPath)}'`
      : "";

    const counts = await this.sql<DocumentTreeCountRow>(
      `SELECT
         COUNT(*) AS total_count,
         COALESCE(SUM(CASE
           WHEN ${depthExpression} <= ${depthLimit} THEN 1
           ELSE 0
         END), 0) AS eligible_count
       FROM blocks d
       WHERE ${commonWhere}`,
    );
    const rows = await this.sql<DocumentTreeRow>(
      `SELECT
         d.id AS id,
         d.path AS path,
         d.hpath AS hpath,
         d.content AS title,
         d.updated AS updated,
         CASE WHEN EXISTS (
           SELECT 1
           FROM blocks child
           WHERE child.type = 'd'
             AND child.id = child.root_id
             AND child.box = d.box
             AND child.path LIKE (
               SUBSTR(d.path, 1, LENGTH(d.path) - 3) || '/%'
             )
           LIMIT 1
         ) THEN 1 ELSE 0 END AS has_children
       FROM blocks d
       WHERE ${commonWhere}
         AND ${depthExpression} <= ${depthLimit}
         ${afterPath}
       ORDER BY d.path ASC
       LIMIT ${input.maxNodes}`,
    );
    const totalCount = Number(counts[0]?.total_count ?? 0);
    const eligibleCount = Number(counts[0]?.eligible_count ?? 0);
    return {
      rows,
      totalCount: Number.isFinite(totalCount) ? totalCount : 0,
      eligibleCount: Number.isFinite(eligibleCount) ? eligibleCount : 0,
    };
  }

  /** Shared exact scope predicate: one notebook, optionally rooted at one
   * physical document subtree. Paths are ID-based; titles never enter this
   * predicate. */
  private documentScopeWhere(
    notebookId: string,
    parent?: BlockRecord,
  ): string {
    const scope = parent
      ? `AND (
           d.id = '${escapeSqlLiteral(parent.id)}'
           OR d.path LIKE '${escapeSqlLiteral(
             parent.path.replace(/\.sy$/i, ""),
           )}/%'
         )`
      : "";
    return `d.type = 'd'
       AND d.id = d.root_id
       AND d.box = '${escapeSqlLiteral(notebookId)}'
       ${scope}`;
  }

  /**
   * Full member list of a scope, ordered by physical path: the enumeration
   * universe for scope reads and the input to the scope change fingerprint.
   * No node limit — callers enforce their own capacity bounds, and a scope
   * must never be silently trimmed.
   */
  async listScopeMembers(input: {
    notebookId: string;
    parentDocument?: BlockRecord;
    /** Optional relative depth bound; omit for the complete subtree. */
    maxDepth?: number;
  }): Promise<ScopeMember[]> {
    const notebookId = assertSiyuanId(input.notebookId, "notebookId");
    const parent = input.parentDocument;
    const commonWhere = this.documentScopeWhere(notebookId, parent);
    const depthClause =
      input.maxDepth === undefined
        ? ""
        : `AND (LENGTH(d.path) - LENGTH(REPLACE(d.path, '/', ''))) <= ${
            (parent ? documentTreePathDepth(parent.path) : 0) + input.maxDepth
          }`;
    // The SQL API silently truncates bare queries at 64 rows, so the member
    // manifest must be fetched in explicit-LIMIT keyset pages on d.path; a
    // single unbounded query would under-count scopes, defang the session
    // capacity cap, and fingerprint a partial member list.
    const PAGE_SIZE = 500;
    const members: Array<{ id: string; path: string; updated: string; contentMark: string }> = [];
    let afterPath = "";
    for (;;) {
      const keyset = afterPath
        ? `AND d.path > '${escapeSqlLiteral(afterPath)}'`
        : "";
      const page = await this.sql<{ id: string; path: string; updated: string }>(
        `SELECT d.id AS id, d.path AS path, d.updated AS updated
         FROM blocks d
         WHERE ${commonWhere}
           ${depthClause}
           ${keyset}
         ORDER BY d.path ASC
         LIMIT ${PAGE_SIZE}`,
      );
      // SiYuan bumps a document block's `updated` only on structural changes;
      // in-place content edits touch child blocks alone. The per-document
      // child aggregate (count + newest child updated) is the content signal
      // coverage re-verification compares. Chunked at 64 ids because bare
      // queries are capped at 64 rows.
      const stats = new Map<string, string>();
      for (let offset = 0; offset < page.length; offset += 64) {
        const idList = page
          .slice(offset, offset + 64)
          .map((row) => `'${escapeSqlLiteral(assertSiyuanId(row.id, "documentId"))}'`)
          .join(", ");
        const rows = await this.sql<{ root_id: string; n: number | string; max_updated: string | null }>(
          `SELECT root_id AS root_id, COUNT(*) AS n, MAX(updated) AS max_updated
           FROM blocks
           WHERE root_id IN (${idList})
           GROUP BY root_id`,
        );
        for (const row of rows) {
          stats.set(row.root_id, `${Number(row.n)}:${row.max_updated ?? "-"}`);
        }
      }
      for (const row of page) {
        members.push({
          id: row.id,
          path: row.path,
          updated: row.updated,
          contentMark: stats.get(row.id) ?? "0:-",
        });
      }
      if (page.length < PAGE_SIZE) {
        return members;
      }
      afterPath = page[page.length - 1].path;
    }
  }

  async getBlockAttrs(
    blockId: string,
  ): Promise<Record<string, string>> {
    return this.post<Record<string, string>>("/api/attr/getBlockAttrs", {
      id: assertSiyuanId(blockId, "blockId"),
    });
  }

  async setBlockAttrs(
    blockId: string,
    attrs: Record<string, string>,
  ): Promise<void> {
    await this.post<unknown>("/api/attr/setBlockAttrs", {
      id: assertSiyuanId(blockId, "blockId"),
      attrs,
    });
  }
}
