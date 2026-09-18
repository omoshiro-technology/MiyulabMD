import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import {
  buildAccessSnapshot,
  ensureFolderRow,
  listFolderChildren,
  resolveFolderAccess,
} from "./access.ts";
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

test("resolveFolderAccess query count stays bounded as folder count grows", async (t) => {
  const { d1, env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const counts: number[] = [];
  let created = 0;
  for (const folderCount of [5, 20]) {
    for (; created < folderCount; created += 1) {
      await ensureFolderRow(env, owner.id, `area-${created}/sub`);
    }
    d1.queries = 0;
    const snapshot = await buildAccessSnapshot(env, [owner.id]);
    const buildQueries = d1.queries;
    d1.queries = 0;
    const access = await resolveFolderAccess(
      env,
      owner.id,
      "area-0",
      owner,
      snapshot,
    );
    assert.equal(access.name, "area-0");
    counts.push(d1.queries);
    t.diagnostic(
      `folders=${folderCount} build=${buildQueries} resolve=${d1.queries}`,
    );
  }

  assert.ok(
    counts[1] <= counts[0] + 3,
    `query count grew with folders: ${counts[0]} -> ${counts[1]}`,
  );
  // スナップショット経路では crumbs/children/scheme まで全てメモリ解決できる。
  assert.ok(counts[1] <= 3, `too many queries with snapshot: ${counts[1]}`);
});

test("listFolderChildren query count stays bounded as folder count grows", async (t) => {
  const { d1, env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const counts: number[] = [];
  let created = 0;
  for (const folderCount of [5, 20]) {
    for (; created < folderCount; created += 1) {
      await ensureFolderRow(env, owner.id, `root/area-${created}`);
      await notes.create(owner, {
        folder: "root",
        markdown: `# n-${created}`,
        title: `n-${created}`,
      });
    }
    const root = await ensureFolderRow(env, owner.id, "root");
    assert.ok(root);
    d1.queries = 0;
    const snapshot = await buildAccessSnapshot(env, [owner.id]);
    d1.queries = 0;
    const result = await listFolderChildren(
      env,
      owner.id,
      "root",
      root,
      owner,
      {},
      snapshot,
    );
    assert.equal(result.entries.length, folderCount * 2);
    counts.push(d1.queries);
    t.diagnostic(`folders=${folderCount} children=${d1.queries}`);
  }

  assert.ok(
    counts[1] <= counts[0] + 3,
    `query count grew with folders: ${counts[0]} -> ${counts[1]}`,
  );
});
