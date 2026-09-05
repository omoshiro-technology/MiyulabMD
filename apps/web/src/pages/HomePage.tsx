import type {
  FolderAccess,
  FolderRecord,
  Note,
  NoteSummary,
} from "@miyulabmd/shared";
import { folderUrl } from "@miyulabmd/shared";
import { type MouseEvent, useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import { ConfirmDialog } from "../components/notes/ConfirmDialog.tsx";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../components/notes/ContextMenu.tsx";
import { DrivePlaceNav } from "../components/notes/DrivePlaceNav.tsx";
import { FolderCreateModal } from "../components/notes/FolderCreateModal.tsx";
import { type MenuTarget, NoteTree } from "../components/notes/NoteTree.tsx";
import { ShareModal } from "../components/notes/ShareModal.tsx";
import { HeaderButton } from "../components/ui/HeaderButton.tsx";
import { FolderOutlineIcon, PlusIcon } from "../components/ui/icons.tsx";
import { ErrorText } from "../components/ui/Text.tsx";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  fetchFolder,
  fetchNote,
  fetchPublicFolders,
  renameFolder,
  updateFolderAccess,
  updateNote,
} from "../lib/api.ts";
import {
  invalidateFolderCache,
  invalidateNotesCache,
  loadFolder,
  loadNotes,
  peekFolder,
  peekNotes,
  seedFolderCache,
} from "../lib/list-cache.ts";
import { invalidateNoteCache, seedNoteCache } from "../lib/note-cache.ts";

function draftFromFolder(access: FolderAccess): AccessDraft {
  return {
    inherit: access.inherit,
    readScope: access.effectiveReadScope,
    writeScope: access.effectiveWriteScope,
    grants: access.grants,
  };
}

function draftFromNote(note: Note): AccessDraft {
  return {
    inherit: note.access.inherit,
    readScope: note.access.effectiveReadScope,
    writeScope: note.access.effectiveWriteScope,
    grants: note.access.grants,
  };
}

type ShareState =
  | { kind: "folder"; folderId: string; name: string; draft: AccessDraft }
  | { kind: "note"; id: string; name: string; draft: AccessDraft };

type MenuState = {
  id: string;
  x: number;
  y: number;
  items: ContextMenuItem[];
};

type ConfirmState =
  | { kind: "folder"; id: string; name: string }
  | { kind: "note"; id: string; name: string };

