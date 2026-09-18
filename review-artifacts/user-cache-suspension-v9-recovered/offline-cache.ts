// Canonical candidate v9; see decisions.md for transaction-terminal rationale.
import type { FolderAccess, Note, NoteSummary } from "@miyulabmd/shared";

import {
  beginNoteReadOrder,
  bindNoteIdentity,
  clearUserNoteReadOrder,
  currentNoteReadGeneration,
  enterNoteDenialOrder,
  isCurrentNoteReadOrder,
  noteIdentityIds,
} from "./note-access-order.ts";

const DATABASE_NAME = "miyulabmd-offline-cache";
const DATABASE_VERSION = 4;
const NOTE_STORE = "notes";
const FOLDER_STORE = "folders";
const NOTE_LIST_STORE = "note-lists";
const METADATA_STORE = "metadata";
const VIEWER_ID_METADATA_KEY = "viewer-id";
const DEVICE_EPOCH_METADATA_KEY = "device-epoch";
const DEVICE_CLEAR_STATE_METADATA_KEY = "device-clear-state";
const DEVICE_CLEAR_PURGING = "purging";
const DEVICE_CLEAR_ACTIVE = "active";
const GLOBAL_LOCK_NAME = "miyulabmd-offline-cache:global";
const DRIVE_ROOT_METADATA_PREFIX = "drive-root:";
const DENIED_NOTE_PREFIX = "denied-note:";
const NOTE_ORDER_PREFIX = "note-order:";
const DENIED_FOLDER_PREFIX = "denied-folder:";
const FOLDER_STATE_PREFIX = "folder-state:";
const IMAGE_METADATA_PREFIX = "image:";
const IMAGE_ORDER_PREFIX = "resource-order:image:";
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

export type OfflineNoteAuthority = {
  epoch: string;
  generation: number;
};

type StoreRecord = {
  storeName: string;
  record: NoteRecord | FolderRecord | NoteListRecord | MetadataRecord;
};

type OfflineCache = {
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
      authorityGeneration?: number;
    },
  ): Promise<void>;
  beginNoteRead(id: string): number;
  denyNote(id: string, orderingToken?: number): Promise<void>;
  clearNoteDenial(
    id: string,
    orderingToken: number,
    authorityGeneration: number,
  ): Promise<void>;
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
  close(): void;
};

export type OpenOfflineCacheOptions = {
  userId: string;
  scope?: OfflineCacheScope;
};

type CancellationOptions = {
  signal?: AbortSignal;
};

export type OfflineCacheDeviceClearOptions = CancellationOptions;

const suspendedUsers = new Set<string>();
const userLifetimes = new Map<string, number>();
const pendingUserOperations = new Map<string, Set<() => void>>();
const openUserCaches = new Map<string, Set<() => void>>();
const clearLifetimes = new Map<string, number>();
const userClearOperations = new Map<string, Promise<void>>();
const pendingUserWrites = new Map<string, Set<Promise<void>>>();
let globalLifetime = 0;
let globalSuspended = false;

export type OfflineCacheScope = {
  userId: string;
  epoch: string | null;
  lifetime: number;
};

const databaseScopes = new WeakMap<IDBDatabase, OfflineCacheScope>();
let epochDatabase: Promise<IDBDatabase | null> | undefined;

// A realm reader for the existing database, not another persistence layer.
// Epoch checks must not repeatedly open/close cache handles or acquire OPFS locks.
function getEpochDatabase(): Promise<IDBDatabase | null> {
  if (!epochDatabase) {
    epochDatabase = openDatabase().then(
      (database) => {
        database.onversionchange = () => {
          database.close();
          epochDatabase = undefined;
        };
        database.onclose = () => {
          epochDatabase = undefined;
        };
        return database;
      },
      () => {
        epochDatabase = undefined;
        return null;
      },
    );
  }
  return epochDatabase;
}

void getEpochDatabase();

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
    epoch: string | null;
    generation: number | null;
  };
};
export type FolderDenialEvent = {
  type: "invalidate";
  userId: string;
  resource: {
    type: "folder";
    aliases: (string | null)[];
    epoch: string | null;
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
    // Messaging is an optimization. The persisted epoch remains authoritative.
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
    (resource.epoch === null || typeof resource.epoch === "string") &&
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
    (resource.epoch === null || typeof resource.epoch === "string") &&
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
  epoch: string | null,
  generation: number | null,
): void {
  const event: NoteDenialEvent = {
    resource: {
      aliases: noteIdentityIds(userId, id),
      epoch,
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
    // A missing notification does not undo the durable authority marker.
  }
}

export function reportOfflineFolderDenial(
  userId: string,
  id: string | null,
  epoch: string | null,
  generation: number | null,
  aliases: readonly (string | null)[] = [id],
): void {
  const event: FolderDenialEvent = {
    resource: {
      aliases: [...new Set(aliases)],
      epoch,
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

export function subscribeOfflineCacheLifecycle(
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
  clearLifetimes.set(userId, captureOfflineCacheUserClearLifetime(userId) + 1);
  clearUserNoteReadOrder(userId);
  userLifetimes.set(userId, currentUserLifetime(userId) + 1);
  for (const abort of pendingUserOperations.get(userId) ?? []) {
    abort();
  }
  for (const close of openUserCaches.get(userId) ?? []) {
    close();
  }
  notifyLifecycle({ type: "invalidate", userId });
}

function invalidateDeviceRealm(): void {
  globalLifetime += 1;
  globalSuspended = true;
  for (const userId of new Set([
    ...openUserCaches.keys(),
    ...userLifetimes.keys(),
  ])) {
    invalidateRealm(userId);
  }
  notifyLifecycle({ type: "device-invalidate", userId: "" });
}

function handleDenialLifecycleMessage(
  event: NoteDenialEvent | FolderDenialEvent,
): void {
  if (event.resource.generation === null) {
    suspendOfflineCacheUser(event.userId);
  }
  notifyLifecycle(event);
}

function handleImageLifecycleMessage(event: ImageInvalidationEvent): void {
  notifyLifecycle(event);
}

function handleInvalidationLifecycleMessage(
  data: unknown,
  event: Partial<OfflineCacheLifecycleEvent>,
): void {
  if (isNoteDenialEvent(data) || isFolderDenialEvent(data)) {
    handleDenialLifecycleMessage(data);
  } else if (isImageInvalidationEvent(data)) {
    handleImageLifecycleMessage(data);
  } else if (!event.resource && typeof event.userId === "string") {
    invalidateRealm(event.userId);
  }
}

function handleLifecycleMessage(data: unknown): void {
  if (!data || typeof data !== "object" || !("type" in data)) {
    return;
  }
  const event = data as Partial<OfflineCacheLifecycleEvent>;
  if (event.type === "device-invalidate") {
    invalidateDeviceRealm();
  } else if (event.type === "invalidate" && typeof event.userId === "string") {
    handleInvalidationLifecycleMessage(data, event);
  } else if (event.type === "identity" && typeof event.userId === "string") {
    notifyLifecycle({ type: "identity", userId: event.userId });
  }
}

if (lifecycleChannel) {
  lifecycleChannel.onmessage = ({ data }) => handleLifecycleMessage(data);
}

function epochKey(userId: string): string {
  return `user-epoch:${encodePathPart(userId)}`;
}

function composeEpoch(globalEpoch: string, userEpoch: string): string {
  const json = JSON.stringify([globalEpoch, userEpoch]);
  return btoa(json)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/, "");
}

function readScopeEpochs(
  database: IDBDatabase,
  userId: string,
): Promise<{ global: string; user: string; state: "active" | "purging" }> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readonly");
      const store = transaction.objectStore(METADATA_STORE);
      const global = store.get(DEVICE_EPOCH_METADATA_KEY);
      const user = store.get(epochKey(userId));
      const state = store.get(DEVICE_CLEAR_STATE_METADATA_KEY);
      transaction.oncomplete = () => {
        const globalEpoch =
          (global.result as MetadataRecord | undefined)?.value ?? "0";
        const userEpoch =
          (user.result as MetadataRecord | undefined)?.value ?? "0";
        const clearState =
          (state.result as MetadataRecord | undefined)?.value ??
          DEVICE_CLEAR_ACTIVE;
        if (
          !(isValidEpoch(globalEpoch) && isValidEpoch(userEpoch)) ||
          isPurgingEpoch(globalEpoch) ||
          isPurgingEpoch(userEpoch) ||
          (clearState !== DEVICE_CLEAR_ACTIVE &&
            clearState !== DEVICE_CLEAR_PURGING)
        ) {
          reject(invalidatedError());
          return;
        }
        resolve({ global: globalEpoch, state: clearState, user: userEpoch });
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? invalidatedError());
    } catch (error) {
      reject(error);
    }
  });
}

