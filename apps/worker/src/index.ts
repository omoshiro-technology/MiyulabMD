import { env } from "cloudflare:workers";
import { collectOgUrls, renderMarkdownHtml } from "@miyulabmd/markdown";
import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { isAccessConfigured } from "./auth/access.ts";
import { withApiSessionIdentity } from "./auth/api-response.ts";
import { readSession } from "./auth/session.ts";
import { envTruthy } from "./env.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { openApiDocument } from "./openapi.ts";
import { articleSourceRoutes } from "./routes/article-sources.ts";
import { articleRoutes } from "./routes/articles.ts";
import {
  handleAuthRequest,
  handleEstablishSession,
  handleUpdateMe,
} from "./routes/auth.ts";
import { folderRoutes } from "./routes/folders.ts";
import { imageRoutes } from "./routes/images.ts";
import { medallionRoutes } from "./routes/medallion.ts";
import { noteRoutes } from "./routes/notes.ts";
import { ogRoutes } from "./routes/og.ts";
import { paraRoutes } from "./routes/para.ts";
import { schemeRoutes } from "./routes/schemes.ts";
import { searchRoutes } from "./routes/search.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { createNoteService } from "./services/notes.ts";
import { peekOgCards, warmOgCards } from "./services/og.ts";
import { readUserSettings } from "./services/settings.ts";
import {
  injectNotePage,
  isPublicGuestCacheable,
  notePageId,
} from "./ssr/inject-note-page.ts";

export { DocumentRoom } from "./durable-objects/DocumentRoom.ts";

const api = new Elysia({ adapter: CloudflareAdapter })
  .get("/api/health", () => ({ ok: true }))
  .get("/api/me", async ({ request }) => {
    const user = await readSession(request, env);
    if (!user) {
      return { user: null };
    }
    const settings = await readUserSettings(env, user.id);
    return { user: { ...user, settings } };
  })
  .get("/api/auth/config", () => {
    const access = isAccessConfigured(env);
    return {
      access,
      mock: envTruthy(env.DEV_AUTH) && !access,
    };
  })
  .get("/openapi.json", () => openApiDocument())
  .use(noteRoutes)
  .use(articleRoutes)
  .use(articleSourceRoutes)
  .use(folderRoutes)
  .use(medallionRoutes)
  .use(ogRoutes)
  .use(paraRoutes)
  .use(schemeRoutes)
  .use(searchRoutes)
  .use(tokenRoutes)
  .use(imageRoutes)
  .use(mcpRoutes)
  .compile();

function noteIdFromWsPath(pathname: string): string | null {
  const match = /^\/ws\/notes\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function isElysiaPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/openapi.json" ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/")
  );
}

function notePageCacheKey(url: URL): Request {
  return new Request(`${url.origin}${url.pathname}`, { method: "GET" });
}

async function handleNotePage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const id = notePageId(url.pathname);
  if (!id || (request.method !== "GET" && request.method !== "HEAD")) {
    return env.ASSETS.fetch(request);
  }

  const user = await readSession(request, env);
  const cacheable = !user;
  if (cacheable) {
    const cached = await caches.default.match(notePageCacheKey(url));
    if (cached) {
      return cached;
    }
  }

  const notes = createNoteService(env);
  const [result, assets] = await Promise.all([
    notes.get(id, user ?? undefined),
    env.ASSETS.fetch(request),
  ]);

  if (result.kind !== "ok") {
    return assets;
  }

  const indexHtml = await assets.text();
  const ogUrls = collectOgUrls(result.note.markdown);
  const ogCards = await peekOgCards(url.origin, ogUrls);
  const missingOg = ogUrls.filter((href) => !ogCards.has(href));
  if (missingOg.length > 0) {
    ctx.waitUntil(warmOgCards(url.origin, missingOg, env.OG_FETCH));
  }
  const previewHtml = renderMarkdownHtml(result.note.markdown, ogCards);
  const ogRecord = Object.fromEntries(ogCards);
  const body = injectNotePage(indexHtml, result.note, previewHtml, ogRecord);
  const publicCache =
    isPublicGuestCacheable(result.note, Boolean(user)) &&
    missingOg.length === 0;
  const headers = new Headers({
    "Cache-Control": publicCache ? "public, s-maxage=30" : "private, no-store",
    "Content-Type": "text/html; charset=utf-8",
  });

  if (request.method === "HEAD") {
    return new Response(null, { headers, status: 200 });
  }

  const response = new Response(body, { headers, status: 200 });
  if (publicCache) {
    ctx.waitUntil(caches.default.put(notePageCacheKey(url), response.clone()));
  }
  return response;
}

function applyWsUserHeaders(
  headers: Headers,
  user: { id: string; displayName: string | null; email: string },
): void {
  headers.set("X-User-Id", user.id);
  headers.set("X-User-Email", user.email);
  if (user.displayName) {
    headers.set("X-Display-Name", user.displayName);
  }
}

async function handleNoteWebSocket(
  request: Request,
  env: Env,
  noteId: string,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", {
      headers: { Upgrade: "websocket" },
      status: 426,
    });
  }

  const user = await readSession(request, env);
  const notes = createNoteService(env);
  const result = await notes.get(noteId, user ?? undefined);

  if (result.kind === "not_found") {
    return new Response("Not found", { status: 404 });
  }
  if (result.kind === "denied") {
    return new Response(result.status === 401 ? "Unauthorized" : "Forbidden", {
      status: result.status,
    });
  }

  const note = result.note;
  const id = env.DOCUMENT_ROOM.idFromName(note.id);
  const headers = new Headers(request.headers);
  headers.set("X-Note-Id", note.id);
  headers.set(
    "X-Can-Edit",
    note.access.flags.canEdit && !note.editLocked ? "true" : "false",
  );
  if (user) {
    applyWsUserHeaders(headers, user);
  }

  const doRequest = new Request(request.url, {
    headers,
    method: request.method,
  });
  return env.DOCUMENT_ROOM.get(id).fetch(doRequest);
}

async function handleAuthAndMeRoutes(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/api/auth/establish") {
    return handleEstablishSession(request, env);
  }
  if (pathname === "/api/me" && request.method === "PATCH") {
    return handleUpdateMe(request, env);
  }
  if (pathname.startsWith("/auth/")) {
    const authResponse = await handleAuthRequest(request, env);
    if (authResponse) {
      return authResponse;
    }
  }
  return null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (notePageId(pathname)) {
      return handleNotePage(request, env, ctx);
    }

    const noteId = noteIdFromWsPath(pathname);
    if (noteId) {
      return handleNoteWebSocket(request, env, noteId);
    }

    if (pathname.startsWith("/api/")) {
      const user = await readSession(request, env);
      let response: Response;
      try {
        response =
          (await handleAuthAndMeRoutes(request, env, pathname)) ??
          (await api.fetch(request));
      } catch {
        // Elysia handles route errors; this also covers non-Elysia API handlers.
        response = new Response("Internal Server Error", { status: 500 });
      }
      return withApiSessionIdentity(response, user);
    }

    const special = await handleAuthAndMeRoutes(request, env, pathname);
    if (special) {
      return special;
    }

    if (isElysiaPath(pathname)) {
      return api.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
