# Pending cross-tab note-denial regression

Public two-page regression: `apps/web/tests/browser/note-denial-tabs.spec.ts`.
Page A holds an authenticated Alice note response. Page B receives same-actor
HTTP 403 and completes durable denial. Releasing A's older 200 currently returns
a successful note and restores its body in the shared cache.

Parent command:

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser note-denial-tabs.spec.ts --workers=1
```

Actual **RED**: expected `{restored: null, stale: false}`, received the original
Markdown body and `stale: true`. Baseline cache SHA256:
`88abe30421cd1ebd586adf0020ffb36f424e656829ab5d1a117a4cf3b116115c`.

The existing note generation ledger is realm-local. Shared user-clear epochs
alone do not order individual note denial. Repair must preserve canonical/short
identity, same-page entry ordering, fail-closed marker writes, independent
resources, and genuinely fresh post-denial revalidation. Do not substitute
latest-request-wins or permanently sticky denial.

This test is deliberately committed failing until the core repair follows the
currently owned folder-denial slice. No test exclusion or completion claim.

## Parent correction and combined GREEN

The child's first implementation stopped stale publication but failed fresh
revalidation (a retained false marker was still treated as denied), split
foreground/prefetch sharing, incremented generations on clear, and did not
guard the body metadata transaction. Parent focused validation exposed these
as **9 passed / 3 failed** before correction.

The corrected rule keeps synchronous same-page entry order and adds a distinct
persistent denial sequence captured before HTTP. Only denial advances it.
Relevant canonical/short markers retain that generation after authorized clear.
The body write transaction checks it, and final cached/network publication
checks relevant identities plus the purge epoch. Prefetch supplies the same
captured authority as foreground reads.

Transport sharing also includes the persistent purge epoch. A new two-page
test disables BroadcastChannel: a post-purge caller must not join the old
pending transport even if the note sequence resets after purge. It was actually
RED (one request instead of two) and then GREEN.

Subscriber-lifetime tests now explicitly supply authority captured through the
public cache helper, as the real foreground/prefetch callers do. This separates
their transport-subscription assertions from arbitrary animation-frame timing
of metadata acquisition; their cancellation and independent-result assertions
are unchanged. The final epoch fixture observes the retained marker's native
`put` with `denied: false`, rather than expecting deletion of ordering state.

Final composed candidate `all --workers=1`: **198 passed**, typecheck and
source lint40 passed. Full source hashes and remaining requirements are in
`composed-adoption-manifest.md`. This is not full C1–C12 completion.
