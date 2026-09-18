import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EDIT_LOCKED_CODE } from "@miyulabmd/shared";
import { upsertUserByEmail } from "../db/users.ts";
import type { Env } from "../env.ts";
import { createImageService } from "./images.ts";

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
    db.exec(
      readFileSync(
        new URL(`../db/migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
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

function createEnv(sqlite: DatabaseSync): Env {
  return {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    DB: new D1DatabaseAdapter(sqlite),
    DEV_AUTH: "false",
    IMAGES: { put: async () => undefined },
  } as unknown as Env;
}

function insertNote(
  sqlite: DatabaseSync,
  ownerId: string,
  id: string,
  editLocked: number,
): void {
  sqlite
    .prepare(
      `INSERT INTO notes (id, short_id, owner_id, title, folder, permission,
         markdown_snapshot, created_at, updated_at, edit_locked)
       VALUES (?, ?, ?, '', '', 'private', '', 0, 0, ?)`,
    )
    .run(id, `s-${id}`, ownerId, editLocked);
}

function pngFile(): File {
  return new File([new Uint8Array([0x89, 0x50])], "a.png", {
    type: "image/png",
  });
}

test("upload rejects an edit-locked note with edit_locked", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  applyMigrations(sqlite);
  const env = createEnv(sqlite);
  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  insertNote(sqlite, owner.id, "n-locked", 1);

  const result = await createImageService(env).upload(
    "n-locked",
    owner,
    pngFile(),
  );
  assert.deepEqual(result, {
    code: EDIT_LOCKED_CODE,
    kind: "denied",
    status: 403,
  });
});

test("upload reaches validation for an unlocked note", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  applyMigrations(sqlite);
  const env = createEnv(sqlite);
  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  insertNote(sqlite, owner.id, "n-open", 0);

  const result = await createImageService(env).upload(
    "n-open",
    owner,
    new File([new Uint8Array([1])], "a.txt", { type: "text/plain" }),
  );
  // The lock gate is passed first; an unsupported type proves the upload
  // pipeline proceeds past it.
  assert.equal(result.kind, "bad_request");
});
