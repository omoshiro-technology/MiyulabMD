# D47 validation

The RED browser test was run through the candidate runner after installing the
worktree Chromium browser.

- `browser offline-drive-view.spec.ts`: **1 passed**, exit **0**
- `all`: browser passed, but candidate lint exited **1** on formatting/style
  diagnostics; no fixes were applied by the runner.
- Live application tests were not run in this slice.

The browser runner verified the candidate without modifying candidate or live
source files. The candidate runner's SHA-256 lines are retained in the
validation transcript. Remaining limitation: this candidate is a focused
cached-view implementation and needs the normal online HomePage behavior
merged around it before adoption.

## D48 repair

The repair files are being staged as candidate-only sources. Validation of the
new reader and cached view is pending completion of the full HomePage candidate
replacement; D47's browser result must not be treated as D48 evidence.

## D48 validation

The candidate was repaired in place with the complete network HomePage baseline
preserved. Validation commands and their exact exits are recorded below after
the implementation:

- `browser offline-drive-view.spec.ts`: exit **0**, **3 passed**
- `all`: exit **0**, **47 passed**
- live web unit suite: exit **0**, **117 passed**
- `git diff --check`: exit **0**

The candidate runner reported no Biome diagnostics and successful typecheck. It
did not write candidate or live source files. The live `apps/web/src` tree was
checked separately and remains unchanged; final SHA-256 values are reported by
the implementing agent alongside this record.

## D49 validation

Commands were run serially from parent checkpoint `910d755`:

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-drive-view.spec.ts`
  initially exited **1** because dependencies were absent.
- `pnpm install --frozen-lockfile` exited **0**; packages installed: **625**.
- The same browser command exited **1** before browser installation because
  Playwright's Chromium headless executable was absent.
- `pnpm --filter @miyulabmd/web test:browser:install` exited **0**.
- The browser command then exited **0**: **4 passed**.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  exited **0**: **48 passed**; candidate typecheck and Biome checks passed
  (`Checked 15 files ... No fixes applied.`).
- `pnpm --filter @miyulabmd/web test` exited **0**: **117 passed**, **0 failed**.
- `git diff --check` exited **0**.

The focused suspension regression passed, including the native IndexedDB
ordering where the folder transaction completes before the list callback and
the user is suspended in between. Candidate SHA-256 changes relative to
`910d755` were:

| File | `910d755` | after D49 code edit |
| --- | --- | --- |
| `src/lib/cached-drive-reader.ts` | `a6ad7f588d71bc5666328a5e7ff468ecc8a5139f5c0aa553676aa756ac9fc326` | `2248e1ada26df30abe3bd42736c67c02c74131eb540cc6e93982497718312da1` |
| `src/pages/HomePage.tsx` | `3ac8f75645c2a1df94d6220a489423f1fbe95007c93ce3ba672a16baedfa9d33` | `4afdca6bd28aa7f3adf6cb77eca3460785923f97e7336090eebbbd5a121acd72` |

The two dedicated records were unchanged before this append; their
post-append hashes are recorded by the parent review after this entry is
written. No live source files were adopted or modified.

## D50 validation

Commands were run serially from `cb9203d` in the candidate worktree:

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-drive-view.spec.ts offline-folder-cache.spec.ts`
  first exited **1** because dependencies were absent.
- `pnpm install --frozen-lockfile` exited **0**; **625** packages were installed.
- The focused browser command then exited **1** because Chromium was absent.
- `pnpm --filter @miyulabmd/web test:browser:install` exited **0** (Chromium
  only).
- The focused browser command exited **0**: **7 passed**.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  first exited **1** on three Biome diagnostics; no fixes were applied.
- After the formatting and complexity corrections, the same `all` command
  exited **0**: **49 passed**; typecheck and Biome checked **15 files** with
  no fixes applied.
- `pnpm --filter @miyulabmd/web test` exited **0**: **117 passed**, **0
  failed**.
- `git diff --check` exited **0**.

Final SHA-256 values after this append:

| File | SHA-256 |
| --- | --- |
| `offline-cache.ts` | `57d2ca3616470279af1b7cea353fcc15a9d87dfe65251e9487e1825ebc16644d` |
| `src/pages/CachedDriveView.tsx` | `6de3791a57fd05b62ac3183bdadf3e5a6e196b7f254332e6e20f4f863ffe20ea` |
| `drive-offline-decisions.md` | `5483152e90da334f6c71d91d730c539456dc4712e167508f01fd0c80c37652a4` |
| `drive-offline-validation.md` | `697f75142cf6fc74462917a79dabb263a4e4b681e89a3b7189edbd7e6e0e055f` |

The live files remained unchanged: `apps/web/src/lib/offline-cache.ts`
SHA-256 `f8c004b8d3ce250f23571b44efc136e1f36efe006b66ed42122e3fef861648d3`
and `apps/web/src/pages/CachedDriveView.tsx` SHA-256
`beddfd7ae56483f82e551e9b6757da44f15e9e574ab7c1f828f3c0ce259cf4b1`.

Because this validation entry itself changes its document hash, the final
post-entry hashes are corrected here: `drive-offline-decisions.md`
`439f358a47343ae43b25cb2a0123bbd11bfcd6a7260518f662473e734d3c40e0` and
`drive-offline-validation.md`
`8437ebceb78099bdeda4515ac6a3d28864d32c11771d4760aeee0528971f08df`.

## D51 validation

Commands were run serially from `HEAD 882b786` in the candidate worktree:

- The focused candidate browser command initially exited **1** because
  dependencies were absent (`ERR_MODULE_NOT_FOUND: vite`).
- `pnpm install --frozen-lockfile` exited **0**; **625** packages installed.
- `pnpm --filter @miyulabmd/web test:browser:install` exited **0**; Chromium
  and its Playwright support binaries were installed.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-folder-cache.spec.ts offline-drive-view.spec.ts`
  exited **0**: **9 passed**, including both D51 failed-root-replacement cases.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  exited **0**: **51 passed**; candidate typecheck and Biome checks covered
  **15 files** with no fixes applied.
- `pnpm --filter @miyulabmd/web test` exited **0**: **117 passed**, **0 failed**.
- `git diff --check` exited **0**.

The candidate `offline-cache.ts` SHA-256 after the code edit and before this
append was
`55f148026381a0d91c5bc6cff35f1ac04d626c9fcc78826e288cd03397da8634`.
The live `apps/web/src/lib/offline-cache.ts` remained unchanged at
`f8c004b8d3ce250f23571b44efc136e1f36efe006b66ed42122e3fef861648d3`.
Only the permitted candidate source and the two append-only review records
were modified.
