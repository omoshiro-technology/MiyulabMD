import type { SessionUser } from "@miyulabmd/shared";
import { jwtVerify, SignJWT } from "jose";

const COOKIE_NAME = "miyulabmd_session";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;
// The API boundary and route handlers share one verification per Request.
// Weak keys retain neither cookies nor sessions across requests.
const sessions = new WeakMap<Request, Promise<SessionUser | null>>();

function sessionSecret(env: Env): Uint8Array | null {
  if (!env.SESSION_SECRET) {
    return null;
  }
  return new TextEncoder().encode(env.SESSION_SECRET);
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function readSession(
  request: Request,
  env: Env,
): Promise<SessionUser | null> {
  let session = sessions.get(request);
  if (!session) {
    session = verifyRequestSession(request, env);
    sessions.set(request, session);
  }
  return session;
}

async function verifyRequestSession(
  request: Request,
  env: Env,
): Promise<SessionUser | null> {
  const secret = sessionSecret(env);
  if (!secret) {
    return null;
  }

  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }

  const token = parseCookie(cookieHeader, COOKIE_NAME);
  if (!token) {
    return null;
  }

  return await readSessionFromToken(token, env);
}

function cookieFlags(secure: boolean): string {
  const parts = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (secure) {
    parts.splice(1, 0, "Secure");
  }
  return parts.join("; ");
}

export async function createSessionToken(
  user: SessionUser,
  env: Env,
): Promise<string> {
  const secret = sessionSecret(env);
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured");
  }

  return await new SignJWT({
    displayName: user.displayName,
    email: user.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(secret);
}

export async function readSessionFromToken(
  token: string,
  env: Env,
): Promise<SessionUser | null> {
  const secret = sessionSecret(env);
  if (!secret) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    const id = typeof payload.sub === "string" ? payload.sub : null;
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!(id && email)) {
      return null;
    }

    const displayName =
      typeof payload.displayName === "string" ? payload.displayName : null;

    return { displayName, email, id };
  } catch {
    return null;
  }
}

export async function sessionCookieHeader(
  user: SessionUser,
  env: Env,
  secure = true,
): Promise<string> {
  const token = await createSessionToken(user, env);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieFlags(secure)}; Max-Age=${SESSION_MAX_AGE_SEC}`;
}

export function sessionCookieFromToken(token: string, secure = true): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieFlags(secure)}; Max-Age=${SESSION_MAX_AGE_SEC}`;
}

export function clearSessionCookieHeader(secure = true): string {
  return `${COOKIE_NAME}=; ${cookieFlags(secure)}; Max-Age=0`;
}
