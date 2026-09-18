// Canonical candidate v9; see decisions.md for transaction-terminal rationale.
import type { FolderAccess, Note, NoteSummary } from "@miyulabmd/shared";

const DATABASE_NAME = "miyulabmd-offline-cache";
const DATABASE_VERSION = 4;
const NOTE_STORE = "notes";
const FOLDER_STORE = "folders";
const NOTE_LIST_STORE = "note-lists";
const METADATA_STORE = "metadata";
const VIEWER_ID_METADATA_KEY = "viewer-id";
const DENIED_NOTE_PREFIX = "denied-note:";
const OPFS_ROOT = "miyulabmd-offline-cache-v1";

type NoteRecord = {
  key: string;
  userId: string;
  noteId: string;
  note: Omit<Note, "markdown">;
  fileName: string;
  cachedAt: number;
};

type FolderRecord = {
  key: string;
  userId: string;
  folderId: string | null;
  folder: FolderAccess;
  cachedAt: number;
};

type NoteListRecord = {
  key: string;
  userId: string;
  notes: NoteSummary[];
  cachedAt: number;
};

type MetadataRecord = {
  key: string;
  value: string;
};

type OfflineCache = {
  putNote(
    note: Note,
    options?: CancellationOptions & { orderingToken?: number },
  ): Promise<void>;
  beginNoteRead(id: string): number;
  denyNote(id: string): Promise<void>;
  clearNoteDenial(id: string, orderingToken?: number): Promise<void>;
  getNote(id: string): Promise<{ note: Note; cachedAt: number } | null>;
  putNoteList(notes: NoteSummary[]): Promise<void>;
  getNoteList(): Promise<{ notes: NoteSummary[]; cachedAt: number } | null>;
  putFolder(folder: FolderAccess): Promise<void>;
  getFolder(
    id: string | null,
  ): Promise<{ folder: FolderAccess; cachedAt: number } | null>;
  close(): void;
};

export type OpenOfflineCacheOptions = {
  userId: string;
};

type CancellationOptions = {
  signal?: AbortSignal;
};

const suspendedUsers = new Set<string>();
const noteGenerations = new Map<string, number>();
const userLifetimes = new Map<string, number>();
const pendingUserOperations = new Map<string, Set<() => void>>();

export function suspendOfflineCacheUser(userId: string): void {
  suspendedUsers.add(userId);
  userLifetimes.set(userId, (userLifetimes.get(userId) ?? 0) + 1);
  for (const abort of pendingUserOperations.get(userId) ?? []) {
    abort();
  }
}

function isUserSuspended(userId: string): boolean {
  return suspendedUsers.has(userId);
}

function currentUserLifetime(userId: string): number {
  return userLifetimes.get(userId) ?? 0;
}

function assertUserActive(userId: string, lifetime: number): void {
  if (isUserSuspended(userId) || currentUserLifetime(userId) !== lifetime) {
    throw new Error("Offline cache is suspended");
  }
}

export function beginOfflineNoteRead(userId: string, noteId: string): number {
  return currentNoteGeneration(userId, noteId);
}

export function isOfflineNoteReadCurrent(
  userId: string,
  noteId: string,
  token: number,
): boolean {
  return currentNoteGeneration(userId, noteId) === token;
}

function deniedNoteKey(userId: string, noteId: string): string {
  return `${DENIED_NOTE_PREFIX}${noteKey(userId, noteId)}`;
}

function generationKey(userId: string, noteId: string): string {
  return noteKey(userId, noteId);
}

function currentNoteGeneration(userId: string, noteId: string): number {
  return noteGenerations.get(generationKey(userId, noteId)) ?? 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason;
  }
}

function encodePathPart(value: string): string {
  // Encode UTF-8 bytes rather than the string itself so every path component
  // is safe even when an ID contains slashes or filesystem punctuation.
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function noteKey(userId: string, noteId: string): string {
  return `${encodePathPart(userId)}:${encodePathPart(noteId)}`;
}

function folderKey(userId: string, folderId: string | null): string {
  return JSON.stringify([userId, folderId]);
}

function noteListKey(userId: string): string {
  return encodePathPart(userId);
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTE_STORE)) {
        request.result.createObjectStore(NOTE_STORE, { keyPath: "key" });
      }
      if (!request.result.objectStoreNames.contains(FOLDER_STORE)) {
        request.result.createObjectStore(FOLDER_STORE, { keyPath: "key" });
      }
      if (!request.result.objectStoreNames.contains(NOTE_LIST_STORE)) {
        request.result.createObjectStore(NOTE_LIST_STORE, { keyPath: "key" });
      }
      if (!request.result.objectStoreNames.contains(METADATA_STORE)) {
        request.result.createObjectStore(METADATA_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(request.error);
    };
  });
}

