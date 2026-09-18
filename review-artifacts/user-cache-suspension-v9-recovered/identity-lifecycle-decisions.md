# C1 explicit logout and verified account switching

Work in progress, candidate only. Native GET `/auth/logout` must remain a
server navigation, including Cloudflare Access redirects. Identity invalidation
is distinct from ordinary cache deletion: only the former may discard a live
authenticated editor buffer. Peer messages invalidate; `/api/me` authorizes.

## Candidate correction: cache-disabled verified online viewer

`/api/me` is the authority for the authenticated viewer. Cache inspection, cleanup,
and persistence are best-effort side effects: a storage failure returns the
verified user with `cacheViewerId: null` and an AppShell warning instead of
blocking online data. The candidate never treats a failed cleanup as completed,
does not probe or write an unknown prior identity, and relies on the cache
purge's suspension of each known prior identity when cleanup fails. Abort
signals and AppShell request generations remain authoritative.

## Peer logout review verification

A static review suggested that the peer tab retained a separate remembered
viewer-ID record after successful logout. That premise does not apply: the IDB
metadata store is shared by same-origin tabs, and the successful purge removes
the matching viewer-ID record before completion is broadcast.

The parent extended the existing real two-page logout fixture to assert the
peer settles to `guest`, has `cacheViewerId: null`, and reads `null` from the
public `readCachedViewerId()` after completion. These assertions pass without a
production change. The fixture also retains its pending-response, both-user
purge, early UI blocking, and native-navigation assertions.

Candidate command:
`node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-storage-retention.spec.ts identity-lifecycle.spec.ts --workers=1`
— **12 passed** (7 identity, 5 storage-retention); candidate typecheck passed.
This rejects the specific reported successful-purge repro, not every possible
missed-message or concurrent-auth scenario. Server preparation is independently
verified in the actual Worker; combined live UI adoption remains pending.
