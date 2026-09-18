# API response session identity (backend foundation)

Every `/api/*` response carries `X-MiyulabMD-Session-User`: `user:<id>`
for a server-verified incoming session cookie, or the explicit sentinel `guest`
for an absent/invalid session. The request header of that name is ignored.
Neither tokens nor email addresses are exposed. `ownerId` remains resource
ownership, not viewer identity: Bob reading Alice's shared note receives Bob's
session identity.

The Worker boundary uses the same request-local `readSession` verification as
the route handlers. This applies to binary images, lists, notes, errors,
unknown API routes, and API auth responses, not just `/api/me`. Auth establish
responses describe the **incoming** cookie, not the newly issued cookie;
their redirect and Set-Cookie remain intact. `/auth/*`, WebSocket upgrades,
MCP, assets and SSR retain their existing behavior.

## Cache policy

All API responses use `Cache-Control: private, no-store`, including guest and
public-note responses. This deliberately sacrifices HTTP caching of public API
bodies to avoid persisting or sharing their request-specific identity metadata.
`Vary: Cookie` alone would still permit storage, so it is not the policy.
Existing unrelated Vary headers are preserved. The separate public guest SSR
cache is unchanged and never receives this header. No API response is inserted
into the Worker's SSR Cache API cache.

## Remaining client work

This is not completion of C2. Clients must next validate the actual response
identity against their captured session before publishing data or caching it,
with fail-closed treatment of missing/mismatched identity. A preflight `/api/me`
cannot close the cookie-switch race; the subsequent response must be checked.
No client candidate, cache, Durable Object, snapshot or shared snapshot protocol
changes are part of this foundation.

The local Worker fixture `worker-response-identity.spec.ts` creates real Alice
and Bob sessions through DEV_AUTH, switches the request cookie after an Alice
preflight, and checks note/list/image/error/guest responses and spoof resistance.

## Explicit logout preparation

`POST /auth/logout` with `X-MiyulabMD-Logout: prepare` is the narrow exception
to the unchanged `/auth/*` behavior above. It deletes the application session
cookie and returns `{ "ok": true }` with the verified **incoming** actor and
`Cache-Control: private, no-store`. The client can identify which local user
cache needs deletion without following an opaque Cloudflare Access redirect.
The response does not establish a new viewer. Request-supplied actor headers
remain untrusted.

The client must subsequently navigate to the ordinary `GET /auth/logout` to
complete Access logout. Native GET and POST without the opt-in header keep
their original redirect behavior. Preparation is idempotent: after cookie
deletion, another preparation reports `guest`.

Validation:

- Direct route/session tests: **2 passed**, including preservation of Access
  redirects and cookie deletion. Included in the Worker package test command.
- Real local Worker command:
  `node apps/web/scripts/test-worker.mjs --grep 'logout preparation clears'`
  — **1 passed**. Real session establishment, spoofed actor rejection, readable
  preparation response, subsequent `/api/me` guest result, repeated preparation,
  and native logout redirect were checked. Owned runtime and processes cleaned.
- Targeted Biome check passed after extracting the logout handler to keep the
  auth dispatcher within its existing complexity limit.

This verifies the server endpoint, not the candidate frontend's full
logout/switch/cache-purge integration or production Cloudflare Access.
