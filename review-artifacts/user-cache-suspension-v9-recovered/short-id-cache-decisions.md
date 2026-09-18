# C4 short-ID cache lookup primitive

This candidate builds on the D108 purge foundation with offline-cache SHA256
`90144cfe26f967a931d64a3f04bc156d7db8ac2d019d10c858eda951f324a7b2`.
Only cache lookup changes; purge, writes, read sessions, request sharing, live
sources, and the test runner retain their existing behavior.

## Resolution and storage

- Prefer an exact canonical key for the captured user.
- Otherwise scan only that user's encoded key range for the current
  `NoteRecord.note.shortId`. Also check the record's user ID before returning it.
- Read OPFS through the resolved record's canonical `noteId` and `fileName`;
  return its original canonical note ID and `cachedAt`.
- A committed replacement owns the new short ID. There is no alias registry,
  duplicate record/body, or schema upgrade, so obsolete short IDs disappear
  from subsequent lookups automatically.
- A bounded scan is linear in this user's cached notes. Prefer this simple
  primitive over a migration/index or a second persistent alias mapping until
  measurements justify the extra storage invariant.
- Article aliases are not supported: they have a different server contract.

## Denial and lifetime

The request ID's generation is captured before lookup. Once resolved, capture
the canonical ID's generation and check its durable denial before reading the
body. Recheck durable denial for both IDs after OPFS reads, then check both
generations and the existing suspension/user-lifetime guard before returning.
Thus a retained canonical row cannot bypass canonical denial via its short ID.
No other user's rows or body paths participate in resolution.

## Follow-up boundary

This is not a general alias-aware network ordering change. Request sharing,
read-session generation tokens, and denial writes remain keyed by their
requested ID. A short-ID denial does not automatically deny the corresponding
canonical route; cross-route network success/denial ordering and successful
revalidation of both names need a separate, test-first identity design.
The separate cross-tab purge reproducer is also outside this primitive.
