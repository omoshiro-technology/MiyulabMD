import { env } from "cloudflare:workers";
import {
  type AccessGrantInput,
  clampWriteScope,
  isAccessScope,
  normalizeFolder,
  type UpdateFolderAccessInput,
} from "@miyulabmd/shared";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import { instanceFlags } from "../env.ts";
import {
  buildAccessSnapshot,
  createOwnedFolder,
  deleteFolderPolicy,
  ensureFolderRow,
  folderViewFlags,
  getFolderById,
  listFolderChildren,
  listOwnedFolders,
  listPublicSharedFolders,
  listSharedFolders,
  parentFolderPath,
  replaceGrants,
  resolveFolderAccess,
  upsertFolderPolicy,
} from "../services/access.ts";
import {
  type MoveError,
  moveFolder,
  moveFolderContents,
} from "../services/move.ts";
import { createNoteService } from "../services/notes.ts";
import {
  createSchemeChild,
  type SchemeError,
  setFolderScheme,
} from "../services/schemes.ts";

const notes = createNoteService(env);

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function moveErrorResponse(
  set: { status?: number | string },
  result: MoveError | SchemeError,
): { error: string } {
  if (result.kind === "not_found") {
    set.status = 404;
    return { error: "Not found" };
  }
  if (result.kind === "denied") {
    set.status = result.status;
    return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
  }
  set.status = result.status;
  return { error: result.error };
}

function normalizeFolderName(name: string): string | null {
  const normalized = normalizeFolder(name);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  return normalized;
}

async function applyFolderScopeChange(
  ownerId: string,
  folder: string,
  body: UpdateFolderAccessInput,
  current: Awaited<ReturnType<typeof resolveFolderAccess>>,
): Promise<{ error: string; status: number } | null> {
  if (body.inherit === true) {
    await deleteFolderPolicy(env, ownerId, folder);
    return null;
  }
  if (
    !(
      body.inherit === false ||
      body.readScope !== undefined ||
      body.writeScope !== undefined
    )
  ) {
    return null;
  }

  const fallback = {
    readScope: current.effectiveReadScope,
    writeScope: current.effectiveWriteScope,
  };
  const requestedRead = body.readScope;
  const requestedWrite = body.writeScope;
  const readScope =
    requestedRead && isAccessScope(requestedRead)
      ? requestedRead
      : fallback.readScope;
  const writeScope = clampWriteScope(
    readScope,
    requestedWrite && isAccessScope(requestedWrite)
      ? requestedWrite
      : fallback.writeScope,
  );
  if (
    (writeScope === "public" || writeScope === "link") &&
    !instanceFlags(env).allowAnonymousEdits
  ) {
    return {
      error: "匿名ユーザーによる書き込みは、匿名編集が無効なため使えません",
      status: 400,
    };
  }
  await upsertFolderPolicy(env, ownerId, folder, readScope, writeScope);
  return null;
}

async function applyFolderAccessPatch(
  ownerId: string,
  folder: string,
  body: UpdateFolderAccessInput,
): Promise<{ error: string; status: number } | null> {
  if (!folder) {
    return {
      error: "マイドライブの範囲は自分のみで固定です",
      status: 400,
    };
  }

  const current = await resolveFolderAccess(env, ownerId, folder, {
    displayName: null,
    email: "",
    id: ownerId,
  });

  const scopeError = await applyFolderScopeChange(
    ownerId,
    folder,
    body,
    current,
  );
  if (scopeError) {
    return scopeError;
  }

  if (body.grants) {
    const replaced = await replaceGrants(
      env,
      ownerId,
      "folder",
      folder,
      body.grants as AccessGrantInput[],
    );
    if ("error" in replaced) {
      return { error: replaced.error, status: 400 };
    }
  }

  return null;
}

async function folderPathFromName(
  userId: string,
  name: string,
  parentId?: string,
): Promise<{ folder: string } | { error: string; status: number }> {
  if (!parentId) {
    return { folder: name };
  }
  const parent = await getFolderById(env, parentId);
  if (!parent || parent.owner_id !== userId) {
    return { error: "Not found", status: 404 };
  }
  return { folder: parent.folder ? `${parent.folder}/${name}` : name };
}

async function resolveCreateFolderPath(
  userId: string,
  body: { folder?: string; name?: string; parentId?: string } | null,
): Promise<{ folder: string } | { error: string; status: number }> {
  let folder = normalizeFolder(body?.folder ?? "");
  if (!folder && body?.name) {
    const name = normalizeFolderName(body.name);
    if (!name) {
      return { error: "フォルダ名が不正です", status: 400 };
    }
    const resolved = await folderPathFromName(userId, name, body.parentId);
    if ("error" in resolved) {
      return resolved;
    }
    folder = resolved.folder;
  }
  if (!folder) {
    return { error: "マイドライブ自体は作成できません", status: 400 };
  }
  return { folder };
}

