import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import { ensureFolderRow } from "./access.ts";
import { createNoteService } from "./notes.ts";
import {
  enablePara,
  paraArchiveProject,
  paraDeleteSpace,
  paraList,
  paraPlan,
  paraRenameSpace,
} from "./para.ts";

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
  const other = await upsertUserByEmail(env, "other@example.com", "Other");
  return { env, other, owner, sqlite };
}

function folderRow(sqlite: DatabaseSync, ownerId: string, path: string) {
  return sqlite
    .prepare(
      "SELECT id, folder, para_bucket, para_space_id FROM folders WHERE owner_id = ? AND folder = ?",
    )
    .get(ownerId, path) as
    | {
        folder: string;
        id: string;
        para_bucket: string | null;
        para_space_id: string | null;
      }
    | undefined;
}

function folderById(sqlite: DatabaseSync, id: string) {
  return sqlite
    .prepare(
      "SELECT id, folder, para_bucket, para_space_id FROM folders WHERE id = ?",
    )
    .get(id) as
    | {
        folder: string;
        id: string;
        para_bucket: string | null;
        para_space_id: string | null;
      }
    | undefined;
}

function spaceRows(sqlite: DatabaseSync, ownerId: string) {
  return sqlite
    .prepare(
      "SELECT id, name, root_folder_id FROM para_spaces WHERE owner_id = ? ORDER BY created_at, id",
    )
    .all(ownerId) as {
    id: string;
    name: string;
    root_folder_id: string | null;
  }[];
}

function folderCount(sqlite: DatabaseSync, ownerId: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS c FROM folders WHERE owner_id = ?")
    .get(ownerId) as { c: number };
  return row.c;
}

test("paraPlan reports all buckets vacant on a fresh drive", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await paraPlan(env, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.plan.space.status, "exists");
  assert.deepEqual(
    result.plan.buckets.map((bucket) => [bucket.bucket, bucket.status]),
    [
      ["projects", "vacant"],
      ["areas", "vacant"],
      ["resources", "vacant"],
      ["archives", "vacant"],
    ],
  );
  // plan must be side-effect-free.
  assert.equal(folderCount(sqlite, owner.id), 0);
});

test("paraPlan reports collision when a default name is taken", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const existingId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(existingId);

  const result = await paraPlan(env, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  const projects = result.plan.buckets.find((b) => b.bucket === "projects");
  assert.equal(projects?.status, "collision");
  assert.deepEqual(projects?.existing, { id: existingId, name: "Projects" });
  assert.equal(
    result.plan.buckets.find((b) => b.bucket === "areas")?.status,
    "vacant",
  );
});

test("paraPlan reports assigned buckets with their folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const enabled = await enablePara(env, {}, owner);
  assert.equal(enabled.kind, "ok");

  const result = await paraPlan(env, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  for (const bucket of result.plan.buckets) {
    assert.equal(bucket.status, "assigned");
    assert.ok(bucket.existing?.id);
  }
  assert.equal(
    result.plan.buckets.find((b) => b.bucket === "projects")?.existing?.name,
    "Projects",
  );
});

test("paraPlan requires a signed-in user", async (t) => {
  const { env, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const result = await paraPlan(env, undefined);
  assert.equal(result.kind, "denied");
});

test("paraList is read-only and returns no buckets before setup", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await paraList(env, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.buckets, []);
  // GET must not materialize folders anymore.
  assert.equal(folderCount(sqlite, owner.id), 0);
});

test("enablePara creates all four buckets when nothing collides", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await enablePara(env, {}, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.ok(
    result.result.plan.buckets.every((bucket) => bucket.status === "assigned"),
  );

  for (const name of ["Projects", "Areas", "Resources", "Archives"]) {
    const row = folderRow(sqlite, owner.id, name);
    assert.ok(row, `missing bucket folder ${name}`);
    assert.ok(row.para_bucket);
  }
  assert.equal(
    folderRow(sqlite, owner.id, "Projects")?.para_bucket,
    "projects",
  );
});

test("enablePara is idempotent", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, {}, owner);
  const afterFirst = folderCount(sqlite, owner.id);
  const second = await enablePara(env, {}, owner);
  assert.equal(second.kind, "ok");
  assert.equal(folderCount(sqlite, owner.id), afterFirst);
});

