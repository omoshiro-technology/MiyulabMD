import type {
  FolderAccess,
  FolderRecord,
  NoteSummary,
  ParaSpaceSummary,
  SessionUser,
} from "@miyulabmd/shared";
import { folderUrl } from "@miyulabmd/shared";
import type { MouseEvent } from "react";
import type { NavigateFunction } from "react-router";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import {
  draftFromFolder,
  draftFromNote,
  folderAccessPatch,
  noteAccessPatch,
} from "../components/notes/access-draft.ts";
import type { ContextMenuItem } from "../components/notes/ContextMenu.tsx";
import type { MenuTarget } from "../components/notes/NoteTree.tsx";
import type { ApiResult } from "../lib/api.ts";
import {
  assignFolderMedallion,
  clearFolderMedallion,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  fetchFolder,
  fetchNote,
  fetchPara,
  fetchPublicFolders,
  renameFolder,
  updateFolderAccess,
  updateFolderScheme,
  updateNote,
} from "../lib/api.ts";
import {
  invalidateFolderCache,
  invalidateNotesCache,
  loadFolder,
  loadNotes,
  peekFolder,
  seedFolderCache,
  upsertNoteSummary,
} from "../lib/list-cache.ts";
import { invalidateNoteCache, seedNoteCache } from "../lib/note-cache.ts";

export type ShareState =
  | { kind: "folder"; folderId: string; name: string; draft: AccessDraft }
  | { kind: "note"; id: string; name: string; draft: AccessDraft };

export type MenuState = {
  id: string;
  x: number;
  y: number;
  items: ContextMenuItem[];
};

export type ConfirmState =
  | { kind: "folder"; id: string; name: string }
  | { kind: "note"; id: string; name: string };

export type HomeFolderSetters = {
  setVisibleFolder: (folder: FolderAccess | null) => void;
  setPublicFolders: (folders: FolderRecord[]) => void;
  setFolderPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
};

type ShareSetters = {
  setShare: (share: ShareState) => void;
  setShareError: (error: string | null) => void;
  setNotes: (notes: NoteSummary[]) => void;
};

export function shareLinkFor(share: ShareState | null): string {
  if (share?.kind === "folder") {
    return `${window.location.origin}${folderUrl(share.folderId)}`;
  }
  if (share) {
    return `${window.location.origin}/n/${share.id}`;
  }
  return "";
}

export function headerFolderFor(
  visibleFolder: FolderAccess | null,
  folderId: string | undefined,
): string | null | undefined {
  const headerFolder = visibleFolder?.folder;
  if (headerFolder === undefined) {
    return folderId ? null : "";
  }
  return headerFolder;
}

export function homeListFlags(input: {
  folderId: string | undefined;
  user: SessionUser | null;
  userLoading: boolean;
  folderPending: boolean;
  visibleFolder: FolderAccess | null;
  error: string | null;
}) {
  const needsFolder = Boolean(input.folderId || input.user);
  const waitingForFolder = needsFolder && !input.visibleFolder && !input.error;
  const showPlaceholder =
    (input.userLoading || input.folderPending || waitingForFolder) &&
    !input.visibleFolder;
  return {
    canAdmin: Boolean(input.visibleFolder?.flags.canAdmin),
    isDriveRoot: Boolean(input.visibleFolder?.locked),
    listPending: input.folderPending && Boolean(input.visibleFolder),
    needsFolder,
    showPlaceholder,
    showTree:
      (!input.folderId || input.visibleFolder || showPlaceholder) &&
      !(input.folderId && input.error && !input.visibleFolder),
  };
}

export function subscribeHomeNotes(
  userLoading: boolean,
  setNotes: (notes: NoteSummary[]) => void,
): (() => void) | undefined {
  if (userLoading) {
    return undefined;
  }
  let cancelled = false;
  void loadNotes(true).then((noteList) => {
    if (!cancelled) {
      setNotes(noteList);
    }
  });
  return () => {
    cancelled = true;
  };
}

function applyPublicFoldersResult(
  result: ApiResult<FolderRecord[]>,
  cancelled: boolean,
  setters: HomeFolderSetters,
) {
  if (cancelled) {
    return;
  }
  setters.setFolderPending(false);
  if (result.ok) {
    setters.setPublicFolders(result.data);
    return;
  }
  setters.setError(result.error);
}

