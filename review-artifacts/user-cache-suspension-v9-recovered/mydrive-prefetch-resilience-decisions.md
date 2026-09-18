# C6 acquisition resilience decisions (candidate only)

Scope: `src/lib/mydrive-prefetch.ts`, `src/lib/mydrive-prefetch-coordinator.ts`,
two new browser specs, and these records. No live implementation adoption,
runner default, cache core, request-sharing layer, read session, AppShell,
Share, editor, PWA, or API changes belong to this slice.

## Policy from offline-pwa.md §§6.1–6.4

One acquisition cycle owns an ephemeral retry budget:

- `PREFETCH_MAX_ATTEMPTS = 2` (one initial attempt plus one retry).
- `PREFETCH_RETRY_DELAY_MS = 500`, cancellable and measured from failure.
- `PREFETCH_MAX_CONSECUTIVE_FAILURES = 4`, counting failed communication
  attempts, not failed items. Any non-transient HTTP response or successful
  acquisition resets the streak; cache reads/writes/skips do not.
- Retry only HTTP 500–599, `ApiCommunicationError` from the shared note
  transport, and raw fetch `TypeError` from the existing metadata APIs.
  The raw-fetch option is explicit at tree/folder/list call sites; note
  acquisition does not reinterpret an arbitrary TypeError as communication.
- Invalid JSON, unknown exceptions, 401, other 4xx, storage exceptions, and
  cancellation are not generic retry candidates.

An item's two transient failures mark the cycle incomplete, but leave room for
the next independent item. Four consecutive communication failures stop the
whole cycle immediately. A successfully acquired independent note is committed
and counted even if another item failed. An incomplete cycle returns the existing
`stopped/network` result with committed counts, not an unqualified success.

Tree/list acquisition are prerequisites: exhaustion stops without inventing
candidates. A folder-detail failure need not prevent independent folder details
or note bodies selected from the successfully fetched owned tree and note list.
Folder acquisition now uses one root-first loop rather than separate root and
child error rules.

401 still stops immediately as auth. Note 403/404 still durably deny only that
note through the existing cache methods and continue independent acquisition.
Storage/quota stops do not retry or download additional bodies. Cancellation
interrupts the delay, removes its timer/listener, is checked around network
responses, and never invokes cache fallback. Terminal close classification and
cache counts remain in their original owner.

The next cycle fetches current metadata again and compares current cache
versions. No queue, retry count, cursor, or checkpoint is persisted. Request
sharing, viewer ownership, denial ordering, and cross-tab locks are unchanged.
The original read-ordering token is retained throughout an item's retry; retry
does not bypass a concurrent denial by inventing a new cache permission token.

## Coordinator cooldown

The existing one-second minimum interval is measured from cycle **start**.
Spaced retries can consume that interval, so a pending trigger can otherwise
launch another failing cycle almost immediately. The focused RED observed five
tree requests while the expected bounded first cycle had only two.

`PREFETCH_FAILURE_COOLDOWN_MS = 30_000` is measured from non-aborted stopped
cycle completion. Scheduling waits for both the old minimum interval and this
deadline. A pending trigger remains coalesced and can reevaluate after the
deadline; no trigger means no autonomous failure retry loop. Disposal clears
timers and active work as before. Auth/storage/unavailable stops also receive
the cooldown, not just network stops. Success keeps the existing schedule;
cancellation does not impose a new cooldown.

This is coordinator-lifetime state, not persistent state or a cross-tab failure
ledger. Existing exclusive cross-tab ownership still covers the entire cycle,
including its retry delay. Foreground requests remain outside this cooldown.

## Alternatives and boundaries

Rejected: retry every exception (would hide programming/storage/cancellation
failures); stop on the first network exception (starves independent notes);
unbounded retries (communication and quota loops); persistent retry queue
(explicitly excluded by the specification); drop pending triggers just to make
an old HTTP-count test pass (loses correct post-acquisition reevaluation).

Deferred: image acquisition, membership reconciliation, foreground priority,
new concurrency, jitter/adaptive backoff, and cross-tab cooldown persistence.
Constants are initial load-tuning choices, not a complete-save guarantee.