export const folderRoutes = new Elysia({ prefix: "/api/folders" })
  .get("/tree", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    await ensureFolderRow(env, user.id, "");
    const folders = await listOwnedFolders(env, user.id);
    return { folders };
  })
  .get("/shared", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const folders = await listSharedFolders(env, user);
    return { folders };
  })
  .get("/public", async () => {
    const folders = await listPublicSharedFolders(env);
    return { folders };
  })
  .get("/:id/children", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const rec = await getFolderById(env, params.id);
    if (!rec) {
      set.status = 404;
      return { error: "Not found" };
    }
    const snapshot = await buildAccessSnapshot(env, [rec.owner_id]);
    const flags = await folderViewFlags(
      env,
      rec.owner_id,
      rec.folder,
      user,
      snapshot,
    );
    if (!flags.canView) {
      set.status = 404;
      return { error: "Not found" };
    }
    const url = new URL(request.url);
    return listFolderChildren(
      env,
      rec.owner_id,
      rec.folder,
      rec.id,
      user,
      {
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? "") || undefined,
      },
      snapshot,
    );
  })
  .get("/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const rec = await getFolderById(env, params.id);
    if (!rec) {
      set.status = 404;
      return { error: "Not found" };
    }

    const access = await resolveFolderAccess(
      env,
      rec.owner_id,
      rec.folder,
      user,
      await buildAccessSnapshot(env, [rec.owner_id]),
    );
    if (!access.flags.canView) {
      set.status = 404;
      return { error: "Not found" };
    }
    return access;
  })
  .get("/", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const path = normalizeFolder(
      new URL(request.url).searchParams.get("path") ?? "",
    );
    const access = await resolveFolderAccess(
      env,
      user.id,
      path,
      user,
      await buildAccessSnapshot(env, [user.id]),
    );
    return access;
  })
  .post("/", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const body = await parseJsonBody<{
      folder?: string;
      name?: string;
      parentId?: string;
      schemeId?: string;
      useScheme?: boolean;
    }>(request);
    if (body?.useScheme) {
      // 親フォルダの命名規則で採番して作成する。
      if (!body.parentId) {
        set.status = 400;
        return { error: "parentId を指定してください" };
      }
      const created = await createSchemeChild(
        env,
        body.parentId,
        { schemeId: body.schemeId, title: body.name },
        user,
      );
      if (created.kind !== "ok") {
        return moveErrorResponse(set, created);
      }
      set.status = 201;
      return created.result.folder;
    }
    const resolved = await resolveCreateFolderPath(user.id, body);
    if ("error" in resolved) {
      set.status = resolved.status;
      return { error: resolved.error };
    }

    const parent = parentFolderPath(resolved.folder);
    if (parent) {
      const parentAccess = await resolveFolderAccess(
        env,
        user.id,
        parent,
        user,
      );
      if (!parentAccess.flags.canAdmin) {
        set.status = 403;
        return { error: "このフォルダには作成権限がありません" };
      }
    }

    const access = await createOwnedFolder(env, user.id, resolved.folder, user);
    set.status = 201;
    return access;
  })
  .patch("/", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const body = await parseJsonBody<UpdateFolderAccessInput>(request);
    if (!body) {
      set.status = 400;
      return { error: "Invalid JSON body" };
    }

    let folder = normalizeFolder(body.folder ?? "");
    if (body.folderId) {
      const rec = await getFolderById(env, body.folderId);
      if (!rec || rec.owner_id !== user.id) {
        set.status = 404;
        return { error: "Not found" };
      }
      folder = rec.folder;
    }

    const applied = await applyFolderAccessPatch(user.id, folder, body);
    if (applied) {
      set.status = applied.status;
      return { error: applied.error };
    }

    return resolveFolderAccess(env, user.id, folder, user);
  })
  .post("/:id/scheme", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{ scheme?: string | null }>(request);
    const result = await setFolderScheme(
      env,
      params.id,
      body && "scheme" in body ? (body.scheme ?? null) : null,
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return moveErrorResponse(set, result);
    }
    return result.result;
  })
  .post("/:id/move", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{
      destFolderId?: string | null;
      name?: string;
      dryRun?: boolean;
    }>(request);
    const result = await moveFolder(
      env,
      params.id,
      {
        destFolderId: body?.destFolderId,
        dryRun: body?.dryRun,
        name: body?.name,
      },
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return moveErrorResponse(set, result);
    }
    return result.result;
  })
  .post("/:id/move-contents", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{
      destFolderId?: string | null;
      includeSubfolders?: boolean;
      dryRun?: boolean;
    }>(request);
    const result = await moveFolderContents(
      env,
      params.id,
      {
        destFolderId: body?.destFolderId,
        dryRun: body?.dryRun,
        includeSubfolders: body?.includeSubfolders,
      },
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return moveErrorResponse(set, result);
    }
    return result.result;
  })
  .patch("/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const body = await parseJsonBody<{ name?: string }>(request);
    const name = normalizeFolderName(body?.name ?? "");
    if (!name) {
      set.status = 400;
      return { error: "フォルダ名が不正です" };
    }

    const result = await notes.renameFolder(params.id, name, user);
    if (result.kind === "not_found") {
      set.status = 404;
      return { error: "Not found" };
    }
    if (result.kind === "denied") {
      set.status = result.status;
      return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
    }
    if (result.kind === "invalid") {
      set.status = result.status;
      return { error: result.error };
    }

    return result.access;
  })
  .delete("/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const result = await notes.removeFolder(params.id, user);
    if (result.kind === "not_found") {
      set.status = 404;
      return { error: "Not found" };
    }
    if (result.kind === "denied") {
      set.status = result.status;
      return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
    }

    set.status = 204;
    return new Response(null, { status: 204 });
  });