function commitTransaction(
  database: IDBDatabase,
  storeName: string,
  record: NoteRecord | MetadataRecord,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      throwIfAborted(signal);
      transaction = database.transaction(storeName, "readwrite");
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let requestError: DOMException | null = null;
    const operations =
      pendingUserOperations.get(userId) ?? new Set<() => void>();
    pendingUserOperations.set(userId, operations);
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      operations.delete(onAbort);
      if (!operations.size) {
        pendingUserOperations.delete(userId);
      }
    };
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        cleanup();
        callback();
      }
    };
    const onAbort = () => {
      try {
        transaction.abort();
      } catch {
        // Completion may already be in progress; the terminal event wins.
      }
    };
    operations.add(onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfAborted(signal);
      transaction.objectStore(storeName).put(record);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Preserve the synchronous request error.
      }
      finish(() => reject(error));
      return;
    }
    transaction.oncomplete = () => finish(resolve);
    transaction.onerror = () => {
      requestError = transaction.error;
    };
    transaction.onabort = () =>
      finish(() =>
        reject(
          signal?.aborted
            ? signal.reason
            : (requestError ??
                transaction.error ??
                new DOMException("Transaction aborted")),
        ),
      );
  });
}

function readRecord(
  database: IDBDatabase,
  key: string,
): Promise<NoteRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(NOTE_STORE, "readonly");
    const request = transaction.objectStore(NOTE_STORE).get(key);
    request.onsuccess = () => resolve(request.result as NoteRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

function commitFolderRecord(
  database: IDBDatabase,
  record: FolderRecord,
  userId: string,
): Promise<void> {
  return commitStoreRecord(database, FOLDER_STORE, record, userId);
}

function readFolderRecord(
  database: IDBDatabase,
  key: string,
): Promise<FolderRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FOLDER_STORE, "readonly");
    const request = transaction.objectStore(FOLDER_STORE).get(key);
    request.onsuccess = () =>
      resolve(request.result as FolderRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

function commitNoteListRecord(
  database: IDBDatabase,
  record: NoteListRecord,
  userId: string,
): Promise<void> {
  return commitStoreRecord(database, NOTE_LIST_STORE, record, userId);
}

function commitStoreRecord(
  database: IDBDatabase,
  storeName: string,
  record: FolderRecord | NoteListRecord,
  userId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    const operations =
      pendingUserOperations.get(userId) ?? new Set<() => void>();
    pendingUserOperations.set(userId, operations);
    let settled = false;
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // The terminal event has already won.
      }
    };
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        operations.delete(abort);
        if (!operations.size) {
          pendingUserOperations.delete(userId);
        }
        callback();
      }
    };
    operations.add(abort);
    transaction.oncomplete = () => finish(resolve);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      finish(() =>
        reject(transaction.error ?? new DOMException("Transaction aborted")),
      );
  });
}

function readNoteListRecord(
  database: IDBDatabase,
  key: string,
): Promise<NoteListRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(NOTE_LIST_STORE, "readonly");
    const request = transaction.objectStore(NOTE_LIST_STORE).get(key);
    request.onsuccess = () =>
      resolve(request.result as NoteListRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

function readMetadataRecord(
  database: IDBDatabase,
  key: string,
): Promise<MetadataRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    const request = transaction.objectStore(METADATA_STORE).get(key);
    request.onsuccess = () =>
      resolve(request.result as MetadataRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function readDeniedNote(
  database: IDBDatabase,
  userId: string,
  noteId: string,
): Promise<boolean> {
  return Boolean(
    await readMetadataRecord(database, deniedNoteKey(userId, noteId)),
  );
}

function removeCachedNote(
  database: IDBDatabase,
  userId: string,
  noteId: string,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let removedFileName: string | null = null;
    try {
      transaction = database.transaction(
        [NOTE_STORE, NOTE_LIST_STORE],
        "readwrite",
      );
      const notes = transaction.objectStore(NOTE_STORE);
      const noteRequest = notes.get(noteKey(userId, noteId));
      noteRequest.onsuccess = () => {
        const record = noteRequest.result as NoteRecord | undefined;
        removedFileName = record?.fileName ?? null;
        notes.delete(noteKey(userId, noteId));
        const lists = transaction.objectStore(NOTE_LIST_STORE);
        const listRequest = lists.get(noteListKey(userId));
        listRequest.onsuccess = () => {
          const list = listRequest.result as NoteListRecord | undefined;
          if (list) {
            lists.put({
              ...list,
              notes: list.notes.filter((item) => item.id !== noteId),
            });
          }
        };
        listRequest.onerror = () => transaction.abort();
      };
      noteRequest.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(removedFileName);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted"));
  });
}

function deleteMetadata(
  database: IDBDatabase,
  key: string,
  userId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      transaction.objectStore(METADATA_STORE).delete(key);
    } catch (error) {
      reject(error);
      return;
    }
    const operations =
      pendingUserOperations.get(userId) ?? new Set<() => void>();
    pendingUserOperations.set(userId, operations);
    let settled = false;
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // The terminal event has already won.
      }
    };
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        operations.delete(abort);
        if (!operations.size) {
          pendingUserOperations.delete(userId);
        }
        callback();
      }
    };
    operations.add(abort);
    transaction.oncomplete = () => finish(resolve);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      finish(() =>
        reject(transaction.error ?? new DOMException("Transaction aborted")),
      );
  });
}

