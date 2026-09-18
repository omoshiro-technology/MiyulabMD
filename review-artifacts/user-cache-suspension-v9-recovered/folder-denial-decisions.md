# D60 folder denial primitive

## Decision

Folder denial is represented by a user-scoped marker in the existing
`metadata` object store. `denyFolder(id)` writes the canonical ID and does not
delete or invalidate the cached folder record, so a later ordinary
`putFolder` cannot accidentally revive a denied snapshot. `getFolder` reads
the bounded metadata prefix for the current user once, then projects denial:
the denied target is a miss, denied children are removed, and a readable
descendant is detached from the denied ancestry.

## Alternatives rejected

- Deleting the folder record alone loses the distinction between a cache miss
  and a confirmed denial and is defeated by stale writes.
- Deleting a subtree would incorrectly deny independently authorized child
  folders and notes (D59).
- One metadata lookup per crumb would add avoidable IndexedDB round trips;
  scanning all metadata would risk crossing user boundaries.

This slice intentionally does not add schema/version changes, root-alias
handling, marker clearing, physical cleanup, or network integration.

## D62 nearest visible parent

The D60 projection now derives `parentId` from the second-to-last projected
crumb when at least two visible crumbs remain. This preserves an independently
allowed child's identity as the nearest visible parent of a deeper allowed
descendant, while retaining `null` for a direct child of a denied ancestor.
The projected crumbs are computed once and used for both the returned crumbs
and parent derivation. Denied target/children filtering, hidden path and
`sourceFolder` cleanup, user/sibling isolation, and original `cachedAt` values
are unchanged. The separate read-overlap denial race remains out of scope.

## D63 read-order correction

The folder record is now read before the user-scoped denial markers. The marker
scan is the final storage boundary before projection, so a denial committed
while the native folder read is pending hides the target or removes the
denied ancestor from a descendant's projected crumbs. Existing closed,
suspension, lifetime, null-root, nearest-visible-parent, and original
`cachedAt` behavior remains unchanged. A missing folder record returns `null`
without inventing a timestamp.

This is candidate-only and remains unadopted. Composite reader and HTTP denial
wiring are separate future slices.

## D72 compound-reader rationale

`readCachedDrive` now awaits `getNoteList()` before invoking `getFolder()`.
This makes the folder read, including D63's user-scoped denial-marker scan, the
last storage boundary before the compound result is assembled. A denial
committed while the note-list read is delayed therefore cannot be masked by a
folder snapshot that was completed earlier. The existing signal/current and
suspension checks, missing flags, timestamps, and `finally`-owned `cache.close`
boundary are unchanged.

This is a one-pass ordering correction only: it adds no retry loop, duplicate
folder scan, schema change, HTTP wiring, or PWA/live-source change. The
candidate remains unadopted pending parent review. The focused and complete
candidate runs still expose the existing native IndexedDB suspension test
timeout and the compound test's `AbortError` when its delayed note-list
transaction is held open while `denyFolder` commits; those results are recorded
exactly in the companion validation record rather than being hidden or worked
around here.

## D76 cancellation correction

The D76 candidate correction reuses one `ensureReadIsCurrent` guard for the
signal, current-owner callback, and user-suspension condition. It runs after
the note-list read and before starting the folder read, preventing a cancelled
compound read from starting its next storage operation. The assembled result is
held until the `finally`-owned `cache.close()` completes; the same guard then
runs immediately before the final return. There is no await after close.

Signal cancellation still throws the exact `signal.reason` object. The
list-first/folder-last order, D63 denial projection, timestamps, missing flags,
and single close boundary are unchanged. No deletion, compensation write,
additional cache close, or error weakening was added. This remains a
candidate-only correction and does not address the separate prefetch test.

## C3 durable HTTP denial ordering

Folder markers now carry a persisted generation. `beginFolderRead` captures the
current marker generation, `denyFolder` advances it transactionally, and
`clearFolderDenial` deletes only a matching generation. Ordinary `putFolder`
never clears a marker, so a late 200 cannot revive a newer 403 while a later
successful read can revalidate. Root routes use a tagged namespace and resolve
the canonical drive root when known; literal `"root"` remains independent.

## Parent correction: transactional authority and publication

The first C3 implementation did not enforce its generation comparison:
`clearFolderDenial` silently discarded a mismatch, Home swallowed it, and the
successful body could still be saved/published. Deleting the generation on
successful clear also allowed generation reuse. Its two-page test incorrectly
created two independent browser contexts, which cannot share IndexedDB.

The parent corrected the rule:

- Reads capture a persisted user-local **folder denial sequence**. Only a denial
  advances it. A folder's last-denial generation must not exceed that captured
  sequence. A denial of a different folder does not invalidate the read.
- Revalidation retains generation state with `denied: false`; it does not reset
  ordering by deleting the state.
- Marker validation, root/canonical alias resolution, optional snapshot write,
  root reference update, and authorized marker clear share one epoch-guarded
  IDB write transaction. Mismatch rejects instead of pretending success.
- Root routing uses actual `null` in a separate `folder-state:` key namespace.
  It cannot collide with string IDs or legacy `denied-folder:` records.
- Home captures authority without opening/closing an extra cache handle before
  HTTP, preserving the established storage-lifetime boundary. Denial persistence
  failure suspends the known user and preserves HTTP status plus a cache warning.
- Final Home publication checks folder authority after the general epoch check;
  its own transaction checks the expected purge epoch as well.
- MyDrive uses the same guarded folder write. No latest-request-wins behavior,
  permanent denial, or new valid-cache deletion policy was introduced.

Targeted mounted-view invalidation and the separate note-denial cross-tab repair
remain part of the broader C2 integration; these cache/HTTP tests alone are not
full offline completion.
