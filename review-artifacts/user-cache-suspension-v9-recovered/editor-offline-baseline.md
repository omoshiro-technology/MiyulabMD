# D42：オンライン機能を保持する再出発点

簡略readonly候補は `904bcfc` に不採用の履歴として保存した。
その後、親がEditorPage候補をライブ原典と同じ656行へapply_patchで揃えた。

```text
apps/web/src/pages/EditorPage.tsx
review-artifacts/user-cache-suspension-v9-recovered/src/pages/EditorPage.tsx
SHA256: 6b17a840782b766d9520f0aae1f05c9bb78f3689e2d67bcdac1f707b0e13217c
```

原典との一致を確認し、候補ファイルのBiomeとdiff-checkは成功。
次を実行した。

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-note-view.spec.ts
exit 1
2 failed
```

両ケースともオンラインの本文表示・Edit表示・有効条件は成功。
その後の永続キャッシュ待ちがnullのため失敗した。
この完全な出発点に必要な差分だけを加え、オンライン機能は維持する。
