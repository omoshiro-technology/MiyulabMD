# 0003. メダリオン層のフォルダ割当化と編集ロックの分離

- ステータス: 採択
- 日付: 2026-09-16（設計合意時点。実装前）
- 関連: `specs/knowledge-management.html` §2.6、`CONTEXT.md`（メダリオン層 / 編集ロック）

## コンテキスト

現行の層モデルは per-note（`notes.layer` = bronze/silver/gold）で、
gold 層が編集ロックを兼ねていた。その結果:

- フォルダ内に bronze/silver/gold が混在し、ツリーから構造が読めない
- 「層 = 精緻度のステージ」という本来の意味と「編集可否」が癒着している
- 昇格ゲート・`note_layer_events`・時間制解除（`gold_unlocked_until`）という
  重い機構が、実際にはほぼ使われていない機能に付随している

## 決定

- 層は**フォルダの属性**（`folders.medallion_set_id` + `folders.medallion_layer`）とし、
  表示ラベルのみを担う。昇格・イベント履歴・編集制限は持たない。
- 層の構成はユーザー定義の「メダリオン設定（層セット）」を複数持てる
  （`medallion_sets`）。既定セット「精緻度」= raw / knowledge / output。
  層キーは immutable、ラベル・順序は編集可、割当済み層は削除不可。
- 編集可否は**独立したノート単位の「編集ロック」フラグ**に分離。
  ロック中は本文編集・削除・移動・共有・改名のすべてを拒否し、
  許可されるのは閲覧とロック解除のみ。時間制解除は廃止。
- ノートの振り分けウィザードは提供しない（per-note 層は実質未使用のため）。
  `notes.layer` / `note_layer_events` / 昇格ゲートは deprecated → 撤去。

## 検討した代替案

- per-note 層を維持して UI だけ改善 → フォルダ内混在という構造上の問題が
  残り、昇格機構の保守コストが続くため不採用。
- 層とロックの一体化を維持 → 「raw に原本を置く」「成果物をロックする」は
  別の操作であり、癒着は誤用の温床になるため不採用。
- 既存ノートの自動振り分け移行 → 管理実績がなく物理移動の副作用だけが
  残るため不採用。

## 影響

- `notes.layer` の値は今後読まない。`gold_unlocked_until` は編集ロック
  フラグへ読み替えて継承。
- 検索 DSL の `layer:` はフォルダ割当層に再定義（`layer:output` /
  `layer:セット.層`）。MCP の `list_notes_by_layer` は廃止、
  `unlock_gold_for_edit` は `set_edit_lock(id, locked)`（解除のみ
  `confirm: true` 必須）に置き換え。
- オフライン編集資格の「編集ロックなし」条件と整合する
  （ADR 0001 / `specs/offline-mode.html`）。
