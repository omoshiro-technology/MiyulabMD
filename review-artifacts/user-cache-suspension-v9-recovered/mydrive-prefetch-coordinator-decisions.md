# MyDrive prefetch coordinator decisions

## D85

- **Scope:** Candidate-only coordinator for the authenticated `AppShell` viewer
  lifetime. The existing `prefetchMyDrive` implementation remains the sole
  acquisition, storage, and error-classification path.
- **Signals:** Startup, `online`, and `visibilitychange` while the document is
  visible share one debounced scheduler. Other triggers, auth refresh,
  cross-tab coordination, and merging with normal requests remain out of
  scope.
- **Eligibility:** The coordinator snapshots an authenticated viewer only when
  `cacheViewerId` matches the authenticated user's ID. Guest, cached, and
  unavailable viewers cannot start network acquisition.
- **Scheduling:** A 200 ms debounce coalesces bursts, and a 1000 ms minimum
  attempt interval prevents tight automatic retries. There is at most one
  active cycle; signals received during it retain one pending rerun so a
  recovery event is not lost when the old request fails.
- **Lifetime:** Disposal removes both listeners and any timer, aborts the
  active cycle, and prevents completion handlers from scheduling new work.
  This also makes React StrictMode's attach/dispose/reattach sequence safe.
- **Rejected alternatives:** Retrying continuously, retaining a persistent
  queue, starting for cached viewers, or copying the acquisition/error policy
  into the coordinator would broaden this slice and risk unauthorized or
  duplicate work.

## D88

- **Status:** Implemented and candidate-validated.
- **Scope:** The coordinator now wraps each background `prefetchMyDrive` call
  in the native Web Locks API with the stable app-specific lock prefix
  `miyulabmd:mydrive-prefetch:` and a JSON-structured authenticated user ID.
  The lock is exclusive and uses `ifAvailable: true`, so a busy lock skips
  that cycle rather than queueing it. Existing debounce, minimum interval,
  single-active-cycle, one-pending-cycle, and disposal behavior remain intact.
- **Safety:** The lock callback checks disposal and the cycle's abort signal
  before starting I/O, and awaits `prefetchMyDrive` so ownership lasts through
  cache close. Environments without Web Locks skip background acquisition
  rather than using an unsafe parallel fallback. Foreground reads and
  autosave are not lock-gated.
- **Deferred:** Identity-change/privacy handling, normal-request deduplication,
  and other PWA requirements remain outside D88 and are not claimed complete.
- **Candidate source SHA-256:** `83860f35d2da2d6d745d6042ba0a148e9dbfaf1fcc8bac1c0008659bd8d3b44c`.

## D91

- **Status:** Candidate implementation added; parent review and validation remain
  pending.
- **Scope:** Add the named `PREFETCH_REFRESH_INTERVAL_MS` five-minute interval
  to the existing eligible-viewer coordinator. Each tick checks visible state
  and enters the existing `requestCycle` scheduler, preserving debounce,
  minimum interval, single-flight, one-pending-cycle, and Web Locks behavior.
- **Safety:** Hidden documents skip periodic requests. Disposal clears the
  interval, aborts the active cycle, and prevents later scheduling. The
  defensive viewer snapshot and existing lock skip/release behavior are
  unchanged.
- **Deferred:** No parallel acquisition path, auth promotion, API mutation
  triggers, normal-request integration, or cross-tab identity handling is added.

## D94

- **Status:** Candidate implementation added; parent review and validation remain
  pending.
- **Scope:** A payload-free `drive-changed` event is emitted by the canonical
  `apiFetch` boundary after successful, non-redirected 2xx mutations to the
  same-origin `/api/notes` or `/api/folders` segment prefixes. The existing
  coordinator subscribes to that event and reuses `requestCycle`; disposal
  removes the subscription.
- **Safety:** Method precedence, mutation gating, transport errors, response
  identity, and response body usability remain unchanged. Reads, failed or
  redirected responses, aborts, unrelated profile requests, foreign origins,
  and server-side calls do not notify. The event module has no coordinator or
  fetch dependency, avoiding a cycle.
- **Deferred:** Parent boundary tests, adoption into live sources, and broader
  normal-request or cross-tab integration remain outside this candidate.
