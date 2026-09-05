# 第三者ライセンス

MiyulabMD 本体は [AGPL-3.0-or-later](LICENSE)。このファイルは、帰属が必要、または MIT 以外の第三者成果物をまとめる。

本番依存の全件は `pnpm licenses list --prod`。許可 SPDX は [`scripts/check-licenses/policy.mjs`](scripts/check-licenses/policy.mjs)。方針は [docs/licenses.md](docs/licenses.md)。

## ブランド

製品名・ロゴ・キャラクターは公式としての利用を許可しない。フォークや再ホストでは、別名称・別アイコンを使う。

## npm（直接依存・本番）

ワークスペース内部（`@miyulabmd/*`）は本体と同じ AGPL。

### Apache-2.0

NOTICE / ライセンス文言の保持が必要。

| パッケージ | 用途 |
|---|---|
| [fast-diff](https://github.com/jhchen/fast-diff) | 差分計算（web / worker） |

### BSD-3-Clause

再配布時の帰属が必要。

| パッケージ | 用途 |
|---|---|
| [highlight.js](https://github.com/highlightjs/highlight.js) | コードハイライト（クライアント）。SSR は `rehype-highlight` 経由 |

### ISC

| パッケージ | 用途 |
|---|---|
| [github-slugger](https://github.com/Flet/github-slugger) | 見出し slug |
| [lucide-react](https://github.com/lucide-icons/lucide) | UI アイコン。一部は Feather（MIT, Cole Bemis）由来 |
| [yaml](https://github.com/eemeli/yaml) | frontmatter |

### MIT

その他の直接本番依存。代表例:

- CodeMirror 6（`codemirror`, `@codemirror/*`, `@lezer/highlight`）
- Tiptap 3（`@tiptap/*`。`@tiptap-pro/*` は使わない）
- React / React DOM / React Router
- Yjs（`yjs`, `y-websocket`, `y-codemirror.next`, `y-protocols`, `lib0`）
- remark / rehype 一式
- Elysia, jose, zod, `agents`, `@modelcontextprotocol/server`

## フォント（CDN）

リポジトリにフォントファイルは置いていない。Google Fonts から読み込む。どちらも SIL Open Font License 1.1。セルフホストするときは OFL 全文と Reserved Font Name に従う。

| フォント | ライセンス | 使い方 |
|---|---|---|
| [M PLUS 2](https://fonts.google.com/specimen/M+PLUS+2) | OFL-1.1 | 本文（`apps/web/index.html`） |
| [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) | OFL-1.1 | 等幅（`--font-mono`） |

## シンタックスハイライト色

`apps/web/src/styles/syntax-tokens.css` は Atom One Light / One Dark の色に寄せた再実装。公式 CSS の丸コピーではない。

- Atom One 元テーマ: MIT（Daniel Gamage / atom `one-*-syntax`）
- highlight.js 同梱テーマ: BSD-3-Clause
