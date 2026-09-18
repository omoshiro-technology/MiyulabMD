import type { GrepMatch, NoteSearchHit } from "@miyulabmd/shared";
import { folderUrl, looksLikeSchemeId } from "@miyulabmd/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { resolveSchemeId, searchWorkspace } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { debounce } from "../../lib/debounce.ts";
import { Input } from "../ui/Input.tsx";
import { MutedText } from "../ui/Text.tsx";

type PaletteItem =
  | { key: string; kind: "note"; note: NoteSearchHit }
  | { key: string; kind: "match"; match: GrepMatch }
  | {
      folder: { id: string; name: string; schemeId: string };
      key: string;
      kind: "folder";
    };

type PaletteState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: PaletteItem[]; truncated: boolean };

function itemToLocation(item: PaletteItem): string {
  if (item.kind === "note") {
    return `/n/${item.note.id}`;
  }
  if (item.kind === "folder") {
    return folderUrl(item.folder.id);
  }
  return `/n/${item.match.noteId}?line=${item.match.line}`;
}

function itemTitle(item: PaletteItem): string {
  if (item.kind === "note") {
    return item.note.title;
  }
  if (item.kind === "folder") {
    return item.folder.name;
  }
  return item.match.title;
}

export function SearchPalette({
  onClose,
  viewerId,
}: {
  onClose: () => void;
  viewerId: string | null;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<PaletteState>({ kind: "idle" });
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useMemo(
    () =>
      debounce((value: string) => {
        const trimmed = value.trim();
        abortRef.current?.abort();
        if (!trimmed) {
          generationRef.current += 1;
          setState({ kind: "idle" });
          return;
        }
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        const controller = new AbortController();
        abortRef.current = controller;
        setState({ kind: "loading" });
        // `15.22` や `202609171230` のような ID は scheme 解決も並走させる。
        const schemeRequest = looksLikeSchemeId(trimmed)
          ? resolveSchemeId(trimmed, {
              signal: controller.signal,
              viewerId,
            }).catch(() => null)
          : Promise.resolve(null);
        void Promise.all([
          searchWorkspace(trimmed, {
            signal: controller.signal,
            viewerId,
          }),
          schemeRequest,
        ]).then(
          ([result, schemeResult]) => {
            if (
              generationRef.current !== generation ||
              controller.signal.aborted
            ) {
              return;
            }
            if (!result.ok) {
              setState({ kind: "error", message: result.error });
              return;
            }
            const items: PaletteItem[] = [
              ...(schemeResult?.ok
                ? [
                    {
                      folder: schemeResult.data.folder,
                      key: `scheme:${schemeResult.data.folder.id}`,
                      kind: "folder" as const,
                    },
                  ]
                : []),
              ...result.data.notes.map((note) => ({
                key: `note:${note.id}`,
                kind: "note" as const,
                note,
              })),
              ...result.data.grep.matches.map((match, index) => ({
                key: `match:${match.noteId}:${match.line}:${index}`,
                kind: "match" as const,
                match,
              })),
            ];
            setState({
              items,
              kind: "ready",
              truncated: result.data.grep.truncated,
            });
            setActive(0);
          },
          (error: unknown) => {
            if (
              controller.signal.aborted ||
              (error instanceof DOMException && error.name === "AbortError")
            ) {
              return;
            }
            if (generationRef.current === generation) {
              setState({
                kind: "error",
                message: "検索できませんでした。",
              });
            }
          },
        );
      }, 200),
    [viewerId],
  );

  useEffect(() => {
    runSearch(query);
  }, [query, runSearch]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      generationRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const items = state.kind === "ready" ? state.items : [];

  function openItem(index: number) {
    const item = items[index];
    if (!item) {
      return;
    }
    onClose();
    navigate(itemToLocation(item));
  }

  function handleListKey(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openItem(active);
    }
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-overlay p-4 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label="検索"
        aria-modal="true"
        className="flex max-h-[min(36rem,calc(var(--app-height,100dvh)*0.8))] w-[min(40rem,100%)] flex-col overflow-hidden rounded-xl bg-canvas shadow-modal"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleListKey}
        role="dialog"
      >
        <div className="border-border border-b p-3">
          <Input
            aria-label="ノートを検索"
            autoFocus={true}
            className="w-full border-0 bg-transparent text-base outline-none focus:ring-0"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="タイトルや本文を検索…"
            value={query}
          />
        </div>
        <div
          aria-label="検索結果"
          className="min-h-0 flex-1 overflow-y-auto p-2"
          ref={listRef}
          role="listbox"
        >
          {state.kind === "loading" && (
            <MutedText className="px-3 py-2">検索中…</MutedText>
          )}
          {state.kind === "error" && (
            <p className="px-3 py-2 text-error" role="alert">
              {state.message}
            </p>
          )}
          {state.kind === "idle" && (
            <MutedText className="px-3 py-2">
              キーワードを入力するとノートを検索します
            </MutedText>
          )}
          {state.kind === "ready" && items.length === 0 && (
            <MutedText className="px-3 py-2">見つかりませんでした</MutedText>
          )}
          {items.map((item, index) => (
            <button
              aria-selected={index === active}
              className={cn(
                "flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 px-3 py-2 text-left",
                index === active
                  ? "bg-surface text-ink"
                  : "bg-transparent text-ink hover:bg-row",
              )}
              data-index={index}
              key={item.key}
              onClick={() => openItem(index)}
              onMouseEnter={() => setActive(index)}
              role="option"
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">
                {itemTitle(item)}
                {item.kind === "folder" && (
                  <span className="ml-2 font-mono text-muted text-xs">
                    フォルダを開く
                  </span>
                )}
                {item.kind === "match" && (
                  <span className="ml-2 text-muted text-xs">
                    {item.match.text.trim()}
                  </span>
                )}
              </span>
              {item.kind === "match" && (
                <span className="shrink-0 font-mono text-muted text-xs">
                  L{item.match.line}
                </span>
              )}
            </button>
          ))}
          {state.kind === "ready" && state.truncated && (
            <MutedText className="px-3 py-2 text-xs">
              結果が多いため一部のみ表示しています
            </MutedText>
          )}
        </div>
        <div className="border-border border-t px-3 py-2">
          <MutedText className="font-mono text-xs">
            "フレーズ" -除外 path: tag: layer: jd: para:
          </MutedText>
        </div>
      </div>
    </div>
  );
}
