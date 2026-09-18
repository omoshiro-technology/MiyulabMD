import type { ArticleSource, Note } from "@miyulabmd/shared";
import {
  matchArticleSource,
  normalizeFolder,
  titleFromMarkdown,
  validateArticleDocument,
} from "@miyulabmd/shared";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, useOutletContext, useParams } from "react-router";
import { EditorModeSwitch } from "../components/editor/EditorModeSwitch.tsx";
import { FolderPopover } from "../components/editor/FolderPopover.tsx";
import { HistoryPanel } from "../components/editor/HistoryPanel.tsx";
import { MarkdownEditor } from "../components/editor/MarkdownEditor.tsx";
import { MarkdownPreview } from "../components/editor/MarkdownPreview.tsx";
import { PresenceBar } from "../components/editor/PresenceBar.tsx";
import { PreviewWithToc } from "../components/editor/PreviewWithToc.tsx";
import { RichMarkdownEditor } from "../components/editor/RichMarkdownEditor.tsx";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import { ArticleFrontmatterAlert } from "../components/notes/ArticleFrontmatterAlert.tsx";
import { draftFromNote } from "../components/notes/access-draft.ts";
import { ShareModal } from "../components/notes/ShareModal.tsx";
import { HeaderButton } from "../components/ui/HeaderButton.tsx";
import { HistoryIcon, ShareIcon } from "../components/ui/icons.tsx";
import { editorLoadingClass } from "../components/ui/prose.ts";
import { ErrorText } from "../components/ui/Text.tsx";
import { cn } from "../lib/cn.ts";
import type { YjsSession } from "../lib/collaboration.ts";
import type { EditorMode } from "../lib/editor-mode.ts";
import {
  dismissStaleSsrPreview,
  removeSsrPreview,
} from "../lib/note-bootstrap.ts";
import {
  createNoteReadSession,
  type NoteReadResult,
  noteDenialMessage,
  OfflineNoteUnavailableError,
} from "../lib/note-read-session.ts";
import type { ImageViewContext } from "../lib/preview-images.ts";
import {
  applySplitScroll,
  bindEditorCollab,
  changeEditorMode,
  editorGridClass,
  editorSessionWritable,
  ownerLabelFor,
  persistEditorAccess,
  persistEditorFolder,
  sourceLineNumbers,
  subscribeArticleSources,
  syncCollabUser,
  teardownCollab,
} from "./editor-page.ts";

function EditorLoadError({ message }: { message: string }) {
  const showAuthLinks =
    message.includes("ログイン") || message.includes("権限");
  return (
    <section className="flex flex-col px-5 py-4">
      <ErrorText>{message}</ErrorText>
      {showAuthLinks && (
        <p>
          <Link to="/">ホームに戻る</Link>
          {" · "}
          <a href="/auth/login">ログイン</a>
        </p>
      )}
    </section>
  );
}

function EditorSourcePane({
  ready,
  yMarkdown,
  awareness,
  noteId,
  canEdit,
  viewMode,
  splitScroll,
  onSplitScroll,
}: {
  ready: boolean;
  yMarkdown: YjsSession["yMarkdown"] | undefined;
  awareness: YjsSession["awareness"] | undefined;
  noteId: string;
  canEdit: boolean;
  viewMode: EditorMode;
  splitScroll: number;
  onSplitScroll: (ratio: number) => void;
}) {
  if (ready && yMarkdown && awareness) {
    return (
      <MarkdownEditor
        awareness={awareness}
        lineNumbers={sourceLineNumbers(viewMode)}
        noteId={noteId}
        onScrollRatio={viewMode === "split" ? onSplitScroll : undefined}
        readOnly={!canEdit}
        scrollRatio={viewMode === "split" ? splitScroll : undefined}
        yText={yMarkdown}
      />
    );
  }
  return (
    <div className={editorLoadingClass}>
      <p>共同編集に接続中…</p>
    </div>
  );
}

