import type { SessionUser, UserSettings } from "@miyulabmd/shared";
import {
  accessLoginUrl,
  isAccessConfigured,
  verifyAccessJwt,
} from "../auth/access.ts";
import { withApiSessionIdentity } from "../auth/api-response.ts";
import {
  clearSessionCookieHeader,
  createSessionToken,
  readSession,
  readSessionFromToken,
  sessionCookieFromToken,
  sessionCookieHeader,
} from "../auth/session.ts";
import {
  type DbUser,
  findUserById,
  toSessionUser,
  updateDisplayName,
  upsertUserByEmail,
} from "../db/users.ts";
import { envTruthy } from "../env.ts";
import {
  readUserSettings,
  updateUserKnowledgeSettings,
} from "../services/settings.ts";

function isDevAuthEnabled(env: Env): boolean {
  return envTruthy(env.DEV_AUTH);
}

function shouldUseMockLogin(request: Request, env: Env): boolean {
  if (!isDevAuthEnabled(env)) {
    return false;
  }
  if (request.headers.get("X-Dev-User-Email")) {
    return true;
  }
  return !isAccessConfigured(env);
}

function mockEmail(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("email");
  if (fromQuery) {
    return fromQuery;
  }
  return request.headers.get("X-Dev-User-Email");
}

function requestIsHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function teamDomain(env: Env): string {
  return env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Access 配下の /auth/* で Set-Cookie すると、エッジが Cookie を落として
 * セッションが残らないことがある。Access の外の /api/auth/establish に渡す。
 */
async function finishLogin(
  env: Env,
  email: string,
  displayName: string | null,
): Promise<Response> {
  const user = await upsertUserByEmail(env, email, displayName);
  const token = await createSessionToken(toSessionUser(user), env);
  const html = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><title>ログインしています</title></head>
  <body>
    <p>ログインしています…</p>
    <form id="establish" method="POST" action="/api/auth/establish">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <noscript><button type="submit">続行</button></noscript>
    </form>
    <script>document.getElementById("establish").submit()</script>
  </body>
</html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
    status: 200,
  });
}

function accessFailurePage(reason: string): Response {
  const html = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><title>ログインに失敗しました</title></head>
  <body>
    <h1>ログインに失敗しました</h1>
    <p>Cloudflare Access の認証は通りましたが、アプリセッションを発行できませんでした。</p>
    <p>理由: <code>${escapeHtml(reason)}</code></p>
    <p><a href="/auth/logout">一度ログアウトして再試行</a></p>
  </body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 401,
  });
}

function logoutResponse(
  request: Request,
  env: Env,
  preferRedirect: boolean,
): Response {
  const headers = new Headers({
    "Set-Cookie": clearSessionCookieHeader(requestIsHttps(request)),
  });

  if (isAccessConfigured(env)) {
    const returnTo = new URL("/", request.url).toString();
    const logout = new URL(`https://${teamDomain(env)}/cdn-cgi/access/logout`);
    logout.searchParams.set("returnTo", returnTo);
    headers.set("Location", logout.toString());
    return new Response(null, { headers, status: 302 });
  }

  if (preferRedirect) {
    headers.set("Location", "/");
    return new Response(null, { headers, status: 302 });
  }

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ ok: true }), { headers, status: 200 });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (
    request.method !== "POST" ||
    request.headers.get("X-MiyulabMD-Logout") !== "prepare"
  ) {
    return logoutResponse(request, env, request.method === "GET");
  }
  // Preparation clears the app cookie without following Access through fetch.
  // The client must still navigate the native GET for Access completion.
  const actor = await readSession(request, env);
  return withApiSessionIdentity(
    Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": clearSessionCookieHeader(requestIsHttps(request)),
        },
      },
    ),
    actor,
  );
}

