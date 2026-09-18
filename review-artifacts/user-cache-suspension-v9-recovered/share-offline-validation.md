# C4 Share validation

Candidate only; no stage, commit, or live source adoption. Dependencies were
installed from the frozen lockfile (initial Windows junction conflicts required
`pnpm install --frozen-lockfile --force`); Chromium was installed through the
existing project-local Playwright wrapper.

## Test-first evidence

Before adding the page candidate, the seeded canonical note plus real short ID
test failed to display its cached body. After implementation the real short-ID
case still fails because the unchanged core cache resolves exact keys only.
The test is retained, not skipped or weakened. Parent will fix that dependency.

Explicit run:

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-share-view.spec.ts --workers=1
```

Result: **6 passed, 1 failed** (offline short-ID lookup).

Passing cases cover canonical cached private body, cache provenance/saved year,
disabled task checkbox, no Edit button, zero note API requests and zero Yjs
connections, and same-document cached viewer change from Alice to Bob via shell
online recovery (old body disappears and a cache miss is shown). Vite HMR
WebSockets are excluded from the Yjs assertion.

Online guest cases pass for 200, 401 login link, 403 denial, 404 not found, and
503 error. No cache-status banner is shown for these network results.

The existing candidate runner `typecheck` mode passes. Focused Biome check of
the new page and test passes. SSR removal is retained in the layout effect,
including terminal errors and empty bodies; no full service-worker navigation
claim is made here, since the parent owns `/s` shell fallback.