test("enablePara reports unresolved collisions without touching them", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const existingId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(existingId);

  const result = await enablePara(env, {}, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, ["projects"]);
  assert.equal(
    result.result.plan.buckets.find((b) => b.bucket === "projects")?.status,
    "collision",
  );
  // The colliding folder is left alone and other buckets are still created.
  assert.equal(folderById(sqlite, existingId)?.para_bucket, null);
  assert.ok(folderRow(sqlite, owner.id, "Areas")?.para_bucket === "areas");
});

test("enablePara rename resolution frees the name then creates the bucket", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const projectId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(projectId);
  const note = await notes.create(owner, {
    folder: "Projects/Web",
    markdown: "# Web",
  });
  assert.ok(!("error" in note));

  const result = await enablePara(
    env,
    {
      resolutions: {
        projects: {
          action: "rename",
          folderId: projectId,
          newName: "旧 Projects",
        },
      },
    },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);

  // The whole subtree moved with the rename.
  const renamed = folderById(sqlite, projectId);
  assert.equal(renamed?.folder, "旧 Projects");
  assert.equal(renamed?.para_bucket, null);
  const bucket = folderRow(sqlite, owner.id, "Projects");
  assert.equal(bucket?.para_bucket, "projects");
  assert.notEqual(bucket?.id, projectId);
  const movedNote = sqlite
    .prepare("SELECT folder FROM notes WHERE id = ?")
    .get(note.id) as { folder: string };
  assert.equal(movedNote.folder, "旧 Projects/Web");
});

test("enablePara adopt resolution assigns the existing folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const projectId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(projectId);

  const result = await enablePara(
    env,
    { resolutions: { projects: { action: "adopt", folderId: projectId } } },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.equal(folderById(sqlite, projectId)?.para_bucket, "projects");
  // No duplicate Projects folder was created.
  const dupes = sqlite
    .prepare(
      "SELECT COUNT(*) AS c FROM folders WHERE owner_id = ? AND folder = 'Projects'",
    )
    .get(owner.id) as { c: number };
  assert.equal(dupes.c, 1);
});

test("enablePara skip leaves the bucket unassigned and out of pending", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const projectId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(projectId);

  const result = await enablePara(
    env,
    { resolutions: { projects: { action: "skip" } } },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.equal(
    result.result.plan.buckets.find((b) => b.bucket === "projects")?.status,
    "collision",
  );
  assert.equal(folderById(sqlite, projectId)?.para_bucket, null);
});

test("enablePara can be re-run to resolve a leftover collision (loop)", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const projectId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(projectId);

  const first = await enablePara(env, {}, owner);
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") {
    return;
  }
  assert.deepEqual(first.result.pending, ["projects"]);

  const second = await enablePara(
    env,
    { resolutions: { projects: { action: "adopt", folderId: projectId } } },
    owner,
  );
  assert.equal(second.kind, "ok");
  if (second.kind !== "ok") {
    return;
  }
  assert.deepEqual(second.result.pending, []);
  assert.ok(
    second.result.plan.buckets.every((bucket) => bucket.status === "assigned"),
  );
});

test("enablePara rejects resolutions with an unknown bucket key", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await enablePara(
    env,
    {
      resolutions: {
        // @ts-expect-error intentionally invalid key
        bogus: { action: "create" },
      },
    },
    owner,
  );
  assert.equal(result.kind, "invalid");
});

test("enablePara rejects adopt for a missing folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await enablePara(
    env,
    {
      resolutions: {
        projects: { action: "adopt", folderId: "no-such-folder" },
      },
    },
    owner,
  );
  assert.equal(result.kind, "not_found");
});

test("enablePara rejects adopt/rename of another user's folder", async (t) => {
  const { env, other, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const foreignId = await ensureFolderRow(env, other.id, "Projects");
  assert.ok(foreignId);

  const adopted = await enablePara(
    env,
    { resolutions: { projects: { action: "adopt", folderId: foreignId } } },
    owner,
  );
  assert.equal(adopted.kind, "denied");

  const renamed = await enablePara(
    env,
    {
      resolutions: {
        projects: { action: "rename", folderId: foreignId, newName: "x" },
      },
    },
    owner,
  );
  assert.equal(renamed.kind, "denied");
  assert.equal(folderById(sqlite, foreignId)?.folder, "Projects");
});

test("enablePara rejects adopt/rename of a non-top-level folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const nestedId = await ensureFolderRow(env, owner.id, "Area/Projects");
  assert.ok(nestedId);

  const adopted = await enablePara(
    env,
    { resolutions: { projects: { action: "adopt", folderId: nestedId } } },
    owner,
  );
  assert.equal(adopted.kind, "invalid");

  const renamed = await enablePara(
    env,
    {
      resolutions: {
        projects: { action: "rename", folderId: nestedId, newName: "x" },
      },
    },
    owner,
  );
  assert.equal(renamed.kind, "invalid");
});

