import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FolderAccess, Note, NoteSummary } from "@miyulabmd/shared";

// ---------------------------------------------------------------------------
// Minimal IndexedDB + OPFS harness.
// Node 24 provides real navigator.locks/DOMException/crypto, so purge
// arbitration is exercised for real; only storage backends are faked.
// ---------------------------------------------------------------------------

type StoreData = Map<string, unknown>;

class FakeIDBRequest {
  error: DOMException | null = null;
  onerror: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null = null;
  result: unknown;
}

class FakeCursor {
  private readonly request: FakeIDBRequest;
  private readonly transaction: FakeTransaction;
  private readonly data: StoreData;
  private readonly keys: string[];
  private readonly index: number;

  constructor(
    request: FakeIDBRequest,
    transaction: FakeTransaction,
    data: StoreData,
    keys: string[],
    index: number,
  ) {
    this.request = request;
    this.transaction = transaction;
    this.data = data;
    this.keys = keys;
    this.index = index;
  }

  get key(): string {
    return this.keys[this.index] as string;
  }

  get value(): unknown {
    return structuredClone(this.data.get(this.keys[this.index] as string));
  }

  continue(): void {
    const nextIndex = this.index + 1;
    this.transaction.schedule(() => {
      this.request.result =
        nextIndex < this.keys.length
          ? new FakeCursor(
              this.request,
              this.transaction,
              this.data,
              this.keys,
              nextIndex,
            )
          : null;
      this.request.onsuccess?.();
    });
  }

  delete(): void {
    this.data.delete(this.keys[this.index] as string);
  }
}

type KeyRange = { lower: string; upper: string };

function inRange(key: string, range?: KeyRange): boolean {
  return !range || (key >= range.lower && key <= range.upper);
}

class FakeObjectStore {
  private readonly transaction: FakeTransaction;
  readonly name: string;
  private readonly data: StoreData;

  constructor(transaction: FakeTransaction, name: string, data: StoreData) {
    this.transaction = transaction;
    this.name = name;
    this.data = data;
  }

  get(key: string): FakeIDBRequest {
    const request = new FakeIDBRequest();
    this.transaction.schedule(() => {
      request.result = structuredClone(this.data.get(key));
      request.onsuccess?.();
    });
    return request;
  }

  getAll(range?: KeyRange): FakeIDBRequest {
    const request = new FakeIDBRequest();
    this.transaction.schedule(() => {
      request.result = [...this.data.keys()]
        .filter((key) => inRange(key, range))
        .sort()
        .map((key) => structuredClone(this.data.get(key)));
      request.onsuccess?.();
    });
    return request;
  }

  put(record: { key: string }): FakeIDBRequest {
    const request = new FakeIDBRequest();
    this.transaction.schedule(() => {
      this.data.set(record.key, structuredClone(record));
      request.onsuccess?.();
    });
    return request;
  }

  delete(key: string): FakeIDBRequest {
    const request = new FakeIDBRequest();
    this.transaction.schedule(() => {
      this.data.delete(key);
      request.onsuccess?.();
    });
    return request;
  }

  clear(): FakeIDBRequest {
    const request = new FakeIDBRequest();
    this.transaction.schedule(() => {
      this.data.clear();
      request.onsuccess?.();
    });
    return request;
  }

  openCursor(range?: KeyRange): FakeIDBRequest {
    const request = new FakeIDBRequest();
    const keys = [...this.data.keys()]
      .filter((key) => inRange(key, range))
      .sort();
    this.transaction.schedule(() => {
      request.result = keys.length
        ? new FakeCursor(request, this.transaction, this.data, keys, 0)
        : null;
      request.onsuccess?.();
    });
    return request;
  }
}

