import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import { buildAccessSnapshot } from "./access.ts";
import { createNoteService } from "./notes.ts";

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

class CountingD1Adapter {
  private readonly db: DatabaseSync;
  queries = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(query: string): BoundStatement {
    this.queries += 1;
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

async function createEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const d1 = new CountingD1Adapter(sqlite);

  const env = {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ALLOW_ANONYMOUS: "false",
    ALLOW_ANONYMOUS_EDITS: "true",
    ALLOW_ANONYMOUS_VIEWS: "true",
    DB: d1,
    DEFAULT_PERMISSION: "editable",
    DEV_AUTH: "false",
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  return { d1, env, owner, sqlite };
}

test("listForUser query count stays bounded as note count grows", async (t) => {
  const { d1, env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const counts: number[] = [];
  let created = 0;
  for (const noteCount of [10, 30]) {
    for (; created < noteCount; created += 1) {
      await notes.create(owner, {
        folder: `folder-${created % 5}`,
        markdown: `# note-${created}`,
        title: `note-${created}`,
      });
    }
    d1.queries = 0;
    const list = await notes.listForUser(owner);
    assert.equal(list.length, noteCount);
    counts.push(d1.queries);
  }

  // N+1 だと 30 ノートで ~180 queries。バッチ化後は定数+αであるべき。
  t.diagnostic(`queries: 10 notes -> ${counts[0]}, 30 notes -> ${counts[1]}`);
  assert.ok(
    counts[1] <= counts[0] + 3,
    `query count grew with notes: ${counts[0]} -> ${counts[1]}`,
  );
  assert.ok(counts[1] <= 20, `too many queries: ${counts[1]}`);
});

test("buildAccessSnapshot chunks owner ids beyond the D1 bind limit", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const ownerIds: string[] = [owner.id];
  // SNAPSHOT_OWNER_CHUNK(50) を超えるオーナー数で IN 句が分割されること。
  for (let i = 0; i < 55; i += 1) {
    const user = await upsertUserByEmail(env, `u${i}@example.com`, `u${i}`);
    ownerIds.push(user.id);
    await notes.create(user, {
      folder: `f${i}`,
      markdown: `# note-${i}`,
      title: `note-${i}`,
    });
  }

  const snapshot = await buildAccessSnapshot(env, ownerIds);
  // ノート未作成の owner 以外の 55 オーナー分が取れていること。
  assert.equal(snapshot.foldersByPath.size, 55);
  assert.equal(snapshot.foldersByPath.get(ownerIds[5])?.has("f4"), true);
});

test("listForUser returns folder ids and schemes from snapshot path", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const created = await notes.create(owner, {
    folder: "work/deep",
    markdown: "# nested",
    title: "nested",
  });
  const list = await notes.listForUser(owner);
  const summary = list.find((note) => note.id === created.id);
  assert.ok(summary);
  assert.equal(summary.folder, "work/deep");
  assert.ok(summary.folderId);
  assert.equal(summary.editLocked, false);
});
