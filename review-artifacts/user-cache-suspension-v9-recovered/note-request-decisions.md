# D101：ノート本文 GET の request-sharing 候補

- **状態**：候補実装中。ライブソースには反映しない。
- **対象**：同一ページ内で、同じ authenticated viewer scope と note ID を持つ
  進行中の本文 GET。
- **選択**：`src/lib/note-request.ts` の viewer ごとの note map で進行中の
  `requestJson<Note>` だけを共有する。`viewerId` は送信せず、HTTP の認証や
  URL の一部にも使わない。
- **理由**：単なる Promise 共有では subscriber の中断が結合し、global response
  cache では viewer 分離と読み取り寿命を壊すため。各 subscriber は独立した
  AbortSignal と成功値の deep copy を持ち、保存・拒否・公開は既存の session／
  prefetch の寿命に残す。
- **未指定 scope**：`viewerId` が undefined または空文字なら従来どおり独立した
  transport request とする。cached viewer の cache ID から scope を推定しない。
- **対象外**：異なる viewer／note、alias 推定、folder/list、legacy hover、
  cross-tab、settled response cache、保存処理の重複統合。
- **中断規則**：一人の中断は他の subscriber に伝播しない。全員が中断した場合
  のみ underlying request を abort し、entry を直ちに削除する。settle 後は entry
  を保持せず、古い cleanup は後続の同じ key を削除しない。

## D103：共有結果の失敗経路も subscriber ごとに完結させる

- **状態**：候補実装済み。ライブソースには反映しない。
- **背景**：共有結果の HTTP 403 container が subscriber 間で共有されると、一方の
  `error` 変更が他方へ漏れる。また成功結果の `structuredClone` が失敗すると、
  settlement callback 自体が reject し、subscriber が pending のままになる。
- **選択**：成功結果のコピー失敗は該当 subscriber だけを同じ例外で reject し、
  他の subscriber の settlement を継続する。失敗結果も subscriber ごとに新しい
  container を作る。settlement の全経路で abort listener と subscriber Set を
  清掃する。
- **理由**：結果値の isolation と個別中断の契約を失敗経路にも一貫して適用しつつ、
  ネットワーク Error の class／cause は transport の reject 値をそのまま渡せるため。
- **対象外**：request key、refcount／中断規則、API caller、storage、拒否処理、
  新しい API や fresh-bypass flag の追加。
- **検証**：subscriber sharing／isolation／cancellation、note denial entry-ordering
  ／ordering の focused specs を候補で直列実行する。

## D104：拒否世代を共有 HTTP の join 判定にも適用する

- **状態**：候補実装済み。ライブソースには反映しない。
- **背景**：拒否確定後の新しい session が、同じ viewer／note の古い共有
  HTTP へ参加すると、古い 200 を新世代へ保存できてしまう。
- **選択**：拒否世代の in-memory ledger を `src/lib/note-access-order.ts` へ
  抽出し、`offline-cache.ts` は互換 export の薄い delegate とする。共有 helper
  は各 scoped call の現在世代を読み、`Entry` に記録した世代と一致しない group
  には参加しない。
- **理由**：begin は増分せず、拒否入口だけが増分する既存意味を保ったまま、
  storage と HTTP sharing が同じ ephemeral ledger を参照できる。古い settle／
  cancel は既存の identity-safe cleanup により新しい group を削除しない。
- **対象外**：caller の epoch／fresh option、session の拒否 catch／fail-closed
  方針、永続 marker／schema／key、live source、cross-tab 同期。