function EditorPreviewPane({
  viewMode,
  markdown,
  splitScroll,
  onSplitScroll,
  taskNoteId,
  imageContext,
}: {
  viewMode: EditorMode;
  markdown: string;
  splitScroll: number;
  onSplitScroll: (ratio: number) => void;
  taskNoteId?: string;
  imageContext?: ImageViewContext;
}) {
  if (viewMode === "preview") {
    return (
      <PreviewWithToc
        documentScroll={true}
        imageContext={imageContext}
        markdown={markdown}
        taskNoteId={taskNoteId}
      />
    );
  }
  return (
    <MarkdownPreview
      imageContext={imageContext}
      markdown={markdown}
      onScrollRatio={onSplitScroll}
      scrollRatio={splitScroll}
    />
  );
}

function EditorRichPane({
  ready,
  yMarkdown,
  awareness,
  noteId,
  canEdit,
}: {
  ready: boolean;
  yMarkdown: YjsSession["yMarkdown"] | undefined;
  awareness: YjsSession["awareness"] | undefined;
  noteId: string;
  canEdit: boolean;
}) {
  if (ready && yMarkdown && awareness) {
    return (
      <RichMarkdownEditor
        awareness={awareness}
        key={noteId}
        noteId={noteId}
        readOnly={!canEdit}
        yText={yMarkdown}
      />
    );
  }
  return (
    <div className={editorLoadingClass}>
      <p>共同編集に接続中…</p>
    </div>
  );
}

function EditorShareDialog({
  shareOpen,
  headingTitle,
  noteId,
  user,
  accessDraft,
  canEdit,
  isOwner,
  saveError,
  onChange,
  onClose,
}: {
  shareOpen: boolean;
  headingTitle: string;
  noteId: string;
  user: AppShellContext["user"];
  accessDraft: AccessDraft;
  canEdit: boolean;
  isOwner: boolean;
  saveError: string | null;
  onChange: (next: AccessDraft) => void;
  onClose: () => void;
}) {
  if (!shareOpen) {
    return null;
  }
  return (
    <ShareModal
      disabled={!(isOwner && canEdit)}
      error={saveError}
      inheritLabel="ディレクトリの設定に従う"
      linkUrl={`${window.location.origin}/n/${noteId}`}
      onChange={onChange}
      onClose={onClose}
      ownerLabel={ownerLabelFor(user)}
      showInherit={isOwner}
      title={headingTitle}
      value={accessDraft}
    />
  );
}

