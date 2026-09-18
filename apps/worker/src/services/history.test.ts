import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { upsertUserByEmail } from "../db/users.ts";
import {
  compactNoteHistory,
  deleteRevisionsForNote,
  getNoteRevision,
  listNoteEditEvents,
  planEventDrops,
  planRevisionDrops,
  recordNoteEditEvent,
  revisionObjectKey,
} from "./history.ts";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_folders.sql",
  "0003_access_scopes.sql",
  "0004_folders_registry.sql",
  "0005_folder_ids.sql",
  "0006_article_sources.sql",
  "0007_user_root_folders.sql",
  "0008_split_link_and_public_scopes.sql",
  "0009_note_history.sql",
  "0010_note_links.sql",
  "0011_para_buckets.sql",
  "0012_naming_schemes.sql",
  "0013_medallion_layers.sql",
  "0014_notes_fts.sql",

  "0015_user_settings.sql",
  "0016_para_spaces.sql",
  "0017_medallion_sets_edit_lock.sql",
  "0018_scheme_root.sql",
];

function applyMigrations(db: DatabaseSync): void {
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(
      new URL(`../db/migrations/${migration}`, import.meta.url),
      "utf8",
    );
    db.exec(sql);
  }
}

type BoundStatement = {
  bind: (...values: unknown[]) => BoundStatement;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  run: () => Promise<{ success: true }>;
};

class StatementAdapter implements BoundStatement {
  private readonly db: DatabaseSync;
  private readonly query: string;
  private readonly binds: unknown[];

  constructor(db: DatabaseSync, query: string, binds: unknown[] = []) {
    this.db = db;
    this.query = query;
    this.binds = binds;
  }

  bind(...values: unknown[]): BoundStatement {
    return new StatementAdapter(this.db, this.query, values);
  }

  all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.query).all(...this.binds);
    return Promise.resolve({ results: rows as T[] });
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...this.binds);
    return Promise.resolve((row as T | null) ?? null);
  }

  runSync(): { success: true } {
    this.db.prepare(this.query).run(...this.binds);
    return { success: true };
  }

  run(): Promise<{ success: true }> {
    return Promise.resolve(this.runSync());
  }
}

class D1DatabaseAdapter {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(query: string): BoundStatement {
    return new StatementAdapter(this.db, query);
  }

  batch(statements: BoundStatement[]) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as StatementAdapter).runSync(),
      );
      this.db.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  failPut = false;

  put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.failPut) {
      return Promise.reject(new Error("r2 put failed"));
    }
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer);
    this.objects.set(key, bytes);
    return Promise.resolve();
  }

  get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const bytes = this.objects.get(key);
    if (!bytes) {
      return Promise.resolve(null);
    }
    const text = new TextDecoder().decode(bytes);
    return Promise.resolve({
      text: () => Promise.resolve(text),
    });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  text(key: string): string | undefined {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }
}

const EVENT = {
  actorKind: "user",
  actorName: "Alice",
  actorUserId: "u1",
  endedAt: 2,
  endOffset: 5,
  excerpt: "hello",
  op: "insert",
  startedAt: 1,
  startOffset: 0,
};

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const r2 = new MemoryR2();
  const env = {
    DB: new D1DatabaseAdapter(sqlite),
    IMAGES: r2,
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  sqlite
    .prepare(
      `INSERT INTO notes (
         id, short_id, owner_id, title, permission, markdown_snapshot, created_at, updated_at
       ) VALUES (?, ?, ?, 'Untitled', 'private', '', 1, 1)`,
    )
    .run("note-1", "abcd1234", owner.id);

  return { env, r2, sqlite };
}

test("revisionObjectKey uses the notes revisions prefix", () => {
  assert.equal(
    revisionObjectKey("note-1", "rev-1"),
    "notes/note-1/revisions/rev-1.md",
  );
});

test("recordNoteEditEvent writes R2 body and D1 metadata", async () => {
  const { env, r2, sqlite } = await setup();
  const markdown = "# Hello\n\nworld";

  await recordNoteEditEvent(env, "note-1", EVENT, markdown);

  const event = sqlite
    .prepare(
      "SELECT id, revision_id, excerpt FROM note_edit_events WHERE note_id = ?",
    )
    .get("note-1") as { id: string; revision_id: string; excerpt: string };
  assert.equal(event.excerpt, "hello");
  assert.ok(event.revision_id);

  const revision = sqlite
    .prepare(
      "SELECT id, event_id, r2_key, byte_size FROM note_revisions WHERE id = ?",
    )
    .get(event.revision_id) as {
    id: string;
    event_id: string;
    r2_key: string;
    byte_size: number;
  };
  assert.equal(revision.event_id, event.id);
  assert.equal(revision.r2_key, revisionObjectKey("note-1", revision.id));
  assert.equal(
    revision.byte_size,
    new TextEncoder().encode(markdown).byteLength,
  );
  assert.equal(r2.text(revision.r2_key), markdown);
});

