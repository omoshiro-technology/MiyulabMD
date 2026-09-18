# D52 Home metadata validation

Candidate validation was run serially from HEAD `84b4ad6` (the candidate remains
under review and no live `apps/web/src` files were edited).

1. `pnpm install --frozen-lockfile` — exit 0 (625 packages installed; required
   because `vite` was initially absent).
2. `pnpm --filter @miyulabmd/web test:browser:install` — exit 0.
3. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-drive-view.spec.ts` — exit 0,
   6/6 passed.
4. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` — exit 0,
   52/52 browser tests passed; candidate typecheck and Biome checks passed.
5. `pnpm --filter @miyulabmd/web test` — exit 0, 117/117 passed (live
   regression suite, not candidate unit proof).
6. `git diff --check` — run after this record is appended.

The initial browser command before installing Chromium exited 1 solely because
the Playwright executable was missing; it was not treated as a product failure.
The first post-install run was 5/6 because guest controls were hidden while the
public root was pending; the header ownership gate was corrected and the final
run is 6/6.

Candidate SHA-256 values from the final all-check run:

- `api.ts`: `3e7cdbde8d16e9f5bd70f4b214a01294829bf4fd0db131330e91e3902c241534`
- `offline-cache.ts`: `9b4835fb13e8b7aa209a5561e84f34a14b42e7e7a0b3912ebf041eeacade9b15`
- `src/lib/home-metadata-reader.ts`: `5efb0348f58ec36c0d49301ec34db77f54055709103501aaa7f6dd36e5da7c82`
- `src/pages/HomePage.tsx`: `93ccda2eed170b05238d2994bb0a0549019fe9400a63f019ee0e395de77b5d2e`

The candidate browser runner also reported the expected RED-to-green behavior:
online authenticated root and child snapshots were saved, and the offline
reload displayed the cached child and canonical root data without folder/note
API reads.

## D53 viewer-lifetime validation

Validation is recorded after the candidate-only change. Commands are run
serially from the repository root; exit codes and result counts are retained
here, along with the candidate hash.

### Commands and results

- `pnpm install --frozen-lockfile` — exit `0`; dependencies installed.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` — first run exit `1` because the Playwright Chromium executable was not installed; no test cases ran.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit `0`; Chromium and required browser support packages installed.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` — exit `0`; `7 passed`, `0 failed` in `8.4s`.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` — exit `0`; candidate check covered `16 files`, then `53 passed`, `0 failed` in `14.1s`.
- `pnpm --filter @miyulabmd/web test` — exit `0`; `117 passed`, `0 failed`, `0 skipped`.
- `git diff --check` — exit `0`.

Candidate `src/pages/HomePage.tsx` SHA256 after validation:
`6ed55396207a23917eb39fa70a801acee70a94b9f5ee4b2b93da9cbd143d8f51`.

The live `apps/web/src` tree has no diff (`git diff --quiet -- apps/web/src`
exit `0`). Only the allowed candidate Home file and the two allowed metadata
records are modified.

Final post-record verification: `git diff --check` exit `0`, live
`apps/web/src` diff check exit `0`, and the candidate Home SHA256 remained
`6ed55396207a23917eb39fa70a801acee70a94b9f5ee4b2b93da9cbd143d8f51`.

## D54 viewer snapshot validation

Validation was run serially from checkpoint `a02ddf2`, with no live source
changes and no commit or restore.

### Commands and results

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` — initial exit `1` because `vite` was missing (`ERR_MODULE_NOT_FOUND`).
- `pnpm install --frozen-lockfile` — exit `0`; 625 packages installed.
- The same targeted browser command — exit `1` because the Playwright Chromium executable was missing; no browser cases completed.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit `0`.
- The same targeted browser command — exit `0`; `8 passed`, `0 failed`.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` — exit `0`; 16 files checked, `54 passed`, `0 failed`.
- `pnpm --filter @miyulabmd/web test` — exit `0`; `117 passed`, `0 failed`, `0 skipped`.
- `git diff --check` — exit `0`.
- `git diff --quiet -- apps/web/src` — exit `0`; no live source edits.

The final candidate SHA-256 for
`src/lib/home-metadata-reader.ts` is
`35a5bee95addd05383266bd70d6ab1fafb38cc6e9845065a6eca59324bf704cf`.
The targeted D54 regression passed: mutating the caller's viewer during the
paused Alice request did not redirect the completed save into Bob's cache.

## D55 network mode gate validation

Validation was run serially from checkpoint `f591e37`. Only the candidate reader
and these two candidate records were changed; no commit or restore was made.

### Commands and exact results

- Initial targeted browser command — exit `1`; dependencies were missing
  (`ERR_MODULE_NOT_FOUND: vite`).
- `pnpm install --frozen-lockfile` — exit `0`; `625` packages installed.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit `0`; Chromium only.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` — exit `0`; `10 passed`, `0 failed`.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` — exit `0`; `16 files` checked and `56 passed`, `0 failed`.
- `pnpm --filter @miyulabmd/web test` — exit `0`; `117 passed`, `0 failed`, `0 skipped`.
- `git diff --check` — exit `0`.
- `git diff --quiet -- apps/web/src` — exit `0`; live `apps/web/src` is unchanged.

Final candidate SHA-256 for
`src/lib/home-metadata-reader.ts`:
`03b96c28238a35cc1548ddea7bcc477f7b2f8917424aeff3680c4ec8374ee39a`.

The two D55 RED cases are green: cached and unavailable viewers reject locally
with zero metadata requests and no fabricated HTTP status. Authenticated and
guest successful network reads remain green. This remains a candidate for parent
review and adoption, not a live source change.

## D56 storage warning UI validation

Validation was run serially from checkpoint `2b96d32`; no commit or restore was
made. The initial targeted browser command exited `1` because `vite` was absent,
so dependencies were installed before the required browser setup.

### Commands and exact results

1. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` —
   exit `1`; `ERR_MODULE_NOT_FOUND: vite`.
