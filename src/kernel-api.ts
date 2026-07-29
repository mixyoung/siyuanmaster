import type * as kernel from "siyuan/kernel";
import type { NotebookSummary } from "./types";

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
    await this.post<unknown>("/api/block/updateBlock", {
      dataType: "markdown",
      data: markdown,
      id: assertSiyuanId(documentId, "documentId"),
    });
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