test("recordNoteEditEvent keeps the event when R2 write fails", async () => {
  const { env, r2, sqlite } = await setup();
  r2.failPut = true;

  await recordNoteEditEvent(env, "note-1", EVENT, "# x");

  const event = sqlite
    .prepare("SELECT revision_id FROM note_edit_events WHERE note_id = ?")
    .get("note-1") as { revision_id: string | null };
  assert.equal(event.revision_id, null);
  assert.equal(r2.objects.size, 0);
});

test("listNoteEditEvents pages newest first", async () => {
  const { env } = await setup();
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 100, excerpt: "first" },
    "# 1",
  );
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 200, excerpt: "second" },
    "# 2",
  );

  const firstPage = await listNoteEditEvents(env, "note-1", { limit: 1 });
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.events[0]?.excerpt, "second");
  assert.ok(firstPage.nextBefore);

  const secondPage = await listNoteEditEvents(env, "note-1", {
    before: firstPage.nextBefore ?? undefined,
    limit: 1,
  });
  assert.equal(secondPage.events[0]?.excerpt, "first");
});

test("getNoteRevision returns the stored markdown", async () => {
  const { env } = await setup();
  await recordNoteEditEvent(env, "note-1", EVENT, "# Hello\n\nworld");
  const page = await listNoteEditEvents(env, "note-1");
  const revisionId = page.events[0]?.revisionId;
  assert.ok(revisionId);

  const revision = await getNoteRevision(env, "note-1", revisionId);
  assert.equal(revision?.markdown, "# Hello\n\nworld");
  assert.equal(revision?.noteId, "note-1");
});

test("deleteRevisionsForNote removes R2 objects", async () => {
  const { env, r2 } = await setup();
  await recordNoteEditEvent(env, "note-1", EVENT, "# keep");
  assert.equal(r2.objects.size, 1);

  await deleteRevisionsForNote(env, "note-1");
  assert.equal(r2.objects.size, 0);
});

test("planRevisionDrops keeps the newest when over the count", () => {
  const drop = planRevisionDrops(
    [
      { byteSize: 10, createdAt: 1, id: "old", r2Key: "a" },
      { byteSize: 10, createdAt: 2, id: "new", r2Key: "b" },
    ],
    { revisionBytesKeep: 10_000, revisionKeep: 1 },
  );
  assert.deepEqual(drop, ["old"]);
});

test("planRevisionDrops keeps the newest even when it exceeds the byte budget", () => {
  const drop = planRevisionDrops(
    [
      { byteSize: 4, createdAt: 1, id: "old", r2Key: "a" },
      { byteSize: 100, createdAt: 2, id: "new", r2Key: "b" },
    ],
    { revisionBytesKeep: 10, revisionKeep: 10 },
  );
  assert.deepEqual(drop, ["old"]);
});

test("planEventDrops keeps the newest events", () => {
  assert.deepEqual(
    planEventDrops(
      [
        { createdAt: 1, id: "a" },
        { createdAt: 3, id: "c" },
        { createdAt: 2, id: "b" },
      ],
      2,
    ),
    ["a"],
  );
});

test("compactNoteHistory drops old revision bodies first", async () => {
  const { env, r2, sqlite } = await setup();
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 10, excerpt: "old" },
    "# old",
  );
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 20, excerpt: "new" },
    "# new",
  );

  await compactNoteHistory(env, "note-1", {
    eventKeep: 10,
    revisionBytesKeep: 10_000,
    revisionKeep: 1,
  });

  const events = await listNoteEditEvents(env, "note-1");
  assert.equal(events.events.length, 2);
  const newest = events.events[0];
  const oldest = events.events[1];
  assert.equal(newest?.excerpt, "new");
  assert.ok(newest?.revisionId);
  assert.equal(oldest?.revisionId, null);

  const revisionCount = sqlite
    .prepare("SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?")
    .get("note-1") as { n: number };
  assert.equal(revisionCount.n, 1);
  assert.equal(r2.objects.size, 1);
  assert.equal(
    (await getNoteRevision(env, "note-1", newest?.revisionId ?? ""))?.markdown,
    "# new",
  );
});

test("compactNoteHistory deletes events past the keep count", async () => {
  const { env } = await setup();
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 1, excerpt: "first" },
    "# 1",
  );
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 2, excerpt: "second" },
    "# 2",
  );
  await recordNoteEditEvent(
    env,
    "note-1",
    { ...EVENT, createdAt: 3, excerpt: "third" },
    "# 3",
  );

  await compactNoteHistory(env, "note-1", {
    eventKeep: 2,
    revisionBytesKeep: 10_000,
    revisionKeep: 10,
  });

  const events = await listNoteEditEvents(env, "note-1");
  assert.equal(
    events.events.map((event) => event.excerpt).join(","),
    "third,second",
  );
  assert.ok(events.events[0]?.revisionId);
});
