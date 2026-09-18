// Canonical candidate v9; candidate-only implementation.
import type { Note } from "@miyulabmd/shared";

import { ApiCommunicationError, type ApiResult, fetchNote } from "./api.ts";
import {
  assertOfflineCacheScope,
  assertOfflineNoteAuthority,
  beginOfflineNoteRead,
  captureOfflineCacheScope,
  captureOfflineNoteAuthority,
  enterOfflineNoteDenial,
  isOfflineCacheUserSuspended,
  isOfflineNoteReadCurrent,
  type NoteDenialEvent,
  type OfflineCacheScope,
  type OfflineNoteAuthority,
  openOfflineCache,
  readOfflineNoteDenial,
  reportOfflineNoteDenial,
  subscribeOfflineCacheInvalidation,
  subscribeOfflineCacheNoteDenial,
  suspendOfflineCacheUser,
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
  authority: OfflineNoteAuthority | null;
  publishedNetwork: boolean;
};

function revalidatedAfter(owner: ReadOwner, event: NoteDenialEvent): boolean {
  return Boolean(
    owner.publishedNetwork &&
      owner.authority &&
      event.resource.generation !== null &&
      owner.authority.epoch === event.resource.epoch &&
      owner.authority.generation >= event.resource.generation,
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

async function persistNote(
  cache: Awaited<ReturnType<typeof openOfflineCache>>,
  note: Note,
  signal: AbortSignal,
  orderingToken: number,
  authorityGeneration: number,
): Promise<void> {
  try {
    await cache.putNote(note, { authorityGeneration, orderingToken, signal });
    await cache.clearNoteDenial(note.id, orderingToken, authorityGeneration);
  } catch {
    if (signal.aborted) {
      throw signal.reason;
    }
    // Valid online data must not depend on offline storage.
  }
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
    if (!(onDenied && owner) || actorId !== event.userId) {
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
  let cacheOpenFailed = false;

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
      result.source === "cache" &&
      capturedViewer.cacheViewerId &&
      isOfflineCacheUserSuspended(capturedViewer.cacheViewerId)
    ) {
      throw new DOMException("Offline cache is suspended");
    }
    if (
      result.ok &&
      capturedViewer.cacheViewerId &&
      !isOfflineNoteReadCurrent(capturedViewer.cacheViewerId, id, orderingToken)
    ) {
      throw new DOMException("Note read superseded by denial");
    }
  };

  const getCache = async (scope?: OfflineCacheScope) => {
    if (!cachePromise) {
      cachePromise = capturedViewer.cacheViewerId
        ? openOfflineCache({
            scope,
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
              cacheOpenFailed = true;
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

  const readNetworkNote = async (
    note: Note,
    orderingToken: number,
    scope: OfflineCacheScope | null,
    authority: Awaited<ReturnType<typeof captureOfflineNoteAuthority>> | null,
  ): Promise<NoteReadResult> => {
    if (signal.aborted) {
      throw signal.reason;
    }
    const openedCache =
      scope?.epoch === null ? null : await getCache(scope ?? undefined);
    if (openedCache && authority) {
      await persistNote(
        openedCache,
        note,
        signal,
        orderingToken,
        authority.generation,
      );
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    if (
      capturedViewer.cacheViewerId &&
      !isOfflineNoteReadCurrent(
        capturedViewer.cacheViewerId,
        note.id,
        orderingToken,
      )
    ) {
      throw new DOMException("Note read superseded by denial");
    }
    return {
      cachedAt: null,
      data: note,
      ok: true,
      source: "network",
      viewer: snapshotViewer(capturedViewer),
    };
  };

  const fetchWithFallback = async (
    id: string,
    orderingToken: number,
    authority: Awaited<ReturnType<typeof captureOfflineNoteAuthority>> | null,
  ): Promise<ApiResult<Note> | NoteReadResult> => {
    let result: ApiResult<Note>;
    try {
      result = await fetchNote(id, {
        noteAuthorityEpoch: authority?.epoch,
        noteAuthorityGeneration: authority?.generation,
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

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: terminal publication and denial guards are intentionally explicit.
    async read(id) {
      const owner: ReadOwner = {
        authority: null,
        identities: new Set([id]),
        publishedNetwork: false,
      };
      currentRead = owner;
      if (signal.aborted) {
        throw signal.reason;
      }
      const orderingToken = capturedViewer.cacheViewerId
        ? beginOfflineNoteRead(capturedViewer.cacheViewerId, id)
        : 0;
      const scope = capturedViewer.cacheViewerId
        ? await captureOfflineCacheScope(capturedViewer.cacheViewerId)
        : null;
      let noteAuthority: Awaited<
        ReturnType<typeof captureOfflineNoteAuthority>
      > | null = null;
      if (capturedViewer.cacheViewerId) {
        try {
          noteAuthority = await captureOfflineNoteAuthority(
            capturedViewer.cacheViewerId,
            id,
          );
        } catch {
          // Cache storage is optional for online display.
        }
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      owner.authority = noteAuthority;
      if (
        scope?.epoch &&
        noteAuthority &&
        scope.epoch !== noteAuthority.epoch
      ) {
        throw new DOMException(
          "Note scope changed before acquisition",
          "AbortError",
        );
      }
      const result =
        capturedViewer.mode === "cached"
          ? await readCachedOnly(id)
          : await fetchWithFallback(id, orderingToken, noteAuthority);
      if (scope) {
        await assertOfflineCacheScope(scope);
      }
      let published: NoteReadResult;
      if (isPublishedReadResult(result)) {
        published = result;
      } else if (result.ok) {
        if (noteAuthority && capturedViewer.cacheViewerId) {
          await assertOfflineNoteAuthority(
            noteAuthority,
            capturedViewer.cacheViewerId,
            id,
          );
        }
        published = await readNetworkNote(
          result.data,
          orderingToken,
          scope,
          noteAuthority,
        );
      } else {
        if (signal.aborted) {
          throw signal.reason;
        }
        let cacheWarning: string | undefined;
        if (isDenial(result) && capturedViewer.cacheViewerId) {
          const denialToken = enterOfflineNoteDenial(
            capturedViewer.cacheViewerId,
            id,
          );
          try {
            const openedCache = await getCache();
            if (openedCache) {
              await openedCache.denyNote(id, denialToken);
            } else if (cacheOpenFailed) {
              suspendOfflineCacheUser(capturedViewer.cacheViewerId);
              reportOfflineNoteDenial(
                capturedViewer.cacheViewerId,
                id,
                scope?.epoch ?? null,
                null,
              );
              cacheWarning =
                "キャッシュを無効化できませんでした。安全のためキャッシュをクリアしてください。";
            }
          } catch {
            suspendOfflineCacheUser(capturedViewer.cacheViewerId);
            reportOfflineNoteDenial(
              capturedViewer.cacheViewerId,
              id,
              scope?.epoch ?? null,
              null,
            );
            cacheWarning =
              "キャッシュの無効化を保存できませんでした。安全のためキャッシュをクリアしてください。";
          }
        }
        published = failedReadResult(result, capturedViewer, cacheWarning);
      }
      ensurePublishable(published, id, orderingToken);
      try {
        if (scope) {
          await assertOfflineCacheScope(scope);
          if (published.ok && noteAuthority) {
            await assertOfflineNoteAuthority(
              noteAuthority,
              scope.userId,
              [id, published.data.id],
              scope,
            );
          }
        }
      } finally {
        ensurePublishable(published, id, orderingToken);
      }
      if (published.ok) {
        owner.identities.add(published.data.id);
        owner.identities.add(published.data.shortId);
        owner.publishedNetwork = published.source === "network";
      }
      return published;
    },
  };
}
