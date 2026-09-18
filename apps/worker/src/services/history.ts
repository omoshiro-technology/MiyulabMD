import {
  isNoteEditOp,
  isNoteHistoryActorKind,
  type NoteEditEvent,
  type NoteHistoryPage,
  type NoteRevisionBody,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 100;

export const HISTORY_EVENT_KEEP = 200;
export const HISTORY_REVISION_KEEP = 80;
export const HISTORY_REVISION_BYTES_KEEP = 8 * 1024 * 1024;

export type HistoryCompactionLimits = {
  eventKeep: number;
  revisionKeep: number;
  revisionBytesKeep: number;
};

export type HistoryRevisionCandidate = {
  id: string;
  r2Key: string;
  createdAt: number;
  byteSize: number;
  /** Pinned revisions (e.g. promote snapshots) are never dropped. */
  pinned?: boolean;
};

export type HistoryEventCandidate = {
  id: string;
  createdAt: number;
};

type EditEventRow = {
  id: string;
  note_id: string;
  revision_id: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  actor_name: string;
  started_at: number;
  ended_at: number;
  start_offset: number;
  end_offset: number;
  op: string;
  excerpt: string;
  created_at: number;
};

type RevisionRow = {
  id: string;
  note_id: string;
  event_id: string | null;
  r2_key: string;
  byte_size: number;
  actor_kind: string;
  actor_user_id: string | null;
  actor_name: string;
  created_at: number;
};

export function revisionObjectKey(noteId: string, revisionId: string): string {
  return `notes/${noteId}/revisions/${revisionId}.md`;
}

type HistoryEventInput = {
  actorKind: string;
  actorUserId: string | null;
  actorName: string;
  startedAt: number;
  endedAt: number;
  startOffset: number;
  endOffset: number;
  op: string;
  excerpt: string;
  createdAt?: number;
};

/** 編集イベントとリビジョン本文を残す。失敗しても呼び出し側の編集は落とさない。 */
export async function recordNoteEditEvent(
  env: Env,
  noteId: string,
  event: HistoryEventInput,
  markdown: string,
): Promise<void> {
  const eventId = crypto.randomUUID();
  const createdAt = event.createdAt ?? Date.now();
  let revisionId: string | null = null;

  try {
    revisionId = await persistRevision(
      env,
      noteId,
      eventId,
      event,
      markdown,
      createdAt,
    );
  } catch {
    revisionId = null;
  }

  try {
    await db(env)
      .prepare(
        `INSERT INTO note_edit_events (
           id, note_id, revision_id, actor_kind, actor_user_id, actor_name,
           started_at, ended_at, start_offset, end_offset, op, excerpt, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        eventId,
        noteId,
        revisionId,
        event.actorKind,
        event.actorUserId,
        event.actorName,
        event.startedAt,
        event.endedAt,
        event.startOffset,
        event.endOffset,
        event.op,
        event.excerpt,
        createdAt,
      )
      .run();
  } catch {
    // 履歴欠落は許容する。
    if (revisionId) {
      try {
        await env.IMAGES.delete(revisionObjectKey(noteId, revisionId));
        await db(env)
          .prepare("DELETE FROM note_revisions WHERE id = ? AND note_id = ?")
          .bind(revisionId, noteId)
          .run();
      } catch {
        // 孤立リビジョンの掃除もベストエフォートに留める。
      }
    }
    return;
  }

  try {
    await compactNoteHistory(env, noteId);
  } catch {
    // 間引き失敗は次の記録で再試行する。
  }
}

async function persistRevision(
  env: Env,
  noteId: string,
  eventId: string,
  event: HistoryEventInput,
  markdown: string,
  createdAt: number,
): Promise<string> {
  const revisionId = crypto.randomUUID();
  const r2Key = revisionObjectKey(noteId, revisionId);
  const body = new TextEncoder().encode(markdown);

  await env.IMAGES.put(r2Key, body, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  try {
    await db(env)
      .prepare(
        `INSERT INTO note_revisions (
           id, note_id, event_id, r2_key, byte_size,
           actor_kind, actor_user_id, actor_name, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        revisionId,
        noteId,
        eventId,
        r2Key,
        body.byteLength,
        event.actorKind,
        event.actorUserId,
        event.actorName,
        createdAt,
      )
      .run();
  } catch (error) {
    await env.IMAGES.delete(r2Key);
    throw error;
  }

  return revisionId;
}

export function planRevisionDrops(
  revisions: HistoryRevisionCandidate[],
  limits: Pick<HistoryCompactionLimits, "revisionKeep" | "revisionBytesKeep">,
): string[] {
  const revisionKeep = Math.max(1, Math.floor(limits.revisionKeep));
  const bytesKeep = Math.max(1, Math.floor(limits.revisionBytesKeep));
  const drop: string[] = [];
  let kept = 0;
  let bytes = 0;
  for (const revision of newestFirst(revisions)) {
    if (revision.pinned) {
      continue;
    }
    if (
      kept >= revisionKeep ||
      (kept > 0 && bytes + revision.byteSize > bytesKeep)
    ) {
      drop.push(revision.id);
      continue;
    }
    kept += 1;
    bytes += revision.byteSize;
  }
  return drop;
}

export function planEventDrops(
  events: HistoryEventCandidate[],
  eventKeep: number,
): string[] {
  const keep = Math.max(1, Math.floor(eventKeep));
  return newestFirst(events)
    .slice(keep)
    .map((event) => event.id);
}

/** ノートあたりの上限を超えた履歴を間引く。最新リビジョンは残す。 */
export async function compactNoteHistory(
  env: Env,
  noteId: string,
  limits: HistoryCompactionLimits = {
    eventKeep: HISTORY_EVENT_KEEP,
    revisionBytesKeep: HISTORY_REVISION_BYTES_KEEP,
    revisionKeep: HISTORY_REVISION_KEEP,
  },
): Promise<void> {
  const revisionRows = await db(env)
    .prepare(
      `SELECT id, r2_key, created_at, byte_size, pinned
       FROM note_revisions
       WHERE note_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(noteId)
    .all<{
      id: string;
      r2_key: string;
      created_at: number;
      byte_size: number;
      pinned: number;
    }>();
  const revisions = (revisionRows.results ?? []).map((row) => ({
    byteSize: row.byte_size,
    createdAt: row.created_at,
    id: row.id,
    pinned: row.pinned === 1,
    r2Key: row.r2_key,
  }));
  const dropRevisionIds = new Set(planRevisionDrops(revisions, limits));

  const eventRows = await db(env)
    .prepare(
      `SELECT id, created_at, revision_id
       FROM note_edit_events
       WHERE note_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(noteId)
    .all<{ id: string; created_at: number; revision_id: string | null }>();
  const events = eventRows.results ?? [];
  const dropEventIds = new Set(
    planEventDrops(
      events.map((row) => ({ createdAt: row.created_at, id: row.id })),
      limits.eventKeep,
    ),
  );

  for (const event of events) {
    if (dropEventIds.has(event.id) && event.revision_id) {
      dropRevisionIds.add(event.revision_id);
    }
  }

  const newestRevisionId = revisions[0]?.id;
  if (newestRevisionId) {
    dropRevisionIds.delete(newestRevisionId);
  }

  const revisionById = new Map(
    revisions.map((revision) => [revision.id, revision]),
  );
  for (const revisionId of dropRevisionIds) {
    const revision = revisionById.get(revisionId);
    if (!revision) {
      continue;
    }
    await env.IMAGES.delete(revision.r2Key);
    await db(env)
      .prepare(
        `UPDATE note_edit_events
         SET revision_id = NULL
         WHERE note_id = ? AND revision_id = ?`,
      )
      .bind(noteId, revisionId)
      .run();
    await db(env)
      .prepare("DELETE FROM note_revisions WHERE id = ? AND note_id = ?")
      .bind(revisionId, noteId)
      .run();
  }

  for (const eventId of dropEventIds) {
    await db(env)
      .prepare("DELETE FROM note_edit_events WHERE id = ? AND note_id = ?")
      .bind(eventId, noteId)
      .run();
  }
}

function newestFirst<T extends { createdAt: number; id: string }>(
  items: T[],
): T[] {
  return [...items].sort((left, right) => {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    if (right.id === left.id) {
      return 0;
    }
    return right.id < left.id ? -1 : 1;
  });
}

/** ノート削除時にリビジョン本文を R2 から消す。 */
export async function deleteRevisionsForNote(
  env: Env,
  noteId: string,
): Promise<void> {
  const rows = await db(env)
    .prepare("SELECT r2_key FROM note_revisions WHERE note_id = ?")
    .bind(noteId)
    .all<{ r2_key: string }>();

  const keys = rows.results ?? [];
  if (keys.length === 0) {
    return;
  }

  await Promise.all(keys.map((entry) => env.IMAGES.delete(entry.r2_key)));
}

export async function listNoteEditEvents(
  env: Env,
  noteId: string,
  query: { limit?: number; before?: number } = {},
): Promise<NoteHistoryPage> {
  const limit = clampLimit(query.limit);
  const binds: (string | number)[] = [noteId];
  let sql = `SELECT id, note_id, revision_id, actor_kind, actor_user_id, actor_name,
                    started_at, ended_at, start_offset, end_offset, op, excerpt, created_at
             FROM note_edit_events
             WHERE note_id = ?`;
  if (query.before !== undefined) {
    sql += " AND created_at < ?";
    binds.push(query.before);
  }
  sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
  binds.push(limit + 1);

  const rows = await db(env)
    .prepare(sql)
    .bind(...binds)
    .all<EditEventRow>();
  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const last = page.at(-1);

  return {
    events: page.map(toEditEvent),
    nextBefore: hasMore && last ? last.created_at : null,
  };
}

export async function getNoteRevision(
  env: Env,
  noteId: string,
  revisionId: string,
): Promise<NoteRevisionBody | null> {
  const row = await db(env)
    .prepare(
      `SELECT id, note_id, event_id, r2_key, byte_size,
              actor_kind, actor_user_id, actor_name, created_at
       FROM note_revisions
       WHERE id = ? AND note_id = ?`,
    )
    .bind(revisionId, noteId)
    .first<RevisionRow>();
  if (!row) {
    return null;
  }

  const object = await env.IMAGES.get(row.r2_key);
  if (!object) {
    return null;
  }

  return {
    actor: {
      kind: isNoteHistoryActorKind(row.actor_kind) ? row.actor_kind : "guest",
      name: row.actor_name,
      userId: row.actor_user_id,
    },
    byteSize: row.byte_size,
    createdAt: row.created_at,
    eventId: row.event_id,
    id: row.id,
    markdown: await object.text(),
    noteId: row.note_id,
    r2Key: row.r2_key,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return HISTORY_DEFAULT_LIMIT;
  }
  return Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function toEditEvent(row: EditEventRow): NoteEditEvent {
  return {
    actor: {
      kind: isNoteHistoryActorKind(row.actor_kind) ? row.actor_kind : "guest",
      name: row.actor_name,
      userId: row.actor_user_id,
    },
    createdAt: row.created_at,
    endedAt: row.ended_at,
    endOffset: row.end_offset,
    excerpt: row.excerpt,
    id: row.id,
    noteId: row.note_id,
    op: isNoteEditOp(row.op) ? row.op : "replace",
    revisionId: row.revision_id,
    startedAt: row.started_at,
    startOffset: row.start_offset,
  };
}
