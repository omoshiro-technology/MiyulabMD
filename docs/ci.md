# GitHub Actions CI セットアップ

このリポジトリの CI は 4 本。Lint / Test / ライセンス検査はシークレット不要。本番デプロイと週次アップグレードだけ GitHub / Cloudflare 側の設定が要る。

| ワークフロー | ファイル | 起動 | シークレット |
|---|---|---|---|
| Lint & Format | `.github/workflows/linter.yml` | `main` への push / PR | なし |
| Test | `.github/workflows/test.yml` | `main` への push / PR | なし |
| Deploy to Cloudflare | `.github/workflows/deploy-cloudflare.yml` | `apps/**` などの変更、または手動 | Environment `cloudflare-production` |
| Cursor Weekly Package Upgrade | `.github/workflows/cursor-weekly-package-upgrade.yml` | 日曜 22:53 UTC、または手動 | リポジトリシークレット |

ランナーは Ubuntu、Node.js 24、pnpm（`packageManager` と lockfile）。インストールは `pnpm install --frozen-lockfile`。

## 1. Lint / Test（追加設定なし）

Actions が有効ならそのまま動く。ローカルと同じコマンド。

```bash
pnpm install --frozen-lockfile
pnpm check            # Biome
pnpm licenses:check   # 本番依存の SPDX 許可リスト
pnpm test
```

`licenses:check` は Test ワークフローでも走る。許可 SPDX と禁止パッケージは [docs/licenses.md](licenses.md)。

## 2. Cloudflare デプロイ

フォークや別アカウントへ複製するときは、手元で対話スクリプトを使う。

```bash
pnpm setup:deploy
```

スクリプトは次を対話で進める。

1. `wrangler login`（ブラウザ OAuth）で一時トークンを取得する。SSH のみのときはデバイス認可。
2. D1 / R2 を作るか既存を使う。`wrangler.toml` は書き換えない
3. Zero Trust のチームドメインと `/auth*` の Access アプリを作り、`ACCESS_AUD` を Worker secret にする
4. 任意で Web ビルド、リモート D1 マイグレーション、初回デプロイ、`SESSION_SECRET`
5. GitHub Environment `cloudflare-production` に Secrets と Variables を入れる

Access と GitHub Actions は wrangler の OAuth スコープ外なので、権限を事前入力したトークン作成 URL を開き、発行した API トークンを貼る。OAuth トークンは期限切れになるため CI には入れない。

