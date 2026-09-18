import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import { ensureFolderRow } from "./access.ts";
import { readUserSettings, updateUserKnowledgeSettings } from "./settings.ts";

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
    DB: new D1DatabaseAdapter(sqlite),
    DEV_AUTH: "false",
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  return { env, owner, sqlite };
}

function storedSettings(sqlite: DatabaseSync, userId: string) {
  const row = sqlite
    .prepare("SELECT settings FROM users WHERE id = ?")
    .get(userId) as { settings: string | null } | undefined;
  return row?.settings ?? null;
}

function grantParaBucket(sqlite: DatabaseSync, ownerId: string) {
  sqlite
    .prepare(
      "INSERT INTO folders (id, owner_id, folder, para_bucket, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(crypto.randomUUID(), ownerId, "個人/Projects", "projects", Date.now());
}

test("readUserSettings returns defaults for a fresh user", async () => {
  const { env, owner } = await createEnv();
  const settings = await readUserSettings(env, owner.id);
  assert.deepEqual(settings, {
    knowledge: { layers: true, para: false, schemes: true },
  });
});

test("readUserSettings derives para=true from para_bucket rows and persists it", async () => {
  const { env, owner, sqlite } = await createEnv();
  grantParaBucket(sqlite, owner.id);

  const settings = await readUserSettings(env, owner.id);
  assert.equal(settings.knowledge.para, true);
  assert.equal(settings.knowledge.schemes, true);
  assert.equal(settings.knowledge.layers, true);

  const stored = JSON.parse(storedSettings(sqlite, owner.id) ?? "{}") as {
    knowledge?: { para?: boolean };
  };
  assert.equal(stored.knowledge?.para, true);
});

test("readUserSettings persists para=false when no para_bucket rows exist", async () => {
  const { env, owner, sqlite } = await createEnv();
  await readUserSettings(env, owner.id);
  const stored = JSON.parse(storedSettings(sqlite, owner.id) ?? "{}") as {
    knowledge?: { para?: boolean };
  };
  assert.equal(stored.knowledge?.para, false);
});

test("stored para flag wins over derivation", async () => {
  const { env, owner, sqlite } = await createEnv();
  grantParaBucket(sqlite, owner.id);
  sqlite
    .prepare("UPDATE users SET settings = ? WHERE id = ?")
    .run(JSON.stringify({ knowledge: { para: false } }), owner.id);

  const settings = await readUserSettings(env, owner.id);
  assert.equal(settings.knowledge.para, false);
});

test("readUserSettings tolerates broken JSON and missing users", async () => {
  const { env, owner, sqlite } = await createEnv();
  sqlite
    .prepare("UPDATE users SET settings = ? WHERE id = ?")
    .run("{not json", owner.id);
  const settings = await readUserSettings(env, owner.id);
  assert.deepEqual(settings.knowledge, {
    layers: true,
    para: false,
    schemes: true,
  });

  const missing = await readUserSettings(env, "no-such-user");
  assert.deepEqual(missing.knowledge, {
    layers: true,
    para: false,
    schemes: true,
  });
});

test("updateUserKnowledgeSettings merges a whitelisted boolean patch", async () => {
  const { env, owner, sqlite } = await createEnv();
  const settings = await updateUserKnowledgeSettings(env, owner.id, {
    layers: "maybe",
    para: true,
    schemes: 0,
    unknown: true,
  });
  assert.ok(settings);
  assert.deepEqual(settings.knowledge, {
    layers: true,
    para: true,
    schemes: true,
  });

  const stored = JSON.parse(storedSettings(sqlite, owner.id) ?? "{}") as {
    knowledge?: Record<string, unknown>;
  };
  assert.equal(stored.knowledge?.para, true);
  assert.equal(stored.knowledge?.unknown, undefined);
});

test("updateUserKnowledgeSettings preserves stored values and unknown top-level keys", async () => {
  const { env, owner, sqlite } = await createEnv();
  sqlite.prepare("UPDATE users SET settings = ? WHERE id = ?").run(
    JSON.stringify({
      future: { experimental: true },
      knowledge: { para: true, schemes: false },
    }),
    owner.id,
  );

  const settings = await updateUserKnowledgeSettings(env, owner.id, {
    layers: false,
  });
  assert.ok(settings);
  assert.deepEqual(settings.knowledge, {
    layers: false,
    para: true,
    schemes: false,
  });

  const stored = JSON.parse(storedSettings(sqlite, owner.id) ?? "{}") as {
    future?: unknown;
    knowledge?: Record<string, unknown>;
  };
  assert.deepEqual(stored.future, { experimental: true });
  assert.equal(stored.knowledge?.layers, false);
  assert.equal(stored.knowledge?.schemes, false);
});

test("updateUserKnowledgeSettings fills missing para via derivation", async () => {
  const { env, owner, sqlite } = await createEnv();
  grantParaBucket(sqlite, owner.id);
  const settings = await updateUserKnowledgeSettings(env, owner.id, {
    schemes: false,
  });
  assert.ok(settings);
  assert.equal(settings.knowledge.para, true);
  assert.equal(settings.knowledge.schemes, false);
});

test("updateUserKnowledgeSettings returns null for a missing user", async () => {
  const { env } = await createEnv();
  const settings = await updateUserKnowledgeSettings(env, "no-such-user", {
    para: true,
  });
  assert.equal(settings, null);
});

test("ensureFolderRow-root folders without para_bucket keep para off", async () => {
  const { env, owner } = await createEnv();
  await ensureFolderRow(env, owner.id, "");
  const settings = await readUserSettings(env, owner.id);
  assert.equal(settings.knowledge.para, false);
});
