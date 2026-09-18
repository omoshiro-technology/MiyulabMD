import type {
  FolderAccess,
  FolderRecord,
  NoteSummary,
} from "@miyulabmd/shared";
import { fetchFolder, fetchNotes, fetchPublicFolders } from "./api.ts";
import {
  assertOfflineCacheScope,
  assertOfflineFolderRead,
  captureOfflineCacheScope,
  captureOfflineCacheUserClearLifetime,
  captureOfflineFolderRead,
  isOfflineCacheUserClearLifetimeCurrent,
  type OfflineCacheScope,
  openOfflineCache,
  subscribeOfflineCacheInvalidation,
  suspendOfflineCacheUser,
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

async function saveHomeMetadata(
  snapshot: HomeMetadataSnapshot,
  viewer: ViewerContext,
  folderId: string | undefined,
  signal: AbortSignal,
  isCurrentOwner: () => boolean,
  clearLifetime: number,
  scope: OfflineCacheScope | null,
  orderingToken: number | undefined,
): Promise<void> {
  if (viewer.mode !== "authenticated" || !viewer.user) {
    return;
  }
  if (viewer.cacheViewerId !== viewer.user.id) {
    snapshot.cacheWarning = "オフラインキャッシュを利用できません。";
    return;
  }
  if (orderingToken === undefined) {
    snapshot.cacheWarning = "オフラインキャッシュを利用できません。";
    return;
  }
  if (!isOfflineCacheUserClearLifetimeCurrent(viewer.user.id, clearLifetime)) {
    throw new DOMException("Home read is no longer current", "AbortError");
  }
  let cache: Awaited<ReturnType<typeof openOfflineCache>> | undefined;
  try {
    cache = await openOfflineCache({
      scope: scope ?? undefined,
      signal,
      userId: viewer.user.id,
    });
    throwIfCancelled(signal, isCurrentOwner);
    if (!snapshot.visibleFolder) {
      throw new Error("Authenticated Home response did not include a folder");
    }
    await cache.putFolder(snapshot.visibleFolder, {
      asDriveRoot: folderId == null,
      orderingToken,
      signal,
    });
    throwIfCancelled(signal, isCurrentOwner);
    await cache.putNoteList(snapshot.notes, { signal });
    throwIfCancelled(signal, isCurrentOwner);
  } catch (error) {
    if (
      signal.aborted ||
      !isCurrentOwner() ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw error;
    }
    snapshot.cacheWarning = "オフラインキャッシュを保存できませんでした。";
  } finally {
    cache?.close();
  }
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

async function persistDeniedFolder(
  error: HomeMetadataError,
  viewer: ViewerContext,
  folderId: string | undefined,
  scope: OfflineCacheScope | null,
  signal: AbortSignal,
  isCurrentOwner: () => boolean,
  orderingToken: number | undefined,
): Promise<void> {
  if (!viewer.user || (error.status !== 403 && error.status !== 404)) {
    return;
  }
  let cache: Awaited<ReturnType<typeof openOfflineCache>> | undefined;
  try {
    cache = await openOfflineCache({
      scope: scope ?? undefined,
      signal,
      userId: viewer.user.id,
    });
    const committed = await cache.denyFolder(
      folderId ?? null,
      orderingToken,
      signal,
    );
    if (!committed) {
      throw new DOMException("Home read is no longer current", "AbortError");
    }
  } catch (cause) {
    if (
      signal.aborted ||
      !isCurrentOwner() ||
      (cause instanceof DOMException && cause.name === "AbortError")
    ) {
      throw cause;
    }
    suspendOfflineCacheUser(viewer.user.id);
    error.cacheWarning =
      "拒否されたフォルダのキャッシュを削除できませんでした。端末キャッシュを削除してください。";
  } finally {
    cache?.close();
  }
}

async function rejectDeniedFolder(
  result: { ok: false; error: string; status: number },
  viewer: ViewerContext,
  folderId: string | undefined,
  scope: OfflineCacheScope | null,
  signal: AbortSignal,
  isCurrentOwner: () => boolean,
  orderingToken: number | undefined,
): Promise<never> {
  const error = deniedFolderError(result);
  await persistDeniedFolder(
    error,
    viewer,
    folderId,
    scope,
    signal,
    isCurrentOwner,
    orderingToken,
  );
  throwIfCancelled(signal, isCurrentOwner);
  throw error;
}

async function validateHomePublication(
  snapshot: HomeMetadataSnapshot,
  scope: OfflineCacheScope | null,
  folderId: string | undefined,
  orderingToken: number | undefined,
): Promise<void> {
  if (!scope) {
    return;
  }
  await assertOfflineCacheScope(scope);
  if (orderingToken === undefined) {
    return;
  }
  try {
    await assertOfflineFolderRead(scope, folderId ?? null, orderingToken);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    snapshot.cacheWarning = "オフラインキャッシュを確認できませんでした。";
  }
}

async function projectCachedHomeMetadata(
  snapshot: HomeMetadataSnapshot,
  folderId: string | undefined,
  viewer: ViewerContext,
  scope: OfflineCacheScope | null,
  signal: AbortSignal,
  isCurrentOwner: () => boolean,
): Promise<void> {
  if (!viewer.user) {
    return;
  }
  let projectionCache: Awaited<ReturnType<typeof openOfflineCache>> | undefined;
  try {
    projectionCache = await openOfflineCache({
      scope: scope ?? undefined,
      signal,
      userId: viewer.user.id,
    });
    const [projectedList, projectedFolder, listState, folderState] =
      await Promise.all([
        projectionCache.getNoteList(),
        projectionCache.getFolder(folderId ?? null),
        projectionCache.getNoteListState(),
        projectionCache.getFolderState(folderId ?? null),
      ]);
    applyCachedHomeMetadataProjection(
      snapshot,
      projectedList,
      projectedFolder,
      listState,
      folderState,
    );
  } catch (error) {
    if (
      signal.aborted ||
      !isCurrentOwner() ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw error;
    }
    snapshot.cacheWarning ??= "オフラインキャッシュを確認できませんでした。";
    if (scope) {
      snapshot.notes = [];
      if (folderId !== undefined) {
        snapshot.visibleFolder = null;
      }
    }
  } finally {
    projectionCache?.close();
  }
}

function applyCachedHomeMetadataProjection(
  snapshot: HomeMetadataSnapshot,
  projectedList: { notes: NoteSummary[]; cachedAt: number } | null,
  projectedFolder: { folder: FolderAccess; cachedAt: number } | null,
  listState: "available" | "denied" | "missing",
  folderState: "available" | "denied" | "missing",
): void {
  if (listState === "denied") {
    snapshot.notes = [];
  } else if (projectedList) {
    snapshot.notes = projectedList.notes;
  }
  if (folderState === "denied") {
    snapshot.visibleFolder = null;
  } else if (projectedFolder) {
    snapshot.visibleFolder = projectedFolder.folder;
  }
}

async function readHomeMetadataSnapshot({
  viewer: inputViewer,
  folderId,
  signal,
  isCurrentOwner,
}: ReadHomeMetadataOptions): Promise<HomeMetadataSnapshot> {
  const viewer: ViewerContext = {
    ...inputViewer,
    user: inputViewer.user ? { ...inputViewer.user } : null,
  };
  throwIfCancelled(signal, isCurrentOwner);
  if (viewer.mode !== "authenticated" && viewer.mode !== "guest") {
    throw new HomeMetadataError("ネットワークのホーム情報を利用できません。");
  }
  const clearLifetime = viewer.user
    ? captureOfflineCacheUserClearLifetime(viewer.user.id)
    : 0;
  const scope = viewer.user
    ? await captureOfflineCacheScope(viewer.user.id)
    : null;
  throwIfCancelled(signal, isCurrentOwner);
  const viewerId = viewer.user?.id ?? null;
  const folderReadGeneration = scope
    ? await captureOfflineFolderRead(scope)
    : undefined;
  throwIfCancelled(signal, isCurrentOwner);
  const notesPromise = fetchNotes({ signal, viewerId });
  const folderPromise = (
    viewer.user || folderId
      ? fetchFolder(folderId, { signal, viewerId })
      : fetchPublicFolders({ signal, viewerId })
  ).then((result) => {
    throwIfCancelled(signal, isCurrentOwner);
    if (!result.ok) {
      return rejectDeniedFolder(
        result,
        viewer,
        folderId,
        scope,
        signal,
        isCurrentOwner,
        folderReadGeneration,
      );
    }
    return result;
  });
  const [notes, folderResult] = await Promise.all([
    notesPromise,
    folderPromise,
  ]);
  throwIfCancelled(signal, isCurrentOwner);
  if (scope) {
    await assertOfflineCacheScope(scope);
  }

  const snapshot = buildHomeSnapshot(viewer, folderId, notes, folderResult);

  await saveHomeMetadata(
    snapshot,
    viewer,
    folderId,
    signal,
    isCurrentOwner,
    clearLifetime,
    scope,
    folderReadGeneration,
  );
  await projectCachedHomeMetadata(
    snapshot,
    folderId,
    viewer,
    scope,
    signal,
    isCurrentOwner,
  );
  throwIfCancelled(signal, isCurrentOwner);
  try {
    await validateHomePublication(
      snapshot,
      scope,
      folderId,
      folderReadGeneration,
    );
  } finally {
    throwIfCancelled(signal, isCurrentOwner);
  }
  if (
    viewer.user &&
    !isOfflineCacheUserClearLifetimeCurrent(viewer.user.id, clearLifetime)
  ) {
    throw new DOMException("Home read is no longer current", "AbortError");
  }
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
  try {
    const snapshot = await readHomeMetadataSnapshot({
      ...options,
      signal: controller.signal,
    });
    throwIfCancelled(controller.signal, options.isCurrentOwner);
    return snapshot;
  } finally {
    options.signal.removeEventListener("abort", cancel);
    unsubscribe();
  }
}
