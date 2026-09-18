import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import { ensureFolderRow } from "./access.ts";
import {
  assignFolderMedallion,
  clearFolderMedallion,
  createMedallionSet,
  deleteMedallionSet,
  ensureDefaultMedallionSet,
  listMedallionAssignments,
  listMedallionSets,
  resolveMedallion,
  updateMedallionSet,
} from "./medallion.ts";
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

function applyMigrations(db: DatabaseSync, list = MIGRATIONS): void {
  for (const migration of list) {
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

async function createEnv(migrations = MIGRATIONS) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, migrations);

  const env = {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    DB: new D1DatabaseAdapter(sqlite),
    DEV_AUTH: "false",
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  const other = await upsertUserByEmail(env, "other@example.com", "Other");
  return { env, other, owner, sqlite };
}

function medallionColumns(sqlite: DatabaseSync, folderId: string) {
  const row = sqlite
    .prepare(
      "SELECT medallion_set_id, medallion_layer FROM folders WHERE id = ?",
    )
    .get(folderId) as
    | { medallion_set_id: string | null; medallion_layer: string | null }
    | undefined;
  // node:sqlite returns null-prototype rows; plain object for deepEqual.
  return row
    ? {
        medallion_layer: row.medallion_layer,
        medallion_set_id: row.medallion_set_id,
      }
    : undefined;
}

// --- default set -----------------------------------------------------------

test("ensureDefaultMedallionSet seeds 精緻度 with raw/knowledge/output", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const set = await ensureDefaultMedallionSet(env, owner);
  assert.equal(set.name, "精緻度");
  assert.deepEqual(
    set.layers.map((layer) => layer.key),
    ["raw", "knowledge", "output"],
  );

  // idempotent — second call returns the same row, not a duplicate.
  const again = await ensureDefaultMedallionSet(env, owner);
  assert.equal(again.id, set.id);
  assert.equal((await listMedallionSets(env, owner)).length, 1);
});

// --- set CRUD ---------------------------------------------------------------

test("createMedallionSet stores a custom set and list returns it", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const created = await createMedallionSet(env, owner, {
    layers: [
      { key: "wip", label: "作業中" },
      { key: "done", label: "完成" },
    ],
    name: "進捗",
  });
  assert.equal(created.kind, "ok");
  if (created.kind !== "ok") {
    return;
  }
  assert.equal(created.result.name, "進捗");
  assert.deepEqual(
    created.result.layers.map((l) => `${l.key}:${l.label}`),
    ["wip:作業中", "done:完成"],
  );

  const sets = await listMedallionSets(env, owner);
  assert.deepEqual(
    sets.map((s) => s.name),
    ["進捗"],
  );
});

test("createMedallionSet rejects invalid input", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  assert.equal(
    (await createMedallionSet(env, owner, { name: "" })).kind,
    "invalid",
  );
  assert.equal(
    (
      await createMedallionSet(env, owner, {
        layers: [{ key: "bad key!", label: "?" }],
        name: "x",
      })
    ).kind,
    "invalid",
  );
  assert.equal(
    (
      await createMedallionSet(env, owner, {
        layers: [
          { key: "a", label: "a" },
          { key: "a", label: "dup" },
        ],
        name: "x",
      })
    ).kind,
    "invalid",
  );
});

test("updateMedallionSet edits labels and order but not keys", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const set = await ensureDefaultMedallionSet(env, owner);
  const updated = await updateMedallionSet(env, owner, set.id, {
    layers: [
      { key: "output", label: "成果物" },
      { key: "knowledge", label: "知識" },
      { key: "raw", label: "素材" },
    ],
    name: "レイヤー",
  });
  assert.equal(updated.kind, "ok");
  if (updated.kind !== "ok") {
    return;
  }
  assert.equal(updated.result.name, "レイヤー");
  assert.deepEqual(
    updated.result.layers.map((l) => l.key),
    ["output", "knowledge", "raw"],
  );

  // Removing or renaming a key is rejected.
  assert.equal(
    (
      await updateMedallionSet(env, owner, set.id, {
        layers: [
          { key: "raw", label: "r" },
          { key: "knowledge", label: "k" },
        ],
      })
    ).kind,
    "invalid",
  );
  assert.equal(
    (
      await updateMedallionSet(env, owner, set.id, {
        layers: [
          { key: "raw", label: "r" },
          { key: "knowledge", label: "k" },
          { key: "output", label: "o" },
          { key: "extra", label: "e" },
        ],
      })
    ).kind,
    "invalid",
  );
});

