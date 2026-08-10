// P1 document access helpers: long-document segmented reading, block
// reference breakage impact, and lookup-only human-readable path
// resolution. All functions are pure over row-shaped data (or take a thin
// injected client) so they are unit-testable without SiYuan.

import type { BlockRecord } from "./kernel-api";

/** Minimal block row shape (subset of the SiYuan `blocks` table). */
export interface BlockRow {
  blockId: string;
  blockType: string;
  content: string;
  markdown?: string;
  sort: number;
}

export function blockDisplayText(row: BlockRow): string {
  const markdown = row.markdown?.trim();
  return markdown ? markdown : row.content;
}

/** Extracts heading level from `h1`..`h6`; returns null for others. */
export function headingLevel(blockType: string): number | null {
  const match = /^h([1-6])$/.exec(blockType);
  return match ? Number(match[1]) : null;
}

export interface OutlineItem {
  blockId: string;
  level: number;
  text: string;
}

/** Builds the outline from heading rows (assumed ordered by sort). */
export function buildOutline(headings: readonly BlockRow[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const row of headings) {
    const level = headingLevel(row.blockType);
    if (level !== null) {
      items.push({ blockId: row.blockId, level, text: blockDisplayText(row).trim() });
    }
  }
  return items;
}

export interface WindowResult {
  page: BlockRow[];
  nextOffset: number | null;
}

/** Windows over an ordered block list (mirrors `core::segments`). */
export function windowBlocks(
  blocks: readonly BlockRow[],
  offset: number,
  limit: number,
): WindowResult {
  const safeOffset = Math.min(Math.max(0, Math.floor(offset)), blocks.length);
  const end = Math.min(safeOffset + Math.max(1, Math.floor(limit)), blocks.length);
  return {
    page: blocks.slice(safeOffset, end),
    nextOffset: end < blocks.length ? end : null,
  };
}

export interface ReferencingBlock {
  blockId: string;
  documentId: string;
  notebookId: string;
  contentSnippet: string;
}

export type ReferenceRisk = "none" | "some" | "critical";
export type ReferenceProtectionMode = "warn" | "deny";

/** Classifies breakage risk of changing/deleting a block. */
export function classifyReferenceRisk(
  referencing: readonly ReferencingBlock[],
  targetDocumentId: string,
): ReferenceRisk {
  if (referencing.length === 0) {
    return "none";
  }
  return referencing.some((block) => block.documentId !== targetDocumentId)
    ? "critical"
    : "some";
}

/** Whether the write is allowed under the protection mode. */
export function referenceAllows(
  referencing: readonly ReferencingBlock[],
  mode: ReferenceProtectionMode,
): boolean {
  return mode === "warn" ? true : referencing.length === 0;
}

/** Bounded snippet for previews/audit (never the full body). */
export function snippet(text: string, maxChars = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}…`
    : normalized;
}

/** Minimal client surface needed for read-only path resolution. */
export interface DocumentLookupClient {
  findDocumentByHPath(
    notebookId: string,
    hPath: string,
    excludeDocumentId?: string,
  ): Promise<BlockRecord | undefined>;
}

export interface ResolvedDocument {
  documentId: string;
  notebookId: string;
  title: string;
  hPath: string;
  path: string;
  updated: string;
}

/**
 * Resolves a human-readable path (`/AI/Memory/note`) to document metadata
 * by ID lookup. Read-only by construction: this function only calls
 * `findDocumentByHPath` and never invokes any write API. Writes must
 * address targets by ID plus expected state — see [`parseWriteTarget`].
 */
export async function resolveDocumentPath(
  client: DocumentLookupClient,
  notebookId: string,
  hPath: string,
): Promise<ResolvedDocument> {
  const normalized = hPath.replace(/\/+$/, "");
  if (!normalized.startsWith("/") || normalized === "/") {
    throw new Error("hPath must be an absolute human-readable path such as /AI/Memory/note");
  }
  const document = await client.findDocumentByHPath(notebookId, normalized);
  if (!document) {
    throw new Error("no document found at the given human-readable path");
  }
  return {
    documentId: document.id,
    notebookId: document.box,
    title: document.content,
    hPath: document.hpath,
    path: document.path,
    updated: document.updated,
  };
}

const SIYUAN_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

export interface WriteTarget {
  id: string;
  expectedHash?: string;
}

/**
 * Write targets must be exact SiYuan IDs plus an optional expected-state
 * hash. Paths are never accepted here (lookup-only).
 */
export function parseWriteTarget(
  rawId: string,
  expectedHash?: string,
): WriteTarget {
  const id = rawId.trim();
  if (!SIYUAN_ID_PATTERN.test(id)) {
    throw new Error(
      `write targets must be exact SiYuan IDs (14 digits + '-' + 7 lowercase alphanumerics); received '${rawId}'`,
    );
  }
  if (expectedHash !== undefined && !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error("expectedHash must be a 64-character hex SHA-256 digest");
  }
  return { id, expectedHash };
}
