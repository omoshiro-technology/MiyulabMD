import type { Note } from "@miyulabmd/shared";
import { type ApiResult, fetchNote } from "./api.ts";
import { loadOgCards } from "./markdown.ts";
import { consumeOgBootstrap, readNoteBootstrap } from "./note-bootstrap.ts";

const noteCache = new Map<string, Note>();
const noteInflight = new Map<string, Promise<ApiResult<Note>>>();
let noteBootstrapAvailable = true;

export function peekNote(id: string): Note | undefined {
  return noteCache.get(id);
}

export function noteFromCaches(id: string): Note | undefined {
  consumeOgBootstrap();
  const peeked = peekNote(id);
  if (peeked) {
    return peeked;
  }
  const boot = noteBootstrapAvailable ? readNoteBootstrap(id) : null;
  if (boot) {
    seedNoteCache(boot);
    return boot;
  }
  return undefined;
}

export function seedNoteCache(note: Note): void {
  noteCache.set(note.id, note);
  if (note.shortId) {
    noteCache.set(note.shortId, note);
  }
}

export function invalidateNoteCache(id?: string): void {
  if (!id) {
    // Identity invalidation must also retire SSR data still present in the DOM.
    // Otherwise a later reader could repopulate the cleared memory cache.
    noteBootstrapAvailable = false;
    noteCache.clear();
    noteInflight.clear();
    return;
  }
  const cached = noteCache.get(id);
  noteCache.delete(id);
  noteInflight.delete(id);
  if (cached) {
    noteCache.delete(cached.id);
    if (cached.shortId) {
      noteCache.delete(cached.shortId);
    }
  }
}

export async function loadNote(
  id: string,
  force = false,
): Promise<ApiResult<Note>> {
  if (!force) {
    const cached = noteCache.get(id);
    if (cached) {
      return { data: cached, ok: true };
    }
    const inflight = noteInflight.get(id);
    if (inflight) {
      return inflight;
    }
  }

  const pending = fetchNote(id).then((result) => {
    if (noteInflight.get(id) !== pending) {
      throw new DOMException("Note cache read invalidated", "AbortError");
    }
    noteInflight.delete(id);
    if (result.ok) {
      seedNoteCache(result.data);
    }
    return result;
  });
  noteInflight.set(id, pending);
  return await pending;
}

export function prefetchNote(id: string): void {
  void loadNote(id)
    .then((result) => {
      if (result.ok) {
        void loadOgCards(result.data.markdown);
      }
    })
    .catch(() => {
      // Prefetch is best effort, including identity invalidation.
    });
}
