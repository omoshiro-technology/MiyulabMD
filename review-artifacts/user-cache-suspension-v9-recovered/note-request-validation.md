# D101 候補検証

## 実施予定／結果

- `note-request-sharing.spec.ts`：背景の保留中 GET と keyboard navigation の
  Editor read が同じ authenticated viewer scope の進行中 request を共有し、
  HTTP note GET が 1 回、通常の network body／Edit が成立することを確認する。
- `note-read-session.spec.ts`：authenticated viewer の captured user ID だけを
  helper に渡し、cached viewer は渡さないことを確認する。
- `mydrive-prefetch.spec.ts`：prefetch が開始時に捕捉した user ID を helper に
  渡すことを確認する。
- 候補全体：`check-offline-candidate.mjs ... all`（期待 86 件）。
- live unit：117 件（候補 runner の対象外）。
- Biome／diffcheck：候補ファイルと許可された scope のみを確認する。

親の採用前に subscriber 単独中断、全員中断、結果値の独立性、settled cleanup
の追加テストを行う。これは最初の D101 slice であり、folder/list、legacy hover、
cross-tab HTTP sharing の完了を意味しない。

## D103 検証

- 対象変更：`src/lib/note-request.ts` のみ。失敗結果 container を subscriber
  ごとに複製し、成功値のコピー例外を該当 subscriber の reject として処理した。
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser note-request-subscribers.spec.ts note-request-sharing.spec.ts note-denial-entry-ordering.spec.ts note-denial-ordering.spec.ts --workers=1`
  は 8 passed、0 failed。候補 `src/lib/note-request.ts` の SHA-256 は
  `98e595229a40ef5a20376b86bbb972ee6d85133e01dbac6664106c7254f005e3`。
- 候補全体は `check-offline-candidate.mjs ... all` で 90 件、live unit は 117 件を
  期待値とする。Biome／diffcheck は許可された候補 scope のみを対象にする。
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  は candidate 20 files checked、90 passed、0 failed。`pnpm --filter
  @miyulabmd/web test` は 117 passed、0 failed。`pnpm exec biome check
  review-artifacts/user-cache-suspension-v9-recovered/src/lib/note-request.ts
  review-artifacts/user-cache-suspension-v9-recovered/note-request-decisions.md
  review-artifacts/user-cache-suspension-v9-recovered/note-request-validation.md`
  は 1 file checked、問題なし。`git diff --check` も成功した。
- この候補結果は親の独立レビューと採用判断を要する。ライブ採用および全体の
  request coalescing 完了を意味しない。

## D104 検証

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser note-request-sharing.spec.ts note-request-subscribers.spec.ts note-denial-entry-ordering.spec.ts note-denial-ordering.spec.ts`
  は 9 passed、0 failed。拒否後の新しい read が古い transport に join せず、
  fresh 403 を受ける回帰試験を含む。
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  は 21 files checked、91 passed、0 failed。`pnpm --filter
  @miyulabmd/web test` は 117 passed、0 failed。
- 変更候補の SHA-256 は `offline-cache.ts`:
  `32a627531733c729c4187093be54814b200bc0585d07551f99cabb2847061c90`、
  `src/lib/note-access-order.ts`:
  `d3d0fdbeecc1403073247428ed50b258fbb0bd24204a7ffd4226f6b3b38b55df`、
  `src/lib/note-request.ts`:
  `33635880d359d1286a6dfc2cd947424b5e4e5c2c5952b0222efe925cb6c3aded`。
- Biome と `git diff --check` は、許可された候補 scope の確認として実行する。
- 結果は親の独立レビューと採用判断を要する。ライブ採用、全体の request
  coalescing 完了、cross-tab 拒否同期を意味しない。
