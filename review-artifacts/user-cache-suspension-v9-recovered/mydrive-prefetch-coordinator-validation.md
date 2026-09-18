# MyDrive prefetch coordinator validation

This document records D85 validation for the candidate worktree. The change is
limited to the new coordinator, the candidate `AppShell` attachment, and these
two candidate records. Acquisition (`mydrive-prefetch.ts`), APIs, storage, PWA,
other UI, tests, runners, and live sources are unchanged.

The focused trigger cases are:

- startup failure followed by three `online` events;
- startup failure followed by three visible `visibilitychange` events;
- one recovery cycle and one body fetch after each burst, without reloading
  Home.

Validation commands and exact results are appended after the serial run. This
slice does not claim full prefetch, offline/PWA, auth-refresh, periodic,
mutation, focus, cross-tab, or normal-request coalescing completion.

## D85 serial validation

- Candidate focused browser:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch-triggers.spec.ts mydrive-prefetch.spec.ts`
  — **3 passed**. This includes both recovery bursts and the existing startup
  MyDrive acquisition case.
- Candidate complete suite:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1`
  — **76 passed**, including typecheck and Biome.
- Live unit regression:
  `pnpm --filter @miyulabmd/web test` — **117 passed, 0 failed**.
- `git diff --check` — passed.
- Dependencies were initially absent; the permitted
  `pnpm install --frozen-lockfile` and project-local
  `pnpm --filter @miyulabmd/web run test:browser:install` were run before
  validation. No source, test, runner, API, storage, or PWA files were added
  outside the requested candidate scope.

Final SHA-256 values:

- `src/lib/mydrive-prefetch-coordinator.ts`:
  `66d69d81e75611e10eede709aa1314a942ec44c9a718a2858087f54226eee177`
- `src/components/layout/AppShell.tsx`:
  `4a2cc87657ec28228477ffb452412b31815e00f6540e93b25651c6dc7b2471e8`
- `mydrive-prefetch-coordinator-decisions.md`:
  `1d2f5cc6b026349fac5fbe07014760ae07bbd9dadaa09e04d6edb846a14818de`

## D88 serial validation

- Initial dependency setup:
  `pnpm install --frozen-lockfile` — **completed**.
- Project-local browser setup:
  `pnpm --filter @miyulabmd/web run test:browser:install` — **completed**.
- Candidate focused browser:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch-tabs.spec.ts mydrive-prefetch-triggers.spec.ts mydrive-prefetch.spec.ts`
  — **5 passed**.
- Candidate complete suite:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1`
  — **78 passed**, including candidate Biome checks.
- Live unit regression:
  `pnpm --filter @miyulabmd/web test` — **117 passed, 0 failed**.
- `git diff --check` — **passed**.
- Candidate source SHA-256:
  `src/lib/mydrive-prefetch-coordinator.ts`:
  `83860f35d2da2d6d745d6042ba0a148e9dbfaf1fcc8bac1c0008659bd8d3b44c`.
- Scope check: only the candidate coordinator source and the two append-only
  coordinator records were changed. No live source, tests, runner, API,
  storage, AppShell, or PWA files were edited.
- This validates D88 only; it does not claim full PWA completion or the
  explicitly deferred identity-change/privacy and deduplication requirements.

## D91 serial validation

- Initial focused browser attempt:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch-periodic.spec.ts mydrive-prefetch-triggers.spec.ts mydrive-prefetch-tabs.spec.ts`
  — **exit 1** because the project-local Playwright Chromium headless shell was
  absent (`Executable doesn't exist ... chromium_headless_shell-1243`).
- Authorized setup:
  `pnpm install --frozen-lockfile` — **completed**.
  `pnpm --filter @miyulabmd/web run test:browser:install` — **completed**.
- Focused candidate browser validation (periodic, triggers, and tabs):
  the same command above — **5 passed**, exit 0.
