# C7 disconnect validation

## Public regression and RED

Added `apps/web/tests/browser/editor-disconnect.spec.ts` before implementation.
It uses the existing real-page HTTP and `routeWebSocket` fixture seams:

1. Open the real note route, click Edit, and initialize the actual y-websocket
   provider with a Yjs sync-step-2 frame.
2. Enter text through browser keyboard input. The server fixture deliberately
   does not store client updates, so its next sync snapshot lacks this buffer.
3. Close that WebSocket through `WebSocketRoute.close()`.
4. Expect a paused/resync explanation, retained DOM editor/selection/focus,
   blocked new typing and undo, and unavailable note mutation controls.
5. Dispatch the browser online hint and accept a second WebSocket without
   sending sync: editing must remain paused.
6. Send the real Yjs sync response and verify the same editor/buffer/caret,
   resumed typing, and restored mutation controls.
7. Open Share and disconnect again; its already-open mutation controls become
   disabled without sending HTTP writes.

The initial source-mode run failed after a real initial sync, entered text,
and socket close: the expected disconnect status did not exist. This was a
behavioral RED, after installing the isolated clone's dependencies and
project-local Chromium (the preceding missing-Vite/missing-browser failures
were environment setup, not RED evidence).

After source-mode GREEN, the regression was extended to rich and split modes.
Rich mode exposed a second failure: readonly native undo moved the retained
caret, so resumed text appeared before the earlier buffer. Stable focusability
and the readonly undo fallback guard fixed it without replacing the editor.

No test calls mutation internals, fabricates provider state, or changes the
candidate runner's loading mechanism. Its default spec list has one appended
entry, `editor-disconnect.spec.ts`.

## Results

Run from the repository root:

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all editor-disconnect.spec.ts editor-read-lifecycle.spec.ts offline-note-view.spec.ts
pnpm exec biome check apps/web/tests/browser/editor-disconnect.spec.ts apps/web/scripts/check-offline-candidate.mjs
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
```

- Targeted candidate typecheck passed.
- Targeted candidate lint passed with three existing `useExhaustiveDependencies`
  warnings inherited from the copied rich editor (`refreshMap`, `applyRemote`,
  `refreshCarets`). No lint errors or formatting errors.
- Targeted browser suite: **11 passed**, including all three disconnect modes,
  normal online collaboration, note navigation/stale responses, and cached
  readonly viewing.
- New spec and runner Biome check: **2 files passed**, no fixes applied.
- Full candidate validation: typecheck and lint passed; **97 browser tests
  passed** with the new default entry.
- The candidate runner's unchanged-file checks passed: it did not modify live
  sources or authoritative candidates during either validation.

This slice is not a PWA production-build test, backend integration test, native
mobile IME test, or durable unsent-buffer recovery guarantee. No PWA harness,
cache core, shared parser, backend, or AppShell files were changed; no live
source adoption or commits were made.

## Follow-up validation: IME and in-flight share completion

The appended regressions were written before implementation. After a frozen
dependency install (`pnpm install --frozen-lockfile`) and project-local Chromium
install (`pnpm --filter @miyulabmd/web test:browser:install`), the behavioral RED
run of `editor-disconnect.spec.ts` produced **3 passed, 2 failed**:

- Real Chromium CDP `Input.imeSetComposition` entered `入力中` into the rich
  editor before the socket closed. The fixture then sent a changed Yjs snapshot
  adding frontmatter, forcing the full remote-content application path. After
  resync the composition text was absent. This was browser-observed data loss,
  not a synthetic composition event or an inferred source-only failure.
- A share PATCH issued while synced was held until after socket close. Resolving
  it with HTTP 500 failed the assertion for the error message: paused writability
  incorrectly suppressed the completion.

Implementation first made IME GREEN and exposed a test-locator ambiguity for
the newly visible share error (the page and dialog both render it). The assertion
was scoped to the dialog; it was not weakened. A companion successful response
case also verifies that canonical server state replaces the optimistic draft
while paused. Both completion cases verify exactly one PATCH through reconnect.

The IME regression additionally checks retained editor identity, focus and caret
at the pause boundary, blocked new browser input, and the composition buffer
after changed remote sync. The original source/rich/split regressions remain
unchanged. Existing note-navigation stale folder success/failure tests still pass.

Final commands:

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all editor-disconnect.spec.ts editor-read-lifecycle.spec.ts offline-note-view.spec.ts
pnpm exec biome check apps/web/tests/browser/editor-disconnect.spec.ts
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
```

Results:

- Focused candidate typecheck passed.
- Candidate lint/check passed: **24 files, no warnings or errors**. Stable rich
  callbacks also resolve the three previously documented dependency warnings.
- Focused browser suite: **14 passed** (including six disconnect cases).
- Browser-spec Biome check: **1 file passed**, no fixes.
- Unfiltered default `all`: typecheck/lint passed; **111 browser tests passed,
  1 failed**. The remaining failure is
  `offline-direct-denial.spec.ts:47`, “a short-ID HTTP denial also hides its
  canonical cached body and list entry”: the short entry is hidden but the
  canonical cached note/list entry remains. This is the previously identified
  out-of-scope inverse short-ID denial defect; no exclusion was used and this
  full run is **not GREEN**.
- Runner unchanged-file guards passed. This follow-up did not edit the runner,
  live sources, cache/API layers, MarkdownEditor, or other candidate scopes.
  No stage, commit, adoption, or publication was performed.

These tests use desktop Chromium CDP, not a native OS/mobile IME driver. They
do not claim durable buffer persistence or production backend/PWA acceptance.
