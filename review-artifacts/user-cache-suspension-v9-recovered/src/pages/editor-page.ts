import type { Note, SessionUser } from "@miyulabmd/shared";
import type { MutableRefObject } from "react";
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
) {
  unbindRef.current?.();
  unbindRef.current = null;
  sessionRef.current?.destroy();
  sessionRef.current = null;
  setCollab(null);
  setCollabReady(false);
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
}) {
  if (!(input.noteId && input.hydrated) || input.userLoading) {
    return;
  }
  if (input.viewMode === "preview") {
    teardownCollab(
      input.unbindRef,
      input.sessionRef,
      input.setCollab,
      input.setCollabReady,
    );
    return;
  }
  if (input.sessionRef.current) {
    return;
  }

  const session = createYjsSession(input.noteId, input.user);
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

  session.provider.on("sync", onSynced);
  session.provider.on("status", onStatus);
  if (session.provider.synced) {
    onSynced(true);
  }

  const onMarkdownChange = () => {
    input.setMarkdown(session.yMarkdown.toString());
  };
  session.yMarkdown.observe(onMarkdownChange);
  input.unbindRef.current = () => {
    session.provider.off("sync", onSynced);
    session.provider.off("status", onStatus);
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
