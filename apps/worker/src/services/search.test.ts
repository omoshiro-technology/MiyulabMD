import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import {
  ensureFolderRow,
  getFolderByPath,
  replaceGrants,
  upsertFolderPolicy,
} from "./access.ts";
import {
  assignFolderMedallion,
  ensureDefaultMedallionSet,
} from "./medallion.ts";
import { createNoteService } from "./notes.ts";
import { enablePara, ensureParaBuckets } from "./para.ts";
import { createSchemeChild, setFolderScheme } from "./schemes.ts";

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

test("grep returns line, column, and context for body matches", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const created = await notes.create(owner, {
    markdown: "# Alpha\nfirst line\nsecond needle line\nlast line\n",
    title: "Alpha",
  });
  assert.ok(!("error" in created));

  const result = await notes.grep(owner, {
    contextAfter: 1,
    contextBefore: 1,
    pattern: "needle",
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.equal(match?.noteId, created.id);
  assert.equal(match?.line, 3);
  assert.equal(match?.column, 8);
  assert.equal(match?.text, "second needle line");
  assert.deepEqual(match?.before, ["first line"]);
  assert.deepEqual(match?.after, ["last line"]);
  assert.equal(typeof match?.snapshotUpdatedAt, "number");
  assert.equal(result.truncated, false);
  assert.equal(result.scannedNotes, 1);
});

test("grep never returns notes the user cannot view", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Hidden\nhidden needle body",
    permission: "private",
    title: "Hidden",
  });
  await upsertFolderPolicy(env, owner.id, "team", "signed_in", "signed_in");
  await replaceGrants(env, owner.id, "folder", "team", [
    { email: viewer.email },
  ]);
  await notes.create(owner, {
    folder: "team",
    inheritAccess: true,
    markdown: "# Shared\nshared needle body",
    title: "Shared",
  });

  const result = await notes.grep(viewer, { pattern: "needle" });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(
    result.matches.map((match) => match.title),
    ["Shared"],
  );
});

test("grep folder_id restricts the scan to that folder subtree", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    folder: "docs",
    markdown: "# Docs\nneedle in docs",
    title: "Docs",
  });
  await notes.create(owner, {
    folder: "docs/deep",
    markdown: "# Deep\nneedle in deep",
    title: "Deep",
  });
  await notes.create(owner, {
    folder: "other",
    markdown: "# Other\nneedle elsewhere",
    title: "Other",
  });

  const docs = await getFolderByPath(env, owner.id, "docs");
  assert.ok(docs);
  const result = await notes.grep(owner, {
    folderIds: [docs.id],
    pattern: "needle",
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.matches.map((match) => match.title).sort(), [
    "Deep",
    "Docs",
  ]);

  const missing = await notes.grep(owner, {
    folderIds: ["00000000-0000-0000-0000-000000000000"],
    pattern: "needle",
  });
  assert.equal(missing.kind, "not_found");
});

test("grep honors case sensitivity and fixed vs regex patterns", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Cases\nNeedle UPPER\nneedle lower\nn..dle regex\n",
    title: "Cases",
  });

  const insensitive = await notes.grep(owner, { pattern: "needle" });
  assert.equal(insensitive.kind, "ok");
  if (insensitive.kind === "ok") {
    assert.equal(insensitive.matches.length, 2);
  }

  const sensitive = await notes.grep(owner, {
    caseSensitive: true,
    pattern: "needle",
  });
  assert.equal(sensitive.kind, "ok");
  if (sensitive.kind === "ok") {
    assert.equal(sensitive.matches.length, 1);
    assert.equal(sensitive.matches[0]?.line, 3);
  }

  const regex = await notes.grep(owner, {
    caseSensitive: true,
    fixedString: false,
    pattern: "n..dle",
  });
  assert.equal(regex.kind, "ok");
  if (regex.kind === "ok") {
    assert.deepEqual(
      regex.matches.map((match) => match.line),
      [3, 4],
    );
  }

  const invalid = await notes.grep(owner, {
    fixedString: false,
    pattern: "([unclosed",
  });
  assert.equal(invalid.kind, "bad_request");
});

