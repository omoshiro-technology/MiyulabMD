import type {
  FolderAccess,
  Note,
  NoteSummary,
  SessionUser,
} from "@miyulabmd/shared";

import {
  beginNoteReadOrder,
  bindNoteIdentity,
  clearUserNoteReadOrder,
  currentNoteReadGeneration,
  enterNoteDenialOrder,
  isCurrentNoteReadOrder,
  noteIdentityIds,
} from "./note-access-order.ts";

// ---------------------------------------------------------------------------
// Display cache (IDB v5 + OPFS). Authority-free: data is last-write-wins, the
// only durable fences are the denial ledger and per-user purge generations.
// A v4 database is wiped wholesale on upgrade (ADR 0002) — no data migration.
// ---------------------------------------------------------------------------

const DATABASE_NAME = "miyulabmd-offline-cache";
const DATABASE_VERSION = 5;
const NOTE_STORE = "notes";
const FOLDER_STORE = "folders";
const NOTE_LIST_STORE = "note-lists";
const METADATA_STORE = "metadata";
const VIEWER_ID_METADATA_KEY = "viewer-id";
const VIEWER_PROFILE_METADATA_KEY = "viewer-profile";
const GLOBAL_LOCK_NAME = "miyulabmd-offline-cache:global";
const DRIVE_ROOT_METADATA_PREFIX = "drive-root:";
const DENIED_NOTE_PREFIX = "denied-note:";
const NOTE_ORDER_PREFIX = "note-order:";
const FOLDER_STATE_PREFIX = "folder-state:";
const IMAGE_METADATA_PREFIX = "image:";
const IMAGE_ORDER_PREFIX = "resource-order:image:";
const PURGE_GENERATION_PREFIX = "purge-generation:";
// Deliberately outside PURGE_GENERATION_PREFIX so a device purge's record
// sweep can keep it while clearing every per-user generation.
const DEVICE_PURGE_GENERATION_KEY = "device-purge-generation";
const USER_PURGE_TOMBSTONE_PREFIX = "purge-tombstone:user:";
const DEVICE_PURGE_TOMBSTONE_KEY = "purge-tombstone:device";
const OPFS_ROOT = "miyulabmd-offline-cache-v1";

type ImageRecord = {
  fileName: string;
  mime: string;
};

export function isSupportedCachedImageMime(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
}

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

type StoreRecord = {
  storeName: string;
  record: NoteRecord | FolderRecord | NoteListRecord | MetadataRecord;
};

export type OfflineCache = {
  putImage(
    noteId: string,
    imageId: string,
    bytes: Blob,
    options?: CancellationOptions & { orderingToken?: number },
  ): Promise<void>;
  getImage(noteId: string, imageId: string): Promise<Blob | null>;
  beginImageRead(noteId: string, imageId: string): Promise<number>;
  denyImage(
    noteId: string,
    imageId: string,
    orderingToken?: number,
  ): Promise<void>;
  putNote(
    note: Note,
    options?: CancellationOptions & {
      orderingToken?: number;
      /**
       * Denial-ledger watermark captured when the read started. The write is
       * skipped when a denial newer than this sequence already committed —
       * a stale 200 must not overwrite a confirmed denial.
       */
      denialSequence?: number;
    },
  ): Promise<void>;
  beginNoteRead(id: string): number;
  denyNote(id: string, orderingToken?: number): Promise<void>;
  clearNoteDenial(
    id: string,
    orderingToken: number,
    denialSequence: number,
  ): Promise<void>;
  /**
   * The durable note-denial watermark, read on this handle's connection so
   * callers that already hold a handle do not churn a second database.
   */
  captureNoteDenialSequence(): Promise<number | null>;
  /**
   * The durable purge fence captured when this handle opened — pass it to
   * `fetchNote` so shared transports split across purges without a second
   * database round-trip.
   */
  capturedPurgeFence(): { device: number; user: number } | null;
  beginFolderRead(id: string | null): Promise<number>;
  denyFolder(
    id: string | null,
    orderingToken?: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  clearFolderDenial(id: string | null, orderingToken: number): Promise<void>;
  getNote(id: string): Promise<{ note: Note; cachedAt: number } | null>;
  putNoteList(
    notes: NoteSummary[],
    options?: CancellationOptions,
  ): Promise<void>;
  getNoteList(): Promise<{ notes: NoteSummary[]; cachedAt: number } | null>;
  getNoteListState(): Promise<"available" | "denied" | "missing">;
  putFolder(
    folder: FolderAccess,
    options?: {
      asDriveRoot?: boolean;
      orderingToken?: number;
    } & CancellationOptions,
  ): Promise<void>;
  getFolder(
    id: string | null,
  ): Promise<{ folder: FolderAccess; cachedAt: number } | null>;
  getFolderState(
    id: string | null,
  ): Promise<"available" | "denied" | "missing">;
  /**
   * `true` when this handle is a stand-in for unavailable storage (for
   * example while a purge is running). Reads resolve as misses and writes
   * reject, but the display layer must keep working without the cache.
   */
  readonly degraded: boolean;
  close(): void;
};

export type OpenOfflineCacheOptions = CancellationOptions & {
  userId: string;
};

type CancellationOptions = {
  signal?: AbortSignal;
};

export type OfflineCacheDeviceClearOptions = CancellationOptions;

// In-memory realm counters: a same-tab purge bumps them so that handles and
// in-flight reads opened before the purge stop serving or writing data.
// Cross-tab ordering is carried by the durable purge generation instead.
const userRealmGenerations = new Map<string, number>();
let deviceRealmGeneration = 0;
const pendingUserWrites = new Map<string, Set<Promise<unknown>>>();
const userClearOperations = new Map<string, Promise<void>>();
let deviceClearOperation: Promise<void> | undefined;
// Set by the v5 upgrade handler; the next open wipes OPFS once so orphaned
// v4 snapshot files cannot linger beside an empty database.
let pendingUpgradeWipe = false;

type RealmToken = {
  device: number;
  user: number;
};

function captureRealmToken(userId: string): RealmToken {
  return {
    device: deviceRealmGeneration,
    user: userRealmGenerations.get(userId) ?? 0,
  };
}

function isRealmCurrent(userId: string, token: RealmToken): boolean {
  return (
    token.device === deviceRealmGeneration &&
    token.user === (userRealmGenerations.get(userId) ?? 0)
  );
}

function bumpUserRealm(userId: string): void {
  userRealmGenerations.set(userId, (userRealmGenerations.get(userId) ?? 0) + 1);
  clearUserNoteReadOrder(userId);
}

/**
 * Process-local suspension: retires every handle and in-flight operation
 * captured before this call without touching durable state. Reads degrade
 * to misses through their `isRealmCurrent` checks; write transactions abort
 * through the liveness probe in `guardPurgeGeneration`. A reload lifts the
 * suspension because nothing is persisted.
 */
export function suspendOfflineCacheUser(userId: string): void {
  bumpUserRealm(userId);
}

export type OfflineCacheLifecycleEvent = {
  type: "identity" | "invalidate" | "device-invalidate";
  userId: string;
  resource?:
    | { type: "image"; noteId: string; imageId: string }
    | NoteDenialEvent["resource"]
    | FolderDenialEvent["resource"];
};
export type NoteDenialEvent = {
  type: "invalidate";
  userId: string;
  resource: {
    type: "note";
    aliases: string[];
    generation: number | null;
  };
};
export type FolderDenialEvent = {
  type: "invalidate";
  userId: string;
  resource: {
    type: "folder";
    aliases: (string | null)[];
    generation: number | null;
  };
};
type ImageInvalidationEvent = {
  type: "invalidate";
  userId: string;
  resource: { type: "image"; noteId: string; imageId: string };
};
const lifecycleListeners = new Set<
  (event: OfflineCacheLifecycleEvent) => void
>();
function createLifecycleChannel(): BroadcastChannel | null {
  try {
    return typeof window === "undefined" ||
      typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("miyulabmd-offline-cache-lifecycle");
  } catch {
    // Messaging is an optimization. The durable ledger remains authoritative.
    return null;
  }
}

const lifecycleChannel = createLifecycleChannel();

export function subscribeOfflineCacheInvalidation(
  listener: (userId: string) => void,
): () => void {
  return subscribeOfflineCacheLifecycle((event) => {
    if (event.type === "invalidate" && !event.resource) {
      listener(event.userId);
    }
  });
}

export function subscribeOfflineCacheImageInvalidation(
  listener: (event: ImageInvalidationEvent) => void,
): () => void {
  return subscribeOfflineCacheLifecycle((event) => {
    if (event.type === "invalidate" && event.resource?.type === "image") {
      listener(event as ImageInvalidationEvent);
    }
  });
}

export function subscribeOfflineCacheNoteDenial(
  listener: (event: NoteDenialEvent) => void,
): () => void {
  return subscribeOfflineCacheLifecycle((event) => {
    if (event.type === "invalidate" && event.resource?.type === "note") {
      listener(event as NoteDenialEvent);
    }
  });
}

export function subscribeOfflineCacheFolderDenial(
  listener: (event: FolderDenialEvent) => void,
): () => void {
  return subscribeOfflineCacheLifecycle((event) => {
    if (event.type === "invalidate" && event.resource?.type === "folder") {
      listener(event as FolderDenialEvent);
    }
  });
}

function isNoteDenialEvent(value: unknown): value is NoteDenialEvent {
  const event = value as Partial<NoteDenialEvent> | null;
  const resource = event?.resource;
  return (
    event?.type === "invalidate" &&
    typeof event.userId === "string" &&
    resource?.type === "note" &&
    Array.isArray(resource.aliases) &&
    resource.aliases.length > 0 &&
    resource.aliases.every((id) => typeof id === "string" && id.length > 0) &&
    (resource.generation === null ||
      (Number.isSafeInteger(resource.generation) && resource.generation >= 0))
  );
}

function isFolderDenialEvent(value: unknown): value is FolderDenialEvent {
  const event = value as Partial<FolderDenialEvent> | null;
  const resource = event?.resource;
  return (
    event?.type === "invalidate" &&
    typeof event.userId === "string" &&
    resource?.type === "folder" &&
    Array.isArray(resource.aliases) &&
    resource.aliases.length > 0 &&
    resource.aliases.every(
      (id) => id === null || (typeof id === "string" && id.length > 0),
    ) &&
    (resource.generation === null ||
      (Number.isSafeInteger(resource.generation) && resource.generation >= 1))
  );
}

function isImageInvalidationEvent(
  value: unknown,
): value is ImageInvalidationEvent {
  const event = value as Partial<ImageInvalidationEvent> | null;
  const resource = event?.resource;
  return (
    event?.type === "invalidate" &&
    typeof event.userId === "string" &&
    resource?.type === "image" &&
    typeof resource.noteId === "string" &&
    typeof resource.imageId === "string"
  );
}

export function reportOfflineNoteDenial(
  userId: string,
  id: string,
  generation: number | null,
): void {
  const event: NoteDenialEvent = {
    resource: {
      aliases: noteIdentityIds(userId, id),
      generation,
      type: "note",
    },
    type: "invalidate",
    userId,
  };
  notifyLifecycle(event);
  try {
    lifecycleChannel?.postMessage(event);
  } catch {
    // A missing notification does not undo the durable denial marker.
  }
}

function reportOfflineFolderDenial(
  userId: string,
  id: string | null,
  generation: number | null,
  aliases: readonly (string | null)[] = [id],
): void {
  const event: FolderDenialEvent = {
    resource: {
      aliases: [...new Set(aliases)],
      generation,
      type: "folder",
    },
    type: "invalidate",
    userId,
  };
  notifyLifecycle(event);
  try {
    lifecycleChannel?.postMessage(event);
  } catch {
    // The durable marker remains authoritative when delivery is unavailable.
  }
}

function subscribeOfflineCacheLifecycle(
  listener: (event: OfflineCacheLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

function notifyLifecycle(event: OfflineCacheLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("Offline cache lifecycle listener failed", error);
    }
  }
}

function invalidateRealm(userId: string): void {
  bumpUserRealm(userId);
  notifyLifecycle({ type: "invalidate", userId });
}

function invalidateDeviceRealm(): void {
  deviceRealmGeneration += 1;
  for (const userId of userRealmGenerations.keys()) {
    bumpUserRealm(userId);
  }
  notifyLifecycle({ type: "device-invalidate", userId: "" });
}

function handleInvalidateEvent(data: object, userId: string): void {
  const event = data as Partial<OfflineCacheLifecycleEvent>;
  if (isNoteDenialEvent(data)) {
    // A peer's committed denial also fences this tab's in-flight note
    // reads: the in-memory generation must move even though the durable
    // marker was written on the other side.
    for (const alias of data.resource.aliases) {
      enterNoteDenialOrder(data.userId, alias);
    }
    notifyLifecycle(data);
  } else if (isFolderDenialEvent(data) || isImageInvalidationEvent(data)) {
    notifyLifecycle(data);
  } else if (!event.resource) {
    bumpUserRealm(userId);
    notifyLifecycle({ type: "invalidate", userId });
  }
}

// Lifecycle messages are reload hints: peers invalidate their in-memory view
// and notify observers, but the durable ledger/purge state stays the source
// of truth. A missed message never corrupts state.
function handleLifecycleMessage(data: unknown): void {
  if (!data || typeof data !== "object" || !("type" in data)) {
    return;
  }
  const event = data as Partial<OfflineCacheLifecycleEvent>;
  if (event.type === "device-invalidate") {
    deviceRealmGeneration += 1;
    notifyLifecycle({ type: "device-invalidate", userId: "" });
  } else if (event.type === "invalidate" && typeof event.userId === "string") {
    handleInvalidateEvent(data, event.userId);
  } else if (event.type === "identity" && typeof event.userId === "string") {
    notifyLifecycle({ type: "identity", userId: event.userId });
  }
}

if (lifecycleChannel) {
  lifecycleChannel.onmessage = ({ data }) => handleLifecycleMessage(data);
}

const STALE_REALM_MESSAGE = "Offline cache realm invalidated";

function invalidatedError(): DOMException {
  return new DOMException(STALE_REALM_MESSAGE, "AbortError");
}

function isInvalidatedError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError" &&
    error.message === STALE_REALM_MESSAGE
  );
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
    .replace(/[=]+$/, "");
}

