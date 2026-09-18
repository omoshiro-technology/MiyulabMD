import type {
  FolderAccess,
  FolderRecord,
  NoteSummary,
  SessionUser,
} from "@miyulabmd/shared";
import { folderUrl } from "@miyulabmd/shared";
import type { AccessDraft } from "../components/notes/AccessPanel.tsx";
import {
  causeMessage,
  draftFromFolder,
  draftFromNote,
  folderAccessPatch,
  noteAccessPatch,
} from "../components/notes/access-draft.ts";
import type { ApiResult } from "../lib/api.ts";
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
} from "../lib/list-cache.ts";
import { invalidateNoteCache } from "../lib/note-cache.ts";

export type ShareState =
  | { kind: "folder"; folderId: string; name: string; draft: AccessDraft }
  | { kind: "note"; id: string; name: string; draft: AccessDraft };

export type SharedByMeSetters = {
  setNotes: (notes: NoteSummary[]) => void;
  setFolders: (folders: FolderAccess[]) => void;
  setError: (error: string | null) => void;
  setPending: (pending: boolean) => void;
};

async function collectFolderAccess(
  folderTree: ApiResult<FolderRecord[]>,
  options: { signal?: AbortSignal; viewerId?: string | null },
): Promise<{ folders: FolderAccess[]; error: string | null }> {
  if (!folderTree.ok) {
    throw new Error(folderTree.error);
  }
  const results = await Promise.all(
    folderTree.data.map((entry) => fetchFolder(entry.id, options)),
  );
  const folders: FolderAccess[] = [];
  let error: string | null = null;
  for (const result of results) {
    if (result.ok) {
      folders.push(result.data);
    } else {
      error = result.error;
    }
  }
  return { error, folders };
}

function applyIfActive(signal: AbortSignal | undefined, apply: () => void) {
  if (!signal?.aborted) {
    apply();
  }
}

export async function loadSharedByMe(
  user: SessionUser | null,
  signal: AbortSignal | undefined,
  setters: SharedByMeSetters,
) {
  if (!user) {
    return;
  }
  const options = { signal, viewerId: user.id };
  setters.setPending(true);
  setters.setError(null);
  try {
    const [noteList, folderTree] = await Promise.all([
      loadNotes(true),
      fetchFolderTree(options),
    ]);
    if (signal?.aborted) {
      return;
    }
    setters.setNotes(noteList);
    const collected = await collectFolderAccess(folderTree, options);
    if (signal?.aborted) {
      return;
    }
    if (collected.error) {
      setters.setError(collected.error);
    }
    setters.setFolders(collected.folders);
  } catch (cause) {
    applyIfActive(signal, () => {
      setters.setError(causeMessage(cause, "共有済みの取得に失敗しました。"));
    });
  } finally {
    applyIfActive(signal, () => {
      setters.setPending(false);
    });
  }
}

export async function openSharedFolderShare(
  folderId: string,
  user: SessionUser | null,
  setError: (error: string | null) => void,
  setShare: (share: ShareState) => void,
  setShareError: (error: string | null) => void,
) {
  if (!user) {
    return;
  }

  const result = await fetchFolder(folderId, { viewerId: user.id });
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
    draft: draftFromFolder(result.data),
    folderId: result.data.id,
    kind: "folder",
    name: result.data.name,
  });
  setShareError(null);
}

export async function openSharedNoteShare(
  noteId: string,
  user: SessionUser | null,
  setError: (error: string | null) => void,
  setShare: (share: ShareState) => void,
  setShareError: (error: string | null) => void,
) {
  if (!user) {
    return;
  }

  const result = await fetchNote(noteId, { viewerId: user.id });
  if (!result.ok) {
    setError(result.error);
    return;
  }
  setShare({
    draft: draftFromNote(result.data),
    id: result.data.id,
    kind: "note",
    name: result.data.title,
  });
  setShareError(null);
}

type ShareSetters = {
  setShare: (share: ShareState) => void;
  setShareError: (error: string | null) => void;
  reload: () => Promise<void>;
};

async function persistSharedFolderShare(
  share: Extract<ShareState, { kind: "folder" }>,
  next: AccessDraft,
  setters: ShareSetters,
) {
  const result = await updateFolderAccess({
    folderId: share.folderId,
    ...folderAccessPatch(next),
  });
  if (!result.ok) {
    setters.setShareError(result.error);
    return;
  }
  setters.setShare({
    ...share,
    draft: draftFromFolder(result.data),
    name: result.data.name,
  });
  invalidateNoteCache();
  invalidateNotesCache();
  invalidateFolderCache();
  await setters.reload();
}

async function persistSharedNoteShare(
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
  invalidateNoteCache(share.id);
  invalidateNotesCache();
  invalidateFolderCache();
  await setters.reload();
}

export async function persistSharedShare(
  share: ShareState | null,
  next: AccessDraft,
  setters: ShareSetters,
) {
  if (!share) {
    return;
  }
  setters.setShare({ ...share, draft: next });
  setters.setShareError(null);
  if (share.kind === "folder") {
    await persistSharedFolderShare(share, next, setters);
    return;
  }
  await persistSharedNoteShare(share, next, setters);
}

export function sharedShareLink(share: ShareState | null): string {
  if (share?.kind === "folder") {
    return `${window.location.origin}${folderUrl(share.folderId)}`;
  }
  if (share) {
    return `${window.location.origin}/n/${share.id}`;
  }
  return "";
}

export function sharedInheritLabel(kind: ShareState["kind"]): string {
  if (kind === "folder") {
    return "親フォルダの設定に従う";
  }
  return "ディレクトリの設定に従う";
}
