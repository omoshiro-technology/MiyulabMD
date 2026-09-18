# D32 AppShell viewer-context candidate validation

## 親によるライブ採用確認

D34補修後の候補に対して親がrunner `all`を実行し、型チェック・Biome・34ブラウザが成功した。
ライブ2ファイルへ反映し、候補と全bytesが一致することを確認した。

```text
AppShell.tsx 35e12ccf2834601f960cce89e9ee4e918b630298391883ce23d1f02e5e8d25da
AppShellContext.ts 0ff5b9d61b118865cde5859b5557eab56c21e76eeafdf2d3d680e47d78de2915
```

通常のライブブラウザコマンドに17specを指定して34件成功。
Web unit117件、型チェック、Webビルド、対象ファイルのBiome、diff-checkも親が成功を確認した。
ビルドは500kB超chunk警告があるが成功。AppShell fixtureでは補助APIのarticle-sourcesも
境界でstubし、ローカルWorker稼働を不要にした。

AppShellのviewer context接続は採用済み。ノート画面の永続読込・更新gate接続とは別の段階。
以下は担当の検証経過として保持する。

## Final run record

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser app-shell-viewer.spec.ts`
  exited `0`: `1 passed`.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  exited `0`: candidate lint/typecheck and `33 passed`.
- `pnpm --filter @miyulabmd/web test` exited `0`: `117 passed`.
- `git diff --check` exited `0`.

The first runner attempts were blocked by missing dependencies and then by the
Playwright browser executable; locked dependency installation and the
authorized `pnpm --filter @miyulabmd/web test:browser:install` resolved those
environment issues. A concurrent `all` attempt also hit a temporary Vite port
collision; the serial rerun above passed.

## Final candidate file hashes

- `src/components/layout/AppShell.tsx`: `2211578ab5cd6dc9226c0b9a8c06157a95d6fae03f9392dd95c65802c1b92f0a`
- `src/components/layout/AppShellContext.ts`:
  `0ff5b9d61b118865cde5859b5557eab56c21e76eeafdf2d3d680e47d78de2915`

## Status

Candidate implementation complete; parent review and adoption remain pending.

## D34 validation

Validation was run after the stale-response guard was added:

- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser app-shell-viewer.spec.ts`
  exited `0`: `2 passed`.
- `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all`
  exited `0`: candidate typecheck/Biome and `34 passed`.
- `pnpm --filter @miyulabmd/web test` exited `0`: `117 passed`.
- `git diff --check` exited `0`.

The candidate `AppShell.tsx` hash after this change is recorded in the final
report; the live `AppShell.tsx` and `AppShellContext.ts` hashes remain
unchanged as required.
