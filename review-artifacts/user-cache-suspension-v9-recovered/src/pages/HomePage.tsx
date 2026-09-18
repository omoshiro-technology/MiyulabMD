import type {
  FolderAccess,
  FolderRecord,
  NoteSummary,
} from "@miyulabmd/shared";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useOutletContext, useParams } from "react-router";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import { ConfirmDialog } from "../components/notes/ConfirmDialog.tsx";
import { ContextMenu } from "../components/notes/ContextMenu.tsx";
import { DrivePlaceNav } from "../components/notes/DrivePlaceNav.tsx";
import { FolderCreateModal } from "../components/notes/FolderCreateModal.tsx";
import { type MenuTarget, NoteTree } from "../components/notes/NoteTree.tsx";
import { ShareModal } from "../components/notes/ShareModal.tsx";
import { HeaderButton } from "../components/ui/HeaderButton.tsx";
import { FolderOutlineIcon, PlusIcon } from "../components/ui/icons.tsx";
import { ErrorText } from "../components/ui/Text.tsx";
import {
  HomeMetadataError,
  readHomeMetadata,
} from "../lib/home-metadata-reader.ts";
import {
  readOfflineFolderDenial,
  readOfflineNoteDenial,
  subscribeOfflineCacheFolderDenial,
  subscribeOfflineCacheNoteDenial,
} from "../lib/offline-cache.ts";
import { CachedDriveView } from "./CachedDriveView.tsx";
import {
  type ConfirmState,
  confirmCopy,
  handleItemMenu,
  headerFolderFor,
  homeListFlags,
  inheritLabelFor,
  type MenuState,
  openFolderShare,
  openNoteShare,
  persistHomeDelete,
  persistHomeShare,
  persistNewFolder,
  persistNewNote,
  persistRenameFolder,
  type ShareState,
  shareLinkFor,
} from "./home-page.ts";

function HomeHeaderEnd({
  canAdmin,
  creating,
  showEnd,
  onCreateFolder,
  onCreateNote,
}: {
  canAdmin: boolean;
  creating: boolean;
  showEnd: boolean;
  onCreateFolder: () => void;
  onCreateNote: () => void;
}) {
  if (!showEnd) {
    return null;
  }
  return (
    <>
      {canAdmin && (
        <HeaderButton
          icon={<FolderOutlineIcon />}
          label="フォルダ"
          onClick={onCreateFolder}
          variant="outline"
        />
      )}
      <HeaderButton
        disabled={creating}
        icon={<PlusIcon />}
        label={creating ? "作成中…" : "新規ノート"}
        onClick={onCreateNote}
        variant="accent"
      />
    </>
  );
}

function useHomeHeader(
  headerFolder: string | null | undefined,
  user: AppShellContext["user"],
  folderId: string | undefined,
  visibleFolder: FolderAccess | null,
  folderPending: boolean,
  canAdmin: boolean,
  creating: boolean,
  setHeader: AppShellContext["setHeader"],
  onCreateFolder: () => void,
  onCreateNote: () => void,
) {
  useEffect(() => {
    setHeader({
      actions: user ? (
        <DrivePlaceNav current={canAdmin || !folderId ? "drive" : "shared"} />
      ) : null,
      end: (
        <HomeHeaderEnd
          canAdmin={canAdmin}
          creating={creating}
          onCreateFolder={onCreateFolder}
          onCreateNote={onCreateNote}
          showEnd={Boolean(
            visibleFolder || !(folderId || user || folderPending),
          )}
        />
      ),
      folder: headerFolder,
    });
    return () => setHeader(null);
  }, [
    headerFolder,
    visibleFolder,
    folderPending,
    folderId,
    canAdmin,
    creating,
    setHeader,
    user,
    onCreateFolder,
    onCreateNote,
  ]);
}

