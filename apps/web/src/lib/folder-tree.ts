import type { FolderRecord } from "@miyulabmd/shared";

export function childrenOf(
  folders: FolderRecord[],
  parentId: string | null,
): FolderRecord[] {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export function folderChain(
  folders: FolderRecord[],
  path: string,
): FolderRecord[] {
  if (!path) return [];
  const byPath = new Map<string, FolderRecord>();
  for (const folder of folders) {
    if (folder.folder) byPath.set(folder.folder, folder);
  }
  const chain: FolderRecord[] = [];
  let prefix = "";
  for (const part of path.split("/").filter(Boolean)) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const next = byPath.get(prefix);
    if (!next) break;
    chain.push(next);
  }
  return chain;
}

export type FolderHierarchyLevel = {
  parentId: string | null;
  parentPath: string;
  options: FolderRecord[];
  selected: string;
};

function driveRootId(folders: FolderRecord[]): string | null {
  return folders.find((folder) => folder.folder === "")?.id ?? null;
}

/** 記事ソースに選べるフォルダがあるか。マイドライブ自体は対象外。 */
export function hasSelectableSourceFolders(folders: FolderRecord[]): boolean {
  return folders.some((folder) => Boolean(folder.folder));
}

export function folderHierarchyLevels(
  folders: FolderRecord[],
  selectedPath: string,
): FolderHierarchyLevel[] {
  const chain = folderChain(folders, selectedPath);
  const rootId = driveRootId(folders);
  const roots = childrenOf(folders, rootId);
  const levels: FolderHierarchyLevel[] = [
    {
      parentId: rootId,
      parentPath: "",
      options: roots,
      selected: chain[0]?.folder ?? "",
    },
  ];

  for (const [index, current] of chain.entries()) {
    const kids = childrenOf(folders, current.id);
    if (kids.length === 0) break;
    levels.push({
      parentId: current.id,
      parentPath: current.folder ?? "",
      options: kids,
      selected: chain[index + 1]?.folder ?? "",
    });
  }

  return levels;
}
