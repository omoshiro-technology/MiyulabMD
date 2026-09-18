# D111 cross-tab purge foundation (candidate only)

## Scope

Built on the candidate inverse-short-ID cache (`251422b7…`) and identity ledger
(`1edaa959…`). No live adoption, staging, commit, acquisition/coordinator changes,
UI/logout integration, editor, Worker, PWA, or API changes are included.

## Authority and operation boundaries

- The existing `miyulabmd-offline-cache` database, version 4, owns the authority:
  `metadata["user-epoch:" + encodedUserId]`. Absence means generation `"0"`.
  Successful purges retain a fresh UUID, rather than deleting the generation and
  accidentally making an old scope current again.
- The purge transaction deletes only the named user's cache records, applicable
  denial/root references, and a matching cached viewer identity. It also writes
  the fresh UUID with a `:purging` suffix. The suffix remains if OPFS deletion
  fails. A final metadata transaction removes the suffix only after deletion
  succeeds. New cache opens reject an incomplete purge, including in other tabs.
- A cache handle captures its generation at open. All its data operations use an
  app-specific, per-user shared Web Lock. Purge uses the same lock exclusively.
  A queued old handle checks the persisted generation after acquiring the lock,
  before it can create OPFS directories. Locks cover local storage operations,
  not HTTP requests or the lifetime of a cache handle.
- Every handle mutation also reads its captured generation in the **same IDB
  readwrite transaction** as its record writes/deletes. This includes notes,
  folders/root references, lists, denials, denial removal, and note cleanup.
  Existing transaction terminal-event settlement is retained.
- Purge therefore waits for an already-running OPFS operation to reach its
  terminal cleanup, then removes the subtree. A deferred HTTP response owns no
  lock and cannot prevent clear from completing. Bob has a different lock,
  metadata generation, and subtree; application CacheStorage is untouched.

## Request scopes and optional storage

`captureOfflineCacheScope(userId)` runs at request start, before HTTP.
`NoteReadSession` captures its note-order token before this first await, preserving
the unknown-ID/denial entry fence. Home captures its viewer and user generation
before starting either metadata request. Both check generation after HTTP and at
publication. A cache opened for a successful response receives the original
request scope; it cannot silently adopt the generation current at completion.
Existing prefetch opens its cache before HTTP, so its handle already carries
the required generation without changing acquisition.

The scope reader keeps one realm-level connection to the **existing** database.
It performs fresh metadata transactions, not an in-memory generation cache.
This avoids repeated database open/close overhead at every publication and
separates authority reads from operation-handle disposal. It closes and releases
its reference on `versionchange`, resets on abnormal close, and does not retain
a failed-open promise forever. There is no second database, download queue,
network-long lock, or automatic retry of an expired scope.

Ordinary cache failures remain non-fatal to healthy network display. A failed
start capture produces an unknown generation and cannot authorize a save.
Cache operations require successful authority reads; optional network publication
checks tolerate an ordinary metadata read error but always reject a known epoch
mismatch or observed lifecycle invalidation.

There is an unavoidable degraded-mode boundary: if durable authority is
unavailable and every lifecycle message is missed, the client cannot distinguish
an intentional clear from ordinary storage failure. The chosen behavior retains
network availability and forbids cache writes without a reliable start scope;
it does not claim cross-tab authority in that information-free state.

## Realm notifications

`miyulabmd-offline-cache-lifecycle` carries only `{ type, userId }`, never note
contents, folder listings, credentials, or cached payloads.

- `invalidate` promptly closes local handles, invalidates note ordering/lifetime,
  aborts active local storage transactions, and notifies request readers.
- `identity` is emitted after a cached viewer identity transaction commits.
- `subscribeOfflineCacheLifecycle` is the narrow future UI integration seam.
  `subscribeOfflineCacheInvalidation` is the request-reader convenience seam.
  Observer failures and unavailable BroadcastChannel do not replace the durable
  authority or prevent normal storage behavior.
- Notifications are conservatively invalidating; even a delayed notification can
  cancel current realm work. Expired work is not retried automatically. A new
  explicit save after invalidation opens a handle at the durable new generation.

`NoteReadSession.dispose()` removes its subscription. Home owns a short-lived
AbortController that forwards the caller's exact abort reason, captures the
original user identity, and removes listeners when the read settles. No UI
behavior is wired in this slice.

## Preserved contracts

The identity ledger is unchanged, including canonical/short-ID inverse identity,
denial alias handling, and unknown-route entry ordering. Existing same-page
purge/suspension, per-store cancellation, terminal committed snapshots, and
healthy-network/storage-failure browser cases remain in the validation set.
No existing test was weakened; additions are appended to `offline-cache-tabs`.
