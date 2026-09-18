# D38–D40 親レビュー

## 採用候補の修正

- `/api/notes` のfixtureを既存契約 `{ notes: [] }` に修正。
- 裸の配列を許容する候補の変更を削除。
- 圧縮されたcandidate api.tsを元の構造へ戻し、全体lint抑制を削除。
- 元のapi.tsとのコード差分は、`apiFetch as fetch`のimportと、
  明示的`logout()`の`globalThis.fetch`呼び出しのみ。
- api-transportは共通fetch境界へ接続する以外、通信・HTTP・取消分類を変更しない。
- AppShellは既存viewerRefを読む一つのcontrollerを作り、同じcontrollerをcontextと
  layout-effect bindingへ渡す。登録解除は既存のtoken保護を利用する。

## 親の再検証

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
candidate typecheck: passed
candidate Biome: passed
browser: 36 passed
```

正しい一覧fixtureと、cache source／cached viewerの両方でログアウト可能な検証を含む。
旧い誤fixture・lint抑制での成功を採用根拠とはしていない。

```text
api.ts b43d1f26c6901242ab8118aa4d6d833953893abca2ae3ce66928fad32e7c2570
api-fetch.ts 8bd0da4e08e7454ceeeba3204a669f38dbfebf4404dac027b1b4da24efa26e16
api-transport.ts 5d93a39d54b05df8ea02f26b407d064fed77bc80c93ce23b4d7b18d13691a2bb
AppShell.tsx d012cb0c7d886531527e2ad7ff275ffd6104bb0ae1a904440d55f7ea2616cbd9
AppShellContext.ts fbe558c87902316fed25b6ed9d9f48dcbf9c7be9f8aeca3792c5412bf7fe49d8
```

ライブ反映後は通常のsourceを読む検証を別途行う。Editorの実際のsource公開、
ログアウト時のキャッシュ消去、Service Workerなどは後続であり、完成扱いにしない。

## ライブ採用後の確認

親が上記5ファイルをライブへ反映し、すべて候補と同一bytesであることを確認した。
通常のbrowserコマンドへ19specを指定して36件成功。
Web unit117件（API通信・取消のNodeテストを含む）、型チェック、Webビルド、
対象Biome、diff-checkも成功した。

更新dispatchとAppShell bindingとして採用済み。Editorの読込結果公開は次のスライス。