test("guest grep rejects regex patterns but allows fixed strings", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Public\npublic needle body",
    readScope: "public",
    title: "Public",
  });

  // JS regex cannot be timed out, so unauthenticated callers are limited to
  // fixed-string scans to keep catastrophic backtracking off the isolate.
  const regex = await notes.grep(undefined, {
    fixedString: false,
    pattern: "n..dle",
  });
  assert.equal(regex.kind, "bad_request");

  const fixed = await notes.grep(undefined, { pattern: "needle" });
  assert.equal(fixed.kind, "ok");
  if (fixed.kind === "ok") {
    assert.deepEqual(
      fixed.matches.map((match) => match.title),
      ["Public"],
    );
  }
});

test("grep glob_title filters which notes are scanned", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# design doc\nneedle hit",
    title: "design doc",
  });
  await notes.create(owner, {
    markdown: "# random memo\nneedle hit",
    title: "random memo",
  });

  const result = await notes.grep(owner, {
    globTitle: "*design*",
    pattern: "needle",
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(
    result.matches.map((match) => match.title),
    ["design doc"],
  );
  assert.equal(result.scannedNotes, 1);
});

test("grep truncates at max_matches_per_note and max_notes", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Many\nneedle\nneedle\nneedle\nneedle\n",
    title: "Many",
  });
  await notes.create(owner, {
    markdown: "# Second\nneedle",
    title: "Second",
  });

  const perNote = await notes.grep(owner, {
    maxMatchesPerNote: 2,
    pattern: "needle",
  });
  assert.equal(perNote.kind, "ok");
  if (perNote.kind !== "ok") {
    return;
  }
  const manyHits = perNote.matches.filter((match) => match.title === "Many");
  assert.equal(manyHits.length, 2);
  assert.equal(perNote.truncated, true);

  const capped = await notes.grep(owner, {
    maxNotes: 1,
    pattern: "needle",
  });
  assert.equal(capped.kind, "ok");
  if (capped.kind !== "ok") {
    return;
  }
  assert.equal(capped.truncated, true);
  const hitNotes = new Set(capped.matches.map((match) => match.noteId));
  assert.equal(hitNotes.size, 1);
});

test("searchNotes scope=title skips body-only matches and pages", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Plain\nbody has needle",
    title: "Plain",
  });
  await notes.create(owner, {
    markdown: "# needle in title\nnothing here",
    title: "needle in title",
  });
  await notes.create(owner, {
    markdown: "# another needle\nneedle body too",
    title: "another needle",
  });

  const titleOnly = await notes.searchNotes(owner, {
    query: "needle",
    scope: "title",
  });
  assert.equal(titleOnly.kind, "ok");
  if (titleOnly.kind !== "ok") {
    return;
  }
  assert.deepEqual(titleOnly.notes.map((note) => note.title).sort(), [
    "another needle",
    "needle in title",
  ]);

  // タイトルは見出し由来なので body スコープでも見出し行がヒットする
  const bodyOnly = await notes.searchNotes(owner, {
    query: "needle",
    scope: "body",
  });
  assert.equal(bodyOnly.kind, "ok");
  if (bodyOnly.kind !== "ok") {
    return;
  }
  assert.deepEqual(bodyOnly.notes.map((note) => note.title).sort(), [
    "Plain",
    "another needle",
    "needle in title",
  ]);

  const page1 = await notes.searchNotes(owner, {
    limit: 1,
    query: "needle",
  });
  assert.equal(page1.kind, "ok");
  if (page1.kind !== "ok") {
    return;
  }
  assert.equal(page1.notes.length, 1);
  assert.ok(page1.nextCursor);
  const page2 = await notes.searchNotes(owner, {
    cursor: page1.nextCursor ?? undefined,
    limit: 10,
    query: "needle",
  });
  assert.equal(page2.kind, "ok");
  if (page2.kind === "ok") {
    assert.equal(page2.notes.length, 2);
    assert.equal(page2.nextCursor, null);
  }
});

test("searchWorkspace returns title hits and line matches together", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# needle title\nbody text\n",
    title: "needle title",
  });
  await notes.create(owner, {
    markdown: "# BodyNote\nline one\nneedle in body\n",
    title: "BodyNote",
  });

  const result = await notes.searchWorkspace(owner, "needle");
  assert.equal(result.query, "needle");
  assert.deepEqual(result.notes.map((note) => note.title).sort(), [
    "BodyNote",
    "needle title",
  ]);
  const bodyHit = result.grep.matches.find(
    (match) => match.title === "BodyNote",
  );
  assert.equal(bodyHit?.line, 3);
  assert.equal(bodyHit?.column, 1);
});

