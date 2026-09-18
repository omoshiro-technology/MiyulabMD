import {
  EDIT_LOCK_WS_CLOSE_CODE,
  type Note,
  type SessionUser,
} from "@miyulabmd/shared";
import type { MutableRefObject } from "react";
import * as Y from "yjs";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import {
  draftFromNote,
  noteAccessPatch,
} from "../components/notes/access-draft.ts";
import type { ApiResult } from "../lib/api.ts";
import { fetchArticleSources, updateNote } from "../lib/api.ts";
import {
  applyAwarenessUser,
  createYjsSession,
  type YjsSession,
} from "../lib/collaboration.ts";
import { type EditorMode, writeEditorMode } from "../lib/editor-mode.ts";
import { loadOgCards } from "../lib/markdown.ts";
import { noteFromCaches, seedNoteCache } from "../lib/note-cache.ts";

export type NoteSetters = {
  setNote: (note: Note | null) => void;
  setMarkdown: (markdown: string) => void;
  setFolder: (folder: string) => void;
  setAccessDraft: (draft: AccessDraft | null) => void;
};

export function applyLoadedNote(loaded: Note, setters: NoteSetters) {
  setters.setNote(loaded);
  setters.setMarkdown(loaded.markdown);
  setters.setFolder(loaded.folder);
  setters.setAccessDraft(draftFromNote(loaded));
}

export function noteLoadErrorMessage(status: number, fallback: string): string {
  if (status === 401) {
    return "このノートを表示するにはログインが必要です。";
  }
  if (status === 403) {
    return "このノートを表示する権限がありません。";
  }
  if (status === 404) {
    return "ノートが見つかりません。";
  }
  return fallback;
}

type EditorLoadSetters = NoteSetters & {
  setLoadError: (error: string | null) => void;
  setSaveError: (error: string | null) => void;
  setCollab: (session: YjsSession | null) => void;
  setCollabReady: (ready: boolean) => void;
  setMode: (mode: EditorMode) => void;
  setSplitScroll: (ratio: number) => void;
  setLoading: (loading: boolean) => void;
  hydratedRef: MutableRefObject<boolean>;
};

export function beginEditorNoteLoad(
  id: string,
  setters: EditorLoadSetters,
): Note | undefined {
  const hit = noteFromCaches(id);
  setters.setLoadError(null);
  setters.setSaveError(null);
  setters.setCollab(null);
  setters.setCollabReady(false);
  setters.setMode("preview");
  setters.setSplitScroll(0);

  if (hit) {
    applyLoadedNote(hit, setters);
    setters.hydratedRef.current = true;
    setters.setLoading(false);
    void loadOgCards(hit.markdown);
    return hit;
  }
  setters.hydratedRef.current = false;
  setters.setLoading(true);
  return undefined;
}

export function applyEditorNoteLoad(
  result: ApiResult<Note>,
  id: string,
  hit: Note | undefined,
  cancelled: boolean,
  setters: EditorLoadSetters,
) {
  if (cancelled) {
    return;
  }
  if (!result.ok) {
    setters.setLoadError(noteLoadErrorMessage(result.status, result.error));
    if (!noteFromCaches(id)) {
      setters.setNote(null);
    }
    setters.setLoading(false);
    return;
  }

  if (hit) {
    setters.setNote(result.data);
    setters.setFolder(result.data.folder);
    setters.setAccessDraft(draftFromNote(result.data));
  } else {
    applyLoadedNote(result.data, setters);
    setters.hydratedRef.current = true;
  }
  setters.setLoading(false);
  void loadOgCards(result.data.markdown);
}

export function subscribeArticleSources(
  user: SessionUser | null,
  setArticleSources: (
    sources: import("@miyulabmd/shared").ArticleSource[],
  ) => void,
): (() => void) | undefined {
  if (!user) {
    setArticleSources([]);
    return undefined;
  }
  const controller = new AbortController();
  void fetchArticleSources({
    signal: controller.signal,
    viewerId: user.id,
  }).then(
    (result) => {
      if (controller.signal.aborted || !result.ok) {
        return;
      }
      setArticleSources(result.data);
    },
    () => {
      // Aborted or failed source discovery is non-fatal to the editor.
    },
  );
  return () => {
    controller.abort();
  };
}

export function teardownCollab(
  unbindRef: MutableRefObject<(() => void) | null>,
  sessionRef: MutableRefObject<YjsSession | null>,
  setCollab: (session: YjsSession | null) => void,
  setCollabReady: (ready: boolean) => void,
  setOfflineWritable?: (writable: boolean) => void,
) {
  unbindRef.current?.();
  unbindRef.current = null;
  sessionRef.current?.destroy();
  sessionRef.current = null;
  setCollab(null);
  setCollabReady(false);
  setOfflineWritable?.(false);
}