function invalidatedError(): DOMException {
  return new DOMException("Offline cache scope invalidated", "AbortError");
}

function isValidEpoch(epoch: unknown): epoch is string {
  return (
    typeof epoch === "string" &&
    (epoch === "0" ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        epoch,
      ) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:purging$/.test(
        epoch,
      ))
  );
}

function isPurgingEpoch(epoch: string | null): boolean {
  return typeof epoch === "string" && epoch.endsWith(":purging");
}

function isInvalidActiveEpochFence(
  globalEpoch: string,
  userEpoch: string,
  state: string,
): boolean {
  return (
    !(isValidEpoch(globalEpoch) && isValidEpoch(userEpoch)) ||
    isPurgingEpoch(globalEpoch) ||
    isPurgingEpoch(userEpoch) ||
    state !== DEVICE_CLEAR_ACTIVE
  );
}

async function captureOfflineCacheScopeUnlocked(
  userId: string,
): Promise<OfflineCacheScope> {
  const lifetime = captureOfflineCacheUserClearLifetime(userId);
  const capturedGlobalLifetime = globalLifetime;
  let epoch: string | null = null;
  let devicePurging = false;
  try {
    const database = await getEpochDatabase();
    if (!database) {
      throw new Error("Offline cache metadata is unavailable");
    }
    const epochs = await readScopeEpochs(database, userId);
    epoch = composeEpoch(epochs.global, epochs.user);
    devicePurging = epochs.state === DEVICE_CLEAR_PURGING;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    // Cache availability must not gate healthy network display.
  }
  const scope = { epoch, lifetime, userId };
  if (
    isPurgingEpoch(epoch) ||
    devicePurging ||
    globalSuspended ||
    globalLifetime !== capturedGlobalLifetime ||
    !isOfflineCacheUserClearLifetimeCurrent(userId, lifetime)
  ) {
    throw invalidatedError();
  }
  return scope;
}

export function captureOfflineCacheScope(
  userId: string,
): Promise<OfflineCacheScope> {
  return userStorageLock(userId, "shared", () =>
    captureOfflineCacheScopeUnlocked(userId),
  );
}

