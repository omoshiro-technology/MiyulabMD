# User cache suspension v9 decisions

## Checkpoint and objective

This candidate responds to checkpoint `03c4d37` and the RED lifecycle tests. It
retains D22 from `docs/offline-pwa-decisions.md`: shared cancellation for
pending per-user cache operations, with IndexedDB terminal events as the
source of truth.

## Alternatives considered

* **Post-write epoch assertions (v8):** rejected. An assertion after `put`
  cannot undo a transaction that already committed, and incorrectly classified
  a committed note as aborted, deleting its OPFS file.
* **Compensating deletes after suspension:** rejected. They race with reads,
  can delete a newer value, and do not provide transaction atomicity.
* **Per-method duplicated checks:** rejected. They miss asynchronous gaps and
  make the rule inconsistent across folders, lists, denials, and notes.
* **Shared per-user pending-operation registry (chosen):** every cache
  read-write transaction registers an abort callback before enqueueing its
  request; suspension aborts all callbacks for that user. Completion removes
  the callback first, so a transaction-complete event wins over a later stop.
  The promise resolves/rejects only from the actual terminal event.
* **Abort valid network requests (rejected):** suspension only aborts optional
  cache transactions. Session disposal still aborts the network request.

## v9 revisions

The candidate adds cancellation to note, folder, list, metadata-put, and
metadata-delete transactions. `putNote` cleans the OPFS file only when the
transaction rejects, never after a successful `complete`. Cached note reads
capture note generation before the denial check and validate it after every
await. List reads snapshot generations and validate both each item and the
final result, preventing stale publication during denial or suspension.

The denial marker is still persisted before physical cleanup; cleanup failure
does not remove logical denial. Database-open or marker-write failures retain
the existing user-wide stop and Japanese manual-clear warning behavior.

## Evidence and revision policy

The parent must run the exact candidate runner after final edits, including
the focused lifecycle spec and the full 29-browser suite, plus the existing
live-web regression suite. Any failure is evidence for another v9 revision,
recorded here before changing implementation. Parent review and revalidation
are required before adoption; this directory is candidate-only and does not
modify `apps/web/src/**`.

## Replication incident

The initial candidate files were created with `apply_patch` placeholders.
Because the directory was untracked, Delta reported it as skipped; a
subsequent terminal `cp` from v8 populated the local disk and tests used those
bytes, but that external edit was not reproduced in the parent's candidate
directory. The final candidate is now staged as four exact new files and this
record is itself updated with `apply_patch`. The parent must verify the bytes
and hashes before adoption; no source restoration or live-source edit occurred.
