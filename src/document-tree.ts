export interface DocumentTreeRow {
  id: string;
  path: string;
  hpath: string;
  title: string;
  updated: string;
  has_children: boolean | number | string;
}

export interface DocumentTreeNode {
  id: string;
  title: string;
  hPath: string;
  parentId: string | null;
  depth: number;
  updated: string;
  hasChildren: boolean;
  children: DocumentTreeNode[];
}

const SIYUAN_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

export function documentTreePathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export function documentTreeParentId(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const parentId = segments.at(-2) ?? "";
  return SIYUAN_ID_PATTERN.test(parentId) ? parentId : null;
}

function fallbackTitle(row: DocumentTreeRow): string {
  const title = row.title.trim();
  if (title) {
    return title;
  }
  return row.hpath.split("/").filter(Boolean).at(-1) ?? "Untitled";
}

function rowHasChildren(value: DocumentTreeRow["has_children"]): boolean {
  return value === true || Number(value) > 0;
}

function sortNodes(nodes: DocumentTreeNode[]): void {
  nodes.sort(
    (left, right) =>
      left.title.localeCompare(right.title, "zh-CN") ||
      left.id.localeCompare(right.id),
  );
  for (const node of nodes) {
    sortNodes(node.children);
  }
}

export function buildDocumentTree(
  rows: DocumentTreeRow[],
  rootDocumentId?: string,
): DocumentTreeNode[] {
  const rootRow = rootDocumentId
    ? rows.find((row) => row.id === rootDocumentId)
    : undefined;
  const baseDepth = rootRow ? documentTreePathDepth(rootRow.path) : 0;
  const nodes = new Map<string, DocumentTreeNode>();

  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      title: fallbackTitle(row),
      hPath: row.hpath,
      parentId:
        row.id === rootDocumentId
          ? null
          : documentTreeParentId(row.path),
      depth: Math.max(0, documentTreePathDepth(row.path) - baseDepth),
      updated: row.updated,
      hasChildren: rowHasChildren(row.has_children),
      children: [],
    });
  }

  const roots: DocumentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      node.parentId = null;
      roots.push(node);
    }
  }

  sortNodes(roots);
  return roots;
}
