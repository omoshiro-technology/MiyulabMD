import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import {
  listBacklinks,
  listBrokenLinks,
  listNoteLinks,
  resolveWikilink,
} from "./links.ts";
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

test("wiki link resolves by title and lists backlinks", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const target = await notes.create(owner, {
    markdown: "# Alpha",
    title: "Alpha",
  });
  assert.ok(!("error" in target));
  const src = await notes.create(owner, {
    markdown: "# Src\nsee [[Alpha]] and [[Alpha|エイリアス]]",
    title: "Src",
  });
  assert.ok(!("error" in src));

  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing.length, 2);
  assert.equal(links.result.outgoing[0]?.note?.id, target.id);
  assert.equal(links.result.outgoing[0]?.line, 2);
  assert.equal(links.result.outgoing[1]?.display, "エイリアス");

  const back = await listBacklinks(env, target.id, owner);
  assert.equal(back.kind, "ok");
  if (back.kind !== "ok") {
    return;
  }
  assert.equal(back.backlinks.length, 2);
  assert.equal(back.backlinks[0]?.note.id, src.id);
});

test("same-folder title wins over global title", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const root = await notes.create(owner, {
    markdown: "# Dup",
    title: "Dup",
  });
  const inner = await notes.create(owner, {
    folder: "work",
    markdown: "# Dup",
    title: "Dup",
  });
  assert.ok(!("error" in root));
  assert.ok(!("error" in inner));

  const inWork = await notes.create(owner, {
    folder: "work",
    markdown: "# Ref\n[[Dup]]",
    title: "Ref",
  });
  assert.ok(!("error" in inWork));
  const links = await listNoteLinks(env, inWork.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing[0]?.note?.id, inner.id);

  // フォルダ修飾で明示指定
  const explicit = await notes.create(owner, {
    folder: "work",
    markdown: "# Ref2\n[[Dup]] と [[/Dup]] 相当の [[work/Dup]]",
    title: "Ref2",
  });
  assert.ok(!("error" in explicit));
  const links2 = await listNoteLinks(env, explicit.id, owner);
  assert.equal(links2.kind, "ok");
  if (links2.kind !== "ok") {
    return;
  }
  const qualified = links2.result.outgoing.find((l) => l.target === "work/Dup");
  assert.equal(qualified?.note?.id, inner.id);
});

test("alias, uuid, and short_id resolve", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const target = await notes.create(owner, {
    markdown: "# Target",
    title: "Target",
  });
  assert.ok(!("error" in target));
  const meta = await notes.updateMeta(target.id, owner, { alias: "my-alias" });
  assert.equal(meta.kind, "ok");

  const src = await notes.create(owner, {
    markdown: `# S\n[[my-alias]] [[${target.id}]] [[${target.shortId}]]`,
    title: "S",
  });
  assert.ok(!("error" in src));

  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.deepEqual(
    links.result.outgoing.map((l) => l.note?.id),
    [target.id, target.id, target.id],
  );
});

test("missing and ambiguous links are stored as unresolved", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, { markdown: "# Same", title: "Same" });
  await notes.create(owner, {
    folder: "other",
    markdown: "# Same",
    title: "Same",
  });
  const src = await notes.create(owner, {
    markdown: "# Src\n[[Same]] and [[NoSuch]]",
    title: "Src",
  });
  assert.ok(!("error" in src));

  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  // 同一フォルダ "other" ではなくグローバル 2 件 → ambiguous → note null
  assert.deepEqual(
    links.result.outgoing.map((l) => l.note),
    [null, null],
  );

  const broken = await listBrokenLinks(env, owner);
  assert.deepEqual(broken.map((b) => b.target).sort(), ["NoSuch", "Same"]);
});

test("viewer cannot see hidden link destinations", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const hidden = await notes.create(owner, {
    markdown: "# Hidden",
    permission: "private",
    title: "Hidden",
  });
  assert.ok(!("error" in hidden));
  const src = await notes.create(owner, {
    markdown: "# Open\nsee [[Hidden]]",
    readScope: "public",
    title: "Open",
  });
  assert.ok(!("error" in src));

  // owner sees the resolved link
  const own = await listNoteLinks(env, src.id, owner);
  assert.equal(own.kind, "ok");
  if (own.kind !== "ok") {
    return;
  }
  assert.equal(own.result.outgoing[0]?.note?.id, hidden.id);

  // viewer sees the note but the destination stays hidden
  const asViewer = await listNoteLinks(env, src.id, viewer);
  assert.equal(asViewer.kind, "ok");
  if (asViewer.kind !== "ok") {
    return;
  }
  assert.equal(asViewer.result.outgoing[0]?.note, null);
  assert.equal(asViewer.result.outgoing[0]?.target, "Hidden");

  // backlinks on the hidden note are not visible either
  const back = await listBacklinks(env, hidden.id, viewer);
  assert.equal(back.kind, "denied");
});

