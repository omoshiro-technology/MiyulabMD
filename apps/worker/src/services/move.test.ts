import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import { moveFolder, moveFolderContents, moveNotes } from "./move.ts";
import { createNoteService } from "./notes.ts";
import { ensureParaBuckets, paraArchiveProject, paraList } from "./para.ts";

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
  const viewer = await upsertUserByEmail(env, "viewer@example.com", "Viewer");

  return { env, owner, sqlite, viewer };
}

function folderIdOf(sqlite: DatabaseSync, folder: string) {
  const row = sqlite
    .prepare("SELECT id FROM folders WHERE folder = ?")
    .get(folder) as { id: string } | undefined;
  return row?.id ?? null;
}

function noteFolderOf(sqlite: DatabaseSync, noteId: string) {
  const row = sqlite
    .prepare("SELECT folder FROM notes WHERE id = ?")
    .get(noteId) as { folder: string } | undefined;
  return row?.folder;
}

test("moveFolder relocates a subtree and keeps note ids", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const note = await notes.create(owner, {
    folder: "Projects/Web",
    markdown: "# Site",
  });
  assert.ok(!("error" in note));
  const srcId = folderIdOf(sqlite, "Projects/Web");
  const destId = folderIdOf(sqlite, "Archives");
  assert.ok(srcId);
  // Archives does not exist yet — create it via a note-less folder row.
  const { ensureFolderRow } = await import("./access.ts");
  const archivesId = await ensureFolderRow(env, owner.id, "Archives");
  assert.ok(archivesId);
  void destId;

  const dry = await moveFolder(
    env,
    srcId,
    { destFolderId: archivesId, dryRun: true },
    owner,
  );
  assert.equal(dry.kind, "ok");
  if (dry.kind !== "ok") {
    return;
  }
  assert.equal(dry.result.dryRun, true);
  assert.equal(dry.result.to, "Archives/Web");
  assert.equal(dry.result.plan.notes, 1);
  assert.equal(noteFolderOf(sqlite, note.id), "Projects/Web");

  const moved = await moveFolder(
    env,
    srcId,
    { destFolderId: archivesId },
    owner,
  );
  assert.equal(moved.kind, "ok");
  if (moved.kind !== "ok") {
    return;
  }
  assert.equal(moved.result.to, "Archives/Web");
  assert.equal(noteFolderOf(sqlite, note.id), "Archives/Web");
  assert.ok(folderIdOf(sqlite, "Archives/Web"));
  assert.equal(folderIdOf(sqlite, "Projects/Web"), null);
});

test("moveFolder rejects cycles and conflicts", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);
  const { ensureFolderRow } = await import("./access.ts");

  await notes.create(owner, { folder: "A/B", markdown: "# n" });
  const a = folderIdOf(sqlite, "A");
  const ab = folderIdOf(sqlite, "A/B");
  assert.ok(a && ab);

  const cycle = await moveFolder(env, a, { destFolderId: ab }, owner);
  assert.equal(cycle.kind, "invalid");

  await ensureFolderRow(env, owner.id, "C/B");
  const c = folderIdOf(sqlite, "C");
  assert.ok(c);
  const conflict = await moveFolder(env, ab, { destFolderId: c }, owner);
  assert.equal(conflict.kind, "invalid");

  const stranger = await moveFolder(
    env,
    a,
    { destFolderId: null },
    await upsertUserByEmail(env, "other@example.com", "O"),
  );
  assert.equal(stranger.kind, "denied");
});