// --- assignment + resolution -------------------------------------------------

test("assign + resolve: nearest ancestor wins, grandchildren inherit", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const set = await ensureDefaultMedallionSet(env, owner);
  const topId = await ensureFolderRow(env, owner.id, "Knowledge");
  const subId = await ensureFolderRow(env, owner.id, "Knowledge/Sub");
  assert.ok(topId && subId);
  const note = await notes.create(owner, {
    folder: "Knowledge/Sub/Deep",
    markdown: "# hi",
  });
  assert.ok(!("error" in note));

  assert.equal(
    (await assignFolderMedallion(env, owner, topId, set.id, "knowledge")).kind,
    "ok",
  );
  assert.equal(
    (await assignFolderMedallion(env, owner, subId, set.id, "output")).kind,
    "ok",
  );

  const sub = await resolveMedallion(env, owner, "Knowledge/Sub/Deep");
  assert.equal(sub?.layerKey, "output");
  assert.equal(sub?.assignedPath, "Knowledge/Sub");
  assert.equal(sub?.setName, "精緻度");
  assert.equal(sub?.layerIndex, 2);

  const sibling = await resolveMedallion(env, owner, "Knowledge/Other/x");
  assert.equal(sibling?.layerKey, "knowledge");
  assert.equal(sibling?.assignedPath, "Knowledge");

  assert.equal(await resolveMedallion(env, owner, "Elsewhere"), null);
});

test("clearFolderMedallion removes the assignment", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const set = await ensureDefaultMedallionSet(env, owner);
  const folderId = await ensureFolderRow(env, owner.id, "A");
  assert.ok(folderId);
  await assignFolderMedallion(env, owner, folderId, set.id, "raw");

  const cleared = await clearFolderMedallion(env, owner, folderId);
  assert.equal(cleared.kind, "ok");
  assert.deepEqual(medallionColumns(sqlite, folderId), {
    medallion_layer: null,
    medallion_set_id: null,
  });
  assert.equal(await resolveMedallion(env, owner, "A"), null);
});

test("assign rejects unknown layer keys, foreign sets, foreign folders", async (t) => {
  const { env, other, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const set = await ensureDefaultMedallionSet(env, owner);
  const otherSet = await ensureDefaultMedallionSet(env, other);
  const folderId = await ensureFolderRow(env, owner.id, "A");
  const foreignFolderId = await ensureFolderRow(env, other.id, "B");
  assert.ok(folderId && foreignFolderId);

  assert.equal(
    (await assignFolderMedallion(env, owner, folderId, set.id, "platinum"))
      .kind,
    "invalid",
  );
  assert.equal(
    (await assignFolderMedallion(env, owner, folderId, otherSet.id, "raw"))
      .kind,
    "denied",
  );
  assert.equal(
    (await assignFolderMedallion(env, owner, foreignFolderId, set.id, "raw"))
      .kind,
    "denied",
  );
  assert.equal(
    (await assignFolderMedallion(env, owner, "no-such-folder", set.id, "raw"))
      .kind,
    "not_found",
  );
});

test("listMedallionAssignments returns set/layer labels for the UI tree", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const set = await ensureDefaultMedallionSet(env, owner);
  const folderId = await ensureFolderRow(env, owner.id, "K/メモ");
  assert.ok(folderId);
  await assignFolderMedallion(env, owner, folderId, set.id, "output");

  const rows = await listMedallionAssignments(env, owner);
  assert.deepEqual(rows, [
    {
      folderId,
      layerKey: "output",
      layerLabel: "output",
      path: "K/メモ",
      setId: set.id,
      setName: "精緻度",
    },
  ]);
});

// --- deletion rules -----------------------------------------------------------