function onCollabSynced(
  synced: boolean,
  session: YjsSession,
  setCollabReady: (ready: boolean) => void,
  setMarkdown: (markdown: string) => void,
) {
  if (!synced) {
    return;
  }
  setCollabReady(true);
  const next = session.yMarkdown.toString();
  if (next.length > 0) {
    setMarkdown(next);
  }
}

export function bindEditorCollab(input: {
  noteId: string | undefined;
  /** 編集キャッシュ（y-indexeddb）の資格判定に使う最新のノートメタデータ。 */
  note: Note | null;
  hydrated: boolean;
  userLoading: boolean;
  viewMode: EditorMode;
  user: SessionUser | null;
  sessionRef: MutableRefObject<YjsSession | null>;
  unbindRef: MutableRefObject<(() => void) | null>;
  setCollab: (session: YjsSession | null) => void;
  setCollabReady: (ready: boolean) => void;
  setMarkdown: (markdown: string) => void;
  setCollabWritable: (writable: boolean) => void;
  /** 編集キャッシュ名空間のユーザー ID（オフライン表示では cacheViewerId）。 */
  editCacheUserId?: string | null;
  /** 表示キャッシュ由来のオフライン編集。編集キャッシュ復元完了を readiness に使う。 */
  offlineEdit?: boolean;
  /**
   * preview 中でもセッションを先行作成し、同期済み Y.Doc を編集キャッシュに
   * 乗せる。オフライン編集資格のあるノートを開くだけでオフライン編集可能に
   * なる温め処理。preview でもコネクションを維持する。
   */
  warmup?: boolean;
  /** オフライン編集でローカル Y.Doc への書き込みが可能になったことを通知する。 */
  setOfflineWritable?: (writable: boolean) => void;
  /** Server revoked edit access mid-session (edit lock engaged). */
  onEditLocked?: () => void;
}) {
  if (!(input.noteId && input.hydrated) || input.userLoading) {
    return;
  }
  // preview ではセッションを持たない。ただし warmup 指定時は preview の
  // まま接続だけ張り、初回 sync で編集キャッシュへ永続化させる。
  if (input.viewMode === "preview" && input.warmup !== true) {
    teardownCollab(
      input.unbindRef,
      input.sessionRef,
      input.setCollab,
      input.setCollabReady,
      input.setOfflineWritable,
    );
    return;
  }
  if (input.sessionRef.current) {
    return;
  }

  const session = createYjsSession(input.noteId, input.user, {
    note: input.note,
    userId: input.editCacheUserId ?? input.user?.id ?? null,
  });
  input.sessionRef.current = session;
  input.setCollab(session);
  input.setCollabReady(false);

  const onSynced = (synced: boolean) => {
    input.setCollabWritable(session.provider.wsconnected && synced);
    onCollabSynced(synced, session, input.setCollabReady, input.setMarkdown);
  };
  const onStatus = () => {
    input.setCollabWritable(editorSessionWritable(session));
  };
  const onClosed = (event: { code: number; reason: string }) => {
    // A 4400-4499 close is terminal: the server will not accept writes on a
    // reconnection either, so flip the note into its locked read-only state.
    if (event.code === EDIT_LOCK_WS_CLOSE_CODE) {
      input.onEditLocked?.();
    }
  };

  session.provider.on("sync", onSynced);
  session.provider.on("status", onStatus);
  session.provider.on("closed", onClosed);
  if (session.provider.synced) {
    onSynced(true);
  }

  // オフライン編集では WebSocket 同期を待たず、編集キャッシュ（y-indexeddb）
  // の復元完了をもってローカル Y.Doc への書き込みを許可する。
  const editCachePersistence = session.editCache?.persistence;
  if (input.offlineEdit && editCachePersistence) {
    void editCachePersistence.whenSynced.then(
      () => {
        if (input.sessionRef.current !== session) {
          return;
        }
        const next = session.yMarkdown.toString();
        // 復元 doc に一切の update が永続化されていない（state vector が空）
        // のに表示スナップショットに本文があるときは、同期済みマーカーだけ
        // 残って編集キャッシュが失われた可能性が高い。空 doc への編集は後の
        // マージで本文を二重化・置換しうるため書き込みを開放せず、オンライン
        // 再同期を待つ。本文を空にした履歴がある doc は state vector が空で
        // ないためこのガードにはかからない。
        if (
          Y.decodeStateVector(Y.encodeStateVector(session.doc)).size === 0 &&
          (input.note?.markdown.length ?? 0) > 0
        ) {
          return;
        }
        input.setCollabReady(true);
        if (next.length > 0) {
          input.setMarkdown(next);
        }
        input.setOfflineWritable?.(true);
      },
      () => undefined,
    );
  }

  const onMarkdownChange = () => {
    input.setMarkdown(session.yMarkdown.toString());
  };
  session.yMarkdown.observe(onMarkdownChange);
  input.unbindRef.current = () => {
    session.provider.off("sync", onSynced);
    session.provider.off("status", onStatus);
    session.provider.off("closed", onClosed);
    session.yMarkdown.unobserve(onMarkdownChange);
  };
}