/** Access 通過後の生 Request を Elysia を介さず処理する。 */
export async function handleAuthRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/auth/")) {
    return null;
  }

  if (pathname === "/auth/logout") {
    return handleLogout(request, env);
  }

  if (pathname !== "/auth/login" && pathname !== "/auth/callback") {
    return new Response("Not found", { status: 404 });
  }

  const verified = await verifyAccessJwt(request, env);
  if (verified.ok) {
    return finishLogin(env, verified.claims.email, verified.claims.displayName);
  }

  if (pathname === "/auth/login" && shouldUseMockLogin(request, env)) {
    const email = mockEmail(request);
    if (!email) {
      return new Response(
        "email query parameter or X-Dev-User-Email header is required",
        {
          status: 400,
        },
      );
    }
    return finishLogin(env, email, email.split("@")[0] ?? null);
  }

  if (isAccessConfigured(env)) {
    console.warn("access login skipped", verified.reason);
    if (verified.reason !== "missing_jwt" || pathname === "/auth/callback") {
      return accessFailurePage(verified.reason);
    }
    return new Response(null, {
      headers: { Location: accessLoginUrl(request, env) },
      status: 302,
    });
  }

  return new Response("Cloudflare Access is not configured", { status: 503 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    headers: { "Content-Type": "application/json" },
    status: 400,
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    headers: { "Content-Type": "application/json" },
    status: 404,
  });
}

type UpdateMePatch = {
  /** undefined = キー未指定（更新しない）。null は明示的なクリア。 */
  displayName?: string | null;
  knowledge?: Record<string, unknown>;
};

async function parseUpdateMeBody(
  request: Request,
): Promise<UpdateMePatch | Response> {
  let body: { displayName?: unknown; settings?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest("Invalid JSON body");
  }
  const patch: UpdateMePatch = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" && body.displayName !== null) {
      return badRequest("displayName must be a string");
    }
    patch.displayName = body.displayName;
  }
  if (body.settings !== undefined) {
    if (!isRecord(body.settings)) {
      return badRequest("settings must be an object");
    }
    const knowledge = body.settings.knowledge;
    if (knowledge !== undefined) {
      if (!isRecord(knowledge)) {
        return badRequest("settings.knowledge must be an object");
      }
      patch.knowledge = knowledge;
    }
  }
  return patch;
}

export async function handleUpdateMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      headers: { "Content-Type": "application/json" },
      status: 401,
    });
  }

  const patch = await parseUpdateMeBody(request);
  if (patch instanceof Response) {
    return patch;
  }

  // displayName / settings.knowledge とも部分更新。未指定のキーは触らない
  // （settings だけの PATCH で表示名が消えないようにする）。
  let updated: DbUser | null = null;
  if (patch.displayName !== undefined) {
    updated = await updateDisplayName(env, session.id, patch.displayName);
    if (!updated) {
      return notFound();
    }
  }

  let settings: UserSettings | null = null;
  if (patch.knowledge) {
    settings = await updateUserKnowledgeSettings(
      env,
      session.id,
      patch.knowledge,
    );
    if (!settings) {
      return notFound();
    }
  }

  updated ??= await findUserById(env, session.id);
  if (!updated) {
    return notFound();
  }
  settings ??= await readUserSettings(env, session.id);

  const user: SessionUser = { ...toSessionUser(updated), settings };
  const setCookie = await sessionCookieHeader(
    user,
    env,
    requestIsHttps(request),
  );
  return new Response(JSON.stringify({ user }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": setCookie,
    },
    status: 200,
  });
}

/** Access の外でセッション Cookie を付ける。 */
export async function handleEstablishSession(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      headers: { Allow: "POST" },
      status: 405,
    });
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  let token: string | null = null;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : null;
  } else {
    const text = await request.text();
    token = new URLSearchParams(text).get("token");
  }

  if (!token) {
    return new Response("Missing session token", { status: 400 });
  }

  const user = await readSessionFromToken(token, env);
  if (!user) {
    return new Response("Invalid session token", { status: 401 });
  }

  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      Location: "/",
      "Set-Cookie": sessionCookieFromToken(token, requestIsHttps(request)),
    },
    status: 302,
  });
}
