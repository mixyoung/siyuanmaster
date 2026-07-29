import type { BlockRecord } from "./kernel-api";

export const STRUCTURE_PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface StructureSnapshot {
  documentId: string;
  notebookId: string;
  path: string;
  hPath: string;
  title: string;
  updated: string;
}

export interface RenamePreview {
  kind: "rename";
  token: string;
  expiresAt: number;
  source: StructureSnapshot;
  newTitle: string;
  targetHPath: string;
  subtreeDocumentCount: number;
}

export interface MovePreview {
  kind: "move";
  token: string;
  expiresAt: number;
  source: StructureSnapshot;
  targetNotebookId: string;
  targetParent?: StructureSnapshot;
  targetHPath: string;
  crossNotebook: boolean;
  subtreeDocumentCount: number;
}

export type StructurePreview = RenamePreview | MovePreview;

export function snapshotDocument(
  document: BlockRecord,
): StructureSnapshot {
  return {
    documentId: document.id,
    notebookId: document.box,
    path: document.path,
    hPath: document.hpath,
    title: document.content,
    updated: document.updated,
  };
}

export function documentDirectory(path: string): string {
  return path.replace(/\.sy$/i, "");
}

export function documentParentDirectory(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function documentParentId(
  document: Pick<BlockRecord, "box" | "path">,
): string {
  const parent = documentParentDirectory(document.path);
  if (parent === "/") {
    return document.box;
  }
  return parent.split("/").filter(Boolean).at(-1) ?? document.box;
}

export function isSameOrDescendantPath(
  candidatePath: string,
  ancestorDocumentPath: string,
): boolean {
  const candidate = candidatePath.replaceAll("\\", "/");
  const ancestorDirectory = documentDirectory(
    ancestorDocumentPath.replaceAll("\\", "/"),
  );
  return (
    candidate === ancestorDocumentPath ||
    candidate.startsWith(`${ancestorDirectory}/`)
  );
}

export function joinHumanPath(parentHPath: string, title: string): string {
  const parent = parentHPath.replace(/\/+$/g, "");
  return `${parent || ""}/${title}` || "/";
}

export function replaceHumanPathTitle(
  currentHPath: string,
  title: string,
): string {
  const normalized = currentHPath.replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  const parent = index <= 0 ? "" : normalized.slice(0, index);
  return joinHumanPath(parent, title);
}

export function previewMatchesCurrent(
  preview: StructureSnapshot,
  current: BlockRecord,
): boolean {
  return (
    preview.documentId === current.id &&
    preview.notebookId === current.box &&
    preview.path === current.path &&
    preview.hPath === current.hpath &&
    preview.title === current.content &&
    preview.updated === current.updated
  );
}