test("guest search only sees public notes", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Public\npublic needle",
    readScope: "public",
    title: "Public",
  });
  await notes.create(owner, {
    markdown: "# Private\nprivate needle",
    permission: "private",
    title: "Private",
  });

  const result = await notes.searchWorkspace(undefined, "needle");
  assert.deepEqual(
    result.notes.map((note) => note.title),
    ["Public"],
  );
  assert.deepEqual(
    result.grep.matches.map((match) => match.title),
    ["Public"],
  );
});

test("searchNotes DSL: phrases, negation, and ANDed terms", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Alpha\nmedallion design draft\n",
    title: "Alpha",
  });
  await notes.create(owner, {
    markdown: "# Beta\nmedallion design final\n",
    title: "Beta",
  });
  await notes.create(owner, {
    markdown: "# Gamma\nunrelated\n",
    title: "Gamma",
  });

  const result = await notes.searchNotes(owner, {
    query: 'medallion -draft "design final"',
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(
    result.notes.map((note) => note.title),
    ["Beta"],
  );
});

test("searchNotes DSL: path/tag/layer filters", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    folder: "Knowledge",
    markdown: "# InKnowledge\nneedle #arch\n",
    title: "InKnowledge",
  });
  await notes.create(owner, {
    folder: "Knowledge/Sub",
    markdown: "# InSub\nneedle #archive deeper\n",
    title: "InSub",
  });
  await notes.create(owner, {
    folder: "Elsewhere",
    markdown: "# Outside\nneedle #arch\n",
    title: "Outside",
  });

  const byPath = await notes.searchNotes(owner, {
    query: "needle path:Knowledge",
  });
  assert.equal(byPath.kind, "ok");
  if (byPath.kind !== "ok") {
    return;
  }
  assert.deepEqual(byPath.notes.map((note) => note.title).sort(), [
    "InKnowledge",
    "InSub",
  ]);

  // #arch must not match the longer #archive tag.
  const byTag = await notes.searchNotes(owner, {
    query: "needle tag:arch",
  });
  assert.equal(byTag.kind, "ok");
  if (byTag.kind !== "ok") {
    return;
  }
  assert.deepEqual(byTag.notes.map((note) => note.title).sort(), [
    "InKnowledge",
    "Outside",
  ]);

  const negatedPath = await notes.searchNotes(owner, {
    query: "needle -path:Knowledge",
  });
  assert.equal(negatedPath.kind, "ok");
  if (negatedPath.kind !== "ok") {
    return;
  }
  assert.deepEqual(
    negatedPath.notes.map((note) => note.title),
    ["Outside"],
  );

  // §2.6: layer: resolves through folder medallion assignments, with
  // nearest-ancestor inheritance.
  const set = await ensureDefaultMedallionSet(env, owner);
  const knowledgeId = await ensureFolderRow(env, owner.id, "Knowledge");
  const subId = await ensureFolderRow(env, owner.id, "Knowledge/Sub");
  assert.ok(knowledgeId && subId);
  assert.equal(
    (await assignFolderMedallion(env, owner, knowledgeId, set.id, "knowledge"))
      .kind,
    "ok",
  );
  // A nearer assignment overrides the inherited one.
  assert.equal(
    (await assignFolderMedallion(env, owner, subId, set.id, "output")).kind,
    "ok",
  );

  const byLayer = await notes.searchNotes(owner, {
    query: "needle layer:knowledge",
  });
  assert.equal(byLayer.kind, "ok");
  if (byLayer.kind !== "ok") {
    return;
  }
  // InSub's folder carries its own output assignment — only InKnowledge
  // resolves to knowledge.
  assert.deepEqual(
    byLayer.notes.map((note) => note.title),
    ["InKnowledge"],
  );

  const byLayerOption = await notes.searchNotes(owner, {
    layer: "output",
    query: "needle",
  });
  assert.equal(byLayerOption.kind, "ok");
  if (byLayerOption.kind === "ok") {
    assert.deepEqual(
      byLayerOption.notes.map((note) => note.title),
      ["InSub"],
    );
  }

  // Set-qualified form pins one set by name.
  const qualified = await notes.searchNotes(owner, {
    query: "needle layer:精緻度.output",
  });
  assert.equal(qualified.kind, "ok");
  if (qualified.kind === "ok") {
    assert.deepEqual(
      qualified.notes.map((note) => note.title),
      ["InSub"],
    );
  }

  // Negated layer filter excludes assigned notes.
  const negatedLayer = await notes.searchNotes(owner, {
    query: "needle -layer:output",
  });
  assert.equal(negatedLayer.kind, "ok");
  if (negatedLayer.kind === "ok") {
    assert.deepEqual(negatedLayer.notes.map((note) => note.title).sort(), [
      "InKnowledge",
      "Outside",
    ]);
  }

  // invalid layer value resolves to an empty result, not an error
  const badLayer = await notes.searchNotes(owner, {
    query: "needle layer:.x",
  });
  assert.equal(badLayer.kind, "ok");
  if (badLayer.kind === "ok") {
    assert.equal(badLayer.notes.length, 0);
  }
});