前提は Node.js 20+、pnpm、[GitHub CLI](https://cli.github.com/)。アカウント固有値は Environment に置くので、フォークは `wrangler.toml` を変えずに upstream を取り込める。

---

PR ではバンドル検証（dry-run）だけ。本番デプロイは `main` への push か `workflow_dispatch` のあと、Environment `cloudflare-production` で走る。

1. og-fetch と本体 Worker を dry-run
2. リモート D1 マイグレーション（バインディング名 `DB`）
3. `miyulabmd-og-fetch` をデプロイ
4. 本体 `miyulabmd` をデプロイ

og-fetch はカスタムドメインの same-zone `fetch` を避ける分離 Worker なので、同じジョブで両方出す。

### 2.1 GitHub Environment

1. **Settings → Environments → New environment**
2. 名前は `cloudflare-production`（ワークフローの `environment:` と一致させる）
3. 必要なら Required reviewers や Wait timer を付ける

このリポジトリでは Environment の Secrets / Variables に置いている。`wrangler.toml` はプレースホルダのまま共有する。デプロイジョブが Variables から `wrangler.deploy.toml` を生成する。

| 種類 | 名前 | 用途 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | wrangler の認証 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 対象アカウント |
| Variable | `D1_DATABASE_ID` | リモート D1（必須） |
| Variable | `ACCESS_TEAM_DOMAIN` | Zero Trust チームドメイン |
| Variable | `D1_DATABASE_NAME` | 任意。未設定なら `wrangler.toml` の名前 |
| Variable | `WORKER_NAME` | 任意。未設定なら `miyulabmd` |
| Variable | `OG_FETCH_WORKER_NAME` | 任意。未設定なら `miyulabmd-og-fetch` |
| Variable | `R2_BUCKET_NAME` | 任意。未設定なら `miyulabmd-images` |
| Variable | `CUSTOM_HOSTNAME` | 任意。カスタムドメイン |

### 2.2 Cloudflare API トークン

[API Tokens](https://dash.cloudflare.com/profile/api-tokens) で Custom token を作る。

| 権限 | アクセス |
|---|---|
| Account · Workers Scripts | Edit |
| Account · D1 | Edit |
| Account · Workers R2 Storage | Edit |
| Account · Account Settings | Read |
| Zone · Workers Routes | Edit（カスタムドメインを使う場合） |

Account Resources はこのアプリのアカウントに制限する。Zone Resources は `md.miyulab.dev` を載せるゾーンに制限する。

Account ID はダッシュボード右側、または `wrangler whoami`。

トークンと Account ID を Environment `cloudflare-production` の Secrets に、D1 ID とチームドメインを同じ Environment の Variables に入れる。リポジトリシークレットには置かない（本番デプロイジョブ以外から見えないようにするため）。

### 2.3 先に揃えておく Cloudflare リソース

ワークフローは既存リソースへデプロイする。初回は手元かダッシュボードで作る。

- Worker `miyulabmd` と `miyulabmd-og-fetch`（初回 `wrangler deploy` で作成可。名前は Variables で変更可）
- D1（Variables の `D1_DATABASE_ID`）
- R2 `miyulabmd-images`（名前は Variables で変更可）
- 本番シークレット: `wrangler secret put SESSION_SECRET` / `wrangler secret put ACCESS_AUD`
- Zero Trust Access アプリ（チームドメインは Variables の `ACCESS_TEAM_DOMAIN`、AUD は Worker secret）

カスタムドメインと Access はワークフローでは作らない。

### 2.4 動作確認

- PR: **Verify Worker bundle** が success、**Deploy production Worker** は skipped
- `main` merge: 両方 success。手動は Actions → Deploy to Cloudflare → Run workflow

## 3. 週次パッケージアップグレード

詳細は [.github/cursor/README.md](../.github/cursor/README.md)。セットアップだけここでも列挙する。

### 3.1 リポジトリシークレット / 変数

**Settings → Secrets and variables → Actions**

| 種類 | 名前 | 必須 | 用途 |
|---|---|---|---|
| Secret | `CURSOR_API_KEY` | 必須 | Cursor CLI |
| Secret | `GH_AW_GITHUB_TOKEN` | 任意 | bot PR から後続 workflow を起動する PAT |
| Variable | `CURSOR_AGENT_MODEL` | 任意 | Cursor のモデル ID |

`GH_AW_GITHUB_TOKEN` が無いと、作った PR で Lint / Test / Deploy の verify が動かないことがある（`GITHUB_TOKEN` で作った PR は同じリポジトリの workflow を起動しない）。

### 3.2 Actions の権限

**Settings → Actions → General → Workflow permissions**

- Read and write permissions
- **Allow GitHub Actions to create and approve pull requests** をオン

### 3.3 ラベル

週次 PR は次を付ける。無いと `gh pr create` が落ちる。

- `dependencies`
- `maintenance`
- `automated`

## 4. このリポジトリで設定済みのもの

| 場所 | 名前 |
|---|---|
| Environment `cloudflare-production` Secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Environment `cloudflare-production` Variables | `D1_DATABASE_ID`, `ACCESS_TEAM_DOMAIN`（ほか任意） |
| Repository secrets | `CURSOR_API_KEY`, `GH_AW_GITHUB_TOKEN` |
| Repository variables | `CURSOR_AGENT_MODEL` |
| Labels | `dependencies`, `maintenance`, `automated` |

フォークや別アカウントへ複製するときは `pnpm setup:deploy` で 1〜3 を同じ名前で入れ直す。ワークフロー YAML の変更は不要。