- Candidate complete suite:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1`
  — **79 passed**, exit 0; candidate Biome checks passed.
- Live unit regression:
  `pnpm --filter @miyulabmd/web test` — **117 passed, 0 failed**, exit 0.
- Direct candidate Biome:
  `pnpm exec biome check review-artifacts/user-cache-suspension-v9-recovered/src/lib/mydrive-prefetch-coordinator.ts`
  — **passed**, exit 0.
- `git diff --check` — **passed**, exit 0.
- Final SHA-256 after validation:
  `src/lib/mydrive-prefetch-coordinator.ts`:
  `10b274fd2226a8d418c9c7b99dad783158598a0d0bcc2517b7cfacadc1fc0a1a`.
  `mydrive-prefetch-coordinator-decisions.md`:
  `1862f2ef6f659b70e3ec0d11a5bdb24237666ff474e6ede745b210775fd4a032`.
  The validation record itself was `27b24139c0a22eb6f1353645e44ccb7467a8fb03bb17b489c651cf335ae814ec`
  before this hash line was appended.
- This records candidate evidence only. Parent review and independent
  validation remain pending; no full completion claim is made.

## D94 serial validation

- Candidate focused browser validation:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch-mutations.spec.ts mydrive-prefetch-triggers.spec.ts mydrive-prefetch-tabs.spec.ts`
  — to be recorded after execution.
- Candidate complete suite, live unit regression, Biome, diff check, exact
  commands, errors, counts, hashes, and scope are recorded below after execution.
- This is candidate evidence only. Parent review and independent boundary tests
  remain pending; no full completion claim is made.

- Setup:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser tests/browser/mydrive-prefetch-mutations.spec.ts mydrive-prefetch-triggers.spec.ts mydrive-prefetch-tabs.spec.ts`
  initially failed (exit 1, `ERR_MODULE_NOT_FOUND: Cannot find package 'vite'`);
  `pnpm install --frozen-lockfile` completed, and
  `pnpm --filter @miyulabmd/web run test:browser:install` completed after the
  project-local Chromium installation was absent.
- Focused candidate browser rerun with the command above — **5 passed**, exit 0.
- First candidate complete-suite attempt — exit 1 during typecheck:
  `TS2345: RequestInfo is not assignable to string | URL` in candidate
  `api-fetch.ts:22`; the subsequent Biome attempt also exited 1 for import
  ordering, nested ternary, and formatting diagnostics. These were corrected
  with literal patches.
- Candidate complete suite:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1`
  — **80 passed**, exit 0; candidate typecheck and Biome passed.
- Live unit regression:
  `pnpm --filter @miyulabmd/web test` — **117 passed, 0 failed**, exit 0.
- Direct candidate Biome:
  `pnpm exec biome check review-artifacts/user-cache-suspension-v9-recovered/api-fetch.ts review-artifacts/user-cache-suspension-v9-recovered/drive-changed.ts review-artifacts/user-cache-suspension-v9-recovered/src/lib/mydrive-prefetch-coordinator.ts`
  — passed, exit 0. `git diff --check` — passed, exit 0.
- Final SHA-256:
  `api-fetch.ts` `33f4ad3363a793d901c843d97887a6c00115ca4a86a6b7c8709914b9f14367d9`;
  `drive-changed.ts` `636188525b7797e8138c3db4f57f67734dfa5621138836cccfc4cf592f9deb31`;
  candidate coordinator
  `728306e697af0c4c91692755691580f4da55038ea4841c70639962ffb4000630`;
  decisions `09719b340efdee8dfe194c53485e969b2ddac5106545a531875fb5087378900b`;
  validation `7b146d18d238db4563d5c7399a95fdb78cdb5c29586f58b1737471be4889d956`.
- Scope check: modified only the canonical flat `api-fetch.ts`, existing
  candidate coordinator, new flat `drive-changed.ts`, and the two append-only
  coordinator Markdown records. Live sources, tests, runner, transport, API,
  storage, AppShell, PWA, and other candidates were not edited. Parent review
  and boundary tests remain pending; no full completion claim is made.
