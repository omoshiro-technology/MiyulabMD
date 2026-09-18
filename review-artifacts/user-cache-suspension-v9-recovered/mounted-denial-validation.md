# Mounted denial propagation: parent RED

Baseline: live `311802e`. Durable note/folder cache fencing and late-response
rejection are implemented, but their denial methods do not yet publish target
events to already-mounted consumers. Image-specific invalidation is separate.

Actual command:

```sh
pnpm --filter @miyulabmd/web test:browser mounted-note-denial.spec.ts --workers=1
```

**4 failed** at the expected mounted-body removal assertion:

- authenticated network note, canonical route;
- authenticated network note, short route;
- cached readonly note, canonical route;
- cached readonly note, short route.

In each case a separate same-context page's public `NoteReadSession` observed
same-actor HTTP403 and completed denial. The first page still contained the
private body (expected0, actual1). An independent note is also mounted in a
third page; the test requires preserving it and forbids a refetch loop once
target removal is implemented. Existing assertions are retained.

Next rule: propagate a typed, user-scoped target denial to current consumers,
without using identity-wide logout/purge or replacing unrelated editor buffers.
Preserve canonical/short matching, parent-note attachment revocation, and
independent folder descendants. Durable success and storage-failure warnings
must not be conflated: a failed marker write is not a successful purge, but
known permission denial must not authorize continued display of the target.

This regression is deliberately kept RED pending the separate C2 UI slice.
The prior198-pass live suite predates these four new acceptance cases.

## Parent implementation and adoption

The delegated note/quota changes were again written to live source instead of
the requested candidate paths. They were preserved, unadopted, on local branch
`review/unvalidated-mounted-denial-quota` at `d3255f5`. The parent restored the
approved main checkout and implemented this note slice directly with literal
patches. The quarantined quota code is not adopted; in particular, splitting
image transport groups by foreground/background policy is not the intended
shared-acquisition contract.

The final note receipt carries user, current aliases, purge epoch and persisted
denial generation. It is emitted after marker commit, before physical cleanup.
Marker/open failure is a distinct receipt with unknown generation, retaining
suspension and a clear-cache warning rather than claiming deletion succeeded.
Readers re-check durable target state and their current read owner. A newer
verified read ignores old receipts; disposing the session removes the listener.
Malformed resource messages are not promoted to identity-wide invalidation.

Editor and Share remove only the affected body/title/workspace and revoke its
mutation scope/collaboration after a settled read. The read reporting403 is not
aborted by its own notification. An already-started fresh revalidation may still
settle through its authority checks. A parent's note denial removes only that
parent's view-owned image URLs, keeping other attachments and the note body.

Evidence:

- Original mounted-note RED4 -> GREEN, expanded to12 cases:
  network/cached/storage-failure × canonical/short × Editor/Share.
- Added parent-image receipt case, actually RED before hook integration.
- Added delayed-receipt/revalidation/disposal case using native transaction
  ordering rather than an animation-frame timing budget.
- Candidate focused note/image/event set: **17 passed**.
- Candidate unfiltered `all --workers=1`: **217 passed**, typecheck and source
  lint passed.
- Exact40 candidate/live source mappings verified (two existing comment-line
  exceptions only).
- Live focused note/image/event set: **17 passed**; app/SW typecheck and Web
  unit **117 passed**; diffcheck passed.

Still pending: folder/list projection and mounted folder receipts, private image
identity checking for guest/cache-disabled contexts, quota recovery, device-wide
clear/UI, and final complete requirements validation.
