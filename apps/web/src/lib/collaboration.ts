import {
  isSnapshotSavedForRoom,
  MESSAGE_SNAPSHOT_SAVED,
  type Note,
  type SessionUser,
} from "@miyulabmd/shared";
import type { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { notifyDriveChanged } from "./drive-changed.ts";
import {
  attachEditCache,
  hasSyncedOnce,
  hasUnsentEdits,
  isEditCacheEligible,
  markYjsSynced,
  subscribeUnsentEdits,
  trackUnsentEdits,
} from "./edit-cache.ts";
import { createSessionLifecycle } from "./page-lifecycle.ts";
import { colorForEmail } from "./user-style.ts";

export type CollabAwareness = WebsocketProvider["awareness"];

export type AwarenessUserState = {
  userId: string;
  displayName: string;
  color: string;
};

/** 編集キャッシュ（y-indexeddb）が接続されたセッションの露出部。 */
export type EditCacheSession = {
  /** 未同期ノートでは provider の初回 sync まで null のまま遅延アタッチされる。 */
  readonly persistence: IndexeddbPersistence | null;
  /** 未送信のローカル編集が残っているか（バッジ表示用）。 */
  hasUnsentEdits: () => boolean;
  subscribeUnsent: (listener: () => void) => () => void;
};

export type YjsSession = {
  doc: Y.Doc;
  provider: WebsocketProvider;
  yMarkdown: Y.Text;
  awareness: CollabAwareness;
  /** オフライン編集資格があるときのみ接続される編集キャッシュ。 */
  editCache: EditCacheSession | null;
  leave: () => void;
  reconnect: () => void;
  destroy: () => void;
  setUser: (user: SessionUser | null) => void;
};

const MARKDOWN_FIELD = "markdown";

function wsProtocol(): "ws" | "wss" {
  return location.protocol === "https:" ? "wss" : "ws";
}

/** DocumentRoom WebSocket のベース URL（y-websocket の serverUrl 引数用）。 */
export function collaborationWsBase(): string {
  return `${wsProtocol()}://${location.host}/ws/notes`;
}

/** ノート用 WebSocket URL（デバッグ・テスト用）。 */
export function collaborationUrl(noteId: string): string {
  return `${collaborationWsBase()}/${noteId}`;
}

/** メールアドレスから安定した表示色を生成する。 */
export function colorForUser(emailOrId: string): string {
  return colorForEmail(emailOrId, emailOrId);
}

export function awarenessLabel(user: SessionUser | null): string {
  return user?.displayName?.trim() || user?.email || "ゲスト";
}

/** y-codemirror.next が読む `user.name` / `user.color` を含む awareness。 */
function colorLightFor(color: string): string {
  if (color.startsWith("#") && color.length === 7) {
    return `${color}40`;
  }
  if (color.startsWith("hsl(") && color.endsWith(")")) {
    return `${color.slice(0, -1)} / 0.25)`;
  }
  return `${color}33`;
}

export function awarenessUser(user: SessionUser | null): AwarenessUserState & {
  user: { name: string; color: string; colorLight: string };
} {
  const userId = user?.id ?? "guest";
  const displayName = awarenessLabel(user);
  const color = colorForEmail(user?.email, userId);
  return {
    color,
    displayName,
    user: {
      color,
      colorLight: colorLightFor(color),
      name: displayName,
    },
    userId,
  };
}

export function applyAwarenessUser(
  awareness: CollabAwareness,
  user: SessionUser | null,
): void {
  const next = awarenessUser(user);
  const current = awareness.getLocalState() ?? {};
  awareness.setLocalState({
    ...current,
    ...next,
    email: user?.email ?? null,
  });
}

/** Yjs ドキュメントと WebSocket プロバイダを初期化し、awareness にローカル状態を設定する。 */
export function createYjsSession(
  noteId: string,
  user: SessionUser | null,
  editCache?: { note?: Note | null; userId?: string | null },
): YjsSession {
  const doc = new Y.Doc();
  const yMarkdown = doc.getText(MARKDOWN_FIELD);
  const provider = new WebsocketProvider(collaborationWsBase(), noteId, doc, {
    connect: false,
  });
  let acceptingSaved = true;
  provider.messageHandlers[MESSAGE_SNAPSHOT_SAVED] = (
    _encoder,
    decoder,
    source,
    fromWebSocket,
  ) => {
    // BroadcastChannel peers and Yjs changes cannot assert server persistence.
    if (
      acceptingSaved &&
      fromWebSocket &&
      source === provider &&
      isSnapshotSavedForRoom(decoder.arr.subarray(decoder.pos), noteId)
    ) {
      notifyDriveChanged();
    }
  };

  applyAwarenessUser(provider.awareness, user);

  // オフライン編集資格があるノートだけ編集キャッシュ（y-indexeddb）に乗せる。
  // 資格は直近メタデータで判定し、stale は許容する（再接続時の Yjs マージが吸収）。
  // 名空間のユーザー ID はオフライン表示では記憶された cacheViewerId を使う。
  // ローカル領域の選択に限り、認証・API 書き込みの権限根拠にはしない。
  const userId = editCache?.userId ?? user?.id ?? null;
  let editCacheSession: EditCacheSession | null = null;
  let editCachePersistence: IndexeddbPersistence | null = null;
  let disposeUnsentTracking: (() => void) | null = null;
  let onSyncMark: ((synced: boolean) => void) | null = null;
  const note = editCache?.note ?? null;
  if (note && userId && isEditCacheEligible(note, userId)) {
    // 永続化は「オンラインで1回同期済み」のノートに限る。未同期ノートは
    // provider の初回 sync でサーバー履歴が揃ってから遅延アタッチする。
    const attach = () => {
      if (editCachePersistence === null) {
        editCachePersistence = attachEditCache(doc, noteId, userId);
      }
    };
    if (hasSyncedOnce(userId, noteId)) {
      attach();
    }
    onSyncMark = (synced) => {
      if (synced) {
        markYjsSynced(userId, noteId);
        attach();
      }
    };
    provider.on("sync", onSyncMark);
    if (provider.synced) {
      markYjsSynced(userId, noteId);
      attach();
    }
    disposeUnsentTracking = trackUnsentEdits({
      doc,
      isPersistenceOrigin: (origin) =>
        origin !== null && origin === editCachePersistence,
      noteId,
      provider,
    });
    editCacheSession = {
      hasUnsentEdits: () => hasUnsentEdits(noteId),
      get persistence() {
        return editCachePersistence;
      },
      subscribeUnsent: (listener: () => void) =>
        subscribeUnsentEdits(noteId, listener),
    };
  }

  let currentUser = user;
  const lifecycle = createSessionLifecycle({
    dispose: () => {
      // Drop the callback closure even if somebody retains the old provider.
      provider.messageHandlers[MESSAGE_SNAPSHOT_SAVED] = () => undefined;
      disposeUnsentTracking?.();
      if (onSyncMark) {
        provider.off("sync", onSyncMark);
      }
      provider.destroy();
      // persistence を先に閉じる: doc.destroy 後も update 由来の
      // IndexedDB 書き込みが走らないようにする（purge 後の再作成防止）。
      void editCachePersistence?.destroy();
      doc.destroy();
    },
    leave: () => {
      acceptingSaved = false;
      provider.awareness.setLocalState(null);
      provider.disconnect();
    },
    reconnect: () => {
      acceptingSaved = true;
      applyAwarenessUser(provider.awareness, currentUser);
      provider.connect();
    },
  });
  provider.connect();

  return {
    awareness: provider.awareness,
    destroy: lifecycle.destroy,
    doc,
    editCache: editCacheSession,
    leave: lifecycle.leave,
    provider,
    reconnect: lifecycle.reconnect,
    setUser(next) {
      currentUser = next;
    },
    yMarkdown,
  };
}
