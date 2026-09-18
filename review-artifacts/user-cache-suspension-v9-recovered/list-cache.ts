import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import { type ApiResult, fetchFolder, fetchNotes } from "./api.ts";

let notesCache: NoteSummary[] | null = null;
let notesInflight: Promise<NoteSummary[]> | null = null;

const folderCache = new Map<string, FolderAccess>();
const folderInflight = new Map<string, Promise<ApiResult<FolderAccess>>>();

export function folderCacheKey(id?: string | null): string {
  return id ?? "__root__";
}

export function peekNotes(): NoteSummary[] | null {
  return notesCache;
}

export function peekFolder(id?: string | null): FolderAccess | undefined {
  return folderCache.get(folderCacheKey(id));
}

export function invalidateNotesCache(): void {
  notesCache = null;
  notesInflight = null;
}

export function invalidateFolderCache(id?: string | null): void {
  if (id === undefined) {
    folderCache.clear();
    folderInflight.clear();
    return;
  }
  const key = folderCacheKey(id);
  folderCache.delete(key);
  folderInflight.delete(key);
}

export function seedFolderCache(data: FolderAccess): void {
  folderCache.set(folderCacheKey(data.id), data);
}

export function upsertNoteSummary(note: NoteSummary): void {
  const current = notesCache ?? [];
  const index = current.findIndex((item) => item.id === note.id);
  notesCache =
    index === -1
      ? [note, ...current]
      : current.map((item, itemIndex) => (itemIndex === index ? note : item));
}

export async function loadNotes(force = false): Promise<NoteSummary[]> {
  if (!force && notesCache) {
    return notesCache;
  }
  if (!force && notesInflight) {
    return notesInflight;
  }

  const previous = notesCache;
  const assertCurrent = (): void => {
    if (notesInflight !== promise) {
      throw new DOMException("List cache read invalidated", "AbortError");
    }
  };
  const promise: Promise<NoteSummary[]> = fetchNotes()
    .then((notes) => {
      assertCurrent();
      notesCache = notes;
      notesInflight = null;
      return notes;
    })
    .catch((error: unknown) => {
      assertCurrent();
      notesInflight = null;
      if (previous) {
        notesCache = previous;
        return previous;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      return [];
    });
  notesInflight = promise;
  return await promise;
}

export async function loadFolder(
  id?: string | null,
  force = false,
): Promise<ApiResult<FolderAccess>> {
  const key = folderCacheKey(id);
  if (!force) {
    const cached = folderCache.get(key);
    if (cached) {
      return { data: cached, ok: true };
    }
    const inflight = folderInflight.get(key);
    if (inflight) {
      return inflight;
    }
  }

  const promise: Promise<ApiResult<FolderAccess>> = fetchFolder(id).then(
    (result) => {
      if (folderInflight.get(key) !== promise) {
        throw new DOMException("Folder cache read invalidated", "AbortError");
      }
      folderInflight.delete(key);
      if (result.ok) {
        folderCache.set(key, result.data);
      }
      return result;
    },
  );
  folderInflight.set(key, promise);
  return await promise;
}

export function prefetchFolder(id?: string | null): void {
  void loadFolder(id).catch(() => {
    // Prefetch is best effort, including identity invalidation.
  });
}
