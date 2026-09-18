import type { Note } from "@miyulabmd/shared";

import { type ApiResult, requestJson } from "./api-transport.ts";
import { currentNoteReadGeneration } from "./note-access-order.ts";
import { captureOfflineNoteAuthority } from "./offline-cache.ts";

type NoteRequestOptions = {
  signal?: AbortSignal;
  viewerId?: string | null;
  noteAuthorityGeneration?: number;
  noteAuthorityEpoch?: string;
};

type Subscriber = {
  reject: (reason: unknown) => void;
  resolve: (result: ApiResult<Note>) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type Entry = {
  controller: AbortController;
  generation: number;
  authorityGeneration?: number;
  authorityEpoch?: string;
  promise: Promise<ApiResult<Note>>;
  subscribers: Set<Subscriber>;
};

const inFlightByViewer = new Map<string, Map<string, Entry>>();

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

function shareNoteRequest(
  id: string,
  viewerId: string,
  signal?: AbortSignal,
  authorityGeneration?: number,
  entryGeneration = currentNoteReadGeneration(viewerId, id),
  authorityEpoch?: string,
): Promise<ApiResult<Note>> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  let byNote = inFlightByViewer.get(viewerId);
  if (!byNote) {
    byNote = new Map();
    inFlightByViewer.set(viewerId, byNote);
  }
  const generation = entryGeneration;
  if (generation !== currentNoteReadGeneration(viewerId, id)) {
    return Promise.reject(
      new DOMException("Note read superseded by denial", "AbortError"),
    );
  }
  let entry = byNote.get(id);
  if (
    !entry ||
    entry.generation !== generation ||
    entry.authorityGeneration !== authorityGeneration ||
    entry.authorityEpoch !== authorityEpoch
  ) {
    const controller = new AbortController();
    entry = {
      authorityEpoch,
      authorityGeneration,
      controller,
      generation,
      promise: requestJson<Note>(
        `/api/notes/${id}`,
        { credentials: "include", signal: controller.signal },
        { viewerId },
      ),
      subscribers: new Set(),
    };
    byNote.set(id, entry);
    const currentEntry = entry;
    currentEntry.promise.then(
      (result) => {
        removeEntry(viewerId, id, currentEntry);
        for (const subscriber of currentEntry.subscribers) {
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
        for (const subscriber of currentEntry.subscribers) {
          cleanupSubscriber(subscriber);
          subscriber.reject(error);
        }
        currentEntry.subscribers.clear();
      },
    );
  }

  const currentEntry = entry;
  return new Promise<ApiResult<Note>>((resolve, reject) => {
    const subscriber: Subscriber = { reject, resolve, signal };
    subscriber.onAbort = () => {
      currentEntry.subscribers.delete(subscriber);
      signal?.removeEventListener("abort", subscriber.onAbort as () => void);
      reject(signal?.reason);
      if (currentEntry.subscribers.size === 0) {
        removeEntry(viewerId, id, currentEntry);
        currentEntry.controller.abort();
      }
    };
    currentEntry.subscribers.add(subscriber);
    signal?.addEventListener("abort", subscriber.onAbort, { once: true });
    if (signal?.aborted) {
      subscriber.onAbort();
    }
  });
}

function shareAfterAuthority(
  id: string,
  viewerId: string,
  signal: AbortSignal | undefined,
  generation: number,
): Promise<ApiResult<Note>> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    void captureOfflineNoteAuthority(viewerId, id)
      .catch(() => null)
      .then((authority) => {
        signal?.removeEventListener("abort", abort);
        return shareNoteRequest(
          id,
          viewerId,
          signal,
          authority?.generation,
          generation,
          authority?.epoch,
        );
      })
      .then(resolve, reject);
  });
}

export function fetchNoteRequest(
  id: string,
  options: NoteRequestOptions = {},
): Promise<ApiResult<Note>> {
  const { viewerId, signal, noteAuthorityGeneration, noteAuthorityEpoch } =
    options;
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
  const generation = currentNoteReadGeneration(viewerId, id);
  if (
    noteAuthorityGeneration !== undefined &&
    noteAuthorityEpoch !== undefined
  ) {
    return shareNoteRequest(
      id,
      viewerId,
      signal,
      noteAuthorityGeneration,
      generation,
      noteAuthorityEpoch,
    );
  }
  return shareAfterAuthority(id, viewerId, signal, generation);
}