export async function persistCachedViewerId(
  viewerId: string,
  options: CancellationOptions = {},
): Promise<void> {
  const { signal } = options;
  if (!(viewerId && "indexedDB" in globalThis)) {
    throw new Error("Viewer identity storage is unavailable");
  }
  const database = await openDatabase(signal);
  try {
    await commitTransaction(
      database,
      METADATA_STORE,
      {
        key: VIEWER_ID_METADATA_KEY,
        value: viewerId,
      },
      viewerId,
      signal,
    );
  } finally {
    database.close();
  }
}

export async function readCachedViewerId(
  options: CancellationOptions = {},
): Promise<string | null> {
  const { signal } = options;
  if (!("indexedDB" in globalThis)) {
    throw new Error("Viewer identity storage is unavailable");
  }
  const database = await openDatabase(signal);
  try {
    throwIfAborted(signal);
    const record = await readMetadataRecord(database, VIEWER_ID_METADATA_KEY);
    throwIfAborted(signal);
    return record?.value || null;
  } finally {
    database.close();
  }
}

async function noteFile(
  userId: string,
  noteId: string,
  fileName: string,
  create = false,
): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle(OPFS_ROOT, {
    create,
  });
  const userDirectory = await appDirectory.getDirectoryHandle(
    encodePathPart(userId),
    { create },
  );
  const notesDirectory = await userDirectory.getDirectoryHandle("notes", {
    create,
  });
  const noteDirectory = await notesDirectory.getDirectoryHandle(
    encodePathPart(noteId),
    { create },
  );
  return noteDirectory.getFileHandle(fileName, { create });
}

async function writeMarkdown(
  userId: string,
  noteId: string,
  markdown: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileName = `${crypto.randomUUID()}.md`;
  const file = await noteFile(userId, noteId, fileName, true);
  const writable = await file.createWritable();
  let closed = false;
  const onAbort = () => {
    if (!closed) {
      void writable.abort().catch(() => {
        // Preserve the caller's cancellation outcome.
      });
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    await writable.write(markdown);
    await writable.close();
    closed = true;
  } catch (error) {
    await writable.abort().catch(() => {
      // Preserve the original write or cancellation error.
    });
    throw signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return fileName;
}

async function removeUnreferencedNoteFile(
  userId: string,
  noteId: string,
  fileName: string,
): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const appDirectory = await root.getDirectoryHandle(OPFS_ROOT);
    const userDirectory = await appDirectory.getDirectoryHandle(
      encodePathPart(userId),
    );
    const notesDirectory = await userDirectory.getDirectoryHandle("notes");
    const noteDirectory = await notesDirectory.getDirectoryHandle(
      encodePathPart(noteId),
    );
    await noteDirectory.removeEntry(fileName);
  } catch {
    // Cleanup is best effort and must not mask the original error.
  }
}

