import type { SessionUser } from "@miyulabmd/shared";

export const API_SESSION_USER_HEADER = "X-MiyulabMD-Session-User";

/** Identity of the incoming verified session, not the note owner or a new cookie. */
export function withApiSessionIdentity(
  response: Response,
  user: SessionUser | null,
): Response {
  const headers = new Headers(response.headers);
  headers.set(API_SESSION_USER_HEADER, user ? `user:${user.id}` : "guest");
  // Even public resource bodies now carry request-specific session metadata.
  // Do not let shared or browser HTTP caches reuse that metadata.
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
