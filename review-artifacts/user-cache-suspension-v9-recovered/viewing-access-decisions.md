# D36 viewing/mutation access policy

Checkpoint: `70431e6c2ab38f1e04fc1efa922e4b8bf0d092f2`

## Contract and choices

- The candidate exports `createViewingAccess(readViewer)`, whose
  `getAccess` is safe to pass unbound, and `beginView(ownerViewer)` returns
  lifecycle-scoped `publish` and `dispose` functions.
- A valid `beginView` replaces any prior scope with `pending`. It is accepted
  only for the exact current viewer snapshot. A scope token makes old
  publish/dispose handles unable to affect a replacement.
- Scope ownership is checked by viewer object identity, while published
  payloads use the viewer association (`mode`, `cacheViewerId`, and user ID).
  This permits the read-session clone required by the contract without
  allowing another viewer's result to publish.
- Access and viewer values are copied at both publication and readback.
  This avoids freezing or changing caller objects and prevents callers from
  mutating policy state.
- A stale active scope reports `pending` (fail closed). No active scope uses
  the current root viewer with `network`, leaving the existing mutation gate
  as the single permission rule.
- Global dispatch is a latest-binding-only boundary. Registration tokens mean
  an older cleanup cannot remove a newer binding; removing the latest leaves
  the boundary unbound rather than resurrecting an older getter.

## Alternatives rejected

- Comparing only user IDs or mode would let a replaced viewer snapshot retain
  an old lifecycle. Identity is therefore required for scope lifetime.
- Trusting the published viewer object would reject legitimate cloned
  note-read results; trusting only authentication would allow cached viewing to
  mutate. Association matching plus the explicit source preserves both
  requirements.
- Keeping a stack of global bindings would make cleanup order resurrect stale
  access. The contract requires fail-closed unbinding instead.

The module deliberately has no API, storage, framework, online-event, or
cross-tab dependencies. Server authorization remains authoritative.
