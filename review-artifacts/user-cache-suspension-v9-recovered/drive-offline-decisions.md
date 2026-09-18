# D47 cached MyDrive navigation

## Decision

The cached drive reader uses the existing folder and note-list snapshots keyed
by the resolved cached viewer ID. A cached viewer has no `user` and is never
treated as the public/guest listing. Folder and note-list misses remain
distinguishable from empty results. Cached rows reuse the existing routes and
markup but pass an explicit readonly capability, which suppresses hover
prefetch and row menus.

## Alternatives rejected

- Calling the folder or notes APIs when a snapshot is missing: this violates
  best-effort readonly offline behavior.
- Treating a missing folder as empty: this hides incomplete cache coverage.
- Creating a second IndexedDB schema: the existing persistent snapshots already
  carry IDs, parent links, crumbs, and cached timestamps.

This candidate intentionally does not implement prefetch, service-worker
support, online persistence, schema changes, or note body loading.

## D48 repair plan

D47 is rejected for replacing the complete online HomePage with a cached-only
screen and for compressing the shared list components. The repair keeps the
complete live HomePage as `NetworkHomePage` and adds only a small route wrapper
that selects cached rendering after viewer resolution. Cached rendering remains
on the existing route and reuses `NoteTree`/`DriveList` with an explicit
readonly capability.

The rejected alternatives were (1) retaining the cached-only replacement,
which breaks authenticated and guest online behavior, and (2) duplicating the
drive tree in a separate offline route, which risks route and markup drift.
The chosen design preserves all normal dialogs and operations, suppresses
menus/context handlers/prefetch only for cached rows, and uses a
viewer-owned, abortable viewing scope for final publication.

## D48 implementation result

The focused candidate now keeps the complete network HomePage intact behind a
route-local wrapper. After viewer loading, only a viewer with a non-null cached
namespace selects `CachedDriveView`; unavailable viewer state gives a generic
status message and never falls through to public APIs. The cached child is keyed
by cached viewer and folder route, so its reader scope cannot publish data to a
different owner or route.

Cached snapshots publish `source: "cache"` only when both folder and note-list
snapshots exist. Missing snapshots remain distinguishable and pending, while
available child folders remain navigable with an incomplete-list explanation.
Readonly `NoteTree`/`DriveRow` suppresses hover prefetch and all row/context
menus without changing default callers.

## D49 suspension boundary correction

The D48 reader already checked cancellation and the current viewing scope, but
those checks did not cover the user-wide offline-cache suspension state. A
folder snapshot could therefore complete before suspension while the pending
note-list snapshot returned `null` after suspension, and the compound reader
could still publish the completed folder.

The correction keeps the existing `Promise.all` composition and adds the
canonical `isOfflineCacheUserSuspended` check at the final return boundary,
after both reads and the current-scope check. A suspended read rejects with
`DOMException("Offline cache is suspended")`; it does not mutate, delete, reset,
or retry cache state. The HomePage cache child key now uses
`JSON.stringify([viewer.cacheViewerId, folderId ?? null])`, preserving the
storage contract while distinguishing a `null` root route from a literal
`"root"` folder ID.

No live source, test, runner, schema, or other candidate file was changed.

## D50 implementation

The candidate now preserves a canonical non-null folder ID and writes its
user-scoped root reference in the existing metadata store. The canonical folder
record and reference are committed in one readwrite transaction, using the
existing pending-user operation lifecycle; ordinary `putFolder(folder)` keeps
its previous behavior. A root lookup follows the explicit reference and falls
back to the legacy null-ID record only when no reference exists. The reference
stores a JSON-encoded ID so `null` remains distinct from a missing reference
and from the literal `"root"` folder key.

The rejected alternatives were rewriting the canonical ID to null (which would
break note and child parent identity) and maintaining a duplicated root
snapshot (which could diverge in body and `cachedAt`). Root detection in the
cached view also recognizes `locked` root snapshots, allowing direct canonical
ID routes without an invalid parent link. No database version, store, schema,
test, runner, or live `apps/web/src` file was changed.

## D51 atomic multi-store commit lifecycle

The D50 multi-store root replacement queued the folder write before a native
IndexedDB `put` failure in the metadata store. Because the synchronous catch
rejected without aborting the transaction, the earlier folder write could
commit while the reference remained unchanged.

The chosen correction keeps one transaction for both the canonical folder and
root reference, but separates transaction-creation failure from write failure.
Terminal handlers and the `pendingUserOperations` registry are established
before any `put` is queued. A synchronous `put` error is retained and causes an
immediate transaction abort; rejection and registry cleanup occur only through
the actual `abort` or `complete` event. Completion remains authoritative, with
no compensating delete or alias reset. Existing single-store callers and the
D50 multi-store caller continue using the same helper.

No schema, API, denial, read, OPFS, note, live source, test, runner, or other
candidate file was changed. The candidate remains unrecovered for independent
parent review and adoption.