test("enablePara rejects adopt of an already bucket-assigned folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, {}, owner);
  const projectsId = folderRow(sqlite, owner.id, "Projects")?.id;
  assert.ok(projectsId);

  const result = await enablePara(
    env,
    { resolutions: { areas: { action: "adopt", folderId: projectsId } } },
    owner,
  );
  assert.equal(result.kind, "invalid");
});

test("enablePara rejects a rename with an invalid new name", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const projectId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(projectId);

  for (const newName of ["", "a/b", ".."]) {
    const result = await enablePara(
      env,
      {
        resolutions: {
          projects: { action: "rename", folderId: projectId, newName },
        },
      },
      owner,
    );
    assert.equal(result.kind, "invalid", `newName=${newName}`);
  }
});

test("enablePara rejects two resolutions targeting the same folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const projectId = await ensureFolderRow(env, owner.id, "Projects");
  assert.ok(projectId);

  const result = await enablePara(
    env,
    {
      resolutions: {
        areas: { action: "adopt", folderId: projectId },
        projects: { action: "adopt", folderId: projectId },
      },
    },
    owner,
  );
  assert.equal(result.kind, "invalid");
});

test("enablePara requires a signed-in user", async (t) => {
  const { env, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const result = await enablePara(env, {}, undefined);
  assert.equal(result.kind, "denied");
});

// --- §2.5 spaces --------------------------------------------------------------

test("0016 backfill: existing buckets keep NULL space + default row appears", async (t) => {
  // Simulate a pre-0016 database: every migration except 0016/0017.
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const migration of MIGRATIONS.filter(
    (name) => !(name.startsWith("0016") || name.startsWith("0017")),
  )) {
    sqlite.exec(
      readFileSync(
        new URL(`../db/migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const env = {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    DB: new D1DatabaseAdapter(sqlite),
    DEV_AUTH: "false",
  } as unknown as Env;
  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  const other = await upsertUserByEmail(env, "other@example.com", "Other");

  // Pre-0016 shape: bucket tags with no space column yet.
  for (const name of ["Projects", "Areas"]) {
    const id = await ensureFolderRow(env, owner.id, name);
    assert.ok(id);
    sqlite
      .prepare("UPDATE folders SET para_bucket = ? WHERE id = ?")
      .run(name.toLowerCase(), id);
  }
  const otherId = await ensureFolderRow(env, other.id, "Projects");
  assert.ok(otherId);
  sqlite
    .prepare("UPDATE folders SET para_bucket = 'projects' WHERE id = ?")
    .run(otherId);

  const sql0016 = readFileSync(
    new URL("../db/migrations/0016_para_spaces.sql", import.meta.url),
    "utf8",
  );
  sqlite.exec(sql0016);

  // Bucket rows stay in the default space (para_space_id = NULL).
  assert.equal(folderRow(sqlite, owner.id, "Projects")?.para_space_id, null);
  // One rootless default-space row per owner that had buckets.
  const ownerSpaces = spaceRows(sqlite, owner.id);
  assert.equal(ownerSpaces.length, 1);
  assert.equal(ownerSpaces[0]?.name, "default");
  assert.equal(ownerSpaces[0]?.root_folder_id, null);
  assert.equal(spaceRows(sqlite, other.id).length, 1);

  // The composite index still enforces bucket uniqueness in the default space.
  const dupId = await ensureFolderRow(env, owner.id, "Projects2");
  assert.ok(dupId);
  assert.throws(() =>
    sqlite
      .prepare("UPDATE folders SET para_bucket = 'projects' WHERE id = ?")
      .run(dupId),
  );
});

test("paraPlan for a new named space reports space + buckets vacant", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await paraPlan(env, owner, { name: "個人" });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.plan.space.status, "vacant");
  assert.equal(result.plan.space.name, "個人");
  assert.ok(result.plan.buckets.every((bucket) => bucket.status === "vacant"));
  // Side-effect-free: no folders, no space rows.
  assert.equal(folderCount(sqlite, owner.id), 0);
  assert.equal(spaceRows(sqlite, owner.id).length, 0);
});

test("paraPlan reports a collision on the proposed space root", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const existingId = await ensureFolderRow(env, owner.id, "個人");
  assert.ok(existingId);

  const result = await paraPlan(env, owner, { name: "個人" });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.plan.space.status, "collision");
  assert.deepEqual(result.plan.space.existing, {
    id: existingId,
    name: "個人",
  });
});

test("paraPlan of an existing space by name shows its buckets", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const enabled = await enablePara(env, { space: { name: "仕事" } }, owner);
  assert.equal(enabled.kind, "ok");

  const result = await paraPlan(env, owner, { name: "仕事" });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.plan.space.status, "exists");
  assert.equal(result.plan.space.name, "仕事");
  assert.ok(result.plan.space.spaceId);
  assert.equal(result.plan.space.existing?.name, "仕事");
  assert.ok(
    result.plan.buckets.every((bucket) => bucket.status === "assigned"),
  );
});

test("enablePara creates a named space: root folder + buckets under it", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await enablePara(env, { space: { name: "個人" } }, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.equal(result.result.plan.space.status, "exists");

  const spaces = spaceRows(sqlite, owner.id);
  const named = spaces.find((row) => row.name === "個人");
  assert.ok(named);
  const root = folderById(sqlite, named.root_folder_id ?? "");
  assert.equal(root?.folder, "個人");

  for (const name of ["Projects", "Areas", "Resources", "Archives"]) {
    const row = folderRow(sqlite, owner.id, `個人/${name}`);
    assert.ok(row, `missing bucket 個人/${name}`);
    assert.equal(row.para_bucket, name.toLowerCase());
    assert.equal(row.para_space_id, named.id);
  }
});

test("enablePara space collision without resolution is pending and creates nothing", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const existingId = await ensureFolderRow(env, owner.id, "個人");
  assert.ok(existingId);
  const before = folderCount(sqlite, owner.id);

  const result = await enablePara(env, { space: { name: "個人" } }, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, ["space"]);
  assert.equal(result.result.plan.space.status, "collision");
  // Nothing was created — not even the space row.
  assert.equal(spaceRows(sqlite, owner.id).length, 0);
  assert.equal(folderCount(sqlite, owner.id), before);
  assert.equal(folderById(sqlite, existingId)?.para_bucket, null);
});

test("enablePara space skip aborts only that space (not pending)", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const result = await enablePara(
    env,
    {
      resolutions: { space: { action: "skip" } },
      space: { name: "個人" },
    },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.equal(spaceRows(sqlite, owner.id).length, 0);
  assert.equal(folderCount(sqlite, owner.id), 0);
});

test("enablePara space rename frees the root name then creates the space", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const existingId = await ensureFolderRow(env, owner.id, "個人");
  assert.ok(existingId);

  const result = await enablePara(
    env,
    {
      resolutions: {
        space: { action: "rename", folderId: existingId, newName: "旧個人" },
      },
      space: { name: "個人" },
    },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.equal(folderById(sqlite, existingId)?.folder, "旧個人");
  const spaces = spaceRows(sqlite, owner.id);
  const named = spaces.find((row) => row.name === "個人");
  assert.ok(named);
  assert.equal(folderById(sqlite, named.root_folder_id ?? "")?.folder, "個人");
});

test("enablePara space adopt allows a nested folder as the space root", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  // ADR 0005: a space root may be ANY folder, nesting included.
  const nestedId = await ensureFolderRow(env, owner.id, "Personal/Home");
  assert.ok(nestedId);

  const result = await enablePara(
    env,
    {
      resolutions: { space: { action: "adopt", folderId: nestedId } },
      space: { name: "home" },
    },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);

  const spaces = spaceRows(sqlite, owner.id);
  const named = spaces.find((row) => row.name === "home");
  assert.ok(named);
  assert.equal(named.root_folder_id, nestedId);
  // Buckets live under the adopted root's actual path, not the space name.
  const projects = folderRow(sqlite, owner.id, "Personal/Home/Projects");
  assert.equal(projects?.para_bucket, "projects");
  assert.equal(projects?.para_space_id, named.id);
  // No top-level "home" folder was created.
  assert.equal(folderRow(sqlite, owner.id, "home"), undefined);
});

test("enablePara rejects space adopt of a folder that is already a bucket", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, {}, owner); // default space: top-level buckets
  const projectsId = folderRow(sqlite, owner.id, "Projects")?.id;
  assert.ok(projectsId);

  // Flat overlap (ADR 0005): a bucket folder cannot become a space root.
  const result = await enablePara(
    env,
    {
      resolutions: { space: { action: "adopt", folderId: projectsId } },
      space: { name: "work" },
    },
    owner,
  );
  assert.equal(result.kind, "invalid");
});

test("enablePara rejects bucket adopt of a folder that is a space root", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  const first = await enablePara(env, { space: { name: "仕事" } }, owner);
  assert.equal(first.kind, "ok");
  const work = spaceRows(sqlite, owner.id).find((row) => row.name === "仕事");
  assert.ok(work?.root_folder_id);

  // A second space's bucket cannot adopt another space's root.
  const result = await enablePara(
    env,
    {
      resolutions: {
        projects: { action: "adopt", folderId: work.root_folder_id ?? "" },
      },
      space: { name: "個人" },
    },
    owner,
  );
  assert.equal(result.kind, "invalid");
});

test("enablePara allows a nested space inside another space's bucket", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, { space: { name: "個人" } }, owner);
  // Create a project folder inside the outer space's Projects bucket, then
  // make it the root of an inner space (ADR 0005: nesting is allowed).
  const innerRoot = await ensureFolderRow(
    env,
    owner.id,
    "個人/Projects/myproj",
  );
  assert.ok(innerRoot);

  const result = await enablePara(
    env,
    {
      resolutions: { space: { action: "adopt", folderId: innerRoot } },
      space: { name: "myproj" },
    },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.result.pending, []);
  assert.equal(
    folderRow(sqlite, owner.id, "個人/Projects/myproj/Archives")?.para_bucket,
    "archives",
  );
});

test("enablePara rejects a space name that collides with an existing space", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, { space: { name: "仕事" } }, owner);
  // Same name resolves to the existing space — a re-run, not a duplicate.
  const again = await enablePara(env, { space: { name: "仕事" } }, owner);
  assert.equal(again.kind, "ok");
  assert.equal(
    spaceRows(sqlite, owner.id).filter((row) => row.name === "仕事").length,
    1,
  );
});

test("enablePara bucket adopt inside a named space requires a direct child of the root", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, { space: { name: "個人" } }, owner);
  // Skipped setup leaves Areas unassigned; a stray same-named folder elsewhere
  // is not adoptable — buckets must be direct children of the space root.
  const elsewhere = await ensureFolderRow(env, owner.id, "Elsewhere/Areas");
  assert.ok(elsewhere);

  const space = spaceRows(sqlite, owner.id).find((row) => row.name === "個人");
  assert.ok(space);
  // Remove the areas bucket to re-open the slot.
  sqlite
    .prepare(
      "UPDATE folders SET para_bucket = NULL, para_space_id = NULL WHERE owner_id = ? AND para_bucket = 'areas' AND para_space_id = ?",
    )
    .run(owner.id, space.id);

  const result = await enablePara(
    env,
    {
      resolutions: { areas: { action: "adopt", folderId: elsewhere } },
      space: { id: space.id },
    },
    owner,
  );
  assert.equal(result.kind, "invalid");
});

test("paraList returns spaces plus default buckets for backward compat", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, {}, owner); // default space
  await enablePara(env, { space: { name: "仕事" } }, owner);

  const result = await paraList(env, owner);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.result.spaces.length, 2);
  const [first, second] = result.result.spaces;
  assert.equal(first?.isDefault, true);
  assert.equal(first?.buckets.length, 4);
  assert.equal(second?.name, "仕事");
  assert.equal(second?.isDefault, false);
  assert.equal(second?.rootPath, "仕事");
  assert.equal(
    second?.buckets.find((bucket) => bucket.key === "projects")?.path,
    "仕事/Projects",
  );
  // Backward compat: top-level buckets = the default space's.
  assert.equal(result.result.buckets.length, 4);
  assert.equal(
    result.result.buckets.find((bucket) => bucket.key === "projects")?.path,
    "Projects",
  );
});

test("paraList space + bucket params scope children to that space", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await enablePara(env, {}, owner);
  await enablePara(env, { space: { name: "仕事" } }, owner);
  const created = await notes.create(owner, {
    folder: "仕事/Projects/App",
    markdown: "# App",
  });
  assert.ok(!("error" in created));

  const scoped = await paraList(env, owner, "projects", "仕事");
  assert.equal(scoped.kind, "ok");
  if (scoped.kind !== "ok") {
    return;
  }
  assert.equal(scoped.result.spaces.length, 1);
  assert.equal(scoped.result.spaces[0]?.name, "仕事");
  assert.equal(scoped.result.children?.entries[0]?.name, "App");

  // bucket alone still means the default space (its Projects is empty).
  const unscoped = await paraList(env, owner, "projects");
  assert.equal(unscoped.kind, "ok");
  if (unscoped.kind !== "ok") {
    return;
  }
  assert.equal(unscoped.result.children?.entries.length, 0);
});

test("paraArchiveProject moves into the same space's Archives", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await enablePara(env, {}, owner);
  await enablePara(env, { space: { name: "仕事" } }, owner);

  const project = await notes.create(owner, {
    folder: "仕事/Projects/App",
    markdown: "# App",
  });
  assert.ok(!("error" in project));
  const appId = folderRow(sqlite, owner.id, "仕事/Projects/App")?.id;
  assert.ok(appId);

  const archived = await paraArchiveProject(
    env,
    appId,
    { name: "AppDone" },
    owner,
  );
  assert.equal(archived.kind, "ok");
  if (archived.kind !== "ok") {
    return;
  }
  assert.equal(archived.result.to, "仕事/Archives/AppDone");
  // The default space's Archives stays untouched.
  assert.equal(folderRow(sqlite, owner.id, "Archives/AppDone"), undefined);
});

test("paraDeleteSpace unassigns the space but keeps the folders", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, { space: { name: "仕事" } }, owner);
  const space = spaceRows(sqlite, owner.id).find((row) => row.name === "仕事");
  assert.ok(space);

  const result = await paraDeleteSpace(env, space.id, owner);
  assert.equal(result.kind, "ok");

  assert.equal(spaceRows(sqlite, owner.id).length, 0);
  const root = folderById(sqlite, space.root_folder_id ?? "");
  assert.equal(root?.folder, "仕事"); // folder itself stays
  assert.equal(root?.para_bucket, null);
  const projects = folderRow(sqlite, owner.id, "仕事/Projects");
  assert.ok(projects); // bucket folder stays
  assert.equal(projects.para_bucket, null);
  assert.equal(projects.para_space_id, null);
});

test("paraDeleteSpace of the default space unassigns top-level buckets", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, {}, owner);
  const space = spaceRows(sqlite, owner.id)[0];
  assert.ok(space);
  assert.equal(space.root_folder_id, null);

  const result = await paraDeleteSpace(env, space.id, owner);
  assert.equal(result.kind, "ok");
  assert.equal(folderRow(sqlite, owner.id, "Projects")?.para_bucket, null);
  assert.equal(folderRow(sqlite, owner.id, "Projects") !== undefined, true);
});

test("paraRenameSpace renames and enforces owner-unique names", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, { space: { name: "仕事" } }, owner);
  await enablePara(env, { space: { name: "個人" } }, owner);
  const work = spaceRows(sqlite, owner.id).find((row) => row.name === "仕事");
  assert.ok(work);

  const renamed = await paraRenameSpace(env, work.id, "Work", owner);
  assert.equal(renamed.kind, "ok");
  assert.equal(
    spaceRows(sqlite, owner.id).find((row) => row.id === work.id)?.name,
    "Work",
  );

  const conflict = await paraRenameSpace(env, work.id, "個人", owner);
  assert.equal(conflict.kind, "invalid");
});

test("paraPlan / space mutations reject another user's space", async (t) => {
  const { env, other, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());

  await enablePara(env, { space: { name: "仕事" } }, owner);
  const space = spaceRows(sqlite, owner.id)[0];
  assert.ok(space);

  const plan = await paraPlan(env, other, { id: space.id });
  assert.equal(plan.kind, "not_found");
  const deleted = await paraDeleteSpace(env, space.id, other);
  assert.equal(deleted.kind, "not_found");
  const renamed = await paraRenameSpace(env, space.id, "x", other);
  assert.equal(renamed.kind, "not_found");
});
