import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import {
  isOfflineCacheUserSuspended,
  openOfflineCache,
} from "./offline-cache.ts";

export type CachedDriveView = {
  folder: FolderAccess | null;
  folderCachedAt: number | null;
  folderMissing: boolean;
  notes: NoteSummary[];
  notesCachedAt: number | null;
  notesMissing: boolean;
};

export async function readCachedDrive(
  userId: string,
  folderId: string | null,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): Promise<CachedDriveView> {
  const ensureReadIsCurrent = () => {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (isCurrent && !isCurrent()) {
      throw new DOMException(
        "Cached drive view is no longer current",
        "AbortError",
      );
    }
    if (isOfflineCacheUserSuspended(userId)) {
      throw new DOMException("Offline cache is suspended");
    }
  };
  const cache = await openOfflineCache({ signal, userId });
  let result: CachedDriveView;
  try {
    ensureReadIsCurrent();
    const noteList = await cache.getNoteList();
    ensureReadIsCurrent();
    const folder = await cache.getFolder(folderId);
    result = {
      folder: folder?.folder ?? null,
      folderCachedAt: folder?.cachedAt ?? null,
      folderMissing: folder === null,
      notes: noteList?.notes ?? [],
      notesCachedAt: noteList?.cachedAt ?? null,
      notesMissing: noteList === null,
    };
  } finally {
    cache.close();
  }
  ensureReadIsCurrent();
  return result;
}
