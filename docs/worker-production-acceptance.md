# 実Workerのローカル本番成果物受け入れ

`offline-pwa-completion.md` の C11 に向けた **online seam の基盤**。
静的PWA fixtureとは別に、実際の Web production build、Worker、
認証、D1、R2、Durable Object、SSR を一つのローカル経路で検証する。
**C11全体の完了を意味しない**。

## 実行

リポジトリrootで Node.js 22以上、pnpm 10を使用する。

```sh
pnpm install --frozen-lockfile
pnpm --filter @miyulabmd/web test:browser:install
node apps/web/scripts/test-worker.mjs
```

依存関係とChromiumの初回取得にはネットワークが必要。
受け入れでは deploy、remote D1、Cloudflare login、実アカウント、
実secretは不要。既存の `test:pwa`、browser/unit suiteは変更しない。

特定testだけを実行する場合:

```sh
node apps/web/scripts/test-worker.mjs --grep "private note"
```

失敗時の終了コード、runtime削除、起動した2つのWorkerのlistener終了を検証する:

```sh
node --test apps/web/scripts/test-worker-lifecycle.test.mjs
```

このlifecycle testは実buildと実Worker起動後に意図的にtestを0件選択する。
内部のPlaywrightは `No tests found` / exit 1、外側のNode testは成功が期待値。

## 仕組みと安全境界

- `scripts/test-worker.mjs` が `.wrangler/acceptance/run-*` を毎回新規作成。
  Web成果物、Wrangler config、全D1 migration、D1/R2/DO state、
  Worker registry、ログ、テスト出力をこのディレクトリに閉じ込める。
  既存の `apps/web/dist` や開発DBを再利用・上書きしない。
- Vite本体configを継承し、出力先と `envDir` だけを変更。
  Worker本体configはlockfileで固定したWranglerの
  `experimental_readRawConfig` で読み、production asset routing、
  compatibility、DO migration、bindingを維持する。
- ローカル用変更は絶対source/migrationパス、runごとのWorker名、
  registry、ローカルD1 ID、`remote: false`、`DEV_AUTH=true`、
  空のAccess domain、`ALLOW_ANONYMOUS=false`、必要なsession secret宣言。
  OG_FETCHも実ローカルWorkerを独立した子プロセスで起動する。
- Workerは必ず `wrangler dev --local`、D1は必ず
  `wrangler d1 migrations apply DB --local --persist-to <run>/state`。
  ポートはloopbackの空きポートを使い、既存serverを再利用しない。
- 子プロセスへの環境変数はOS実行に必要なものだけをallowlist。
  Cloudflare credentials、proxy、`NODE_OPTIONS`、利用者のsecretは継承しない。
  Wranglerへ空の専用 `--env-file` を渡すため、利用者の `.dev.vars` や
  `.env` を読まない。Viteも専用 `envDir` を使用する。
- `SESSION_SECRET` はrun中に生成する乱数で、main Workerプロセスの
  environmentだけに渡す。config/引数/保存したsession stateに書かない。
  Wranglerはsecretをhidden表示する。trace、video、screenshotは無効。
- 成功・失敗・SIGINT/SIGTERMで自身の子プロセスだけを終了し、
  runディレクトリを削除する。Windowsは所有PIDへの `taskkill /T /F`、
  POSIXは専用process groupへTERM、必要ならKILL。全体に5分のdeadline。
  強制的な親process killやOS停止からの自動回収は保証しない。
- ブラウザの外部HTTP requestを遮断する。任意のGoogle Fontsは取得しない。
  API/auth/SSR/assetsのレスポンスをmock/fulfillするコードはない。
  OS全体のネットワークsandboxではないため、Wranglerのversion確認等まで
  「一切のネットワーク通信なし」とは主張しない。Workerから外部fetchする
  内容のノートはテストに入れていない。

## 検証する動作

1. 実 `/api/health`、guest `/api/me`、guest note作成401。
2. `/auth/login?email=...@example.test` の実フォームをブラウザがsubmitし、
   `/api/auth/establish` の302でHttpOnly cookieを発行。
   `/api/me` が実D1 userを返す。
