import { env } from "cloudflare:workers";
import type { CreateNoteInput, UpdateNoteMetaInput } from "@miyulabmd/shared";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import { createNoteService } from "../services/notes.ts";

type PatchNoteBody = UpdateNoteMetaInput & {
  markdown?: string;
};

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

const notes = createNoteService(env);

export const noteRoutes = new Elysia({ prefix: "/api/notes" })
  .get("/", async ({ request }) => {
    const user = await readSession(request, env);
    const list = user
      ? await notes.listForUser(user)
      : await notes.listForGuest();
    return { notes: list };
  })
  .post("/", async ({ request, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<CreateNoteInput>(request);

    const created = await notes.create(user ?? undefined, body ?? {});
    if ("error" in created) {
      set.status = created.status;
      return { error: created.error };
    }

    set.status = 201;
    return created;
  })
  .get("/:id", async ({ request, params, set }) => {
    const user = await readSession(request, env);
    const result = await notes.get(params.id, user ?? undefined);

    if (result.kind === "not_found") {
      set.status = 404;
      return { error: "Not found" };
    }
    if (result.kind === "denied") {
      set.status = result.status;
      return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
    }

    return result.note;
  })
  .patch("/:id", async ({ request, params, set }) => {
    const user = await readSession(request, env);
    const body = await parseJsonBody<PatchNoteBody>(request);
    if (!body) {
      set.status = 400;
      return { error: "Invalid JSON body" };
    }

    const { markdown, ...meta } = body;
    let latest = null as Awaited<ReturnType<typeof notes.updateMeta>> | null;

    const hasMeta =
      meta.title !== undefined ||
      meta.permission !== undefined ||
      meta.alias !== undefined ||
      meta.folder !== undefined ||
      meta.inheritAccess !== undefined ||
      meta.readScope !== undefined ||
      meta.writeScope !== undefined ||
      meta.grants !== undefined;

    if (hasMeta) {
      latest = await notes.updateMeta(params.id, user ?? undefined, meta);
      if (latest.kind !== "ok") {
        if (latest.kind === "not_found") {
          set.status = 404;
          return { error: "Not found" };
        }
        if (latest.kind === "bad_request") {
          set.status = 400;
          return { error: latest.error };
        }
        set.status = latest.status;
        return { error: latest.status === 401 ? "Unauthorized" : "Forbidden" };
      }
    }

    if (markdown !== undefined) {
      const markdownResult = await notes.updateMarkdown(
        params.id,
        user ?? undefined,
        markdown,
      );
      if (markdownResult.kind !== "ok") {
        if (markdownResult.kind === "not_found") {
          set.status = 404;
          return { error: "Not found" };
        }
        if (markdownResult.kind === "bad_request") {
          set.status = 400;
          return { error: markdownResult.error };
        }
        set.status = markdownResult.status;
        return {
          error: markdownResult.status === 401 ? "Unauthorized" : "Forbidden",
        };
      }
      latest = markdownResult;
    }

    if (!latest || latest.kind !== "ok") {
      set.status = 400;
      return { error: "No fields to update" };
    }

    return latest.note;
  })
  .delete("/:id", async ({ request, params, set }) => {
    const user = await readSession(request, env);
    const result = await notes.remove(params.id, user ?? undefined);

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
