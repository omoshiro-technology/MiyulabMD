import { env } from "cloudflare:workers";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import {
  createSchemeChild,
  jdAllocateId,
  jdListCategory,
  listSchemeRoots,
  type SchemeError,
  schemeGet,
  suggestSchemeChild,
  validateSchemeTree,
} from "../services/schemes.ts";

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function schemeErrorResponse(
  set: { status?: number | string },
  result: SchemeError,
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

export const schemeRoutes = new Elysia({ prefix: "/api/schemes" })
  .get("/", async ({ request, set }) => {
    const user = await readSession(request, env);
    const result = await listSchemeRoots(env, user ?? undefined);
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    return result.result;
  })
  .get("/suggest", async ({ request, set }) => {
    const user = await readSession(request, env);
    const folderId = new URL(request.url).searchParams.get("folderId") ?? "";
    if (!folderId) {
      set.status = 400;
      return { error: "folderId を指定してください" };
    }
    const result = await suggestSchemeChild(env, folderId, user ?? undefined);
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    return result.result;
  })
  .post("/folders", async ({ request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{
      parentId?: string;
      schemeId?: string;
      title?: string;
    }>(request);
    if (!body?.parentId) {
      set.status = 400;
      return { error: "parentId を指定してください" };
    }
    const result = await createSchemeChild(
      env,
      body.parentId,
      { schemeId: body.schemeId, title: body.title },
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    set.status = 201;
    return result.result;
  })
  .post("/jd/allocate", async ({ request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<{ folderId?: string }>(request);
    if (!body?.folderId) {
      set.status = 400;
      return { error: "folderId を指定してください" };
    }
    const result = await jdAllocateId(env, body.folderId, user ?? undefined);
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    return result.result;
  })
  .get("/jd/category/:folderId", async ({ params, request, set }) => {
    const user = await readSession(request, env);
    const result = await jdListCategory(
      env,
      params.folderId,
      user ?? undefined,
    );
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    return result.result;
  })
  .get("/resolve", async ({ request, set }) => {
    const user = await readSession(request, env);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const result = await schemeGet(env, id, user ?? undefined);
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    return result.result;
  })
  .get("/validate", async ({ request, set }) => {
    const user = await readSession(request, env);
    const result = await validateSchemeTree(env, user ?? undefined);
    if (result.kind !== "ok") {
      return schemeErrorResponse(set, result);
    }
    return result.result;
  });
