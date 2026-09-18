import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionUser } from "@miyulabmd/shared";
import { upsertUserByEmail } from "../db/users.ts";
import { ensureFolderRow } from "./access.ts";
import { createNoteService, persistMarkdownSnapshot } from "./notes.ts";

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

async function createEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  const env = {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ALLOW_ANONYMOUS: "false",
    ALLOW_ANONYMOUS_EDITS: "true",
    ALLOW_ANONYMOUS_VIEWS: "true",
    DB: new D1DatabaseAdapter(sqlite),
    DEFAULT_PERMISSION: "editable",
    DEV_AUTH: "false",
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  await ensureFolderRow(env, owner.id, "");

  return { env, owner, sqlite };
}

async function createNote(
  env: Env,
  owner: SessionUser,
  markdown = "# 元タイトル\n\n本文。",
) {
  const notes = createNoteService(env);
  const created = await notes.create(owner, { markdown });
  assert.ok(!("error" in created));
  if ("error" in created) {
    throw new Error("unreachable");
  }
  return created;
}

function snapshotRow(sqlite: DatabaseSync, id: string) {
  return sqlite
    .prepare("SELECT markdown_snapshot, title FROM notes WHERE id = ?")
    .get(id) as { markdown_snapshot: string; title: string };
}

test("persistMarkdownSnapshot writes for an unlocked note", async () => {
  const { env, owner, sqlite } = await createEnv();
  const created = await createNote(env, owner);

  const result = await persistMarkdownSnapshot(
    env,
    created.id,
    "# 新タイトル\n\n変更。",
  );

  assert.equal(result, "persisted");
  const row = snapshotRow(sqlite, created.id);
  assert.equal(row.markdown_snapshot, "# 新タイトル\n\n変更。");
  assert.equal(row.title, "新タイトル");
});

test("persistMarkdownSnapshot skips the write while the note is edit-locked", async () => {
  const { env, owner, sqlite } = await createEnv();
  const created = await createNote(env, owner);
  const notes = createNoteService(env);
  const locked = await notes.setEditLock(created.id, owner, true);
  assert.equal(locked.kind, "ok");

  // Live session was connected before the lock: the durable boundary
  // must refuse the snapshot write even though the DO accepted the edit,
  // and the skip must be visible so the outbox drops the pending snapshot
  // instead of reporting a saved snapshot.
  const result = await persistMarkdownSnapshot(
    env,
    created.id,
    "# 書き換え\n\nロック越し。",
  );

  assert.equal(result, "rejected");
  const row = snapshotRow(sqlite, created.id);
  assert.equal(row.markdown_snapshot, "# 元タイトル\n\n本文。");
  assert.equal(row.title, "元タイトル");
});

test("persistMarkdownSnapshot writes again after an explicit unlock", async () => {
  const { env, owner, sqlite } = await createEnv();
  const created = await createNote(env, owner);
  const notes = createNoteService(env);
  await notes.setEditLock(created.id, owner, true);
  await notes.setEditLock(created.id, owner, false);

  await persistMarkdownSnapshot(env, created.id, "# 解除後\n\n変更。");

  const row = snapshotRow(sqlite, created.id);
  assert.equal(row.markdown_snapshot, "# 解除後\n\n変更。");
  assert.equal(row.title, "解除後");

  // Re-lock → writes refused again.
  await notes.setEditLock(created.id, owner, true);
  await persistMarkdownSnapshot(env, created.id, "# 再ロック後\n\n変更。");
  const relocked = snapshotRow(sqlite, created.id);
  assert.equal(relocked.markdown_snapshot, "# 解除後\n\n変更。");
});
