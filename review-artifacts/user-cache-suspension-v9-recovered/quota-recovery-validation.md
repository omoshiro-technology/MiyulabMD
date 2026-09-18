# quota recovery の検証記録

## 対象

`apps/web/src/lib/storage-write-recovery.ts`、`attached-images.ts`、
`mydrive-prefetch.ts` と候補 `src/lib/` の3 mappingは byte 一致を確認した。
`apps/web/tests/browser/prefetch-quota.spec.ts` は本文 quota、本文から画像へ共有
される予算、共有 foreground、abort、画像 quota の6 focused caseを含む。

## 親から引き継いだ成功結果

- candidate quota focused：5件 GREEN。
- candidate quota + image regression：20件 GREEN。
- 本文 recovery 成功後の後続画像 quota は、同じ recovery instance では二回目の
  GC/retry を行わず storage stop になることを追加テストで固定した（live未実行）。
  `createWritable` の writes は本文 quota、本文 retry、画像 quota の3回で止まり、
  4回目の画像 retry writeがないことを assertion する。GC invocation自体の専用DIは
  製品APIへ追加せず、`attempted` クロージャの共有とこの write回数を観測根拠とした。
- candidate typecheck/lint：GREEN。
- live typecheck／対象 lint：GREEN。
- live focused browser：外部中断。10件成功時点までで、20件全体の完走結果ではない。

## この環境での再実行

`pnpm --filter @miyulabmd/web test:browser tests/browser/prefetch-quota.spec.ts`
は **FAIL（0 tests executed）**。`@playwright/test` が未導入で、
`node_modules` が存在しないため起動前に `ERR_MODULE_NOT_FOUND` となった。
このエラーを成功件数へ算入していない。

## 未確認

この環境では依存未導入のため、Web unit、app+SW typecheck、Biome対象チェック、
candidate focused/typecheck/lint、candidate all は再実行できていない。実ブラウザの
live focused suite 20件完走も未確認であり、quota slice以外のオフライン要件完了を
主張しない。

## 既知のリスク

`collectOfflineCacheOrphans` は orphan 列挙・削除の途中では signal を観測しない。
大量 orphan ではキャンセル完了が遅れる可能性がある。ただし GC 完了後の signal
check により、abort 後の write retry は行われない。今回の slice では recovery API
を広げず、後続の専用改善課題として残す。
