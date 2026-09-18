import { DurableObject } from "cloudflare:workers";
import type { TaskCheckboxUpdate } from "@miyulabmd/markdown";
import {
  EDIT_LOCK_WS_CLOSE_CODE,
  EDIT_LOCK_WS_CLOSE_REASON,
  type NoteHistoryActor,
} from "@miyulabmd/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { db } from "../db/client.ts";
import { recordNoteEditEvent } from "../services/history.ts";
import { persistMarkdownSnapshot } from "../services/notes.ts";
import {
  AGENT_IDLE_MS,
  type AgentPresenceInput,
  agentAwarenessState,
} from "./agent-presence.ts";
import {
  type AwarenessChanges,
  applyOwnedClientChanges,
  clientsForAwarenessBroadcast,
  clockForRemoval,
  encodeAwarenessNullUpdate,
  nextAwarenessClocks,
} from "./awareness-sync.ts";
import { EditLockRecheck, type EditLockRow } from "./edit-lock.ts";
import {
  APPLY_EDIT_ORIGIN,
  APPLY_MARKDOWN_ORIGIN,
  actorFromAgent,
  actorFromWsAttachment,
  applyEditOp,
  applyHunkToSession,
  eventFromSession,
  HISTORY_IDLE_MS,
  historyActorKey,
  type PendingHistorySession,
  sessionFromApplyEdit,
  sessionFromHunk,
  shouldSkipHistoryOrigin,
  summarizeTextDelta,
} from "./history-edit.ts";
import {
  type AgentCursor,
  applyTextDiff,
  excerptAround,
  type InsertPosition,
  planInsert,
  planReplace,
} from "./markdown-edit.ts";
import {
  SnapshotPersistence,
  STORAGE_YJS_KEY,
} from "./snapshot-persistence.ts";
import { writeSnapshotAndNotify } from "./snapshot-saved.ts";
import { applyTaskCheckbox } from "./task-checkbox.ts";

/** y-websocket 互換のトップレベルメッセージ種別。 */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

const STORAGE_NOTE_ID_KEY = "note-id";

type WsAttachment = {
  canEdit: boolean;
  userId?: string;
  displayName?: string;
  email?: string;
  historySessionId?: string;
  awarenessClientIds: number[];
  awarenessClocks: Record<string, number>;
};

function isRoomSocket(origin: unknown): origin is WebSocket {
  return (
    typeof origin === "object" &&
    origin !== null &&
    "deserializeAttachment" in origin &&
    "serializeAttachment" in origin
  );
}

export type ApplyEditInput = {
  noteId: string;
  agent: AgentPresenceInput;
} & (
  | {
      op: "replace";
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }
  | { op: "insert"; text: string; position: InsertPosition }
  | { op: "set"; markdown: string }
);

export type ApplyEditResult =
  | {
      ok: true;
      cursor: AgentCursor;
      excerpt: string;
      markdownLength: number;
    }
  | {
      ok: false;
      error: "not_found" | "ambiguous" | "invalid" | "locked";
      message: string;
      matches?: number;
    };

const EDIT_LOCKED_MESSAGE =
  "edit_locked: this note is edit-locked. Call set_edit_lock first.";

export type TaskCheckboxResult =
  | { checked: boolean; ok: true }
  | { error: "conflict"; ok: false }
  | { error: "locked"; message: string; ok: false };

/**
 * ノート 1 件につき 1 Durable Object。
 * Yjs 同期・awareness・SQLite 永続化・MCP からの差分編集を担う。
 */
