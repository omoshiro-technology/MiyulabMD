# v8 decisions

## User lifecycle over per-operation checks

The rejected v6 candidate checked suspension only at operation start. That
allowed an already-running IndexedDB/OPFS read to publish stale data and left
folder/list handles usable. v8 keeps a process-local per-user lifetime epoch:
every suspension advances it, and every read/write checks the epoch at its
terminal boundary. This is preferred over aborting every handle because it
preserves valid online results while synchronously making all cache kinds
unavailable.

## Candidate-only implementation

The canonical files here are authored implementation, not source snapshots.
Live `apps/web/src/**` remains unchanged. The supplied candidate runner is the
only validation path.
