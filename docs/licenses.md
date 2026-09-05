# ライセンス方針

MiyulabMD 本体は [GNU Affero General Public License v3.0 or later](../LICENSE)（`AGPL-3.0-or-later`）。

ホストした改変版にも、ネットワーク利用者へ対応するソースの提供を求める。公式のソースは <https://github.com/WakuwakuP/MiyulabMD>。

依存ライブラリの帰属は [THIRD_PARTY.md](../THIRD_PARTY.md)。許可 SPDX は [`scripts/check-licenses/policy.mjs`](../scripts/check-licenses/policy.mjs)。

## なぜ AGPL か

共同編集 Markdown はサーバで動く。MIT だけだと、改変して閉じたホストをする利用を止められない。HedgeDoc など同类プロダクトと同じく、公開した改変はソースも公開してほしい。

依存は寛容系（MIT / Apache-2.0 / ISC / BSD / CC-BY-4.0）なので、AGPL との組み合わせに問題はない。

## 本番依存の許可

`pnpm licenses:check` が本番ツリー（`pnpm licenses list --prod`）を見る。

許可する SPDX の例:

- MIT / ISC / Apache-2.0 / BSD-2-Clause / BSD-3-Clause
- CC-BY-4.0 / CC0-1.0 / 0BSD / Unlicense / BlueOak-1.0.0
- MPL-2.0 / OFL-1.1
- AGPL-3.0-or-later（このリポジトリ自身）

デュアルライセンスは、OR の一方が許可なら通す。AND は両方必要。

入れないもの:

- `@tiptap-pro/*` など商用スコープ
- BUSL / SSPL / Commons Clause / UNLICENSED
- 許可リストに無い GPL / LGPL（混入したらレビューする）

dev 専用のネイティブ（wrangler 経由の libvips など）は本番チェックの対象外。配布物に載せない。

## 新しい依存を足すとき

1. `package.json` の `license` と LICENSE 本文を確認する
2. `@tiptap-pro/*` や Commons Clause 付きは使わない
3. 許可に無い SPDX なら、互換と帰属を確認してから `ALLOWED_LICENSES` に足す
4. Apache-2.0 / BSD / CC-BY は [THIRD_PARTY.md](../THIRD_PARTY.md) の帰属を更新する

## ブランド

製品名・ロゴ・キャラクターは、公式 MiyulabMD としての再利用を許可しない。コードの AGPL とは別。
