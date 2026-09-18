# D60 folder denial validation

The candidate-only primitive was validated serially with the requested
commands:

```text
pnpm install --frozen-lockfile                         exit 0
pnpm --filter @miyulabmd/web test:browser:install     exit 0
candidate browser (denial + folder cache):             exit 0, 5 passed
candidate all:                                         exit 0, 61 passed
pnpm --filter @miyulabmd/web test                     exit 0, 117 passed
git diff --check                                       exit 0
```

The first `all` run had one unrelated flaky `app-shell-viewer.spec.ts` failure
(60 passed, exit 1); its serial rerun passed all 61 tests.

Final SHA256:

```text
offline-cache.ts            428673176c94a17fc16f1600c0516e85af5be5a89e7a6b0de1023e3551ff9591
folder-denial-decisions.md  9a6502c41cd125ffba578517f6ca64144a184cbb3dc41e32974b9199e8301edb
folder-denial-validation.md 252b8f36d35297a3c035b648d9de9181ad66402ca6001d74f8b9498d9c0a524c
```

The live `apps/web/src` tree is unchanged by this slice.

## D62 nearest visible parent validation

Commands were run serially for checkpoint `dd5d526`:

```text
pnpm install --frozen-lockfile                         exit 0, 855 packages
pnpm --filter @miyulabmd/web test:browser:install     exit 0
focused candidate browser (6 tests):                  exit 0, 6 passed
candidate all:                                         exit 0, 62 passed
pnpm --filter @miyulabmd/web test                     exit 0, 117 passed
git diff --check                                       exit 0
```

The focused candidate command first exited 1 because Chromium was not
installed. The first `all` command exited 1 on the expected TypeScript
`noUncheckedIndexedAccess` diagnostic before the `.at(-2)` lint-compatible
correction; the final rerun above passed. No test or runner files were changed.

Final SHA-256 before this append:

```text
candidate review-artifacts/user-cache-suspension-v9-recovered/offline-cache.ts
7ea33268a699c8ea16550164e5ac806c32a7b10a7b6a2d18b95b2ea57f54fcff
live apps/web/src/lib/offline-cache.ts
64d56a1e0570116fe90d4613635ab262947922873a7cb8240254e82846ebbbd9
```

The live `apps/web/src` tree remains unchanged. Only the permitted candidate
`offline-cache.ts` and these two append-only review records were modified.

## D63 read-order correction validation

Commands were run serially for checkpoint `ce37106`:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-folder-denial.spec.ts offline-folder-cache.spec.ts
  exit 1 (Chromium executable missing; 8 tests could not launch)
pnpm install --frozen-lockfile
  exit 0, 855 packages
pnpm --filter @miyulabmd/web test:browser:install
  exit 0
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-folder-denial.spec.ts offline-folder-cache.spec.ts
  exit 0, 8 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
  exit 1 (TypeScript TS18048 before the no-record narrowing correction)
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-folder-denial.spec.ts offline-folder-cache.spec.ts
  exit 0, 8 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
  exit 0, 64 passed
pnpm --filter @miyulabmd/web test
  exit 0, 117 passed
git diff --check
  exit 0
```

The first focused run required the explicitly permitted Chromium installation.
The first all run caught and was followed by a small TypeScript-only narrowing
correction for the coherent missing-record `null` path; the final reruns above
are the validated bytes. The D63 rationale is to make the denial marker scan
the final storage boundary after the potentially delayed folder read, without
retry loops or duplicate scans.

Final SHA-256:

```text
offline-cache.ts            8370fdd98a7a029825029f1336de8becde47bbc0262f71c41a040ae960fb52b0
```

Only the permitted candidate files were changed by this slice. Pre-existing
worktree changes under `review-artifacts/pwa-shell` were not touched. Live
`src`, tests, runner, PWA, and package files remain unchanged by this slice.
This candidate is preserved for parent review and is not adopted into the live
implementation.

## D76 cancellation correction validation

Commands were run serially after the permitted frozen dependency and Chromium
installation steps:

```text
pnpm install --frozen-lockfile
  exit 0, 855 packages
pnpm --filter @miyulabmd/web test:browser:install
  exit 0
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser cached-drive-lifecycle.spec.ts
  exit 0, 2 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-folder-denial.spec.ts
  exit 0, 5 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-drive-view.spec.ts
  exit 0, 6 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --grep-invert 'authenticated startup prepares unvisited MyDrive'
  exit 0, 67 passed (the unrelated prefetch RED test was deliberately excluded)
pnpm --filter @miyulabmd/web test
  exit 0, 117 passed
git diff --check
  exit 0
