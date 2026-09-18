# Real Worker editor-to-offline-cache acceptance

Run from the repository root:

```sh
node apps/web/scripts/test-worker.mjs --grep "real Worker source editor save refreshes offline cache"
```

`apps/web/tests/worker/worker-editor-cache.spec.ts` exercises the production
frontend and local Worker, with real DEV_AUTH login, note creation, Yjs
WebSocket, Durable Object snapshot persistence and D1 reads.

- Before editing, observe the initial folder-tree response, then await release
  of the coordinator's prefetch Web Lock and the note's initial cache commit.
- Select the source editor through its UI and append text with keyboard input.
  The task checkbox precedes the final paragraph so Markdown list continuation
  does not change the intended input.
- Await exact new Markdown from the D1-backed GET, an actual room-specific
  saved frame, a new coordinator tree response, and a cache metadata transaction
  committed with the same server `updatedAt` (different from creation).
- A test-only `addInitScript` forwards native IndexedDB `put` unchanged and
  observes transaction completion; it does not modify writes, call production
  helpers, or introduce an application test API.
- Confirm the online CodeMirror buffer still exactly matches the keyboard input.
  With HTTP cache disabled, go offline and reload: the response must come from
  the service worker's body-free shell, the new body must render from storage,
  Edit/editable CodeMirror must be absent, the checkbox disabled, and no new
  WebSocket may be created.

No PATCH after setup, response mocks, injected saved frames, synthetic drive
notifications, candidate transforms, or arbitrary sleeps are used.

Validation: focused actual-Worker run passed on local Windows Chromium, including
a repeat run; Biome check and `git diff --check` passed. The runner reported
owned child shutdown and runtime removal. An initial test expectation failed
because Enter at the end of a task list continued the list; placing the existing
task before the final paragraph corrected the setup without changing production
behavior or weakening the exact D1 assertion.

This is one canonical-note keyboard-edit acceptance, not evidence for IME,
multiple concurrent editors, remote Cloudflare deployment, or all C11 scenarios.