class FakeTransaction {
  private readonly snapshots = new Map<string, StoreData>();
  private pending = 0;
  private settled = false;
  private aborted = false;
  private readonly backend: FakeBackend;
  readonly mode: string;
  error: DOMException | null = null;
  onabort: (() => void) | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(backend: FakeBackend, storeNames: string[], mode: string) {
    this.backend = backend;
    this.mode = mode;
    for (const name of storeNames) {
      const store = this.backend.stores.get(name);
      if (!store) {
        throw new DOMException(
          `Object store ${name} not found`,
          "NotFoundError",
        );
      }
      this.snapshots.set(name, new Map(store));
    }
    // An empty transaction commits on the next turn.
    queueMicrotask(() => this.check());
  }

  objectStore(name: string): FakeObjectStore {
    const data = this.snapshots.get(name);
    if (!data) {
      throw new DOMException(`Object store ${name} not found`, "NotFoundError");
    }
    return new FakeObjectStore(this, name, data);
  }

  schedule(run: () => void): void {
    this.pending += 1;
    queueMicrotask(() => {
      try {
        if (!(this.aborted || this.settled)) {
          run();
        }
      } catch (error) {
        this.abort(
          error instanceof DOMException
            ? error
            : new DOMException("Request failed", "UnknownError"),
        );
      }
      this.pending -= 1;
      this.check();
    });
  }

  abort(error?: DOMException): void {
    if (this.settled) {
      return;
    }
    this.aborted = true;
    this.error = error ?? new DOMException("Transaction aborted", "AbortError");
    this.onerror?.();
    this.check();
  }

  private check(): void {
    if (this.settled || this.pending > 0) {
      return;
    }
    this.settled = true;
    if (this.aborted) {
      queueMicrotask(() => this.onabort?.());
      return;
    }
    for (const [name, data] of this.snapshots) {
      this.backend.stores.set(name, data);
    }
    queueMicrotask(() => this.oncomplete?.());
  }
}

/** Backing storage shared by every connection to the same database. */
class FakeBackend {
  readonly stores = new Map<string, StoreData>();
  version = 0;
}

/** One `indexedDB.open()` result — a distinct connection per call. */
class FakeDatabase {
  private readonly backend: FakeBackend;
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;

  constructor(backend: FakeBackend) {
    this.backend = backend;
  }

  get objectStoreNames(): string[] & { contains(name: string): boolean } {
    const names = [...this.backend.stores.keys()];
    return Object.assign(names, {
      contains: (name: string): boolean => this.backend.stores.has(name),
    });
  }

  createObjectStore(name: string): void {
    if (!this.backend.stores.has(name)) {
      this.backend.stores.set(name, new Map());
    }
  }

  deleteObjectStore(name: string): void {
    this.backend.stores.delete(name);
  }

  transaction(
    storeNames: string[] | string,
    mode = "readonly",
  ): FakeTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const transaction = new FakeTransaction(this.backend, names, mode);
    if (idbHarness.abortNextTransaction) {
      idbHarness.abortNextTransaction = false;
      transaction.abort(new DOMException("Injected abort", "AbortError"));
    }
    return transaction;
  }

  close(): void {
    this.onclose?.();
  }
}

const DATABASE_NAME = "miyulabmd-offline-cache";
const DATABASE_VERSION = 5;

const idbHarness = {
  abortNextTransaction: false,
  databases: new Map<string, FakeBackend>(),
  open(name: string, version?: number): FakeIDBRequest {
    const request = new FakeIDBRequest();
    queueMicrotask(() => {
      try {
        let backend = this.databases.get(name);
        const oldVersion = backend?.version ?? 0;
        const targetVersion = version ?? oldVersion ?? 1;
        if (!backend) {
          backend = new FakeBackend();
          this.databases.set(name, backend);
          backend.version = targetVersion;
        }
        const database = new FakeDatabase(backend);
        request.result = database;
        if (targetVersion > oldVersion) {
          backend.version = targetVersion;
          request.onupgradeneeded?.({ oldVersion });
        }
        request.onsuccess?.();
      } catch (error) {
        request.error =
          error instanceof DOMException
            ? error
            : new DOMException("Open failed", "UnknownError");
        request.onerror?.();
      }
    });
    return request;
  },
};

