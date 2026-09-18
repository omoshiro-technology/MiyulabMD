import { env } from "cloudflare:workers";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import { createImageService } from "../services/images.ts";

const images = createImageService(env);

async function parseUploadFile(request: Request): Promise<File | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const field = form.get("file");
    return field instanceof File ? field : null;
  }

  if (contentType.startsWith("image/")) {
    const blob = await request.blob();
    return new File([blob], "upload", { type: contentType });
  }

  return null;
}

export const imageRoutes = new Elysia({ prefix: "/api/notes" })
  .post("/:id/images", async ({ request, params, set }) => {
    const user = await readSession(request, env);
    const file = await parseUploadFile(request);

    if (!file) {
      set.status = 400;
      return { error: "file required" };
    }

    const result = await images.upload(params.id, user ?? undefined, file);

    if (result.kind === "not_found") {
      set.status = 404;
      return { error: "Not found" };
    }
    if (result.kind === "denied") {
      set.status = result.status;
      return {
        error:
          result.code ?? (result.status === 401 ? "Unauthorized" : "Forbidden"),
      };
    }
    if (result.kind === "bad_request") {
      set.status = 400;
      return { error: result.error };
    }

    set.status = 201;
    return { id: result.id, url: result.url };
  })
  .get("/:id/images/:imageId", async ({ request, params, set }) => {
    const user = await readSession(request, env);
    const result = await images.get(
      params.id,
      params.imageId,
      user ?? undefined,
    );

    if (result.kind === "not_found") {
      set.status = 404;
      return { error: "Not found" };
    }
    if (result.kind === "denied") {
      set.status = result.status;
      return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
    }

    return new Response(result.body, {
      headers: { "Content-Type": result.contentType },
    });
  });
