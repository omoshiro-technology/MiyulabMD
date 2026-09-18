import {
  folderContains,
  MOVE_MAX_ITEMS,
  type MoveFolderContentsResult,
  type MoveFolderItem,
  type MoveFolderResult,
  type MoveNoteItem,
  type MoveNotesResult,
  type MovePlan,
  normalizeFolder,
  type SessionUser,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import {
  ensureFolderRow,
  folderName,
  getFolderById,
  getFolderByPath,
  parentFolderPath,
  resolveNoteAccess,
} from "./access.ts";
import { escapeLikePattern } from "./articles.ts";
import {
  accessFields,
  findNoteRow,
  lockedNotesInFolder,
  NOTE_COLUMNS,
  type NoteRow,
  relocateFolderTree,
  syncNoteLinks,
} from "./notes.ts";

export type MoveError =
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "invalid"; error: string; status: number };

type MoveOk<T> = { kind: "ok"; result: T };

type DestFolder = { id: string | null; folder: string; owner_id: string };

function invalid(error: string, status = 400): MoveError {
  return { error, kind: "invalid", status };
}

function ownerDenied(
  ownerId: string,
  user: SessionUser | undefined,
): MoveError | null {
  if (!user || user.id !== ownerId) {
    return { kind: "denied", status: user === undefined ? 401 : 403 };
  }
  return null;
}

/**
 * Resolve the destination folder. `null`/omitted means the caller's drive root.
 * The destination must live in the same owner namespace as the moved entities.
 */
async function resolveDest(
  env: Env,
  destFolderId: string | null | undefined,
  ownerId: string,
  user: SessionUser | undefined,
): Promise<DestFolder | MoveError> {
  if (destFolderId === null || destFolderId === undefined) {
    if (!user || user.id !== ownerId) {
      return { kind: "denied", status: user === undefined ? 401 : 403 };
    }
    return { folder: "", id: null, owner_id: ownerId };
  }
  const rec = await getFolderById(env, destFolderId);
  if (!rec) {
    return { kind: "not_found" };
  }
  if (rec.owner_id !== ownerId) {
    return {
      error: "別のドライブへは移動できません",
      kind: "invalid",
      status: 400,
    };
  }
  return rec;
}

