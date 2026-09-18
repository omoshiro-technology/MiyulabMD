# quota recovery の判断記録

## D129：quota recovery を acquisition cycle の共有予算にする

- 状態：実装・候補検証済み。本体の focused browser suite は依存未導入のため未完走。
- 背景：OPFS の quota failure 後に、本文・folder/list metadata・添付画像の保存を
  同じ acquisition cycle 内で回収・再試行する必要がある。一方、保存失敗中の共有
  lock を保持したまま GC すると、失敗した書き込みと回収が相互に待ち合う。
- 検討した案：
  - write ごとに回収予算を作る案は、1 cycle の上限を隠し、複数対象で無制限に
    GC/retry するため棄却。
  - failed write の lock callback 内で GC する案は、失敗した共有 lock と競合する
    ため棄却。
  - foreground の画像取得を cache write failure で失敗させる案は、表示用 bytes
    まで失うため棄却。
- 採用：`createStorageWriteRecovery` を cycle の入口で一度だけ作り、本文・folder・
  list metadata・画像の全 put が同じ `recover` を共有する。quota を最初に観測した
  write の完了後、別の exclusive lock で orphan GC を一度だけ行い、signal を再確認
 して同じ validated operation を一度だけ再開する。GC または retry 前の abort は
  即時停止し、abort 後に再開しない。
- 画像は `requireCache` を in-flight transport key に含めない。foreground と
  background は同じ network response/bytes を共有し、通常の foreground は cache
  write failure 後も bytes を返す。必須保存を要求する background だけが
  `AttachedImageCacheError` として storage failure を観測する。403/404 の denial
  marker は retry せず、取得開始時の ordering token を retry に引き継ぐ。
- 制約：folder denial projection、manual clear、guest image identity、全オフライン
  要件の完了はこの slice に含めない。quarantine branch の実装は参照・コピーしない。
- 既知のP2：`collectOfflineCacheOrphans` は大量 orphan の削除途中で signal を観測
  しないため、キャンセル完了が遅れる可能性がある。GC後の signal check により
  abort後の retry は防げるので、今回の recovery API は拡張せず後続課題とする。