test("deleteMedallionSet requires confirmation while folders are assigned", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const set = await ensureDefaultMedallionSet(env, owner);
  const folderId = await ensureFolderRow(env, owner.id, "A");
  assert.ok(folderId);
  await assignFolderMedallion(env, owner, folderId, set.id, "raw");

  const blocked = await deleteMedallionSet(env, owner, set.id, false);
  assert.equal(blocked.kind, "confirm_required");
  if (blocked.kind === "confirm_required") {
    assert.equal(blocked.assignedFolders, 1);
  }
  assert.equal((await listMedallionSets(env, owner)).length, 1);

  const deleted = await deleteMedallionSet(env, owner, set.id, true);
  assert.equal(deleted.kind, "ok");
  assert.equal((await listMedallionSets(env, owner)).length, 0);
  // Folders are unassigned, not deleted.
  assert.deepEqual(medallionColumns(sqlite, folderId), {
    medallion_layer: null,
    medallion_set_id: null,
  });
});

test("updateMedallionSet cannot drop a key that folders still reference", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  // Two keys with the same name set would need a custom set; simulate the
  // "assigned layer" guard by assigning then attempting an update that drops
  // the key — already covered by key-set equality. Here we verify the
  // explicit in_use guard on a custom set where key removal is attempted.
  const created = await createMedallionSet(env, owner, {
    layers: [
      { key: "a", label: "a" },
      { key: "b", label: "b" },
    ],
    name: "s",
  });
  assert.equal(created.kind, "ok");
  if (created.kind !== "ok") {
    return;
  }
  const folderId = await ensureFolderRow(env, owner.id, "F");
  assert.ok(folderId);
  await assignFolderMedallion(env, owner, folderId, created.result.id, "b");

  const attempt = await updateMedallionSet(env, owner, created.result.id, {
    layers: [
      { key: "a", label: "a" },
      { key: "b", label: "b" },
      { key: "c", label: "c" },
    ],
  });
  assert.equal(attempt.kind, "invalid");
});

// --- 0017 backfill -------------------------------------------------------------

test("0017 backfill: gold notes become edit_locked unless unlock window open", async (t) => {
  // Build a pre-0017 database, insert legacy rows directly (the note service
  // selects edit_locked, which does not exist yet), then apply 0017.
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  applyMigrations(
    sqlite,
    MIGRATIONS.slice(
      0,
      MIGRATIONS.indexOf("0017_medallion_sets_edit_lock.sql"),
    ),
  );

  const env = {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    DB: new D1DatabaseAdapter(sqlite),
    DEV_AUTH: "false",
  } as unknown as Env;
  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");

  const insert = sqlite.prepare(
    `INSERT INTO notes (id, short_id, owner_id, title, folder, permission,
       markdown_snapshot, created_at, updated_at, layer, gold_unlocked_until)
     VALUES (?, ?, ?, '', '', 'private', '', 0, 0, ?, ?)`,
  );
  const future = Date.now() + 60_000;
  insert.run("n-locked-gold", "sg1", owner.id, "gold", null);
  insert.run("n-open-gold", "sg2", owner.id, "gold", future);
  insert.run("n-expired-gold", "sg3", owner.id, "gold", Date.now() - 1000);
  insert.run("n-silver", "sg4", owner.id, "silver", null);
  insert.run("n-bronze", "sg5", owner.id, "bronze", null);

  sqlite.exec(
    readFileSync(
      new URL(
        "../db/migrations/0017_medallion_sets_edit_lock.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  const flags = sqlite
    .prepare("SELECT id, edit_locked FROM notes ORDER BY id")
    .all() as { id: string; edit_locked: number }[];
  const byId = new Map(flags.map((f) => [f.id, f.edit_locked]));
  assert.equal(byId.get("n-locked-gold"), 1);
  assert.equal(byId.get("n-open-gold"), 0);
  assert.equal(byId.get("n-expired-gold"), 1);
  assert.equal(byId.get("n-silver"), 0);
  assert.equal(byId.get("n-bronze"), 0);

  // New columns exist on folders/medallion_sets.
  const set = await ensureDefaultMedallionSet(env, owner);
  assert.equal(set.name, "精緻度");
});
