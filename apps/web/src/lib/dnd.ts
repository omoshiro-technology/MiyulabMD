export const TREE_DRAG_MIME = "application/x-miyulabmd-tree";

export type TreeDragItem = {
  kind: "note" | "folder";
  id: string;
};

export function encodeTreeDragItem(item: TreeDragItem): string {
  return JSON.stringify(item);
}

export function decodeTreeDragItem(payload: string): TreeDragItem | null {
  try {
    const parsed = JSON.parse(payload) as Partial<TreeDragItem>;
    if (
      (parsed.kind === "note" || parsed.kind === "folder") &&
      typeof parsed.id === "string" &&
      parsed.id
    ) {
      return { id: parsed.id, kind: parsed.kind };
    }
  } catch {
    // not our payload
  }
  return null;
}