function applyFolderLoadResult(
  result: ApiResult<FolderAccess>,
  folderId: string | undefined,
  cancelled: boolean,
  setters: HomeFolderSetters,
) {
  if (cancelled) {
    return;
  }
  setters.setFolderPending(false);
  if (!result.ok) {
    if (peekFolder(folderId)) {
      return;
    }
    setters.setVisibleFolder(null);
    setters.setError(
      result.status === 404 ? "フォルダが見つかりません。" : result.error,
    );
    return;
  }
  setters.setError(null);
  setters.setVisibleFolder(result.data);
}

export function subscribeHomeFolder(
  folderId: string | undefined,
  user: SessionUser | null,
  userLoading: boolean,
  setters: HomeFolderSetters,
): (() => void) | undefined {
  if (userLoading) {
    return undefined;
  }
  let cancelled = false;
  setters.setError(null);

  if (!(folderId || user)) {
    setters.setVisibleFolder(null);
    setters.setPublicFolders([]);
    setters.setFolderPending(true);
    void fetchPublicFolders().then((result) => {
      applyPublicFoldersResult(result, cancelled, setters);
    });
    return () => {
      cancelled = true;
    };
  }

  const cached = peekFolder(folderId);
  if (cached) {
    setters.setVisibleFolder(cached);
    setters.setFolderPending(false);
  } else {
    setters.setFolderPending(true);
  }

  void loadFolder(folderId, true).then((result) => {
    applyFolderLoadResult(result, folderId, cancelled, setters);
  });
  return () => {
    cancelled = true;
  };
}

export async function persistNewNote(
  visibleFolder: FolderAccess | null,
  navigate: NavigateFunction,
  setCreating: (creating: boolean) => void,
  setError: (error: string | null) => void,
) {
  setCreating(true);
  setError(null);

  const result = await createNote({
    folder: visibleFolder?.folder,
    folderId: visibleFolder?.id ?? undefined,
    inheritAccess: true,
    markdown: "# 無題\n",
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

  const { markdown: _markdown, ...summary } = result.data;
  upsertNoteSummary(summary);
  seedNoteCache(result.data);
  navigate(`/n/${result.data.id}`);
}

export async function persistNewFolder(
  name: string,
  visibleFolder: FolderAccess | null,
  navigate: NavigateFunction,
  setters: {
    setFolderCreating: (busy: boolean) => void;
    setFolderCreateError: (error: string | null) => void;
    setFolderCreateOpen: (open: boolean) => void;
    setShare: (share: ShareState) => void;
    setShareError: (error: string | null) => void;
  },
  options: { useScheme?: boolean } = {},
) {
  setters.setFolderCreating(true);
  setters.setFolderCreateError(null);

  const result = await createFolder({
    name,
    parentId: visibleFolder?.id,
    useScheme: options.useScheme,
  });
  if (!result.ok) {
    setters.setFolderCreateError(result.error);
    setters.setFolderCreating(false);
    return;
  }

  setters.setFolderCreateOpen(false);
  setters.setFolderCreating(false);
  invalidateNotesCache();
  if (visibleFolder?.id) {
    invalidateFolderCache(visibleFolder.id);
  }
  if (result.data.id) {
    seedFolderCache(result.data);
    navigate(folderUrl(result.data.id));
    setters.setShare({
      draft: draftFromFolder(result.data),
      folderId: result.data.id,
      kind: "folder",
      name: result.data.name,
    });
    setters.setShareError(null);
  }
}

export async function openFolderShare(
  id: string,
  name: string,
  setError: (error: string | null) => void,
  setShare: (share: ShareState) => void,
  setShareError: (error: string | null) => void,
) {
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
    draft: draftFromFolder(result.data),
    folderId: result.data.id,
    kind: "folder",
    name,
  });
  setShareError(null);
}

