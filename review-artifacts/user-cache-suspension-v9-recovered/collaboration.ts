import {
  isSnapshotSavedForRoom,
  MESSAGE_SNAPSHOT_SAVED,
  type SessionUser,
} from "@miyulabmd/shared";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { notifyDriveChanged } from "./drive-changed.ts";
import { createSessionLifecycle } from "./page-lifecycle.ts";
import { colorForEmail } from "./user-style.ts";

export type CollabAwareness = WebsocketProvider["awareness"];

export type AwarenessUserState = {
  userId: string;
  displayName: string;
  color: string;
};

export type YjsSession = {
  doc: Y.Doc;
  provider: WebsocketProvider;
  yMarkdown: Y.Text;
  awareness: CollabAwareness;
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

  let currentUser = user;
  const lifecycle = createSessionLifecycle({
    dispose: () => {
      // Drop the callback closure even if somebody retains the old provider.
      provider.messageHandlers[MESSAGE_SNAPSHOT_SAVED] = () => undefined;
      provider.destroy();
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
    leave: lifecycle.leave,
    provider,
    reconnect: lifecycle.reconnect,
    setUser(next) {
      currentUser = next;
    },
    yMarkdown,
  };
}
