import type {
  NoteEditEvent,
  NoteHistoryPage,
  SessionUser,
} from "@miyulabmd/shared";
import { useEffect, useRef, useState } from "react";
import {
  type ApiResult,
  fetchNoteHistory,
  fetchNoteRevision,
  restoreNoteRevision,
} from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import {
  formatHistoryOp,
  formatHistoryRange,
  formatHistoryWhen,
} from "../../lib/note-history.ts";
import { Button } from "../ui/Button.tsx";
import { Modal, ModalHeader } from "../ui/Modal.tsx";
import { ErrorText, MutedText } from "../ui/Text.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

type Props = {
  noteId: string;
  user: SessionUser | null;
  canEdit: boolean;
  onClose: () => void;
};

export function HistoryPanel({ noteId, user, canEdit, onClose }: Props) {
  const lifetime = useRef<AbortController | null>(null);
  const [events, setEvents] = useState<NoteEditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewHint, setPreviewHint] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  function publishHistory(
    result: ApiResult<NoteHistoryPage>,
    selectFirst: boolean,
    before?: number,
  ) {
    if (!result.ok) {
      setListError(result.error);
      return;
    }
    const data = result.data;
    setEvents((current) =>
      before === undefined ? data.events : [...current, ...data.events],
    );
    setNextBefore(data.nextBefore);
    if (selectFirst) {
      setSelectedId(data.events[0]?.id ?? null);
    }
  }

  async function loadHistory(selectFirst: boolean, before?: number) {
    const controller = lifetime.current;
    if (!controller) {
      return;
    }
    const setPending = before === undefined ? setLoadingList : setLoadingMore;
    setPending(true);
    setListError(null);
    try {
      const result = await fetchNoteHistory(
        noteId,
        { before, limit: 30 },
        { signal: controller.signal, viewerId: user?.id ?? null },
      );
      if (controller.signal.aborted) {
        return;
      }
      publishHistory(result, selectFirst, before);
    } catch {
      if (!controller.signal.aborted) {
        setListError("履歴を取得できませんでした。");
      }
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setEvents([]);
    setSelectedId(null);
    setPreview(null);
    setLoadingMore(false);
    setLoadingList(true);
    setListError(null);
    setConfirming(false);
    setRestoreError(null);
    setRestoreNotice(null);
    void fetchNoteHistory(
      noteId,
      { limit: 30 },
      { signal: controller.signal, viewerId: user?.id ?? null },
    ).then(
      (result) => {
        if (controller.signal.aborted) {
          return;
        }
        setLoadingList(false);
        if (!result.ok) {
          setListError(result.error);
          return;
        }
        setEvents(result.data.events);
        setNextBefore(result.data.nextBefore);
        setSelectedId(result.data.events[0]?.id ?? null);
      },
      () => {
        if (!controller.signal.aborted) {
          setListError("履歴を取得できませんでした。");
          setLoadingList(false);
        }
      },
    );
    return () => {
      if (lifetime.current === controller) {
        lifetime.current = null;
      }
      controller.abort();
    };
  }, [noteId, user?.id]);

  const selected = events.find((event) => event.id === selectedId) ?? null;
  const selectedRevisionId = selected?.revisionId ?? null;

  useEffect(() => {
    if (!selectedId) {
      setLoadingPreview(false);
      setPreview(null);
      setPreviewHint(null);
      setPreviewError(null);
      return;
    }
    if (!selectedRevisionId) {
      setLoadingPreview(false);
      setPreview(null);
      setPreviewHint("この時点の本文は残っていません。");
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoadingPreview(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewHint(null);
    void fetchNoteRevision(noteId, selectedRevisionId, {
      signal: controller.signal,
      viewerId: user?.id ?? null,
    }).then(
      (result) => {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setLoadingPreview(false);
        if (!result.ok) {
          setPreview(null);
          setPreviewError(result.error);
          return;
        }
        setPreview(result.data.markdown);
      },
      () => {
        if (!controller.signal.aborted) {
          setLoadingPreview(false);
          setPreviewError("プレビューを取得できませんでした。");
        }
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [noteId, selectedId, selectedRevisionId, user?.id]);

  return (
    <Modal
      className="flex h-[min(40rem,calc(var(--app-height,100dvh)*0.9))] w-[min(56rem,100%)] max-h-none flex-col"
      labelledBy="note-history-title"
      onClose={onClose}
      overflow="hidden"
    >
      <ModalHeader id="note-history-title" onClose={onClose} title="編集履歴" />
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,38%)_minmax(0,1fr)] gap-3 min-[720px]:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] min-[720px]:grid-rows-none">
        <HistoryEventList
          events={events}
          listError={listError}
          loadingList={loadingList}
          loadingMore={loadingMore}
          nextBefore={nextBefore}
          onLoadMore={() => {
            if (nextBefore !== null) {
              void loadHistory(false, nextBefore);
            }
          }}
          onSelect={(id) => {
            setSelectedId(id);
            setConfirming(false);
            setRestoreError(null);
          }}
          selectedId={selectedId}
        />
        <section className="flex min-h-0 flex-col overflow-hidden">
          {selected && (
            <MutedText className="mb-2 shrink-0">
              {formatHistoryWhen(selected.endedAt)} · {selected.actor.name}
            </MutedText>
          )}
          <HistoryPreview
            loadingList={loadingList}
            loadingPreview={loadingPreview}
            preview={preview}
            previewError={previewError}
            previewHint={previewHint}
            selected={Boolean(selected)}
          />
          {canEdit && selectedRevisionId && (
            <HistoryRestoreActions
              confirming={confirming}
              onCancel={() => setConfirming(false)}
              onConfirm={() => setConfirming(true)}
              onRestore={() => {
                const controller = lifetime.current;
                if (!controller || controller.signal.aborted) {
                  return;
                }
                void (async () => {
                  setRestoring(true);
                  setRestoreError(null);
                  const result = await restoreNoteRevision(
                    noteId,
                    selectedRevisionId,
                  );
                  if (controller.signal.aborted) {
                    return;
                  }
                  setRestoring(false);
                  if (!result.ok) {
                    setRestoreError(result.error);
                    return;
                  }
                  setConfirming(false);
                  setRestoreNotice(result.data.message);
                  await loadHistory(true);
                })().catch(() => {
                  if (!controller.signal.aborted) {
                    setRestoring(false);
                    setRestoreError("履歴を復元できませんでした。");
                  }
                });
              }}
              restoreError={restoreError}
              restoreNotice={restoreNotice}
              restoring={restoring}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}

function HistoryEventList({
  events,
  listError,
  loadingList,
  loadingMore,
  nextBefore,
  onLoadMore,
  onSelect,
  selectedId,
}: {
  events: NoteEditEvent[];
  listError: string | null;
  loadingList: boolean;
  loadingMore: boolean;
  nextBefore: number | null;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden border-b border-border pb-3 min-[720px]:border-r min-[720px]:border-b-0 min-[720px]:pr-3 min-[720px]:pb-0">
      <div className="min-h-0 flex-1 overflow-auto">
        {loadingList && <MutedText>読み込み中…</MutedText>}
        {listError && <ErrorText>{listError}</ErrorText>}
        {!loadingList && events.length === 0 && !listError && (
          <MutedText>まだ履歴はありません。</MutedText>
        )}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {events.map((event) => (
            <HistoryEventItem
              active={event.id === selectedId}
              event={event}
              key={event.id}
              onSelect={onSelect}
            />
          ))}
        </ul>
        {nextBefore !== null && (
          <Button
            className="mt-2 w-full"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "読み込み中…" : "さらに表示"}
          </Button>
        )}
      </div>
    </section>
  );
}

function HistoryEventItem({
  active,
  event,
  onSelect,
}: {
  active: boolean;
  event: NoteEditEvent;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        aria-current={active ? "true" : undefined}
        className={cn(
          "w-full rounded-lg border px-3 py-2 text-left",
          active
            ? "border-accent bg-fill"
            : "border-transparent hover:bg-fill-hover",
        )}
        onClick={() => onSelect(event.id)}
        type="button"
      >
        <p className="m-0 text-[0.85rem] font-medium">
          {formatHistoryWhen(event.endedAt)}
        </p>
        <p className="m-0 text-[0.8rem] text-muted">
          {event.actor.name}
          {" · "}
          {formatHistoryOp(event.op)}
          {" · "}
          {formatHistoryRange(event.startOffset, event.endOffset)}
        </p>
        {event.excerpt && (
          <p className="m-0 mt-1 line-clamp-2 text-[0.8rem] text-ink">
            {event.excerpt}
          </p>
        )}
      </button>
    </li>
  );
}

function HistoryPreview({
  loadingList,
  loadingPreview,
  preview,
  previewError,
  previewHint,
  selected,
}: {
  loadingList: boolean;
  loadingPreview: boolean;
  preview: string | null;
  previewError: string | null;
  previewHint: string | null;
  selected: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {loadingPreview && <MutedText>プレビューを読み込み中…</MutedText>}
      {previewError && <ErrorText>{previewError}</ErrorText>}
      {previewHint && <MutedText>{previewHint}</MutedText>}
      {preview !== null && (
        <MarkdownPreview documentScroll={true} markdown={preview} />
      )}
      {!(selected || loadingList) && (
        <MutedText>履歴を選ぶと、その時点の本文を表示します。</MutedText>
      )}
    </div>
  );
}

function HistoryRestoreActions({
  confirming,
  onCancel,
  onConfirm,
  onRestore,
  restoreError,
  restoreNotice,
  restoring,
}: {
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRestore: () => void;
  restoreError: string | null;
  restoreNotice: string | null;
  restoring: boolean;
}) {
  return (
    <div className="mt-3 shrink-0 border-t border-border pt-3">
      {restoreNotice && <MutedText className="mb-2">{restoreNotice}</MutedText>}
      {restoreError && <ErrorText>{restoreError}</ErrorText>}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <MutedText>
            今の本文をこの版で置き換えます。同時に編集していた内容は上書きされます。
          </MutedText>
          <div className="flex flex-wrap gap-2">
            <Button disabled={restoring} onClick={onRestore} variant="danger">
              {restoring ? "復元中…" : "置き換える"}
            </Button>
            <Button disabled={restoring} onClick={onCancel}>
              キャンセル
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={onConfirm}>この版に戻す</Button>
      )}
    </div>
  );
}