export async function openNoteShare(
  note: NoteSummary,
  setError: (error: string | null) => void,
  setShare: (share: ShareState) => void,
  setShareError: (error: string | null) => void,
) {
  const result = await fetchNote(note.id);
  if (!result.ok) {
    setError(result.error);
    return;
  }
  setShare({
    draft: draftFromNote(result.data),
    id: note.id,
    kind: "note",
    name: result.data.title,
  });
  setShareError(null);
}

async function persistHomeFolderShare(
  share: Extract<ShareState, { kind: "folder" }>,
  next: AccessDraft,
  visibleFolderId: string | null | undefined,
  setters: ShareSetters & { setVisibleFolder: (folder: FolderAccess) => void },
) {
  const result = await updateFolderAccess({
    folderId: share.folderId,
    ...folderAccessPatch(next),
  });
  if (!result.ok) {
    setters.setShareError(result.error);
    return;
  }
  setters.setShare({ ...share, draft: draftFromFolder(result.data) });
  seedFolderCache(result.data);
  if (visibleFolderId === share.folderId) {
    setters.setVisibleFolder(result.data);
  }
  invalidateNotesCache();
  void loadNotes(true).then(setters.setNotes);
}

async function persistHomeNoteShare(
  share: Extract<ShareState, { kind: "note" }>,
  next: AccessDraft,
  setters: ShareSetters,
) {
  const result = await updateNote(share.id, noteAccessPatch(next));
  if (!result.ok) {
    setters.setShareError(result.error);
    return;
  }
  setters.setShare({
    ...share,
    draft: draftFromNote(result.data),
    name: result.data.title,
  });
  invalidateNotesCache();
  void loadNotes(true).then(setters.setNotes);
}

export async function persistHomeShare(
  share: ShareState | null,
  next: AccessDraft,
  visibleFolderId: string | null | undefined,
  setters: ShareSetters & { setVisibleFolder: (folder: FolderAccess) => void },
) {
  if (!share) {
    return;
  }
  setters.setShare({ ...share, draft: next });
  setters.setShareError(null);
  if (share.kind === "folder") {
    await persistHomeFolderShare(share, next, visibleFolderId, setters);
    return;
  }
  await persistHomeNoteShare(share, next, setters);
}

/**
 * §2.4/§2.5: fetch the caller's PARA spaces (with buckets), but only when the
 * para feature flag is on — flag OFF means /api/para is never called and the
 * section stays hidden.
 */
export async function loadParaSpaces(
  user: SessionUser | null | undefined,
  paraEnabled: boolean,
): Promise<ParaSpaceSummary[]> {
  if (!(user && paraEnabled)) {
    return [];
  }
  const result = await fetchPara({ viewerId: user.id });
  return result.ok ? result.data.spaces : [];
}

export function menuPosition(event: MouseEvent) {
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

function folderMenuItems(
  target: Extract<MenuTarget, { kind: "folder" }>,
  canAdmin: boolean,
  navigate: NavigateFunction,
  onShare: (id: string, name: string) => void,
  onRename: (id: string, name: string) => void,
  onDelete: (id: string, name: string) => void,
  options: {
    onArchive: (id: string, name: string) => void;
    onScheme: (id: string, name: string, scheme: string | null) => void;
    /** §2.6: medallion assignment dialog (layers feature only). */
    onMedallion?: (id: string, name: string, path?: string) => void;
    projectsPaths: string[];
  },
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: "開く", onSelect: () => navigate(folderUrl(target.id)) },
    { label: "共有", onSelect: () => onShare(target.id, target.name) },
  ];
  if (!canAdmin) {
    return items;
  }
  items.push({
    label: "名前を変更",
    onSelect: () => onRename(target.id, target.name),
  });
  items.push({
    label: "命名規則…",
    onSelect: () =>
      options.onScheme(target.id, target.name, target.scheme ?? null),
  });
  if (options.onMedallion) {
    items.push({
      label: "メダリオン層…",
      onSelect: () =>
        options.onMedallion?.(target.id, target.name, target.path),
    });
  }
  const inProjects = options.projectsPaths.some(
    (path) => target.path?.startsWith(`${path}/`) === true,
  );
  if (inProjects) {
    items.push({
      label: "完了してアーカイブ（PARA）",
      onSelect: () => options.onArchive(target.id, target.name),
    });
  }
  items.push({
    danger: true,
    label: "削除",
    onSelect: () => onDelete(target.id, target.name),
  });
  return items;
}

