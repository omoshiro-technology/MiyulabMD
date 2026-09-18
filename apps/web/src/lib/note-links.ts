import type { WikiLinkMap } from "@miyulabmd/markdown";
import type { NoteLinksResult } from "@miyulabmd/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchNoteLinks } from "./api.ts";

/** Build the preview resolution map: link target → note id (or null). */
export function wikiLinkMapFor(
  result: NoteLinksResult | null,
): WikiLinkMap | undefined {
  if (!(result && Array.isArray(result.outgoing))) {
    return undefined;
  }
  const map: WikiLinkMap = new Map();
  for (const link of result.outgoing) {
    map.set(link.target, link.note?.id ?? null);
  }
  return map;
}

/**
 * Fetch outgoing/backlink data for a note. `refreshKey` (usually the live
 * markdown) re-fetches after a debounce so snapshot reindexing has landed.
 */
export function useNoteLinks(
  noteId: string | undefined,
  viewerId: string | null | undefined,
  refreshKey: string,
) {
  const [data, setData] = useState<NoteLinksResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-fetches after edits settle; tick forces a manual reload.
  useEffect(() => {
    if (!noteId) {
      setData(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    // The server reindexes on snapshot persist (debounced), so wait a moment
    // after the last edit before re-reading the index.
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        void fetchNoteLinks(noteId, {
          signal: controller.signal,
          viewerId: viewerId ?? null,
        }).then(
          (result) => {
            if (controller.signal.aborted) {
              return;
            }
            setLoading(false);
            if (result.ok) {
              setData(result.data);
              setError(null);
            } else {
              setError(result.error);
            }
          },
          () => {
            if (!controller.signal.aborted) {
              setLoading(false);
              setError("リンクを取得できませんでした。");
            }
          },
        );
      },
      tick === 0 ? 0 : 1500,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [noteId, viewerId, refreshKey, tick]);

  return { data, error, loading, reload };
}