export class DocumentRoom extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private loading: Promise<void> | null = null;
  private readonly snapshots = new SnapshotPersistence(
    this.ctx.storage,
    async (markdown) => {
      const noteId = await this.ctx.storage.get<string>(STORAGE_NOTE_ID_KEY);
      if (!noteId) {
        throw new Error("Cannot persist snapshot without note ID");
      }
      const result = await writeSnapshotAndNotify(
        () => persistMarkdownSnapshot(this.env, noteId, markdown),
        noteId,
        () => this.ctx.getWebSockets(),
      );
      if (result === "rejected") {
        console.warn(`markdown snapshot rejected for note ${noteId}`);
      }
    },
  );
  // X-Can-Edit is fixed at connect time; this re-checks the §2.6 edit
  // lock against D1 so a mid-session lock/unlock takes effect.
  private readonly editLock = new EditLockRecheck(() => this.readEditLockRow());
  private agentIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private historyPending = new Map<string, PendingHistorySession>();
  private historyMarkdown = new Map<string, string>();
  private historyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private requireDoc(): Y.Doc {
    if (!this.doc) {
      throw new Error("Y.Doc is not initialized");
    }
    return this.doc;
  }

  private requireAwareness(): awarenessProtocol.Awareness {
    if (!this.awareness) {
      throw new Error("Awareness is not initialized");
    }
    return this.awareness;
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        headers: { Upgrade: "websocket" },
        status: 426,
      });
    }

    const noteId = request.headers.get("X-Note-Id");
    if (!noteId) {
      return new Response("Missing X-Note-Id", { status: 400 });
    }

    await this.ensureInitialized(noteId);

    const canEdit = request.headers.get("X-Can-Edit") === "true";
    const userId = request.headers.get("X-User-Id") ?? undefined;
    const displayName = request.headers.get("X-Display-Name") ?? undefined;
    const email = request.headers.get("X-User-Email") ?? undefined;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const attachment: WsAttachment = {
      awarenessClientIds: [],
      awarenessClocks: {},
      canEdit,
      displayName,
      email,
      historySessionId: crypto.randomUUID(),
      userId,
    };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    await this.ensureInitialized();

    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    const canEdit = attachment?.canEdit ?? false;

    const data =
      typeof message === "string"
        ? new TextEncoder().encode(message)
        : new Uint8Array(message);
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        const syncTypePos = decoder.pos;
        const syncMessageType = decoding.readVarUint(decoder);
        decoder.pos = syncTypePos;

        const isWrite =
          syncMessageType === syncProtocol.messageYjsSyncStep2 ||
          syncMessageType === syncProtocol.messageYjsUpdate;
        if (isWrite) {
          if (!canEdit) {
            break;
          }
          if (await this.editLock.locked()) {
            // X-Can-Edit is frozen at connect time, so the client still
            // believes it can edit. Close writable sockets with a permanent
            // app-level code instead of silently dropping the update.
            this.closeLockedWriters();
            break;
          }
        }

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, this.requireDoc(), ws);

        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(
          this.requireAwareness(),
          update,
          ws,
        );
        break;
      }
      case MESSAGE_QUERY_AWARENESS: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.requireAwareness(),
            Array.from(this.requireAwareness().getStates().keys()),
          ),
        );
        ws.send(encoding.toUint8Array(encoder));
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.ensureInitialized();

    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    if (attachment) {
      const actor = actorFromWsAttachment(attachment);
      await this.flushHistorySession(
        historyActorKey(actor, attachment.historySessionId),
      ).catch(() => undefined);
    }

    const owned = attachment?.awarenessClientIds ?? [];
    if (owned.length === 0) {
      return;
    }

    const awareness = this.requireAwareness();
    const present = owned.filter((id) => awareness.getStates().has(id));
    if (present.length > 0) {
      awarenessProtocol.removeAwarenessStates(awareness, present, ws);
    }

    const stale = owned.filter((id) => !awareness.meta.has(id));
    if (stale.length > 0) {
      const clocks = attachment?.awarenessClocks ?? {};
      this.sendAwarenessUpdate(
        encodeAwarenessNullUpdate(
          stale.map((clientId) => ({
            clientId,
            clock: clockForRemoval(clocks[String(clientId)]),
          })),
        ),
        ws,
      );
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // 接続エラーは webSocketClose で後処理する。
  }

  /**
   * The edit lock engaged mid-session. Every socket accepted with
   * X-Can-Edit=true is revoked and closed with a permanent code so clients
   * flip to read-only; read-only sockets keep syncing/awareness.
   */
  private closeLockedWriters(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment =
          socket.deserializeAttachment() as WsAttachment | null;
        if (!attachment?.canEdit) {
          continue;
        }
        attachment.canEdit = false;
        socket.serializeAttachment(attachment);
        socket.close(EDIT_LOCK_WS_CLOSE_CODE, EDIT_LOCK_WS_CLOSE_REASON);
      } catch {
        // A socket already tearing down needs no revocation.
      }
    }
  }

  async applyMarkdown(markdown: string, noteId?: string): Promise<void> {
    await this.ensureInitialized(noteId);
    const ytext = this.requireDoc().getText("markdown");
    applyTextDiff(ytext, markdown, APPLY_MARKDOWN_ORIGIN);
    await this.persistYjsState(this.requireDoc());
  }

  async getMarkdown(noteId?: string): Promise<string> {
    await this.ensureInitialized(noteId);
    return this.requireDoc().getText("markdown").toString();
  }

  async updateTaskCheckbox(
    noteId: string,
    input: TaskCheckboxUpdate,
    actor: NoteHistoryActor,
  ): Promise<TaskCheckboxResult> {
    await this.ensureInitialized(noteId);
    if (await this.editLock.lockedNow()) {
      return { error: "locked", message: EDIT_LOCKED_MESSAGE, ok: false };
    }
    const doc = this.requireDoc();
    const result = await applyTaskCheckbox(doc.getText("markdown"), input);
    if (!result.ok) {
      return { error: "conflict", ok: false };
    }
    const markdown = doc.getText("markdown").toString();
    // Acknowledge only after durable storage; the normal Yjs update broadcasts to editors.
    await this.persistYjsState(doc);
    await this.flushSnapshotToD1();
    if (result.changed) {
      const session = sessionFromApplyEdit(
        actor,
        { anchor: result.offset, head: result.offset + 1 },
        "replace",
        Date.now(),
      );
      await this.persistHistorySession(session, markdown).catch(
        () => undefined,
      );
    }
    return { checked: result.checked, ok: true as const };
  }

  /** 最新本文を返し、エージェントのカーソルを出す。 */
  async readForAgent(
    noteId: string,
    agent: AgentPresenceInput,
  ): Promise<string> {
    await this.ensureInitialized(noteId);
    const markdown = this.requireDoc().getText("markdown").toString();
    this.touchAgentPresence(agent, { anchor: 0, head: 0 });
    return markdown;
  }

  async setAgentPresence(
    noteId: string,
    agent: AgentPresenceInput,
    cursor?: AgentCursor,
  ): Promise<void> {
    await this.ensureInitialized(noteId);
    this.touchAgentPresence(agent, cursor ?? { anchor: 0, head: 0 });
  }

  async clearAgentPresence(): Promise<void> {
    await this.ensureInitialized();
    this.stopAgentIdle();
    this.awareness?.setLocalState(null);
  }

  async applyEdit(input: ApplyEditInput): Promise<ApplyEditResult> {
    await this.ensureInitialized(input.noteId);
    if (await this.editLock.lockedNow()) {
      return { error: "locked", message: EDIT_LOCKED_MESSAGE, ok: false };
    }
    const ytext = this.requireDoc().getText("markdown");
    const current = ytext.toString();

    let plan: ApplyEditResult | ReturnType<typeof planInsert>;
    if (input.op === "replace") {
      plan = planReplace(
        current,
        input.oldString,
        input.newString,
        input.replaceAll,
      );
    } else if (input.op === "insert") {
      plan = planInsert(current, input.text, input.position);
    } else {
      plan = {
        cursor: cursorAfterSet(current, input.markdown),
        next: input.markdown,
        ok: true as const,
      };
    }

    if (!plan.ok) {
      return plan;
    }

    applyTextDiff(ytext, plan.next, APPLY_EDIT_ORIGIN);
    this.touchAgentPresence(input.agent, plan.cursor);
    await this.persistYjsState(this.requireDoc());
    await this.recordApplyEditHistory(input, plan.cursor, plan.next);

    return {
      cursor: plan.cursor,
      excerpt: excerptAround(plan.next, plan.cursor.anchor, plan.cursor.head),
      markdownLength: plan.next.length,
      ok: true,
    };
  }

  /** 選んだ時点の全文で現行 Yjs を置き換える。履歴は消さず restore を足す。 */
  async restoreMarkdown(
    noteId: string,
    markdown: string,
    actor: NoteHistoryActor,
  ): Promise<ApplyEditResult> {
    await this.ensureInitialized(noteId);
    if (await this.editLock.lockedNow()) {
      return { error: "locked", message: EDIT_LOCKED_MESSAGE, ok: false };
    }
    const ytext = this.requireDoc().getText("markdown");
    const current = ytext.toString();
    const cursor = cursorAfterSet(current, markdown);
    applyTextDiff(ytext, markdown, APPLY_EDIT_ORIGIN);
    await this.persistYjsState(this.requireDoc());
    const session = sessionFromApplyEdit(actor, cursor, "restore", Date.now());
    await this.persistHistorySession(session, markdown).catch(() => undefined);
    return {
      cursor,
      excerpt: excerptAround(markdown, cursor.anchor, cursor.head),
      markdownLength: markdown.length,
      ok: true,
    };
  }

  private async readEditLockRow(): Promise<EditLockRow | null> {
    const noteId = await this.ctx.storage.get<string>(STORAGE_NOTE_ID_KEY);
    if (!noteId) {
      return null;
    }
    return db(this.env)
      .prepare("SELECT edit_locked FROM notes WHERE id = ?")
      .bind(noteId)
      .first<EditLockRow>();
  }

  private async ensureInitialized(noteId?: string): Promise<void> {
    if (noteId) {
      const existing = await this.ctx.storage.get<string>(STORAGE_NOTE_ID_KEY);
      if (!existing) {
        await this.ctx.storage.put(STORAGE_NOTE_ID_KEY, noteId);
      }
    }

    if (this.doc) {
      return;
    }

    if (!this.loading) {
      this.loading = this.initializeDocument();
    }
    await this.loading;
  }

  private async initializeDocument(): Promise<void> {
    if (this.doc) {
      return;
    }

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    const storedUpdate =
      await this.ctx.storage.get<ArrayBuffer>(STORAGE_YJS_KEY);
    if (storedUpdate && storedUpdate.byteLength > 0) {
      Y.applyUpdate(doc, new Uint8Array(storedUpdate));
    } else {
      const noteId = await this.ctx.storage.get<string>(STORAGE_NOTE_ID_KEY);
      if (noteId) {
        const row = await db(this.env)
          .prepare("SELECT markdown_snapshot FROM notes WHERE id = ?")
          .bind(noteId)
          .first<{ markdown_snapshot: string }>();

        const snapshot = row?.markdown_snapshot ?? "";
        if (snapshot.length > 0) {
          doc.getText("markdown").insert(0, snapshot);
          await this.persistYjsState(doc);
        }
      }
    }

    doc.getText("markdown").observe((event, transaction) => {
      this.onMarkdownHistory(event, transaction);
    });

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.ctx.waitUntil(this.onDocUpdate(update, origin));
    });

    awareness.on("update", (changes: AwarenessChanges, origin: unknown) => {
      this.trackOwnedAwareness(changes, origin);
      this.broadcastAwarenessDiff(changes, origin);
    });

    this.doc = doc;
    this.awareness = awareness;
  }

  private async onDocUpdate(
    update: Uint8Array,
    origin: unknown,
  ): Promise<void> {
    const doc = this.doc;
    if (!doc) {
      return;
    }

    await this.persistYjsState(doc);
    this.broadcastSyncUpdate(update, origin);
  }

  private async persistYjsState(doc: Y.Doc): Promise<void> {
    const merged = Y.encodeStateAsUpdate(doc);
    await this.snapshots.persist(merged, doc.getText("markdown").toString());
  }

  private broadcastSyncUpdate(update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const payload = encoding.toUint8Array(encoder);

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === origin) {
        continue;
      }
      try {
        ws.send(payload);
      } catch {
        // 切断済み接続は無視する。
      }
    }
  }

  private trackOwnedAwareness(
    changes: AwarenessChanges,
    origin: unknown,
  ): void {
    if (!isRoomSocket(origin)) {
      return;
    }

    const attachment = origin.deserializeAttachment() as WsAttachment | null;
    if (!attachment) {
      return;
    }

    const owned = applyOwnedClientChanges(
      attachment.awarenessClientIds ?? [],
      changes,
    );
    attachment.awarenessClientIds = owned;
    attachment.awarenessClocks = nextAwarenessClocks(
      attachment.awarenessClocks ?? {},
      owned,
      changes,
      (clientId) => this.awareness?.meta.get(clientId)?.clock,
    );
    origin.serializeAttachment(attachment);
  }

  private broadcastAwarenessDiff(
    changes: AwarenessChanges,
    origin: unknown,
  ): void {
    const awareness = this.awareness;
    if (!awareness) {
      return;
    }

    const clients = clientsForAwarenessBroadcast(changes);
    if (clients.length === 0) {
      return;
    }

    const withMeta = clients.filter((id) => awareness.meta.has(id));
    const withoutMeta = clients.filter((id) => !awareness.meta.has(id));

    if (withMeta.length > 0) {
      this.sendAwarenessUpdate(
        awarenessProtocol.encodeAwarenessUpdate(awareness, withMeta),
        origin,
      );
    }
    if (withoutMeta.length > 0) {
      this.sendAwarenessUpdate(
        encodeAwarenessNullUpdate(
          withoutMeta.map((clientId) => ({
            clientId,
            clock: clockForRemoval(undefined),
          })),
        ),
        origin,
      );
    }
  }

  private sendAwarenessUpdate(update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const payload = encoding.toUint8Array(encoder);

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === origin) {
        continue;
      }
      try {
        ws.send(payload);
      } catch {
        // 切断済み接続は無視する。
      }
    }
  }

  private touchAgentPresence(
    agent: AgentPresenceInput,
    cursor: AgentCursor,
  ): void {
    const awareness = this.awareness;
    const ytext = this.doc?.getText("markdown");
    if (!(awareness && ytext)) {
      return;
    }
    awareness.setLocalState(agentAwarenessState(agent, ytext, cursor));
    this.scheduleAgentIdle();
  }

  private scheduleAgentIdle(): void {
    this.stopAgentIdle();
    this.agentIdleTimer = setTimeout(() => {
      this.agentIdleTimer = null;
      this.awareness?.setLocalState(null);
    }, AGENT_IDLE_MS);
  }

  private stopAgentIdle(): void {
    if (this.agentIdleTimer !== null) {
      clearTimeout(this.agentIdleTimer);
      this.agentIdleTimer = null;
    }
  }

  async alarm(): Promise<void> {
    await this.flushSnapshotToD1();
  }

  private async flushSnapshotToD1(): Promise<void> {
    await this.snapshots.flush();
  }

  private onMarkdownHistory(
    event: Y.YTextEvent,
    transaction: Y.Transaction,
  ): void {
    if (shouldSkipHistoryOrigin(transaction.origin)) {
      return;
    }
    if (!isRoomSocket(transaction.origin)) {
      return;
    }

    const attachment =
      transaction.origin.deserializeAttachment() as WsAttachment | null;
    if (!attachment) {
      return;
    }

    const hunk = summarizeTextDelta(event.changes.delta);
    if (!hunk) {
      return;
    }

    const actor = actorFromWsAttachment(attachment);
    const session = this.historyPending.get(
      historyActorKey(actor, attachment.historySessionId),
    );
    const now = Date.now();
    const next = session
      ? applyHunkToSession(session, hunk, now)
      : sessionFromHunk(actor, hunk, now, attachment.historySessionId);
    this.historyPending.set(next.actorKey, next);
    this.historyMarkdown.set(
      next.actorKey,
      this.requireDoc().getText("markdown").toString(),
    );
    this.scheduleHistoryFlush(next.actorKey);
  }

  private async recordApplyEditHistory(
    input: ApplyEditInput,
    cursor: AgentCursor,
    nextMarkdown: string,
  ): Promise<void> {
    let deleted = input.op === "set";
    let newTextLength = 0;
    if (input.op === "insert") {
      newTextLength = input.text.length;
    } else if (input.op === "replace") {
      deleted = input.oldString.length > 0;
      newTextLength = input.newString.length;
    } else {
      newTextLength = input.markdown.length;
    }
    const session = sessionFromApplyEdit(
      actorFromAgent(input.agent),
      cursor,
      applyEditOp(input.op, newTextLength, deleted),
      Date.now(),
    );
    await this.persistHistorySession(session, nextMarkdown).catch(
      () => undefined,
    );
  }

  private scheduleHistoryFlush(actorKey: string): void {
    const existing = this.historyTimers.get(actorKey);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.historyTimers.set(
      actorKey,
      setTimeout(() => {
        this.historyTimers.delete(actorKey);
        void this.flushHistorySession(actorKey).catch(() => undefined);
      }, HISTORY_IDLE_MS),
    );
  }

  private async flushHistorySession(actorKey: string): Promise<void> {
    const timer = this.historyTimers.get(actorKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.historyTimers.delete(actorKey);
    }

    const session = this.historyPending.get(actorKey);
    if (!session) {
      return;
    }
    this.historyPending.delete(actorKey);

    const markdown =
      this.historyMarkdown.get(actorKey) ??
      this.doc?.getText("markdown").toString() ??
      "";
    this.historyMarkdown.delete(actorKey);
    await this.persistHistorySession(session, markdown);
  }

  private async persistHistorySession(
    session: PendingHistorySession,
    markdown: string,
  ): Promise<void> {
    const noteId = await this.ctx.storage.get<string>(STORAGE_NOTE_ID_KEY);
    if (!noteId) {
      return;
    }

    const excerpt = excerptAround(
      markdown,
      session.startOffset,
      session.endOffset,
    );
    await recordNoteEditEvent(
      this.env,
      noteId,
      eventFromSession(session, excerpt),
      markdown,
    );
  }
}

function cursorAfterSet(previous: string, next: string): AgentCursor {
  const max = Math.min(previous.length, next.length);
  let start = 0;
  while (start < max && previous[start] === next[start]) {
    start += 1;
  }
  return { anchor: start, head: next.length };
}