export async function openOfflineCache(
  options: OpenOfflineCacheOptions & CancellationOptions,
): Promise<OfflineCache> {
  if (!options.userId) {
    throw new Error("A user ID is required");
  }
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    throw new Error("Offline cache storage is unavailable");
  }

  const database = await openDatabase(options.signal);
  const userId = options.userId;
  let closed = false;

  return {
    beginNoteRead(id) {
      return currentNoteGeneration(userId, id);
    },
    async clearNoteDenial(id, orderingToken) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      if (suspendedUsers.has(userId)) {
        throw new Error("Offline cache is suspended");
      }
      if (
        orderingToken !== undefined &&
        orderingToken !== currentNoteGeneration(userId, id)
      ) {
        return;
      }
      await deleteMetadata(database, deniedNoteKey(userId, id), userId);
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },

    async denyNote(id) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      if (suspendedUsers.has(userId)) {
        throw new Error("Offline cache is suspended");
      }
      const key = generationKey(userId, id);
      noteGenerations.set(key, currentNoteGeneration(userId, id) + 1);
      try {
        await commitTransaction(
          database,
          METADATA_STORE,
          {
            key: deniedNoteKey(userId, id),
            value: "1",
          },
          userId,
        );
      } catch (error) {
        suspendedUsers.add(userId);
        throw error;
      }
      try {
        const fileName = await removeCachedNote(database, userId, id);
        if (fileName) {
          await removeUnreferencedNoteFile(userId, id, fileName);
        }
      } catch {
        // The durable denial remains authoritative; cleanup is retryable.
      }
    },

    async getFolder(id) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      if (isUserSuspended(userId)) {
        return null;
      }
      const record = await readFolderRecord(database, folderKey(userId, id));
      if (isUserSuspended(userId) || currentUserLifetime(userId) !== lifetime) {
        return null;
      }
      return record
        ? { cachedAt: record.cachedAt, folder: record.folder }
        : null;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: lifetime and denial guards are intentionally explicit.
    async getNote(id) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      const generation = currentNoteGeneration(userId, id);
      if (
        isUserSuspended(userId) ||
        (await readDeniedNote(database, userId, id))
      ) {
        return null;
      }
      if (
        isUserSuspended(userId) ||
        currentUserLifetime(userId) !== lifetime ||
        currentNoteGeneration(userId, id) !== generation
      ) {
        return null;
      }
      const record = await readRecord(database, noteKey(userId, id));
      if (
        !record ||
        isUserSuspended(userId) ||
        currentUserLifetime(userId) !== lifetime
      ) {
        return null;
      }

      try {
        const file = await noteFile(userId, id, record.fileName);
        const markdown = await (await file.getFile()).text();
        if (
          isUserSuspended(userId) ||
          currentUserLifetime(userId) !== lifetime ||
          currentNoteGeneration(userId, id) !== generation
        ) {
          return null;
        }
        return {
          cachedAt: record.cachedAt,
          note: { ...record.note, markdown } as Note,
        };
      } catch {
        // A missing or unreadable OPFS file is a cache miss, not a partial note.
        return null;
      }
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-item denial and terminal publication guards are intentionally explicit.
    async getNoteList() {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      if (isUserSuspended(userId)) {
        return null;
      }
      const record = await readNoteListRecord(database, noteListKey(userId));
      if (
        !record ||
        isUserSuspended(userId) ||
        currentUserLifetime(userId) !== lifetime
      ) {
        return null;
      }
      const generations = new Map(
        record.notes.map((note) => [
          note.id,
          currentNoteGeneration(userId, note.id),
        ]),
      );
      const notes: NoteSummary[] = [];
      for (const note of record.notes) {
        if (!(await readDeniedNote(database, userId, note.id))) {
          if (
            isUserSuspended(userId) ||
            currentUserLifetime(userId) !== lifetime ||
            currentNoteGeneration(userId, note.id) !== generations.get(note.id)
          ) {
            return null;
          }
          notes.push(note);
        }
      }
      if (
        isUserSuspended(userId) ||
        currentUserLifetime(userId) !== lifetime ||
        record.notes.some(
          (note) =>
            currentNoteGeneration(userId, note.id) !== generations.get(note.id),
        )
      ) {
        return null;
      }
      return { cachedAt: record.cachedAt, notes };
    },

    async putFolder(folder) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      assertUserActive(userId, lifetime);
      await commitFolderRecord(
        database,
        {
          cachedAt: Date.now(),
          folder,
          folderId: folder.id,
          key: folderKey(userId, folder.id),
          userId,
        },
        userId,
      );
    },

    async putNote(note, options = {}) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      throwIfAborted(options.signal);
      const lifetime = currentUserLifetime(userId);
      assertUserActive(userId, lifetime);
      const orderingToken = options.orderingToken;
      if (
        orderingToken !== undefined &&
        orderingToken !== currentNoteGeneration(userId, note.id)
      ) {
        return;
      }
      const fileName = await writeMarkdown(
        userId,
        note.id,
        note.markdown,
        options.signal,
      );
      const { markdown: _markdown, ...metadata } = note;
      try {
        assertUserActive(userId, lifetime);
        if (
          orderingToken !== undefined &&
          orderingToken !== currentNoteGeneration(userId, note.id)
        ) {
          await removeUnreferencedNoteFile(userId, note.id, fileName);
          return;
        }
        await commitTransaction(
          database,
          NOTE_STORE,
          {
            cachedAt: Date.now(),
            fileName,
            key: noteKey(userId, note.id),
            note: metadata,
            noteId: note.id,
            userId,
          },
          userId,
          options.signal,
        );
      } catch (error) {
        await removeUnreferencedNoteFile(userId, note.id, fileName);
        throw error;
      }
    },

    async putNoteList(notes) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      assertUserActive(userId, lifetime);
      await commitNoteListRecord(
        database,
        {
          cachedAt: Date.now(),
          key: noteListKey(userId),
          notes,
          userId,
        },
        userId,
      );
    },
  };
}