function HomePageDialogs({
  user,
  menu,
  folderCreateOpen,
  folderCreating,
  folderCreateError,
  folderRename,
  folderRenaming,
  folderRenameError,
  confirm,
  confirmBusy,
  confirmError,
  share,
  shareError,
  shareLink,
  onCloseMenu,
  onCreateFolder,
  onCloseCreateFolder,
  onRenameFolder,
  onCloseRename,
  onConfirmDelete,
  onCloseConfirm,
  onPersistShare,
  onCloseShare,
}: {
  user: AppShellContext["user"];
  menu: MenuState | null;
  folderCreateOpen: boolean;
  folderCreating: boolean;
  folderCreateError: string | null;
  folderRename: { id: string; name: string } | null;
  folderRenaming: boolean;
  folderRenameError: string | null;
  confirm: ConfirmState | null;
  confirmBusy: boolean;
  confirmError: string | null;
  share: ShareState | null;
  shareError: string | null;
  shareLink: string;
  onCloseMenu: () => void;
  onCreateFolder: (name: string) => void;
  onCloseCreateFolder: () => void;
  onRenameFolder: (name: string) => void;
  onCloseRename: () => void;
  onConfirmDelete: () => void;
  onCloseConfirm: () => void;
  onPersistShare: (next: AccessDraft) => void;
  onCloseShare: () => void;
}) {
  const copy = confirm ? confirmCopy(confirm) : null;
  return (
    <>
      {menu && (
        <ContextMenu
          items={menu.items}
          onClose={onCloseMenu}
          x={menu.x}
          y={menu.y}
        />
      )}
      {folderCreateOpen && (
        <FolderCreateModal
          busy={folderCreating}
          error={folderCreateError}
          onClose={onCloseCreateFolder}
          onSubmit={onCreateFolder}
        />
      )}
      {folderRename && (
        <FolderCreateModal
          busy={folderRenaming}
          busyLabel="変更中…"
          error={folderRenameError}
          initialName={folderRename.name}
          onClose={onCloseRename}
          onSubmit={onRenameFolder}
          submitLabel="変更"
          title="フォルダ名を変更"
        />
      )}
      {confirm && copy && (
        <ConfirmDialog
          busy={confirmBusy}
          error={confirmError}
          message={copy.message}
          onClose={onCloseConfirm}
          onConfirm={onConfirmDelete}
          title={copy.title}
        />
      )}
      {share && user && (
        <ShareModal
          error={shareError}
          inheritLabel={inheritLabelFor(share.kind)}
          linkUrl={shareLink}
          onChange={onPersistShare}
          onClose={onCloseShare}
          ownerLabel={user.displayName?.trim() || user.email}
          showInherit={true}
          title={share.name}
          value={share.draft}
        />
      )}
    </>
  );
}

