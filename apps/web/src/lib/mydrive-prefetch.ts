import type { FolderRecord, NoteSummary } from "@miyulabmd/shared";
import {
  ApiHttpError,
  fetchFolder,
  fetchFolderTree,
  fetchNote,
  fetchNotes,
} from "./api.ts";
import { ApiCommunicationError, ApiIdentityError } from "./api-transport.ts";
import {
  type AttachedImage,
  AttachedImageCacheError,
  acquireAttachedImage,
  collectAttachedImages,
} from "./attached-images.ts";
import { openOfflineCache } from "./offline-cache.ts";
import {
  createStorageWriteRecovery,
  type StorageWriteRecovery,
} from "./storage-write-recovery.ts";
import type { ViewerContext } from "./viewer-context.ts";

export const PREFETCH_MAX_ATTEMPTS = 2;
export const PREFETCH_RETRY_DELAY_MS = 500;
export const PREFETCH_MAX_CONSECUTIVE_FAILURES = 4;

export type MyDrivePrefetchResult =
  | { status: "success"; folders: number; notes: number }
  | {
      status: "stopped";
      reason: "aborted" | "auth" | "network" | "storage" | "unavailable";
      folders: number;
      notes: number;
    };

type Counts = { folders: number; notes: number };

export type MyDrivePrefetchPriority =
  | { kind: "folder"; id: string }
  | { kind: "note"; id: string }
  | null;

type GetPriority = () => MyDrivePrefetchPriority;

// Select anew between requests, not once at cycle entry. The remaining work
// belongs only to this acquisition; navigation never changes its viewer.
function takeNext<T>(pending: T[], preferred: (item: T) => boolean): T {
  const index = pending.findIndex(preferred);
  return pending.splice(index < 0 ? 0 : index, 1)[0] as T;
}

function takeNextNote(
  targets: NoteSummary[],
  priority: MyDrivePrefetchPriority,
): NoteSummary {
  // Canonical IDs win over short-ID collisions, as in foreground reads.
  const currentNote =
    priority?.kind === "note"
      ? (targets.find((item) => item.id === priority.id) ??
        targets.find((item) => item.shortId === priority.id))
      : undefined;
  return takeNext(targets, (item) =>
    priority?.kind === "folder"
      ? item.folderId === priority.id
      : item === currentNote,
  );
}

function stopped(
  reason: "aborted" | "auth" | "network" | "storage" | "unavailable",
  counts: Counts,
): MyDrivePrefetchResult {
  return { ...counts, reason, status: "stopped" };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error === signal.reason;
}

function throwIfPrefetchAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

type IoBoundary = "network" | "storage";

class PrefetchIoError extends Error {
  constructor(
    readonly boundary: IoBoundary,
    readonly cause: unknown,
  ) {
    super(`Prefetch ${boundary} operation failed`);
  }
}

async function prefetchIo<T>(
  signal: AbortSignal,
  boundary: IoBoundary,
  operation: () => Promise<T> | T,
): Promise<T> {
  throwIfPrefetchAborted(signal);
  try {
    return await operation();
  } catch (error) {
    throw new PrefetchIoError(boundary, error);
  }
}

function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

function folderIds(tree: FolderRecord[]): Set<string> {
  return new Set(tree.map((folder) => folder.id));
}

function rootFolder(tree: FolderRecord[]): FolderRecord | undefined {
  return tree.find((folder) => folder.parentId === null);
}

function stopReason(
  error: unknown,
  signal: AbortSignal,
): "aborted" | "auth" | "network" | "storage" {
  const boundary =
    error instanceof PrefetchIoError ? error.boundary : "network";
  const cause = error instanceof PrefetchIoError ? error.cause : error;
  if (isAbort(cause, signal)) {
    return "aborted";
  }
  if (
    cause instanceof ApiIdentityError ||
    (cause instanceof ApiHttpError && isAuthStatus(cause.status))
  ) {
    return "auth";
  }
  return boundary;
}

