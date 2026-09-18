import type { Note } from "@miyulabmd/shared";

import { ApiCommunicationError, type ApiResult, fetchNote } from "./api.ts";
import {
  beginOfflineNoteRead,
  captureOfflineNoteDenialSequence,
  captureOfflinePurgeFence,
  enterOfflineNoteDenial,
  isOfflineNoteReadCurrent,
  isOfflinePurgeFenceCurrent,
  type NoteDenialEvent,
  openOfflineCache,
  readOfflineNoteDenial,
  reportOfflineNoteDenial,
  subscribeOfflineCacheInvalidation,
  subscribeOfflineCacheNoteDenial,
} from "./offline-cache.ts";
import type { ViewerContext } from "./viewer-context.ts";

export type NoteReadResult =
  | {
      ok: true;
      data: Note;
      viewer: ViewerContext;
      source: "network" | "cache";
      cachedAt: number | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      viewer: ViewerContext;
      source: "network";
      cachedAt: null;
      cacheWarning?: string;
    };

export type NoteReadSession = {
  read(id: string): Promise<NoteReadResult>;
  dispose(): void;
};

type NoteReadSessionOptions = {
  onDenied?: (event: NoteDenialEvent) => void;
};

type ReadOwner = {
  identities: Set<string>;
  /**
   * The durable denial sequence captured when the read started. A denial
   * event whose generation is not newer than this watermark predates the
   * published network data and must not hide it.
   */
  denialSequence: number | null;
  publishedNetwork: boolean;
  /**
   * This read itself confirmed a 403/404 and is publishing the error — its
   * own ledger write echoes back through the denial subscription and must
   * not overwrite that result with the generic denial message.
   */
  deniedLocally: boolean;
};

function revalidatedAfter(owner: ReadOwner, event: NoteDenialEvent): boolean {
  return Boolean(
    owner.publishedNetwork &&
      owner.denialSequence !== null &&
      event.resource.generation !== null &&
      event.resource.generation <= owner.denialSequence,
  );
}

export function noteDenialMessage(event: NoteDenialEvent): string {
  return event.resource.generation === null
    ? "閲覧が拒否されたため表示を停止しました。キャッシュを無効化できませんでした。端末キャッシュを削除してください。"
    : "閲覧できないか削除されたため、表示を停止しました。";
}

export class OfflineNoteUnavailableError extends Error {
  constructor(id: string) {
    super(`Offline note unavailable: ${id}`);
    this.name = "OfflineNoteUnavailableError";
  }
}

function snapshotViewer(viewer: ViewerContext): ViewerContext {
  return {
    cacheViewerId: viewer.cacheViewerId,
    mode: viewer.mode,
    user: viewer.user
      ? {
          displayName: viewer.user.displayName,
          email: viewer.user.email,
          id: viewer.user.id,
        }
      : null,
  };
}

function isServerFailure(result: ApiResult<Note>): boolean {
  return !result.ok && result.status >= 500 && result.status <= 599;
}

function isDenial(result: ApiResult<Note>): boolean {
  return !result.ok && (result.status === 403 || result.status === 404);
}

function cachedReadResult(
  cached: { note: Note; cachedAt: number },
  viewer: ViewerContext,
): NoteReadResult {
  return {
    cachedAt: cached.cachedAt,
    data: cached.note,
    ok: true,
    source: "cache",
    viewer: snapshotViewer(viewer),
  };
}

function isPublishedReadResult(
  result: ApiResult<Note> | NoteReadResult,
): result is NoteReadResult {
  return (
    result.ok &&
    "source" in result &&
    "viewer" in result &&
    "cachedAt" in result
  );
}

function failedReadResult(
  result: { error: string; status: number },
  viewer: ViewerContext,
  cacheWarning?: string,
): NoteReadResult {
  return {
    cachedAt: null,
    error: result.error,
    ok: false,
    source: "network",
    status: result.status,
    ...(cacheWarning ? { cacheWarning } : {}),
    viewer: snapshotViewer(viewer),
  };
}

/**
 * Fully detached display-cache save on its own handle: it outlives the
 * read (and session disposal) because a cancelled navigation must not
 * undo a committed write. `denialSequence` is the ledger watermark
 * captured when the read began: a denial committed since then makes the
 * put (and the denial clear) lose — a stale 200 never resurrects a denied
 * note. Failures warn only; valid online data must not depend on storage.
 */
function persistNoteDetached(
  userId: string,
  note: Note,
  orderingToken: number,
  denialSequence: number | null,
): void {
  void (async () => {
    const cache = await openOfflineCache({ userId });
    try {
      if (cache.degraded) {
        return;
      }
      await cache.putNote(note, {
        denialSequence: denialSequence ?? undefined,
        orderingToken,
      });
      if (denialSequence !== null) {
        await cache.clearNoteDenial(note.id, orderingToken, denialSequence);
      }
    } finally {
      cache.close();
    }
  })().catch((error) => {
    console.warn("Offline note cache save failed", error);
  });
}

