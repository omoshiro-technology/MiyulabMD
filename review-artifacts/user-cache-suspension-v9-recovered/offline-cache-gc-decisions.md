# C9 SAFE ORPHAN GC foundation — candidate

This candidate adds only `collectOfflineCacheOrphans(userId)` to the recovered
offline cache. It takes the existing per-user `navigator.locks` exclusive lock,
opens the existing v4 IndexedDB directly, and snapshots current note
`fileName` values plus valid image metadata references before looking at OPFS.

The sweep is deliberately narrow: it visits only
`miyulabmd-offline-cache-v1/<encoded-user>/notes/<encoded-note>` and removes
files not present in the complete reference snapshot. Missing directories are
zero cleanup. Malformed or unreadable references abort before any deletion;
scope/epoch checks remain authoritative. Other users, unknown layouts, Cache
Storage, quota policy, and all-device clearing are outside this slice.

No schema, second database, LRU policy, public cache method, or handle-lifetime
lock was introduced. Quota integration and UI adoption remain parent-owned.

## Parent correction and adoption

The first reference scan silently ignored an Alice-keyed row whose `userId`
field was corrupted. Parent browser reproduction proved that GC then deleted
its body file; repairing the row could no longer recover the body. The final
scan is bounded by the user's actual key namespace and requires matching
owner, canonical key, note ID and safe filename. Uncertain references abort
the entire snapshot before OPFS deletion.

References use the complete encoded-note/filename path, not a filename shared
across all note directories. UTF-8 path decoding must round-trip to the exact
canonical encoding. Only known immutable UUID-v4 `.md` / `.image` filenames
are collectible; unrelated future files and layouts remain untouched.

The concurrency test now gates the real public `putNote()` operation after
native OPFS close and before metadata publication. It observes the collector's
exclusive lock queued behind that actual shared write, then verifies the new
committed body remains readable. A manually created unreferenced file under
a hand-written lock is not equivalent to a valid in-progress cache write.

The parent adopted the corrected primitive into live `offline-cache.ts`.
It is not yet wired into quota handling or a device-wide settings action.