function HomePageView({
  user,
  folderId,
  userLoading,
  notes,
  visibleFolder,
  publicFolders,
  error,
  cacheWarning,
  flags,
  menu,
  onItemMenu,
  dialogs,
}: {
  user: AppShellContext["user"];
  folderId: string | undefined;
  userLoading: boolean;
  notes: NoteSummary[];
  visibleFolder: FolderAccess | null;
  publicFolders: FolderRecord[];
  error: string | null;
  cacheWarning: string | null;
  flags: ReturnType<typeof homeListFlags>;
  menu: MenuState | null;
  onItemMenu: (event: MouseEvent, target: MenuTarget) => void;
  dialogs: ReactNode;
}) {
  const showGuestTitle = !(user || folderId || userLoading);
  return (
    <section>
      {showGuestTitle && (
        <h1 className="mb-3 text-lg font-semibold">全体公開</h1>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {cacheWarning && <p role="status">{cacheWarning}</p>}
      {flags.showTree ? (
        <NoteTree
          childrenFolders={
            user || folderId ? (visibleFolder?.children ?? []) : publicFolders
          }
          crumbs={visibleFolder?.crumbs ?? []}
          currentFolderId={visibleFolder?.id ?? null}
          isDriveRoot={flags.isDriveRoot}
          notes={notes}
          onItemMenu={onItemMenu}
          openMenuId={menu?.id}
          parentId={visibleFolder?.parentId ?? null}
          pending={flags.listPending}
          placeholder={flags.showPlaceholder}
          rootHref={user ? "/shared" : "/"}
          showAllNotes={!(user || folderId)}
          showRootCrumb={flags.canAdmin}
        />
      ) : null}
      {dialogs}
    </section>
  );
}

function NetworkHomePage() {
  const navigate = useNavigate();
  const { folderId } = useParams();
  const { user, userLoading, viewer, setHeader } =
    useOutletContext<AppShellContext>();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [visibleFolder, setVisibleFolder] = useState<FolderAccess | null>(null);
  const [folderPending, setFolderPending] = useState(true);
  const [publicFolders, setPublicFolders] = useState<FolderRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheWarning, setCacheWarning] = useState<string | null>(null);
  const [reloadRequest, setReloadRequest] = useState(0);
  const latestReloadRequest = useRef(reloadRequest);
  latestReloadRequest.current = reloadRequest;
  const notesRef = useRef<NoteSummary[]>([]);
  const visibleFolderRef = useRef<FolderAccess | null>(null);
  const reloadOwnerRef = useRef(0);
  const homeReadOwnerRef = useRef<object | null>(null);
  const homeReadActiveRef = useRef(false);
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [folderCreating, setFolderCreating] = useState(false);
  const [folderCreateError, setFolderCreateError] = useState<string | null>(
    null,
  );
  const [folderRename, setFolderRename] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [folderRenaming, setFolderRenaming] = useState(false);
  const [folderRenameError, setFolderRenameError] = useState<string | null>(
    null,
  );

  const flags = homeListFlags({
    error,
    folderId,
    folderPending,
    user,
    userLoading,
    visibleFolder,
  });
  const headerFolder = headerFolderFor(visibleFolder, folderId);
  const shareLink = shareLinkFor(share);

  useEffect(() => {
    if (userLoading) {
      return;
    }
    const controller = new AbortController();
    const owner = {};
    let current = true;
    const requestOwner = reloadRequest;
    homeReadOwnerRef.current = owner;
    homeReadActiveRef.current = true;
    const finishRead = () => {
      if (homeReadOwnerRef.current === owner) {
        homeReadOwnerRef.current = null;
        homeReadActiveRef.current = false;
      }
    };
    const isCurrentOwner = () =>
      current &&
      latestReloadRequest.current === requestOwner &&
      homeReadOwnerRef.current === owner &&
      homeReadActiveRef.current;
    setError(null);
    setCacheWarning(null);
    setFolderPending(true);
    ++reloadOwnerRef.current;
    void readHomeMetadata({
      folderId,
      isCurrentOwner,
      signal: controller.signal,
      viewer,
    })
      .then((snapshot) => {
        const ownerCurrent = isCurrentOwner();
        finishRead();
        if (!ownerCurrent || controller.signal.aborted) {
          return;
        }
        notesRef.current = snapshot.notes;
        visibleFolderRef.current = snapshot.visibleFolder;
        setNotes(snapshot.notes);
        setVisibleFolder(snapshot.visibleFolder);
        setPublicFolders(snapshot.publicFolders);
        setCacheWarning(snapshot.cacheWarning ?? null);
        setFolderPending(false);
      })
      .catch((error: unknown) => {
        const ownerCurrent = isCurrentOwner();
        finishRead();
        if (!ownerCurrent || controller.signal.aborted) {
          return;
        }
        setFolderPending(false);
        notesRef.current = [];
        setVisibleFolder(null);
        visibleFolderRef.current = null;
        setPublicFolders([]);
        setNotes([]);
        if (error instanceof HomeMetadataError) {
          setCacheWarning(error.cacheWarning ?? null);
        }
        if (error instanceof HomeMetadataError || error instanceof Error) {
          setError(error.message);
        } else {
          setError("データを取得できませんでした。");
        }
      });
    return () => {
      current = false;
      controller.abort();
      finishRead();
    };
  }, [folderId, reloadRequest, userLoading, viewer]);

  useEffect(() => {
    if (viewer.cacheViewerId === null) {
      return;
    }
    let active = true;
    const unsubscribe = subscribeOfflineCacheNoteDenial((event) => {
      const receiptOwner = reloadOwnerRef.current;
      if (event.userId !== viewer.cacheViewerId || !active) {
        return;
      }
      const identities = event.resource.aliases.filter((alias) =>
        notesRef.current.some(
          (current) => current.id === alias || current.shortId === alias,
        ),
      );
      if (identities.length === 0) {
        return;
      }
      void readOfflineNoteDenial(event, identities).then((denied) => {
        if (
          denied === false ||
          !active ||
          receiptOwner !== reloadOwnerRef.current ||
          viewer.cacheViewerId !== event.userId
        ) {
          return;
        }
        setReloadRequest((value) => value + 1);
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [viewer.cacheViewerId]);

  useEffect(() => {
    let active = true;
    const targetUserId = viewer.user?.id;
    const unsubscribe = subscribeOfflineCacheFolderDenial((event) => {
      const relationIds = new Set<string | null>([
        folderId ?? null,
        visibleFolderRef.current?.id ?? null,
        ...(visibleFolderRef.current?.children ?? []).map((child) => child.id),
        ...(visibleFolderRef.current?.crumbs ?? []).map((crumb) => crumb.id),
        ...notesRef.current.map((note) => note.folderId),
      ]);
      const relevant = event.resource.aliases.some((id) => relationIds.has(id));
      if (
        active &&
        !homeReadActiveRef.current &&
        event.userId === targetUserId &&
        relevant
      ) {
        const receiptOwner = homeReadOwnerRef.current;
        void readOfflineFolderDenial(event).then((denied) => {
          if (
            active &&
            homeReadOwnerRef.current === receiptOwner &&
            !homeReadActiveRef.current &&
            denied !== null
          ) {
            setReloadRequest((value) => value + 1);
          } else if (
            active &&
            homeReadOwnerRef.current === receiptOwner &&
            !homeReadActiveRef.current
          ) {
            setCacheWarning("オフラインキャッシュを確認できませんでした。");
          }
        });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [folderId, viewer.user?.id]);

  // Header updates re-render AppShell and this page. Keep its callbacks stable
  // so useHomeHeader does not publish another header on every parent render.
  const handleCreateFolder = useCallback(() => {
    setFolderCreateError(null);
    setFolderCreateOpen(true);
  }, []);
  const handleCreateNote = useCallback(() => {
    void persistNewNote(visibleFolder, navigate, setCreating, setError);
  }, [visibleFolder, navigate]);

  useHomeHeader(
    headerFolder,
    user,
    folderId,
    visibleFolder,
    folderPending,
    flags.canAdmin,
    creating,
    setHeader,
    handleCreateFolder,
    handleCreateNote,
  );

  return (
    <HomePageView
      cacheWarning={cacheWarning}
      dialogs={
        <HomePageDialogs
          confirm={confirm}
          confirmBusy={confirmBusy}
          confirmError={confirmError}
          folderCreateError={folderCreateError}
          folderCreateOpen={folderCreateOpen}
          folderCreating={folderCreating}
          folderRename={folderRename}
          folderRenameError={folderRenameError}
          folderRenaming={folderRenaming}
          menu={menu}
          onCloseConfirm={() => {
            if (!confirmBusy) {
              setConfirm(null);
            }
          }}
          onCloseCreateFolder={() => {
            if (!folderCreating) {
              setFolderCreateOpen(false);
            }
          }}
          onCloseMenu={() => setMenu(null)}
          onCloseRename={() => {
            if (!folderRenaming) {
              setFolderRename(null);
            }
          }}
          onCloseShare={() => setShare(null)}
          onConfirmDelete={() => {
            void persistHomeDelete(
              confirm,
              folderId,
              visibleFolder?.parentId,
              user,
              navigate,
              {
                setConfirm,
                setConfirmBusy,
                setConfirmError,
                setNotes,
                setVisibleFolder,
              },
            );
          }}
          onCreateFolder={(name) => {
            void persistNewFolder(name, visibleFolder, navigate, {
              setFolderCreateError,
              setFolderCreateOpen,
              setFolderCreating,
              setShare,
              setShareError,
            });
          }}
          onPersistShare={(next) => {
            void persistHomeShare(share, next, visibleFolder?.id, {
              setNotes,
              setShare,
              setShareError,
              setVisibleFolder,
            });
          }}
          onRenameFolder={(name) => {
            void persistRenameFolder(
              folderRename,
              name,
              visibleFolder?.id,
              folderId,
              user,
              navigate,
              {
                setFolderRename,
                setFolderRenameError,
                setFolderRenaming,
                setNotes,
                setVisibleFolder,
              },
            );
          }}
          share={share}
          shareError={shareError}
          shareLink={shareLink}
          user={user}
        />
      }
      error={error}
      flags={flags}
      folderId={folderId}
      menu={menu}
      notes={notes}
      onItemMenu={(event, target) => {
        handleItemMenu(
          event,
          target,
          flags.canAdmin,
          navigate,
          setMenu,
          (id, name) => {
            void openFolderShare(id, name, setError, setShare, setShareError);
          },
          (note) => {
            void openNoteShare(note, setError, setShare, setShareError);
          },
          (id, name) => {
            setFolderRename({ id, name });
            setFolderRenameError(null);
          },
          (kind, id, name) => {
            setConfirm({ id, kind, name });
            setConfirmError(null);
          },
        );
      }}
      publicFolders={publicFolders}
      user={user}
      userLoading={userLoading}
      visibleFolder={visibleFolder}
    />
  );
}

export function HomePage() {
  const { folderId } = useParams();
  const { user, userLoading, viewer } = useOutletContext<AppShellContext>();
  const networkViewerKey = JSON.stringify([
    viewer.mode,
    user?.id ?? null,
    viewer.cacheViewerId,
  ]);

  if (userLoading) {
    return <NetworkHomePage key={networkViewerKey} />;
  }
  if (viewer.mode === "cached" && viewer.cacheViewerId !== null) {
    return (
      <CachedDriveView
        key={JSON.stringify([viewer.cacheViewerId, folderId ?? null])}
      />
    );
  }
  if (viewer.mode === "unavailable") {
    return (
      <p role="status">
        閲覧者を確認できないため、この画面を表示できません。しばらくしてから再試行してください。
      </p>
    );
  }
  return <NetworkHomePage key={networkViewerKey} />;
}
