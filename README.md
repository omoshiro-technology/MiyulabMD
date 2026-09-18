# MiyulabMD

共同編集できる Markdown エディタ。Cloudflare Workers / Durable Objects / R2 / Zero Trust 上でホストし、MCP からもノートを編集できる。

設計の詳細は [docs/design.md](docs/design.md) を参照。エージェント向けのコードグラフは [docs/code-graph.md](docs/code-graph.md)。

```
apps/web          フロント（React + Vite + CodeMirror 予定）
apps/worker       fetch 分岐 + Elysia (REST / MCP) / Durable Objects
packages/shared   権限モデルと共有型
docs/design.md    設計書
```

## 開発環境セットアップ

前提: Node.js 24+（portless の必須要件）、pnpm 10（`corepack enable` 推奨）。

```bash
# 1. 依存関係
pnpm install

# 2. Worker 用ローカル設定（ローカルログインには必須）
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# .dev.vars の SESSION_SECRET をローカル専用のランダムな値に変更する

# 3. ローカル D1 にマイグレーション（リモート database_id は不要）
pnpm db:migrate

# 4. 動作確認
pnpm dev
# ブラウザで http://miyulabmd.localhost を開く
# http://miyulabmd.localhost/api/health => {"ok":true}
```

`wrangler.toml` の `database_id` はプレースホルダのままでよい。`wrangler d1 ... --local` と `wrangler dev` はローカル SQLite を使う。アカウント固有の D1 ID や Access チームドメインは GitHub Actions の Variables に置く。

ローカルでは `.dev.vars` の `DEV_AUTH=true` により `/auth/login?email=...` でモックログインできる。本番の `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `SESSION_SECRET` は Environment と Worker secret で渡す。

`.dev.vars` がない場合、サーバーと `/api/health` は動くが、`wrangler.toml` の `DEV_AUTH=false` が使われるためローカルログインは無効になる。PowerShell では `Copy-Item apps/worker/.dev.vars.example apps/worker/.dev.vars` で作成できる（既存ファイルは上書きしないこと）。`DEV_AUTH=true` と `SESSION_SECRET` を設定し、`ACCESS_AUD` は設定しない。設定後は Worker を再起動する。Web 側の `/api/auth/config` が `{"access":false,"mock":true}` なら、アカウントメニューにメールアドレス入力が表示される。

## ローカル開発の起動

リポジトリルートで **`pnpm dev` の 1 コマンド**で起動する。portless のプロキシを準備してから、mprocs が Web と Worker を同時に起動する。どちらもプロジェクトの開発依存なのでグローバルインストールは不要。

| プロセス | 単独起動コマンド | URL（標準設定） |
| ---------- | ----------------- | --------------------- |
| Web (Vite) | `pnpm dev:web` | http://miyulabmd.localhost |
| Worker | `pnpm dev:worker` | http://worker.miyulabmd.localhost |

mprocs は左の一覧に `web` / `worker`、右に選択したプロセスのログを表示する。プロセス一覧にフォーカスした状態で ↑/↓ で選択、`r` で再起動、`x` で停止、`s` で開始、`q` で両方を終了する。Ctrl+A でログ側とフォーカスを切り替える。キー操作は画面下部にも表示される。Windows ではプロファイルを読み込まない `cmd.exe /d` を使い、個人の PowerShell 起動処理を実行しない。

標準は **HTTP / 80 番ポート / ループバックのみ**で、URL にポート番号を書く必要はない。共通の `scripts/portless.mjs` が同時起動・単独起動に同じ設定を適用する。OpenSSL のインストールや証明書の信頼登録は不要で、hosts ファイルも自動変更しない。macOS / Linux では標準ポートの利用に portless が sudo による昇格を求める場合がある。Chrome / Edge / Firefox で開くこと。OS の DNS に依存する curl 等では、例えば `curl --resolve miyulabmd.localhost:80:127.0.0.1 http://miyulabmd.localhost/api/health` を使う。

HTTPS が必要な場合だけ、OpenSSL と証明書の信頼登録を準備し、`PORTLESS_HTTPS=1` を環境変数に設定して起動する（PowerShell なら `$env:PORTLESS_HTTPS="1"; pnpm dev`）。この場合は標準の 443 番を使い、URL は `https://miyulabmd.localhost` になる。80 / 443 番が別のサービスで使用中、または昇格を避けたい場合は `PORTLESS_PORT` を指定できるが、その場合は URL にポート番号が必要になる。