function EditorWorkspace({
  note,
  markdown,
  imageContext,
  accessDraft,
  saveError,
  articleSource,
  articleIssues,
  viewMode,
  usesInternalScroll,
  ready,
  yMarkdown,
  awareness,
  canEdit,
  splitScroll,
  shareOpen,
  historyOpen,
  headingTitle,
  user,
  isOwner,
  onSplitScroll,
  onPersistAccess,
  onCloseShare,
  onCloseHistory,
}: {
  note: Note;
  markdown: string;
  imageContext?: ImageViewContext;
  accessDraft: AccessDraft;
  saveError: string | null;
  articleSource: ArticleSource | null;
  articleIssues: ReturnType<typeof validateArticleDocument>["issues"];
  viewMode: EditorMode;
  usesInternalScroll: boolean;
  ready: boolean;
  yMarkdown: YjsSession["yMarkdown"] | undefined;
  awareness: YjsSession["awareness"] | undefined;
  canEdit: boolean;
  splitScroll: number;
  shareOpen: boolean;
  historyOpen: boolean;
  headingTitle: string;
  user: AppShellContext["user"];
  isOwner: boolean;
  onSplitScroll: (ratio: number) => void;
  onPersistAccess: (next: AccessDraft) => void;
  onCloseShare: () => void;
  onCloseHistory: () => void;
}) {
  const showSource = viewMode === "split" || viewMode === "source";
  const showPreview = viewMode === "split" || viewMode === "preview";
  const showRich = viewMode === "rich";
  return (
    <section
      className={cn("flex flex-col", usesInternalScroll && "h-full min-h-0")}
    >
      {saveError && <ErrorText className="px-5 py-4">{saveError}</ErrorText>}
      {articleSource && <ArticleFrontmatterAlert issues={articleIssues} />}
      <div className={editorGridClass(viewMode, usesInternalScroll, cn)}>
        {showSource && (
          <EditorSourcePane
            awareness={awareness}
            canEdit={canEdit}
            noteId={note.id}
            onSplitScroll={onSplitScroll}
            ready={ready}
            splitScroll={splitScroll}
            viewMode={viewMode}
            yMarkdown={yMarkdown}
          />
        )}
        {showPreview && (
          <EditorPreviewPane
            imageContext={imageContext}
            markdown={markdown}
            onSplitScroll={onSplitScroll}
            splitScroll={splitScroll}
            taskNoteId={canEdit ? note.id : undefined}
            viewMode={viewMode}
          />
        )}
        {showRich && (
          <EditorRichPane
            awareness={awareness}
            canEdit={canEdit}
            noteId={note.id}
            ready={ready}
            yMarkdown={yMarkdown}
          />
        )}
      </div>
      <EditorShareDialog
        accessDraft={accessDraft}
        canEdit={canEdit}
        headingTitle={headingTitle}
        isOwner={isOwner}
        noteId={note.id}
        onChange={onPersistAccess}
        onClose={onCloseShare}
        saveError={saveError}
        shareOpen={shareOpen}
        user={user}
      />
      {historyOpen && (
        <HistoryPanel
          canEdit={canEdit}
          noteId={note.id}
          onClose={onCloseHistory}
          user={user}
        />
      )}
    </section>
  );
}

function EditorPageView({
  loading,
  loadError,
  paused,
  readSource,
  cachedAt,
  note,
  accessDraft,
  workspace,
}: {
  loading: boolean;
  loadError: string | null;
  paused: boolean;
  readSource: "pending" | "network" | "cache";
  cachedAt: number | null;
  note: Note | null;
  accessDraft: AccessDraft | null;
  workspace: ReactNode;
}) {
  if (loading) {
    return (
      <section className="flex flex-col px-5 py-4">
        <p>読み込み中…</p>
      </section>
    );
  }
  if (loadError) {
    return <EditorLoadError message={loadError} />;
  }
  if (!(note && accessDraft)) {
    return null;
  }
  return (
    <>
      {readSource === "cache" && cachedAt !== null && (
        <p className="px-5 py-2" role="status">
          オフラインキャッシュを表示中（保存日時:{" "}
          {new Date(cachedAt).toLocaleString("ja-JP")})。閲覧のみです。
        </p>
      )}
      {paused && (
        <p className="px-5 py-2" role="status">
          共同編集の接続が切れました。入力済みの内容はこの画面に保持しています。
          再接続・再同期が完了するまで編集できません。
        </p>
      )}
      {workspace}
    </>
  );
}

function EditorHeaderEnd({
  awareness,
  folder,
  folderId,
  isOwner,
  onFolderChange,
  onFolderBlur,
  onHistory,
  onShare,
}: {
  awareness: YjsSession["awareness"] | undefined;
  folder: string;
  folderId: string | null;
  isOwner: boolean;
  onFolderChange: (folder: string) => void;
  onFolderBlur: () => void;
  onHistory: () => void;
  onShare: () => void;
}) {
  return (
    <>
      {awareness && <PresenceBar awareness={awareness} />}
      <FolderPopover
        folder={folder}
        folderId={folderId}
        isOwner={isOwner}
        onFolderBlur={onFolderBlur}
        onFolderChange={onFolderChange}
      />
      <HeaderButton icon={<HistoryIcon />} label="履歴" onClick={onHistory} />
      <HeaderButton
        icon={<ShareIcon />}
        label="共有"
        onClick={onShare}
        variant="accent"
      />
    </>
  );
}

function ownerFlags(user: AppShellContext["user"], note: Note | null) {
  return {
    canEdit: Boolean(note?.access.flags.canEdit),
    isOwner: Boolean(user && note && user.id === note.ownerId),
  };
}

