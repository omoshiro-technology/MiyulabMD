import { env } from "cloudflare:workers";
import type { ParaEnableInput } from "@miyulabmd/shared";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import {
  enablePara,
  paraArchiveProject,
  paraDeleteSpace,
  paraList,
  paraPlan,
  paraRenameSpace,
} from "../services/para.ts";

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function errorStatus(
  set: { status?: number | string },
  result: { kind: string; status?: number; error?: string },
) {
  if (result.kind === "not_found") {
    set.status = 404;
    return { error: "Not found" };
  }
  if (result.kind === "denied") {
    set.status = result.status ?? 403;
    return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
  }
  set.status = result.status ?? 400;
  return { error: result.error ?? "Invalid request" };
}

export const paraRoutes = new Elysia({ prefix: "/api/para" })
  .get("/", async ({ request, set }) => {
    const user = await readSession(request, env);
    const params = new URL(request.url).searchParams;
    const bucket = params.get("bucket") ?? undefined;
    // §2.5: ?space= narrows the response to one space (name, id, or
    // "default"); bucket children resolve inside that space.
    const space = params.get("space") ?? undefined;
    const result = await paraList(env, user ?? undefined, bucket, space);
    if (result.kind !== "ok") {
      return errorStatus(set, result);
    }
    return result.result;
  })
  .get("/plan", async ({ request, set }) => {
    const user = await readSession(request, env);
    // §2.5: ?space=<name|id|"default"> selects the space to inspect.
    const space = new URL(request.url).searchParams.get("space") ?? undefined;
    const result = await paraPlan(env, user ?? undefined, space);
    if (result.kind !== "ok") {
      return errorStatus(set, result);
    }
    return result.plan;
  })
  .post("/enable", async ({ request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<ParaEnableInput>(request);
    const result = await enablePara(env, body ?? {}, user ?? undefined);
    if (result.kind !== "ok") {
      return errorStatus(set, result);
    }
    return result.result;
  })
  .post("/archive", async ({ request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{
      folderId?: string;
      dated?: boolean;
      name?: string;
      dryRun?: boolean;
    }>(request);
    if (!body?.folderId) {
      set.status = 400;
      return { error: "folderId が必要です" };
    }
    const result = await paraArchiveProject(
      env,
      body.folderId,
      { dated: body.dated, dryRun: body.dryRun, name: body.name },
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return errorStatus(set, result);
    }
    return result.result;
  })
  .patch("/spaces/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{ name?: string }>(request);
    if (typeof body?.name !== "string") {
      set.status = 400;
      return { error: "name が必要です" };
    }
    const result = await paraRenameSpace(
      env,
      params.id,
      body.name,
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return errorStatus(set, result);
    }
    return { ok: true };
  })
  .delete("/spaces/:id", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    // §2.5: deleting a space unassigns its buckets; folders remain.
    const result = await paraDeleteSpace(env, params.id, user ?? undefined);
    if (result.kind !== "ok") {
      return errorStatus(set, result);
    }
    return { ok: true };
  });