async function assertOfflineCacheScopeUnlocked(
  scope: OfflineCacheScope,
  requireStorage = false,
): Promise<void> {
  const capturedGlobalLifetime = globalLifetime;
  if (!isOfflineCacheUserClearLifetimeCurrent(scope.userId, scope.lifetime)) {
    throw invalidatedError();
  }
  let epoch: string | null = null;
  try {
    const database = await getEpochDatabase();
    if (!database) {
      throw new Error("Offline cache metadata is unavailable");
    }
    const epochs = await readScopeEpochs(database, scope.userId);
    epoch = composeEpoch(epochs.global, epochs.user);
    if (epochs.state === DEVICE_CLEAR_PURGING || globalSuspended) {
      throw invalidatedError();
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (requireStorage) {
      throw error;
    }
    // Ordinary storage failures do not invalidate online data.
  }
  if (
    !isOfflineCacheUserClearLifetimeCurrent(scope.userId, scope.lifetime) ||
    globalSuspended ||
    globalLifetime !== capturedGlobalLifetime ||
    (scope.epoch !== null && epoch !== null && scope.epoch !== epoch)
  ) {
    throw invalidatedError();
  }
}

export function assertOfflineCacheScope(
  scope: OfflineCacheScope,
  requireStorage = false,
): Promise<void> {
  return userStorageLock(scope.userId, "shared", () =>
    assertOfflineCacheScopeUnlocked(scope, requireStorage),
  );
}

function userStorageLock<T>(
  userId: string,
  mode: "shared" | "exclusive",
  operation: () => Promise<T>,
): Promise<T> {
  return globalSharedStorageLock(() =>
    navigator.locks.request(
      `miyulabmd-offline-cache:user:${encodePathPart(userId)}`,
      { mode },
      operation,
    ),
  );
}

function globalSharedStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    return Promise.reject(new Error("Offline cache locking is unavailable"));
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

// Every handle mutation includes this read in its own write transaction.
// IDB serializes the epoch read with a purge's epoch increment.
function guardTransaction(
  database: IDBDatabase,
  transaction: IDBTransaction,
  expectedScope?: OfflineCacheScope,
): void {
  const scope = expectedScope ?? databaseScopes.get(database);
  if (!scope) {
    return;
  }
  const metadata = transaction.objectStore(METADATA_STORE);
  const global = metadata.get(DEVICE_EPOCH_METADATA_KEY);
  const user = metadata.get(epochKey(scope.userId));
  const state = metadata.get(DEVICE_CLEAR_STATE_METADATA_KEY);
  global.onsuccess = () => {
    user.onsuccess = () => {
      state.onsuccess = () => {
        const globalEpoch =
          (global.result as MetadataRecord | undefined)?.value ?? "0";
        const userEpoch =
          (user.result as MetadataRecord | undefined)?.value ?? "0";
        const clearState =
          (state.result as MetadataRecord | undefined)?.value ??
          DEVICE_CLEAR_ACTIVE;
        const actual = composeEpoch(globalEpoch, userEpoch);
        if (
          actual !== scope.epoch ||
          isInvalidActiveEpochFence(globalEpoch, userEpoch, clearState) ||
          globalSuspended ||
          !isOfflineCacheUserClearLifetimeCurrent(scope.userId, scope.lifetime)
        ) {
          transaction.abort();
        }
      };
    };
  };
}

export function suspendOfflineCacheUser(userId: string): void {
  suspendedUsers.add(userId);
  userLifetimes.set(userId, (userLifetimes.get(userId) ?? 0) + 1);
  for (const abort of pendingUserOperations.get(userId) ?? []) {
    abort();
  }
}

export function isOfflineCacheUserSuspended(userId: string): boolean {
  return suspendedUsers.has(userId);
}

export function captureOfflineCacheUserClearLifetime(userId: string): number {
  return clearLifetimes.get(userId) ?? 0;
}

export function isOfflineCacheUserClearLifetimeCurrent(
  userId: string,
  lifetime: number,
): boolean {
  return captureOfflineCacheUserClearLifetime(userId) === lifetime;
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

function deniedNoteKey(userId: string, noteId: string): string {
  return `${DENIED_NOTE_PREFIX}${noteKey(userId, noteId)}`;
}

/** Null means authority cannot be inspected, not proof of restored access. */
async function readOfflineNoteDenialUnlocked(
  event: NoteDenialEvent,
  identities: readonly string[],
): Promise<boolean | null> {
  try {
    const database = await getEpochDatabase();
    if (!database) {
      return null;
    }
    return await new Promise<boolean | null>((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readonly");
      let denied: boolean | null = null;
      readMetadataBatch(
        transaction.objectStore(METADATA_STORE),
        [
          DEVICE_EPOCH_METADATA_KEY,
          epochKey(event.userId),
          DEVICE_CLEAR_STATE_METADATA_KEY,
          ...identities.map((id) => deniedNoteKey(event.userId, id)),
        ],
        (records) => {
          const globalEpoch =
            records.get(DEVICE_EPOCH_METADATA_KEY)?.value ?? "0";
          const userEpoch = records.get(epochKey(event.userId))?.value ?? "0";
          const state =
            records.get(DEVICE_CLEAR_STATE_METADATA_KEY)?.value ??
            DEVICE_CLEAR_ACTIVE;
          if (isInvalidActiveEpochFence(globalEpoch, userEpoch, state)) {
            throw invalidatedError();
          }
          const epoch = composeEpoch(globalEpoch, userEpoch);
          if (event.resource.epoch !== null && epoch !== event.resource.epoch) {
            denied = false;
          } else if (event.resource.generation !== null) {
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
          }
        },
        () => transaction.abort(),
      );
      transaction.oncomplete = () => resolve(denied);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    return null;
  }
}

export function readOfflineNoteDenial(
  event: NoteDenialEvent,
  identities: readonly string[],
): Promise<boolean | null> {
  return userStorageLock(event.userId, "shared", () =>
    readOfflineNoteDenialUnlocked(event, identities),
  );
}

function noteOrderKey(userId: string): string {
  return `${NOTE_ORDER_PREFIX}${encodePathPart(userId)}`;
}

function noteSequence(record: MetadataRecord | undefined): number {
  const generation = Number(record?.value ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid note denial sequence");
  }
  return generation;
}

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

async function captureOfflineNoteAuthorityUnlocked(
  userId: string,
  _id: string,
): Promise<OfflineNoteAuthority> {
  const database = await getEpochDatabase();
  if (!database) {
    throw new Error("Note authority is unavailable");
  }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    let snapshot: OfflineNoteAuthority;
    let failure: unknown;
    readMetadataBatch(
      transaction.objectStore(METADATA_STORE),
      [
        noteOrderKey(userId),
        DEVICE_EPOCH_METADATA_KEY,
        epochKey(userId),
        DEVICE_CLEAR_STATE_METADATA_KEY,
      ],
      (records) => {
        const globalEpoch =
          records.get(DEVICE_EPOCH_METADATA_KEY)?.value ?? "0";
        const userEpoch = records.get(epochKey(userId))?.value ?? "0";
        const state =
          records.get(DEVICE_CLEAR_STATE_METADATA_KEY)?.value ??
          DEVICE_CLEAR_ACTIVE;
        if (isInvalidActiveEpochFence(globalEpoch, userEpoch, state)) {
          throw invalidatedError();
        }
        snapshot = {
          epoch: composeEpoch(globalEpoch, userEpoch),
          generation: noteSequence(records.get(noteOrderKey(userId))),
        };
      },
      (error) => {
        failure = error;
        transaction.abort();
      },
    );
    transaction.oncomplete = () => resolve(snapshot);
    transaction.onabort = () =>
      reject(failure ?? transaction.error ?? invalidatedError());
  });
}

async function assertOfflineNoteAuthorityUnlocked(
  authority: OfflineNoteAuthority,
  userId: string,
  id: string | readonly string[],
  scope?: OfflineCacheScope,
): Promise<void> {
  if (scope && scope.epoch !== authority.epoch) {
    throw invalidatedError();
  }
  const database = await getEpochDatabase();
  if (!database) {
    throw new Error("Note authority is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    guardTransaction(
      database,
      transaction,
      scope ?? {
        epoch: authority.epoch,
        lifetime: captureOfflineCacheUserClearLifetime(userId),
        userId,
      },
    );
    for (const identity of typeof id === "string" ? [id] : id) {
      const request = transaction
        .objectStore(METADATA_STORE)
        .get(deniedNoteKey(userId, identity));
      request.onsuccess = () => {
        if (
          (parseNoteAuthority(request.result)?.generation ?? 0) >
          authority.generation
        ) {
          transaction.abort();
        }
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(invalidatedError());
  });
  if (
    scope &&
    !isOfflineCacheUserClearLifetimeCurrent(userId, scope.lifetime)
  ) {
    throw invalidatedError();
  }
}

export function captureOfflineNoteAuthority(
  userId: string,
  id: string,
): Promise<OfflineNoteAuthority> {
  return userStorageLock(userId, "shared", () =>
    captureOfflineNoteAuthorityUnlocked(userId, id),
  );
}

export function assertOfflineNoteAuthority(
  authority: OfflineNoteAuthority,
  userId: string,
  id: string | readonly string[],
  scope?: OfflineCacheScope,
): Promise<void> {
  return userStorageLock(userId, "shared", () =>
    assertOfflineNoteAuthorityUnlocked(authority, userId, id, scope),
  );
}

function currentNoteGeneration(userId: string, noteId: string): number {
  return currentNoteReadGeneration(userId, noteId);
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

function deniedFolderKey(userId: string, folderId: string | null): string {
  return `${FOLDER_STATE_PREFIX}${encodePathPart(userId)}:${encodePathPart(
    JSON.stringify(["folder", folderId]),
  )}`;
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

function clearUserRecords(
  database: IDBDatabase,
  userId: string,
  epoch: string,
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
      metadata.put({ key: epochKey(userId), value: `${epoch}:purging` });
      const request = metadata.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        const key = String(cursor.key);
        if (
          key === driveRootMetadataKey(userId) ||
          key === folderSequenceKey(userId) ||
          key === noteOrderKey(userId) ||
          key.startsWith(`${FOLDER_STATE_PREFIX}${encodePathPart(userId)}:`) ||
          key.startsWith(
            `${IMAGE_METADATA_PREFIX}${encodePathPart(userId)}:`,
          ) ||
          key.startsWith(`${IMAGE_ORDER_PREFIX}${encodePathPart(userId)}:`) ||
          key.startsWith(`${DENIED_NOTE_PREFIX}${noteListKey(userId)}:`) ||
          key.startsWith(`${DENIED_FOLDER_PREFIX}${encodePathPart(userId)}:`)
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
        .openCursor(IDBKeyRange.bound(notePrefix, `${notePrefix}\uffff`));
      notes.onsuccess = () => {
        const cursor = notes.result;
        if (!cursor) {
          return;
        }
        const record = cursor.value as Partial<NoteRecord>;
        if (
          record.userId !== userId ||
          !isFileName(record.fileName) ||
          typeof record.noteId !== "string" ||
          record.key !== cursor.key ||
          record.key !== noteKey(userId, record.noteId)
        ) {
          transaction.abort();
          return;
        }
        files.add(`${encodePathPart(record.noteId)}/${record.fileName}`);
        cursor.continue();
      };
      notes.onerror = () => transaction.abort();

      const prefix = `${IMAGE_METADATA_PREFIX}${encodePathPart(userId)}:`;
      const metadata = transaction
        .objectStore(METADATA_STORE)
        .openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      metadata.onsuccess = () => {
        const cursor = metadata.result;
        if (!cursor) {
          return;
        }
        const key = String(cursor.key);
        try {
          const reference = imageFileReference(
            key.slice(prefix.length),
            cursor.value,
          );
          if (reference) {
            files.add(reference);
          }
        } catch {
          transaction.abort();
          return;
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
    throw new Error("Invalid image reference");
  }
  if (record.value === "denied") {
    return null;
  }
  const image = JSON.parse(record.value) as Partial<ImageRecord> | null;
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
    throw new Error("Invalid image reference");
  }
  return `${parts[0]}/${image.fileName}`;
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
    const capturedScope = await captureOfflineCacheScopeUnlocked(userId);
    if (capturedScope.epoch === null) {
      throw new Error("Offline cache metadata is unavailable");
    }
    const database = await openDatabase();
    try {
      await assertOfflineCacheScopeUnlocked(capturedScope, true);
      const references = await readUserFileSnapshot(database, userId);
      await assertOfflineCacheScopeUnlocked(capturedScope, true);

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

async function purgeOfflineCacheUser(userId: string): Promise<void> {
  if (!userId) {
    throw new Error("A user ID is required");
  }
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    throw new Error("Offline cache storage is unavailable");
  }
  invalidateRealm(userId);
  lifecycleChannel?.postMessage({ type: "invalidate", userId });
  suspendOfflineCacheUser(userId);
  for (const close of openUserCaches.get(userId) ?? []) {
    close();
  }
  await Promise.all(pendingUserWrites.get(userId) ?? []);
  await userStorageLock(userId, "exclusive", async () => {
    const database = await openDatabase();
    try {
      const epoch = crypto.randomUUID();
      await clearUserRecords(database, userId, epoch);
      await clearUserFiles(userId);
      await commitTransaction(
        database,
        METADATA_STORE,
        { key: epochKey(userId), value: epoch },
        userId,
      );
    } finally {
      database.close();
    }
  });
  suspendedUsers.delete(userId);
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

function updateDeviceState(
  database: IDBDatabase,
  state: string,
  epoch?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      const metadata = transaction.objectStore(METADATA_STORE);
      metadata.put({ key: DEVICE_CLEAR_STATE_METADATA_KEY, value: state });
      if (epoch !== undefined) {
        metadata.put({ key: DEVICE_EPOCH_METADATA_KEY, value: epoch });
      }
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? invalidatedError());
  });
}

function clearPrivateDeviceRecords(database: IDBDatabase): Promise<void> {
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
        // Only the viewer identity and device authority survive a device clear.
        if (
          key !== VIEWER_ID_METADATA_KEY &&
          key !== DEVICE_EPOCH_METADATA_KEY &&
          key !== DEVICE_CLEAR_STATE_METADATA_KEY
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
    // Durable state remains authoritative.
  }
  await globalStorageLock(async () => {
    const database = await openDatabase(options.signal);
    try {
      throwIfAborted(options.signal);
      // This marker is durable before either destructive operation.
      await updateDeviceState(database, DEVICE_CLEAR_PURGING);
      globalSuspended = true;
      for (const writes of pendingUserWrites.values()) {
        await Promise.all(writes);
      }
      await clearPrivateDeviceRecords(database);
      await removeDeviceFiles();
      const epoch = crypto.randomUUID();
      await updateDeviceState(database, DEVICE_CLEAR_ACTIVE, epoch);
      globalSuspended = false;
    } finally {
      database.close();
    }
  });
}

let deviceClearOperation: Promise<void> | undefined;
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

function commitTransaction(
  database: IDBDatabase,
  storeName: string,
  record: NoteRecord | MetadataRecord,
  userId: string,
  signal?: AbortSignal,
  authorityGeneration?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      throwIfAborted(signal);
      transaction = database.transaction(
        [...new Set([storeName, METADATA_STORE])],
        "readwrite",
      );
      guardTransaction(database, transaction);
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
      if (authorityGeneration !== undefined && "noteId" in record) {
        for (const id of noteIdentityIds(userId, record.noteId)) {
          const request = transaction
            .objectStore(METADATA_STORE)
            .get(deniedNoteKey(userId, id));
          request.onsuccess = () => {
            if (
              (parseNoteAuthority(request.result)?.generation ?? 0) >
              authorityGeneration
            ) {
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
      .openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
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

function commitFolderRecord(
  database: IDBDatabase,
  record: FolderRecord,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return commitStoreRecord(database, FOLDER_STORE, record, userId, signal);
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

function commitNoteListRecord(
  database: IDBDatabase,
  record: NoteListRecord,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return commitStoreRecord(database, NOTE_LIST_STORE, record, userId, signal);
}

function commitStoreRecord(
  database: IDBDatabase,
  storeName: string,
  record: FolderRecord | NoteListRecord,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return commitStoreRecords(database, [{ record, storeName }], userId, signal);
}

function commitStoreRecords(
  database: IDBDatabase,
  records: StoreRecord[],
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
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
      guardTransaction(database, transaction);
    } catch (error) {
      reject(error);
      return;
    }
    const operations =
      pendingUserOperations.get(userId) ?? new Set<() => void>();
    pendingUserOperations.set(userId, operations);
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
        operations.delete(abort);
        if (!operations.size) {
          pendingUserOperations.delete(userId);
        }
        callback();
      }
    };
    operations.add(abort);
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

function changeImageOrder(
  database: IDBDatabase,
  userId: string,
  noteId: string,
  imageId: string,
  orderingToken: number | undefined,
  deny: boolean,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let result: number | null = null;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      guardTransaction(database, transaction);
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
        if (deny) {
          metadata.put({
            key: imageMetadataKey(userId, noteId, imageId),
            value: "denied",
          });
        }
      };
      orderRequest.onerror = () => transaction.abort();
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => undefined;
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted"));
  });
}

function commitImageMetadata(
  database: IDBDatabase,
  userId: string,
  noteId: string,
  imageId: string,
  orderingToken: number,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let stale = false;
    try {
      throwIfAborted(signal);
      transaction = database.transaction(METADATA_STORE, "readwrite");
      guardTransaction(database, transaction);
      const metadata = transaction.objectStore(METADATA_STORE);
      const orderRequest = metadata.get(imageOrderKey(userId, noteId, imageId));
      orderRequest.onsuccess = () => {
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

type FolderDenialMarker = {
  denied: boolean;
  folderId: string | null;
  generation: number;
};

type FolderDenialReceipt = {
  aliases: (string | null)[];
  epoch: string | null;
  generation: number | null;
  committed: boolean;
};

function folderSequenceKey(userId: string): string {
  return `folder-denial-sequence:${encodePathPart(userId)}`;
}

function legacyDeniedFolderKey(userId: string, id: string): string {
  return `${DENIED_FOLDER_PREFIX}${encodePathPart(userId)}:${encodePathPart(id)}`;
}

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

function rootReferenceId(record: MetadataRecord | undefined): string | null {
  try {
    const id: unknown = record ? JSON.parse(record.value) : null;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function readMetadataBatch(
  store: IDBObjectStore,
  keys: string[],
  complete: (records: Map<string, MetadataRecord>) => void,
  fail: (error: unknown) => void,
): void {
  const records = new Map<string, MetadataRecord>();
  let remaining = keys.length;
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

async function captureOfflineFolderReadUnlocked(
  scope: OfflineCacheScope,
): Promise<number | undefined> {
  if (scope.epoch === null) {
    return;
  }
  try {
    const database = await getEpochDatabase();
    if (database) {
      return folderSequence(
        await readMetadataRecord(database, folderSequenceKey(scope.userId)),
      );
    }
  } catch {
    // Unknown ordering cannot authorize a cache write; online display survives.
  }
}

async function assertOfflineFolderReadUnlocked(
  scope: OfflineCacheScope,
  id: string | null,
  orderingToken: number,
): Promise<void> {
  const database = await getEpochDatabase();
  if (!database) {
    throw new Error("Offline folder ordering is unavailable");
  }
  await updateFolderDenial(
    database,
    scope.userId,
    id,
    orderingToken,
    "check",
    undefined,
    undefined,
    scope,
  );
  if (!isOfflineCacheUserClearLifetimeCurrent(scope.userId, scope.lifetime)) {
    throw invalidatedError();
  }
}

export function captureOfflineFolderRead(
  scope: OfflineCacheScope,
): Promise<number | undefined> {
  return userStorageLock(scope.userId, "shared", () =>
    captureOfflineFolderReadUnlocked(scope),
  );
}

export function assertOfflineFolderRead(
  scope: OfflineCacheScope,
  id: string | null,
  orderingToken: number,
): Promise<void> {
  return userStorageLock(scope.userId, "shared", () =>
    assertOfflineFolderReadUnlocked(scope, id, orderingToken),
  );
}

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

function commitFolderDenial(
  database: IDBDatabase,
  userId: string,
  id: string | null,
  orderingToken: number | undefined,
  signal: AbortSignal | undefined,
  scope: OfflineCacheScope,
): Promise<FolderDenialReceipt> {
  return updateFolderDenial(
    database,
    userId,
    id,
    orderingToken,
    "deny",
    undefined,
    signal,
    scope,
  );
}

function reportCommittedFolderDenial(
  userId: string,
  id: string | null,
  receipt: FolderDenialReceipt,
): void {
  if (receipt.committed) {
    reportOfflineFolderDenial(
      userId,
      id,
      receipt.epoch,
      receipt.generation,
      receipt.aliases,
    );
  }
}

function throwFolderDenialFailure(
  error: unknown,
  userId: string,
  id: string | null,
  lifetime: number,
  signal: AbortSignal | undefined,
  scope: OfflineCacheScope,
): never {
  if (signal?.aborted) {
    throw signal.reason;
  }
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    isUserSuspended(userId) ||
    currentUserLifetime(userId) !== lifetime
  ) {
    throw error instanceof DOMException ? error : invalidatedError();
  }
  suspendOfflineCacheUser(userId);
  reportOfflineFolderDenial(userId, id, scope.epoch, null, [id]);
  throw error;
}

function applyFolderOperation(
  transaction: IDBTransaction,
  operation: FolderOperation,
  sequence: number,
  ids: (string | null)[],
  records: Map<string, MetadataRecord>,
  epoch: string | null,
  receipt: { value?: FolderDenialReceipt },
): void {
  const { userId, action, orderingToken, save } = operation;
  const store = transaction.objectStore(METADATA_STORE);
  const current = ids.map((id) => ({
    generation:
      parseFolderDenialMarker(records.get(deniedFolderKey(userId, id)), id)
        ?.generation ?? 1,
    id,
  }));
  const currentGeneration = Math.max(
    ...current.map((marker) => marker.generation),
  );
  receipt.value = {
    aliases: ids,
    committed: false,
    epoch,
    generation: currentGeneration,
  };
  if (
    action === "deny" &&
    orderingToken !== undefined &&
    currentGeneration > orderingToken
  ) {
    return;
  }
  if (action === "check") {
    return;
  }
  if (
    action !== "deny" &&
    (orderingToken === undefined ||
      current.some((marker) => marker.generation > orderingToken))
  ) {
    throw invalidatedError();
  }
  const generation = sequence + 1;
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
    if (marker.id !== null) {
      store.delete(legacyDeniedFolderKey(userId, marker.id));
    }
  }
  receipt.value = {
    aliases: ids,
    committed: true,
    epoch,
    generation,
  };
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
    [rootKey, sequenceKey, epochKey(operation.userId)],
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
            // A cache scope uses "0" until the first purge establishes an
            // epoch. Keep that opaque default in the receipt as well; null
            // means that the transaction failed and is reserved for failure
            // notifications.
            initial.get(epochKey(operation.userId))?.value ?? "0",
            receipt,
          ),
        fail,
      );
    },
    fail,
  );
}

// One metadata transaction orders root aliases, denial, revalidation and writes.
function updateFolderDenial(
  database: IDBDatabase,
  userId: string,
  folderId: string | null,
  orderingToken: number | undefined,
  action: "deny" | "clear" | "check",
  save?: { record: FolderRecord; asDriveRoot: boolean },
  signal?: AbortSignal,
  scope?: OfflineCacheScope,
): Promise<FolderDenialReceipt> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let failure: unknown;
    const receipt: { value?: FolderDenialReceipt } = {};
    try {
      transaction = database.transaction(
        [METADATA_STORE, FOLDER_STORE],
        "readwrite",
      );
      guardTransaction(database, transaction, scope);
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
    const operations =
      pendingUserOperations.get(userId) ?? new Set<() => void>();
    pendingUserOperations.set(userId, operations);
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // Transaction completion is authoritative if it already committed.
      }
    };
    const unregister = () => {
      operations.delete(abort);
      signal?.removeEventListener("abort", abort);
    };
    operations.add(abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    transaction.oncomplete = () => {
      unregister();
      resolve(
        receipt.value ?? {
          aliases: [folderId],
          committed: false,
          epoch: scope?.epoch ?? null,
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

type FolderDenialSnapshot = {
  deniedFolderIds: Set<string | null>;
  sequence: number;
};

function readFolderDenialSnapshot(
  database: IDBDatabase,
  userId: string,
): Promise<FolderDenialSnapshot> {
  const suffix = `${encodePathPart(userId)}:`;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    const store = transaction.objectStore(METADATA_STORE);
    const legacyRequest = store.getAll(
      IDBKeyRange.bound(
        `${DENIED_FOLDER_PREFIX}${suffix}`,
        `${DENIED_FOLDER_PREFIX}${suffix}\uffff`,
      ),
    );
    const currentRequest = store.getAll(
      IDBKeyRange.bound(
        `${FOLDER_STATE_PREFIX}${suffix}`,
        `${FOLDER_STATE_PREFIX}${suffix}\uffff`,
      ),
    );
    const sequenceRequest = store.get(folderSequenceKey(userId));
    transaction.oncomplete = () => {
      try {
        resolve(
          parseFolderDenialSnapshot(
            legacyRequest.result as MetadataRecord[],
            currentRequest.result as MetadataRecord[],
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
  legacyRecords: MetadataRecord[],
  currentRecords: MetadataRecord[],
  sequenceRecord: MetadataRecord | undefined,
): FolderDenialSnapshot {
  const deniedFolderIds = new Set<string | null>(
    legacyRecords.map((record) => record.value),
  );
  for (const record of currentRecords) {
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

/** Null means the durable folder authority could not be inspected. */
async function readOfflineFolderDenialUnlocked(
  event: FolderDenialEvent,
): Promise<boolean | null> {
  try {
    const database = await getEpochDatabase();
    if (!database) {
      return null;
    }
    return await new Promise<boolean | null>((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readonly");
      const store = transaction.objectStore(METADATA_STORE);
      const aliases = [...new Set(event.resource.aliases)];
      const requests = aliases.map((alias) => ({
        alias,
        request: store.get(deniedFolderKey(event.userId, alias)),
      }));
      const globalEpochRequest = store.get(DEVICE_EPOCH_METADATA_KEY);
      const epochRequest = store.get(epochKey(event.userId));
      const stateRequest = store.get(DEVICE_CLEAR_STATE_METADATA_KEY);
      transaction.oncomplete = () => {
        const globalEpoch =
          (globalEpochRequest.result as MetadataRecord | undefined)?.value ??
          "0";
        const userEpoch =
          (epochRequest.result as MetadataRecord | undefined)?.value ?? "0";
        const state =
          (stateRequest.result as MetadataRecord | undefined)?.value ??
          DEVICE_CLEAR_ACTIVE;
        if (isInvalidActiveEpochFence(globalEpoch, userEpoch, state)) {
          resolve(null);
          return;
        }
        const epoch = composeEpoch(globalEpoch, userEpoch);
        if (event.resource.epoch !== null && epoch !== event.resource.epoch) {
          resolve(false);
          return;
        }
        const parsed = requests.map(({ alias, request }) => ({
          marker: parseFolderDenialMarker(
            request.result as MetadataRecord | undefined,
            alias,
          ),
          present: request.result !== undefined,
        }));
        if (parsed.some(({ marker, present }) => present && marker === null)) {
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
  } catch {
    return null;
  }
}

export function readOfflineFolderDenial(
  event: FolderDenialEvent,
): Promise<boolean | null> {
  return userStorageLock(event.userId, "shared", () =>
    readOfflineFolderDenialUnlocked(event),
  );
}

function projectDeniedFolder(
  folder: FolderAccess,
  deniedFolderIds: Set<string | null>,
): FolderAccess | null {
  if (folder.id !== null && deniedFolderIds.has(folder.id)) {
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
      guardTransaction(database, transaction);
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

async function persistCachedViewerIdUnlocked(
  viewerId: string,
  scope: OfflineCacheScope,
  clearLifetime: number,
  options: CancellationOptions = {},
): Promise<void> {
  const { signal } = options;
  if (!(viewerId && "indexedDB" in globalThis)) {
    throw new Error("Viewer identity storage is unavailable");
  }
  if (scope.epoch === null) {
    throw new Error("Viewer identity storage is unavailable");
  }
  const database = await openDatabase(signal);
  databaseScopes.set(database, scope);
  try {
    if (
      userClearOperations.has(viewerId) ||
      globalSuspended ||
      isUserSuspended(viewerId) ||
      !isOfflineCacheUserClearLifetimeCurrent(viewerId, clearLifetime)
    ) {
      throw new Error("Offline cache is suspended");
    }
    await assertOfflineCacheScopeUnlocked(scope, true);
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
    const event: OfflineCacheLifecycleEvent = {
      type: "identity",
      userId: viewerId,
    };
    notifyLifecycle(event);
    lifecycleChannel?.postMessage(event);
  } finally {
    database.close();
  }
}

async function readCachedViewerIdUnlocked(
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

export function persistCachedViewerId(
  viewerId: string,
  options: CancellationOptions = {},
): Promise<void> {
  return userStorageLock(viewerId, "shared", async () => {
    const clearLifetime = captureOfflineCacheUserClearLifetime(viewerId);
    const scope = await captureOfflineCacheScopeUnlocked(viewerId);
    if (scope.epoch === null) {
      throw new Error("Viewer identity storage is unavailable");
    }
    return { clearLifetime, scope };
  }).then(({ clearLifetime, scope }) =>
    persistCachedViewerIdUnlocked(viewerId, scope, clearLifetime, options),
  );
}

export function readCachedViewerId(
  options: CancellationOptions = {},
): Promise<string | null> {
  return globalSharedStorageLock(() => readCachedViewerIdUnlocked(options));
}

function cacheLifetimeCurrent(userId: string, lifetime: number): boolean {
  return !isUserSuspended(userId) && currentUserLifetime(userId) === lifetime;
}

async function readVisibleNoteList(
  database: IDBDatabase,
  userId: string,
  lifetime: number,
  record: NoteListRecord,
): Promise<{ notes: NoteSummary[]; cachedAt: number } | null> {
  const generations = new Map(
    record.notes.map((note) => [
      note.id,
      currentNoteGeneration(userId, note.id),
    ]),
  );
  const folderSnapshot = await readFolderDenialSnapshot(database, userId);
  const { deniedFolderIds } = folderSnapshot;
  if (!cacheLifetimeCurrent(userId, lifetime)) {
    return null;
  }
  const notes: NoteSummary[] = [];
  for (const note of record.notes) {
    const denied =
      deniedFolderIds.has(note.folderId) ||
      (await readDeniedNote(database, userId, note.id));
    if (denied) {
      continue;
    }
    if (
      !cacheLifetimeCurrent(userId, lifetime) ||
      currentNoteGeneration(userId, note.id) !== generations.get(note.id)
    ) {
      return null;
    }
    notes.push(note);
  }
  if (
    !cacheLifetimeCurrent(userId, lifetime) ||
    requiredFolderSequence(
      await readMetadataRecord(database, folderSequenceKey(userId)),
    ) !== folderSnapshot.sequence ||
    record.notes.some(
      (note) =>
        currentNoteGeneration(userId, note.id) !== generations.get(note.id),
    )
  ) {
    return null;
  }
  return { cachedAt: record.cachedAt, notes };
}

function readNoteListState(
  userId: string,
  lifetime: number,
  record: NoteListRecord | undefined,
): "available" | "denied" | "missing" {
  if (!record) {
    return "missing";
  }
  if (!cacheLifetimeCurrent(userId, lifetime)) {
    return "denied";
  }
  // Individual denials are projected by getNoteList. They do not make the
  // list itself unavailable; only an invalid lifetime denies it.
  return "available";
}

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

function writeNoteAuthorityMarkers(
  metadata: IDBObjectStore,
  userId: string,
  identities: readonly string[],
  records: Map<string, MetadataRecord>,
  denialGeneration: number | undefined,
  authorityGeneration: number | undefined,
): void {
  for (const identity of identities) {
    const previous = parseNoteAuthority(
      records.get(deniedNoteKey(userId, identity)),
    );
    if (
      denialGeneration === undefined &&
      (authorityGeneration === undefined ||
        (previous?.generation ?? 0) > authorityGeneration)
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
  orderingToken?: number,
  authorityGeneration?: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readwrite");
      guardTransaction(database, transaction);
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
          currentNoteGeneration(userId, id) !== orderingToken
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
          authorityGeneration,
        );
      },
      (error) => {
        failure = error;
        transaction.abort();
      },
    );
    const operations =
      pendingUserOperations.get(userId) ?? new Set<() => void>();
    pendingUserOperations.set(userId, operations);
    const abort = () => transaction.abort();
    operations.add(abort);
    transaction.oncomplete = () => {
      operations.delete(abort);
      resolve(committedGeneration);
    };
    transaction.onabort = () => {
      operations.delete(abort);
      reject(failure ?? transaction.error ?? invalidatedError());
    };
  });
}

async function openOfflineCacheUnlocked(
  options: OpenOfflineCacheOptions & CancellationOptions,
): Promise<OfflineCache> {
  if (!options.userId) {
    throw new Error("A user ID is required");
  }
  if (!("indexedDB" in globalThis && navigator.storage?.getDirectory)) {
    throw new Error("Offline cache storage is unavailable");
  }

  const userId = options.userId;
  const clearLifetime = captureOfflineCacheUserClearLifetime(userId);
  const database = await openDatabase(options.signal);
  let scope: OfflineCacheScope;
  try {
    const epochs = await readScopeEpochs(database, userId);
    const epoch = composeEpoch(epochs.global, epochs.user);
    throwIfAborted(options.signal);
    scope = { epoch, lifetime: clearLifetime, userId };
    if (
      isPurgingEpoch(epoch) ||
      epochs.state === DEVICE_CLEAR_PURGING ||
      globalSuspended ||
      userClearOperations.has(userId) ||
      !isOfflineCacheUserClearLifetimeCurrent(userId, clearLifetime) ||
      (options.scope &&
        (options.scope.userId !== userId ||
          options.scope.epoch !== epoch ||
          !isOfflineCacheUserClearLifetimeCurrent(
            userId,
            options.scope.lifetime,
          )))
    ) {
      throw invalidatedError();
    }
    databaseScopes.set(database, scope);
  } catch (error) {
    database.close();
    throwIfAborted(options.signal);
    throw error;
  }
  let closed = false;

  const cache: OfflineCache = {
    async beginFolderRead() {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      return folderSequence(
        await readMetadataRecord(database, folderSequenceKey(userId)),
      );
    },
    async beginImageRead(noteId, imageId) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const order = await changeImageOrder(
        database,
        userId,
        noteId,
        imageId,
        undefined,
        false,
      );
      if (order === null) {
        throw invalidatedError();
      }
      return order;
    },
    beginNoteRead(id) {
      return currentNoteGeneration(userId, id);
    },
    async clearFolderDenial(id, orderingToken) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      await updateFolderDenial(database, userId, id, orderingToken, "clear");
    },
    async clearNoteDenial(id, orderingToken, authorityGeneration) {
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
      await updateNoteAuthority(
        database,
        userId,
        id,
        "clear",
        orderingToken,
        authorityGeneration,
      );
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },

    async denyFolder(id, orderingToken, signal) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      assertUserActive(userId, lifetime);
      if (signal?.aborted) {
        throw signal.reason;
      }
      try {
        const receipt = await commitFolderDenial(
          database,
          userId,
          id,
          orderingToken,
          signal,
          scope,
        );
        assertUserActive(userId, lifetime);
        if (signal?.aborted) {
          throw signal.reason;
        }
        reportCommittedFolderDenial(userId, id, receipt);
        return receipt.committed;
      } catch (error) {
        throwFolderDenialFailure(error, userId, id, lifetime, signal, scope);
      }
    },

    async denyImage(noteId, imageId, orderingToken) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const order = await changeImageOrder(
        database,
        userId,
        noteId,
        imageId,
        orderingToken,
        true,
      );
      if (order === null) {
        return;
      }
      const event = {
        resource: { imageId, noteId, type: "image" as const },
        type: "invalidate" as const,
        userId,
      };
      notifyLifecycle(event);
      lifecycleChannel?.postMessage(event);
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: identity discovery, durable fencing, and cleanup have distinct failure boundaries.
    async denyNote(id, orderingToken) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      if (suspendedUsers.has(userId)) {
        throw new Error("Offline cache is suspended");
      }
      const denialToken = orderingToken ?? enterOfflineNoteDenial(userId, id);
      if (denialToken !== currentNoteGeneration(userId, id)) {
        return;
      }
      try {
        const record = await readNoteForRoute(database, userId, id);
        if (record) {
          bindNoteIdentity(userId, record.noteId, record.note.shortId);
        } else {
          const list = await readNoteListRecord(database, noteListKey(userId));
          const note = list?.notes.find(
            (item) => item.id === id || item.shortId === id,
          );
          if (note) {
            bindNoteIdentity(userId, note.id, note.shortId);
          }
        }
        if (denialToken !== currentNoteGeneration(userId, id)) {
          return;
        }
        const generation = await updateNoteAuthority(
          database,
          userId,
          id,
          "deny",
          denialToken,
        );
        reportOfflineNoteDenial(userId, id, scope.epoch, generation);
      } catch (error) {
        suspendOfflineCacheUser(userId);
        reportOfflineNoteDenial(userId, id, scope.epoch, null);
        throw error;
      }
      try {
        const canonical = noteIdentityIds(userId, id)[0] ?? id;
        const fileName = await removeCachedNote(database, userId, canonical);
        if (fileName) {
          await removeUnreferencedNoteFile(userId, canonical, fileName);
        }
      } catch {
        // The durable denial remains authoritative; cleanup is retryable.
      }
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit cache lifetime and denial fences
    async getFolder(id) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      if (isUserSuspended(userId)) {
        return null;
      }
      const record = await readFolderForRoute(database, userId, id);
      if (isUserSuspended(userId) || currentUserLifetime(userId) !== lifetime) {
        return null;
      }
      const deniedFolderIds = await readDeniedFolderIds(database, userId);
      if (isUserSuspended(userId) || currentUserLifetime(userId) !== lifetime) {
        return null;
      }
      if (!record) {
        return null;
      }
      if (
        deniedFolderIds.has(record.folderId) ||
        (id === null && deniedFolderIds.has(null))
      ) {
        return null;
      }
      const folder = projectDeniedFolder(record.folder, deniedFolderIds);
      return folder ? { cachedAt: record.cachedAt, folder } : null;
    },

    async getFolderState(id) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      if (isUserSuspended(userId)) {
        return "denied";
      }
      const record = await readFolderForRoute(database, userId, id);
      if (isUserSuspended(userId) || currentUserLifetime(userId) !== lifetime) {
        return "denied";
      }
      if (!record) {
        return "missing";
      }
      const denied = await readDeniedFolderIds(database, userId);
      if (denied.has(record.folderId) || (id === null && denied.has(null))) {
        return "denied";
      }
      return "available";
    },

    async getImage(noteId, imageId) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      const generation = currentNoteGeneration(userId, noteId);
      if (
        isUserSuspended(userId) ||
        (await readDeniedNote(database, userId, noteId))
      ) {
        return null;
      }
      const record = await readMetadataRecord(
        database,
        imageMetadataKey(userId, noteId, imageId),
      );
      if (!record || record.value === "denied") {
        return null;
      }
      try {
        const image = JSON.parse(record.value) as ImageRecord;
        if (!isSupportedCachedImageMime(image.mime)) {
          return null;
        }
        const file = await noteFile(userId, noteId, image.fileName);
        const bytes = await file.getFile();
        const denied = await readDeniedNote(database, userId, noteId);
        const current = await readMetadataRecord(
          database,
          imageMetadataKey(userId, noteId, imageId),
        );
        if (
          current?.value !== record.value ||
          denied ||
          generation !== currentNoteGeneration(userId, noteId)
        ) {
          return null;
        }
        assertUserActive(userId, lifetime);
        return bytes.slice(0, bytes.size, image.mime);
      } catch {
        return null;
      }
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
      const record = await readNoteForRoute(database, userId, id);
      if (
        !record ||
        isUserSuspended(userId) ||
        currentUserLifetime(userId) !== lifetime
      ) {
        return null;
      }
      const canonicalGeneration = currentNoteGeneration(userId, record.noteId);
      if (await readDeniedNote(database, userId, record.noteId)) {
        return null;
      }

      try {
        const file = await noteFile(userId, record.noteId, record.fileName);
        const markdown = await (await file.getFile()).text();
        // Both route and canonical denials remain authoritative after OPFS awaits.
        if (
          (await readDeniedNote(database, userId, id)) ||
          (id !== record.noteId &&
            (await readDeniedNote(database, userId, record.noteId)))
        ) {
          return null;
        }
        if (
          isUserSuspended(userId) ||
          currentUserLifetime(userId) !== lifetime ||
          currentNoteGeneration(userId, id) !== generation ||
          currentNoteGeneration(userId, record.noteId) !== canonicalGeneration
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
      return readVisibleNoteList(database, userId, lifetime, record);
    },

    async getNoteListState() {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      const lifetime = currentUserLifetime(userId);
      if (isUserSuspended(userId)) {
        return "denied";
      }
      const record = await readNoteListRecord(database, noteListKey(userId));
      return readNoteListState(userId, lifetime, record);
    },

    async putFolder(folder, options = {}) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      throwIfAborted(options.signal);
      const lifetime = currentUserLifetime(userId);
      assertUserActive(userId, lifetime);
      const cachedAt = Date.now();
      const record: FolderRecord = {
        cachedAt,
        folder,
        folderId: folder.id,
        key: folderKey(userId, folder.id),
        userId,
      };
      if (options.orderingToken !== undefined) {
        await updateFolderDenial(
          database,
          userId,
          options.asDriveRoot ? null : folder.id,
          options.orderingToken,
          "clear",
          { asDriveRoot: options.asDriveRoot === true, record },
          options.signal,
        );
        return;
      }
      if (options.asDriveRoot) {
        await commitStoreRecords(
          database,
          [
            { record, storeName: FOLDER_STORE },
            {
              record: {
                key: driveRootMetadataKey(userId),
                value: JSON.stringify(folder.id),
              },
              storeName: METADATA_STORE,
            },
          ],
          userId,
          options.signal,
        );
      } else {
        await commitFolderRecord(database, record, userId, options.signal);
      }
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: image replacement has separate lifetime, order, file, and metadata fences.
    async putImage(noteId, imageId, bytes, options = {}) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      if (!isSupportedCachedImageMime(bytes.type)) {
        throw new Error("Unsupported image MIME");
      }
      const lifetime = currentUserLifetime(userId);
      const generation = currentNoteGeneration(userId, noteId);
      const orderingToken =
        options.orderingToken ??
        (await changeImageOrder(
          database,
          userId,
          noteId,
          imageId,
          undefined,
          false,
        ));
      if (orderingToken === null) {
        throw invalidatedError();
      }
      const assertCurrent = () => {
        throwIfAborted(options.signal);
        assertUserActive(userId, lifetime);
        if (generation !== currentNoteGeneration(userId, noteId)) {
          throw invalidatedError();
        }
      };
      assertCurrent();
      if (await readDeniedNote(database, userId, noteId)) {
        throw invalidatedError();
      }
      let finishWrite!: () => void;
      const terminal = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      const writes = pendingUserWrites.get(userId) ?? new Set<Promise<void>>();
      pendingUserWrites.set(userId, writes);
      writes.add(terminal);
      try {
        // New immutable file first, then an atomic reference swap in the existing
        // v4 metadata store. A failed replacement never damages the prior image.
        const fileName = await writeNoteFileContents(
          userId,
          noteId,
          bytes,
          options.signal,
          assertCurrent,
        );
        try {
          assertCurrent();
          if (await readDeniedNote(database, userId, noteId)) {
            throw invalidatedError();
          }
          assertCurrent();
          await commitImageMetadata(
            database,
            userId,
            noteId,
            imageId,
            orderingToken,
            JSON.stringify({
              fileName,
              mime: bytes.type,
            } satisfies ImageRecord),
            options.signal,
          );
        } catch (error) {
          await removeUnreferencedNoteFile(userId, noteId, fileName);
          throw error;
        }
      } finally {
        writes.delete(terminal);
        if (!writes.size) {
          pendingUserWrites.delete(userId);
        }
        finishWrite();
      }
    },

    async putNote(note, options = {}) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      throwIfAborted(options.signal);
      const lifetime = currentUserLifetime(userId);
      assertUserActive(userId, lifetime);
      const orderingToken = options.orderingToken;
      if (!bindNoteIdentity(userId, note.id, note.shortId, orderingToken)) {
        throw invalidatedError();
      }
      // Register before the first path await and settle only after metadata and
      // cleanup reach their terminal outcome. Purge waits even for failed writes.
      let finishWrite!: () => void;
      const terminal = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      const writes = pendingUserWrites.get(userId) ?? new Set<Promise<void>>();
      pendingUserWrites.set(userId, writes);
      writes.add(terminal);
      try {
        const fileName = await writeNoteFileContents(
          userId,
          note.id,
          note.markdown,
          options.signal,
          () => {
            throwIfAborted(options.signal);
            assertUserActive(userId, lifetime);
          },
        );
        const { markdown: _markdown, ...metadata } = note;
        try {
          assertUserActive(userId, lifetime);
          if (
            orderingToken !== undefined &&
            orderingToken !== currentNoteGeneration(userId, note.id)
          ) {
            throw invalidatedError();
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
            options.authorityGeneration,
          );
        } catch (error) {
          await removeUnreferencedNoteFile(userId, note.id, fileName);
          throw error;
        }
      } finally {
        writes.delete(terminal);
        if (!writes.size) {
          pendingUserWrites.delete(userId);
        }
        finishWrite();
      }
    },

    async putNoteList(notes, options = {}) {
      if (closed) {
        throw new Error("Offline cache is closed");
      }
      throwIfAborted(options.signal);
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
        options.signal,
      );
    },
  };
  // Locks cover actual local storage work only, never a handle's lifetime or HTTP.
  // The post-lock durable check rejects queued work from an expired handle even
  // when its tab missed every lifecycle message.
  for (const name of [
    "beginFolderRead",
    "putImage",
    "getImage",
    "denyImage",
    "putNote",
    "putFolder",
    "putNoteList",
    "denyNote",
    "denyFolder",
    "clearNoteDenial",
    "clearFolderDenial",
    "getFolder",
    "getNoteList",
    "getNoteListState",
  ] as const) {
    const operation = cache[name].bind(cache) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    Object.assign(cache, {
      [name]: (...args: unknown[]) =>
        userStorageLock(userId, "shared", async () => {
          await assertOfflineCacheScopeUnlocked(scope, true);
          const result = await operation(...args);
          await assertOfflineCacheScopeUnlocked(scope, true);
          return result;
        }),
    });
  }
  const readCachedNote = cache.getNote.bind(cache);
  cache.getNote = (id) =>
    userStorageLock(userId, "shared", async () => {
      await assertOfflineCacheScopeUnlocked(scope, true);
      const authority = await captureOfflineNoteAuthorityUnlocked(userId, id);
      const snapshot = await readCachedNote(id);
      await assertOfflineCacheScopeUnlocked(scope, true);
      if (!snapshot) {
        return null;
      }
      try {
        await assertOfflineNoteAuthorityUnlocked(
          authority,
          userId,
          [id, snapshot.note.id],
          scope,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return null;
        }
        throw error;
      }
      return isUserSuspended(userId) ? null : snapshot;
    });
  const trackedClose = () => cache.close();
  const caches = openUserCaches.get(userId) ?? new Set<() => void>();
  openUserCaches.set(userId, caches);
  caches.add(trackedClose);
  const originalClose = cache.close;
  cache.close = () => {
    originalClose();
    caches.delete(trackedClose);
    if (!caches.size) {
      openUserCaches.delete(userId);
    }
  };
  return cache;
}

export function openOfflineCache(
  options: OpenOfflineCacheOptions & CancellationOptions,
): Promise<OfflineCache> {
  if (!options.userId) {
    return Promise.reject(new Error("A user ID is required"));
  }
  if (
    userClearOperations.has(options.userId) ||
    isUserSuspended(options.userId) ||
    globalSuspended
  ) {
    return Promise.reject(invalidatedError());
  }
  return userStorageLock(options.userId, "shared", () =>
    openOfflineCacheUnlocked(options),
  );
}
