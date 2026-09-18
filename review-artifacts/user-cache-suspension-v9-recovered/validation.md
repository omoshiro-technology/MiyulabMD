# 回収したv9と後継修正の親検証

## P1 source validation status

P1で追加した公開ストレージロックのcoverage:

| 公開API群 | coverage |
| --- | --- |
| scope capture / viewer ID persist・read | global shared |
| cache handle methods（`getNoteListState`を含む） | global shared → user shared |
| orphan collection / user clear | global shared → user exclusive |
| device clear | global exclusive |
| 同期 lifecycle・order helper | lockなし |

source APIの型検査・lintと既存folder/image/quota semanticsは次のcandidate
runnerで確認する。browser tests、UI、prefetch、Service Workerへの反映は次slice。

## 最新：D30/D31の親レビュー・ライブ反映

候補セッションSHA256
`d79a9d8ff3a28b956a2f8fd9f7bd9ef59536585d88e8b13ccfc0c6c46a7f10a7`に対して、
親がcandidate runner `all`を再実行し、型チェック・Biome・32ブラウザが成功した。

先頭の候補コメント以外のbytesをそのままライブへ反映し、一致を確認した。
ライブセッションSHA256は
`b49748b4b9c42b11fc1b5ced350f6c91e21545e7515d12b6d7036d43c95e4dbb`。
通常のライブbrowserコマンドへ16specを指定して32件成功。
Web unit117件、Web型チェック、対象ファイルのBiome、diff-checkも親が確認した。

cached viewerのローカル読み取りと、HTTP statusを持たない
`OfflineNoteUnavailableError`を採用済み。以下は以前の経過であり、最新状態とは区別する。

## 完全bytesの確認

子worktreeの原典と、編集ツール経由で回収したファイルのハッシュが一致した。

```text
offline-cache.ts     515a9c378f86e65e6def3427074c32a423743d0058ffd1099ae8047637958fcd
note-read-session.ts 081bb2dbd02aedecf096b7f6cec7cfde13979a64e0cc2c00c23c1c363da260b7
```

## 親が回収後に実行した検証

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 1
candidate typecheck: passed
candidate Biome: passed
browser: 29 passed, 1 failed
```

既存29件はすべて成功し、native IDB未確定／complete境界の2件も成功した。
失敗は追加した `note-denial-entry-ordering.spec.ts` の1件。
DB接続失敗を伴う403の後でも、先行した200が成功を返してしまい、
`oldPublished=false` の期待に対しtrueとなる。

**本候補は未採用。** D26の後継修正と再検証が必要。
ライブの `apps/web/src/` はこの検証で変更していない。

## 元担当の報告（親の再実行とは区別）

- frozen install、専用Chromium install：exit0。
- 当時の既定29ブラウザ、候補型チェック・Biome：exit0。
- 単独の書き込みライフサイクル2件は成功したが、旧ランナーの不要な
  セッションmodule読込要求によりコマンド全体はexit1。ランナーはD24で修正済み。
- 既存ライブWeb unit：117 passed、exit0。
- cached diff-check：exit0。

当時の29件成功を、現在の追加テストを含む30件成功とは扱わない。

## D26修正後の検証

依存関係が未配置だったため、認可された frozen install を先に実行した。
Chromiumも指定されたWebパッケージのinstallコマンドだけで導入した。

```text
pnpm install --frozen-lockfile
exit 0
pnpm --filter @miyulabmd/web test:browser:install
exit 0
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser note-denial-entry-ordering.spec.ts
exit 0
1 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
candidate typecheck: passed
candidate Biome: passed
browser: 30 passed
git diff --check
exit 0
```

`all` の30件には既存29件と `note-denial-entry-ordering.spec.ts` を含む。
`pnpm --filter @miyulabmd/web test` はこの担当では再実行していないため、既存ライブ
Webの過去の根拠（117 passed、exit 0）とは区別する。

最終候補ファイルのSHA256（この記録追記後のコードファイル）:

```text
note-read-session.ts 8bc7b324065c126fc8590b1a1b2e8babbdff159add0e23329079e65d83fe5d73
offline-cache.ts    4a1f88f52bca0ab86f2d54b1f2f0398430e68367ed7189248fb445f61e94db4e
```

## D28修正の検証

変更は canonical `offline-cache.ts` の `denyNote()` に限定し、直接呼び出しで
共有同期拒否入口を使う分岐を追加した。以下をリポジトリルートから実行し、
結果をここへ追記する。

依存関係と指定ブラウザが未配置だったため、指定どおり先に導入した。

```text
pnpm install --frozen-lockfile
exit 0
pnpm --filter @miyulabmd/web test:browser:install
exit 0
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-direct-denial.spec.ts
exit 0
1 passed
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
candidate typecheck: passed
candidate Biome: passed
browser: 31 passed
pnpm --filter @miyulabmd/web test
exit 0
117 passed
git diff --check
exit 0
```

最終候補ファイルのSHA256:

```text
offline-cache.ts    f80be6ed11b8e16fd02a539c23c813602c7c2f69de0e6de9d4c89a3e9b8f9581
note-read-session.ts 8bc7b324065c126fc8590b1a1b2e8babbdff159add0e23329079e65d83fe5d73
```

## D28後の親による採用前検証

親が完全な候補のハッシュ一致を確認し、次を再実行した。

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
candidate typecheck: passed
candidate Biome: passed
browser: 31 passed
```

