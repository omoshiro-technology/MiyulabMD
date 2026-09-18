# v9の判断と回収

## 元の実装担当の判断

参照したチェックポイントは `03c4d37`、方針は意思決定台帳D22。
実装担当から読み取り専用で回収した判断内容を以下に保存する。

- v8の書き込み後epoch検査は、commitを取り消せず、確定済み本文の誤削除に
  つながったため棄却。
- 停止後の補償的な削除も、読み取り・新しい保存と競合し、原子性を保証しないため棄却。
- メソッドごとの個別チェック追加は、非同期の隙間を見落としやすいため棄却。
- ユーザー単位の進行中操作レジストリを選択。停止時に未確定トランザクションを
  abortし、実際のcomplete／abortをPromiseの結果とする。
- 正常なネットワーク要求をキャッシュ停止だけで中止する案は棄却。
  セッション破棄によるネットワーク中止は引き続き行う。
- 本文・フォルダ・一覧・メタデータput/deleteへ取消を適用し、`putNote`の
  OPFS cleanupはトランザクション失敗時のみとする。
- 本文は拒否世代、一覧は各ノートの世代を確認し、停止・拒否後の古い結果を返さない。
- 永続拒否記録を物理cleanupより先に保存し、cleanup失敗で拒否を解除しない。
- DB接続・拒否記録保存失敗時のユーザー利用停止と日本語の手動クリア警告を維持する。

これらは判断・実装意図の記録であり、全経路で正しく実現したという証明ではない。
具体的な親検証結果は `validation.md` を参照する。

## 受け渡し事故と回収方法

初期placeholderはapply_patch、その後の本文配置はterminalのcpで行われたため、
親にはplaceholderだけが届いた。Git blobもclone間で共有されていなかった。
元担当の作業ディレクトリには完全なコードが残っており、親が読み取り専用で確認した。

新しい担当がapply_patchで途中まで回収し、残りを親がapply_patchで補完した。
途中で折り返されていたコメント1箇所も原典どおりに戻し、両ファイルの完全SHA256が
原典と一致することを確認した。新たな実装やライブソースの復元は行っていない。

## 後継判断

親の追加テストで、DB接続失敗時に先行するネットワーク成功が返る問題を確認した。
本候補は未採用。D26に従い、拒否の順序をDB接続より前に確定する後継修正へ進む。

## D26修正（GPT-5.6-luna）

### 検討した代替案

- `getCache()` の完了後にだけ拒否世代を進める案は、DB open失敗時に古い
  ネットワーク成功を止められないため棄却した。
- ユーザーキャッシュ停止中はすべてのネットワーク成功を拒否する案は、
  オンラインの新規読み取りまで壊すため棄却した。
- `denyNote()` の中で世代を進め続ける案は、ストレージ待ちの間に同じ拒否入口を
  二重に扱う余地を残すため棄却した。

### 採用した設計と理由

HTTP 403/404を観測した同期入口で `enterOfflineNoteDenial()` を呼び、
ストレージ操作やawaitより先にユーザー・ノートの世代を進める。確定した世代を
`denyNote()` に渡して永続化するため、拒否入口の順序と保存・cleanupの責務を分離し、
ストレージが遅くても同じ処理で世代を二重更新しない。拒否保存の失敗は既存の共有
`suspendOfflineCacheUser()` に集約し、保留中のユーザー単位書き込みを同じ寿命境界で
abortする。

最終公開境界ではキャッシュ由来の成功だけ現在のユーザー停止状態も検査する。一方、
ネットワーク由来の成功は停止状態を失敗扱いせず、ノート固有の拒否世代とセッションの
停止だけを検査する。これにより、先行要求は拒否後に公開されず、拒否後に開始した
新規オンライン要求は成功できる。

### 根拠

追加の `note-denial-entry-ordering.spec.ts` が、DB openが失敗する403の後に先行200を
公開しないことと、新規要求の200を許可することを検証する。D26修正後は既存を含む
候補ブラウザ30件が成功した（詳細は `validation.md`）。

## D28修正（GPT-5.6-luna）

### 採用した選択

`denyNote()` に順序トークンがない直接呼び出しでは、ストレージ待ちに入る前に
共有同期入口 `enterOfflineNoteDenial(userId, id)` で新しい拒否世代を一度だけ進める。
トークンが渡された場合はその値を再利用し、既存の世代チェックを通して二重更新を
避ける。

### 理由

D26でHTTP拒否経路の世代作成を呼び出し側へ移した際、直接の `denyNote()` 呼び出しで
世代が作成されない回帰が入った。入口を `orderingToken ?? enterOfflineNoteDenial(...)`
として共有し、直接拒否では保留中の読み取りを無効化しつつ、既存のトークン付き経路の
順序と stale-token チェックを変更しない。無関係なメソッドは変更しない。

## D30/D31：cached viewerのlocal-only note read（GPT-5.6-luna）

### 採用した選択

`viewer.mode === "cached"` をセッション生成時に捕捉したviewerのモードとして判定し、
既存の `getCache()` / `readCachedNote()` / `cachedReadResult()` だけで読む分岐を追加した。
この分岐では `fetchNote()`、認証、キャッシュ更新、SSR seed、network fallbackを行わない。
`cacheViewerId` がない場合、ストレージを開けない場合、またはノートがない場合は、
HTTP statusを持たないexport済み `OfflineNoteUnavailableError` を投げる。

### 理由と棄却した代替案

- cached viewerでもnetwork-firstしてmiss時に救済する案は、別principalの本文で既存Alice
  キャッシュを上書きし、未検証viewerにネットワーク結果を公開するため棄却した。
- missを `status: 404` のread resultにする案は、local unavailableをHTTP結果へ偽装し、
  既存のnetwork result unionを不必要に広げるため棄却した。
- cached成功だけを早期returnする案は、停止・stale ordering・dispose/abortのpublication
  gatesを迂回するため棄却した。cache read後は既存の最終ゲートを通す。

### スコープ

変更はこの候補の `note-read-session.ts` と本記録だけ。認証済みviewer／confirmed guestの
network-first経路、拒否・取消しの理由、storage module、AppShell／Editor／mutation API、
およびライブ `apps/web/src` は変更しない。

## D32 AppShell viewer-context candidate

The D32 decision and validation records are preserved in:

- [`app-shell-decisions.md`](app-shell-decisions.md)
- [`app-shell-validation.md`](app-shell-validation.md)

## P1 device-clear authority and locking

Device clear retains only `viewer-id`, `device-epoch`, and
`device-clear-state`. All `user-epoch:*` records and every private note,
folder, list, denial, ordering, image, drive-root, and folder-state record are
removed. The global device epoch fences scopes, including a user purge that
failed before its user epoch could be restored.

The durable `purging` marker is a commit point: cancellation is checked before
the exclusive lock and once at the lock callback entry, then the clear runs to
terminal completion and leaves `globalSuspended`/`purging` on failure. A retry
can use the exclusive path while suspended. A device invalidation is signalled
at operation start.

The public storage lock coverage is:

| API | lock |
| --- | --- |
| `captureOfflineCacheScope`, authority/folder reads | user shared |
| `persistCachedViewerId` | user shared |
| `readCachedViewerId` | global shared |
| cache handle methods (including `getNoteListState`) | user shared |
| `collectOfflineCacheOrphans` | user exclusive |
| `clearOfflineCacheUser` | user exclusive |
| `clearOfflineCacheDevice` | global exclusive |
| synchronous lifecycle/order helpers and BroadcastChannel subscription | none |

Unlocked helpers are used inside lock callbacks; no public locked helper is
called from another locked helper.
