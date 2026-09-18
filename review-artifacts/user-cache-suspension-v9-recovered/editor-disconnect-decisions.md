# C7: pause a previously synced editor on provider disconnect

Candidate only. This does not adopt files into `apps/web/src` or change the
offline-cache, AppShell, coordinator, parser, backend, or PWA harness.

## Boundary and state

The existing online note read still grants network provenance and the existing
permission-based editor mode. The first Yjs sync still initializes the editor.
Cached note reads remain preview-only and never initialize collaboration.

After that first sync, `collabReady` remains true for the session, even when the
provider emits `sync(false)` or a disconnected/connecting status. A separate
`collabWritable` value requires **both** `provider.wsconnected` and
`provider.synced`. The page derives a paused mutation capability from those
facts without changing the note's read provenance.

A browser `online` event and WebSocket open alone cannot resume editing. The
existing provider must reconnect and receive the actual Yjs sync response.
Listeners are removed through the existing collaboration teardown. Note/viewer
navigation retains the existing teardown and initialization behavior.

## Keep the document and editor, change only input capability

The page does not force preview, reset the Markdown state, destroy the Y.Doc,
replace the editor, or fetch a cached snapshot on disconnect. It shows an
accessible explanation that entered content remains in this screen and editing
is paused until reconnection/resync.

The permission/provenance `canEdit` value remains the collaboration lifecycle
input. A separate `canMutate` value controls editor readonly props, mode controls,
task mutation binding, share controls, and history restoration. Mutation-oriented
header controls are omitted while paused. Already-open share/history dialogs
remain mounted but cannot mutate. Folder/access callbacks also check the current
provider state at dispatch and completion, not just a captured render value.

The editor components need candidate copies because the original CodeMirror
effect includes `readOnly` in its construction dependencies:

- CodeMirror uses a `Compartment` to reconfigure editable/readonly facets in the
  same view. A transaction filter rejects local document changes but accepts
  Yjs synchronization transactions. Its retained undo manager is also guarded:
  y-codemirror undo mutates Y.Text before a CodeMirror transaction is created.
- TipTap keeps its existing editor and uses `setEditable(..., false)`. A
  ProseMirror transaction filter rejects document-changing local commands while
  allowing the existing remote-Yjs application path. Upload/link continuations
  recheck readonly/liveness before inserting.
- Both editors remain keyboard-focusable with `tabindex=0`. Without that,
  Chromium moves focus to the body when contenteditable becomes false. Rich
  editor native undo can then move the retained caret even though the document
  remains unchanged. Rich readonly undo/redo key handling suppresses this native
  fallback; the transaction filter is the mutation boundary, not a DOM-only
  event shield.

## Alternatives rejected

- Setting `collabReady=false`: replaces the live editor with the connection
  loading screen, destroying selection/editor state.
- Reusing permission `canEdit` for transport loss: forces preview and invokes
  collaboration teardown, discarding the in-memory unsent document.
- Passing readonly into the original CodeMirror construction effect: preserves
  Y.Text but recreates the editor and loses selection/undo state.
- Only intercepting DOM input: insufficient for undo commands, delayed upload
  completions, and programmatic editor transactions.
- Browser connectivity hints: do not prove the note's WebSocket has resynced.

## Scope of preservation

This protects the current live document/buffer; it is not offline editing, a
durable Yjs store, a new mutation queue, or a recovery copy after page exit.
Existing in-memory Yjs synchronization is retained, including its normal merge
on reconnect. No HTTP mutation is newly queued/replayed by this change, and no
request already sent to the server can be undone by disabling controls.

The public regression uses browser input and actual WebSocket close/sync
boundaries. Native mobile/OS IME and crash recovery are not claimed by the
desktop Chromium validation.

## Follow-up: accepted composition and issued HTTP requests

Two lifecycle boundaries needed different rules from new input.

### Preserve accepted rich-editor state before pausing

Rich IME updates already enter ProseMirror while `flushLocal` deliberately
defers serialization until composition ends. Making that editor readonly first
left the accepted composition outside Y.Text forever: the later composition-end
flush was readonly-blocked, and a changed remote sync could replace it.

The writable-to-readonly layout transition now commits the already-accepted
ProseMirror document through the same `commitLocal` serialization path as normal
updates, ends the local composition deferral, and drains pending remote work.
This is not permission to process new DOM input: the readonly ref and transaction
filter already reject new local document changes, and `setEditable(false)` still
disables contenteditable. No editor remount, focus/selection reset, timeout,
offline input window, or reconnect-only recovery was introduced.

The rich map/cursor/serialization callbacks are stable with explicit dependencies,
so the layout transition and observer effects use the same current logic without
running merely because a function identity changed.

### Separate dispatch permission from completion ownership

This supersedes the earlier statement that folder/access completions check
provider writability. `canStart` checks the current provider capability at entry;
`isCurrent` checks only the captured note/viewer read scope. Both are required to
issue a request. Once issued, a response owned by that same scope must reconcile
even while collaboration is paused.

Success adopts the canonical server response. Failure restores the original
access/folder value and reports its error, including thrown transport errors.
Navigation/viewer invalidation still makes the captured scope stale and suppresses
its result. No request is retried or replayed on reconnection.

Rejected alternatives: treating pause as stale ownership loses server outcomes;
waiting for reconnect leaves optimistic state unresolved unnecessarily; allowing
the composition-end callback to write arbitrary readonly document updates would
blur the boundary between already-accepted state and new offline input.