test("moveFolderContents moves direct notes and subfolders", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);
  const { ensureFolderRow } = await import("./access.ts");

  const n1 = await notes.create(owner, { folder: "Src", markdown: "# One" });
  const n2 = await notes.create(owner, {
    folder: "Src/Sub",
    markdown: "# Two",
  });
  assert.ok(!("error" in n1 || "error" in n2));
  const src = folderIdOf(sqlite, "Src");
  const dest = await ensureFolderRow(env, owner.id, "Dest");
  assert.ok(src && dest);

  const shallow = await moveFolderContents(
    env,
    src,
    { destFolderId: dest },
    owner,
  );
  assert.equal(shallow.kind, "ok");
  if (shallow.kind !== "ok") {
    return;
  }
  assert.equal(shallow.result.moved, 1);
  assert.equal(noteFolderOf(sqlite, n1.id), "Dest");
  assert.equal(noteFolderOf(sqlite, n2.id), "Src/Sub");

  const deep = await moveFolderContents(
    env,
    src,
    { destFolderId: dest, includeSubfolders: true },
    owner,
  );
  assert.equal(deep.kind, "ok");
  if (deep.kind !== "ok") {
    return;
  }
  assert.equal(deep.result.folders[0]?.status, "moved");
  assert.equal(noteFolderOf(sqlite, n2.id), "Dest/Sub");
});

test("moveNotes reports per-note results and reindexes links", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);
  const { ensureFolderRow } = await import("./access.ts");

  const target = await notes.create(owner, { markdown: "# Target" });
  const ref = await notes.create(owner, {
    markdown: "# Ref\n[[Target]]",
  });
  assert.ok(!("error" in target || "error" in ref));
  const dest = await ensureFolderRow(env, owner.id, "Inbox");
  assert.ok(dest);

  const result = await moveNotes(
    env,
    { destFolderId: dest, noteIds: [target.id, ref.id, "missing-id"] },
    owner,
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.result.moved, 2);
  assert.equal(result.result.failed, 1);
  assert.equal(
    result.result.items.find((item) => item.noteId === "missing-id")?.reason,
    "not_found",
  );
  assert.equal(noteFolderOf(sqlite, target.id), "Inbox");

  const { listNoteLinks } = await import("./links.ts");
  const links = await listNoteLinks(env, ref.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing[0]?.note?.id, target.id);

  // A non-owner's own destination rejects notes they cannot even see.
  const viewerDest = await ensureFolderRow(env, viewer.id, "VInbox");
  const denied = await moveNotes(
    env,
    { destFolderId: viewerDest, noteIds: [target.id] },
    viewer,
  );
  assert.equal(denied.kind, "ok");
  if (denied.kind !== "ok") {
    return;
  }
  assert.equal(denied.result.items[0]?.reason, "not_found");
});

test("para_list materializes buckets and para_archive_project moves into Archives", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const project = await notes.create(owner, {
    folder: "Projects/Web",
    markdown: "# Web",
  });
  assert.ok(!("error" in project));

  // §2.4: paraList is read-only now; setup happens via explicit enable.
  await ensureParaBuckets(env, owner.id);
  const listed = await paraList(env, owner, "projects");
  assert.equal(listed.kind, "ok");
  if (listed.kind !== "ok") {
    return;
  }
  assert.equal(listed.result.buckets.length, 4);
  const projects = listed.result.buckets.find((b) => b.key === "projects");
  assert.equal(projects?.path, "Projects");
  assert.ok(listed.result.children);
  assert.equal(listed.result.children?.entries[0]?.name, "Web");

  const webId = folderIdOf(sqlite, "Projects/Web");
  assert.ok(webId);
  const archived = await paraArchiveProject(env, webId, { dated: true }, owner);
  assert.equal(archived.kind, "ok");
  if (archived.kind !== "ok") {
    return;
  }
  assert.match(archived.result.to, /^Archives\/\d{4}-\d{2}-Web$/);
  assert.equal(noteFolderOf(sqlite, project.id), archived.result.to);

  // Projects bucket key survives the move of other folders.
  const again = await paraList(env, owner);
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") {
    return;
  }
  assert.equal(
    again.result.buckets.find((b) => b.key === "projects")?.path,
    "Projects",
  );
});

test("para_archive_project rejects folders outside Projects", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const { ensureFolderRow } = await import("./access.ts");

  const misc = await ensureFolderRow(env, owner.id, "Misc");
  assert.ok(misc);
  await ensureParaBuckets(env, owner.id); // materialize buckets
  const result = await paraArchiveProject(env, misc, {}, owner);
  assert.equal(result.kind, "invalid");
});