export function createNoteReadSession(
  viewer: ViewerContext,
  options: NoteReadSessionOptions = {},
): NoteReadSession {
  const capturedViewer = snapshotViewer(viewer);
  const controller = new AbortController();
  const { signal } = controller;
  const onDenied = options.onDenied;
  const actorId = capturedViewer.user?.id ?? capturedViewer.cacheViewerId;
  let currentRead: ReadOwner | null = null;
  const unsubscribe = subscribeOfflineCacheInvalidation((userId) => {
    if (userId === capturedViewer.cacheViewerId) {
      controller.abort(new DOMException("Note read invalidated", "AbortError"));
    }
  });
  let cachePromise:
    | Promise<Awaited<ReturnType<typeof openOfflineCache>> | null>
    | undefined;
  let disposed = false;
  const unsubscribeDenial = subscribeOfflineCacheNoteDenial((event) => {
    const owner = currentRead;
    if (
      !(onDenied && owner) ||
      actorId !== event.userId ||
      owner.deniedLocally
    ) {
      return;
    }
    const identities = event.resource.aliases.filter((id) =>
      owner.identities.has(id),
    );
    if (!identities.length || revalidatedAfter(owner, event)) {
      return;
    }
    void readOfflineNoteDenial(event, identities)
      .then((denied) => {
        if (
          disposed ||
          currentRead !== owner ||
          denied === false ||
          revalidatedAfter(owner, event)
        ) {
          return;
        }
        return onDenied(event);
      })
      .catch(() => {
        // Observer failures do not replace the original HTTP result.
      });
  });
  let cache: Awaited<ReturnType<typeof openOfflineCache>> | null = null;

  const ensurePublishable = (
    result: NoteReadResult,
    id: string,
    orderingToken: number,
  ) => {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (
      result.ok &&
      capturedViewer.cacheViewerId &&
      !isOfflineNoteReadCurrent(capturedViewer.cacheViewerId, id, orderingToken)
    ) {
      throw new DOMException("Note read superseded by denial");
    }
  };

  const getCache = async () => {
    if (!cachePromise) {
      cachePromise = capturedViewer.cacheViewerId
        ? openOfflineCache({
            signal,
            userId: capturedViewer.cacheViewerId,
          }).then(
            (openedCache) => {
              if (signal.aborted) {
                openedCache.close();
                throw signal.reason;
              }
              return openedCache;
            },
            () => {
              if (signal.aborted) {
                throw signal.reason;
              }
              return null;
            },
          )
        : Promise.resolve(null);
    }
    const openedCache = await cachePromise;
    if (openedCache) {
      if (signal.aborted) {
        openedCache.close();
        throw signal.reason;
      }
      cache = openedCache;
    }
    return openedCache;
  };

  const readCachedNote = async (id: string) => {
    const openedCache = await getCache();
    if (!openedCache) {
      return null;
    }
    try {
      const cached = await openedCache.getNote(id);
      if (signal.aborted) {
        throw signal.reason;
      }
      return cached;
    } catch {
      if (signal.aborted) {
        throw signal.reason;
      }
      // Offline storage is optional; a read error is a cache miss.
      return null;
    }
  };

  const communicationFallback = async (
    id: string,
    error: unknown,
    orderingToken: number,
  ) => {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (!(error instanceof ApiCommunicationError)) {
      throw error;
    }
    const cached = await readCachedNote(id);
    if (
      cached &&
      capturedViewer.cacheViewerId &&
      !isOfflineNoteReadCurrent(capturedViewer.cacheViewerId, id, orderingToken)
    ) {
      throw error;
    }
    if (cached) {
      return cachedReadResult(cached, capturedViewer);
    }
    throw error;
  };

  const serverFallback = async (
    id: string,
    result: ApiResult<Note>,
    orderingToken: number,
  ) => {
    if (!isServerFailure(result)) {
      return null;
    }
    const cached = await readCachedNote(id);
    if (
      cached &&
      capturedViewer.cacheViewerId &&
      !isOfflineNoteReadCurrent(capturedViewer.cacheViewerId, id, orderingToken)
    ) {
      return null;
    }
    return cached ? cachedReadResult(cached, capturedViewer) : null;
  };

  const fetchWithFallback = async (
    id: string,
    orderingToken: number,
    purgeFence: Promise<{ device: number; user: number } | null>,
  ): Promise<ApiResult<Note> | NoteReadResult> => {
    let result: ApiResult<Note>;
    try {
      result = await fetchNote(id, {
        purgeFence,
        signal,
        viewerId: capturedViewer.user?.id ?? null,
      });
    } catch (error) {
      return await communicationFallback(id, error, orderingToken);
    }
    const fallback = await serverFallback(id, result, orderingToken);
    if (fallback) {
      return fallback;
    }
    return result;
  };

  const readCachedOnly = async (id: string): Promise<NoteReadResult> => {
    const cached = await readCachedNote(id);
    if (!cached) {
      throw new OfflineNoteUnavailableError(id);
    }
    return cachedReadResult(cached, capturedViewer);
  };

  /**
   * Record a confirmed 403/404. The in-memory read generation bumps first —
   * that alone already fences the stale in-flight read. The durable marker
   * is then awaited but best-effort: a denied note has nothing to render,
   * so the local ledger write cannot delay real display, and its failure
   * surfaces as the result's cacheWarning instead of throwing.
   */
  const persistDenial = async (id: string): Promise<boolean> => {
    const userId = capturedViewer.cacheViewerId;
    if (!userId) {
      return false;
    }
    const denialToken = enterOfflineNoteDenial(userId, id);
    try {
      const openedCache = await getCache();
      if (!openedCache || openedCache.degraded) {
        throw new Error("Offline cache is unavailable");
      }
      await openedCache.denyNote(id, denialToken);
      return true;
    } catch {
      // The ledger could not record the denial — report it without a
      // generation so observers hide the note and show the warning.
      reportOfflineNoteDenial(userId, id, null);
      return false;
    }
  };

  /** 成功したネットワーク結果を即座に publish し、キャッシュ保存は切り離す。 */
  const publishNetworkResult = async (
    result: ApiResult<Note> & { ok: true },
    orderingToken: number,
    owner: ReadOwner,
    denialSequencePromise: Promise<number | null>,
    purgeFencePromise: Promise<{ device: number; user: number } | null>,
  ): Promise<NoteReadResult> => {
    const cacheViewerId = capturedViewer.cacheViewerId;
    owner.denialSequence = await denialSequencePromise;
    const purgeFence = await purgeFencePromise;
    if (
      cacheViewerId &&
      purgeFence &&
      !(await isOfflinePurgeFenceCurrent(cacheViewerId, purgeFence))
    ) {
      throw new DOMException("Note read invalidated by purge", "AbortError");
    }
    const published: NoteReadResult = {
      cachedAt: null,
      data: result.data,
      ok: true,
      source: "network",
      viewer: snapshotViewer(capturedViewer),
    };
    if (cacheViewerId) {
      persistNoteDetached(
        cacheViewerId,
        result.data,
        orderingToken,
        owner.denialSequence,
      );
    }
    return published;
  };

  /** 失敗結果を publish 用の形に整える。denial は台帳へ best-effort 記録。 */
  const publishFailedResult = async (
    result: ApiResult<Note> & { ok: false },
    id: string,
    owner: ReadOwner,
  ): Promise<NoteReadResult> => {
    if (signal.aborted) {
      throw signal.reason;
    }
    let cacheWarning: string | undefined;
    if (isDenial(result) && capturedViewer.cacheViewerId) {
      owner.deniedLocally = true;
      const persisted = await persistDenial(id);
      if (!persisted) {
        cacheWarning =
          "キャッシュを無効化できませんでした。安全のためキャッシュをクリアしてください。";
      }
    }
    return failedReadResult(result, capturedViewer, cacheWarning);
  };

  const publishResult = (
    result: ApiResult<Note> | NoteReadResult,
    id: string,
    orderingToken: number,
    owner: ReadOwner,
    denialSequencePromise: Promise<number | null>,
    purgeFencePromise: Promise<{ device: number; user: number } | null>,
  ): Promise<NoteReadResult> => {
    if (isPublishedReadResult(result)) {
      return Promise.resolve(result);
    }
    if (result.ok) {
      return publishNetworkResult(
        result,
        orderingToken,
        owner,
        denialSequencePromise,
        purgeFencePromise,
      );
    }
    return publishFailedResult(result, id, owner);
  };

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      unsubscribeDenial();
      controller.abort();
      cache?.close();
      cache = null;
    },

    async read(id) {
      const owner: ReadOwner = {
        denialSequence: null,
        deniedLocally: false,
        identities: new Set([id]),
        publishedNetwork: false,
      };
      currentRead = owner;
      if (signal.aborted) {
        throw signal.reason;
      }
      const cacheViewerId = capturedViewer.cacheViewerId;
      const orderingToken = cacheViewerId
        ? beginOfflineNoteRead(cacheViewerId, id)
        : 0;
      // The ledger read runs alongside the fetch; it doubles as the CAS
      // watermark for the detached save and the denial-event watermark.
      const denialSequencePromise = cacheViewerId
        ? captureOfflineNoteDenialSequence(cacheViewerId)
        : Promise.resolve(null);
      // Durable purge fence captured at read start; re-checked before a
      // network publish so a cross-tab purge invalidates this response even
      // when the BroadcastChannel message was missed.
      const purgeFencePromise = cacheViewerId
        ? captureOfflinePurgeFence(cacheViewerId)
        : Promise.resolve(null);
      const result =
        capturedViewer.mode === "cached"
          ? await readCachedOnly(id)
          : await fetchWithFallback(id, orderingToken, purgeFencePromise);
      const published = await publishResult(
        result,
        id,
        orderingToken,
        owner,
        denialSequencePromise,
        purgeFencePromise,
      );
      ensurePublishable(published, id, orderingToken);
      if (published.ok) {
        owner.identities.add(published.data.id);
        owner.identities.add(published.data.shortId);
        owner.publishedNetwork = published.source === "network";
      }
      return published;
    },
  };
}
