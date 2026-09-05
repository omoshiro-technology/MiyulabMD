import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import { folderUrl } from "@miyulabmd/shared";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import { AccessScopeMeta } from "../components/notes/AccessScopeMeta.tsx";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../components/notes/ContextMenu.tsx";
import { DrivePlaceNav } from "../components/notes/DrivePlaceNav.tsx";
import { ShareModal } from "../components/notes/ShareModal.tsx";
import { DriveList, DriveRow } from "../components/ui/DriveList.tsx";
import { FolderIcon, MarkdownIcon } from "../components/ui/icons.tsx";
import { ErrorText } from "../components/ui/Text.tsx";
import {
  fetchFolder,
  fetchFolderTree,
  fetchNote,
  updateFolderAccess,
  updateNote,
} from "../lib/api.ts";
import {
  invalidateFolderCache,
  invalidateNotesCache,
  loadNotes,
  prefetchFolder,
} from "../lib/list-cache.ts";
import { invalidateNoteCache, prefetchNote } from "../lib/note-cache.ts";
import {
  filterSharedByMeFolders,
  filterSharedByMeNotes,
} from "../lib/shared-by-me.ts";

function draftFromFolder(folder: FolderAccess): AccessDraft {
  return {
    inherit: folder.inherit,
    readScope: folder.effectiveReadScope,
    writeScope: folder.effectiveWriteScope,
    grants: folder.grants,
  };
}

function draftFromNote(note: NoteSummary): AccessDraft {
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

export function SharedByMePage() {
  const navigate = useNavigate();
  const { user, userLoading, setHeader } = useOutletContext<AppShellContext>();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<FolderAccess[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    setHeader({
      folder: null,
      actions: user ? <DrivePlaceNav current="shared-by-me" /> : null,
    });
    return () => setHeader(null);
  }, [setHeader, user]);

  const loadData = useCallback(
    async (signal?: AbortSignal) => {
      if (!user) return;
      setPending(true);
      setError(null);
      try {
        const [noteList, folderTree] = await Promise.all([
          loadNotes(true),
          fetchFolderTree(),
        ]);
        if (signal?.aborted) return;
        setNotes(filterSharedByMeNotes(noteList, user.id));
        if (!folderTree.ok) throw new Error(folderTree.error);
        const results = await Promise.all(
          folderTree.data.map((entry) => fetchFolder(entry.id)),
        );
        if (signal?.aborted) return;
        const nextFolders: FolderAccess[] = [];
        for (const result of results) {
          if (result.ok) nextFolders.push(result.data);
          else setError(result.error);
        }
        setFolders(filterSharedByMeFolders(nextFolders));
      } catch (cause) {
        if (!signal?.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "共有済みの取得に失敗しました。",
          );
        }
      } finally {
        if (!signal?.aborted) setPending(false);
      }
    },
    [user],
  );

  useEffect(() => {
    if (userLoading) return;
    if (!user) {
      navigate("/", { replace: true });
      return;
    }
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [user, userLoading, navigate, loadData]);

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

  function openFolderMenu(event: MouseEvent, folder: FolderAccess) {
    const folderId = folder.id;
    if (!folderId) return;
    event.preventDefault();
    event.stopPropagation();
    const position = menuPosition(event);
    const items: ContextMenuItem[] = [
      { label: "開く", onSelect: () => navigate(folderUrl(folder.id)) },
      { label: "共有設定", onSelect: () => void openFolderShare(folderId) },
    ];
    setMenu({ id: folderId, ...position, items });
  }

  function openNoteMenu(event: MouseEvent, note: NoteSummary) {
    event.preventDefault();
    event.stopPropagation();
    const position = menuPosition(event);
    const items: ContextMenuItem[] = [
      { label: "開く", onSelect: () => navigate(`/n/${note.id}`) },
      { label: "共有設定", onSelect: () => void openNoteShare(note.id) },
    ];
    setMenu({ id: note.id, ...position, items });
  }

  async function openFolderShare(folderId: string) {
    if (!user) return;

    const result = await fetchFolder(folderId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.data.locked) {
      setError("マイドライブの範囲は自分のみで固定です。");
      return;
    }
    if (!result.data.id) {
      setError("共有対象のフォルダ情報が取得できませんでした。");
      return;
    }
    setShare({
      kind: "folder",
      folderId: result.data.id,
      name: result.data.name,
      draft: draftFromFolder(result.data),
    });
    setShareError(null);
  }

  async function openNoteShare(noteId: string) {
    if (!user) return;

    const result = await fetchNote(noteId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setShare({
      kind: "note",
      id: result.data.id,
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
      setShare({
        ...share,
        name: result.data.name,
        draft: draftFromFolder(result.data),
      });

      invalidateNoteCache();
      invalidateNotesCache();
      invalidateFolderCache();
      await loadData();
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
    invalidateNoteCache(share.id);
    invalidateNotesCache();
    invalidateFolderCache();
    await loadData();
  }

  const shareLink =
    share?.kind === "folder"
      ? `${window.location.origin}${folderUrl(share.folderId)}`
      : share
        ? `${window.location.origin}/n/${share.id}`
        : "";

  const empty = folders.length === 0 && notes.length === 0;
  if (!user) return null;

  return (
    <section>
      <p className="mb-3 text-sm text-muted">
        自分が共有しているアイテムです。各アイテムのメニューから共有設定を変更できます。
      </p>
      {error && <ErrorText>{error}</ErrorText>}
      {empty && !pending ? (
        <p>共有しているアイテムはありません。</p>
      ) : (
        <DriveList
          className={
            pending ? "opacity-60 transition-opacity duration-150" : undefined
          }
        >
          {folders
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, "ja"))
            .map((folder) => (
              <DriveRow
                key={folder.id}
                href={folderUrl(folder.id)}
                name={folder.name}
                icon={<FolderIcon />}
                meta={
                  <AccessScopeMeta
                    readScope={folder.effectiveReadScope}
                    writeScope={folder.effectiveWriteScope}
                  />
                }
                menuOpen={menu?.id === folder.id}
                onMenu={(event) => openFolderMenu(event, folder)}
                onPointerEnter={() => prefetchFolder(folder.id)}
              />
            ))}
          {notes
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((note) => (
              <DriveRow
                key={note.id}
                href={`/n/${note.id}`}
                name={note.title}
                icon={<MarkdownIcon />}
                meta={
                  <AccessScopeMeta
                    readScope={note.access.effectiveReadScope}
                    writeScope={note.access.effectiveWriteScope}
                  />
                }
                menuOpen={menu?.id === note.id}
                onMenu={(event) => openNoteMenu(event, note)}
                onPointerEnter={() => prefetchNote(note.id)}
              />
            ))}
        </DriveList>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {share && (
        <ShareModal
          title={share.name}
          linkUrl={shareLink}
          ownerLabel={user.displayName?.trim() || user.email}
          value={share.draft}
          showInherit
          inheritLabel={
            share.kind === "folder"
              ? "親フォルダの設定に従う"
              : "ディレクトリの設定に従う"
          }
          error={shareError}
          onChange={(next) => {
            void persistShare(next).catch((cause) => {
              setShareError(
                cause instanceof Error
                  ? cause.message
                  : "共有設定の更新に失敗しました。",
              );
            });
          }}
          onClose={() => setShare(null)}
        />
      )}
    </section>
  );
}
