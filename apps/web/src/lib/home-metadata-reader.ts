import type {
  FolderAccess,
  FolderRecord,
  NoteSummary,
} from "@miyulabmd/shared";
import { fetchFolder, fetchNotes, fetchPublicFolders } from "./api.ts";
import {
  type OfflineDenialSnapshot,
  openOfflineCache,
  projectDeniedFolder,
  readOfflineDenialSnapshot,
  subscribeOfflineCacheFolderDenial,
  subscribeOfflineCacheInvalidation,
} from "./offline-cache.ts";
import type { ViewerContext } from "./viewer-context.ts";

export class HomeMetadataError extends Error {
  readonly status: number | undefined;
  cacheWarning?: string;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HomeMetadataError";
    this.status = status;
  }
}

export type HomeMetadataSnapshot = {
  notes: NoteSummary[];
  visibleFolder: FolderAccess | null;
  publicFolders: FolderRecord[];
  cacheWarning?: string;
};

type ReadHomeMetadataOptions = {
  viewer: ViewerContext;
  folderId: string | undefined;
  signal: AbortSignal;
  isCurrentOwner: () => boolean;
  /** Detached cache writes finish after the snapshot resolves; failures are
   * reported through this callback instead of blocking first paint. */
  onCacheWarning?: (warning: string) => void;
  /** Internal: invoked once the network fetches settle so the caller can
   * stop invalidating this read for mid-flight denials. */
  onNetworkSettled?: () => void;
};

function requireResult<T>(
  result: { ok: true; data: T } | { ok: false; status: number; error: string },
): T {
  if (!result.ok) {
    throw new HomeMetadataError(
      result.status === 404 ? "フォルダが見つかりません。" : result.error,
      result.status,
    );
  }
  return result.data;
}

function buildHomeSnapshot(
  viewer: ViewerContext,
  folderId: string | undefined,
  notes: NoteSummary[],
  folderResult:
    | Awaited<ReturnType<typeof fetchFolder>>
    | Awaited<ReturnType<typeof fetchPublicFolders>>,
): HomeMetadataSnapshot {
  if (viewer.user || folderId) {
    return {
      notes,
      publicFolders: [],
      visibleFolder: requireResult(
        folderResult as Awaited<ReturnType<typeof fetchFolder>>,
      ),
    };
  }
  return {
    notes,
    publicFolders: requireResult(
      folderResult as Awaited<ReturnType<typeof fetchPublicFolders>>,
    ),
    visibleFolder: null,
  };
}

function throwIfCancelled(
  signal: AbortSignal,
  isCurrentOwner: () => boolean,
): void {
  if (signal.aborted) {
    throw signal.reason;
  }
  if (!isCurrentOwner()) {
    throw new DOMException("Home read is no longer current", "AbortError");
  }
}

/**
 * Project the durable denial ledger over freshly fetched network data.
 * A `null` snapshot means the ledger could not be read — the display keeps
 * the unprojected network data (the ledger is best-effort, never a gate).
 */
function projectNetworkSnapshot(
  snapshot: HomeMetadataSnapshot,
  denial: OfflineDenialSnapshot | null,
): void {
  if (!denial) {
    return;
  }
  snapshot.notes = snapshot.notes.filter(
    (note) =>
      !(
        (denial.deniedFolderIds.has(note.folderId) &&
          note.access?.inherit !== false) ||
        denial.deniedNoteIds.has(note.id) ||
        denial.deniedNoteIds.has(note.shortId)
      ),
  );
  if (snapshot.visibleFolder) {
    snapshot.visibleFolder = denial.deniedFolderIds.has(
      snapshot.visibleFolder.id,
    )
      ? null
      : projectDeniedFolder(snapshot.visibleFolder, denial.deniedFolderIds);
  }
}

/**
 * Detached cache write: the display never waits for it. The purge-generation
 * and denial-sequence fences inside the cache make the write lose to any
 * purge or denial that landed after this read started.
 */
function saveHomeMetadataDetached(
  snapshot: HomeMetadataSnapshot,
  viewer: ViewerContext,
  folderId: string | undefined,
  orderingToken: number | undefined,
  onCacheWarning?: (warning: string) => void,
): void {
  if (viewer.mode !== "authenticated" || !viewer.user) {
    return;
  }
  if (viewer.cacheViewerId !== viewer.user.id) {
    snapshot.cacheWarning = "オフラインキャッシュを利用できません。";
    return;
  }
  const folder = snapshot.visibleFolder;
  if (!folder) {
    return;
  }
  const userId = viewer.user.id;
  void (async () => {
    const cache = await openOfflineCache({ userId });
    try {
      if (cache.degraded) {
        return;
      }
      await cache.putFolder(folder, {
        asDriveRoot: folderId == null,
        orderingToken,
      });
      await cache.putNoteList(snapshot.notes);
    } finally {
      cache.close();
    }
  })().catch((error) => {
    console.warn("Offline home metadata save failed", error);
    snapshot.cacheWarning ??= "オフラインキャッシュを保存できませんでした。";
    onCacheWarning?.("オフラインキャッシュを保存できませんでした。");
  });
}

