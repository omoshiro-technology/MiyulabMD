import { env } from "cloudflare:workers";
import type { MedallionLayer } from "@miyulabmd/shared";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import {
  assignFolderMedallion,
  clearFolderMedallion,
  createMedallionSet,
  deleteMedallionSet,
  ensureDefaultMedallionSet,
  listMedallionAssignments,
  listMedallionSets,
  type MedallionResult,
  resolveMedallion,
  updateMedallionSet,
} from "../services/medallion.ts";

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function medallionError(
  set: { status?: number | string },
  result: Exclude<MedallionResult<unknown>, { kind: "ok" }>,
) {
  if (result.kind === "not_found") {
    set.status = 404;
    return { error: "Not found" };
  }
  if (result.kind === "denied") {
    set.status = 403;
    return { error: "Forbidden" };
  }
  if (result.kind === "confirm_required") {
    // 409 + count lets the UI ask "unassign N folders?" before retrying.
    set.status = 409;
    return {
      assignedFolders: result.assignedFolders,
      error: "confirm_required",
    };
  }
  set.status = 400;
  return { error: result.message ?? "Invalid request" };
}

export const medallionRoutes = new Elysia({ prefix: "/api/medallion" })
  .get("/sets", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return { sets: await listMedallionSets(env, user) };
  })
  .post("/sets/default", async ({ request, set }) => {
    // Idempotent seed of the built-in 精緻度 set (called when the feature is
    // enabled). Safe to call repeatedly.
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return { set: await ensureDefaultMedallionSet(env, user) };
  })
  .post("/sets", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const body = await parseJsonBody<{
      name?: string;
      layers?: MedallionLayer[];
    }>(request);
    const result = await createMedallionSet(env, user, body ?? {});
    if (result.kind !== "ok") {
      return medallionError(set, result);
    }
    set.status = 201;
    return { set: result.result };
  })
  .patch("/sets/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const body = await parseJsonBody<{
      name?: string;
      layers?: MedallionLayer[];
    }>(request);
    const result = await updateMedallionSet(env, user, params.id, body ?? {});
    if (result.kind !== "ok") {
      return medallionError(set, result);
    }
    return { set: result.result };
  })
  .delete("/sets/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const confirm = new URL(request.url).searchParams.get("confirm") === "1";
    const result = await deleteMedallionSet(env, user, params.id, confirm);
    if (result.kind !== "ok") {
      return medallionError(set, result);
    }
    return { ok: true };
  })
  .get("/assignments", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return { assignments: await listMedallionAssignments(env, user) };
  })
  .get("/resolve", async ({ request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const path = new URL(request.url).searchParams.get("path") ?? "";
    return { medallion: await resolveMedallion(env, user, path) };
  })
  .put("/folders/:folderId", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const body = await parseJsonBody<{ setId?: string; layer?: string }>(
      request,
    );
    if (!(body?.setId && body.layer)) {
      set.status = 400;
      return { error: "setId と layer が必要です" };
    }
    const result = await assignFolderMedallion(
      env,
      user,
      params.folderId,
      body.setId,
      body.layer,
    );
    if (result.kind !== "ok") {
      return medallionError(set, result);
    }
    return { assignment: result.result };
  })
  .delete("/folders/:folderId", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const result = await clearFolderMedallion(env, user, params.folderId);
    if (result.kind !== "ok") {
      return medallionError(set, result);
    }
    return { ok: true };
  });
