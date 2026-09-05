import type { AccessScope, FolderAccess, NoteSummary } from "@miyulabmd/shared";

function isSelfScope(scope: AccessScope): boolean {
  return scope === "self";
}

export function isSharedByMeFolder(folder: FolderAccess): boolean {
  return folder.locked !== true && !isSelfScope(folder.effectiveReadScope);
}

export function isSharedByMeNote(note: NoteSummary, ownerId: string): boolean {
  return (
    note.ownerId === ownerId && !isSelfScope(note.access.effectiveReadScope)
  );
}

export function filterSharedByMeNotes(
  notes: NoteSummary[],
  ownerId: string,
): NoteSummary[] {
  return notes.filter((note) => isSharedByMeNote(note, ownerId));
}

export function filterSharedByMeFolders(
  folders: FolderAccess[],
): FolderAccess[] {
  return folders.filter(isSharedByMeFolder);
}
