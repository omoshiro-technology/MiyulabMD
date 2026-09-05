import { createRemoteJWKSet, jwtVerify } from "jose";

export type AccessClaims = {
  email: string;
  displayName: string | null;
};

export type AccessVerifyResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: string };

function teamIssuer(env: Env): string {
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(
    /\/$/,
    "",
  );
  return `https://${domain}`;
}

export function isAccessConfigured(env: Env): boolean {
  return Boolean(
    env.ACCESS_AUD?.trim() &&
    env.ACCESS_TEAM_DOMAIN &&
    String(env.ACCESS_TEAM_DOMAIN) !== "example.cloudflareaccess.com",
  );
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export function extractAccessJwt(request: Request): string | null {
  const fromHeader =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    request.headers.get("cf-access-jwt-assertion");
  if (fromHeader) {
    return fromHeader;
  }

  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }
  return parseCookie(cookieHeader, "CF_Authorization");
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function emailFromPayload(
  payload: Record<string, unknown>,
  request: Request,
): string | null {
  const identity =
    payload.identity && typeof payload.identity === "object"
      ? (payload.identity as Record<string, unknown>)
      : null;

  const commonName = stringClaim(payload.common_name);
  return (
    stringClaim(payload.email) ??
    stringClaim(identity?.email) ??
    (commonName?.includes("@") ? commonName : null) ??
    request.headers.get("Cf-Access-Authenticated-User-Email")
  );
}

function displayNameFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const identity =
    payload.identity && typeof payload.identity === "object"
      ? (payload.identity as Record<string, unknown>)
      : null;

  return stringClaim(payload.name) ?? stringClaim(identity?.name) ?? null;
}

/** Cloudflare Access JWT を検証し identity を返す。 */
export async function verifyAccessJwt(
  request: Request,
  env: Env,
): Promise<AccessVerifyResult> {
  if (!isAccessConfigured(env) || !env.ACCESS_AUD) {
    return { ok: false, reason: "access_not_configured" };
  }

  const token = extractAccessJwt(request);
  if (!token) {
    return { ok: false, reason: "missing_jwt" };
  }

  const issuer = teamIssuer(env);
  const audience = env.ACCESS_AUD.trim();

  try {
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, jwks, { issuer, audience });
      payload = verified.payload as Record<string, unknown>;
    } catch (firstError) {
      // iss の表記ゆれ（末尾スラッシュなど）でも署名と aud は必ず見る
      const verified = await jwtVerify(token, jwks, { audience });
      payload = verified.payload as Record<string, unknown>;
      if (firstError instanceof Error) {
        console.warn(
          "access jwt issuer mismatch, accepted by aud+signature",
          firstError.message,
        );
      }
    }

    const email = emailFromPayload(payload, request);
    if (!email) {
      return { ok: false, reason: "missing_email_claim" };
    }

    return {
      ok: true,
      claims: { email, displayName: displayNameFromPayload(payload) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "verify_failed";
    console.warn("access jwt verify failed", message);
    return { ok: false, reason: message };
  }
}

export function accessLoginUrl(request: Request, env: Env): string {
  const callback = new URL("/auth/callback", request.url).toString();
  return `${teamIssuer(env)}/cdn-cgi/access/login?redirect_url=${encodeURIComponent(callback)}`;
}