以前の 1355 番設定など、既存の共有プロキシと設定が異なる場合は、起動中の Web / Worker を終了し、他のプロジェクトが使っていないことを確認して `pnpm exec portless proxy stop` で停止してから `pnpm dev` を起動する。環境変数に `PORTLESS_PORT` を設定している場合はそれが優先されるため、標準ポートに戻すには解除する。実際の URL は起動ログを参照。

Vite は `/api` `/auth` `/mcp` `/openapi.json` `/ws` を portless 経由で Worker にプロキシする。ブラウザでは Web 側の URL を使うことでログインと WebSocket を同一オリジンに保つ。バックエンドのポートは portless が割り当て、Worker にも `PORT` を渡すため、5173 / 8787 の空きを気にする必要はない。

Worker 単体で API だけ試す場合は `pnpm dev:worker` のみでよい。OG 取得用 Worker も従来どおり Wrangler の multi-worker 構成で起動する。`apps/web/dist` が無い場合も `predev` が空ディレクトリを作るため起動できる（本番相当の静的配信は `pnpm --filter @miyulabmd/web build` 後）。

URL はこのリポジトリ用の固定名。同じチェックアウトで `pnpm dev` と単独起動を重ねないこと。終了後も portless の共有プロキシは残る。他のプロジェクトでも使っていない場合のみ `pnpm exec portless proxy stop` で停止できる。

## ブラウザテスト

既存の Node.js テストとは別に、Playwright Test で実際の IndexedDB / OPFS と、キャッシュ閲覧・自動先読みの画面連携を検証する。

```bash
# pnpm install 後、初回または Playwright 更新時に実行
pnpm --filter @miyulabmd/web test:browser:install

pnpm --filter @miyulabmd/web test:browser
# 個別のテストだけ実行する場合
pnpm --filter @miyulabmd/web test:browser storage-platform.spec.ts
# 本番ビルドの Service Worker・オフライン起動を検証する場合
pnpm --filter @miyulabmd/web test:pwa
```

両コマンドは `apps/web/scripts/playwright.mjs` を通し、専用 Chromium を `apps/web/node_modules/.cache/playwright/` に保存・参照する。共有ブラウザキャッシュを使用せず、自動 GC も無効にする。通常の Chrome / Edge や他プロジェクトのブラウザに影響させないため、直接 `playwright install` を実行せず上記コマンドを使う。新しい worktree ではブラウザを別途インストールする。

`test:browser` は `127.0.0.1:4174` で専用の Vite サーバーを自動起動・終了する。起動済みの別サーバーは再利用しない。ストレージの基盤テストは専用ページ、画面テストは実際のアプリとAPI fixtureを使い、Worker や実ログインを必要としない。

`test:pwa` は本番ビルド後、`127.0.0.1:4175` の専用previewサーバーで、HTTP cacheに依存しないオフライン起動、SSR HTMLを保存しないこと、キャッシュ整理と更新待機などを検証する。SSR応答はテスト用HTTP fixtureであり、実際のCloudflare配信・認証・エッジキャッシュの検証を代替しない。開発用ViteではService Workerを登録しない。

各テストは独立したブラウザコンテキストで実行する。失敗時のトレース等は `apps/web/test-results/` に保存され、Git 管理外となる。CI でブラウザテストを実行する場合も、専用ブラウザのインストールを先に行う。

### オフライン実装候補のレビュー

未採用の実装は、候補ディレクトリ内の `offline-cache.ts`、`note-read-session.ts` を直接編集して検証できる。同じディレクトリの追加 `.ts` ファイルも `src/lib/` の候補として扱う。

UIの候補は、候補ディレクトリ配下の `src/` に実装と同じ階層の `.ts` / `.tsx` を置く
（例：`src/components/layout/AppShell.tsx`）。同じ実装パスを指す候補の重複はエラーにする。

```bash
# リポジトリのルートで実行。候補ファイルはこのディレクトリ自体に保持する。
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/offline-candidate all
# 個別の検証
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/offline-candidate browser user-cache-suspension.spec.ts
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/offline-candidate typecheck
```

