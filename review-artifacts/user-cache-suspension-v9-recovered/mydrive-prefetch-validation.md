# MyDrive prefetch candidate validation

The RED test is `tests/browser/mydrive-prefetch.spec.ts`: authenticated Home
must remain rendered while an unvisited owned folder and owned note body become
available through the existing cache APIs; an accessible note owned by another
user must not be fetched. The same test then disables API traffic and navigates
to the cached folder and note.

Validation performed in this candidate worktree:

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch.spec.ts`: 1 passed.
- The same runner in `all` mode with the 66 positional files from
  `apps/web/tests/browser/*.spec.ts`: typecheck passed, Biome passed, 66 passed.
- `pnpm --filter @miyulabmd/web test`: 117 passed.
- `git diff --check` and focused Biome check: passed.

Candidate SHA-256 values:

- `src/lib/mydrive-prefetch.ts`: `a13c8bc96503fff89ba33f1fe99903d134df068172e67cd4c5ce375855f1fa95`
- `src/components/layout/AppShell.tsx`: `3de2893f6ffc6f1afa962870d74a98a44828b8df7bae212e78eca822a5055e42`
- `api.ts`: `2edc2e4ecf6a15a2eb5261d7fd24cffc279943f3d4f13377dd0bd0f26306d08e`

This deliberately does not claim live adoption, full offline coverage, retries,
cross-tab coordination, images, or quota recovery. The parent should rerun the
combined suite when the two D76 lifecycle cases are present.

## D77 validation

- Candidate focused browser command
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser mydrive-prefetch-ownership.spec.ts mydrive-prefetch.spec.ts`:
  first attempt failed before tests ran because the worktree-local Chromium
  executable was missing; after the allowed local install, 2 passed.
- Candidate all command
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`:
  the default list includes ownership and cached lifecycle2 coverage; 69
  passed, 0 failed, including typecheck and Biome checks.
- Parent baseline before this fix remains 67 passed / 1 failed (68 total);
  the focused Home root-link failure passed on five one-worker repeats, so it
  remains an unresolved intermittent failure rather than being called green.
- Live web unit command `pnpm --filter @miyulabmd/web test`: 117 passed,
  0 failed.
- `git diff --check`: passed.

## D78 validation

- Candidate focused browser command:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser mydrive-prefetch-denial.spec.ts mydrive-prefetch-ownership.spec.ts mydrive-prefetch.spec.ts`
- Candidate all command:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
- Live web unit command: `pnpm --filter @miyulabmd/web test`
- `git diff --check`: passed.

The focused denial coverage exercises both 403 and 404, confirms the old body
is no longer readable, verifies independent acquisition is not auth-stopped,
and verifies a later successful network revalidation restores the note. Results
and candidate hashes are recorded below after the serial validation run.

Serial results: focused browser `4 passed (5.2s)`; candidate `all` `71 passed
(16.6s)` (including typecheck, Biome, and browser validation); live web unit
`117 passed, 0 failed`; `git diff --check` passed. The first focused browser
attempt before the permitted local browser install failed before tests ran
because Chromium was missing; it was rerun successfully after installing the
worktree-local browser. Candidate `src/lib/mydrive-prefetch.ts` SHA-256:
`760f549c0019e0b43d31120c1e408b3f968baff0e7db2d93b05102cb6e6ded15`.

## D79 validation

The first requested candidate-focused command could not start because the
worktree lacked dependencies: `node apps/web/scripts/check-offline-candidate.mjs
review-artifacts/user-cache-suspension-v9-recovered browser
tests/browser/mydrive-prefetch.spec.ts mydrive-prefetch-ownership.spec.ts
mydrive-prefetch-denial.spec.ts mydrive-prefetch-stops.spec.ts` failed before
tests with `ERR_MODULE_NOT_FOUND: Cannot find package 'vite'`. Dependencies are
not installed, so Chromium/test counts, the candidate-all 74 expectation, and
the live 117-unit expectation remain unverified for this change. The
standalone `pnpm exec biome check` also could not run because `biome` was
unavailable. After `pnpm install --frozen-lockfile --offline` and the permitted
worktree-local `pnpm --filter @miyulabmd/web run test:browser:install`, the
same focused command completed with `7 passed (5.6s)`. Candidate `all`
completed with `74 passed (19.9s)`, including typecheck and Biome. Live web
unit tests completed with `117 passed, 0 failed`.

`git diff --check` passed. The focused candidate scope is the four
`mydrive-prefetch*.spec.ts` files (7 tests total: startup 1, ownership 1,
denial 2, stops 3); no tests or runner files were changed. D78 denial behavior
and D77 viewer snapshot remain untouched.

Post-change candidate file SHA-256 values (computed with Node
`crypto.createHash("sha256")`):

- `src/lib/mydrive-prefetch.ts`:
  `b7f4a7d69fa1264278c258deda491eb9fc4018b0edb5d80e1a4137803d09e6fe`
- `api.ts`:
  `1d844664a3b4268b04f31b7ba27542adb2f758e04075031a0a4d02204b33faee8`
- `api-transport.ts`:
  `44f5f6d256186257a4bc2a0425e33a8bfbeba41339bbccd2635a118b566f9977`
# D82 refactor validation

The source-only change is limited to `src/lib/mydrive-prefetch.ts` plus this
decision/validation documentation. No live implementation, tests, runner,
API, AppShell, storage, or PWA files were changed.

Focused serial prefetch validation was attempted with:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch.spec.ts mydrive-prefetch-ownership.spec.ts mydrive-prefetch-denial.spec.ts mydrive-prefetch-stops.spec.ts
```

It could not start in this worktree because the frozen project dependencies
are not installed: Node reported `ERR_MODULE_NOT_FOUND` for package `vite`
imported by `check-offline-candidate.mjs`. Therefore no test pass count is
claimed here. Parent-side candidate-all, live-unit, Biome, and diff checks
remain required before adoption.

## D82 independent parent verification

Parent ran the candidate runner with installed dependencies. Its first
typecheck failed with TS18047 at the cache-open callback: narrowing
`ownedViewer.user` did not survive capture by the callback. Parent captured
the already-validated user ID in a const, removed the duplicate root check
(the folder acquisition routine owns that check), and applied the local
formatting corrections through literal patches.

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1
  exit 0, typecheck passed, Biome checked 17 files, 74 passed
```

The 74-case suite includes the seven prefetch cases and both compound-cache
cancellation cases. An unmocked AppShell fixture tree request logged a
localhost proxy connection error; its test still passed. This is recorded,
not presented as production backend coverage or as a fix for the earlier
intermittent parallel Home root-link timeout.

Final parent-reviewed candidate source SHA-256:
`63f06eb02b25c61e7b0f57284b830fd00748cdd9bd777dfa0cee1edf2b123f3f`.

Correction to the earlier D79 API hash transcription: the actual `api.ts`
SHA-256 printed by the parent runner is
`1d844664a3b4268b04f317ba27542adb2f758e04075031a0a4d02204b33faee8`.
The earlier longer string in this record is a typo, not another code version.
