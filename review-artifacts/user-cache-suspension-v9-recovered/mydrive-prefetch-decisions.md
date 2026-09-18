# MyDrive prefetch candidate decisions

This candidate implements the first D75 startup slice only. `AppShell` starts one
best-effort cycle after an authenticated viewer with a matching cache identity is
resolved. The cycle acquires the real root and each folder response, stores the
full notes-list response, and fetches bodies only for notes owned by that viewer
and contained in the owned folder tree.

The folder tree is only a set of ownership IDs: it is never converted into
`FolderAccess`. Folder API responses provide the saved permissions and crumbs.
The existing note cache's ordering token prevents an older body request from
reviving a durable denial. Existing bodies are skipped when their `updatedAt` is
at least the list summary's value.

This intentionally does not add retry triggers, cross-tab coordination,
coalescing with foreground reads, image acquisition, or a completion model.
Stopping is best effort and is represented by the public `stopped` result rather
than a download-complete claim.

## D77: Capture the prefetch ownership snapshot at the public entry point

The public `prefetchMyDrive` entry point now synchronously clones the
`ViewerContext` and its nested user before any await. Mode validation, cache
opening, and note target filtering all use that owned snapshot. This prevents a
caller mutation of `cacheViewerId` or `user.id` after entry from switching an
in-flight Alice prefetch to Bob, without mutating or freezing the caller and
without introducing mutable global ownership state.

## D78: Persist note denials without stopping independent acquisition

The note branch treats only HTTP 401 as an authentication stop. HTTP 403 and
404 call the existing public `cache.denyNote(summary.id)` entry point, which
advances the denial generation and persists the durable denial; a successful
denial then permits the loop to acquire later independent notes. A failure to
persist that denial is a storage stop, rather than a broad reclassification of
other errors. Successful body writes clear the denial with the read's original
ordering token, so an older revalidation cannot clear a later denial.

## D79: Keep acquisition failures at their actual I/O boundary

The prefetch cycle tracks whether its current awaited operation is network or
storage. Generic IndexedDB exceptions are therefore storage stops even when a
cache handle exists; transport exceptions remain network stops. Notes-list HTTP
errors use an Error-compatible status-bearing error, preserving the existing
`fetchNotes(): NoteSummary[]` success contract while classifying HTTP 401 as
authentication expiry.

The result is held until the single `cache.close()` in `finally` completes. A
close failure is a storage stop, while abort observed at entry, between I/O
operations, or during close has cancellation priority. No rollback or
compensating deletion is attempted, so completed transactions remain visible
and no later note bodies are requested after a stop.

## D82: Separate acquisition flow from lifecycle ownership

The previous implementation encoded the current I/O boundary in a mutable
`operation` label and held a partially assigned result through deeply nested
response branches. The refactor uses two private acquisition routines with
early returns and a small `prefetchIo` helper. Each await declares its boundary
(`network` or `storage`) at the call site; the helper performs the common
pre-I/O cancellation check and wraps failures with that boundary. The public
function alone owns the viewer snapshot, cache assignment, one `finally`
close, and the final cancellation override.

The alternatives were (A) retain the nested state/result structure, (B) add a
generic scheduler or state machine, or (C) use focused acquisition routines
and a boundary-tagging I/O helper. A preserves behavior but keeps the
mutable-state and review burden. B is disproportionate to this sequential
workflow and would obscure its ordering. C was selected because it makes
network/storage classification local without changing the public result,
sequential order, ownership snapshot, or cache lifetime contract.

The helper intentionally checks before each operation rather than after it:
the public cache assignment must remain observable so an abort racing cache
open still reaches the sole `finally` close. Cancellation is checked again
immediately after assignment and at finalization; the cache API also receives
the signal for in-flight storage termination.