function articleIssuesFor(
  articleSource: ArticleSource | null,
  markdown: string,
) {
  if (!articleSource) {
    return [];
  }
  return validateArticleDocument(articleSource.schema, markdown).issues;
}

type EditorReadState = {
  id: string;
  ownerViewer: AppShellContext["viewer"];
  phase: "pending" | "success" | "error";
  result?: Extract<NoteReadResult, { ok: true }>;
};

function sameViewer(
  left: AppShellContext["viewer"],
  right: AppShellContext["viewer"],
) {
  return (
    left.mode === right.mode &&
    left.cacheViewerId === right.cacheViewerId &&
    left.user?.id === right.user?.id
  );
}

export function EditorPage() {
  const { id = "" } = useParams();
  const { user, userLoading, viewer, viewing, setHeader } =
    useOutletContext<AppShellContext>();
  const [note, setNote] = useState<Note | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [folder, setFolder] = useState("");
  const [accessDraft, setAccessDraft] = useState<AccessDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [readState, setReadState] = useState<EditorReadState>({
    id: "",
    ownerViewer: viewer,
    phase: "pending",
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collab, setCollab] = useState<YjsSession | null>(null);
  const [collabReady, setCollabReady] = useState(false);
  const [collabWritable, setCollabWritable] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [articleSources, setArticleSources] = useState<ArticleSource[]>([]);
  const [mode, setMode] = useState<EditorMode>("preview");
  const [splitScroll, setSplitScroll] = useState(0);
  const splitScrollLock = useRef(false);
  const hydratedRef = useRef(false);
  const sessionRef = useRef<YjsSession | null>(null);
  const unbindCollabRef = useRef<(() => void) | null>(null);
  const [viewScope, setViewScope] = useState<{
    isCurrent: () => boolean;
  } | null>(null);

  const noteId = note?.id;
  const userId = user?.id;
  const currentReadState =
    readState.id === id && sameViewer(readState.ownerViewer, viewer)
      ? readState
      : null;
  const readSource =
    currentReadState?.phase === "success"
      ? (currentReadState.result?.source ?? "pending")
      : "pending";
  const cachedAt =
    currentReadState?.phase === "success"
      ? (currentReadState.result?.cachedAt ?? null)
      : null;
  const flags = ownerFlags(user, note);
  const readReady = currentReadState?.phase === "success" && !loading;
  const canEdit = flags.canEdit && readSource === "network" && readReady;
  const viewMode: EditorMode = canEdit ? mode : "preview";
  const usesInternalScroll = viewMode !== "preview";
  const headingTitle = titleFromMarkdown(markdown);
  const articleSource = matchArticleSource(folder, articleSources);
  const articleIssues = articleIssuesFor(articleSource, markdown);
  const awareness = collab?.awareness;
  const yMarkdown = collab?.yMarkdown;
  const ready = Boolean(yMarkdown && awareness && collabReady);
  // Read readiness is sticky for this session: a disconnect must not unmount
  // the editor or replace its local document with the network/cache snapshot.
  const paused = ready && !collabWritable;
  const canMutate = canEdit && !paused;

  useLayoutEffect(() => {
    hydratedRef.current = false;
    setReadState({ id, ownerViewer: viewer, phase: "pending" });
    setLoading(true);
    setLoadError(null);
    setNote(null);
    setAccessDraft(null);
    setMarkdown("");
    setFolder("");
    setMode("preview");
    setViewScope(null);
    setShareOpen(false);
    setHistoryOpen(false);
    setSaveError(null);
  }, [id, viewer]);

  useEffect(() => {
    dismissStaleSsrPreview(id);
    if (userLoading) {
      return;
    }
    const scope = viewing.beginView(viewer);
    setViewScope(scope);
    let cancelled = false;
    if (viewer.mode === "unavailable") {
      setReadState({ id, ownerViewer: viewer, phase: "error" });
      setLoading(false);
      setLoadError(
        "閲覧情報を確認できません。しばらくしてから再度お試しください。",
      );
      return () => {
        cancelled = true;
        setViewScope(null);
        scope.dispose();
      };
    }
    let settled = false;
    const session = createNoteReadSession(viewer, {
      onDenied: (event) => {
        if (cancelled || !scope.isCurrent()) {
          return;
        }
        if (settled) {
          scope.dispose();
          setViewScope(null);
        }
        teardownCollab(unbindCollabRef, sessionRef, setCollab, setCollabReady);
        hydratedRef.current = false;
        setReadState({ id, ownerViewer: viewer, phase: "error" });
        setNote(null);
        setAccessDraft(null);
        setMarkdown("");
        setShareOpen(false);
        setHistoryOpen(false);
        setLoading(false);
        setLoadError(noteDenialMessage(event));
      },
    });
    setLoading(true);
    setLoadError(null);
    void session.read(id).then(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: read publication and stale-scope guards are intentionally explicit.
      (result: NoteReadResult) => {
        settled = true;
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          if (!scope.publish({ source: "pending", viewer })) {
            return;
          }
          hydratedRef.current = false;
          setReadState({ id, ownerViewer: viewer, phase: "error" });
          setNote(null);
          setAccessDraft(null);
          setLoading(false);
          setLoadError(
            result.cacheWarning
              ? `${result.error} ${result.cacheWarning}`
              : result.error,
          );
          return;
        }
        if (!scope.publish({ source: result.source, viewer: result.viewer })) {
          return;
        }
        hydratedRef.current = result.source === "network";
        setReadState({ id, ownerViewer: viewer, phase: "success", result });
        setNote(result.data);
        setMarkdown(result.data.markdown);
        setFolder(result.data.folder);
        setAccessDraft(draftFromNote(result.data));
        setLoading(false);
      },
      (error: unknown) => {
        settled = true;
        if (cancelled || !scope.publish({ source: "pending", viewer })) {
          return;
        }
        hydratedRef.current = false;
        setReadState({ id, ownerViewer: viewer, phase: "error" });
        setNote(null);
        setAccessDraft(null);
        setLoading(false);
        let message = "ノートを読み込めませんでした。";
        if (error instanceof OfflineNoteUnavailableError) {
          message = "このノートはオフラインキャッシュに保存されていません。";
        } else if (error instanceof Error) {
          message = error.message;
        }
        setLoadError(message);
      },
    );
    return () => {
      cancelled = true;
      session.dispose();
      setViewScope(null);
      scope.dispose();
    };
  }, [id, userLoading, viewer, viewing]);

  useEffect(() => subscribeArticleSources(user, setArticleSources), [user]);

  useLayoutEffect(() => {
    dismissStaleSsrPreview(id);
    if (!loading) {
      removeSsrPreview();
    }
  }, [id, loading]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!usesInternalScroll) {
      root.classList.remove("editor-lock-viewport");
      return;
    }
    root.classList.add("editor-lock-viewport");
    return () => {
      root.classList.remove("editor-lock-viewport");
    };
  }, [usesInternalScroll]);

  useEffect(() => {
    void noteId;
    void userId;
    return () => {
      teardownCollab(unbindCollabRef, sessionRef, setCollab, setCollabReady);
    };
  }, [noteId, userId]);

  useEffect(() => {
    bindEditorCollab({
      hydrated: hydratedRef.current,
      noteId: canEdit ? noteId : undefined,
      sessionRef,
      setCollab,
      setCollabReady,
      setCollabWritable,
      setMarkdown,
      unbindRef: unbindCollabRef,
      user,
      userLoading,
      viewMode,
    });
  }, [noteId, userLoading, viewMode, user, canEdit]);

  useEffect(() => {
    syncCollabUser(collab, user);
  }, [collab, user]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${headingTitle} · MiyulabMD`;
    return () => {
      document.title = previous;
    };
  }, [headingTitle]);

  useEffect(() => {
    bindEditorHeader({
      awareness,
      canEdit: canMutate,
      canStart: () => editorSessionWritable(sessionRef.current),
      folder,
      isCurrent: () => viewScope?.isCurrent() === true,
      isOwner: flags.isOwner,
      note,
      paused,
      readSource,
      setAccessDraft,
      setFolder,
      setHeader,
      setHistoryOpen,
      setMode,
      setNote,
      setSaveError,
      setShareOpen,
      viewMode,
    });
    return () => setHeader(null);
  }, [
    note,
    viewMode,
    canMutate,
    awareness,
    folder,
    flags.isOwner,
    paused,
    readSource,
    setHeader,
    viewScope,
  ]);

  return (
    <EditorPageView
      accessDraft={accessDraft}
      cachedAt={cachedAt}
      loadError={loadError}
      loading={loading}
      note={note}
      paused={paused}
      readSource={readSource}
      workspace={
        currentReadState?.phase === "success" && note && accessDraft ? (
          <EditorWorkspace
            accessDraft={accessDraft}
            articleIssues={articleIssues}
            articleSource={articleSource}
            awareness={awareness}
            canEdit={canMutate}
            headingTitle={headingTitle}
            historyOpen={historyOpen}
            imageContext={currentReadState.result}
            isOwner={flags.isOwner}
            markdown={markdown}
            note={note}
            onCloseHistory={() => setHistoryOpen(false)}
            onCloseShare={() => setShareOpen(false)}
            onPersistAccess={(next) => {
              void persistEditorAccess(note, next, {
                canStart: () => editorSessionWritable(sessionRef.current),
                isCurrent: () => viewScope?.isCurrent() === true,
                setAccessDraft,
                setNote,
                setSaveError,
              });
            }}
            onSplitScroll={(ratio) => {
              applySplitScroll(ratio, splitScrollLock, setSplitScroll);
            }}
            ready={ready}
            saveError={saveError}
            shareOpen={shareOpen}
            splitScroll={splitScroll}
            user={user}
            usesInternalScroll={usesInternalScroll}
            viewMode={viewMode}
            yMarkdown={yMarkdown}
          />
        ) : null
      }
    />
  );
}

function bindEditorHeader(input: {
  note: Note | null;
  folder: string;
  viewMode: EditorMode;
  canEdit: boolean;
  paused: boolean;
  readSource: "pending" | "network" | "cache";
  awareness: YjsSession["awareness"] | undefined;
  isOwner: boolean;
  setHeader: AppShellContext["setHeader"];
  setMode: (mode: EditorMode) => void;
  setFolder: (folder: string) => void;
  setSaveError: (error: string | null) => void;
  canStart: () => boolean;
  isCurrent: () => boolean;
  setNote: (note: Note) => void;
  setAccessDraft: (draft: AccessDraft) => void;
  setShareOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
}) {
  if (!input.note) {
    input.setHeader({ folder: null, layout: "editor" });
    return;
  }
  input.setHeader({
    actions: (
      <EditorModeSwitch
        canEdit={input.canEdit}
        onChange={(next) =>
          changeEditorMode(input.canEdit, next, input.setMode)
        }
        value={input.viewMode}
      />
    ),
    end:
      input.readSource === "cache" || input.paused ? undefined : (
        <EditorHeaderEnd
          awareness={input.awareness}
          folder={input.folder}
          folderId={input.note.folderId}
          isOwner={input.isOwner}
          onFolderBlur={() => {
            void persistEditorFolder(
              input.note,
              input.folder,
              normalizeFolder,
              {
                canStart: input.canStart,
                isCurrent: input.isCurrent,
                setAccessDraft: input.setAccessDraft,
                setFolder: input.setFolder,
                setNote: input.setNote,
                setSaveError: input.setSaveError,
              },
            );
          }}
          onFolderChange={input.setFolder}
          onHistory={() => input.setHistoryOpen(true)}
          onShare={() => input.setShareOpen(true)}
        />
      ),
    folder: input.folder,
    layout: "editor",
  });
}