function decodePathPart(value: string): string | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="),
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    return decoded && encodePathPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
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

function driveRootMetadataKey(userId: string): string {
  return `${DRIVE_ROOT_METADATA_PREFIX}${encodePathPart(userId)}`;
}

function deniedNoteKey(userId: string, noteId: string): string {
  return `${DENIED_NOTE_PREFIX}${noteKey(userId, noteId)}`;
}

function deniedFolderKey(userId: string, folderId: string | null): string {
  return `${FOLDER_STATE_PREFIX}${encodePathPart(userId)}:${encodePathPart(
    JSON.stringify(["folder", folderId]),
  )}`;
}

function folderSequenceKey(userId: string): string {
  return `folder-denial-sequence:${encodePathPart(userId)}`;
}

function imageMetadataKey(
  userId: string,
  noteId: string,
  imageId: string,
): string {
  return `${IMAGE_METADATA_PREFIX}${encodePathPart(userId)}:${encodePathPart(noteId)}:${encodePathPart(imageId)}`;
}

function imageOrderKey(
  userId: string,
  noteId: string,
  imageId: string,
): string {
  return `${IMAGE_ORDER_PREFIX}${encodePathPart(userId)}:${encodePathPart(noteId)}:${encodePathPart(imageId)}`;
}

function noteOrderKey(userId: string): string {
  return `${NOTE_ORDER_PREFIX}${encodePathPart(userId)}`;
}

function purgeGenerationKey(userId: string): string {
  return `${PURGE_GENERATION_PREFIX}${encodePathPart(userId)}`;
}

function userPurgeTombstoneKey(userId: string): string {
  return `${USER_PURGE_TOMBSTONE_PREFIX}${encodePathPart(userId)}`;
}

function userLockName(userId: string): string {
  return `miyulabmd-offline-cache:user:${encodePathPart(userId)}`;
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
    request.onupgradeneeded = (event) => {
      // v5 wipe migration (ADR 0002): the display cache is disposable, so the
      // upgrade deletes every existing store — including legacy stores under
      // any name — instead of copying data forward.
      const database = request.result;
      const oldVersion =
        typeof event === "object" && event !== null && "oldVersion" in event
          ? Number((event as { oldVersion?: number }).oldVersion)
          : 0;
      if (oldVersion > 0) {
        pendingUpgradeWipe = true;
      }
      for (const name of Array.from(database.objectStoreNames)) {
        database.deleteObjectStore(name);
      }
      database.createObjectStore(NOTE_STORE, { keyPath: "key" });
      database.createObjectStore(FOLDER_STORE, { keyPath: "key" });
      database.createObjectStore(NOTE_LIST_STORE, { keyPath: "key" });
      database.createObjectStore(METADATA_STORE, { keyPath: "key" });
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

type LockAttempt<T> = { acquired: boolean; value?: T };

async function requestLockIfAvailable<T>(
  name: string,
  mode: "exclusive" | "shared",
  operation: () => Promise<T>,
): Promise<LockAttempt<T>> {
  if (!navigator.locks) {
    // Without Web Locks there is no cross-context survivor check; run the
    // recovery best effort. Same-tab purges are still serialized by the
    // in-memory operation trackers.
    return { acquired: true, value: await operation() };
  }
  return navigator.locks.request(
    name,
    { ifAvailable: true, mode },
    async (lock): Promise<LockAttempt<T>> =>
      lock ? { acquired: true, value: await operation() } : { acquired: false },
  );
}

function userStorageLock<T>(
  userId: string,
  mode: "shared" | "exclusive",
  operation: () => Promise<T>,
): Promise<T> {
  return globalSharedStorageLock(() => {
    if (!navigator.locks) {
      return mode === "shared"
        ? operation()
        : Promise.reject(new Error("Offline cache locking is unavailable"));
    }
    return navigator.locks.request(userLockName(userId), { mode }, operation);
  });
}

function globalSharedStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    return operation();
  }
  return navigator.locks.request(
    GLOBAL_LOCK_NAME,
    { mode: "shared" },
    operation,
  );
}

function globalStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    return Promise.reject(new Error("Offline cache locking is unavailable"));
  }
  return navigator.locks.request(
    GLOBAL_LOCK_NAME,
    { mode: "exclusive" },
    operation,
  );
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

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

function readMetadataBatch(
  store: IDBObjectStore,
  keys: string[],
  complete: (records: Map<string, MetadataRecord>) => void,
  fail: (error: unknown) => void,
): void {
  const records = new Map<string, MetadataRecord>();
  let remaining = keys.length;
  if (remaining === 0) {
    complete(records);
    return;
  }
  for (const key of keys) {
    const request = store.get(key);
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      if (request.result) {
        records.set(key, request.result as MetadataRecord);
      }
      remaining -= 1;
      if (remaining === 0) {
        try {
          complete(records);
        } catch (error) {
          fail(error);
        }
      }
    };
  }
}

function readMetadataRange(
  database: IDBDatabase,
  prefix: string,
): Promise<MetadataRecord[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    const request = transaction
      .objectStore(METADATA_STORE)
      .getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
    request.onsuccess = () => resolve(request.result as MetadataRecord[]);
    request.onerror = () => reject(request.error);
  });
}

function purgeGenerationValue(record: MetadataRecord | undefined): number {
  const value = Number(record?.value ?? "0");
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Purge tombstones + self-healing (OFF-A contract, durable-marker form)
// ---------------------------------------------------------------------------
// Purge writes a `{kind, startedAt}` tombstone before deleting, then removes
// it on completion. Whoever finds a leftover tombstone tries the same
// exclusive lock the purge would hold: a granted lock proves the previous
// purge died, so the observer finishes the deletion and removes the marker.
// An unavailable lock means a live purge — callers proceed against an empty
// cache instead of blocking.

type PurgeState = {
  deviceGeneration: number;
  deviceTombstone: boolean;
  userGeneration: number;
  userTombstone: boolean;
};

function readPurgeState(
  database: IDBDatabase,
  userId: string,
): Promise<PurgeState> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readonly");
      const store = transaction.objectStore(METADATA_STORE);
      const device = store.get(DEVICE_PURGE_TOMBSTONE_KEY);
      const user = store.get(userPurgeTombstoneKey(userId));
      const generation = store.get(purgeGenerationKey(userId));
      const deviceGeneration = store.get(DEVICE_PURGE_GENERATION_KEY);
      let remaining = 4;
      const finish = () => {
        if (--remaining !== 0) {
          return;
        }
        resolve({
          deviceGeneration: purgeGenerationValue(
            deviceGeneration.result as MetadataRecord | undefined,
          ),
          deviceTombstone: device.result !== undefined,
          userGeneration: purgeGenerationValue(
            generation.result as MetadataRecord | undefined,
          ),
          userTombstone: user.result !== undefined,
        });
      };
      device.onsuccess = finish;
      user.onsuccess = finish;
      generation.onsuccess = finish;
      deviceGeneration.onsuccess = finish;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? invalidatedError());
    } catch (error) {
      reject(error);
    }
  });
}

