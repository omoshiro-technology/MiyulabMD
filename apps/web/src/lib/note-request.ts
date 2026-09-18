import type { Note } from "@miyulabmd/shared";

import { type ApiResult, requestJson } from "./api-transport.ts";
import { currentNoteReadGeneration } from "./note-access-order.ts";
import { captureOfflinePurgeFence } from "./offline-cache.ts";

export type NotePurgeFence = { device: number; user: number };

type NoteRequestOptions = {
  signal?: AbortSignal;
  viewerId?: string | null;
  /**
   * Durable purge fence the caller already captured. When omitted the fence
   * is read lazily alongside the transport, so a read started after a
   * cross-tab purge can never settle on a pre-purge response — even when
   * the BroadcastChannel invalidation was missed.
   */
  purgeFence?: Promise<NotePurgeFence | null> | NotePurgeFence | null;
};

type Subscriber = {
  reject: (reason: unknown) => void;
  resolve: (result: ApiResult<Note>) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type Entry = {
  controller: AbortController;
  /**
   * The creating subscriber's durable fence. `undefined` while the ledger
   * read is still in flight; `null` means the ledger was unreadable and the
   * entry degrades to unfenced sharing.
   */
  fence: NotePurgeFence | null | undefined;
  fencePromise: Promise<NotePurgeFence | null>;
  generation: number;
  promise: Promise<ApiResult<Note>>;
  subscribers: Set<Subscriber>;
};

const inFlightByViewer = new Map<string, Map<string, Entry>>();

/** Internal retry signal: the joined transport predates the caller's purge fence. */
const STALE_FENCE = Symbol("note-request-stale-fence");

function copyResult(result: ApiResult<Note>): ApiResult<Note> {
  return result.ok
    ? { data: structuredClone(result.data), ok: true }
    : { error: result.error, ok: false, status: result.status };
}

function cleanupSubscriber(subscriber: Subscriber): void {
  if (subscriber.onAbort) {
    subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
  }
}

function removeEntry(viewerId: string, id: string, entry: Entry): void {
  const byNote = inFlightByViewer.get(viewerId);
  if (byNote?.get(id) !== entry) {
    return;
  }
  byNote.delete(id);
  if (byNote.size === 0) {
    inFlightByViewer.delete(viewerId);
  }
}

function fenceMatches(
  mine: NotePurgeFence | null,
  theirs: NotePurgeFence | null,
): boolean {
  // An unreadable ledger cannot prove staleness; degrade to shared.
  if (!(mine && theirs)) {
    return true;
  }
  return mine.device === theirs.device && mine.user === theirs.user;
}

// In-flight requests are shared per (viewer, note, read generation). The
// transport is issued immediately — first paint must not wait on the durable
// fence read. A purge committed between two reads changes the durable fence:
// the entry's fence is compared against each subscriber's as soon as both
// are known (and again at delivery), so a post-purge read never settles on a
// pre-purge response even when BroadcastChannel was unavailable.
function shareNoteRequest(
  id: string,
  viewerId: string,
  signal: AbortSignal | undefined,
  generation: number,
  fencePromise: Promise<NotePurgeFence | null>,
  resolvedFence: NotePurgeFence | null | undefined,
): Promise<ApiResult<Note>> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  let byNote = inFlightByViewer.get(viewerId);
  if (!byNote) {
    byNote = new Map();
    inFlightByViewer.set(viewerId, byNote);
  }
  if (generation !== currentNoteReadGeneration(viewerId, id)) {
    return Promise.reject(
      new DOMException("Note read superseded by denial", "AbortError"),
    );
  }
  let entry = byNote.get(id);
  if (
    !entry ||
    entry.generation !== generation ||
    entry.controller.signal.aborted ||
    // A resolved mismatch evicts the stale transport so this read opens a
    // current one instead of settling on a pre-purge response.
    (entry.fence !== undefined &&
      resolvedFence !== undefined &&
      !fenceMatches(resolvedFence, entry.fence))
  ) {
    const controller = new AbortController();
    const created: Entry = {
      controller,
      fence: undefined,
      fencePromise: fencePromise.then((fence) => {
        created.fence = fence;
        return fence;
      }),
      generation,
      // Defer the wire request one microtask: a caller cancelled during the
      // same synchronous turn (StrictMode remount, navigation racing a read)
      // must not spend a real request whose only subscriber is already gone.
      promise: new Promise<ApiResult<Note>>((resolve, reject) => {
        queueMicrotask(() => {
          if (controller.signal.aborted || created.subscribers.size === 0) {
            reject(
              controller.signal.aborted
                ? controller.signal.reason
                : new DOMException("Note request abandoned", "AbortError"),
            );
            return;
          }
          requestJson<Note>(
            `/api/notes/${id}`,
            { credentials: "include", signal: controller.signal },
            { viewerId },
          ).then(resolve, reject);
        });
      }),
      subscribers: new Set(),
    };
    entry = created;
    byNote.set(id, entry);
    const currentEntry = entry;
    currentEntry.promise.then(
      (result) => {
        removeEntry(viewerId, id, currentEntry);
        for (const subscriber of [...currentEntry.subscribers]) {
          cleanupSubscriber(subscriber);
          try {
            subscriber.resolve(copyResult(result));
          } catch (error) {
            subscriber.reject(error);
          }
        }
        currentEntry.subscribers.clear();
      },
      (error) => {
        removeEntry(viewerId, id, currentEntry);
        for (const subscriber of [...currentEntry.subscribers]) {
          cleanupSubscriber(subscriber);
          subscriber.reject(error);
        }
        currentEntry.subscribers.clear();
      },
    );
  }

  const currentEntry = entry;
  return new Promise<ApiResult<Note>>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupSubscriber(subscriber);
      currentEntry.subscribers.delete(subscriber);
      callback();
    };
    const releaseEntryIfIdle = () => {
      if (currentEntry.subscribers.size === 0) {
        removeEntry(viewerId, id, currentEntry);
        currentEntry.controller.abort();
      }
    };
    const subscriber: Subscriber = { reject, resolve, signal };
    subscriber.resolve = (result) => {
      void Promise.all([fencePromise, currentEntry.fencePromise]).then(
        ([mine, theirs]) => {
          if (!fenceMatches(mine, theirs)) {
            settle(() => {
              reject(STALE_FENCE);
              releaseEntryIfIdle();
            });
            return;
          }
          settle(() => resolve(result));
        },
        () => settle(() => resolve(result)),
      );
    };
    subscriber.reject = (reason) => {
      settle(() => reject(reason));
    };
    subscriber.onAbort = () => {
      settle(() => {
        reject(signal?.reason);
        releaseEntryIfIdle();
      });
    };
    // Bail as soon as both fences are known to disagree — no need to wait
    // for the stale transport to settle.
    void Promise.all([fencePromise, currentEntry.fencePromise]).then(
      ([mine, theirs]) => {
        if (!fenceMatches(mine, theirs)) {
          settle(() => {
            reject(STALE_FENCE);
            releaseEntryIfIdle();
          });
        }
      },
      () => undefined,
    );
    currentEntry.subscribers.add(subscriber);
    signal?.addEventListener("abort", subscriber.onAbort, { once: true });
    if (signal?.aborted) {
      subscriber.onAbort();
    }
  });
}

