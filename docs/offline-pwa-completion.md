# オフライン・PWA完了チェックリスト

## 目的と範囲

`docs/offline-pwa.md` の合意済み仕様について、これまで後続扱いにした必須項目を
完了まで追跡する。利用者から「残っているタスクすべてが完了するまで進めて」と
依頼された時点の開始チェックポイントは `da108dd`。

オフライン編集、更新キュー、全件保存保証、終了後の継続ダウンロード、
外部コンテンツの完全保存、詳細なダウンロード管理画面など、仕様上の非目標は
この依頼を理由に追加しない。根拠と設計変更は意思決定台帳へ追記する。

## 開始時に本体で確認済み

- PWA純粋shell・資産、SSR/APIの分離、更新待機、appだけのcache整理。
- viewer単位のIDB/OPFS本文・フォルダ・一覧、通常閲覧時の保存。
- キャッシュ閲覧のreadonly UIとAPI mutation gate。
- MyDrive所有フォルダ・本文の起動／復帰／定期／HTTP変更後の先読み。
- 同一userの背景cycleのタブ間排他。
- cached/unavailable viewerのサーバー再確認と所有者切替。
- 同一ページの世代付きノートGET共有、subscriber中断・独立結果。
- 本体browser91件、Web unit117件、production PWA8件。

これらの件数は開始時の証拠であり、残作業が完了したことを意味しない。

## 残作業と完了条件

| ID | 作業 | 完了条件 | 状態 |
|---|---|---|---|
| C1 | user切替・明示logout・端末cache削除 | 旧userの表示・メモリ・IDB・OPFSを規則どおり除去し、全タブの進行中処理が復元しない。app起動資産とserverデータは残す | logout/switch・user purge本体反映済み、実Workerでpeer本文・IDB・OPFS削除確認。端末全体削除のcore・UI本体反映済み、browser gate 8件成功。実Worker・複数タブの最終統合はC11/C12 |
| C2 | 認証と拒否のタブ間整合性 | 別タブの認証変更を検出し、誤ったuser領域への保存・表示を防ぐ。確定拒否後の古い保存／公開が他タブでも復活しない | 応答identity・永続世代・表示中note/親画像の拒否通知を本体反映。folder/list投影・guest/cache-disabled画像のchecked fetchが残る |
| C3 | folder HTTP拒否・解除 | canonical ID/root alias、独立した子孫、パンくず・参照、失敗時のfail-closed、古い応答、新しい成功による解除を検証 | 本体反映・対象検証済み：非衝突root、永続世代、atomic保存／解除、Home警告、独立prefetch。表示中通知はC2で継続 |
| C4 | 短縮ID・alias・`/s` | serverの実際の識別子契約に合わせ、対応URLのoffline直接アクセス／reloadと拒否・別名変更を検証 | 本体反映・対象検証済み：canonical/short IDと`/s`。記事aliasはgeneric note APIの契約外。C2との最終統合検証待ち |
| C5 | read入口の残る統合 | folder/list・hoverをviewer所有の共通取得へ接続。通常取得と背景取得の重複、中断、guest/readonly、既存UIを検証 | 調査中 |
| C6 | prefetch完備 | 現在表示対象の優先、完全一覧／所属追従、単発失敗の限定再試行、連続通信・auth・quota停止、不要ダウンロード抑止を検証 | 実装中：D113 retry関連19件・D116 priority関連8件を親確認、全体統合は未完 |
| C7 | Yjsと切断 | server保存確認後の取得契機。オンライン編集中の切断で新規入力を止め、入力済みbufferは破棄・上書きしない | 本体反映・対象検証済み：IME/HTTP境界、永続alarm、保存通知。実Workerで入力→D1→cache→offline本文を確認。最終統合待ち |
| C8 | アプリ内添付画像 | 権限付き取得、参照抽出・重複共有、IDB/OPFS保存、cached preview解決、欠落時の説明。本文だけでも表示できる | 本体反映・対象検証済み：画像15件と実Workerの別親note添付→OPFS→offline画像表示を確認。不要ファイル回収はC9 |
| C9 | storage保持・安全な回収 | persist/estimateをbest-effortに利用。参照中・書込中を壊さないorphan回収、quota停止、旧版保持、migration失敗縮退を検証 | 保持要求・容量概算・user単位安全GCを本体反映。実write排他／壊れた参照の停止を検証済み。quota連携と最終統合が残る |
| C10 | UI説明と操作 | 端末cache削除の確認、保存限界・共有端末上の非公開dataの制約、session切れの案内、必要な非致命的warning | 調査中 |
| C11 | 実配信経路の受け入れ | Web本番成果物＋実WorkerのSSR/auth/API経路でonline→offline再起動、全対応URL、更新、複数タブを検証 | 実Worker全11件成功：本文URL3経路、編集保存、画像、logout peer削除を含む。手動clearと更新の最終統合が残る |
| C12 | 最終統合・記録 | 全suite、型・lint・build、チェックリストの未完項目0、README/仕様/台帳の整合、署名なしcheckpoint、最終変更ガイド | 未実施 |