test("searchNotes DSL: jd: and para: resolve through folder metadata", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const ensured = await ensureFolderRow(env, owner.id, "");
  assert.ok(ensured);
  const rootId = { id: ensured };
  assert.equal((await setFolderScheme(env, rootId.id, "jd", owner)).kind, "ok");
  const area = await createSchemeChild(
    env,
    rootId.id,
    { title: "仕事" },
    owner,
  );
  assert.equal(area.kind, "ok");
  if (area.kind !== "ok") {
    return;
  }
  const category = await createSchemeChild(
    env,
    area.result.folder.id ?? "",
    { title: "経費" },
    owner,
  );
  assert.equal(category.kind, "ok");
  if (category.kind !== "ok") {
    return;
  }
  const id = await createSchemeChild(
    env,
    category.result.folder.id ?? "",
    {},
    owner,
  );
  assert.equal(id.kind, "ok");
  if (id.kind !== "ok") {
    return;
  }
  assert.equal(id.result.schemeId, "10.11");

  await notes.create(owner, {
    folder: id.result.folder.folder,
    markdown: "# JdNote\nneedle inside jd\n",
    title: "JdNote",
  });
  await notes.create(owner, {
    folder: "loose",
    markdown: "# Loose\nneedle outside jd\n",
    title: "Loose",
  });

  const byJd = await notes.searchNotes(owner, { query: "needle jd:10.11" });
  assert.equal(byJd.kind, "ok");
  if (byJd.kind === "ok") {
    assert.deepEqual(
      byJd.notes.map((note) => note.title),
      ["JdNote"],
    );
  }

  const buckets = await ensureParaBuckets(env, owner.id);
  const projects = buckets.find((bucket) => bucket.bucket === "projects");
  assert.ok(projects);
  await notes.create(owner, {
    folder: projects.path,
    markdown: "# ParaNote\nneedle in projects\n",
    title: "ParaNote",
  });
  const byPara = await notes.searchNotes(owner, {
    query: "needle para:projects",
  });
  assert.equal(byPara.kind, "ok");
  if (byPara.kind === "ok") {
    assert.deepEqual(
      byPara.notes.map((note) => note.title),
      ["ParaNote"],
    );
  }
});

test("searchNotes DSL: para:<space>.<bucket> scopes to one space", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  // Default space + a named "work" space.
  await ensureParaBuckets(env, owner.id);
  const enabled = await enablePara(env, { space: { name: "work" } }, owner);
  assert.equal(enabled.kind, "ok");

  await notes.create(owner, {
    folder: "Projects",
    markdown: "# DefaultProj\nneedle default-space\n",
    title: "DefaultProj",
  });
  await notes.create(owner, {
    folder: "work/Projects",
    markdown: "# WorkProj\nneedle work-space\n",
    title: "WorkProj",
  });

  // Unqualified: matches across all spaces.
  const all = await notes.searchNotes(owner, { query: "needle para:projects" });
  assert.equal(all.kind, "ok");
  if (all.kind === "ok") {
    assert.deepEqual(all.notes.map((note) => note.title).sort(), [
      "DefaultProj",
      "WorkProj",
    ]);
  }

  // Space-qualified: only the work space's bucket.
  const work = await notes.searchNotes(owner, {
    query: "needle para:work.projects",
  });
  assert.equal(work.kind, "ok");
  if (work.kind === "ok") {
    assert.deepEqual(
      work.notes.map((note) => note.title),
      ["WorkProj"],
    );
  }

  // An unknown space resolves to an empty result set.
  const missing = await notes.searchNotes(owner, {
    query: "needle para:nosuch.projects",
  });
  assert.equal(missing.kind, "ok");
  if (missing.kind === "ok") {
    assert.deepEqual(missing.notes, []);
  }
});

