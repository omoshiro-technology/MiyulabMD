# PWA shell candidate decisions

- **Scope:** First production-only shell candidate for the MyDrive slice. The
  candidate is not live application code and does not implement IndexedDB,
  OPFS, prefetch, or offline note data.
- **Static cache:** `vite-plugin-pwa` `injectManifest` supplies the Workbox
  precache manifest. The 5 MiB limit includes the current approximately 2.3 MiB
  main bundle and lazy assets. HTML is limited to the generated `index.html`;
  note and other SSR HTML is never precached.
- **Navigation:** `/`, `/f/:id`, and `/n/:id` use a direct network request while
  online. Only a failed request or temporary 5xx receives the pure index shell.
  `/s/:id`, settings, API/auth/MCP/openapi, WebSocket, and non-GET requests do
  not receive shell handling or runtime caching.
- **Lifecycle:** The worker does not call `skipWaiting`, `clientsClaim`, forced
  navigation, or broad cache deletion. Workbox's app-prefixed precache cache is
  the only cache it owns.

## D65 candidate: scoped old-precache cleanup

- **Status:** Implemented in this candidate and independently reviewable; not
  adopted into live application code.
- **Background:** The parent production PWA test seeded an obsolete app
  precache, a foreign precache, an app precache for another scope, and an
  unrelated data cache before activation. The obsolete app cache remained.
- **Decision:** On `activate`, await deletion only for cache names that start
  with the literal `miyulabmd-precache-` prefix and end with the exact current
  `registration.scope`, excluding Workbox's current `cacheNames.precache`.
- **Reason:** This removes superseded caches owned by this app in this scope
  without relying on Workbox's broader `cleanupOutdatedCaches` matching or
  deleting unrelated cache storage.
- **Lifecycle preserved:** No `skipWaiting`, `clientsClaim`, forced navigation,
  or reload was added. Existing navigation, privacy, and registration behavior
  remains unchanged.
- **Constraints:** Same-origin behavior, icon format, and ordinary service
  worker type-check integration remain separate reviews. The candidate remains
  under `review-artifacts/pwa-shell/`.

## D66/D67 hardening checkpoint

- **Checkpoint:** `372103c` (review-only candidate; no live adoption).
- **Status:** Implemented and validated in the candidate; pending parent review
  and adoption decision.
- **D66 same-origin defense:** The parent’s real-browser checks passed for both
  foreign `localhost` versus `127.0.0.1` navigation and same-origin navigation
  redirected to a foreign `503`, with the foreign response preserved. This is
  not an exploit reproduction. The candidate therefore adds Workbox’s explicit
  `sameOrigin` predicate before pathname matching as defense-in-depth, while
  preserving the existing redirect/4xx behavior and the no-runtime-HTML-cache
  rule.
- **D67 typecheck wiring:** The candidate’s normal Web `typecheck` script runs
  the app check and then `tsconfig.sw.json`. That worker config extends the
  common Web config and overrides only the worker `lib`, empty `types`, and
  worker include, keeping Worker globals out of app `src`.
- **Scope:** No icons, update policy, live files, tests, runner, dependencies,
  lockfile, or data were changed. The candidate remains under review.