検証対象は保存層`f80be6ed11b8e16fd02a539c23c813602c7c2f69de0e6de9d4c89a3e9b8f9581`、
セッション`8bc7b324065c126fc8590b1a1b2e8babbdff159add0e23329079e65d83fe5d73`。
候補レビューを終え、D29に従いライブ基盤へ反映する。
画面・Service Worker・prefetchの完成を意味しない。

## D29：ライブソースへの反映後

親が、両ライブファイルは候補の先頭コメント1行を除く全bytesと一致することを確認した。
反映後のSHA256:

```text
apps/web/src/lib/offline-cache.ts f8c004b8d3ce250f23571b44efc136e1f36efe006b66ed42122e3fef861648d3
apps/web/src/lib/note-read-session.ts e6d112c9af925ca9a77f2aa6c78cc55471f43aafc3243f5d9a34bb7cfa582830
```

通常のライブソースを使うbrowserコマンドへ、候補ランナー既定の15specを指定して再実行：
31 passed、exit0。未接続の `offline-note-view.spec.ts` は対象外。
Web unit117件、Web型チェック、本番ビルド、ライブ2ファイルのBiome、diff-checkも親が成功を確認した。
ビルドには500kB超chunk警告があるが、ビルド自体は成功。

保存・読み取り基盤として採用済み。UIとService Workerの完成を示すものではない。

## D30/D31の候補検証（GPT-5.6-luna）

依存関係と指定ブラウザが未配置だったため、許可されたコマンドで導入した。

```text
pnpm install --frozen-lockfile
exit 0
pnpm --filter @miyulabmd/web test:browser:install
exit 0
```

実装後、指定されたcached viewerテストを先に実行した。

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser cached-viewer-note-read.spec.ts
exit 0
1 passed
```

最初の `all` 実行では候補の型判定が TypeScript 7 で曖昧になったため、
published resultの形を確認する型ガード `isPublishedReadResult()` を追加した。
これはcached-onlyの挙動や既存経路を変更せず、候補のBiome指摘も解消する。

最終コードでの検証:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
candidate typecheck: passed
candidate Biome: passed
browser: 32 passed
pnpm --filter @miyulabmd/web test
exit 0
117 passed
git diff --check
exit 0
```

最終SHA256（検証後）:

```text
review-artifacts/user-cache-suspension-v9-recovered/note-read-session.ts d79a9d8ff3a28b956a2f8fd9f7bd9ef59536585d88e8b13ccfc0c6c46a7f10a7
review-artifacts/user-cache-suspension-v9-recovered/offline-cache.ts    f80be6ed11b8e16fd02a539c23c813602c7c2f69de0e6de9d4c89a3e9b8f9581
apps/web/src/lib/note-read-session.ts                                   e6d112c9af925ca9a77f2aa6c78cc55471f43aafc3243f5d9a34bb7cfa582830
apps/web/src/lib/offline-cache.ts                                      f8c004b8d3ce250f23571b44efc136e1f36efe006b66ed42122e3fef861648d3
```

## D32 AppShell viewer-context candidate

The D32 decision and validation records are preserved in:

- [`app-shell-decisions.md`](app-shell-decisions.md)
- [`app-shell-validation.md`](app-shell-validation.md)