async function countQuery(
  env: Env,
  sql: string,
  ...params: string[]
): Promise<number> {
  const row = await db(env)
    .prepare(sql)
    .bind(...params)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** Count every entity whose path lives inside `path` (inclusive). */
export async function countSubtree(
  env: Env,
  ownerId: string,
  path: string,
): Promise<MovePlan> {
  const like = `${escapeLikePattern(path)}/%`;
  const subtree = "(folder = ? OR folder LIKE ? ESCAPE '\\')";
  const grants = "(target_key = ? OR target_key LIKE ? ESCAPE '\\')";
  const [notes, folders, policies, grantsCount, articleSources] =
    await Promise.all([
      countQuery(
        env,
        `SELECT COUNT(*) AS c FROM notes WHERE owner_id = ? AND ${subtree}`,
        ownerId,
        path,
        like,
      ),
      countQuery(
        env,
        `SELECT COUNT(*) AS c FROM folders WHERE owner_id = ? AND ${subtree}`,
        ownerId,
        path,
        like,
      ),
      countQuery(
        env,
        `SELECT COUNT(*) AS c FROM folder_policies WHERE owner_id = ? AND ${subtree}`,
        ownerId,
        path,
        like,
      ),
      countQuery(
        env,
        `SELECT COUNT(*) AS c FROM access_grants WHERE owner_id = ? AND target_kind = 'folder' AND ${grants}`,
        ownerId,
        path,
        like,
      ),
      countQuery(
        env,
        `SELECT COUNT(*) AS c FROM article_sources WHERE owner_id = ? AND ${subtree}`,
        ownerId,
        path,
        like,
      ),
    ]);
  return {
    articleSources,
    folders,
    grants: grantsCount,
    notes,
    policies,
  };
}

function exceedsLimit(plan: MovePlan): boolean {
  return plan.notes + plan.folders > MOVE_MAX_ITEMS;
}

function limitError(): MoveError {
  return invalid(
    `1 回の移動は ${MOVE_MAX_ITEMS} 件（ノート＋フォルダ）までです`,
    400,
  );
}

export type MoveFolderInput = {
  /** Destination folder UUID; null/omitted moves to the drive root. */
  destFolderId?: string | null;
  /** Optional rename applied while moving. */
  name?: string;
  dryRun?: boolean;
};

export async function moveFolder(
  env: Env,
  folderId: string,
  input: MoveFolderInput,
  user: SessionUser | undefined,
): Promise<MoveError | MoveOk<MoveFolderResult>> {
  const src = await getFolderById(env, folderId);
  if (!src) {
    return { kind: "not_found" };
  }
  const denied = ownerDenied(src.owner_id, user);
  if (denied) {
    return denied;
  }
  if (!src.folder) {
    return invalid("マイドライブは移動できません");
  }
  const dest = await resolveDest(env, input.destFolderId, src.owner_id, user);
  if ("kind" in dest) {
    return dest;
  }
  if (folderContains(src.folder, dest.folder)) {
    return invalid("移動先が移動元の配下です");
  }

  const name =
    input.name === undefined
      ? folderName(src.folder)
      : normalizeFolder(input.name);
  if (!name || name.includes("/")) {
    return invalid("フォルダ名が不正です");
  }
  const to = dest.folder ? `${dest.folder}/${name}` : name;
  const dryRun = input.dryRun ?? false;
  if (to === src.folder) {
    const plan = await countSubtree(env, src.owner_id, src.folder);
    return {
      kind: "ok",
      result: { dryRun, from: src.folder, plan, to },
    };
  }
  if (await getFolderByPath(env, src.owner_id, to)) {
    return invalid("同じ名前のフォルダが既にあります", 409);
  }
  const plan = await countSubtree(env, src.owner_id, src.folder);
  if (exceedsLimit(plan)) {
    return limitError();
  }
  // §2.6: a folder move relocates every note inside — refuse while any of
  // them is edit-locked.
  if ((await lockedNotesInFolder(env, src.owner_id, src.folder)) > 0) {
    return invalid("編集ロック中のノートを含むため移動できません", 409);
  }
  if (!dryRun) {
    await relocateFolderTree(env, src.owner_id, src.folder, to);
  }
  return {
    kind: "ok",
    result: { dryRun, from: src.folder, plan, to },
  };
}

export type MoveFolderContentsInput = {
  destFolderId?: string | null;
  /** Also move direct child folders (with their subtrees). */
  includeSubfolders?: boolean;
  dryRun?: boolean;
};

async function moveOneNote(
  env: Env,
  row: NoteRow,
  destPath: string,
  dryRun: boolean,
): Promise<MoveNoteItem> {
  // §2.6: folder move is a mutation — locked notes refuse to move.
  if (row.edit_locked === 1) {
    return {
      from: row.folder,
      noteId: row.id,
      reason: "locked",
      status: "failed",
    };
  }
  if (row.folder === destPath) {
    return {
      from: row.folder,
      noteId: row.id,
      reason: "same_folder",
      status: "skipped",
    };
  }
  if (!dryRun) {
    await db(env)
      .prepare("UPDATE notes SET folder = ?, updated_at = ? WHERE id = ?")
      .bind(destPath, Date.now(), row.id)
      .run();
    await syncNoteLinks(env, { ...row, folder: destPath }, row);
  }
  return { from: row.folder, noteId: row.id, status: "moved", to: destPath };
}

function summarizeMove(items: { status: string }[]) {
  let moved = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === "moved") {
      moved += 1;
    } else if (item.status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  return { failed, moved, skipped };
}

export async function moveFolderContents(
  env: Env,
  folderId: string,
  input: MoveFolderContentsInput,
  user: SessionUser | undefined,
): Promise<MoveError | MoveOk<MoveFolderContentsResult>> {
  const src = await getFolderById(env, folderId);
  if (!src) {
    return { kind: "not_found" };
  }
  const denied = ownerDenied(src.owner_id, user);
  if (denied) {
    return denied;
  }
  const dest = await resolveDest(env, input.destFolderId, src.owner_id, user);
  if ("kind" in dest) {
    return dest;
  }
  const dryRun = input.dryRun ?? false;
  const destPath = dest.folder;

  const noteRows = await db(env)
    .prepare(
      `SELECT ${NOTE_COLUMNS} FROM notes WHERE owner_id = ? AND folder = ?`,
    )
    .bind(src.owner_id, src.folder)
    .all<NoteRow>();
  const folderRows = input.includeSubfolders
    ? (
        await db(env)
          .prepare(
            "SELECT id, owner_id, folder, created_at FROM folders WHERE owner_id = ?",
          )
          .bind(src.owner_id)
          .all<{ id: string; owner_id: string; folder: string }>()
      ).results.filter((row) => parentFolderPath(row.folder) === src.folder)
    : [];

  // Enforce the per-request cap before writing anything.
  let touched = (noteRows.results ?? []).length;
  const childPlans = new Map<string, MovePlan>();
  for (const child of folderRows) {
    const plan = await countSubtree(env, src.owner_id, child.folder);
    childPlans.set(child.id, plan);
    touched += plan.notes + plan.folders;
  }
  if (touched > MOVE_MAX_ITEMS) {
    return limitError();
  }

  const notes: MoveNoteItem[] = [];
  const folders: MoveFolderItem[] = [];
  if (!dryRun) {
    await ensureFolderRow(env, src.owner_id, destPath);
  }
  for (const row of noteRows.results ?? []) {
    notes.push(await moveOneNote(env, row, destPath, dryRun));
  }
  for (const child of folderRows) {
    folders.push(
      await moveChildFolder(env, src.owner_id, child, destPath, dryRun),
    );
  }
  const summary = summarizeMove([...notes, ...folders]);
  return {
    kind: "ok",
    result: {
      destFolderId: dest.id,
      destPath,
      dryRun,
      folders,
      notes,
      ...summary,
    },
  };
}

async function moveChildFolder(
  env: Env,
  ownerId: string,
  child: { id: string; folder: string },
  destPath: string,
  dryRun: boolean,
): Promise<MoveFolderItem> {
  const to = destPath
    ? `${destPath}/${folderName(child.folder)}`
    : folderName(child.folder);
  if (to === child.folder) {
    return {
      folderId: child.id,
      from: child.folder,
      reason: "same_folder",
      status: "skipped",
    };
  }
  if (folderContains(child.folder, destPath)) {
    return {
      folderId: child.id,
      from: child.folder,
      reason: "cycle",
      status: "skipped",
    };
  }
  if (await getFolderByPath(env, ownerId, to)) {
    return {
      folderId: child.id,
      from: child.folder,
      reason: "conflict",
      status: "skipped",
    };
  }
  // §2.6: locked notes inside the subtree block the move.
  if ((await lockedNotesInFolder(env, ownerId, child.folder)) > 0) {
    return {
      folderId: child.id,
      from: child.folder,
      reason: "locked",
      status: "skipped",
    };
  }
  if (!dryRun) {
    await relocateFolderTree(env, ownerId, child.folder, to);
  }
  return { folderId: child.id, from: child.folder, status: "moved", to };
}

export type MoveNotesInput = {
  noteIds: string[];
  destFolderId?: string | null;
  dryRun?: boolean;
};

async function classifyNoteForMove(
  env: Env,
  noteId: string,
  destOwner: string,
  user: SessionUser,
): Promise<{ row: NoteRow } | { item: MoveNoteItem }> {
  const row = await findNoteRow(env, noteId);
  if (!row) {
    return { item: { noteId, reason: "not_found", status: "failed" } };
  }
  const access = await resolveNoteAccess(env, accessFields(row), user);
  if (!access.flags.canView) {
    // 権限外ノートの存在を漏らさないため not_found と同じ扱いにする。
    return { item: { noteId, reason: "not_found", status: "failed" } };
  }
  if (row.owner_id !== destOwner) {
    return {
      item: {
        from: row.folder,
        noteId,
        reason: "owner_mismatch",
        status: "failed",
      },
    };
  }
  if (!access.flags.canAdmin) {
    return { item: { noteId, reason: "denied", status: "failed" } };
  }
  // §2.6: edit-locked notes refuse folder moves.
  if (row.edit_locked === 1) {
    return {
      item: { from: row.folder, noteId, reason: "locked", status: "failed" },
    };
  }
  return { row };
}

export async function moveNotes(
  env: Env,
  input: MoveNotesInput,
  user: SessionUser | undefined,
): Promise<MoveError | MoveOk<MoveNotesResult>> {
  if (!user) {
    return { kind: "denied", status: 401 };
  }
  const noteIds = [...new Set(input.noteIds)];
  if (noteIds.length === 0) {
    return invalid("note_ids が空です");
  }
  if (noteIds.length > MOVE_MAX_ITEMS) {
    return limitError();
  }
  const dest = await resolveDest(env, input.destFolderId, user.id, user);
  if ("kind" in dest) {
    return dest;
  }
  const dryRun = input.dryRun ?? false;
  const destPath = dest.folder;

  const items: MoveNoteItem[] = [];
  for (const noteId of noteIds) {
    const classified = await classifyNoteForMove(
      env,
      noteId,
      dest.owner_id,
      user,
    );
    if ("item" in classified) {
      items.push(classified.item);
      continue;
    }
    items.push(await moveOneNote(env, classified.row, destPath, dryRun));
  }
  const summary = summarizeMove(items);
  if (!dryRun && summary.moved > 0) {
    await ensureFolderRow(env, dest.owner_id, destPath);
  }
  return {
    kind: "ok",
    result: {
      destFolderId: dest.id,
      destPath,
      dryRun,
      items,
      ...summary,
    },
  };
}