function noteMenuItems(
  note: NoteSummary,
  navigate: NavigateFunction,
  onShare: (note: NoteSummary) => void,
  onDelete: (id: string, name: string) => void,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: "開く", onSelect: () => navigate(`/n/${note.id}`) },
    { label: "共有", onSelect: () => onShare(note) },
  ];
  if (!note.access.flags.canAdmin) {
    return items;
  }
  items.push({
    danger: true,
    label: "削除",
    onSelect: () => onDelete(note.id, note.title),
  });
  return items;
}

export function handleItemMenu(
  event: MouseEvent,
  target: MenuTarget,
  canAdmin: boolean,
  navigate: NavigateFunction,
  setMenu: (menu: MenuState) => void,
  onFolderShare: (id: string, name: string) => void,
  onNoteShare: (note: NoteSummary) => void,
  onRename: (id: string, name: string) => void,
  onDelete: (kind: ConfirmState["kind"], id: string, name: string) => void,
  options: {
    onArchive: (id: string, name: string) => void;
    onScheme: (id: string, name: string, scheme: string | null) => void;
    onMedallion?: (id: string, name: string, path?: string) => void;
    projectsPaths: string[];
  },
) {
  const position = menuPosition(event);
  if (target.kind === "folder") {
    setMenu({
      id: target.id,
      ...position,
      items: folderMenuItems(
        target,
        canAdmin,
        navigate,
        onFolderShare,
        onRename,
        (id, name) => onDelete("folder", id, name),
        options,
      ),
    });
    return;
  }
  setMenu({
    id: target.note.id,
    ...position,
    items: noteMenuItems(target.note, navigate, onNoteShare, (id, name) =>
      onDelete("note", id, name),
    ),
  });
}