export function HomePage() {
  const navigate = useNavigate();
  const { folderId } = useParams();
  const { user, userLoading, setHeader } = useOutletContext<AppShellContext>();
  const [notes, setNotes] = useState<NoteSummary[]>(() => peekNotes() ?? []);
  const [visibleFolder, setVisibleFolder] = useState<FolderAccess | null>(
    () => peekFolder(folderId) ?? null,
  );
  const [folderPending, setFolderPending] = useState(false);
  const [publicFolders, setPublicFolders] = useState<FolderRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const sessionKey = user?.id ?? "guest";

  useEffect(() => {
    if (userLoading) return;
    let cancelled = false;
    void sessionKey;

    invalidateNotesCache();
    void loadNotes(true).then((noteList) => {
      if (!cancelled) setNotes(noteList);
    });

    return () => {
      cancelled = true;
    };
  }, [sessionKey, userLoading]);

  useEffect(() => {
    if (userLoading) return;
    let cancelled = false;
    setError(null);

    if (!folderId && !user) {
      setVisibleFolder(null);
      setPublicFolders([]);
      setFolderPending(true);
      void fetchPublicFolders().then((result) => {
        if (cancelled) return;
        setFolderPending(false);
        if (result.ok) setPublicFolders(result.data);
        else setError(result.error);
      });
      return () => {
        cancelled = true;
      };
    }

    const cached = peekFolder(folderId);
    if (cached) {
      setVisibleFolder(cached);
      setFolderPending(false);
      return;
    }

    setFolderPending(true);
    void loadFolder(folderId).then((result) => {
      if (cancelled) return;
      setFolderPending(false);
      if (!result.ok) {
        if (!peekFolder(folderId)) setVisibleFolder(null);
        setError(
          result.status === 404 ? "フォルダが見つかりません。" : result.error,
        );
        return;
      }
      setVisibleFolder(result.data);
    });

    return () => {
      cancelled = true;
    };
  }, [folderId, user, userLoading]);

  async function handleCreate() {
    setCreating(true);
    setError(null);

    const result = await createNote({
      markdown: "# 無題\n",
      folderId: visibleFolder?.id ?? undefined,
      folder: visibleFolder?.folder,
      inheritAccess: true,
    });
    if (!result.ok) {
      setError(
        result.status === 401
          ? "ノートを作成するにはログインが必要です。"
          : result.error,
      );
      setCreating(false);
      return;
    }

    seedNoteCache(result.data);
    navigate(`/n/${result.data.id}`);
  }

  async function persistNewFolder(name: string) {
    setFolderCreating(true);
    setFolderCreateError(null);

    const result = await createFolder({ name, parentId: visibleFolder?.id });
    if (!result.ok) {
      setFolderCreateError(result.error);
      setFolderCreating(false);
      return;
    }

    setFolderCreateOpen(false);
    setFolderCreating(false);
    invalidateNotesCache();
    if (visibleFolder?.id) invalidateFolderCache(visibleFolder.id);
    if (result.data.id) {
      seedFolderCache(result.data);
      navigate(folderUrl(result.data.id));
      setShare({
        kind: "folder",
        folderId: result.data.id,
        name: result.data.name,
        draft: draftFromFolder(result.data),
      });
      setShareError(null);
    }
  }

  async function openFolderShare(id: string, name: string) {
    const result = await fetchFolder(id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.data.locked || !result.data.id) {
      setError("マイドライブの範囲は自分のみで固定です。");
      return;
    }
    setShare({
      kind: "folder",
      folderId: result.data.id,
      name,
      draft: draftFromFolder(result.data),
    });
    setShareError(null);
  }

  async function openNoteShare(note: NoteSummary) {
    const result = await fetchNote(note.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setShare({
      kind: "note",
      id: note.id,
      name: result.data.title,
      draft: draftFromNote(result.data),
    });
    setShareError(null);
  }

  async function persistShare(next: AccessDraft) {
    if (!share) return;
    setShare({ ...share, draft: next });
    setShareError(null);

    if (share.kind === "folder") {
      const result = await updateFolderAccess({
        folderId: share.folderId,
        inherit: next.inherit,
        readScope: next.inherit ? undefined : next.readScope,
        writeScope: next.inherit ? undefined : next.writeScope,
        grants: next.grants.map((grant) => ({
          email: grant.email,
          canWrite: grant.canWrite,
        })),
      });
      if (!result.ok) {
        setShareError(result.error);
        return;
      }
      setShare({ ...share, draft: draftFromFolder(result.data) });
      seedFolderCache(result.data);
      if (visibleFolder?.id === share.folderId) setVisibleFolder(result.data);
      invalidateNotesCache();
      void loadNotes(true).then(setNotes);
      return;
    }

    const result = await updateNote(share.id, {
      inheritAccess: next.inherit,
      readScope: next.inherit ? null : next.readScope,
      writeScope: next.inherit ? null : next.writeScope,
      grants: next.grants.map((grant) => ({
        email: grant.email,
        canWrite: grant.canWrite,
      })),
    });
    if (!result.ok) {
      setShareError(result.error);
      return;
    }
    setShare({
      ...share,
      name: result.data.title,
      draft: draftFromNote(result.data),
    });
    invalidateNotesCache();
    void loadNotes(true).then(setNotes);
  }

  function menuPosition(event: MouseEvent) {
    const target = event.currentTarget;
    if (target instanceof HTMLButtonElement) {
      const rect = target.getBoundingClientRect();
      return {
        x: Math.min(rect.right - 10, window.innerWidth - 180),
        y: rect.bottom + 4,
      };
    }
    return {
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 160),
    };
  }

  function handleItemMenu(event: MouseEvent, target: MenuTarget) {
    const position = menuPosition(event);
    if (target.kind === "folder") {
      const items: ContextMenuItem[] = [
        { label: "開く", onSelect: () => navigate(folderUrl(target.id)) },
        {
          label: "共有",
          onSelect: () => void openFolderShare(target.id, target.name),
        },
      ];
      if (visibleFolder?.flags.canAdmin) {
        items.push({
          label: "名前を変更",
          onSelect: () => {
            setFolderRename({ id: target.id, name: target.name });
            setFolderRenameError(null);
          },
        });
        items.push({
          label: "削除",
          danger: true,
          onSelect: () => {
            setConfirm({ kind: "folder", id: target.id, name: target.name });
            setConfirmError(null);
          },
        });
      }
      setMenu({ id: target.id, ...position, items });
      return;
    }

    const items: ContextMenuItem[] = [
      { label: "開く", onSelect: () => navigate(`/n/${target.note.id}`) },
      { label: "共有", onSelect: () => void openNoteShare(target.note) },
    ];
    if (target.note.access.flags.canAdmin) {
      items.push({
        label: "削除",
        danger: true,
        onSelect: () => {
          setConfirm({
            kind: "note",
            id: target.note.id,
            name: target.note.title,
          });
          setConfirmError(null);
        },
      });
    }
    setMenu({ id: target.note.id, ...position, items });
  }

  async function refreshList() {
    invalidateNotesCache();
    invalidateFolderCache();
    const noteList = await loadNotes(true);
    setNotes(noteList);
    if (!folderId) {
      if (!user) {
        setVisibleFolder(null);
        return;
      }
      const root = await loadFolder(undefined, true);
      if (root.ok) setVisibleFolder(root.data);
      return;
    }
    const result = await loadFolder(folderId, true);
    if (!result.ok) {
      setVisibleFolder(null);
      navigate("/");
      return;
    }
    setVisibleFolder(result.data);
  }

  async function persistRenameFolder(name: string) {
    if (!folderRename) return;
    if (name === folderRename.name) {
      setFolderRename(null);
      return;
    }

    setFolderRenaming(true);
    setFolderRenameError(null);

    const result = await renameFolder(folderRename.id, name);
    if (!result.ok) {
      setFolderRenameError(result.error);
      setFolderRenaming(false);
      return;
    }

    setFolderRename(null);
    setFolderRenaming(false);
    seedFolderCache(result.data);
    if (visibleFolder?.id === result.data.id) setVisibleFolder(result.data);
    await refreshList();
  }

  async function persistDelete() {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    const result =
      confirm.kind === "folder"
        ? await deleteFolder(confirm.id)
        : await deleteNote(confirm.id);
    if (!result.ok) {
      setConfirmError(result.error);
      setConfirmBusy(false);
      return;
    }
    setConfirm(null);
    setConfirmBusy(false);
    if (confirm.kind === "note") invalidateNoteCache(confirm.id);
    if (confirm.kind === "folder" && folderId === confirm.id) {
      navigate(folderUrl(visibleFolder?.parentId));
    }
    await refreshList();
  }

  const shareLink =
    share?.kind === "folder"
      ? `${window.location.origin}${folderUrl(share.folderId)}`
      : share
        ? `${window.location.origin}/n/${share.id}`
        : "";

  const headerFolder =
    visibleFolder?.folder !== undefined
      ? visibleFolder.folder
      : folderId
        ? null
        : "";
  const canAdmin = Boolean(visibleFolder?.flags.canAdmin);
  const needsFolder = Boolean(folderId || user);
  const showPlaceholder =
    (userLoading || (needsFolder && folderPending)) && !visibleFolder;
  const listPending = folderPending && Boolean(visibleFolder);
  const showTree =
    (!folderId || visibleFolder || showPlaceholder) &&
    !(folderId && error && !visibleFolder);

  useEffect(() => {
    setHeader({
      folder: headerFolder,
      actions: user ? (
        <DrivePlaceNav current={canAdmin || !folderId ? "drive" : "shared"} />
      ) : null,
      end:
        visibleFolder || !folderId ? (
          <>
            {canAdmin && (
              <HeaderButton
                variant="outline"
                icon={<FolderOutlineIcon />}
                label="フォルダ"
                onClick={() => {
                  setFolderCreateError(null);
                  setFolderCreateOpen(true);
                }}
              />
            )}
            <HeaderButton
              variant="accent"
              icon={<PlusIcon />}
              label={creating ? "作成中…" : "新規ノート"}
              disabled={creating}
              onClick={() => void handleCreate()}
            />
          </>
        ) : null,
    });
    return () => setHeader(null);
  }, [
    headerFolder,
    visibleFolder,
    folderId,
    canAdmin,
    creating,
    setHeader,
    user,
  ]);

  const isDriveRoot = Boolean(visibleFolder?.locked);

  return (
    <section>
      {!user && !folderId && !userLoading && (
        <h1 className="mb-3 text-lg font-semibold">全体公開</h1>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {showTree ? (
        <NoteTree
          notes={notes}
          currentFolderId={visibleFolder?.id ?? null}
          crumbs={visibleFolder?.crumbs ?? []}
          parentId={visibleFolder?.parentId ?? null}
          childrenFolders={
            !user && !folderId ? publicFolders : (visibleFolder?.children ?? [])
          }
          showAllNotes={!user && !folderId}
          rootHref={user ? "/shared" : "/"}
          showRootCrumb={canAdmin}
          isDriveRoot={isDriveRoot}
          openMenuId={menu?.id}
          pending={listPending}
          placeholder={showPlaceholder}
          onItemMenu={handleItemMenu}
        />
      ) : null}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
      {folderCreateOpen && (
        <FolderCreateModal
          busy={folderCreating}
          error={folderCreateError}
          onSubmit={(name) => void persistNewFolder(name)}
          onClose={() => {
            if (!folderCreating) setFolderCreateOpen(false);
          }}
        />
      )}
      {folderRename && (
        <FolderCreateModal
          title="フォルダ名を変更"
          submitLabel="変更"
          busyLabel="変更中…"
          initialName={folderRename.name}
          busy={folderRenaming}
          error={folderRenameError}
          onSubmit={(name) => void persistRenameFolder(name)}
          onClose={() => {
            if (!folderRenaming) setFolderRename(null);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "folder" ? "フォルダを削除" : "ノートを削除"}
          message={
            confirm.kind === "folder"
              ? `「${confirm.name}」を削除します。中のノートとフォルダも削除され、元に戻せません。`
              : `「${confirm.name}」を削除します。この操作は元に戻せません。`
          }
          busy={confirmBusy}
          error={confirmError}
          onConfirm={() => void persistDelete()}
          onClose={() => {
            if (!confirmBusy) setConfirm(null);
          }}
        />
      )}
      {share && user && (
        <ShareModal
          title={share.name}
          linkUrl={shareLink}
          ownerLabel={user.displayName?.trim() || user.email}
          value={share.draft}
          showInherit
          inheritLabel={
            share.kind === "folder"
              ? "親ディレクトリの設定に従う"
              : "ディレクトリの設定に従う"
          }
          error={shareError}
          onChange={(next) => void persistShare(next)}
          onClose={() => setShare(null)}
        />
      )}
    </section>
  );
}