function beginUserPurge(database: IDBDatabase, userId: string): Promise<void> {
  // Tombstone + generation bump commit together, before any deletion.
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      const metadata = transaction.objectStore(METADATA_STORE);
      const current = metadata.get(purgeGenerationKey(userId));
      current.onsuccess = () => {
        const next =
          purgeGenerationValue(current.result as MetadataRecord | undefined) +
          1;
        metadata.put({ key: purgeGenerationKey(userId), value: String(next) });
        metadata.put({
          key: userPurgeTombstoneKey(userId),
          value: JSON.stringify({ kind: "user", startedAt: Date.now() }),
        });
      };
      current.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

function endUserPurge(database: IDBDatabase, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      transaction
        .objectStore(METADATA_STORE)
        .delete(userPurgeTombstoneKey(userId));
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

function beginDevicePurge(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      const metadata = transaction.objectStore(METADATA_STORE);
      const current = metadata.get(DEVICE_PURGE_GENERATION_KEY);
      current.onsuccess = () => {
        // A monotonically increasing device generation fences handles opened
        // before this purge even after the per-user generations are wiped.
        const next =
          purgeGenerationValue(current.result as MetadataRecord | undefined) +
          1;
        metadata.put({
          key: DEVICE_PURGE_GENERATION_KEY,
          value: String(next),
        });
        metadata.put({
          key: DEVICE_PURGE_TOMBSTONE_KEY,
          value: JSON.stringify({ kind: "device", startedAt: Date.now() }),
        });
      };
      current.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

function endDevicePurge(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      transaction
        .objectStore(METADATA_STORE)
        .delete(DEVICE_PURGE_TOMBSTONE_KEY);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

function clearUserRecords(
  database: IDBDatabase,
  userId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        [NOTE_STORE, FOLDER_STORE, NOTE_LIST_STORE, METADATA_STORE],
        "readwrite",
      );
      for (const storeName of [NOTE_STORE, FOLDER_STORE, NOTE_LIST_STORE]) {
        const request = transaction.objectStore(storeName).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          if ((cursor.value as { userId?: string }).userId === userId) {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => transaction.abort();
      }
      const metadata = transaction.objectStore(METADATA_STORE);
      const request = metadata.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        const key = String(cursor.key);
        const userPrefix = `${encodePathPart(userId)}:`;
        // Purge generations and tombstones survive: the generation fences
        // writes from pre-purge handles and the tombstone is removed by the
        // purge flow itself once deletion completes.
        if (
          key === driveRootMetadataKey(userId) ||
          key === folderSequenceKey(userId) ||
          key === noteOrderKey(userId) ||
          key.startsWith(`${FOLDER_STATE_PREFIX}${userPrefix}`) ||
          key.startsWith(`${IMAGE_METADATA_PREFIX}${userPrefix}`) ||
          key.startsWith(`${IMAGE_ORDER_PREFIX}${userPrefix}`) ||
          key.startsWith(`${DENIED_NOTE_PREFIX}${noteListKey(userId)}:`)
        ) {
          cursor.delete();
        }
        cursor.continue();
      };
      const viewer = metadata.get(VIEWER_ID_METADATA_KEY);
      viewer.onsuccess = () => {
        if ((viewer.result as MetadataRecord | undefined)?.value === userId) {
          metadata.delete(VIEWER_ID_METADATA_KEY);
        }
      };
      const profile = metadata.get(VIEWER_PROFILE_METADATA_KEY);
      profile.onsuccess = () => {
        if (
          parseCachedViewerProfile(
            (profile.result as MetadataRecord | undefined)?.value,
          )?.id === userId
        ) {
          metadata.delete(VIEWER_PROFILE_METADATA_KEY);
        }
      };
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => undefined;
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted"));
  });
}

async function clearUserFiles(userId: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    const app = await root.getDirectoryHandle(OPFS_ROOT);
    await app.removeEntry(encodePathPart(userId), { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }
}

function clearDeviceRecords(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        [NOTE_STORE, FOLDER_STORE, NOTE_LIST_STORE, METADATA_STORE],
        "readwrite",
      );
      for (const storeName of [NOTE_STORE, FOLDER_STORE, NOTE_LIST_STORE]) {
        transaction.objectStore(storeName).clear();
      }
      const metadata = transaction.objectStore(METADATA_STORE);
      const request = metadata.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        const key = String(cursor.key);
        // Only the remembered viewer identity, the device purge generation,
        // and the purge markers driving this very operation survive a
        // device-wide clear.
        if (
          key !== VIEWER_ID_METADATA_KEY &&
          key !== VIEWER_PROFILE_METADATA_KEY &&
          key !== DEVICE_PURGE_GENERATION_KEY &&
          key !== DEVICE_PURGE_TOMBSTONE_KEY &&
          !key.startsWith(USER_PURGE_TOMBSTONE_PREFIX)
        ) {
          cursor.delete();
        }
        cursor.continue();
      };
      request.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

async function removeDeviceFiles(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(OPFS_ROOT, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }
  await root.getDirectoryHandle(OPFS_ROOT, { create: true });
}

async function drainPendingUserWrites(userId: string): Promise<void> {
  const writes = pendingUserWrites.get(userId);
  if (writes) {
    await Promise.all([...writes]);
  }
}

async function finishInterruptedUserPurge(
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  const database = await openDatabase(signal);
  try {
    // Re-run the purge's own steps: delete scoped data, then remove the
    // tombstone. A crash here simply leaves another tombstone for the next
    // observer.
    await clearUserRecords(database, userId);
    await clearUserFiles(userId);
    await endUserPurge(database, userId);
  } finally {
    database.close();
  }
}

async function finishInterruptedDevicePurge(): Promise<void> {
  const database = await openDatabase();
  try {
    await clearDeviceRecords(database);
    await removeDeviceFiles();
    await endDevicePurge(database);
  } finally {
    database.close();
  }
}

/** device 墓標が残っていたら中断済みデバイス purge をロック下で完了させる。 */
async function healDeviceTombstone(
  database: IDBDatabase,
  userId: string,
): Promise<"clean" | "purging"> {
  try {
    const healed = await requestLockIfAvailable(
      GLOBAL_LOCK_NAME,
      "exclusive",
      async () => {
        const again = await readPurgeState(database, userId);
        if (again.deviceTombstone) {
          await finishInterruptedDevicePurge();
        }
      },
    );
    if (!healed.acquired) {
      return "purging";
    }
  } catch {
    return "purging";
  }
  const scan = await readPurgeState(database, userId);
  return scan.deviceTombstone ? "purging" : "clean";
}

/** user 墓標が残っていたら中断済みユーザー purge をロック下で完了させる。 */
async function healUserTombstone(
  database: IDBDatabase,
  userId: string,
  signal?: AbortSignal,
): Promise<"clean" | "purging"> {
  try {
    const healed = await requestLockIfAvailable(
      GLOBAL_LOCK_NAME,
      "shared",
      () =>
        requestLockIfAvailable(userLockName(userId), "exclusive", async () => {
          const again = await readPurgeState(database, userId);
          if (again.userTombstone) {
            await finishInterruptedUserPurge(userId, signal);
          }
        }),
    );
    if (!healed.acquired || healed.value?.acquired !== true) {
      return "purging";
    }
  } catch {
    return "purging";
  }
  const after = await readPurgeState(database, userId);
  return after.userTombstone ? "purging" : "clean";
}

async function healInterruptedPurgeMarkers(
  database: IDBDatabase,
  userId: string,
  signal?: AbortSignal,
): Promise<"clean" | "purging"> {
  // Runs on the caller's already-open connection: opening and closing a
  // second database here would show up as extra connection churn in
  // instrumented environments (and is pure overhead either way).
  let scan: PurgeState;
  try {
    scan = await readPurgeState(database, userId);
  } catch {
    // A transient scan failure must not degrade the whole open: the
    // caller's own purge-state read decides, and a leftover tombstone is
    // retried by the next observer.
    return "clean";
  }
  if (
    scan.deviceTombstone &&
    (await healDeviceTombstone(database, userId)) === "purging"
  ) {
    return "purging";
  }
  if (scan.userTombstone) {
    return healUserTombstone(database, userId, signal);
  }
  return "clean";
}

async function purgeOfflineCacheUser(userId: string): Promise<void> {
  if (!userId) {
    throw new Error("A user ID is required");
  }
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    throw new Error("Offline cache storage is unavailable");
  }
  invalidateRealm(userId);
  try {
    lifecycleChannel?.postMessage({ type: "invalidate", userId });
  } catch {
    // The durable purge state remains authoritative.
  }
  await userStorageLock(userId, "exclusive", async () => {
    const database = await openDatabase();
    try {
      await beginUserPurge(database, userId);
      await drainPendingUserWrites(userId);
      await clearUserRecords(database, userId);
      await clearUserFiles(userId);
      await endUserPurge(database, userId);
    } finally {
      database.close();
    }
  });
}

export function clearOfflineCacheUser(userId: string): Promise<void> {
  const existing = userClearOperations.get(userId);
  if (existing) {
    return existing;
  }
  const operation = purgeOfflineCacheUser(userId).finally(() => {
    userClearOperations.delete(userId);
  });
  userClearOperations.set(userId, operation);
  return operation;
}

async function purgeOfflineCacheDevice(
  options: OfflineCacheDeviceClearOptions = {},
): Promise<void> {
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    throw new Error("Offline cache storage is unavailable");
  }
  throwIfAborted(options.signal);
  invalidateDeviceRealm();
  try {
    lifecycleChannel?.postMessage({ type: "device-invalidate", userId: "" });
  } catch {
    // The durable tombstone remains authoritative.
  }
  await globalStorageLock(async () => {
    const database = await openDatabase(options.signal);
    try {
      throwIfAborted(options.signal);
      // This marker is durable before either destructive operation.
      await beginDevicePurge(database);
      for (const writes of pendingUserWrites.values()) {
        await Promise.all([...writes]);
      }
      await clearDeviceRecords(database);
      await removeDeviceFiles();
      await endDevicePurge(database);
    } finally {
      database.close();
    }
  });
}

export function clearOfflineCacheDevice(
  options: OfflineCacheDeviceClearOptions = {},
): Promise<void> {
  if (!deviceClearOperation) {
    deviceClearOperation = purgeOfflineCacheDevice(options).finally(() => {
      deviceClearOperation = undefined;
    });
  }
  return deviceClearOperation;
}

// ---------------------------------------------------------------------------
// Orphan collection (OPFS files whose IDB reference is gone)
// ---------------------------------------------------------------------------

export type OfflineCacheOrphanCollection = {
  removedFiles: number;
};

type OfflineCacheFileSnapshot = {
  files: Set<string>;
};

function isFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function readUserFileSnapshot(
  database: IDBDatabase,
  userId: string,
): Promise<OfflineCacheFileSnapshot> {
  return new Promise((resolve, reject) => {
    const files = new Set<string>();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        [NOTE_STORE, METADATA_STORE],
        "readonly",
      );
      const notePrefix = `${noteListKey(userId)}:`;
      const notes = transaction
        .objectStore(NOTE_STORE)
        .openCursor(IDBKeyRange.bound(notePrefix, `${notePrefix}￿`));
      notes.onsuccess = () => {
        const cursor = notes.result;
        if (!cursor) {
          return;
        }
        const record = cursor.value as Partial<NoteRecord>;
        // A record inside this user's key range owned by someone else means
        // the reference map is corrupt; deleting files on that basis could
        // destroy live data, so abort the whole sweep.
        if (record.userId !== undefined && record.userId !== userId) {
          transaction.abort();
          return;
        }
        // Corrupt rows skip instead of aborting the whole sweep (spec §4.5).
        if (
          record.userId === userId &&
          isFileName(record.fileName) &&
          typeof record.noteId === "string" &&
          record.key === cursor.key &&
          record.key === noteKey(userId, record.noteId)
        ) {
          files.add(`${encodePathPart(record.noteId)}/${record.fileName}`);
        }
        cursor.continue();
      };
      notes.onerror = () => transaction.abort();

      const prefix = `${IMAGE_METADATA_PREFIX}${encodePathPart(userId)}:`;
      const metadata = transaction
        .objectStore(METADATA_STORE)
        .openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
      metadata.onsuccess = () => {
        const cursor = metadata.result;
        if (!cursor) {
          return;
        }
        const key = String(cursor.key);
        const reference = imageFileReference(
          key.slice(prefix.length),
          cursor.value,
        );
        if (reference) {
          files.add(reference);
        }
        cursor.continue();
      };
      metadata.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve({ files });
    transaction.onerror = () => undefined;
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Offline cache reference snapshot failed"),
      );
  });
}

function imageFileReference(suffix: string, value: unknown): string | null {
  const record = value as Partial<MetadataRecord> | null;
  if (typeof record?.value !== "string") {
    return null;
  }
  if (record.value === "denied") {
    return null;
  }
  let image: Partial<ImageRecord> | null;
  try {
    image = JSON.parse(record.value) as Partial<ImageRecord> | null;
  } catch {
    return null;
  }
  const parts = suffix.split(":");
  if (
    !isFileName(image?.fileName) ||
    typeof image?.mime !== "string" ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    decodePathPart(parts[0]) === null ||
    decodePathPart(parts[1]) === null
  ) {
    return null;
  }
  return `${parts[0]}/${image.fileName}`;
}

async function optionalDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

async function userNotesDirectory(
  userId: string,
): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  const app = await optionalDirectory(root, OPFS_ROOT);
  if (!app) {
    return null;
  }
  const user = await optionalDirectory(app, encodePathPart(userId));
  return user ? optionalDirectory(user, "notes") : null;
}

type CacheFileCandidate = {
  directory: FileSystemDirectoryHandle;
  name: string;
};

function isManagedSnapshotFile(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(md|image)$/.test(
    name,
  );
}