export async function refreshHomeList(
  folderId: string | undefined,
  user: SessionUser | null,
  navigate: NavigateFunction,
  setNotes: (notes: NoteSummary[]) => void,
  setVisibleFolder: (folder: FolderAccess | null) => void,
) {
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
    if (root.ok) {
      setVisibleFolder(root.data);
    }
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

export async function persistFolderScheme(
  target: { id: string; name: string; scheme: string | null } | null,
  scheme: string | null,
  folderId: string | undefined,
  user: SessionUser | null,
  navigate: NavigateFunction,
  setters: {
    setSchemeBusy: (busy: boolean) => void;
    setSchemeDialog: (
      value: { id: string; name: string; scheme: string | null } | null,
    ) => void;
    setSchemeError: (error: string | null) => void;
    setNotes: (notes: NoteSummary[]) => void;
    setVisibleFolder: (folder: FolderAccess | null) => void;
  },
) {
  if (!target) {
    return;
  }
  setters.setSchemeBusy(true);
  setters.setSchemeError(null);
  const result = await updateFolderScheme(target.id, scheme);
  if (!result.ok) {
    setters.setSchemeError(result.error);
    setters.setSchemeBusy(false);
    return;
  }
  setters.setSchemeBusy(false);
  setters.setSchemeDialog(null);
  invalidateFolderCache();
  await refreshHomeList(
    folderId,
    user,
    navigate,
    setters.setNotes,
    setters.setVisibleFolder,
  );
}

export type MedallionDialogTarget = {
  id: string;
  name: string;
  path?: string;
};

/**
 * §2.6: assign a medallion layer to a folder (`next` = {setId, layer}) or
 * clear the folder's own assignment (`next` = null). Inherited badges are
 * recomputed by reloading the assignment list afterwards.
 */
export async function persistFolderMedallion(
  target: MedallionDialogTarget | null,
  next: { setId: string; layer: string } | null,
  folderId: string | undefined,
  user: SessionUser | null,
  navigate: NavigateFunction,
  setters: {
    setMedallionBusy: (busy: boolean) => void;
    setMedallionDialog: (value: MedallionDialogTarget | null) => void;
    setMedallionError: (error: string | null) => void;
    setNotes: (notes: NoteSummary[]) => void;
    setVisibleFolder: (folder: FolderAccess | null) => void;
    /** Reloads the medallion set/assignment lists for badges. */
    onMedallionsChanged: () => void;
  },
) {
  if (!target) {
    return;
  }
  setters.setMedallionBusy(true);
  setters.setMedallionError(null);
  const result = next
    ? await assignFolderMedallion(target.id, {
        layer: next.layer,
        setId: next.setId,
      })
    : await clearFolderMedallion(target.id);
  if (!result.ok) {
    setters.setMedallionError(result.error);
    setters.setMedallionBusy(false);
    return;
  }
  setters.setMedallionBusy(false);
  setters.setMedallionDialog(null);
  setters.onMedallionsChanged();
  invalidateFolderCache();
  await refreshHomeList(
    folderId,
    user,
    navigate,
    setters.setNotes,
    setters.setVisibleFolder,
  );
}

export async function persistRenameFolder(
  folderRename: { id: string; name: string } | null,
  name: string,
  visibleFolderId: string | null | undefined,
  folderId: string | undefined,
  user: SessionUser | null,
  navigate: NavigateFunction,
  setters: {
    setFolderRename: (value: { id: string; name: string } | null) => void;
    setFolderRenaming: (busy: boolean) => void;
    setFolderRenameError: (error: string | null) => void;
    setVisibleFolder: (folder: FolderAccess | null) => void;
    setNotes: (notes: NoteSummary[]) => void;
  },
) {
  if (!folderRename) {
    return;
  }
  if (name === folderRename.name) {
    setters.setFolderRename(null);
    return;
  }

  setters.setFolderRenaming(true);
  setters.setFolderRenameError(null);

  const result = await renameFolder(folderRename.id, name);
  if (!result.ok) {
    setters.setFolderRenameError(result.error);
    setters.setFolderRenaming(false);
    return;
  }

  setters.setFolderRename(null);
  setters.setFolderRenaming(false);
  seedFolderCache(result.data);
  if (visibleFolderId === result.data.id) {
    setters.setVisibleFolder(result.data);
  }
  await refreshHomeList(
    folderId,
    user,
    navigate,
    setters.setNotes,
    setters.setVisibleFolder,
  );
}

export async function persistHomeDelete(
  confirm: ConfirmState | null,
  folderId: string | undefined,
  parentId: string | null | undefined,
  user: SessionUser | null,
  navigate: NavigateFunction,
  setters: {
    setConfirmBusy: (busy: boolean) => void;
    setConfirmError: (error: string | null) => void;
    setConfirm: (value: ConfirmState | null) => void;
    setNotes: (notes: NoteSummary[]) => void;
    setVisibleFolder: (folder: FolderAccess | null) => void;
  },
) {
  if (!confirm) {
    return;
  }
  setters.setConfirmBusy(true);
  setters.setConfirmError(null);
  const result = await deleteConfirmTarget(confirm);
  if (!result.ok) {
    setters.setConfirmError(result.error);
    setters.setConfirmBusy(false);
    return;
  }
  setters.setConfirm(null);
  setters.setConfirmBusy(false);
  if (confirm.kind === "note") {
    invalidateNoteCache(confirm.id);
  }
  if (confirm.kind === "folder" && folderId === confirm.id) {
    navigate(folderUrl(parentId));
  }
  await refreshHomeList(
    folderId,
    user,
    navigate,
    setters.setNotes,
    setters.setVisibleFolder,
  );
}

function deleteConfirmTarget(confirm: ConfirmState) {
  if (confirm.kind === "folder") {
    return deleteFolder(confirm.id);
  }
  return deleteNote(confirm.id);
}

export function inheritLabelFor(kind: ShareState["kind"]): string {
  if (kind === "folder") {
    return "親ディレクトリの設定に従う";
  }
  return "ディレクトリの設定に従う";
}

export function confirmCopy(confirm: ConfirmState): {
  title: string;
  message: string;
} {
  if (confirm.kind === "folder") {
    return {
      message: `「${confirm.name}」を削除します。中のノートとフォルダも削除され、元に戻せません。`,
      title: "フォルダを削除",
    };
  }
  return {
    message: `「${confirm.name}」を削除します。この操作は元に戻せません。`,
    title: "ノートを削除",
  };
}
