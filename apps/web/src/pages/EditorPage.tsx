import type { WikiLinkMap } from "@miyulabmd/markdown";
import type {
  ArticleSource,
  MedallionResolution,
  Note,
  NoteSummary,
} from "@miyulabmd/shared";
import {
  matchArticleSource,
  medalForLayerIndex,
  normalizeFolder,
  titleFromMarkdown,
  validateArticleDocument,
} from "@miyulabmd/shared";
import { parseAsString, useQueryState } from "nuqs";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router";
import { EditorModeSwitch } from "../components/editor/EditorModeSwitch.tsx";
import { EditorOverflowMenu } from "../components/editor/EditorOverflowMenu.tsx";
import { FolderPopover } from "../components/editor/FolderPopover.tsx";
import { HistoryPanel } from "../components/editor/HistoryPanel.tsx";
import { LinksPanel } from "../components/editor/LinksPanel.tsx";
import { MarkdownEditor } from "../components/editor/MarkdownEditor.tsx";
import { MarkdownPreview } from "../components/editor/MarkdownPreview.tsx";
import { MedalBadge } from "../components/editor/MedalBadge.tsx";
import { PresenceBar } from "../components/editor/PresenceBar.tsx";
import { PreviewWithToc } from "../components/editor/PreviewWithToc.tsx";
import { RichMarkdownEditor } from "../components/editor/RichMarkdownEditor.tsx";
import { TabIndentHint } from "../components/editor/TabIndentHint.tsx";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import { ArticleFrontmatterAlert } from "../components/notes/ArticleFrontmatterAlert.tsx";
import { draftFromNote } from "../components/notes/access-draft.ts";
import { ShareModal } from "../components/notes/ShareModal.tsx";
import { HeaderButton } from "../components/ui/HeaderButton.tsx";
import { ShareIcon } from "../components/ui/icons.tsx";
import { editorLoadingClass } from "../components/ui/prose.ts";
import { ErrorText } from "../components/ui/Text.tsx";
import { resolveMedallion } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import type { YjsSession } from "../lib/collaboration.ts";
import { hasSyncedOnce, isEditCacheEligible } from "../lib/edit-cache.ts";
import {
  type EditMode,
  type EditorMode,
  isEditMode,
  readLastEditMode,
} from "../lib/editor-mode.ts";
import { useKnowledgeFeature } from "../lib/knowledge-features.ts";
import {
  dismissStaleSsrPreview,
  removeSsrPreview,
} from "../lib/note-bootstrap.ts";
import { useNoteLinks, wikiLinkMapFor } from "../lib/note-links.ts";
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
  focusLine,
}: {
  ready: boolean;
  yMarkdown: YjsSession["yMarkdown"] | undefined;
  awareness: YjsSession["awareness"] | undefined;
  noteId: string;
  canEdit: boolean;
  viewMode: EditorMode;
  splitScroll: number;
  onSplitScroll: (ratio: number) => void;
  focusLine?: number;
}) {
  if (ready && yMarkdown && awareness) {
    return (
      <MarkdownEditor
        awareness={awareness}
        focusLine={focusLine}
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
  focusLine,
  wikiLinks,
}: {
  viewMode: EditorMode;
  markdown: string;
  splitScroll: number;
  onSplitScroll: (ratio: number) => void;
  taskNoteId?: string;
  imageContext?: ImageViewContext;
  focusLine?: number;
  wikiLinks?: WikiLinkMap;
}) {
  if (viewMode === "preview") {
    return (
      <PreviewWithToc
        documentScroll={true}
        focusLine={focusLine}
        imageContext={imageContext}
        markdown={markdown}
        taskNoteId={taskNoteId}
        wikiLinks={wikiLinks}
      />
    );
  }
  return (
    <MarkdownPreview
      imageContext={imageContext}
      markdown={markdown}
      onScrollRatio={onSplitScroll}
      scrollRatio={splitScroll}
      wikiLinks={wikiLinks}
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
  canManage,
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
  focusLine,
  wikiLinks,
  linksPanel,
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
  /** False while paused or edit-locked — §2.6 blocks share/folder mutations too. */
  canManage: boolean;
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
  focusLine?: number;
  wikiLinks?: WikiLinkMap;
  linksPanel?: ReactNode;
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
      {(showSource || showRich) && <TabIndentHint />}
      <div className={editorGridClass(viewMode, usesInternalScroll, cn)}>
        {showSource && (
          <EditorSourcePane
            awareness={awareness}
            canEdit={canEdit}
            focusLine={focusLine}
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
            focusLine={focusLine}
            imageContext={imageContext}
            markdown={markdown}
            onSplitScroll={onSplitScroll}
            splitScroll={splitScroll}
            taskNoteId={canManage ? note.id : undefined}
            viewMode={viewMode}
            wikiLinks={wikiLinks}
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
        canEdit={canManage}
        headingTitle={headingTitle}
        isOwner={isOwner}
        noteId={note.id}
        onChange={onPersistAccess}
        onClose={onCloseShare}
        saveError={saveError}
        shareOpen={shareOpen}
        user={user}
      />
      {linksPanel}
      {historyOpen && (
        <HistoryPanel
          canEdit={canManage}
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
  unsentEdits,
  note,
  accessDraft,
  workspace,
}: {
  loading: boolean;
  loadError: string | null;
  paused: boolean;
  unsentEdits: boolean;
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
      {paused && (
        <p className="px-5 py-2" role="status">
          共同編集の接続が切れました。入力済みの内容はこの画面に保持しています。
          再接続・再同期が完了するまで編集できません。
        </p>
      )}
      {unsentEdits && (
        <p className="px-5 py-2" role="status">
          未送信の編集あり（オフライン）
        </p>
      )}
      {note.editLocked && (
        <p className="px-5 py-2" role="status">
          このノートは編集ロックされています。ヘッダーの「⋯」メニューの
          「編集ロック」から解除できます。
        </p>
      )}
      {workspace}
    </>
  );
}

/**
 * 右 nav（specs/knowledge-management.html §3.1）。
 * 常時表示は共有 CTA と ⋯ メニュー、条件付きは presence アバター。
 * フォルダ・リンク・履歴・編集ロックは「⋯ ノート」に集約する。
 */
function EditorHeaderEnd({
  awareness,
  folder,
  folderId,
  isOwner,
  medallion,
  note,
  user,
  onFolderChange,
  onFolderBlur,
  onHistory,
  onLinks,
  onNoteChange,
  onSearch,
  onShare,
}: {
  awareness: YjsSession["awareness"] | undefined;
  folder: string;
  folderId: string | null;
  isOwner: boolean;
  medallion: MedallionResolution | null;
  note: Note;
  user: AppShellContext["user"];
  onFolderChange: (folder: string) => void;
  onFolderBlur: () => void;
  onHistory: () => void;
  onLinks: () => void;
  onNoteChange: (note: NoteSummary) => void;
  onSearch: () => void;
  onShare: () => void;
}) {
  return (
    <>
      {awareness && <PresenceBar awareness={awareness} />}
      {/* ≥900px では現在地ボタンとして残す（§3.2）。<900px では ⋯ 内へ。 */}
      <div className="max-[900px]:hidden">
        <FolderPopover
          folder={folder}
          folderId={folderId}
          isOwner={isOwner && !note.editLocked}
          onFolderBlur={onFolderBlur}
          onFolderChange={onFolderChange}
        />
      </div>
      <EditorOverflowMenu
        awareness={awareness}
        folder={folder}
        folderId={folderId}
        isOwner={isOwner}
        medallion={medallion}
        note={note}
        onFolderBlur={onFolderBlur}
        onFolderChange={onFolderChange}
        onHistory={onHistory}
        onLinks={onLinks}
        onNoteChange={onNoteChange}
        onSearch={onSearch}
        user={user}
      />
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

function parseFocusLine(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const line = Number(raw);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: read-session, collab, and panel wiring are intentionally kept in one component.
export function EditorPage() {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const focusLine = parseFocusLine(searchParams.get("line"));
  const { user, userLoading, viewer, viewing, setHeader, openSearch } =
    useOutletContext<AppShellContext>();
  const layersEnabled = useKnowledgeFeature("layers");
  const [medallion, setMedallion] = useState<MedallionResolution | null>(null);
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
  const [offlineWritable, setOfflineWritable] = useState(false);
  const [unsentEdits, setUnsentEdits] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [articleSources, setArticleSources] = useState<ArticleSource[]>([]);
  // エディタモードは URL クエリ (?mode=edit) が正。オンライン復帰や
  // リロードでビューアが切り替わっても編集モードを維持する。
  // 編集サブモード（テキスト/分割/リッチ）は端末の最終選択を引き継ぐ。
  const [modeParam, setModeParam] = useQueryState(
    "mode",
    parseAsString.withOptions({ history: "replace" }),
  );
  const [editSubMode, setEditSubMode] = useState<EditMode>(() =>
    readLastEditMode(),
  );
  const mode: EditorMode = modeParam === "edit" ? editSubMode : "preview";
  const setMode = useCallback(
    (next: EditorMode) => {
      if (isEditMode(next)) {
        setEditSubMode(next);
        void setModeParam("edit");
      } else {
        void setModeParam(null);
      }
    },
    [setModeParam],
  );
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
  const flags = ownerFlags(user, note);
  const readReady = currentReadState?.phase === "success" && !loading;
  // §2.6: edit_locked freezes every mutation (body, folder, share, delete)
  // until explicitly unlocked — including for the owner.
  const editLocked = Boolean(note?.editLocked);
  // 編集キャッシュ名空間の本人判定。cacheViewerId は認証ではなくローカル
  // 領域の選択にだけ使い、API 書き込みの権限根拠にはしない。
  const editIdentityId = user?.id ?? viewer.cacheViewerId ?? null;
  const collabUser = user ?? viewer.cachedUser ?? null;
  // 表示キャッシュ由来でも「オンライン同期履歴あり・オフライン編集資格あり」
  // のノートは本文のローカル編集を許可する（それ以外の操作は閲覧のみ）。
  const offlineEditable = Boolean(
    readSource === "cache" &&
      note &&
      editIdentityId &&
      isEditCacheEligible(note, editIdentityId) &&
      hasSyncedOnce(editIdentityId, note.id),
  );
  const canEdit =
    readReady &&
    ((flags.canEdit && readSource === "network") || offlineEditable);
  // オフライン編集資格のあるノートは preview 中でも共同編集セッションを
  // 先行接続し、同期済み Y.Doc を編集キャッシュ（y-indexeddb）に乗せる。
  // 編集モードに一度も入らなくてもオフライン編集できるようにする温め。
  const warmupEditCache = Boolean(
    readSource === "network" &&
      canEdit &&
      note &&
      editIdentityId &&
      isEditCacheEligible(note, editIdentityId),
  );
  const viewMode: EditorMode = canEdit && !editLocked ? mode : "preview";
  const usesInternalScroll = viewMode !== "preview";
  const headingTitle = titleFromMarkdown(markdown);
  const noteLinks = useNoteLinks(
    readSource === "network" ? note?.id : undefined,
    user?.id ?? null,
    markdown,
  );
  const wikiLinks = useMemo(
    () => wikiLinkMapFor(noteLinks.data),
    [noteLinks.data],
  );
  const articleSource = matchArticleSource(folder, articleSources);
  const articleIssues = articleIssuesFor(articleSource, markdown);
  const awareness = collab?.awareness;
  const yMarkdown = collab?.yMarkdown;
  const ready = Boolean(yMarkdown && awareness && collabReady);
  // Read readiness is sticky for this session: a disconnect must not unmount
  // the editor or replace its local document with the network/cache snapshot.
  // オフライン編集では編集キャッシュ復元（offlineWritable）だけで本文を書ける。
  const bodyWritable = collabWritable || offlineWritable;
  const paused = ready && !bodyWritable;
  // §2.6: edit lock freezes all mutations, not just the body.
  // 本文以外の REST 変更はネットワーク由来の閲覧に限る。preview 中の
  // warmup セッションは REST の配送可否に関係しないため、セッション
  // 同期状態は編集モード時だけ見る。表示キャッシュ由来では ws が後から
  // 同期しても REST UI は有効化しない。
  const canMutate =
    canEdit &&
    readSource === "network" &&
    !editLocked &&
    (viewMode === "preview" || (!paused && (!collab || collabWritable)));
  // preview 中の warmup セッション切断は編集可否に関係しないため、
  // paused は編集モード時だけ Edit 表示の条件にする。
  const bodyEditable =
    canEdit && !editLocked && (viewMode === "preview" || !paused);
  // REST 変更は preview 中の warmup セッションの同期状態に依存しない。
  // 編集セッションがあるモードだけ ws 同期を配送可否の条件にする。
  const canStartMutation = () =>
    viewMode === "preview" || editorSessionWritable(sessionRef.current);

  useLayoutEffect(() => {
    hydratedRef.current = false;
    setReadState({ id, ownerViewer: viewer, phase: "pending" });
    setLoading(true);
    setLoadError(null);
    setNote(null);
    setAccessDraft(null);
    setMarkdown("");
    setFolder("");
    setLinksOpen(false);
    setViewScope(null);
    setShareOpen(false);
    setHistoryOpen(false);
    setSaveError(null);
    setOfflineWritable(false);
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
        teardownCollab(
          unbindCollabRef,
          sessionRef,
          setCollab,
          setCollabReady,
          setOfflineWritable,
        );
        hydratedRef.current = false;
        setReadState({ id, ownerViewer: viewer, phase: "error" });
        setLinksOpen(false);
        setNote(null);
        setAccessDraft(null);
        setMarkdown("");
        setShareOpen(false);
        setHistoryOpen(false);
        setLinksOpen(false);
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

  // §2.6: resolve the note's effective medallion from its folder ancestry.
  // Layers OFF or a network-miss both render no badge (display-only data).
  const noteFolder = note?.folder;
  useEffect(() => {
    if (!(layersEnabled && noteFolder) || readSource !== "network") {
      setMedallion(null);
      return;
    }
    let cancelled = false;
    void resolveMedallion(noteFolder).then(
      (result) => {
        if (!cancelled) {
          setMedallion(result.ok ? result.data.medallion : null);
        }
      },
      () => {
        if (!cancelled) {
          setMedallion(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [layersEnabled, noteFolder, readSource]);

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
      teardownCollab(
        unbindCollabRef,
        sessionRef,
        setCollab,
        setCollabReady,
        setOfflineWritable,
      );
    };
  }, [noteId, userId]);

  useEffect(() => {
    bindEditorCollab({
      editCacheUserId: editIdentityId,
      hydrated: hydratedRef.current || offlineEditable,
      note: canEdit ? note : null,
      noteId: canEdit ? noteId : undefined,
      offlineEdit: offlineEditable,
      onEditLocked: () => {
        // The server closed the writable session: reflect the lock so the
        // body flips to read-only and the lock banner appears.
        setNote((current) =>
          current ? { ...current, editLocked: true } : current,
        );
      },
      sessionRef,
      setCollab,
      setCollabReady,
      setCollabWritable,
      setMarkdown,
      setOfflineWritable,
      unbindRef: unbindCollabRef,
      user: collabUser,
      userLoading,
      viewMode,
      warmup: warmupEditCache,
    });
  }, [
    noteId,
    userLoading,
    viewMode,
    collabUser,
    canEdit,
    note,
    offlineEditable,
    editIdentityId,
    warmupEditCache,
  ]);

  useEffect(() => {
    syncCollabUser(collab, collabUser);
  }, [collab, collabUser]);

  useEffect(() => {
    const editCache = collab?.editCache;
    if (!editCache) {
      setUnsentEdits(false);
      return;
    }
    setUnsentEdits(editCache.hasUnsentEdits());
    return editCache.subscribeUnsent(() => {
      setUnsentEdits(editCache.hasUnsentEdits());
    });
  }, [collab]);

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
      canEdit: bodyEditable,
      canStart: canStartMutation,
      folder,
      isCurrent: () => viewScope?.isCurrent() === true,
      isOwner: flags.isOwner,
      medallion,
      note,
      onOpenSearch: openSearch,
      paused,
      readSource,
      setAccessDraft,
      setFolder,
      setHeader,
      setHistoryOpen,
      setLinksOpen,
      setMode,
      setNote,
      setSaveError,
      setShareOpen,
      user,
      viewMode,
    });
    return () => setHeader(null);
  }, [
    note,
    viewMode,
    bodyEditable,
    awareness,
    folder,
    flags.isOwner,
    medallion,
    openSearch,
    paused,
    readSource,
    setHeader,
    setMode,
    user,
    viewScope,
  ]);

  return (
    <EditorPageView
      accessDraft={accessDraft}
      loadError={loadError}
      loading={loading}
      note={note}
      // preview 中の warmup セッション切断は編集不能を意味しないので
      // バナーは編集モード時だけ出す。
      paused={paused && viewMode !== "preview"}
      unsentEdits={unsentEdits}
      workspace={
        currentReadState?.phase === "success" && note && accessDraft ? (
          <EditorWorkspace
            accessDraft={accessDraft}
            articleIssues={articleIssues}
            articleSource={articleSource}
            awareness={awareness}
            canEdit={bodyEditable}
            canManage={canMutate}
            focusLine={focusLine}
            headingTitle={headingTitle}
            historyOpen={historyOpen}
            imageContext={currentReadState.result}
            isOwner={flags.isOwner}
            linksPanel={
              linksOpen ? (
                <LinksPanel
                  error={noteLinks.error}
                  links={noteLinks.data}
                  loading={noteLinks.loading}
                  onClose={() => setLinksOpen(false)}
                />
              ) : null
            }
            markdown={markdown}
            note={note}
            onCloseHistory={() => setHistoryOpen(false)}
            onCloseShare={() => setShareOpen(false)}
            onPersistAccess={(next) => {
              void persistEditorAccess(note, next, {
                canStart: canStartMutation,
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
            wikiLinks={wikiLinks}
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
  medallion: MedallionResolution | null;
  user: AppShellContext["user"];
  onOpenSearch: () => void;
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
  setLinksOpen: (open: boolean) => void;
}) {
  if (!input.note) {
    input.setHeader({ folder: null, layout: "editor" });
    return;
  }
  const note = input.note;
  input.setHeader({
    actions: (
      <span className="flex items-center gap-2">
        {/* §3.1 中央スロット: フォルダのメダリオン割当（最寄祖先）を表示する */}
        <MedalBadge
          medal={
            input.medallion
              ? {
                  medal: medalForLayerIndex(input.medallion.layerIndex),
                  path: input.folder || input.medallion.assignedPath,
                }
              : null
          }
        />
        <EditorModeSwitch
          canEdit={input.canEdit}
          onChange={(next) =>
            changeEditorMode(input.canEdit, next, input.setMode)
          }
          value={input.viewMode}
        />
      </span>
    ),
    end:
      input.readSource === "cache" ||
      (input.paused && input.viewMode !== "preview") ? undefined : (
        <EditorHeaderEnd
          // preview 中の warmup セッションは UI に出さない。presence
          // アバターは従来どおり編集モード時だけ表示する。
          awareness={input.viewMode === "preview" ? undefined : input.awareness}
          folder={input.folder}
          folderId={input.note.folderId}
          isOwner={input.isOwner}
          medallion={input.medallion}
          note={input.note}
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
          onLinks={() => input.setLinksOpen(true)}
          onNoteChange={(summary) =>
            input.setNote({ ...note, ...summary, markdown: note.markdown })
          }
          onSearch={input.onOpenSearch}
          onShare={() => input.setShareOpen(true)}
          user={input.user}
        />
      ),
    folder: input.folder,
    layout: "editor",
  });
}
