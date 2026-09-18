# Network-only preview image decisions

## Scope

This candidate adds `acquireAttachedImageNetworkOnly` while preserving the
existing cache-backed acquisition path. Preview acquisition is explicit:
cache views use cache-only, authenticated network views with a matching
`cacheViewerId` use cache-backed reads, and only guest or verified
authenticated-without-cache-id views use network-only. Mismatched or
unavailable contexts fail closed. The network-only in-flight namespace is separate
and keyed by the captured expected viewer (`null` for guest), so guest, Alice,
Bob, and cache-backed reads cannot share a transport.

The primitive validates the canonical same-origin attachment URL, calls
`apiFetch` with an explicit identity expectation, and accepts only a 2xx
response with PNG/JPEG/GIF/WebP MIME. It never opens offline storage, writes a
denial marker, performs recovery, or creates a Blob URL. Preview ownership
continues to revoke Blob URLs during cleanup and context changes.

## Deliberate compatibility

Cache-backed reads retain their existing `acquireAttachedImage` path and
foreground/background in-flight sharing, including `requireCache` behavior.
Only the network-only mode uses the new primitive. Cache-backed network views
retain subscriptions, scope capture, cache writes, denial markers, and
invalidation. Network-only views never open storage or subscribe to its
lifecycle. Managed image URLs are removed when no valid view context exists;
external images retain raw rendering.

## Storage boundary

`network-attached-images.ts` imports only the API transport and the
storage-free target parser. Its private MIME predicate intentionally mirrors
the PNG/JPEG/GIF/WebP cache predicate without importing `offline-cache.ts`.
`preview-images.ts` therefore has no static cache or attached-cache import:
cache subscriptions, scope capture, and cache acquisition begin only after the
cache module's dynamic import completes, and an aborted effect cannot publish
late work.
## Reviewer follow-up: checked preview image settlement

- Dynamic initialization failure is terminal for the current owned preview
  state: aborts remain silent, while import, capture-scope, and subscription
  failures publish an empty managed-image map with `unavailable` status.
- Preview resolution has a DOM-free fallback. It strips managed
  `/api/notes/.../images/...` sources conservatively, including encoded paths,
  while retaining body text and external image sources.
- Blob URLs remain preview-owned and are revoked by the existing effect cleanup;
  no delayed initialization branch publishes after abort.