3. 実APIでprivate noteを作成・取得。DOに到達する古いtask-checkbox更新が409。
4. 実画像upload APIからR2に保存し、取得bytesが一致する。
5. 認証cookieを持つJavaScript無効browserで `/n/<shortId>` を開き、
   serverのprivate/no-store、SSR本文、bootstrap、titleを確認。
6. 通常browserで同じnoteを開き、production JSとアプリUIを確認。
   実 `/ws/notes/<id>` でYjs sync step 1を送り、DOからreplyを得る。
7. 実logout後、userがnullとなり、private note/image APIが401、
   note SSRにprivate本文が含まれない。

## 初回実行記録と制約

Windows、Node v24.21.0、pnpm 10.14.0、Wrangler 4.129.0、
Chromium 153 / Playwright 1.63.0で実行。

- RED: server実装前のPlaywright testが
  `ECONNREFUSED 127.0.0.1:4199` で1件失敗。
- 最初のreal-auth runは実Google Fonts要求を外部通信禁止assertionで検出。
  optional fontだけを許容リストに入れつつ、要求自体は遮断してgreen。
- 長い `apps/web/node_modules/.cache/...` 以下のstateではDO RPC/WSが500。
  `.wrangler/acceptance/run-*` へ短縮後、RPC409とWS101/syncが成功。
  WindowsではSQLiteのpath長に注意し、checkout自体も短い場所を推奨。
  アプリsourceの修正、失敗testのskipは行っていない。
- `node apps/web/scripts/test-worker.mjs`: 2件成功。
  毎回9個のD1 migrationを新規適用し、終了時runtime削除。
- `node apps/web/scripts/test-worker.mjs --grep __intentional_no_matching_test__`:
  期待どおりexit 1、runtime削除。
- `node --test apps/web/scripts/test-worker-lifecycle.test.mjs`: 1件成功。
  意図的なbrowser失敗後のruntime不在と、両Workerのport閉鎖も確認。
- `pnpm test`: shared 22、markdown 21、web 117、worker 68、
  root scripts 22、合計250件成功。
- `pnpm --filter @miyulabmd/web test:pwa`: 既存8件成功。
- `pnpm typecheck`: 全workspace成功。
- `pnpm exec biome check apps/web/scripts/test-worker.mjs apps/web/scripts/test-worker-lifecycle.test.mjs apps/web/playwright.worker.config.ts apps/web/vite.worker-acceptance.config.ts apps/web/tests/worker/worker-online.spec.ts`:
  新規コード5ファイル成功。`git diff --check` も成功。

初回onlineテストはservice workerをblockして配信seamを独立させたため、offline再起動、
全URL種別/alias/`/s`、更新待機、複数タブ、user切替、cache削除、
Cloudflare Access本番JWT、HTTPS Secure cookie、実edge配信は未検証。
R2のoffline画像化やYjsの編集・再接続・永続化保証もこのsmokeの対象外。
macOS/Linuxのprocess-group終了は実装しているが、この初回記録では未実行。
将来のC11拡張はこの本物の経路を使い、static fixtureの成功を代替根拠にしない。

## 親の独立確認とoffline経路の追加

- `node apps/web/scripts/test-worker.mjs` を親が実行し、onlineの2件成功を確認。
- `worker-offline.spec.ts` を追加。こちらだけservice workerをallowし、実ログイン、
  private note作成、通常閲覧後、HTTP cacheを無効にしたままoffline reloadする。
  ナビゲーション応答はSWの純粋shellでprivate本文を含まず、Reactのcached readerが
  保存本文・キャッシュ説明を表示する。Editはなく、task checkboxはdisabled、
  offline reload後のWebSocket生成は0件。
- `node apps/web/scripts/test-worker.mjs --grep 'real private note reloads'`：
  親の実行で1件成功。現在はcanonical `/n/:id` のみで、短縮ID・`/s`・フォルダ・
  logout/purge・複数タブの全受け入れ完了とはしない。
- `node --test apps/web/scripts/test-worker-lifecycle.test.mjs`：
  親の独立実行でも1件成功。意図的な子test失敗後のruntime削除とport終了を確認。
- 新規offline specのBiome、runnerのBiome、`git diff --check`も成功。
