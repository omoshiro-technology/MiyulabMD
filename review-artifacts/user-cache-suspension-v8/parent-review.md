# 親による v8 検証記録

## 状態

**不採用・後継で修正。** この候補は検証用資料としてコミットに保存する。
`apps/web/src/` への反映を意味しない。

## 実際に検証した候補

- `offline-cache.ts`: `52970cb6e000d11a95eeaf432f19bc8e7b4d90de24190eabf61fc218366bd648`
- `note-read-session.ts`: `3260264d92aa18a95230f890782845a3e7ad20c44430717139189f3c53cf4229`

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v8 all
exit 0
candidate typecheck: passed
candidate Biome: passed
candidate browser: 27 passed
```

ランナーは候補の同一bytesを読み込み、実装用ソースは変更しない。
検証前後の候補・実装用ソースの不変チェックも通過。

現行ライブ実装の回帰検証として、以下も親が確認した。
候補の Node 単体検証とは混同しない。

```text
pnpm --filter @miyulabmd/web test
117 passed, exit 0
pnpm --filter @miyulabmd/web typecheck
exit 0
```

## 独立レビューの指摘

- `putNote` はメタデータcommit後の利用停止チェックも、未参照ファイルの
  cleanup用catchへ流してしまう。確定済みレコードが参照しているOPFS本文を削除し得る。
- 禁止解除のトランザクションには、ユーザー停止で未確定処理を取り消す仕組みがない。
- 公開キャッシュAPIの `getNote` はノート単位の拒否世代を完了時に確認せず、
  セッションを経由しない進行中読み取りが拒否後も本文を返し得る。
- 一覧のユーザー寿命チェックは個別の拒否記録を読む前にあり、
  その読み取り中に停止すると古い一覧を返し得る。

これらはコードレビューによる指摘であり、上記27件の成功が解消を証明するものではない。
ユーザーの推奨案で進めてよいという指示に従い、未確定操作の取消と終端の事実を
共通化する後継案へ進む。判断は意思決定台帳D22へ記録する。

## 親による追加再現

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v8 browser user-cache-write-lifecycle.spec.ts
exit 1
2 failed
```

native IndexedDBのput直後に停止した場合も、completeイベントで停止した場合も、
再読み込み後に本文を取得できなかった。前者は旧本文、後者は確定した新本文を
維持すべきであり、書き込みとファイルcleanupの不整合を回帰テストで確認した。