このランナーは実装用の `src/` を変更・復元しない。ブラウザ検証は候補を Vite の読み込み時に差し替え、型チェックは候補と同じ内容を検証専用ツリーへ配置して行う。候補への書き戻しは行わず、検証前後で候補と元ソースが変わっていないことを確認する。候補の SHA-256 を出力するので、検証結果と併せて記録する。ブラウザは専用キャッシュを使用し、Vite は空きポートで起動する。検証専用ツリーは `apps/web/node_modules/.cache/offline-candidate/` 配下に作成し、終了時に削除する。

`all` は候補の型チェック・Biomeと、ランナーに明示した基盤・画面テストを実行する。新しいspecはデフォルト一覧にも登録する。既存ユニットテストは別途実行する。レビュー完了までは候補ファイルを正本として保持し、実装用ファイルから候補へコピーし直さない。

### 現在のオフライン対応範囲

本番ビルドは共通の起動用資産を保存し、保存済みのノート・フォルダを閲覧専用で表示する。認証済みのアプリ起動時には、自分のMyDriveのフォルダとノート本文を順次先読みする。認証済み状態が維持されていれば、通信復帰・画面への復帰時、表示中の5分ごとの定期確認、同じ画面内のノート・フォルダAPI更新成功後に再確認を試み、短時間の重複通知をまとめる。非表示中の定期通知は省略する。通常の画面表示・編集は維持し、共有されているだけの他人のノート本文は自動先読みしない。ブラウザの保存容量や通信状況によって取得・保持できない項目があるため、全件保存やバックアップを保証しない。

同じユーザーの背景先読みはWeb Locksでタブ間排他し、別タブが取得中ならその試行を省略する。Web Locksを利用できない環境では、背景先読みだけを省略し、通常閲覧とそのキャッシュ保存は維持する。

認証済みのEditor読み取りと背景先読みは、同じページ内・同じ利用者・同じ要求IDの進行中ノートGETを共有する。各呼び出しの中断と結果は独立し、拒否世代が変わった後の読み取りは古い取得へ参加しない。完了済みのHTTP応答を保持するキャッシュではない。

キャッシュ専用・利用者未確認モードでは、通信復帰や画面への復帰時にサーバーへ利用者を確認し直す。確認中はキャッシュの閲覧専用表示を維持し、保存済みIDだけで認証済みに切り替えない。別ユーザーと確認された場合は元ユーザーの表示を除外する。確認結果が同じキャッシュ利用者のままなら、選択中の文字などの閲覧状態も維持する。

Yjsのサーバー保存確認後の通知、別タブの変更・認証変更検出、一覧・フォルダ・ホバー時の旧取得経路の統合、別名URL対応、添付画像、容量回収、フォルダHTTP拒否の接続などは継続実装中。既に認証済み・ゲストの画面を今回の復帰処理で再確認するものではない。仕様と実装済み範囲は区別し、最新の判断・検証は [意思決定台帳](docs/offline-pwa-decisions.md) を参照する。

## CI / デプロイ

フォークや別アカウントでは、手元から対話スクリプトで Cloudflare（Access / Worker / D1 / R2）と GitHub Actions の Secrets / Variables を揃えられる。`wrangler.toml` は共通のままなので、upstream への追従でコンフリクトしにくい。

```bash
pnpm setup:deploy
```

`wrangler login` でブラウザ認証し、セットアップ用の一時トークンを取得する。詳細は [docs/ci.md](docs/ci.md)。`main` への merge で Worker（本体 + og-fetch）をデプロイする。

## ライセンス

Copyright (C) 2026 Naoki Fujisawa (WakuwakuP)

GNU Affero General Public License v3.0 or later。[LICENSE](LICENSE) を参照。方針は [docs/licenses.md](docs/licenses.md)、第三者の帰属は [THIRD_PARTY.md](THIRD_PARTY.md)。

ホストした改変版は、ネットワーク利用者へ対応するソースを提供すること（AGPL §13）。公式ソースは <https://github.com/WakuwakuP/MiyulabMD>。製品名・ロゴ・キャラクターは公式としての再利用を許可しない。

本番依存のライセンスは `pnpm licenses:check` で検証する。
