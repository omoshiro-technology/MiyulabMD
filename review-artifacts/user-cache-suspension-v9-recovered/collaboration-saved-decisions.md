# C7 server-confirmed snapshot notification

## Scope and adoption

`collaboration.ts` maps to `apps/web/src/lib/collaboration.ts`; it remains a
candidate. Worker `DocumentRoom`, the small `snapshot-saved.ts` writer helper,
and the shared protocol module are live changes. Cache, coordinator, API transport,
UI and harness files are unchanged by this slice.

This is not a completed C7 claim. The parent must adopt the candidate and verify
the composed live frontend/backend and existing captured-user refresh coordinator.

## Contract

- `packages/shared/src/snapshot-saved.ts` owns message type **4**, version **1**.
  The binary frame is `[4, 1, ...UTF8(noteId)]`; no markdown, revision, identity,
  credentials or cache contents are included.
- Standard y-websocket types 0/1/3 and their handlers remain unchanged. Old clients
  can ignore the unknown extension (y-websocket may log its unknown-type warning).
- `DocumentRoom` notifies all current room subscribers, including the editing
  socket, **only after the D1 snapshot writer resolves successfully**. It does not
  interpret an incoming extension frame as a save.
- Yjs mutation, sync/update broadcasts, the durable outbox write, and alarm
  scheduling are not save notifications. Failed D1 writes emit nothing and retain
  the existing durable retry behavior. A disconnected subscriber does not turn
  successful D1 persistence into a retry.
- This is a best-effort refresh hint, not an exactly-once delivery log. A lost
  connection/actor can lose the hint; retry after D1 success can duplicate it.
  Existing refresh acquisition/coalescing remains authoritative.

## Client boundary

The provider registers its type-4 handler before connecting. It accepts only
WebSocket-origin messages, not BroadcastChannel peer assertions, for the exact
room and supported version. Empty, oversized, invalid UTF-8, foreign-room and
extended payloads are ignored without breaking the session.

A valid hint dispatches the existing payload-free `drive-changed` event. The
session owns neither cache state nor user capture. Existing listeners/coordinator
retain that ownership.

Leaving disables notifications; reconnecting re-enables them. Destroying first
leaves, then replaces the handler with a no-op before destroying the provider and
document. A retained/queued old provider callback therefore cannot trigger work.

## Focused verification

- Real Worker test was RED: D1 contained the edited snapshot, but no saved frame
  arrived. GREEN after the post-writer broadcast. It verifies no immediate save,
  real alarm debounce, snapshot contents and the small shared-protocol frame.
- Browser test is a normal live-module import, not a candidate override. Live
  source is RED (no public event); candidate runner is GREEN. It proves local
  typing and a received Yjs update do not notify, the server hint emits a
  payload-free public event, malformed/foreign frames are ignored, and a queued
  WebSocket callback after disposal emits nothing.
- Backend boundary tests cover a pending writer, a rejected writer, current
  subscriber lookup after completion, and a disconnected socket.
- Shared tests cover exact framing and defensive decoding.

Commands:

```sh
node apps/web/scripts/test-worker.mjs --grep 'alarm projects'
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser collaboration-saved.spec.ts --workers=1
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered typecheck
pnpm --filter @miyulabmd/worker test
pnpm --filter @miyulabmd/shared test
pnpm --filter @miyulabmd/worker typecheck
pnpm --filter @miyulabmd/shared typecheck
```

Frozen dependencies and worktree-local Chromium were used. No deployment,
staging, commit, secret or harness/config/package changes were performed.

Final slice results: shared **24/24**, Worker **74/74**, real Worker **4/4**,
focused candidate Chromium **1/1**. Worker/shared and composed-candidate
typechecks passed; targeted Biome check passed for all nine changed TypeScript
files. Live browser RED is expected until candidate adoption.