class FakeFileHandle {
  readonly kind = "file";
  content: Blob | null = null;

  getFile(): Promise<Blob> {
    if (!this.content) {
      return Promise.reject(
        new DOMException("File not found", "NotFoundError"),
      );
    }
    return Promise.resolve(this.content);
  }

  createWritable(): Promise<{
    write(data: string | Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    const chunks: (string | Blob)[] = [];
    return Promise.resolve({
      abort: () => Promise.resolve(),
      close: () => {
        this.content =
          chunks.length === 1 && chunks[0] instanceof Blob
            ? chunks[0]
            : new Blob(chunks as BlobPart[]);
        return Promise.resolve();
      },
      write: (data: string | Blob) => {
        chunks.push(data);
        return Promise.resolve();
      },
    });
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory";
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();

  getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectoryHandle) {
      return Promise.resolve(existing);
    }
    if (existing || !options.create) {
      return Promise.reject(
        new DOMException("Directory not found", "NotFoundError"),
      );
    }
    const created = new FakeDirectoryHandle();
    this.children.set(name, created);
    return Promise.resolve(created);
  }

  getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) {
      return Promise.resolve(existing);
    }
    if (existing || !options.create) {
      return Promise.reject(
        new DOMException("File not found", "NotFoundError"),
      );
    }
    const created = new FakeFileHandle();
    this.children.set(name, created);
    return Promise.resolve(created);
  }

  removeEntry(
    name: string,
    _options: { recursive?: boolean } = {},
  ): Promise<void> {
    if (!this.children.delete(name)) {
      return Promise.reject(
        new DOMException("Entry not found", "NotFoundError"),
      );
    }
    return Promise.resolve();
  }

  // biome-ignore lint/suspicious/useAwait: mocks FileSystemDirectoryHandle.entries, which is an async iterator
  async *entries(): AsyncIterableIterator<
    [string, FakeDirectoryHandle | FakeFileHandle]
  > {
    for (const entry of this.children) {
      yield entry;
    }
  }
}

const opfsRoot = new FakeDirectoryHandle();

Object.defineProperty(globalThis, "indexedDB", {
  configurable: true,
  value: {
    open: (name: string, version?: number) => idbHarness.open(name, version),
  },
});
Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: {
    bound: (lower: string, upper: string): KeyRange => ({ lower, upper }),
  },
});
Object.defineProperty(navigator, "storage", {
  configurable: true,
  value: { getDirectory: () => Promise.resolve(opfsRoot) },
});