```

The first focused lifecycle attempt before installation exited 1 because the
Playwright Chromium executable was absent; no test failure was inferred from
that environment error. The final focused runs above were serial. A duplicate
drive-view invocation was also issued concurrently during investigation and
is not counted as the validation run.

Final candidate SHA-256:

```text
review-artifacts/user-cache-suspension-v9-recovered/src/lib/cached-drive-reader.ts
fb0f5b581bef32a53382dce246445cf890130249d04b8c2b15ee008dd02d99c5
```

Diff scope is limited to the permitted candidate reader and append-only
changes to these two folder-denial records. No live source, tests, runner,
PWA, API, storage, prefetch helper, delete, staging, restore, or commit was
changed.

## D72 compound-reader validation

The requested commands were run serially after the candidate-only reader
ordering edit:

```text
pnpm install --frozen-lockfile
  exit 0, 855 packages
pnpm --filter @miyulabmd/web test:browser:install
  exit 0
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-folder-denial.spec.ts offline-drive-view.spec.ts
  exit 1, 9 passed, 2 failed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
  exit 1, 63 passed, 2 failed (65 tests; candidate typecheck/Biome check passed)
pnpm --filter @miyulabmd/web test
  exit 0, 117 passed
git diff --check
  exit 0
```

The focused failure is `offline-folder-denial.spec.ts`'s compound-drive case:
the delayed native note-list request is aborted while `denyFolder` waits for
that transaction, so the page evaluation reports `AbortError`. The other
candidate failure in both the focused and all runs is the pre-existing
`offline-drive-view.spec.ts` pending-folder-after-suspension case, which times
out after 30 seconds. No test, runner, live source, PWA, or other candidate
file was changed to bypass either result.

Final SHA-256 after this append:

```text
cached-drive-reader.ts
e2b6c93e08ab21b820077dde2bb8e11c0cec37698410dbb8037ac74ad8e75fb2
folder-denial-decisions.md
3163dec765187bbbaf902049ed05b0ef6237cdc7fc4cfbc2053c70ecb011b232
```

The validation record intentionally does not embed its own digest (which would
be self-referential). The candidate is preserved for independent parent
review.

## D72 parent verification and fixture correction

The preceding AbortError explanation was an unverified hypothesis, not a
storage conflict diagnosis. Parent review found that the test cursor wrapper
read `request.result` after the real handler called `cursor.continue()`.
At that point the request is pending again; the instrumentation could throw
and abort the native transaction. The wrapper now captures the terminal-cursor
condition before calling the handler. No production code was changed for this.

The older suspension test also required a folder request to complete before
releasing the note list. It now waits for that folder only if already started,
so it tests the same rejection rule with either parallel or sequential reads.
Neither test removes its denial, suspension, parent, or timestamp assertions.

Independent parent commands after these fixture corrections:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
  exit 0, typecheck/Biome passed, 65 passed
pnpm --filter @miyulabmd/web test
  exit 0, 117 passed (live regression)
pnpm exec biome check apps/web/tests/browser/offline-folder-denial.spec.ts apps/web/tests/browser/offline-drive-view.spec.ts
  included in the parent 8-file check, exit 0
git diff --check
  exit 0
```

Candidate reader bytes remain
`e2b6c93e08ab21b820077dde2bb8e11c0cec37698410dbb8037ac74ad8e75fb2`.
This verifies the bounded D72 folder-publication rule; HTTP denial wiring and
other compound lifetime boundaries remain separate work.

## C3 validation

Candidate typecheck and lint passed (`exit 0` each). After the authorized
Chromium installation, the existing parent folder-denial browser spec passed
(`5 passed`). The new focused boundary spec passed the null-root/literal-ID
case, while its two-page late-200 case still fails because the second page's
denial is not observed by the first page before stale clear. This remains a
recorded C3 failure rather than an exclusion. Live `apps/web/src` was not
edited.

## Parent merged correction evidence

- Corrected the child test to use two pages in **one browser context**, and
  require rejection of stale revalidation. Added a separate real routed-HTTP
  Home test: held 200, other-tab 403, stale result rejected, fresh read succeeds.
- Added null versus literal `"root"`, `"null"`, former sentinel, and structured
  ID boundaries, plus repeated denial/revalidation and independent folders.
- Added Home denial during the final epoch await to the existing terminal
  regression without removing any abort/ownership cases.
- Candidate typecheck passed. Focused cache/Home/terminal run before the last
  added cases: **25 passed**.
- Unfiltered candidate `all --workers=1`: typecheck and source lint passed;
  **188 passed / 5 failed**, total193. All new folder/terminal cases passed.
  Failures were the separate known note-denial-tabs RED and four old response
  fixtures missing verified actor headers after broader caller enforcement.
- Parent migrated only those fixture responses, preserving assertions:
  `note-request-sharing.spec.ts`, `user-cache-suspension.spec.ts`,
  `offline-cache-cleanup.spec.ts`. Their serial rerun: **7 passed**.
  This does not retroactively turn the preceding full run into a green result.
