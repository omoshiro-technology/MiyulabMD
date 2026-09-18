# C8 attached-image first slice — candidate

Baseline: offline-cache `963fef222a16c99829cbad6fc888cc042c76ee1e341fa241eaaff9be31374893`,
note-read-session `8487ab5bf0761da41bed6f1356e4d84541a00bda9f070ca9baf072a7705f4482`,
home-metadata-reader `eaa4cb40537d44649b018758930a598f61862d81cba76a976a3f473fbeaeee33`.
The latter two are untouched.

## Decisions

- Keep the existing v4 IndexedDB database. Image references fit its metadata
  key/value store, with `image:<encoded user>:<encoded referenced parent>:<encoded image>`.
  There is no schema change, destructive upgrade, or second database.
- Store immutable binary OPFS files beside that referenced parent's note files,
  below the existing user directory. Close the new file before committing its
  metadata reference. Failure cleans only the new unreferenced file, preserving
  the previous reference. Old successfully replaced files await the later GC
  stage; user purge removes all of them now.
- Reuse the existing per-user shared storage lock, durable epoch transaction
  guard, final scope guards, tracked open handles and pending-write purge fence.
  Purge also deletes image metadata in its existing transaction.
- `attached-images.ts` is the only image acquisition path for preview and final
  prefetch stage. It uses the shared Markdown image collector. Only same-origin
  `/api/notes/:id/images/:imageId` is eligible; the parent comes from the URL,
  not the viewed note. PNG/JPEG/GIF/WebP match the existing upload contract.
- Fetch uses the existing API wrapper, credentials, no HTTP cache, and no redirects.
  401/403/404 never fall back to old bytes; an image-only durable denial prevents
  later cached reads without denying the note body. Definite denial persistence
  failure suspends the user cache. Communication/5xx may use committed bytes.
- Preview owns blob creation/revocation. It maps only app-image destinations in
  already sanitized HTML, using an inert template before DOM insertion to avoid
  duplicate browser downloads. Raw Markdown/Yjs are unchanged. The shared
  renderer and exact output when no view resolver is provided are unchanged.
- Foreground renders the body immediately; attachment acquisition is an effect.
  Missing/forbidden images have a status message. Preview cleanup/invalidation
  revokes URLs and removes resolved sources.
- Prefetch collects references while acquiring notes, then downloads images
  sequentially only after all note bodies. It uses the same per-viewer/epoch/image
  in-flight helper, with independent consumer cancellation.

## Checkpoint evidence

- Initial local run could not load Vite: this agent clone lacked dependencies.
  Authorized `pnpm install --frozen-lockfile` succeeded (855 reused, 0 downloaded).
- Candidate typecheck passed after cache/preview wiring, before final prefetch edit.
- First browser attempt failed only because local Chromium was absent.
  Authorized `node apps/web/scripts/playwright.mjs install chromium` succeeded.
- Parent RED `offline-image-view.spec.ts`: **1 passed**. HTTP-cache-disabled
  online image and offline reload both have naturalWidth 1; body remains raw.
- First focused storage/helper+view run: **6 passed, 1 failed**. Failure was the
  new test's expected key using literal IDs instead of the existing base64url
  encoding. Corrected expectation and corrected OPFS directory assertion to
  check the actual encoded user directory. Rerun pending at this checkpoint.
- Read-only Biome check found formatting/block/import/complexity issues in new
  code; cleanup pending. No formatter writes or live source adoption performed.

The checkpoint items above are historical. The final candidate passes all 12
image tests, candidate typecheck, candidate Biome (29 files), and new test Biome
(3 files). See `attached-image-validation.md` for exact failures encountered in
wider regression runs and the frozen hashes.

No AppShell/logout/UI-clear/Worker/API transport/coordinator/runner changes.

## C2 integration handoff

The image helper already calls canonical `apiFetch`, not native fetch.
The parent is assigning captured HTTP viewer identity checking to a separate
worker. Once its optional `viewerId` fetch option exists, add
`viewerId: scope.userId` to `readNetworkImage`'s request initializer. This C8
candidate does not modify the common transport or existing prefetch metadata
request options, and does not pretend that the future identity-header check is
already present.
