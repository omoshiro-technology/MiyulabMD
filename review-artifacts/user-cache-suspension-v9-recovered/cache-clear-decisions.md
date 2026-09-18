# D108 user-cache purge foundation

- Candidate-only primitive; live application integration, cross-tab fences, and
  logout/UI coordination remain later work.
- A clear advances a per-user clear lifetime and a monotonic note-read barrier.
  The barrier is returned by reads for note IDs that have never been cached, so
  an old network publication cannot create a new cache entry after clearing.
- IndexedDB removal is scoped by each record's `userId` plus the user's
  drive-root and denial metadata keys. The remembered viewer ID is removed only
  when it names the cleared user. Cache Storage is intentionally untouched.
- Existing handles are closed and the user remains stopped if either the
  IndexedDB transaction or OPFS recursive removal fails. Missing OPFS entries
  are already-cleared; successful completion lifts the stopped state and allows
  explicit new handles.
- Later image/GC work should use the same user lifetime fence and a per-user
  cleanup result, rather than broad database or Cache Storage deletion.

## Same-page in-flight work follow-up

- Each note write registers before its first OPFS await. Clear suspends the user,
  closes handles, then waits for all already-started writes through metadata
  commit/abort and cleanup before purging records and the user directory. A
  failed write settles its completion barrier without turning an otherwise
  successful purge into a failure; purge storage errors still leave it stopped.
- Creating paths checks cancellation and the captured user lifetime after every
  awaited path operation. Writer acquisition, write, and close are fenced too.
  Cleanup covers failures starting with path acquisition, and removes only the
  new UUID body, never a previously committed snapshot.
- Remembered-viewer persistence captures the user's clear epoch before opening
  IndexedDB and checks it before starting the metadata transaction. A delayed
  pre-clear open cannot restore the cleared identity after purge completes.
- Ordinary suspension, typed cache methods, coalesced clear calls, and actual
  transaction-terminal commit outcomes remain unchanged. This is a same-page
  foundation, not cross-tab or full C1/C2 completion.