test("updateMarkdown reindexes outgoing links", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const target = await notes.create(owner, {
    markdown: "# T",
    title: "T",
  });
  const src = await notes.create(owner, {
    markdown: "# S\n[[Nothing]]",
    title: "S",
  });
  assert.ok(!("error" in target));
  assert.ok(!("error" in src));

  await notes.updateMarkdown(src.id, owner, "# S\n[[T]]");
  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing.length, 1);
  assert.equal(links.result.outgoing[0]?.note?.id, target.id);
});

test("rename breaks and recreation heals dependent links", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const target = await notes.create(owner, {
    markdown: "# Old",
    title: "Old",
  });
  const src = await notes.create(owner, {
    markdown: "# S\n[[Old]]",
    title: "S",
  });
  assert.ok(!("error" in target));
  assert.ok(!("error" in src));

  // rename → src link becomes missing
  const renamed = await notes.updateMeta(target.id, owner, {
    title: "Renamed",
  });
  assert.equal(renamed.kind, "ok");
  const brokenAfter = await listBrokenLinks(env, owner);
  assert.ok(brokenAfter.some((b) => b.target === "Old"));

  // creating a note with the old title heals the link
  const healed = await notes.create(owner, {
    markdown: "# Old",
    title: "Old",
  });
  assert.ok(!("error" in healed));
  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing[0]?.note?.id, healed.id);
});

test("delete marks inbound links missing", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const target = await notes.create(owner, {
    markdown: "# Gone",
    title: "Gone",
  });
  const src = await notes.create(owner, {
    markdown: "# S\n[[Gone]]",
    title: "S",
  });
  assert.ok(!("error" in target));
  assert.ok(!("error" in src));

  const removed = await notes.remove(target.id, owner);
  assert.equal(removed.kind, "ok");
  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing[0]?.note, null);
});

test("resolve_wikilink scopes to context folder", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, { markdown: "# Dup", title: "Dup" });
  const inner = await notes.create(owner, {
    folder: "work",
    markdown: "# Dup",
    title: "Dup",
  });
  const ctx = await notes.create(owner, {
    folder: "work",
    markdown: "# Ctx",
    title: "Ctx",
  });
  assert.ok(!("error" in inner));
  assert.ok(!("error" in ctx));

  const scoped = await resolveWikilink(env, owner, "Dup", ctx.id);
  assert.equal(scoped.kind, "ok");
  if (scoped.kind !== "ok") {
    return;
  }
  assert.equal(scoped.resolution.status, "resolved");
  if (scoped.resolution.status === "resolved") {
    assert.equal(scoped.resolution.note.id, inner.id);
  }

  const ambiguous = await resolveWikilink(env, owner, "Dup");
  assert.equal(ambiguous.kind, "ok");
  if (ambiguous.kind !== "ok") {
    return;
  }
  assert.equal(ambiguous.resolution.status, "ambiguous");

  const missing = await resolveWikilink(env, owner, "Nope");
  assert.equal(missing.kind, "ok");
  if (missing.kind !== "ok") {
    return;
  }
  assert.equal(missing.resolution.status, "missing");
});

test("heading and self links are indexed", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const src = await notes.create(owner, {
    markdown: "# Self\n## Deep\n[[Self#Deep]] [[#Deep]]",
    title: "Self",
  });
  assert.ok(!("error" in src));

  const links = await listNoteLinks(env, src.id, owner);
  assert.equal(links.kind, "ok");
  if (links.kind !== "ok") {
    return;
  }
  assert.equal(links.result.outgoing[0]?.heading, "Deep");
  assert.equal(links.result.outgoing[0]?.note?.id, src.id);
  assert.equal(links.result.outgoing[1]?.note?.id, src.id);
});
