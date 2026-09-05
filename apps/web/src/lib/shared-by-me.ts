import type {
  AccessScope,
  EffectiveAccess,
  FolderAccess,
  NoteSummary,
} from "@miyulabmd/shared";

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

function sameSharing(a: EffectiveAccess, b: EffectiveAccess): boolean {
  if (
    a.effectiveReadScope !== b.effectiveReadScope ||
    a.effectiveWriteScope !== b.effectiveWriteScope
  )
    return false;

  // Grants only affect access when either scope targets specific users.
  if (a.effectiveReadScope !== "users" && a.effectiveWriteScope !== "users") {
    return true;
  }
  const grantsKey = (access: EffectiveAccess) =>
    JSON.stringify(
      access.grants
        .map((grant) => [
          grant.userId ?? grant.email.trim().toLowerCase(),
          access.effectiveWriteScope === "users" && grant.canWrite,
        ])
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    );
  return grantsKey(a) === grantsKey(b);
}

/** Root lists sharing boundaries; a folder lists its shared direct children. */
export function sharedByMeItems(
  folders: FolderAccess[],
  notes: NoteSummary[],
  ownerId: string,
  folderId: string | null,
): { folders: FolderAccess[]; notes: NoteSummary[] } {
  const sharedFolders = filterSharedByMeFolders(folders);
  const sharedNotes = filterSharedByMeNotes(notes, ownerId);
  if (folderId !== null) {
    return {
      folders: sharedFolders.filter((folder) => folder.parentId === folderId),
      notes: sharedNotes.filter((note) => note.folderId === folderId),
    };
  }

  const parents = new Map(sharedFolders.map((folder) => [folder.id, folder]));
  const isBoundary = (access: EffectiveAccess, parentId: string | null) => {
    const parent = parents.get(parentId);
    return !parent || !sameSharing(access, parent);
  };
  return {
    folders: sharedFolders.filter((folder) =>
      isBoundary(folder, folder.parentId),
    ),
    notes: sharedNotes.filter((note) => isBoundary(note.access, note.folderId)),
  };
}
