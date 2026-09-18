# ノート画面への接続：調査と実装順

保存・拒否・利用停止基盤の採用後に行う、実画面接続の調査記録。
本書は実装完了を示さない。意思決定は [台帳](offline-pwa-decisions.md) に追記する。

## 調査時点の経路

D32・D34でAppShellのviewer所有と独立したconfig解決はライブへ反映した。
以下は接続前の調査記録。Editor・mutation・SSRの注意点は引き続き後続作業に適用する。

| 対象 | 現状と接続時の注意 |
| --- | --- |
| `AppShell` | `fetchMe`とauth-configをPromise.allで取得。contextはuser/loadingが中心でcached viewerを表現していない |
| `EditorPage` | 初期値は`noteFromCaches`、読込effectは`beginEditorNoteLoad`＋従来`loadNote`。永続読み取りセッションは未接続 |
| `note-cache.ts` | process-globalなMap/inflightとfetchNote。SSR bootstrapもこのMapへ入る |
| `ownerFlags` | ノートのaccessとAppShell userから編集可否を算出。実際のcache/network由来が反映されない |
| collaboration | hydrate済み・preview以外・user loading完了で接続可能。user nullだけでは接続を防げない |
| mutation gate | 純粋な判定ユーティリティのみ。実APIからまだ使われていない |
| preview task | `taskNoteId`が渡るとチェックボックスからPATCHできる。見た目だけでなくdispatch時の制御が必要 |
| SSR | Workerがroot外にpreviewとnote-bootstrap JSONを注入。表示用の一時データと認証済みキャッシュ保存を混同しない |

調査時点の主な参照先：

- [AppShell](../apps/web/src/components/layout/AppShell.tsx#L24)、
  [AppShellContext](../apps/web/src/components/layout/AppShellContext.ts#L7)
- [EditorPageの初期化・読込](../apps/web/src/pages/EditorPage.tsx#L411)
- [従来note-cache](../apps/web/src/lib/note-cache.ts#L6)
- [collaboration開始条件](../apps/web/src/pages/editor-page.ts#L164)
- [共有・フォルダ更新](../apps/web/src/pages/editor-page.ts#L228)
- [タスクチェックボックス](../apps/web/src/lib/task-checkboxes.ts#L9)
- [SSR挿入](../apps/worker/src/ssr/inject-note-page.ts#L19)、
  [bootstrap読込](../apps/web/src/lib/note-bootstrap.ts#L29)

コードの行番号は調査時点の参照であり、接続実装で変わり得る。

## 既存の実画面テスト

`apps/web/tests/browser/offline-note-view.spec.ts` は、実際のノート画面に対して以下を要求する。

1. オンラインで表示したノートが永続キャッシュへ保存される。
2. API通信だけを遮断して再読み込みしても、本文とキャッシュ表示のstatusが見える。
3. Editなし、タスク操作不可、ノート用WebSocket接続なし。
4. 8種の更新API呼び出しがReadOnlyViewingErrorになり、更新HTTP要求を送らない。

現状ではこのテストは未完了。Viteの静的shellは読み込める条件なので、
完全オフラインのService Worker起動を検証しているわけではない。

## 接続で維持すべき境界

- 前回のcached viewerは認証済みではない。新しいネットワーク応答を未確認の
  前回ユーザーIDへ保存しない。cached/unavailableからの読込方針を先にテストする。
- viewerをセッション開始時に固定し、ID・viewer変更・unmountで読込を破棄する。
  古いレスポンスを現在のviewerの保存先へ流さない。
- 本文・viewer・source・cachedAtを一つの結果としてUIが保持する。
  sourceを認証結果から推測したり、別のglobal Mapに分離したりしない。
- cache由来はpreview-only。共同編集を作成しないことを、effect開始条件でも保証する。
- 共有設定、フォルダ変更、履歴復元、画像操作、タスク更新などを同じdispatch方針で制御する。
  以前の候補であった「隠したが別経路から更新できる」状態に戻さない。
- SSR bootstrapは表示の初期化には使えても、viewer確認前の永続保存の根拠にはしない。
- auth-configの失敗とviewerの解決を分ける。任意のbootstrap例外を
  通信失敗としてcached viewerへ変換しない。

## 推奨する縦方向の実装順

1. 未確認のcached viewerでの読込がローカルだけになることをpublic APIテストで固定する。
2. AppShellがキャンセル可能なviewer contextを所有する。
3. Editorがnote ID・viewerに対応する読み取りセッションを所有し、結果のprovenanceを保持する。
4. その同じ結果からpreview、status、collaboration、mutation dispatchを制御する。
5. 既存の実画面テストを通し、認証API成功＋ノートだけ503の場合もcache由来としてreadonlyにする。
6. SSR経路、ユーザー切替・古いcallback、未取得表示を確認してからフォルダ／一覧へ広げる。

## dispatch設計の比較（接続前に決定・記録する）

- **明示的なmutation facade**：viewer/read-resultに束縛された操作を渡す。
  所有権は明確だが、既存APIの呼び出し箇所を接続し直す必要がある。
- **共通API入口のgate**：既存の更新API全体へ共通判定を入れる。
  現在の直接API呼び出しテストに適合するが、状態を認証だけから推測せず、
  現在の読込結果と同じ所有権・切替ルールに従わせる必要がある。

以前の「mutable global viewerで保存」「auth成功だけで更新を許可」という案は不採用。
共通入口を使うこと自体と、その不適切な状態管理は区別して評価する。
