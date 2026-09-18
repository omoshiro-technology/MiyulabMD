# Device private-cache clear (candidate)

The candidate uses one canonical Web Lock, `miyulabmd-offline-cache:global`, as
the realm fence. Device clear acquires it exclusively and never acquires a user
lock. Every user-scoped storage operation acquires the global lock shared first,
then its user lock shared or exclusive, and releases them in reverse order. The
identity metadata write is the deliberate exception: only its authority capture
uses the pair, while its transaction-level fence protects the later write. The
single helper composes that order around `*Unlocked` internals, so operations
that already hold the pair never request either lock recursively.

| Operation | Global lock | User lock | Internal helper |
| --- | --- | --- | --- |
| Public scope/authority/folder reads | shared | shared | `*Unlocked` |
| `persistCachedViewerId` authority capture | shared | shared | `capture...Unlocked` |
| `persistCachedViewerId` metadata write | none | none | `*Unlocked` + transaction fence |
| `readCachedViewerId` | shared | none | `*Unlocked` |
| Open-cache initialization | shared | shared | `*Unlocked` |
| Open-cache handle wrapper and `getNote` | shared | shared | `*Unlocked` |
| Orphan collection | shared | exclusive | `assertOfflineCacheScopeUnlocked` |
| User clear | shared | exclusive | clear/purge helpers |
| Device clear | exclusive | none | device purge helpers |

`captureOfflineCacheScope` reads `device-epoch`, `user-epoch:<encoded user>`,
and the device state in one readonly IndexedDB transaction. The public epoch is
an opaque base64url encoding of a JSON tuple, so global and user epochs cannot
collide through delimiters. The global epoch invalidates every old scope after a
device clear.

Note authority capture and both note/folder denial readers use the same
readonly snapshot of global epoch, user epoch, and device state. They compare
and report `composeEpoch(global,user)`, never the raw user epoch; malformed or
purging metadata remains fail-closed, and note/folder generation fences are
unchanged.

The clear commits `device-clear-state=purging` before clearing the private
stores, recursively removes only the OPFS application root
`miyulabmd-offline-cache-v1`, then commits a new global epoch and `active`.
`viewer-id` and authority epoch keys are retained. Unknown metadata is removed
by default; only explicitly listed authority keys are retained, so future
metadata must be classified as authority before it is added. IndexedDB,
OPFS, Cache Storage, cookies, PWA shell entries, and server data are separate
resources; only the first two private-cache resources are touched here.

IndexedDB and OPFS are not atomic. Any failure leaves the durable purging
marker and the in-memory global suspension in place; callers must retry the
clear explicitly. A successful final commit is the only path that re-enables
new cache scopes.

The identity writer deliberately holds the shared lock only while capturing its
composed global/user epoch and lifetime. The gated IndexedDB write runs after
that lock is released, so a user-exclusive clear can make progress. Its
immediate pre-transaction checks reject a newly suspended or clearing user, and
`guardTransaction` reads the device-clear state as well as both epochs in the
same readwrite transaction. A transaction that observes anything other than
the captured active scope aborts; this durable fence protects against missed
`BroadcastChannel` invalidations without weakening the device clear's global
exclusive lock or its retry-on-failure behavior.