async function findCacheOrphans(
  notes: FileSystemDirectoryHandle,
  references: OfflineCacheFileSnapshot,
): Promise<CacheFileCandidate[]> {
  const candidates: CacheFileCandidate[] = [];
  for await (const [noteName, entry] of notes.entries()) {
    if (entry.kind !== "directory" || decodePathPart(noteName) === null) {
      continue;
    }
    for await (const [name, file] of entry.entries()) {
      if (
        file.kind === "file" &&
        isManagedSnapshotFile(name) &&
        !references.files.has(`${noteName}/${name}`)
      ) {
        candidates.push({ directory: entry, name });
      }
    }
  }
  return candidates;
}

export function collectOfflineCacheOrphans(
  userId: string,
): Promise<OfflineCacheOrphanCollection> {
  if (!userId) {
    throw new Error("A user ID is required");
  }
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    throw new Error("Offline cache storage is unavailable");
  }
  return userStorageLock(userId, "exclusive", async () => {
    const database = await openDatabase();
    try {
      const references = await readUserFileSnapshot(database, userId);
      const notes = await userNotesDirectory(userId);
      if (!notes) {
        return { removedFiles: 0 };
      }
      const candidates = await findCacheOrphans(notes, references);
      let removedFiles = 0;
      for (const candidate of candidates) {
        await candidate.directory.removeEntry(candidate.name);
        removedFiles += 1;
      }
      return { removedFiles };
    } finally {
      database.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Denial ledger reads (durable, best-effort — never on the display path)
// ---------------------------------------------------------------------------

type NoteAuthorityMarker = {
  denied: boolean;
  generation: number;
};

function parseNoteAuthority(
  record: MetadataRecord | undefined,
): NoteAuthorityMarker | null {
  if (!record) {
    return null;
  }
  try {
    const parsed = JSON.parse(record.value) as NoteAuthorityMarker;
    return parsed !== null &&
      Number.isSafeInteger(parsed.generation) &&
      parsed.generation >= 0 &&
      typeof parsed.denied === "boolean"
      ? parsed
      : { denied: true, generation: 0 };
  } catch {
    return { denied: true, generation: 0 };
  }
}

function noteSequence(record: MetadataRecord | undefined): number {
  const generation = Number(record?.value ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid note denial sequence");
  }
  return generation;
}

/** The durable per-user note denial sequence — the CAS watermark for puts. */
export async function captureOfflineNoteDenialSequence(
  userId: string,
): Promise<number | null> {
  try {
    const database = await openDatabase();
    try {
      return noteSequence(
        await readMetadataRecord(database, noteOrderKey(userId)),
      );
    } finally {
      database.close();
    }
  } catch {
    // The ledger is best-effort; an unreadable sequence is no authority.
    return null;
  }
}

/**
 * Durable purge fence captured when a read starts. `null` means the ledger
 * is unavailable — reads degrade to unfenced rather than failing.
 */
export async function captureOfflinePurgeFence(
  userId: string,
): Promise<{ device: number; user: number } | null> {
  try {
    const database = await openDatabase();
    try {
      const state = await readPurgeState(database, userId);
      return {
        device: state.deviceGeneration,
        user: state.userGeneration,
      };
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/**
 * Re-reads the durable purge state; `false` when a user or device purge
 * committed (or is still committing) after `fence` was captured. This is
 * the cross-tab backstop for reads that missed the BroadcastChannel
 * invalidation.
 */
export async function isOfflinePurgeFenceCurrent(
  userId: string,
  fence: { device: number; user: number },
): Promise<boolean> {
  try {
    const database = await openDatabase();
    try {
      const state = await readPurgeState(database, userId);
      return (
        state.deviceGeneration === fence.device &&
        state.userGeneration === fence.user &&
        !state.deviceTombstone &&
        !state.userTombstone
      );
    } finally {
      database.close();
    }
  } catch {
    // An unreadable ledger cannot prove staleness; degrade to publishable.
    return true;
  }
}

export type OfflineDenialSnapshot = {
  deniedNoteIds: Set<string>;
  deniedFolderIds: Set<string | null>;
  /** Folder ledger watermark at snapshot time — the ordering token that
   * authorizes this read's writes to lift earlier denials. */
  folderSequence: number;
};

/**
 * One-shot ledger read for projecting denials over freshly fetched data.
 * Runs in parallel with network reads; `null` means "not available" and
 * callers must proceed without projecting.
 */
export async function readOfflineDenialSnapshot(
  userId: string,
): Promise<OfflineDenialSnapshot | null> {
  try {
    const database = await openDatabase();
    try {
      const notePrefix = `${DENIED_NOTE_PREFIX}${encodePathPart(userId)}:`;
      const folderPrefix = `${FOLDER_STATE_PREFIX}${encodePathPart(userId)}:`;
      const [noteRecords, folderRecords, sequence] = await Promise.all([
        readMetadataRange(database, notePrefix),
        readMetadataRange(database, folderPrefix),
        readMetadataRecord(database, folderSequenceKey(userId)),
      ]);
      const deniedNoteIds = new Set<string>();
      for (const record of noteRecords) {
        if (parseNoteAuthority(record)?.denied !== true) {
          continue;
        }
        const noteId = decodePathPart(record.key.slice(notePrefix.length));
        if (noteId !== null) {
          deniedNoteIds.add(noteId);
        }
      }
      const deniedFolderIds = new Set<string | null>();
      for (const record of folderRecords) {
        let marker: Partial<FolderDenialMarker>;
        try {
          marker = JSON.parse(record.value) as Partial<FolderDenialMarker>;
        } catch {
          continue;
        }
        if (marker.denied !== false) {
          deniedFolderIds.add(marker.folderId ?? null);
        }
      }
      return {
        deniedFolderIds,
        deniedNoteIds,
        folderSequence: folderSequence(sequence),
      };
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/** Null means the durable note denial could not be inspected. */
export async function readOfflineNoteDenial(
  event: NoteDenialEvent,
  identities: readonly string[],
): Promise<boolean | null> {
  try {
    const database = await openDatabase();
    try {
      return await new Promise<boolean | null>((resolve, reject) => {
        const transaction = database.transaction(METADATA_STORE, "readonly");
        let denied: boolean | null = null;
        readMetadataBatch(
          transaction.objectStore(METADATA_STORE),
          identities.map((id) => deniedNoteKey(event.userId, id)),
          (records) => {
            if (event.resource.generation === null) {
              denied = null;
              return;
            }
            const generation = event.resource.generation;
            const authorities = identities
              .map((id) =>
                parseNoteAuthority(
                  records.get(deniedNoteKey(event.userId, id)),
                ),
              )
              .filter(
                (authority): authority is NoteAuthorityMarker =>
                  authority !== null && authority.generation >= generation,
              );
            denied =
              authorities.length > 0 &&
              authorities.some((authority) => authority.denied);
          },
          () => transaction.abort(),
        );
        transaction.oncomplete = () => resolve(denied);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

type FolderDenialMarker = {
  denied: boolean;
  folderId: string | null;
  generation: number;
};

type FolderDenialReceipt = {
  aliases: (string | null)[];
  generation: number | null;
  committed: boolean;
  /** True when a clear/putFolder replaced a marker that was still denied. */
  liftedDenial?: boolean;
  /** True when the operation flipped a marker's denied state. Events are
   * only broadcast when this is set so idempotent repeats do not trigger
   * reload loops in subscribers. */
  changed?: boolean;
};

function parseFolderDenialMarker(
  record: MetadataRecord | undefined,
  fallbackId: string | null,
): FolderDenialMarker | null {
  if (!record) {
    return null;
  }
  try {
    const marker = JSON.parse(record.value) as Partial<FolderDenialMarker>;
    if (
      marker.folderId === fallbackId &&
      Number.isSafeInteger(marker.generation) &&
      (marker.generation ?? 0) >= 1
    ) {
      return {
        denied: marker.denied !== false,
        folderId: fallbackId,
        generation: marker.generation as number,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Null means the durable folder denial could not be inspected. */
export async function readOfflineFolderDenial(
  event: FolderDenialEvent,
): Promise<boolean | null> {
  try {
    const database = await openDatabase();
    try {
      return await new Promise<boolean | null>((resolve, reject) => {
        const transaction = database.transaction(METADATA_STORE, "readonly");
        const store = transaction.objectStore(METADATA_STORE);
        const aliases = [...new Set(event.resource.aliases)];
        const requests = aliases.map((alias) => ({
          alias,
          request: store.get(deniedFolderKey(event.userId, alias)),
        }));
        transaction.oncomplete = () => {
          const parsed = requests.map(({ alias, request }) => ({
            marker: parseFolderDenialMarker(
              request.result as MetadataRecord | undefined,
              alias,
            ),
            present: request.result !== undefined,
          }));
          if (
            parsed.some(({ marker, present }) => present && marker === null)
          ) {
            resolve(null);
            return;
          }
          const generation = event.resource.generation;
          resolve(
            parsed.some(
              ({ marker }) =>
                marker?.denied === true &&
                (generation === null || marker.generation >= generation),
            ),
          );
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function beginOfflineNoteRead(userId: string, noteId: string): number {
  return beginNoteReadOrder(userId, noteId);
}

export function enterOfflineNoteDenial(userId: string, noteId: string): number {
  return enterNoteDenialOrder(userId, noteId);
}

export function isOfflineNoteReadCurrent(
  userId: string,
  noteId: string,
  token: number,
): boolean {
  return isCurrentNoteReadOrder(userId, noteId, token);
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

async function readNoteForRoute(
  database: IDBDatabase,
  userId: string,
  id: string,
): Promise<NoteRecord | undefined> {
  const canonical = await readRecord(database, noteKey(userId, id));
  if (canonical) {
    return canonical.userId === userId ? canonical : undefined;
  }
  // Scan only this user's canonical rows; the current snapshot owns its short ID.
  const prefix = `${noteListKey(userId)}:`;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(NOTE_STORE, "readonly");
    const request = transaction
      .objectStore(NOTE_STORE)
      .openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(undefined);
        return;
      }
      const record = cursor.value as NoteRecord;
      if (record.userId === userId && record.note.shortId === id) {
        resolve(record);
        return;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
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

function rootReferenceId(record: MetadataRecord | undefined): string | null {
  try {
    const id: unknown = record ? JSON.parse(record.value) : null;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

async function readFolderForRoute(
  database: IDBDatabase,
  userId: string,
  id: string | null,
): Promise<FolderRecord | undefined> {
  if (id !== null) {
    return readFolderRecord(database, folderKey(userId, id));
  }
  const rootReference = await readMetadataRecord(
    database,
    driveRootMetadataKey(userId),
  );
  if (!rootReference) {
    return readFolderRecord(database, folderKey(userId, null));
  }
  try {
    const rootId = JSON.parse(rootReference.value) as string | null;
    return readFolderRecord(database, folderKey(userId, rootId));
  } catch {
    return undefined;
  }
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

async function readDeniedNote(
  database: IDBDatabase,
  userId: string,
  noteId: string,
): Promise<boolean> {
  return (
    parseNoteAuthority(
      await readMetadataRecord(database, deniedNoteKey(userId, noteId)),
    )?.denied ?? false
  );
}

/** Denial-ledger check across every identity a note route may resolve. */
async function isNoteRecordDenied(
  database: IDBDatabase,
  userId: string,
  record: NoteRecord,
): Promise<boolean> {
  const identities = [
    ...new Set([
      record.noteId,
      record.note.shortId,
      ...noteIdentityIds(userId, record.noteId),
    ]),
  ];
  for (const identity of identities) {
    if (await readDeniedNote(database, userId, identity)) {
      return true;
    }
  }
  return false;
}

async function readDeniedNoteIds(
  database: IDBDatabase,
  userId: string,
): Promise<Set<string>> {
  const prefix = `${DENIED_NOTE_PREFIX}${encodePathPart(userId)}:`;
  const records = await readMetadataRange(database, prefix);
  const denied = new Set<string>();
  for (const record of records) {
    if (parseNoteAuthority(record)?.denied !== true) {
      continue;
    }
    const noteId = decodePathPart(record.key.slice(prefix.length));
    if (noteId !== null) {
      denied.add(noteId);
    }
  }
  return denied;
}

type FolderDenialSnapshot = {
  deniedFolderIds: Set<string | null>;
  sequence: number;
};

function readFolderDenialSnapshot(
  database: IDBDatabase,
  userId: string,
): Promise<FolderDenialSnapshot> {
  const prefix = `${FOLDER_STATE_PREFIX}${encodePathPart(userId)}:`;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    const store = transaction.objectStore(METADATA_STORE);
    const markerRequest = store.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
    const sequenceRequest = store.get(folderSequenceKey(userId));
    transaction.oncomplete = () => {
      try {
        resolve(
          parseFolderDenialSnapshot(
            markerRequest.result as MetadataRecord[],
            sequenceRequest.result as MetadataRecord | undefined,
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

function parseFolderDenialSnapshot(
  records: MetadataRecord[],
  sequenceRecord: MetadataRecord | undefined,
): FolderDenialSnapshot {
  const deniedFolderIds = new Set<string | null>();
  for (const record of records) {
    let marker: Partial<FolderDenialMarker>;
    try {
      marker = JSON.parse(record.value) as Partial<FolderDenialMarker>;
    } catch {
      throw new Error("Invalid folder denial metadata");
    }
    if (
      (marker.folderId !== null && typeof marker.folderId !== "string") ||
      !Number.isSafeInteger(marker.generation) ||
      (marker.generation ?? 0) < 1 ||
      typeof marker.denied !== "boolean"
    ) {
      throw new Error("Invalid folder denial metadata");
    }
    if (marker.denied !== false) {
      deniedFolderIds.add(marker.folderId ?? null);
    }
  }
  return {
    deniedFolderIds,
    sequence: requiredFolderSequence(sequenceRecord),
  };
}

function folderSequence(record: MetadataRecord | undefined): number {
  const value = Number(record?.value);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function requiredFolderSequence(record: MetadataRecord | undefined): number {
  if (!record) {
    return 1;
  }
  const value = Number(record.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid folder denial sequence");
  }
  return value;
}

export function projectDeniedFolder(
  folder: FolderAccess,
  deniedFolderIds: Set<string | null>,
): FolderAccess | null {
  // The root folder itself is denied through the null alias (or its concrete
  // drive-root id); descendant denials are projected below.
  if (deniedFolderIds.has(folder.id)) {
    return null;
  }
  const deniedCrumbIndex = folder.crumbs.reduce(
    (lastIndex, crumb, index) =>
      deniedFolderIds.has(crumb.id) ? index : lastIndex,
    -1,
  );
  const children = folder.children.filter(
    (child) => !deniedFolderIds.has(child.id),
  );
  if (deniedCrumbIndex < 0) {
    return { ...folder, children };
  }
  const crumbs = folder.crumbs.slice(deniedCrumbIndex + 1);
  return {
    ...folder,
    children: children.map(({ folder: _folder, ...child }) => child),
    crumbs,
    folder: undefined,
    parentId: crumbs.length >= 2 ? (crumbs.at(-2)?.id ?? null) : null,
    sourceFolder: null,
  };
}

async function readVisibleNoteList(
  database: IDBDatabase,
  userId: string,
  realm: RealmToken,
  record: NoteListRecord,
): Promise<{ notes: NoteSummary[]; cachedAt: number } | null> {
  const generations = new Map(
    record.notes.map((note) => [
      note.id,
      currentNoteReadGeneration(userId, note.id),
    ]),
  );
  const [{ deniedFolderIds }, deniedNoteIds] = await Promise.all([
    readFolderDenialSnapshot(database, userId),
    readDeniedNoteIds(database, userId),
  ]);
  if (!isRealmCurrent(userId, realm)) {
    return null;
  }
  const notes: NoteSummary[] = [];
  for (const note of record.notes) {
    const denied =
      (deniedFolderIds.has(note.folderId) && note.access?.inherit !== false) ||
      deniedNoteIds.has(note.id) ||
      deniedNoteIds.has(note.shortId);
    if (denied) {
      continue;
    }
    if (
      currentNoteReadGeneration(userId, note.id) !== generations.get(note.id)
    ) {
      // A denial began while this read was in flight; exclude the note
      // rather than republishing data the denial just superseded.
      continue;
    }
    notes.push(note);
  }
  return { cachedAt: record.cachedAt, notes };
}

// ---------------------------------------------------------------------------
// OPFS file helpers (immutable snapshot files + atomic IDB reference swap)
// ---------------------------------------------------------------------------

async function noteFile(
  userId: string,
  noteId: string,
  fileName: string,
  create = false,
  assertCurrent: () => void = () => undefined,
): Promise<FileSystemFileHandle> {
  assertCurrent();
  const root = await navigator.storage.getDirectory();
  assertCurrent();
  const appDirectory = await root.getDirectoryHandle(OPFS_ROOT, {
    create,
  });
  assertCurrent();
  const userDirectory = await appDirectory.getDirectoryHandle(
    encodePathPart(userId),
    { create },
  );
  assertCurrent();
  const notesDirectory = await userDirectory.getDirectoryHandle("notes", {
    create,
  });
  assertCurrent();
  const noteDirectory = await notesDirectory.getDirectoryHandle(
    encodePathPart(noteId),
    { create },
  );
  assertCurrent();
  const file = await noteDirectory.getFileHandle(fileName, { create });
  assertCurrent();
  return file;
}

async function writeNoteFileContents(
  userId: string,
  noteId: string,
  contents: string | Blob,
  signal?: AbortSignal,
  assertCurrent: () => void = () => throwIfAborted(signal),
): Promise<string> {
  const fileName = `${crypto.randomUUID()}.${typeof contents === "string" ? "md" : "image"}`;
  let writable: FileSystemWritableFileStream | undefined;
  let closed = false;
  const onAbort = () => {
    if (writable && !closed) {
      void writable.abort().catch(() => {
        // Preserve the caller's cancellation outcome.
      });
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const file = await noteFile(userId, noteId, fileName, true, assertCurrent);
    writable = await file.createWritable();
    assertCurrent();
    await writable.write(contents);
    assertCurrent();
    await writable.close();
    closed = true;
    assertCurrent();
  } catch (error) {
    await writable?.abort().catch(() => {
      // Preserve the original write or cancellation error.
    });
    await removeUnreferencedNoteFile(userId, noteId, fileName);
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

// ---------------------------------------------------------------------------
// Write transactions with the reduced CAS
// ---------------------------------------------------------------------------
// Every handle-pinned write transaction reads the durable purge generation of
// its user and aborts when it moved — a purge that landed after the handle
// opened turns in-flight writes into skips instead of resurrecting deleted
// data. Note puts additionally check each identity's denial marker against
// the caller's captured denial sequence, so a stale 200 cannot overwrite a
// confirmed denial.

type StaleFlag = { value: boolean };

/**
 * Cheap pre-check before writing OPFS files: the transaction-level guard is
 * authoritative, but reading the generation first keeps a fenced write from
 * littering orphan directories it would only have to clean up.
 */
/**
 * The durable purge generations a handle captured when it opened. Both are
 * compared before every write: the user generation fences user purges, and
 * the device generation fences device purges — including after the per-user
 * generation keys themselves were wiped.
 */
type PurgeGenerations = {
  device: number;
  user: number;
};

async function assertPurgeGenerationCurrent(
  database: IDBDatabase,
  userId: string,
  expected: PurgeGenerations | undefined,
): Promise<void> {
  if (expected === undefined) {
    return;
  }
  const [user, device] = await Promise.all([
    readMetadataRecord(database, purgeGenerationKey(userId)),
    readMetadataRecord(database, DEVICE_PURGE_GENERATION_KEY),
  ]);
  if (
    purgeGenerationValue(user) !== expected.user ||
    purgeGenerationValue(device) !== expected.device
  ) {
    throw invalidatedError();
  }
}

function guardPurgeGeneration(
  transaction: IDBTransaction,
  userId: string,
  expected: PurgeGenerations | undefined,
  stale: StaleFlag,
): void {
  const store = transaction.objectStore(METADATA_STORE);
  // Realm liveness probe: a same-tab purge or suspension bumps the in-memory
  // realm without touching durable records, so the durable CAS alone cannot
  // see it. This request always completes before the commit — when the realm
  // moved on, aborting here keeps the stale write from landing.
  const realm = captureRealmToken(userId);
  const liveness = store.get(DEVICE_PURGE_GENERATION_KEY);
  liveness.onsuccess = () => {
    if (!isRealmCurrent(userId, realm)) {
      stale.value = true;
      try {
        transaction.abort();
      } catch {
        // Completion may already be in progress; the terminal event wins.
      }
    }
  };
  if (expected === undefined) {
    return;
  }
  const check = (key: string, generation: number) => {
    const request = store.get(key);
    request.onsuccess = () => {
      if (
        purgeGenerationValue(request.result as MetadataRecord | undefined) !==
        generation
      ) {
        stale.value = true;
        try {
          transaction.abort();
        } catch {
          // Completion may already be in progress; the terminal event wins.
        }
      }
    };
  };
  check(purgeGenerationKey(userId), expected.user);
  check(DEVICE_PURGE_GENERATION_KEY, expected.device);
}

function commitTransaction(
  database: IDBDatabase,
  storeName: string,
  record: NoteRecord | MetadataRecord,
  userId: string,
  purgeFence: PurgeGenerations | undefined,
  signal?: AbortSignal,
  denialSequence?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    const stale: StaleFlag = { value: false };
    try {
      throwIfAborted(signal);
      transaction = database.transaction(
        [...new Set([storeName, METADATA_STORE])],
        "readwrite",
      );
      guardPurgeGeneration(transaction, userId, purgeFence, stale);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let requestError: DOMException | null = null;
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
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
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfAborted(signal);
      if (denialSequence !== undefined && "noteId" in record) {
        for (const id of noteIdentityIds(userId, record.noteId)) {
          const request = transaction
            .objectStore(METADATA_STORE)
            .get(deniedNoteKey(userId, id));
          request.onsuccess = () => {
            if (
              (parseNoteAuthority(request.result)?.generation ?? 0) >
              denialSequence
            ) {
              stale.value = true;
              requestError = invalidatedError();
              transaction.abort();
            }
          };
        }
      }
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

function commitStoreRecords(
  database: IDBDatabase,
  records: StoreRecord[],
  userId: string,
  purgeFence: PurgeGenerations | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    const stale: StaleFlag = { value: false };
    try {
      throwIfAborted(signal);
      transaction = database.transaction(
        [
          ...new Set([
            METADATA_STORE,
            ...records.map(({ storeName }) => storeName),
          ]),
        ],
        "readwrite",
      );
      guardPurgeGeneration(transaction, userId, purgeFence, stale);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let putError: unknown;
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // The terminal event has already won.
      }
    };
    const onAbort = () => abort();
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback();
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transaction.oncomplete = () => finish(resolve);
    transaction.onerror = () => {
      // The abort event is the single terminal rejection boundary.
    };
    transaction.onabort = () =>
      finish(() =>
        reject(
          signal?.aborted
            ? signal.reason
            : (putError ??
                transaction.error ??
                new DOMException("Transaction aborted")),
        ),
      );
    try {
      throwIfAborted(signal);
      for (const { storeName, record } of records) {
        transaction.objectStore(storeName).put(record);
      }
    } catch (error) {
      putError = error;
      abort();
    }
  });
}

function commitNoteListRecord(
  database: IDBDatabase,
  record: NoteListRecord,
  userId: string,
  purgeFence: PurgeGenerations | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return commitStoreRecords(
    database,
    [{ record, storeName: NOTE_LIST_STORE }],
    userId,
    purgeFence,
    signal,
  );
}

function changeImageOrder(
  database: IDBDatabase,
  userId: string,
  noteId: string,
  imageId: string,
  orderingToken: number | undefined,
  deny: boolean,
  purgeFence?: PurgeGenerations,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let result: number | null = null;
    const stale: StaleFlag = { value: false };
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      guardPurgeGeneration(transaction, userId, purgeFence, stale);
      const metadata = transaction.objectStore(METADATA_STORE);
      const orderRequest = metadata.get(imageOrderKey(userId, noteId, imageId));
      orderRequest.onsuccess = () => {
        const current = Number(orderRequest.result?.value ?? 0);
        if (deny && orderingToken !== undefined && current !== orderingToken) {
          return;
        }
        // Reads capture a denial generation; they do not make another
        // still-pending request's later denial obsolete.
        result = deny ? current + 1 : current;
        if (!deny) {
          return;
        }
        metadata.put({
          key: imageOrderKey(userId, noteId, imageId),
          value: String(result),
        });
        metadata.put({
          key: imageMetadataKey(userId, noteId, imageId),
          value: "denied",
        });
      };
      orderRequest.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => undefined;
    transaction.onabort = () =>
      reject(
        stale.value
          ? invalidatedError()
          : (transaction.error ?? new DOMException("Transaction aborted")),
      );
  });
}

function commitImageMetadata(
  database: IDBDatabase,
  userId: string,
  noteId: string,
  imageId: string,
  orderingToken: number,
  value: string,
  purgeFence: PurgeGenerations | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let stale = false;
    try {
      throwIfAborted(signal);
      transaction = database.transaction(METADATA_STORE, "readwrite");
      const staleFlag: StaleFlag = { value: false };
      guardPurgeGeneration(transaction, userId, purgeFence, staleFlag);
      const metadata = transaction.objectStore(METADATA_STORE);
      const orderRequest = metadata.get(imageOrderKey(userId, noteId, imageId));
      orderRequest.onsuccess = () => {
        if (staleFlag.value) {
          return;
        }
        if (Number(orderRequest.result?.value ?? 0) !== orderingToken) {
          stale = true;
          transaction.abort();
          return;
        }
        metadata.delete(imageMetadataKey(userId, noteId, imageId));
        metadata.put({
          key: imageMetadataKey(userId, noteId, imageId),
          value,
        });
      };
      orderRequest.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => undefined;
    transaction.onabort = () =>
      reject(
        stale
          ? invalidatedError()
          : (transaction.error ?? new DOMException("Transaction aborted")),
      );
  });
}

function writeNoteAuthorityMarkers(
  metadata: IDBObjectStore,
  userId: string,
  identities: readonly string[],
  records: Map<string, MetadataRecord>,
  denialGeneration: number | undefined,
  denialSequence: number | undefined,
): void {
  for (const identity of identities) {
    const previous = parseNoteAuthority(
      records.get(deniedNoteKey(userId, identity)),
    );
    if (
      denialGeneration === undefined &&
      (denialSequence === undefined ||
        (previous?.generation ?? 0) > denialSequence)
    ) {
      throw invalidatedError();
    }
    metadata.put({
      key: deniedNoteKey(userId, identity),
      value: JSON.stringify({
        denied: denialGeneration !== undefined,
        generation: denialGeneration ?? previous?.generation ?? 0,
      } satisfies NoteAuthorityMarker),
    } satisfies MetadataRecord);
  }
}

function updateNoteAuthority(
  database: IDBDatabase,
  userId: string,
  id: string,
  action: "deny" | "clear",
  purgeFence: PurgeGenerations | undefined,
  orderingToken?: number,
  denialSequence?: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    const stale: StaleFlag = { value: false };
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      guardPurgeGeneration(transaction, userId, purgeFence, stale);
    } catch (error) {
      reject(error);
      return;
    }
    const metadata = transaction.objectStore(METADATA_STORE);
    const identities = noteIdentityIds(userId, id);
    let failure: unknown;
    let committedGeneration = 0;
    readMetadataBatch(
      metadata,
      [
        noteOrderKey(userId),
        ...identities.map((identity) => deniedNoteKey(userId, identity)),
      ],
      (records) => {
        if (
          orderingToken !== undefined &&
          currentNoteReadGeneration(userId, id) !== orderingToken
        ) {
          throw invalidatedError();
        }
        let generation: number | undefined;
        if (action === "deny") {
          generation = noteSequence(records.get(noteOrderKey(userId))) + 1;
          committedGeneration = generation;
          if (!Number.isSafeInteger(generation)) {
            throw new Error("Note denial sequence exhausted");
          }
          metadata.put({
            key: noteOrderKey(userId),
            value: String(generation),
          } satisfies MetadataRecord);
        }
        writeNoteAuthorityMarkers(
          metadata,
          userId,
          identities,
          records,
          generation,
          denialSequence,
        );
      },
      (error) => {
        failure = error;
        transaction.abort();
      },
    );
    transaction.oncomplete = () => {
      resolve(committedGeneration);
    };
    transaction.onabort = () => {
      reject(
        stale.value
          ? invalidatedError()
          : (failure ?? transaction.error ?? invalidatedError()),
      );
    };
  });
}

// ---------------------------------------------------------------------------
// Folder denial ledger (durable generation CAS)
// ---------------------------------------------------------------------------

type FolderOperation = {
  userId: string;
  folderId: string | null;
  orderingToken: number | undefined;
  action: "deny" | "clear" | "check";
  save?: { record: FolderRecord; asDriveRoot: boolean };
};

function folderOperationIds(
  operation: FolderOperation,
  rootId: string | null,
): (string | null)[] {
  const { folderId, save } = operation;
  const ids = new Set<string | null>([folderId]);
  if (folderId === null || folderId === rootId || save?.asDriveRoot) {
    ids.add(null);
    if (rootId !== null) {
      ids.add(rootId);
    }
  }
  if (save) {
    ids.add(save.record.folderId);
  }
  return [...ids];
}

function reportCommittedFolderDenial(
  userId: string,
  id: string | null,
  receipt: FolderDenialReceipt,
): void {
  if (receipt.committed && receipt.changed) {
    reportOfflineFolderDenial(userId, id, receipt.generation, receipt.aliases);
  }
}

type FolderMarkerState = {
  denied: boolean;
  generation: number;
  id: string | null;
};

function readFolderMarkerStates(
  userId: string,
  ids: (string | null)[],
  records: Map<string, MetadataRecord>,
): FolderMarkerState[] {
  return ids.map((id) => {
    const marker = parseFolderDenialMarker(
      records.get(deniedFolderKey(userId, id)),
      id,
    );
    return {
      denied: marker?.denied === true,
      generation: marker?.generation ?? 1,
      id,
    };
  });
}

// A stale deny is dropped, never thrown: a denial newer than the caller's
// token already won, so resubmitting it would only roll the state back.
function isStaleFolderDeny(
  action: FolderOperation["action"],
  orderingToken: number | undefined,
  currentGeneration: number,
): boolean {
  return (
    action === "deny" &&
    orderingToken !== undefined &&
    currentGeneration > orderingToken
  );
}

// "check" throws only when a denied marker is newer than the token.
// Generation advances written by clear/putFolder carry denied: false and
// must not invalidate a read that was captured after them.
function assertFolderReadFresh(
  orderingToken: number | undefined,
  current: FolderMarkerState[],
): void {
  if (
    orderingToken === undefined ||
    current.some((marker) => marker.denied && marker.generation > orderingToken)
  ) {
    throw invalidatedError();
  }
}

// "clear" (including putFolder saves) requires a token newer than every
// recorded generation; "deny" already passed its staleness fence above.
function assertFolderWriteFresh(
  action: FolderOperation["action"],
  orderingToken: number | undefined,
  current: FolderMarkerState[],
): void {
  if (
    action !== "deny" &&
    (orderingToken === undefined ||
      current.some((marker) => marker.generation > orderingToken))
  ) {
    throw invalidatedError();
  }
}

function putFolderOperationMarkers(
  store: IDBObjectStore,
  userId: string,
  action: FolderOperation["action"],
  generation: number,
  current: FolderMarkerState[],
): void {
  if (action === "deny" || action === "clear") {
    store.put({
      key: folderSequenceKey(userId),
      value: String(generation),
    } satisfies MetadataRecord);
  }
  for (const marker of current) {
    store.put({
      key: deniedFolderKey(userId, marker.id),
      value: JSON.stringify({
        denied: action === "deny",
        folderId: marker.id,
        generation,
      } satisfies FolderDenialMarker),
    } satisfies MetadataRecord);
  }
}

function putFolderOperationSave(
  transaction: IDBTransaction,
  store: IDBObjectStore,
  userId: string,
  save: FolderOperation["save"],
): void {
  if (!save) {
    return;
  }
  transaction.objectStore(FOLDER_STORE).put(save.record);
  if (save.asDriveRoot) {
    store.put({
      key: driveRootMetadataKey(userId),
      value: JSON.stringify(save.record.folderId),
    } satisfies MetadataRecord);
  }
}

function applyFolderOperation(
  transaction: IDBTransaction,
  operation: FolderOperation,
  sequence: number,
  ids: (string | null)[],
  records: Map<string, MetadataRecord>,
  receipt: { value?: FolderDenialReceipt },
): void {
  const { userId, action, orderingToken, save } = operation;
  const store = transaction.objectStore(METADATA_STORE);
  const current = readFolderMarkerStates(userId, ids, records);
  const currentGeneration = Math.max(
    ...current.map((marker) => marker.generation),
  );
  receipt.value = {
    aliases: ids,
    committed: false,
    generation: currentGeneration,
  };
  if (isStaleFolderDeny(action, orderingToken, currentGeneration)) {
    return;
  }
  if (action === "check") {
    assertFolderReadFresh(orderingToken, current);
    return;
  }
  if (action === "clear" && save && orderingToken === undefined) {
    // A save without a read token cannot prove freshness: persist the
    // record, but leave the denial ledger untouched — any committed denial
    // still projects over it on read.
    putFolderOperationSave(transaction, store, userId, save);
    receipt.value = {
      aliases: ids,
      committed: true,
      generation: currentGeneration,
    };
    return;
  }
  assertFolderWriteFresh(action, orderingToken, current);
  const generation = sequence + 1;
  const liftedDenial =
    action !== "deny" && current.some((marker) => marker.denied);
  // Whether any marker's denied state actually flipped. Events are only
  // broadcast on a state change so idempotent repeats (e.g. a page's own
  // detached re-deny of an already denied folder) cannot trigger reload
  // loops in subscribers.
  const changed =
    action === "deny" ? current.some((marker) => !marker.denied) : liftedDenial;
  putFolderOperationMarkers(store, userId, action, generation, current);
  receipt.value = {
    aliases: ids,
    changed,
    committed: true,
    generation,
    liftedDenial,
  };
  putFolderOperationSave(transaction, store, userId, save);
}

function queueFolderOperation(
  transaction: IDBTransaction,
  operation: FolderOperation,
  fail: (error: unknown) => void,
  receipt: { value?: FolderDenialReceipt },
): void {
  const store = transaction.objectStore(METADATA_STORE);
  const rootKey = driveRootMetadataKey(operation.userId);
  const sequenceKey = folderSequenceKey(operation.userId);
  readMetadataBatch(
    store,
    [rootKey, sequenceKey],
    (initial) => {
      const ids = folderOperationIds(
        operation,
        rootReferenceId(initial.get(rootKey)),
      );
      readMetadataBatch(
        store,
        ids.map((id) => deniedFolderKey(operation.userId, id)),
        (records) =>
          applyFolderOperation(
            transaction,
            operation,
            folderSequence(initial.get(sequenceKey)),
            ids,
            records,
            receipt,
          ),
        fail,
      );
    },
    fail,
  );
}

// One metadata transaction orders root aliases, denial, revalidation and
// writes. The durable purge generation is the only cross-operation fence.
function updateFolderDenial(
  database: IDBDatabase,
  userId: string,
  folderId: string | null,
  orderingToken: number | undefined,
  action: "deny" | "clear" | "check",
  save?: { record: FolderRecord; asDriveRoot: boolean },
  signal?: AbortSignal,
  purgeFence?: PurgeGenerations,
): Promise<FolderDenialReceipt> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let failure: unknown;
    const stale: StaleFlag = { value: false };
    const receipt: { value?: FolderDenialReceipt } = {};
    try {
      transaction = database.transaction(
        [METADATA_STORE, FOLDER_STORE],
        "readwrite",
      );
      guardPurgeGeneration(transaction, userId, purgeFence, stale);
      const fail = (error: unknown) => {
        failure = error;
        transaction.abort();
      };
      queueFolderOperation(
        transaction,
        { action, folderId, orderingToken, save, userId },
        fail,
        receipt,
      );
    } catch (error) {
      reject(error);
      return;
    }
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // Transaction completion is authoritative if it already committed.
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const unregister = () => {
      signal?.removeEventListener("abort", abort);
    };
    transaction.oncomplete = () => {
      unregister();
      resolve(
        receipt.value ?? {
          aliases: [folderId],
          committed: false,
          generation: null,
        },
      );
    };
    transaction.onabort = () => {
      unregister();
      reject(
        signal?.aborted
          ? signal.reason
          : (failure ?? transaction.error ?? invalidatedError()),
      );
    };
  });
}

async function readDeniedFolderIds(
  database: IDBDatabase,
  userId: string,
): Promise<Set<string | null>> {
  return (await readFolderDenialSnapshot(database, userId)).deniedFolderIds;
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
        [NOTE_STORE, NOTE_LIST_STORE, METADATA_STORE],
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

// ---------------------------------------------------------------------------
// Cache handle
// ---------------------------------------------------------------------------

function reportImageInvalidation(
  userId: string,
  noteId: string,
  imageId: string,
): void {
  const event: ImageInvalidationEvent = {
    resource: { imageId, noteId, type: "image" },
    type: "invalidate",
    userId,
  };
  notifyLifecycle(event);
  try {
    lifecycleChannel?.postMessage(event);
  } catch {
    // The durable marker remains authoritative when delivery is unavailable.
  }
}

// Purge drains the tracked writes of the same tab before deleting; cross-tab
// ordering is fenced by the durable purge generation inside each transaction.
function trackUserWrite<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const write = operation();
  let writes = pendingUserWrites.get(userId);
  if (!writes) {
    writes = new Set();
    pendingUserWrites.set(userId, writes);
  }
  writes.add(write);
  const release = () => {
    writes.delete(write);
    if (writes.size === 0) {
      pendingUserWrites.delete(userId);
    }
  };
  void write.then(release, release);
  return write;
}

function parseImageRecord(
  record: MetadataRecord | undefined,
): ImageRecord | null {
  if (!record || record.value === "denied") {
    return null;
  }
  try {
    const image = JSON.parse(record.value) as Partial<ImageRecord>;
    return isFileName(image.fileName) && typeof image.mime === "string"
      ? { fileName: image.fileName, mime: image.mime }
      : null;
  } catch {
    return null;
  }
}

async function readNoteFileBlob(
  userId: string,
  noteId: string,
  fileName: string,
  assertCurrent: () => void,
): Promise<Blob | null> {
  try {
    const file = await noteFile(userId, noteId, fileName, false, assertCurrent);
    return await file.getFile();
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === "NotFoundError") ||
      isInvalidatedError(error)
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * `database === null` produces the degraded stand-in: reads resolve as cache
 * misses and writes reject, so the display layer keeps working while storage
 * is unavailable or a purge is running.
 */
function createOfflineCacheHandle(
  database: IDBDatabase | null,
  userId: string,
  purgeFence: PurgeGenerations | undefined,
): OfflineCache {
  let closed = false;
  // Captured once at open: a later same-tab purge bumps the realm counters,
  // which permanently retires this handle's reads and writes.
  const openRealm = captureRealmToken(userId);

  const readable = (): IDBDatabase | null => (closed ? null : database);

  const writable = (realm: RealmToken): IDBDatabase => {
    if (!database || closed) {
      throw new Error("Offline cache is unavailable");
    }
    if (!isRealmCurrent(userId, realm)) {
      throw invalidatedError();
    }
    return database;
  };

  const assertReadable = (realm: RealmToken): void => {
    if (!isRealmCurrent(userId, realm)) {
      throw invalidatedError();
    }
  };

  // Writes take the shared user lock only when there is real storage to
  // touch — a degraded (or closed) handle rejects immediately instead of
  // queueing behind a live purge's exclusive lock.
  const lockedWrite = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!database || closed) {
      return Promise.reject(new Error("Offline cache is unavailable"));
    }
    return userStorageLock(userId, "shared", operation);
  };

  return {
    async beginFolderRead(id) {
      const db = readable();
      if (!db) {
        return 1;
      }
      void id;
      return (await readFolderDenialSnapshot(db, userId)).sequence;
    },

    beginImageRead(noteId, imageId) {
      return lockedWrite(async () => {
        const db = readable();
        if (!db) {
          return 0;
        }
        return (
          (await changeImageOrder(
            db,
            userId,
            noteId,
            imageId,
            undefined,
            false,
            purgeFence,
          )) ?? 0
        );
      });
    },

    beginNoteRead(id) {
      return beginNoteReadOrder(userId, id);
    },

    capturedPurgeFence() {
      return purgeFence ?? null;
    },

    async captureNoteDenialSequence() {
      const db = readable();
      if (!(db && isRealmCurrent(userId, openRealm))) {
        return null;
      }
      try {
        return noteSequence(await readMetadataRecord(db, noteOrderKey(userId)));
      } catch {
        // The ledger is best-effort; an unreadable sequence is no authority.
        return null;
      }
    },

    clearFolderDenial(id, orderingToken) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        const receipt = await updateFolderDenial(
          db,
          userId,
          id,
          orderingToken,
          "clear",
          undefined,
          undefined,
          purgeFence,
        );
        if (receipt.committed && receipt.changed) {
          reportOfflineFolderDenial(userId, id, null, receipt.aliases);
        }
      });
    },

    clearNoteDenial(id, orderingToken, denialSequence) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        await trackUserWrite(userId, () =>
          updateNoteAuthority(
            db,
            userId,
            id,
            "clear",
            purgeFence,
            orderingToken,
            denialSequence,
          ),
        );
        // A lifted denial is not a denial event — broadcasting one would make
        // observers hide the very note this successful read just published.
      });
    },

    close(): void {
      closed = true;
      database?.close();
    },
    degraded: database === null,

    denyFolder(id, orderingToken, signal) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        let committedReceipt: FolderDenialReceipt | undefined;
        await trackUserWrite(userId, async () => {
          committedReceipt = await updateFolderDenial(
            db,
            userId,
            id,
            orderingToken,
            "deny",
            undefined,
            signal,
            purgeFence,
          );
        });
        const receipt = committedReceipt ?? {
          aliases: [id],
          committed: false,
          generation: null,
        };
        reportCommittedFolderDenial(userId, id, receipt);
        return receipt.committed;
      });
    },

    denyImage(noteId, imageId, orderingToken) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        const generation = await trackUserWrite(userId, async () => {
          await changeImageOrder(
            db,
            userId,
            noteId,
            imageId,
            orderingToken,
            true,
            purgeFence,
          );
        });
        void generation;
        reportImageInvalidation(userId, noteId, imageId);
      });
    },

    denyNote(id, orderingToken) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        const token = orderingToken ?? enterOfflineNoteDenial(userId, id);
        const generation = await trackUserWrite(userId, () =>
          updateNoteAuthority(db, userId, id, "deny", purgeFence, token),
        );
        // The durable marker is committed first; removing the record is
        // belt-and-suspenders — projection hides it either way.
        const removedFileName = await removeCachedNote(db, userId, id);
        if (removedFileName) {
          await removeUnreferencedNoteFile(userId, id, removedFileName);
        }
        reportOfflineNoteDenial(userId, id, generation);
      });
    },

    async getFolder(id) {
      const realm = openRealm;
      const db = readable();
      if (!(db && isRealmCurrent(userId, realm))) {
        return null;
      }
      // The token fences the whole read: a denial committing between the
      // snapshot and the check turns this into a miss.
      const orderingToken = (await readFolderDenialSnapshot(db, userId))
        .sequence;
      const record = await readFolderForRoute(db, userId, id);
      if (!(record && isRealmCurrent(userId, realm))) {
        return null;
      }
      const deniedFolderIds = await readDeniedFolderIds(db, userId);
      const projected = projectDeniedFolder(record.folder, deniedFolderIds);
      if (!(projected && isRealmCurrent(userId, realm))) {
        return null;
      }
      try {
        await updateFolderDenial(
          db,
          userId,
          id,
          orderingToken,
          "check",
          undefined,
          undefined,
          purgeFence,
        );
      } catch {
        return null;
      }
      return { cachedAt: record.cachedAt, folder: projected };
    },

    async getFolderState(id) {
      const realm = openRealm;
      const db = readable();
      if (!(db && isRealmCurrent(userId, realm))) {
        return "missing";
      }
      const deniedFolderIds = await readDeniedFolderIds(db, userId);
      const record = await readFolderForRoute(db, userId, id);
      if (record) {
        return projectDeniedFolder(record.folder, deniedFolderIds)
          ? "available"
          : "denied";
      }
      if (deniedFolderIds.has(id)) {
        return "denied";
      }
      if (id === null) {
        // Root denials may be recorded under the concrete root folder id.
        const rootReference = await readMetadataRecord(
          db,
          driveRootMetadataKey(userId),
        );
        if (deniedFolderIds.has(rootReferenceId(rootReference))) {
          return "denied";
        }
      }
      return "missing";
    },

    async getImage(noteId, imageId) {
      const realm = openRealm;
      const db = readable();
      if (!(db && isRealmCurrent(userId, realm))) {
        return null;
      }
      const image = parseImageRecord(
        await readMetadataRecord(db, imageMetadataKey(userId, noteId, imageId)),
      );
      if (!(image && isRealmCurrent(userId, realm))) {
        return null;
      }
      const blob = await readNoteFileBlob(userId, noteId, image.fileName, () =>
        assertReadable(realm),
      );
      if (!(blob && isRealmCurrent(userId, realm))) {
        return null;
      }
      return blob.slice(0, blob.size, image.mime);
    },

    async getNote(id) {
      const realm = openRealm;
      const db = readable();
      if (!(db && isRealmCurrent(userId, realm))) {
        return null;
      }
      const orderingToken = beginNoteReadOrder(userId, id);
      const record = await readNoteForRoute(db, userId, id);
      if (!(record && isRealmCurrent(userId, realm))) {
        return null;
      }
      // A denial or realm change committing mid-read makes the snapshot
      // stale; each stage re-checks this before returning.
      const stillFresh = () =>
        isRealmCurrent(userId, realm) &&
        isCurrentNoteReadOrder(userId, record.noteId, orderingToken);
      // Check the denial ledger for every identity the route may resolve.
      if (await isNoteRecordDenied(db, userId, record)) {
        return null;
      }
      if (!stillFresh()) {
        return null;
      }
      const blob = await readNoteFileBlob(
        userId,
        record.noteId,
        record.fileName,
        () => assertReadable(realm),
      );
      if (!(blob && stillFresh())) {
        return null;
      }
      // The denial must also fence a read whose body decode was already in
      // flight, so the ordering token is re-checked after blob.text().
      const markdown = await blob.text();
      if (!stillFresh()) {
        return null;
      }
      bindNoteIdentity(userId, record.noteId, record.note.shortId);
      return {
        cachedAt: record.cachedAt,
        note: { ...record.note, markdown },
      };
    },

    async getNoteList() {
      const realm = openRealm;
      const db = readable();
      if (!(db && isRealmCurrent(userId, realm))) {
        return null;
      }
      const record = await readNoteListRecord(db, noteListKey(userId));
      if (!(record && isRealmCurrent(userId, realm))) {
        return null;
      }
      const sequenceBefore = (await readFolderDenialSnapshot(db, userId))
        .sequence;
      const visible = await readVisibleNoteList(db, userId, realm, record);
      if (!visible) {
        return null;
      }
      // A folder denial committing while this read was in flight makes the
      // snapshot stale; report a miss so callers re-read the current ledger.
      const sequenceAfter = (await readFolderDenialSnapshot(db, userId))
        .sequence;
      if (sequenceAfter !== sequenceBefore || !isRealmCurrent(userId, realm)) {
        return null;
      }
      return visible;
    },

    async getNoteListState() {
      const realm = openRealm;
      const db = readable();
      if (!(db && isRealmCurrent(userId, realm))) {
        return "missing";
      }
      const record = await readNoteListRecord(db, noteListKey(userId));
      if (record) {
        return "available";
      }
      const { deniedFolderIds } = await readFolderDenialSnapshot(db, userId);
      return deniedFolderIds.has(null) ? "denied" : "missing";
    },

    putFolder(folder, options = {}) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        // A caller token captured at read start authorizes lifting a denial;
        // without one the record is saved but the ledger is left alone, so a
        // stale success can never resurrect a denied folder.
        const orderingToken = options.orderingToken;
        const record: FolderRecord = {
          cachedAt: Date.now(),
          folder,
          folderId: folder.id,
          key: folderKey(userId, folder.id),
          userId,
        };
        const receipt = await trackUserWrite(userId, async () =>
          updateFolderDenial(
            db,
            userId,
            folder.id,
            orderingToken,
            "clear",
            { asDriveRoot: options.asDriveRoot === true, record },
            options.signal,
            purgeFence,
          ),
        );
        // Only notify peers when this write lifted a recorded denial —
        // otherwise every successful folder fetch would retrigger the
        // denial listeners and loop the reload.
        if (receipt.liftedDenial) {
          reportOfflineFolderDenial(userId, folder.id, null, [
            folder.id,
            ...(options.asDriveRoot === true ? [null] : []),
          ]);
        }
      });
    },

    putImage(noteId, imageId, bytes, options = {}) {
      // The shared user lock keeps an in-flight OPFS write visible to a
      // purge or orphan sweep in another tab waiting on the exclusive lock.
      return lockedWrite(async () => {
        if (!isSupportedCachedImageMime(bytes.type)) {
          throw new Error(`Unsupported cached image MIME: ${bytes.type}`);
        }
        const realm = openRealm;
        const db = writable(realm);
        await assertPurgeGenerationCurrent(db, userId, purgeFence);
        const orderingToken =
          options.orderingToken ??
          (await changeImageOrder(
            db,
            userId,
            noteId,
            imageId,
            undefined,
            false,
            purgeFence,
          )) ??
          0;
        const fileName = await writeNoteFileContents(
          userId,
          noteId,
          bytes,
          options.signal,
          () => {
            throwIfAborted(options.signal);
            assertReadable(realm);
          },
        );
        try {
          await trackUserWrite(userId, () =>
            commitImageMetadata(
              db,
              userId,
              noteId,
              imageId,
              orderingToken,
              JSON.stringify({
                fileName,
                mime: bytes.type,
              } satisfies ImageRecord),
              purgeFence,
              options.signal,
            ),
          );
        } catch (error) {
          await removeUnreferencedNoteFile(userId, noteId, fileName);
          throw error;
        }
      });
    },

    putNote(note, options = {}) {
      // The shared user lock keeps the in-flight OPFS write visible to a
      // purge or orphan sweep waiting on the exclusive lock in another tab.
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        if (
          !bindNoteIdentity(
            userId,
            note.id,
            note.shortId,
            options.orderingToken,
          )
        ) {
          // A denial began after the caller's read token was captured; the
          // stale success must not resurrect the note.
          throw invalidatedError();
        }
        await assertPurgeGenerationCurrent(db, userId, purgeFence);
        const fileName = await writeNoteFileContents(
          userId,
          note.id,
          note.markdown,
          options.signal,
          () => {
            throwIfAborted(options.signal);
            assertReadable(realm);
          },
        );
        const record: NoteRecord = {
          cachedAt: Date.now(),
          fileName,
          key: noteKey(userId, note.id),
          note: (({ markdown: _markdown, ...summary }) => summary)(note),
          noteId: note.id,
          userId,
        };
        try {
          await trackUserWrite(userId, () =>
            commitTransaction(
              db,
              NOTE_STORE,
              record,
              userId,
              purgeFence,
              options.signal,
              options.denialSequence,
            ),
          );
        } catch (error) {
          await removeUnreferencedNoteFile(userId, note.id, fileName);
          throw error;
        }
      });
    },

    putNoteList(notes, options = {}) {
      return lockedWrite(async () => {
        const realm = openRealm;
        const db = writable(realm);
        const record: NoteListRecord = {
          cachedAt: Date.now(),
          key: noteListKey(userId),
          notes,
          userId,
        };
        await trackUserWrite(userId, () =>
          commitNoteListRecord(db, record, userId, purgeFence, options.signal),
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Open the display cache for `userId`. Never blocks on a running purge: a
 * live purge (or unavailable storage) yields a degraded handle whose reads
 * are misses and whose writes reject. Leftover purge tombstones are finished
 * by whoever can take the same exclusive lock first.
 */
export async function openOfflineCache(
  options: OpenOfflineCacheOptions,
): Promise<OfflineCache> {
  const { userId } = options;
  if (!userId) {
    throw new Error("A user ID is required");
  }
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    return createOfflineCacheHandle(null, userId, undefined);
  }
  let database: IDBDatabase;
  try {
    database = await openDatabase(options.signal);
  } catch (error) {
    // A caller's own cancellation still wins; storage failures degrade to
    // an empty cache and callers must not treat them as fatal.
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    return createOfflineCacheHandle(null, userId, undefined);
  }
  try {
    throwIfAborted(options.signal);
    if (
      (await healInterruptedPurgeMarkers(database, userId, options.signal)) ===
      "purging"
    ) {
      database.close();
      return createOfflineCacheHandle(null, userId, undefined);
    }
    // The caller's own cancellation wins even when the tombstone scan's
    // storage reads absorbed it — an aborted open must not yield a handle.
    throwIfAborted(options.signal);
    const { deviceGeneration, userGeneration } = await readPurgeState(
      database,
      userId,
    );
    throwIfAborted(options.signal);
    if (pendingUpgradeWipe) {
      pendingUpgradeWipe = false;
      // The v4→v5 upgrade wiped every IDB record, orphaning all managed
      // OPFS files. Sweep them detached — first paint must not wait.
      void collectOfflineCacheOrphans(userId).catch(() => {
        // Unreachable files are harmless; a later sweep picks them up.
      });
    }
    return createOfflineCacheHandle(database, userId, {
      device: deviceGeneration,
      user: userGeneration,
    });
  } catch (error) {
    database.close();
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    return createOfflineCacheHandle(null, userId, undefined);
  }
}

function parseCachedViewerProfile(value: unknown): SessionUser | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const user = parsed as Record<string, unknown>;
    if (
      typeof user.id === "string" &&
      user.id.length > 0 &&
      typeof user.email === "string" &&
      (typeof user.displayName === "string" || user.displayName === null)
    ) {
      return {
        displayName: user.displayName,
        email: user.email,
        id: user.id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeViewerIdentity(
  userId: string,
  profile: SessionUser | null,
  options: CancellationOptions,
): Promise<void> {
  if (!("indexedDB" in globalThis)) {
    return;
  }
  // Fence on the in-memory realm plus the durable tombstone: a purge that
  // started after this write was captured already deleted the identity, so
  // committing now would resurrect it.
  const realm = captureRealmToken(userId);
  const database = await openDatabase(options.signal);
  try {
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(METADATA_STORE, "readwrite");
      } catch (error) {
        reject(error);
        return;
      }
      const onAbort = () => {
        try {
          transaction.abort();
        } catch {
          // Completion may already be in progress; the terminal event wins.
        }
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const unregister = () => {
        options.signal?.removeEventListener("abort", onAbort);
      };
      const store = transaction.objectStore(METADATA_STORE);
      const tombstone = store.get(userPurgeTombstoneKey(userId));
      tombstone.onsuccess = () => {
        if (
          tombstone.result !== undefined ||
          options.signal?.aborted ||
          !isRealmCurrent(userId, realm)
        ) {
          onAbort();
          return;
        }
        store.put({
          key: VIEWER_ID_METADATA_KEY,
          value: userId,
        } satisfies MetadataRecord);
        if (profile) {
          // Display-only copy of the signed-in profile; it is never used as
          // proof of authentication or server permissions.
          store.put({
            key: VIEWER_PROFILE_METADATA_KEY,
            value: JSON.stringify({
              displayName: profile.displayName,
              email: profile.email,
              id: profile.id,
            }),
          } satisfies MetadataRecord);
        }
      };
      tombstone.onerror = onAbort;
      transaction.oncomplete = () => {
        unregister();
        // A commit that already landed stays committed even when the
        // caller's abort raced the completion notification.
        resolve();
      };
      transaction.onerror = () => {
        unregister();
        reject(
          options.signal?.aborted
            ? options.signal.reason
            : (transaction.error ?? invalidatedError()),
        );
      };
      transaction.onabort = () => {
        unregister();
        reject(
          options.signal?.aborted
            ? options.signal.reason
            : (transaction.error ?? invalidatedError()),
        );
      };
      if (options.signal?.aborted) {
        onAbort();
      }
    });
  } finally {
    database.close();
  }
}

/** Remember the signed-in viewer so cold starts can route quickly. */
export function persistCachedViewerId(
  userId: string,
  options: CancellationOptions = {},
): Promise<void> {
  return writeViewerIdentity(userId, null, options);
}

/**
 * Remember the signed-in viewer together with a display-only profile
 * (id/email/displayName) so a cached cold start can show who the data
 * belongs to. The profile is not an authentication token.
 */
export function persistCachedViewer(
  user: SessionUser,
  options: CancellationOptions = {},
): Promise<void> {
  return writeViewerIdentity(user.id, user, options);
}

export type CachedViewerIdentity = {
  id: string;
  user: SessionUser | null;
};

/** Best-effort; `null` when storage is unavailable or nothing was saved. */
export async function readCachedViewer(
  options: CancellationOptions = {},
): Promise<CachedViewerIdentity | null> {
  if (!("indexedDB" in globalThis)) {
    return null;
  }
  try {
    throwIfAborted(options.signal);
    const database = await openDatabase(options.signal);
    try {
      const record = await readMetadataRecord(database, VIEWER_ID_METADATA_KEY);
      const id =
        typeof record?.value === "string" && record.value ? record.value : null;
      if (id === null) {
        return null;
      }
      const profile = await readMetadataRecord(
        database,
        VIEWER_PROFILE_METADATA_KEY,
      );
      const user = parseCachedViewerProfile(profile?.value);
      return { id, user: user?.id === id ? user : null };
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/** Best-effort; `null` when storage is unavailable or nothing was saved. */
export async function readCachedViewerId(
  options: CancellationOptions = {},
): Promise<string | null> {
  return (await readCachedViewer(options))?.id ?? null;
}
