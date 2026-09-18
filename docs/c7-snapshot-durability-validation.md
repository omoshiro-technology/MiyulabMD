# C7: durable server snapshot projection

## Scope and rule

`docs/offline-pwa.md` requires checking the timing between collaborative edits
and the read API. This change addresses server-side eventual snapshot durability,
not offline editing or a browser cache confirmation protocol.

The DocumentRoom now commits the encoded Yjs state, a pending markdown projection
with a unique revision, and its alarm in one Durable Object storage transaction.
The normal trailing debounce remains 3 seconds, using a durable alarm rather than
an in-memory timeout. Alarm delivery can reconstruct the actor and flush without
opening a Y.Doc or accepting a new connection.

Before D1 I/O the handler schedules a 30-second retry. A rejected write leaves the
pending projection and retry intact and propagates the error (including to task
RPC callers). Cloudflare alarm retries may also deliver earlier. Retries continue
while work remains; they do not discard an edit after a fixed attempt limit.
Successful writes clear the pending revision and alarm only if no newer revision
has arrived. Flush calls within one actor are serialized so an older in-flight
write cannot complete after a newer flush and overwrite it.

Task checkbox operations still await D1 persistence. Apply, agent-edit, and restore
operations keep their existing history/origin behavior and await the atomic local
write; their D1 projection remains debounced. Existing Yjs broadcasts are unchanged
and are not a D1 persistence acknowledgment.

## Local evidence

Test-first: added focused tests before the helper; the initial exact invocation
failed because the helper module did not exist. The implemented production helper
passes tests for actor reconstruction over shared persisted state, failure/retry,
an edit arriving during a D1 flush, and atomic rollback on alarm scheduling failure.

Commands:

```sh
node --experimental-strip-types --test apps/worker/src/durable-objects/snapshot-persistence.test.ts
pnpm --filter @miyulabmd/worker test
pnpm --filter @miyulabmd/worker typecheck
```

After installing dependencies with `pnpm install --frozen-lockfile`, Worker
typecheck passed, the full Worker suite passed **72/72**, and the exact focused
suite passed **4/4**. No package manifests or lockfile were changed.
These dependency-free tests exercise the exact helper used by DocumentRoom, with
an in-memory transactional storage seam and injected D1 writer. They do not prove
Cloudflare runtime alarm delivery, output gates, actual D1 transactions, or live
WebSocket behavior. A local actual-Worker harness should validate those separately.

## Follow-up and limits

- An explicit revision-bearing server-persisted notification and its client/cache
  handling remain necessary if C7 requires immediately knowing when list/body
  reads include a collaborative edit. No WebSocket message is invented here.
- This protects writes made through the new atomic path. It does not retroactively
  repair legacy actors whose pre-change volatile timer was already lost.
- D1 projection and DO storage are not a distributed transaction. If D1 succeeds
  and local cleanup is interrupted, delivery is at least once and repeats the
  snapshot persistence service. Its existing timestamp/derived-data semantics
  remain unchanged.
- No deployment, production DB, secrets, web sources, or harness configuration
  were touched in this slice.

## Follow-up: actual local Worker acceptance

The snapshot follow-up now has runtime evidence, not just the storage seam.
`apps/web/tests/worker/worker-snapshot.spec.ts` logs in through real DEV_AUTH,
creates a private note through the API, and opens a cookie-authenticated browser
WebSocket. It requests and decodes the actual sync-step-2 into a Y.Doc, asserts
the initial markdown, mutates that document, and sends its differential Yjs
update with the existing y-websocket framing libraries. No API PATCH, task RPC,
mocked snapshot writer, invented saved event, or editor mutation is involved.

The test verifies the immediate read still contains the old markdown/title,
then polls the real `/api/notes/:id` until both fields reflect the Yjs edit.
It also asserts at least the 3-second debounce has elapsed. With the current
DocumentRoom implementation, this exercises local workerd alarm delivery and
the actual D1 snapshot projection through the read API.

Actual commands and results:

```sh
pnpm install --frozen-lockfile
pnpm --filter @miyulabmd/web test:browser:install
node apps/web/scripts/test-worker.mjs --grep "real Worker alarm"
pnpm --filter @miyulabmd/worker test
pnpm --filter @miyulabmd/worker typecheck
```

- First harness attempt built assets and migrated local D1, but could not launch
  because this checkout lacked Chromium. Installed the authorized local browser
  using the existing script; no dependency or harness changes were needed.
- The subsequent actual-Worker run passed **1/1** (test 3.9 seconds, Playwright
  5.0 seconds), with real login 302, create 201, authenticated WebSocket 101,
  and read API 200 responses. The harness stopped its owned child processes and
  removed its isolated runtime successfully.
- Worker tests remain **72/72**, including all **4/4** snapshot helper cases;
  Worker typecheck passes. The three backend files received only nonbehavioral
  Biome cleanup; test doubles retain promise resolution/rejection semantics.

This does **not** force actor eviction, reconstruct a real Durable Object, kill
workerd between edit and alarm, or inject a real D1 failure. Eviction/reconstruction
and failure/retry durability remain unit-only evidence. Closing the test socket
after a successful read is cleanup, not a crash test. Nothing was deployed,
staged, or committed, and package manifests, lockfile, harness configuration,
and web candidate sources were not edited by this follow-up.

## Parent independent validation

The parent subsequently ran Worker tests (**72 passed**), Worker typecheck,
and the entire actual-Worker acceptance runner (**4 passed**). This combines
online authentication/API/SSR coverage, production-shell offline note reload,
and actual WebSocket-to-alarm-to-D1 projection in one clean local runtime.
This still does not establish real eviction/crash recovery or saved-event
delivery to the application coordinator.