const {
  captureOfflineNoteDenialSequence,
  clearOfflineCacheUser,
  openOfflineCache,
} = await import("./offline-cache.ts");
const { readCachedDrive } = await import("./cached-drive-reader.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodePathPart(value: string): string {
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

function backendStore(name: string): StoreData {
  const database = idbHarness.databases.get(DATABASE_NAME);
  assert.ok(database, "offline cache database must exist");
  const store = database.stores.get(name);
  assert.ok(store, `store ${name} must exist`);
  return store;
}

function metadataValue(key: string): string | undefined {
  return (backendStore("metadata").get(key) as { value?: string } | undefined)
    ?.value;
}

function writeMetadata(key: string, value: string): void {
  backendStore("metadata").set(key, { key, value });
}

function userLockName(userId: string): string {
  return `miyulabmd-offline-cache:user:${encodePathPart(userId)}`;
}

function userPurgeTombstoneKey(userId: string): string {
  return `purge-tombstone:user:${encodePathPart(userId)}`;
}

const DEVICE_PURGE_TOMBSTONE_KEY = "purge-tombstone:device";

function note(id: string, ownerId: string): Note {
  return {
    access: {
      effectiveReadScope: "self",
      effectiveWriteScope: "self",
      flags: { canAdmin: true, canEdit: true, canView: true },
      grants: [],
      inherit: true,
      readScope: null,
      source: "default",
      sourceFolder: null,
      writeScope: null,
    },
    alias: null,
    articleMeta: {},
    createdAt: 1,
    editLocked: false,
    folder: "",
    folderId: null,
    id,
    markdown: `# ${id}`,
    ownerId,
    permission: "private",
    shortId: `s-${id}`,
    title: id,
    updatedAt: 2,
  };
}

function folder(id: string | null): FolderAccess {
  return {
    children: [],
    crumbs: [],
    effectiveReadScope: "self",
    effectiveWriteScope: "self",
    flags: { canAdmin: true, canEdit: true, canView: true },
    grants: [],
    id,
    inherit: true,
    name: id ?? "root",
    parentId: null,
    readScope: null,
    source: "default",
    sourceFolder: null,
    writeScope: null,
  };
}

function summary(id: string, ownerId: string): NoteSummary {
  const { markdown: _markdown, ...rest } = note(id, ownerId);
  return rest;
}

function opfsUserDirectory(userId: string): FakeDirectoryHandle | undefined {
  const app = opfsRoot.children.get("miyulabmd-offline-cache-v1");
  if (!(app instanceof FakeDirectoryHandle)) {
    return undefined;
  }
  const user = app.children.get(encodePathPart(userId));
  return user instanceof FakeDirectoryHandle ? user : undefined;
}

function resetStores(): void {
  for (const database of idbHarness.databases.values()) {
    database.version = DATABASE_VERSION;
    for (const store of database.stores.values()) {
      store.clear();
    }
  }
  opfsRoot.children.clear();
  idbHarness.abortNextTransaction = false;
}

afterEach(resetStores);

// ---------------------------------------------------------------------------
// v5 wipe migration (ADR 0002)
// ---------------------------------------------------------------------------

test("upgrading a v4 database wipes every record and legacy store", async () => {
  const userId = "user-wipe-1";
  const enc = encodePathPart(userId);
  const backend = new FakeBackend();
  backend.version = 4;
  backend.stores.set(
    "notes",
    new Map([
      [
        `notes:${enc}:note-old`,
        {
          cachedAt: 1,
          fileName: "old.md",
          key: `notes:${enc}:note-old`,
          note: summary("note-old", userId),
          noteId: "note-old",
          userId,
        },
      ],
    ]),
  );
  backend.stores.set(
    "folders",
    new Map([
      [
        `folders:${enc}:`,
        {
          cachedAt: 1,
          folder: folder(null, userId),
          folderId: null,
          key: `folders:${enc}:`,
          userId,
        },
      ],
    ]),
  );
  backend.stores.set(
    "note-lists",
    new Map([
      [
        `notes:${enc}`,
        {
          cachedAt: 1,
          key: `notes:${enc}`,
          notes: [summary("note-old", userId)],
          userId,
        },
      ],
    ]),
  );
  backend.stores.set(
    "metadata",
    new Map([
      [
        `user-epoch:${enc}`,
        { key: `user-epoch:${enc}`, value: "legacy-epoch" },
      ],
      [
        `denied-note:${enc}:note-old`,
        {
          key: `denied-note:${enc}:note-old`,
          value: JSON.stringify({ denied: true, generation: 3 }),
        },
      ],
    ]),
  );
  backend.stores.set("legacy-blobs", new Map([["blob", { key: "blob" }]]));
  idbHarness.databases.set(DATABASE_NAME, backend);

  const cache = await openOfflineCache({ userId });
  assert.equal(cache.degraded, false);
  try {
    assert.equal(await cache.getNoteList(), null);
    assert.equal(await cache.getNote("note-old"), null);
    assert.equal(await cache.getFolder(null), null);
  } finally {
    cache.close();
  }
  assert.deepEqual([...backend.stores.keys()].sort(), [
    "folders",
    "metadata",
    "note-lists",
    "notes",
  ]);
  assert.equal(backend.stores.get("metadata")?.size, 0);
  assert.equal(backend.stores.get("notes")?.size, 0);
  // A wiped cache accepts fresh writes under the v5 layout.
  const fresh = await openOfflineCache({ userId });
  await fresh.putNoteList([summary("note-new", userId)]);
  assert.equal((await fresh.getNoteList())?.notes[0]?.id, "note-new");
  fresh.close();
});

// ---------------------------------------------------------------------------
// Purge tombstone self-healing
// ---------------------------------------------------------------------------

test("openOfflineCache completes an interrupted user purge instead of failing", async () => {
  const userId = "user-heal-1";
  const seeded = await openOfflineCache({ userId });
  await seeded.putNote(note("note-a", userId));
  await seeded.putNoteList([summary("note-a", userId)]);
  await seeded.putFolder(folder(null), { asDriveRoot: true });
  seeded.close();
  assert.ok(opfsUserDirectory(userId), "seeded OPFS data must exist");

  // Simulate a purge that died after writing its durable tombstone.
  writeMetadata(
    userPurgeTombstoneKey(userId),
    JSON.stringify({ kind: "user", startedAt: Date.now() }),
  );

  const cache = await openOfflineCache({ userId });
  assert.equal(cache.degraded, false);
  try {
    // The healed purge finished deleting the scoped data.
    assert.equal(await cache.getNoteList(), null);
    assert.equal(await cache.getFolder(null), null);
  } finally {
    cache.close();
  }
  assert.equal(metadataValue(userPurgeTombstoneKey(userId)), undefined);
  assert.equal(opfsUserDirectory(userId), undefined);
});

test("openOfflineCache completes an interrupted device purge", async () => {
  const userId = "user-heal-2";
  const seeded = await openOfflineCache({ userId });
  await seeded.putNoteList([summary("note-b", userId)]);
  seeded.close();

  writeMetadata(
    DEVICE_PURGE_TOMBSTONE_KEY,
    JSON.stringify({ kind: "device", startedAt: Date.now() }),
  );

  const cache = await openOfflineCache({ userId });
  assert.equal(cache.degraded, false);
  try {
    assert.equal(await cache.getNoteList(), null);
  } finally {
    cache.close();
  }
  assert.equal(metadataValue(DEVICE_PURGE_TOMBSTONE_KEY), undefined);
});

test("openOfflineCache returns a degraded empty cache while a live purge holds the lock", async () => {
  const userId = "user-heal-3";
  const seeded = await openOfflineCache({ userId });
  await seeded.putNoteList([summary("note-c", userId)]);
  seeded.close();
  writeMetadata(
    userPurgeTombstoneKey(userId),
    JSON.stringify({ kind: "user", startedAt: Date.now() }),
  );

  // A live purge in another tab holds the exclusive user lock.
  const release = Promise.withResolvers<void>();
  const held = navigator.locks.request(
    userLockName(userId),
    { mode: "exclusive" },
    () => release.promise,
  );

  const cache = await openOfflineCache({ userId });
  assert.equal(cache.degraded, true);
  // Reads degrade to misses; writes reject instead of blocking or
  // suspending the display.
  assert.equal(await cache.getNoteList(), null);
  assert.equal(await cache.getNote("note-c"), null);
  assert.equal(await cache.getFolderState(null), "missing");
  assert.equal(await cache.getNoteListState(), "missing");
  await assert.rejects(cache.putNoteList([summary("late", userId)]));
  await assert.rejects(cache.putNote(note("late", userId)));
  await assert.rejects(cache.denyFolder(null));
  await assert.rejects(cache.denyNote("note-c"));
  cache.close();

  release.resolve();
  await held;

  // Once the live purge lets go, the next open heals the marker.
  const healed = await openOfflineCache({ userId });
  assert.equal(healed.degraded, false);
  healed.close();
  assert.equal(metadataValue(userPurgeTombstoneKey(userId)), undefined);
});

test("openOfflineCache still honours a caller's own abort", async () => {
  const controller = new AbortController();
  controller.abort(new Error("navigated away"));
  await assert.rejects(
    openOfflineCache({ signal: controller.signal, userId: "user-heal-4" }),
    /navigated away/,
  );
});

// ---------------------------------------------------------------------------
// Display reads degrade to cache miss, never to an invalidation error
// ---------------------------------------------------------------------------

test("readCachedDrive treats an interrupted purge as an empty cache", async () => {
  const userId = "user-failsoft-1";
  const seeded = await openOfflineCache({ userId });
  await seeded.putNoteList([summary("note-d", userId)]);
  await seeded.putFolder(folder(null), { asDriveRoot: true });
  seeded.close();
  writeMetadata(
    userPurgeTombstoneKey(userId),
    JSON.stringify({ kind: "user", startedAt: Date.now() }),
  );

  const view = await readCachedDrive(userId, null);
  assert.equal(view.folderMissing, true);
  assert.equal(view.notesMissing, true);
  assert.deepEqual(view.notes, []);
});

test("readCachedDrive returns cached data on a healthy cache", async () => {
  const userId = "user-failsoft-2";
  const seeded = await openOfflineCache({ userId });
  await seeded.putFolder(folder("folder-1"));
  await seeded.putNoteList([summary("note-e", userId)]);
  seeded.close();

  const view = await readCachedDrive(userId, "folder-1");
  assert.equal(view.folderMissing, false);
  assert.equal(view.folder?.id, "folder-1");
  assert.equal(view.notesMissing, false);
  assert.deepEqual(
    view.notes.map((item) => item.id),
    ["note-e"],
  );
});

test("a failed denial write does not break the user's cached reads", async () => {
  const userId = "user-failsoft-3";
  const seeded = await openOfflineCache({ userId });
  await seeded.putNote(note("note-f", userId));
  await seeded.putNoteList([summary("note-f", userId)]);
  seeded.close();

  const cache = await openOfflineCache({ userId });
  try {
    idbHarness.abortNextTransaction = true;
    await assert.rejects(cache.denyNote("note-f"));
    // The failed denial is a warning, not a suspension: cached data still
    // reads back instead of being hidden.
    const cached = await cache.getNote("note-f");
    assert.equal(cached?.note.id, "note-f");
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// Denial ledger + CAS
// ---------------------------------------------------------------------------

test("denyNote hides the cached note and removes it from the note list", async () => {
  const userId = "user-deny-1";
  const cache = await openOfflineCache({ userId });
  try {
    await cache.putNote(note("note-x", userId));
    await cache.putNoteList([
      summary("note-x", userId),
      summary("note-y", userId),
    ]);
    await cache.denyNote("note-x");

    assert.equal(await cache.getNote("note-x"), null);
    const list = await cache.getNoteList();
    assert.deepEqual(
      list?.notes.map((item) => item.id),
      ["note-y"],
    );
    // The denial is durable: a fresh handle still hides the note.
    const reopened = await openOfflineCache({ userId });
    assert.equal(await reopened.getNote("note-x"), null);
    reopened.close();
  } finally {
    cache.close();
  }
});

test("a stale putNote loses to a committed denial (denial-sequence CAS)", async () => {
  const userId = "user-deny-2";
  const cache = await openOfflineCache({ userId });
  try {
    // Watermark captured before the denial — a slow 200 arriving later.
    const staleSequence = await captureOfflineNoteDenialSequence(userId);
    await cache.denyNote("note-z");

    await assert.rejects(
      cache.putNote(note("note-z", userId), {
        denialSequence: staleSequence ?? undefined,
      }),
    );
    assert.equal(await cache.getNote("note-z"), null);
  } finally {
    cache.close();
  }
});

test("clearNoteDenial with the current sequence restores writability", async () => {
  const userId = "user-deny-3";
  const cache = await openOfflineCache({ userId });
  try {
    await cache.denyNote("note-w");
    const orderingToken = cache.beginNoteRead("note-w");
    const sequence = await captureOfflineNoteDenialSequence(userId);
    assert.notEqual(sequence, null);
    await cache.clearNoteDenial("note-w", orderingToken, sequence as number);
    await cache.putNote(note("note-w", userId), {
      denialSequence: sequence ?? undefined,
      orderingToken,
    });
    assert.equal((await cache.getNote("note-w"))?.note.id, "note-w");
  } finally {
    cache.close();
  }
});

test("denyFolder hides the cached folder and getFolderState reports denied", async () => {
  const userId = "user-deny-4";
  const cache = await openOfflineCache({ userId });
  try {
    const target = folder("folder-a", userId);
    target.crumbs = [{ id: "folder-a", name: "folder-a" }];
    await cache.putFolder(target);
    await cache.denyFolder("folder-a");

    assert.equal(await cache.getFolder("folder-a"), null);
    assert.equal(await cache.getFolderState("folder-a"), "denied");
    // The denial survives across handles.
    const reopened = await openOfflineCache({ userId });
    assert.equal(await reopened.getFolderState("folder-a"), "denied");
    reopened.close();
  } finally {
    cache.close();
  }
});

test("putFolder clears a committed denial only with a fresh read token", async () => {
  const userId = "user-deny-5";
  const cache = await openOfflineCache({ userId });
  try {
    await cache.denyFolder("folder-b");
    assert.equal(await cache.getFolderState("folder-b"), "denied");
    // A tokenless blind save persists the record but leaves the denial.
    await cache.putFolder(folder("folder-b", userId));
    assert.equal(await cache.getFolderState("folder-b"), "denied");
    assert.equal(await cache.getFolder("folder-b"), null);
    // A token captured after the denial proves revalidation and lifts it.
    const orderingToken = await cache.beginFolderRead("folder-b");
    await cache.putFolder(folder("folder-b", userId), { orderingToken });
    assert.equal((await cache.getFolder("folder-b"))?.folder.id, "folder-b");
  } finally {
    cache.close();
  }
});

test("putImage/getImage round-trip and denyImage hides the image", async () => {
  const userId = "user-deny-6";
  const cache = await openOfflineCache({ userId });
  try {
    const bytes = new Blob(["png-bytes"], { type: "image/png" });
    await cache.putImage("note-i", "img-1", bytes);
    const cached = await cache.getImage("note-i", "img-1");
    assert.ok(cached);
    assert.equal(cached?.type, "image/png");

    // A stale token cannot overwrite a committed denial.
    const staleToken = await cache.beginImageRead("note-i", "img-2");
    await cache.denyImage("note-i", "img-2", staleToken);
    await assert.rejects(
      cache.putImage("note-i", "img-2", bytes, {
        orderingToken: staleToken,
      }),
    );
    assert.equal(await cache.getImage("note-i", "img-2"), null);
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// Purge fences
// ---------------------------------------------------------------------------

test("a completed user purge fences a pre-purge handle and leaves the cache empty", async () => {
  const userId = "user-purge-1";
  const cache = await openOfflineCache({ userId });
  await cache.putNote(note("note-p", userId));
  await cache.putNoteList([summary("note-p", userId)]);

  await clearOfflineCacheUser(userId);

  // Same-tab purge bumps the in-memory realm: the old handle stops serving
  // and writing immediately.
  assert.equal(await cache.getNote("note-p"), null);
  assert.equal(await cache.getNoteList(), null);
  await assert.rejects(cache.putNote(note("note-q", userId)));
  cache.close();

  const fresh = await openOfflineCache({ userId });
  try {
    assert.equal(fresh.degraded, false);
    assert.equal(await fresh.getNoteList(), null);
    assert.equal(await fresh.getNote("note-p"), null);
  } finally {
    fresh.close();
  }
  assert.equal(opfsUserDirectory(userId), undefined);
});