## 進め方

1. まず現在のコードとAPI契約を調査し、必要な共有interfaceと責任範囲を決める。
2. 各縦切りで公開動作のREDを確認し、候補実装、親レビュー・独立検証、本体反映を行う。
3. 独立作業は並行化するが、同じcache core等を複数担当が同時に書き換えない。
4. 検証失敗や誤った仮定を記録し、テストを除外して完了扱いにしない。
5. 外部へのdeploy／共有upstreamの操作など、承認が必要な境界は実行前に確認する。
   ローカルの本番相当Worker検証は先に進める。

## 検証記録

各行の状態を変更するときは、対応する台帳番号、変更commit、実行したcommand、
実際の成功／失敗件数、対象がcandidateかliveかを追記する。

### `aaa3a15`候補チェックポイント／`aa2eea1` logout準備

- D121–D124および候補内のidentity/image検証記録を反映して状態を更新した。
  `aaa3a15`は未採用候補と明示的なREDを含む保存点であり、完了commitではない。
- candidateのidentity/recovery/context対象17件、image対象15件、
  actor fixture移行の対象92件を親で確認。対象集合は重複し得るため合計しない。
  source typecheckとlint34ファイルも成功。完全suite成功の主張はしない。
- `aa2eea1`の本体backend:
  `pnpm --filter @miyulabmd/worker typecheck` 成功、
  `pnpm --filter @miyulabmd/worker test` **76件成功**。
  `node apps/web/scripts/test-worker.mjs --grep 'logout preparation clears'`
  **実Worker1件成功**。詳細は `docs/api-response-identity.md`。
- 未採用のlive編集は`review/unadopted-reader-folder-work`の`12ac659`へ保全した。
  mainの`apps/web/src`に未検証の部分API変更を残さず、候補から再構成する。

### `fdaf910`–`8801027` 端末cache削除の本体反映

- `071be6b` で採用判断を manifest に記録（候補 `offline-cache.ts` を
  banner 除去のうえバイトコピー。候補が最新 live を内包することを
  mounted-folder manifest の hash で確認）。
- `fdaf910` で `apps/web/src/lib/offline-cache.ts` に本体反映。
  反映直後の browser suite で14件の回帰を検出し、以下の採用後差分で解消した。
  いずれも判断内容は `device-cache-clear-adoption-manifest.md` に記録。
  - OPFS app root を削除後に空で再作成（clear 後の `getDirectoryHandle` 契約）。
  - suspended user の `openOfflineCache` を拒否しない（open 成功・各操作が
    fail-closed の従来契約を復元）。
  - `navigator.locks` 非対応時、shared lock は無ロック実行に縮退、
    exclusive（GC/user clear/device clear）は従来どおり reject。
  - `readScopeEpochs` を request の `onsuccess` 解決に変更
    （epoch-terminal の最終検証ゲートがハンドラ遅延で実際に読み取りを
    保留できるようにする）。
- `0c281df` で `manual-cache-clear.spec.ts` の callback 抽出と
  `manual-cache-clear-tabs.spec.ts`（BroadcastChannel 欠如時の durable
  device epoch 拒否）を追加。`e1e58ef` で gc/tabs ゲートの lock 名を
  `miyulabmd-offline-cache:user:<id>` に追従。
- `8801027` で `/settings/profile` に端末削除 UI（ConfirmDialog 経由）を追加。
  ゲートは `settings-device-cache.spec.ts`。
- 実行: `pnpm --filter @miyulabmd/web typecheck` 成功、`pnpm test` 117件成功、
  `node scripts/playwright.mjs test` 254件成功・2件失敗
  （`offline-epoch-terminal` home-folder-denial、`offline-folder-denial`
  stale-navigation は採用前からの RED。C2/C3 側の残件として継続）。
