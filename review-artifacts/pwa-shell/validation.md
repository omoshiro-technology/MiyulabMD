# PWA shell candidate validation

## Candidate runner

- Command: `node apps/web/scripts/check-pwa-candidate.mjs review-artifacts/pwa-shell`
- Exit: `0`
- PWA browser tests: `1 passed` (1 test, 4.2 seconds)
- Production precache: `119 entries (3274.18 KiB)`
- Live input and candidate byte invariants: passed
- Candidate files and SHA-256:
  - `public/icon.svg`: `135fa8ec8a30630e1c2455b83a9d0abeb767bf1f1f07d1f1c1bfe5d9598277c1`
  - `service-worker/sw.ts`: `7013cc83138132e565dfc5a6d384ab2f7a89646ff4ba839aff4dc56c65ea9431`
  - `src/lib/register-service-worker.ts`: `82526993f61599c037887d64dd2ea81b37aec5237881a7b268bb44b2bd74a737`
  - `src/main.tsx`: `4d35a33cc9aa942474610a7ed0190e687fe755564e7f7a36298176ac8062478b`
  - `tsconfig.sw.json`: `8fbfee86a1df3c33c838d700d742c8212b2129b605dd3f30f956bb3bbccb1260`
  - `vite.config.ts`: `74484246c7cdb0102fc28bcf017c9b04d7037fce7f312bdbd6828042e6fbad44`

Build emitted the existing large-chunk warning for the approximately 2.29 MiB
main chunk (`index-CMLf_G6Q.js`), while the 5 MiB Workbox limit included it.

## Live unit regression

- Command: `pnpm --filter @miyulabmd/web test`
- Exit: `0`
- Result: `117 passed`, `0 failed`, `0 skipped`
- `git diff --check`: passed

This is only the first boot/offline-shell checkpoint. SSR privacy, route
exclusion, foreign-cache protection, and update lifecycle tests remain pending.
The normal dev browser suite's separate folder-denial test is not claimed green
for this slice.

## D65 scoped old-precache cleanup

- **Candidate runner:** `node apps/web/scripts/check-pwa-candidate.mjs review-artifacts/pwa-shell`
  — exit `0`.
- **PWA browser tests:** `3 passed`, `0 failed`, `0 skipped` (9.0 seconds).
  This includes boot/offline shell, SSR privacy, and activation cleanup.
- **Production precache:** `119 entries (3274.18 KiB)`.
- **Live input invariant:** passed; live source/config/public/test/runner/package
  inputs were unchanged by the candidate runner.
- **Unit regression:** `pnpm --filter @miyulabmd/web test` — exit `0`;
  `117 passed`, `0 failed`, `0 skipped`.
- **Diff whitespace check:** `git diff --check` — exit `0`.
- **Final candidate SHA-256:** `service-worker/sw.ts`
  `310c77e0f4dc9d789add804246b188db54ecebe8711d246ff7ab9a6b2c608c4d`.
  The other candidate hashes remain unchanged from the values recorded above.
- **Rationale verified:** The activation test removed the exact-scope obsolete
  `miyulabmd-precache-` cache and preserved the foreign, other-scope, and
  unrelated sentinels, then successfully reloaded the current shell offline.
- **Remaining review boundaries:** Same-origin navigation/redirect behavior,
  icon/typecheck review, and the separate dev data suite were not changed or
  claimed by this checkpoint.

## D66/D67 hardening checkpoint

- **Checkpoint:** `372103c`.
- **Candidate runner:** `node apps/web/scripts/check-pwa-candidate.mjs review-artifacts/pwa-shell`
-  — exit `0`; Biome, app/SW typecheck, production build, and all PWA checks
  completed successfully.
- **PWA browser regression:** `4 passed`, `0 failed`, `0 skipped` (8.5 seconds).
  This includes boot, SSR privacy, scoped cleanup, and foreign navigation/
  redirect preservation.
- **Production precache:** `119 entries (3274.18 KiB)`.
- **Live-input and candidate-byte invariant:** passed; the runner reported live
  inputs and candidate bytes unchanged.
- **Live unit regression:** `pnpm --filter @miyulabmd/web test` — exit `0`;
  `117 passed`, `0 failed`, `0 skipped` (12.7 seconds).
- **Whitespace check:** `git diff --check` — exit `0`.
- **Final changed candidate SHA-256:** `package.json`
  `3e1dee46174610fb6ba1941414bac77a9e87421b9aa706ca77e7a110e9d6bf66`;
  `service-worker/sw.ts`
  `e382cdc7a73c01973cb1f217cedf36f183339a32dfd3133a23fb97f16ba35a61`;
  `tsconfig.sw.json`
  `10a816b416489be05a6b7c501e4f763cd4875a664960808db8d4893f938ae4e6`.
- **Static script/inheritance verification:** package metadata and dependency
  groups are byte-equivalent to live; candidate `typecheck` is
  `tsc --noEmit && tsc --noEmit -p tsconfig.sw.json`; worker config extends
  `./tsconfig.json` and isolates `ES2022`/`WebWorker`, `types: []`, and worker
  include. The runner typechecks both configs but does not execute the
  candidate package script itself, so this records wiring truthfully rather
  than claiming normal-command adoption.
- **Change rationale:** Workbox `sameOrigin` is explicit defense-in-depth only;
  no foreign navigation exploit was reproduced. Redirects, non-success response
  preservation, shell fallback, and cache exclusions remain unchanged.