type PrefetchCache = Awaited<ReturnType<typeof openOfflineCache>>;

function withStorageRecovery(
  cache: PrefetchCache,
  recovery: StorageWriteRecovery,
  signal: AbortSignal,
): PrefetchCache {
  return {
    ...cache,
    putFolder: (folder, options) =>
      recovery.run(() => cache.putFolder(folder, options), signal),
    putNote: (note, options) =>
      recovery.run(() => cache.putNote(note, options), signal),
    putNoteList: (notes, options) =>
      recovery.run(() => cache.putNoteList(notes, options), signal),
  };
}

function transientStatus(status: unknown): boolean {
  return typeof status === "number" && status >= 500 && status <= 599;
}

function transientError(error: unknown, rawFetchErrors: boolean): boolean {
  return (
    error instanceof ApiCommunicationError ||
    (rawFetchErrors && error instanceof TypeError) ||
    (error instanceof ApiHttpError && transientStatus(error.status))
  );
}

function noteDenied(status: number): boolean {
  return status === 403 || status === 404;
}

function retryDelay(signal: AbortSignal): Promise<void> {
  throwIfPrefetchAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, PREFETCH_RETRY_DELAY_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// One cycle owns the budget. Only communication errors and HTTP 5xx
// are retryable; storage, cancellation, malformed data and denial are not.
class Acquisition {
  consecutiveFailures = 0;
  incomplete = false;

  constructor(readonly signal: AbortSignal) {}

  async run<T>(
    operation: () => Promise<T>,
    { rawFetchErrors = false } = {},
  ): Promise<T | undefined> {
    for (let attempt = 1; attempt <= PREFETCH_MAX_ATTEMPTS; attempt += 1) {
      throwIfPrefetchAborted(this.signal);
      try {
        const result = await operation();
        throwIfPrefetchAborted(this.signal);
        if (
          !(
            result &&
            typeof result === "object" &&
            "ok" in result &&
            result.ok === false &&
            "status" in result &&
            transientStatus(result.status)
          )
        ) {
          this.consecutiveFailures = 0;
          return result;
        }
      } catch (error) {
        if (
          isAbort(error, this.signal) ||
          !transientError(error, rawFetchErrors)
        ) {
          throw new PrefetchIoError("network", error);
        }
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= PREFETCH_MAX_CONSECUTIVE_FAILURES) {
        throw new PrefetchIoError(
          "network",
          new Error("Communication stopped"),
        );
      }
      if (attempt < PREFETCH_MAX_ATTEMPTS) {
        await retryDelay(this.signal);
      }
    }
    this.incomplete = true;
    return undefined;
  }
}

async function acquireFolders(
  cache: PrefetchCache,
  signal: AbortSignal,
  userId: string,
  tree: FolderRecord[],
  counts: Counts,
  acquisition: Acquisition,
  getPriority: GetPriority,
): Promise<"aborted" | "auth" | "network" | "storage" | null> {
  const root = rootFolder(tree);
  if (!root) {
    return "network";
  }
  const ordered = [root, ...tree.filter((folder) => folder.id !== root.id)];
  while (ordered.length) {
    const priority = getPriority();
    const folder = takeNext(
      ordered,
      (item) => priority?.kind === "folder" && item.id === priority.id,
    );
    const orderingToken = await prefetchIo(signal, "storage", () =>
      cache.beginFolderRead(folder.id),
    );
    const folderResult = await acquisition.run(
      () => fetchFolder(folder.id, { signal, viewerId: userId }),
      { rawFetchErrors: true },
    );
    if (!folderResult) {
      continue;
    }
    if (!folderResult.ok) {
      if (folderResult.status === 403 || folderResult.status === 404) {
        await prefetchIo(signal, "storage", () => cache.denyFolder(folder.id));
        continue;
      }
      return folderResult.status === 401 ? "auth" : "network";
    }
    await prefetchIo(signal, "storage", () =>
      cache.putFolder(folderResult.data, {
        asDriveRoot: folder.id === root.id,
        orderingToken,
        signal,
      }),
    );
    counts.folders += 1;
  }
  return null;
}

async function acquireDrive(
  cache: PrefetchCache,
  signal: AbortSignal,
  userId: string,
  counts: Counts,
  storageRecovery: StorageWriteRecovery,
  getPriority: GetPriority = () => null,
): Promise<MyDrivePrefetchResult> {
  const acquisition = new Acquisition(signal);
  const treeResult = await acquisition.run(
    () => fetchFolderTree({ signal, viewerId: userId }),
    { rawFetchErrors: true },
  );
  if (!treeResult) {
    return stopped("network", counts);
  }
  if (!treeResult.ok) {
    return stopped(
      isAuthStatus(treeResult.status) ? "auth" : "network",
      counts,
    );
  }
  const folderStop = await acquireFolders(
    cache,
    signal,
    userId,
    treeResult.data,
    counts,
    acquisition,
    getPriority,
  );
  if (folderStop) {
    return stopped(folderStop, counts);
  }
  const notesStop = await acquireNotes(
    cache,
    signal,
    userId,
    folderIds(treeResult.data),
    counts,
    acquisition,
    storageRecovery,
    getPriority,
  );
  return notesStop || acquisition.incomplete
    ? stopped(notesStop ?? "network", counts)
    : { ...counts, status: "success" };
}

/** 1 ノート分の取得。「auth」は即中断、「cached」は新規保存、null はスキップ。 */
async function acquireOneNote(
  cache: PrefetchCache,
  signal: AbortSignal,
  userId: string,
  summary: NoteSummary,
  acquisition: Acquisition,
  collectImages: (markdown: string) => void,
): Promise<"auth" | "cached" | null> {
  const existing = await prefetchIo(signal, "storage", () =>
    cache.getNote(summary.id),
  );
  if (existing && existing.note.updatedAt >= summary.updatedAt) {
    collectImages(existing.note.markdown);
    return null;
  }
  const orderingToken = await prefetchIo(signal, "storage", () =>
    cache.beginNoteRead(summary.id),
  );
  // The durable denial watermark, captured before the fetch: a denial
  // committing after this point makes the put/clear below lose — a stale
  // 200 must not overwrite a confirmed denial. Read on the prefetch
  // handle's own connection so no extra database churn interrupts the
  // acquisition boundary instrumentation.
  const denialSequence = await prefetchIo(signal, "storage", () =>
    cache.captureNoteDenialSequence(),
  );
  const noteResult = await acquisition.run(() =>
    fetchNote(summary.id, {
      // Reuse the fence this handle captured at open — reading it through
      // a second database connection would churn a close inside the
      // acquisition boundary (and is pure overhead either way).
      purgeFence: cache.capturedPurgeFence(),
      signal,
      viewerId: userId,
    }),
  );
  if (!noteResult) {
    return null;
  }
  if (!noteResult.ok) {
    if (noteResult.status === 401) {
      return "auth";
    }
    if (noteDenied(noteResult.status)) {
      await prefetchIo(signal, "storage", () => cache.denyNote(summary.id));
    }
    return null;
  }
  await prefetchIo(signal, "storage", () =>
    cache.putNote(noteResult.data, {
      denialSequence: denialSequence ?? undefined,
      orderingToken,
      signal,
    }),
  );
  if (denialSequence !== null) {
    await prefetchIo(signal, "storage", () =>
      cache.clearNoteDenial(summary.id, orderingToken, denialSequence),
    );
  }
  collectImages(noteResult.data.markdown);
  return "cached";
}

async function acquireNotes(
  cache: PrefetchCache,
  signal: AbortSignal,
  userId: string,
  ownedFolders: Set<string>,
  counts: Counts,
  acquisition: Acquisition,
  storageRecovery: StorageWriteRecovery,
  getPriority: GetPriority,
): Promise<"aborted" | "auth" | "network" | "storage" | null> {
  const images = new Map<string, AttachedImage>();
  const collectImages = (markdown: string) => {
    for (const image of collectAttachedImages(markdown)) {
      images.set(image.url, image);
    }
  };
  const summaries = await acquisition.run(
    () => fetchNotes({ signal, viewerId: userId }),
    { rawFetchErrors: true },
  );
  if (!summaries) {
    return "network";
  }
  await prefetchIo(signal, "storage", () =>
    cache.putNoteList(summaries, { signal }),
  );
  const targets = summaries.filter(
    (summary: NoteSummary) =>
      summary.ownerId === userId &&
      summary.folderId !== null &&
      ownedFolders.has(summary.folderId),
  );
  while (targets.length) {
    const summary = takeNextNote(targets, getPriority());
    const outcome = await acquireOneNote(
      cache,
      signal,
      userId,
      summary,
      acquisition,
      collectImages,
    );
    if (outcome === "auth") {
      return "auth";
    }
    if (outcome === "cached") {
      counts.notes += 1;
    }
  }
  await acquireImages(images, userId, signal, storageRecovery);
  return null;
}

// Attachments are the final, sequential, lowest-priority stage. In particular
// neither a slow nor a denied image can delay another note's body acquisition.
async function acquireImages(
  images: Map<string, AttachedImage>,
  userId: string,
  signal: AbortSignal,
  storageRecovery: StorageWriteRecovery,
): Promise<void> {
  for (const image of images.values()) {
    throwIfPrefetchAborted(signal);
    try {
      await acquireAttachedImage(image, {
        cacheOnly: false,
        requireCache: true,
        signal,
        storageRecovery,
        userId,
      });
    } catch (error) {
      throwIfPrefetchAborted(signal);
      if (error instanceof AttachedImageCacheError) {
        throw new PrefetchIoError("storage", error.cause);
      }
      // Image storage and permission failures are partial attachment misses.
    }
  }
}

export async function prefetchMyDrive(
  viewer: ViewerContext,
  options: { signal?: AbortSignal; getPriority?: GetPriority } = {},
): Promise<MyDrivePrefetchResult> {
  const ownedViewer: ViewerContext = {
    ...viewer,
    user: viewer.user ? { ...viewer.user } : null,
  };
  const signal = options.signal ?? new AbortController().signal;
  const getPriority = options.getPriority;
  const counts: Counts = { folders: 0, notes: 0 };
  if (signal.aborted) {
    return stopped("aborted", counts);
  }
  if (
    ownedViewer.mode !== "authenticated" ||
    !ownedViewer.user ||
    ownedViewer.cacheViewerId !== ownedViewer.user.id
  ) {
    return stopped("unavailable", counts);
  }

  const userId = ownedViewer.user.id;
  let cache: PrefetchCache | null = null;
  let outcome: MyDrivePrefetchResult;
  try {
    cache = await prefetchIo(signal, "storage", () =>
      openOfflineCache({ signal, userId }),
    );
    throwIfPrefetchAborted(signal);
    const storageRecovery = createStorageWriteRecovery(userId);
    const recoveringCache = withStorageRecovery(cache, storageRecovery, signal);
    outcome = await acquireDrive(
      recoveringCache,
      signal,
      userId,
      counts,
      storageRecovery,
      getPriority,
    );
  } catch (error) {
    outcome = stopped(stopReason(error, signal), counts);
  } finally {
    if (cache) {
      try {
        cache.close();
      } catch {
        outcome = stopped(signal.aborted ? "aborted" : "storage", counts);
      }
      if (signal.aborted) {
        outcome = stopped("aborted", counts);
      }
    }
  }
  return outcome;
}