test("searchNotes finds Japanese text and falls back for short terms", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# 会議メモ\n金曜日の議事録をまとめる\n",
    title: "会議メモ",
  });
  await notes.create(owner, {
    markdown: "# Other\n月曜日の予定\n",
    title: "Other",
  });

  // 3+ chars → trigram FTS narrowing path.
  const fts = await notes.searchNotes(owner, { query: "金曜日" });
  assert.equal(fts.kind, "ok");
  if (fts.kind === "ok") {
    assert.deepEqual(
      fts.notes.map((note) => note.title),
      ["会議メモ"],
    );
  }

  // 2 chars → below the trigram minimum, JS substring fallback.
  const short = await notes.searchNotes(owner, { query: "金曜" });
  assert.equal(short.kind, "ok");
  if (short.kind === "ok") {
    assert.deepEqual(
      short.notes.map((note) => note.title),
      ["会議メモ"],
    );
  }
});

test("FTS index stays in sync on update and delete", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const created = await notes.create(owner, {
    markdown: "# Synced\nuniquefern body\n",
    title: "Synced",
  });
  assert.ok(!("error" in created));

  const hit = await notes.searchNotes(owner, { query: "uniquefern" });
  assert.equal(hit.kind, "ok");
  if (hit.kind === "ok") {
    assert.equal(hit.notes.length, 1);
  }

  await notes.updateMarkdown(created.id, owner, "# Synced\nrewritten\n");
  const afterUpdate = await notes.searchNotes(owner, { query: "uniquefern" });
  assert.equal(afterUpdate.kind, "ok");
  if (afterUpdate.kind === "ok") {
    assert.equal(afterUpdate.notes.length, 0);
  }
  const newTerm = await notes.searchNotes(owner, { query: "rewritten" });
  assert.equal(newTerm.kind, "ok");
  if (newTerm.kind === "ok") {
    assert.equal(newTerm.notes.length, 1);
  }

  await notes.remove(created.id, owner);
  const afterDelete = await notes.searchNotes(owner, { query: "rewritten" });
  assert.equal(afterDelete.kind, "ok");
  if (afterDelete.kind === "ok") {
    assert.equal(afterDelete.notes.length, 0);
  }
});

test("searchNotes DSL never leaks notes outside the caller's visibility", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    markdown: "# Hidden\nneedle hidden\n",
    permission: "private",
    title: "Hidden",
  });
  await notes.create(owner, {
    markdown: "# Open\nneedle visible\n",
    readScope: "public",
    title: "Open",
  });

  const result = await notes.searchNotes(viewer, {
    query: "needle -other",
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.deepEqual(
      result.notes.map((note) => note.title),
      ["Open"],
    );
  }

  const guest = await notes.searchNotes(undefined, { query: "needle" });
  assert.equal(guest.kind, "ok");
  if (guest.kind === "ok") {
    assert.deepEqual(
      guest.notes.map((note) => note.title),
      ["Open"],
    );
  }
});

test("searchWorkspace applies DSL operators to both notes and grep", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    folder: "keep",
    markdown: "# Keep\nneedle line\n",
    title: "Keep",
  });
  await notes.create(owner, {
    folder: "drop",
    markdown: "# Drop\nneedle line\n",
    title: "Drop",
  });

  const result = await notes.searchWorkspace(owner, "needle path:keep");
  assert.deepEqual(
    result.notes.map((note) => note.title),
    ["Keep"],
  );
  assert.deepEqual(
    result.grep.matches.map((match) => match.title),
    ["Keep"],
  );
});
