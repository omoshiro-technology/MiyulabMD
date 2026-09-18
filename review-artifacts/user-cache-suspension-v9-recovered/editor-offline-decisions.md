# D41 editor cached-note candidate decisions

## Recommended boundary

`EditorPage` owns one `createNoteReadSession(viewer)` and one
`viewing.beginView(viewer)` scope for the current note ID and shell viewer
identity. The scope is disposed only when that identity, ID, or component
changes, not when the read promise resolves. The reader remains the source of
truth for network/cache provenance and `cachedAt`.

The candidate deliberately keeps cached and fallback results read-only:
there is no task-note binding, collaboration session, access mutation, folder
mutation, or optimistic edit path. This avoids making a cached snapshot appear
editable and lets the existing mutation gate reject direct writes.

## Alternatives considered

* Continuing to call `loadNote`/`noteFromCaches` was rejected: those APIs have
  no owned viewer/session and cannot distinguish verified cache ownership from
  SSR or legacy maps.
* Disposing the viewing scope in the read continuation was rejected: header and
  task controls can outlive the promise, so the provenance must remain
  available for the entire display lifetime.
* Treating `viewer.user` as sufficient authentication was rejected: cached
  and unavailable viewer modes intentionally do not prove a current session.
* Keeping the normal collaborative editor active for cache fallback was
  rejected: it creates a write-capable transport for a read-only snapshot.

## Evidence

The two D41 real-page tests fail before this candidate because the legacy
`EditorPage` uses `loadNote` and never polls the persistent cache. The
candidate uses the approved session's `source` and `cachedAt` directly and
publishes the same result to the approved viewing controller.

## Rejected implementation

The first candidate version replaced the existing page with a small
read-only renderer. That approach is rejected: it removed the online editor,
Yjs collaborative lifecycle, mode switching, folder/access/history controls,
article-source handling, and the existing editor header behavior. Passing the
offline acceptance cases by deleting those capabilities violates D41's
requirement to preserve the online editing UX. The replacement must instead
start from the complete 656-line `EditorPage.tsx` and make only the owned-read,
provenance/capability, and cache-status changes.

## D42 adoption notes

The complete page now starts with no legacy cache/SSR note state. After
`userLoading` settles it creates a viewer-owned read session and a viewing
scope, and keeps both alive for the display lifetime. The result publishes
source and viewer association before it can update the page; stale results
are ignored. Cache results remain preview-only, suppress collaboration and
mutation-oriented header controls, and expose the persisted `cachedAt` value
in one accessible status message. A cache miss has a local-cache explanation,
while server failures retain their cache warning.

## D43/D44 correction decisions

The candidate now models read provenance as one state tagged with the requested
note ID and viewer association. A layout-phase reset clears hydration, note
data, markdown, folder, access draft, and mode before a new ID/viewer can
render. This was chosen over synchronizing separate `readSource` and
`cachedAt` states because separate state can carry a previous owner's network
capability into the first render of a new request.

Only successful reads publish their real source. Denials, HTTP failures, and
thrown communication errors publish `pending`, keep `canEdit` false, and never
open the mutation gate. Successful network reads set hydration; cached reads
remain preview-only. An unavailable viewer creates only a pending viewing
scope, shows the generic `閲覧情報を確認できません` explanation, and does not
create a note session or issue a note GET.

The complete online workspace and its existing Yjs/header/rendering paths were
retained. Resetting mode to preview on each new read preserves the original
new-note/history navigation behavior rather than fixing the WebSocket count by
removing collaboration. Scope publication and error callbacks both require
the current scope and cancellation check, while disposal remains tied to the
ID/viewer lifetime.

## D45/D46 implementation decisions

Mutation callbacks now receive the `isCurrent` predicate from the viewing
scope. They check it before dispatch and again after the awaited update, before
any success, error, rollback, or legacy cache seeding. A stale response is
silently ignored; this does not claim to undo a request already accepted by the
server. Thrown update errors are reported only while the scope remains current.
The ordinary no-scope network default and the existing mutation gate are
unchanged.

The scope handle exposes a pure `isCurrent()` method backed by its existing
token, owner reference, and viewer-association rules. Replacing a scope,
changing its viewer, starting with a stale owner, and disposing a scope all
return `false`.

ID/viewer lifetime resets now also close share and history dialogs and clear
the prior save error. Cached and pending views continue to force preview mode
and omit editable header controls. The complete online editor, Yjs lifecycle,
mode switching, and existing Markdown history behavior remain intact.

The chosen scope-based callback contract was preferred over wrapping each
setter independently because it covers cache seeding and exception paths with
one rule. Treating every no-scope page as pending was rejected because it would
break intentionally network-capable authenticated and guest pages.