export async function fetchNoteRequest(
  id: string,
  options: NoteRequestOptions = {},
): Promise<ApiResult<Note>> {
  const { viewerId, signal, purgeFence } = options;
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  if (!viewerId) {
    return requestJson<Note>(
      `/api/notes/${id}`,
      { credentials: "include", signal },
      { viewerId },
    );
  }
  let resolvedFence: NotePurgeFence | null | undefined;
  let fencePromise = (
    purgeFence === undefined
      ? captureOfflinePurgeFence(viewerId).catch(() => null)
      : Promise.resolve(purgeFence).catch(() => null)
  ).then((fence) => {
    resolvedFence = fence;
    return fence;
  });
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const generation = currentNoteReadGeneration(viewerId, id);
    try {
      return await shareNoteRequest(
        id,
        viewerId,
        signal,
        generation,
        fencePromise,
        resolvedFence,
      );
    } catch (error) {
      if (error !== STALE_FENCE || signal?.aborted) {
        throw error;
      }
      // The joined transport predates this read's durable fence — capture
      // the post-purge fence and join (or open) a current entry instead.
      resolvedFence = undefined;
      fencePromise = captureOfflinePurgeFence(viewerId)
        .catch(() => null)
        .then((fence) => {
          resolvedFence = fence;
          return fence;
        });
      resolvedFence = await fencePromise;
    }
  }
}