export function editorSessionWritable(session: YjsSession | null): boolean {
  return !session || (session.provider.wsconnected && session.provider.synced);
}

export function syncCollabUser(
  collab: YjsSession | null,
  user: SessionUser | null,
) {
  if (!collab) {
    return;
  }
  collab.setUser(user);
  applyAwarenessUser(collab.awareness, user);
}

type MutationSetters = {
  // Dispatch permission is transient; completion ownership survives a pause.
  canStart: () => boolean;
  isCurrent: () => boolean;
  setSaveError: (error: string | null) => void;
  setNote: (note: Note) => void;
};

export async function persistEditorAccess(
  note: Note | null,
  next: AccessDraft,
  setters: MutationSetters & { setAccessDraft: (draft: AccessDraft) => void },
) {
  if (!(note && setters.isCurrent() && setters.canStart())) {
    return;
  }
  setters.setAccessDraft(next);
  setters.setSaveError(null);

  let result: Awaited<ReturnType<typeof updateNote>>;
  try {
    result = await updateNote(note.id, noteAccessPatch(next));
  } catch (error) {
    if (setters.isCurrent()) {
      setters.setAccessDraft(draftFromNote(note));
      setters.setSaveError(
        error instanceof Error ? error.message : "保存できませんでした。",
      );
    }
    return;
  }
  if (!setters.isCurrent()) {
    return;
  }
  if (!result.ok) {
    setters.setSaveError(result.error);
    setters.setAccessDraft(draftFromNote(note));
    return;
  }
  setters.setNote(result.data);
  setters.setAccessDraft(draftFromNote(result.data));
  seedNoteCache(result.data);
}

export async function persistEditorFolder(
  note: Note | null,
  folder: string,
  normalizeFolder: (value: string) => string,
  setters: MutationSetters & {
    setFolder: (folder: string) => void;
    setAccessDraft: (draft: AccessDraft) => void;
  },
) {
  if (!(note && setters.isCurrent() && setters.canStart())) {
    return;
  }
  const next = normalizeFolder(folder);
  if (next === note.folder) {
    return;
  }

  let result: Awaited<ReturnType<typeof updateNote>>;
  try {
    result = await updateNote(note.id, { folder: next });
  } catch (error) {
    if (setters.isCurrent()) {
      setters.setFolder(note.folder);
      setters.setSaveError(
        error instanceof Error ? error.message : "保存できませんでした。",
      );
    }
    return;
  }
  if (!setters.isCurrent()) {
    return;
  }
  if (!result.ok) {
    setters.setFolder(note.folder);
    setters.setSaveError(result.error);
    return;
  }
  setters.setNote(result.data);
  setters.setFolder(result.data.folder);
  setters.setAccessDraft(draftFromNote(result.data));
  seedNoteCache(result.data);
}

export function changeEditorMode(
  canEdit: boolean,
  next: EditorMode,
  setMode: (mode: EditorMode) => void,
) {
  if (!canEdit && next !== "preview") {
    return;
  }
  setMode(next);
  writeEditorMode(next);
}

export function applySplitScroll(
  ratio: number,
  lock: MutableRefObject<boolean>,
  setSplitScroll: (ratio: number) => void,
) {
  if (lock.current) {
    return;
  }
  lock.current = true;
  setSplitScroll(ratio);
  window.requestAnimationFrame(() => {
    lock.current = false;
  });
}

export function editorGridClass(
  viewMode: EditorMode,
  usesInternalScroll: boolean,
  cn: (...inputs: Array<string | false | undefined>) => string,
): string {
  return cn(
    "grid min-h-0 flex-1 [&>*]:min-h-0",
    viewMode === "split" &&
      "grid-cols-2 max-[900px]:grid-cols-1 [&>:first-child]:border-r [&>:first-child]:border-border",
    viewMode !== "split" && "grid-cols-1",
    viewMode === "preview" && "block",
    usesInternalScroll && "overflow-hidden",
  );
}

export function sourceLineNumbers(viewMode: EditorMode): boolean {
  return viewMode === "source" || viewMode === "split";
}

export function ownerLabelFor(user: SessionUser | null): string {
  return user?.displayName?.trim() || user?.email || "オーナー";
}
