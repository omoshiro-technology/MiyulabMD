# Network-only preview image validation

## Evidence status

The parent measurement was RED: 1/11 passed and 10/11 failed. The primary
failure was nested imports of `../../api-fetch.ts` and `../../api-transport.ts`;
the overlay virtual path is `apps/web/src/lib`, so the imports must be
`./api-fetch.ts` and `./api-transport.ts`. The parent also measured 23 Biome
errors. The resolver-only fixtures named as cache-backed acquisition/sharing
regressions were removed because they did not exercise transport, storage, or
foreground/background sharing.

The browser spec is present at
`apps/web/tests/browser/network-only-preview-image.spec.ts`. The isolated
candidate worktree has no `node_modules`, so the browser runner, typecheck, and
lint could not be executed here. No GREEN result is claimed. The parent worker
should run the requested browser matrix and candidate regression suite with its
installed dependencies. `node --experimental-strip-types --check` passes for
the new spec. This candidate does not claim the full matrix is green.

## Required RED/GREEN matrix

- RED: guest plus a `user:alice` response must demonstrate the prior raw
  `<img>` display, without a fetch spy.
- GREEN: guest/`guest` and authenticated Alice/`user:alice` display through
  Blob URLs; wrong, missing, or malformed identities are hidden.
- GREEN: HTTP denial/status errors, unsupported or missing MIME, and redirects
  do not fall back to cache or raw source.
- GREEN: network-only runs show zero IndexedDB, OPFS, metadata-write, denial,
  and recovery activity.
- GREEN: unmount/context switch aborts transport and publishes no late result;
  created Blob URLs are revoked.
- GREEN: guest and Alice never share a transport; same-actor consumers share
  one request and only abort it when the final consumer leaves.
- GREEN: existing cache-enabled foreground/background quota sharing remains
  unchanged.

## Review follow-up

The prior candidate was not approved: it routed every network source through
network-only, used an `error.name` identity check, accepted empty image bodies,
left rejected response bodies undisposed, and left managed raw URLs visible
without an image context. This revision addresses those findings with explicit
acquisition modes, an `instanceof ApiIdentityError` check, best-effort body
disposal, empty-body rejection, and fail-closed managed-image resolution.
Candidate-wide typecheck remains blocked by a known error in another candidate
folder. No full browser matrix, Biome, or candidate typecheck was run in this
isolated checkout because dependencies are absent.

## Remaining risk

The candidate source has not been executed in this isolated checkout. Browser
coverage and source/runtime compatibility therefore remain for the parent
worker to establish.

## This structural revision

The parent focused run measured 21/23 passing. The two failures were the guest
note fixture lacking an explicit `X-MiyulabMD-Session-User: guest` response
header (the note itself was rejected) and a cache-disabled storage assertion
observing one IndexedDB open. The latter was caused by static loading of
`offline-cache.ts` through the network-only image path; the assertion remains
zero rather than being weakened. The candidate now isolates parsing in
`attached-image-target.ts`, transport and actor-keyed sharing in
`network-attached-images.ts`, and dynamically loads cache modules only for
cache modes. The MIME parser also uses optional chaining before `trim()`.

The requested candidate Biome baseline was 22 errors and the candidate type
baseline had one MIME parse error. Dependencies are absent here, so the
browser matrix, typecheck, and Biome remain unexecuted; these measurements
must be re-run by the parent worker. The node strip-types syntax check and
`git diff --check` were run successfully.

## Candidate style pass

The five checked candidate files pass `pnpm dlx @biomejs/biome check`. The
network-only browser suite and web typecheck were not runnable because this
worktree has no installed dependencies (`node_modules` is absent). The
browser spec passes `node --experimental-strip-types --check`, and
`git diff --check` passes. No browser GREEN result is claimed.

## Parent validation after candidate fixes

The parent worker measured the network-only browser suite at 10/10 passing,
including DOM, storage, actor, status, MIME, and abort coverage. The focused
network plus existing-image/quota run measured 17/29 passing. Candidate
typecheck reported two errors: the missing local `attachedImage` binding in
`attached-images.ts` and the invalid-target `Promise<Blob | null>` return in
`network-attached-images.ts`; both are addressed by this candidate fix. The
five checked candidate files passed Biome.
## Reviewer final findings and fix status

The reviewer findings were addressed in the candidate source:

- **P0 adoption accounting:** the two previously unlisted new libraries are
  mapped explicitly in `network-only-image-adoption-manifest.md`; the
  historical composed manifest remains an immutable D125/D126 record.
- **P1 initialization:** non-abort initialization failures now publish an
  owned empty map with `unavailable` status, so the preview settles to
  `画像を表示できません` instead of loading forever. Cleanup and context
  ownership checks prevent late state or URL publication.
- **P1 SSR:** `resolvePreviewImages` no longer touches `document` when it is
  unavailable. The pure fallback removes managed image sources while retaining
  prose and external sources.
- **P2 lifecycle coverage:** existing browser lifetime coverage exercises blob
  creation/revocation and cache-backed DOM cleanup; the network-only regression
  suite remains the source of the actor and transport checks.

Not verified in this worker: live adoption of the two new files, the complete
browser suite, and a deliberately failed dynamic-import fixture. The
pre-existing mounted-folder worktree diff was not staged.

## Final static checks

The parent worker's final candidate checks found and fixed the remaining four
static diagnostics: one typecheck error from the widened `status` value passed
to `MarkdownPreview`, plus three image-side Biome diagnostics (the two default
origin ternaries, the `useMemo` return-key order, and the managed-image
predicate). The candidate hook now exposes the literal status union
`"loading" | "ready" | "unavailable"` without an unsafe cast. The parent should
rerun the focused browser regression and static checks after this style-only
commit; the mounted-folder test change remains excluded.

## Mounted image invalidation style correction

The parent measured four source/artifact hash pairs as matching, with live app
and service-worker typechecks passing. One Biome diagnostic remained in the
mounted image invalidation predicate; both source copies now use the exact
single-line formatter output. The corrected `preview-images.ts` pair has SHA-256
`52b3187ec4c2296fdf8e5576302e265134a2199783aead887e1ee06566f056f2`.

## Candidate-only final style correction

The parent measured candidate typecheck as passing and found one remaining
image-side Biome error: both SSR-safe `origin` default parameters used a
line break after `origin =`. Those two defaults now use Biome's expected
format. No live or folder test was run.

## Deterministic lifecycle regression

The parent measured the focused browser matrix at 29/30 passing, and the
`offline-image-lifetime` test failed both in the matrix and when rerun alone:
`preview owns blob URLs and purge removes visible assets and revokes them`.
After `clearOfflineCacheUser`, the old blob URL remained in the rendered
`img`. The invalidation callback previously aborted the acquisition controller
and then called `publish`, whose abort guard prevented the mounted preview from
receiving the empty state. The candidate now separates mounted ownership from
acquisition abort: purge aborts pending work, revokes owned URLs, publishes a
fail-closed null map while the owner is mounted, and cleanup still only aborts
and revokes without setting state. Parent should rerun the 29/30 matrix and
the standalone regression after this candidate-only fix.