function deniedFolderError(result: {
  error: string;
  status: number;
}): HomeMetadataError {
  return new HomeMetadataError(
    result.status === 404 ? "フォルダが見つかりません。" : result.error,
    result.status,
  );
}

/**
 * A confirmed 403/404 becomes a durable denial marker — detached and
 * best-effort, so it never delays or fails the error the caller renders.
 * The write intentionally outlives the read's own signal: a cancelled
 * navigation must not undo a confirmed denial.
 */
function persistDeniedFolderDetached(
  error: HomeMetadataError,
  viewer: ViewerContext,
  folderId: string | undefined,
): void {
  if (!viewer.user || (error.status !== 403 && error.status !== 404)) {
    return;
  }
  const userId = viewer.user.id;
  void (async () => {
    const cache = await openOfflineCache({ userId });
    try {
      if (cache.degraded) {
        return;
      }
      await cache.denyFolder(folderId ?? null);
    } finally {
      cache.close();
    }
  })().catch((cause) => {
    console.warn("Offline folder denial could not be persisted", cause);
    error.cacheWarning =
      "拒否されたフォルダのキャッシュを削除できませんでした。端末キャッシュを削除してください。";
  });
}

async function readHomeMetadataSnapshot({
  viewer: inputViewer,
  folderId,
  signal,
  isCurrentOwner,
  onCacheWarning,
  onNetworkSettled,
}: ReadHomeMetadataOptions): Promise<HomeMetadataSnapshot> {
  const viewer: ViewerContext = {
    ...inputViewer,
    user: inputViewer.user ? { ...inputViewer.user } : null,
  };
  throwIfCancelled(signal, isCurrentOwner);
  if (viewer.mode !== "authenticated" && viewer.mode !== "guest") {
    throw new HomeMetadataError("ネットワークのホーム情報を利用できません。");
  }
  const viewerId = viewer.user?.id ?? null;
  // The denial ledger read runs in parallel with the network fetches; it is
  // local, best-effort (`null` on failure) and adds no time to first paint.
  const denialPromise = viewer.user
    ? readOfflineDenialSnapshot(viewer.user.id)
    : Promise.resolve(null);
  const notesPromise = fetchNotes({ signal, viewerId });
  const folderPromise = (
    viewer.user || folderId
      ? fetchFolder(folderId, { signal, viewerId })
      : fetchPublicFolders({ signal, viewerId })
  ).then((result) => {
    throwIfCancelled(signal, isCurrentOwner);
    if (!result.ok) {
      const error = deniedFolderError(result);
      persistDeniedFolderDetached(error, viewer, folderId);
      throw error;
    }
    return result;
  });
  let notes: NoteSummary[];
  let folderResult: Awaited<typeof folderPromise>;
  try {
    [notes, folderResult] = await Promise.all([notesPromise, folderPromise]);
  } finally {
    // Once the fetches settle a late denial no longer aborts: the denial
    // snapshot and the page's folder-denial subscription project it.
    onNetworkSettled?.();
  }
  throwIfCancelled(signal, isCurrentOwner);

  const snapshot = buildHomeSnapshot(viewer, folderId, notes, folderResult);

  const denial = await denialPromise;
  // Persist the *fetched* folder before projecting denials: a confirmed 200
  // revalidates, and the watermark authorizes lifting an older denial while
  // still losing to one committed after the read began.
  saveHomeMetadataDetached(
    snapshot,
    viewer,
    folderId,
    denial?.folderSequence,
    onCacheWarning,
  );

  // Denials committed before this read hide their resources; a denial that
  // lands later reaches the page through the denial subscriptions.
  projectNetworkSnapshot(snapshot, denial);
  throwIfCancelled(signal, isCurrentOwner);
  return snapshot;
}

export async function readHomeMetadata(
  options: ReadHomeMetadataOptions,
): Promise<HomeMetadataSnapshot> {
  const controller = new AbortController();
  const userId = options.viewer.user?.id;
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) {
    cancel();
  }
  const unsubscribe = subscribeOfflineCacheInvalidation((invalidatedUserId) => {
    if (invalidatedUserId === userId) {
      controller.abort(new DOMException("Home read invalidated", "AbortError"));
    }
  });
  // A folder denial committed while the network fetch is still pending
  // invalidates this snapshot — but only when the denied folder is the
  // one being read (denials of other folders must not cancel a healthy
  // read; their rows are corrected through the page's subscription).
  // Clear events carry a null generation and never invalidate.
  const unsubscribeFolder = subscribeOfflineCacheFolderDenial((event) => {
    if (
      event.userId === userId &&
      event.resource.generation !== null &&
      event.resource.aliases.includes(options.folderId ?? null)
    ) {
      controller.abort(new DOMException("Home read invalidated", "AbortError"));
    }
  });
  try {
    const snapshot = await readHomeMetadataSnapshot({
      ...options,
      onNetworkSettled: () => {
        unsubscribeFolder();
        options.onNetworkSettled?.();
      },
      signal: controller.signal,
    });
    throwIfCancelled(controller.signal, options.isCurrentOwner);
    return snapshot;
  } finally {
    options.signal.removeEventListener("abort", cancel);
    unsubscribeFolder();
    unsubscribe();
  }
}