2. `pnpm install --frozen-lockfile` — exit `0`; `625` packages installed.
3. `pnpm --filter @miyulabmd/web test:browser:install` — exit `0`; Chromium
   (and Playwright's required FFmpeg/headless support packages) installed.
4. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` —
   exit `0`; `11 passed`, `0 failed`.
5. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` —
   exit `0`; `16 files` checked and `57 passed`, `0 failed`.
6. `pnpm --filter @miyulabmd/web test` — exit `0`; `117 passed`, `0 failed`,
   `0 skipped`.
7. `git diff --check` — exit `0`.
8. `git diff --quiet -- apps/web/src` — exit `0`; live `apps/web/src` is
   unchanged.

Final candidate SHA-256 for
`src/pages/HomePage.tsx`:
`2eac5e8bdfcecaccbb75dc90c57ec6ff3da5d885a7a3f35ee27814ea214db571`.

The D56 RED case is green: a failed cache save displays a `role="status"`
containing `キャッシュを保存できません`, while valid network notes and the
new-note control remain usable and cached-only wording is absent. A subsequent
reload after the injected fault is disabled clears the warning and saves the
root snapshot. Warning state is reset on each read and viewer remount, while
the next cancellation-boundary test remains out of scope.

## D57 metadata transaction cancellation reason validation

Validation was run serially from checkpoint `90f89dd`; no commit or restore was
made. Only candidate `offline-cache.ts` and the two allowed metadata records
were changed. The initial targeted browser command exited `1` because `vite`
was absent (`ERR_MODULE_NOT_FOUND`).

### Commands and exact results

1. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-folder-cache.spec.ts` —
   exit `1`; dependencies were missing.
2. `pnpm install --frozen-lockfile` — exit `0`; `625` packages installed.
3. `pnpm --filter @miyulabmd/web test:browser:install` — exit `0`; Chromium
   installed.
4. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-folder-cache.spec.ts` —
   exit `0`; `11 passed`, `0 failed`.
5. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` —
   exit `0`; `16 files` checked and `59 passed`, `0 failed`.
6. `pnpm --filter @miyulabmd/web test` — exit `0`; `117 passed`, `0 failed`,
   `0 skipped`.
7. `git diff --check` — exit `0`.
8. `git diff --quiet -- apps/web/src` — exit `0`; live `apps/web/src` is
   unchanged.

Candidate SHA-256 for `offline-cache.ts` after the D57 change:
`a60ebcb6df42d52f6678b0e79d7f1b0286ecec33374d886863b5b9e1803fa925`.

Both parent-provided D57 RED cases are green: cancelling a pending folder save
and cancelling a pending note-list save rejects with the exact custom
`AbortController` reason by identity and preserves the prior snapshot. The
candidate remains under parent review and is not adopted into live sources.

## D58 final-publication cancellation guard validation

Validation was run serially from checkpoint `366bc74`; no commit or restore was
made. Only candidate `src/lib/home-metadata-reader.ts` and the two allowed
candidate records were changed. Live sources remain unchanged.

### Commands and exact results

1. The initial targeted browser command — exit `1`; `ERR_MODULE_NOT_FOUND:
   vite`.
2. `pnpm install --frozen-lockfile` — exit `0`; `625` packages installed.
3. `pnpm --filter @miyulabmd/web test:browser:install` — exit `0`; Chromium
   installed.
4. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser home-metadata.spec.ts offline-drive-view.spec.ts` —
   exit `0`; `14 passed`, `0 failed`.
5. `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` —
   exit `0`; `16 files` checked, `60 passed`, `0 failed`.
6. `pnpm --filter @miyulabmd/web test` — exit `0`; `117 passed`, `0 failed`,
   `0 skipped`.
7. `git diff --check` — exit `0`.
8. `git diff --quiet -- apps/web/src` — exit `0`; live source unchanged.

Candidate SHA-256 for `src/lib/home-metadata-reader.ts` after D58:
`75bc316055ce4afaa8cba0c188a1f5b135dd5171bb3d6373b55e752ce86e27eb`.

The D58 cancellation-after-metadata-commit case rejects the custom reason by
identity while preserving the committed root/list snapshots. The live
`apps/web/src` tree has no changes (`git diff --quiet -- apps/web/src` exit
`0`). The guard is deliberately synchronous and final: it reuses the existing
ownership/cancellation check after the awaited save, adds no later await, and
does not roll back or delete committed snapshots.
