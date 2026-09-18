import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { collaborationWsBase } from "./collaboration.ts";
import { editCacheDocName } from "./edit-cache.ts";

/**
 * purge ガード用の一時同期。永続化済みのローカル Y.Doc を読み込み、
 * DocumentRoom へ接続して sync（state vector 交換＝未送信 update の送信）
 * が完了するまで待つ。成功後に purge しても編集はサーバーにある。
 */
export async function syncEditCacheDoc(
  userId: string,
  noteId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(
    editCacheDocName(userId, noteId),
    doc,
  );
  try {
    await persistence.whenSynced;
    const provider = new WebsocketProvider(collaborationWsBase(), noteId, doc);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Edit-cache sync timed out")),
          timeoutMs,
        );
        const onSync = (synced: boolean) => {
          if (synced) {
            clearTimeout(timer);
            resolve();
          }
        };
        provider.on("sync", onSync);
        if (provider.synced) {
          onSync(true);
        }
      });
    } finally {
      provider.destroy();
    }
  } finally {
    persistence.destroy();
    doc.destroy();
  }
}

/**
 * 登録済み doc を逐次同期する。1件でも失敗（オフライン・タイムアウト等）
 * したらその時点で止め、失敗した noteId 以降は未処理のまま返す。
 * 呼び出し側は `failed` が空なら purge してよい。
 */
export async function syncEditCacheDocs(
  userId: string,
  noteIds: string[],
): Promise<{ synced: string[]; failed: string[] }> {
  const synced: string[] = [];
  const failed: string[] = [];
  for (const noteId of noteIds) {
    try {
      await syncEditCacheDoc(userId, noteId);
      synced.push(noteId);
    } catch {
      failed.push(noteId);
      break;
    }
  }
  return { failed, synced };
}
