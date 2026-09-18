# D97 viewer recovery decisions

## Scope

This candidate implements D97 only. The only code change is the candidate
`src/components/layout/AppShell.tsx`; the live application, tests, runner, API,
viewer context, storage, editor, coordinator, and PWA sources are unchanged.

## Adopted approach

- Initial mount and recovery use one `requestViewer` entry point around the
  existing `resolveViewerContext`.
- `online` and visible `visibilitychange` retry only `cached` or `unavailable`
  viewers. Stable authenticated and guest viewers are not reset.
- `viewerRequestRef` coalesces concurrent requests. Each request retains its
  generation and abort controller, and publication requires the active,
  generation, and non-aborted guards.
- The request reference is cleared only when the matching request settles, so a
  completed initial request cannot suppress a later recovery.
- Recovery never changes initial loading or hides cached content. Only the
  resolver's authoritative viewer result changes the viewer; cached identity
  does not authenticate anyone.
- Cleanup removes both listeners and aborts whichever request is current,
  including a later recovery request. Existing `setUser` invalidation remains
  unchanged. `AuthConfig` remains independent.

The candidate does not claim full authentication, cross-tab, PWA, failure-race,
or ownership-race completion. The parent will add the latter race tests before
adoption.

## D98: Preserve unchanged unauthenticated viewer identity

- **State**: Implemented in this candidate only; parent review and late-ownership
  validation remain pending.
- **Background**: A recovery request can resolve to a newly allocated
  unauthenticated context whose mode and cached viewer identity are unchanged.
  Publishing that equivalent object unnecessarily replaces the React viewer
  identity, which can reset editor-local state such as a body selection while a
  retry is pending.
- **Options**: Replace the viewer for every resolver result; compare serialized
  objects; or preserve the current identity only for equivalent
  unauthenticated contexts.
- **Adopted**: The narrow equivalence guard. When both old and new users are
  `null` and `mode` plus `cacheViewerId` are unchanged, neither
  `viewerRef.current` nor React viewer state is updated. Initial loading still
  completes. Authenticated results and changed mode/cache identity still
  publish through the existing path.
- **Constraints**: Generation, abort, in-flight reference clearing, cleanup,
  retry eligibility, and `setUser` behavior are unchanged. No editor-specific
  workaround or global suppression of authenticated/profile/association
  changes is introduced.
