import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import {
  ensureFolderRow,
  getFolderByPath,
  listFolderChildren,
  replaceGrants,
  upsertFolderPolicy,
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

test("owner sees direct children folders and notes in one response", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, {
    folder: "work",
    markdown: "# Alpha",
    title: "Alpha",
  });
  await notes.create(owner, {
    folder: "work",
    markdown: "# Beta",
    title: "Beta",
  });
  await notes.create(owner, {
    folder: "work/sub",
    markdown: "# Nested",
    title: "Nested",
  });
  await notes.create(owner, {
    folder: "other",
    markdown: "# Other",
    title: "Other",
  });

  const work = await getFolderByPath(env, owner.id, "work");
  assert.ok(work);
  const result = await listFolderChildren(
    env,
    owner.id,
    "work",
    work.id,
    owner,
  );

  assert.deepEqual(
    result.entries.map((entry) => [
      entry.type,
      entry.type === "folder" ? entry.name : entry.title,
    ]),
    [
      ["folder", "sub"],
      ["note", "Alpha"],
      ["note", "Beta"],
    ],
  );
  const sub = result.entries[0];
  assert.equal(sub.type, "folder");
  if (sub.type === "folder") {
    assert.equal(sub.noteCount, 1);
    assert.equal(sub.parentId, work.id);
  }
  assert.equal(result.nextCursor, null);
  assert.equal(result.folder.name, "work");
  assert.deepEqual(result.folder.path, ["work"]);
});

test("entries paginate with a stable offset cursor", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  for (const name of ["n1", "n2", "n3"]) {
    await notes.create(owner, {
      folder: "paged",
      markdown: `# ${name}`,
      title: name,
    });
  }
  await ensureFolderRow(env, owner.id, "paged/sub");

  const paged = await getFolderByPath(env, owner.id, "paged");
  assert.ok(paged);
  const first = await listFolderChildren(
    env,
    owner.id,
    "paged",
    paged.id,
    owner,
    {
      limit: 2,
    },
  );
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextCursor);
  const second = await listFolderChildren(
    env,
    owner.id,
    "paged",
    paged.id,
    owner,
    {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    },
  );
  assert.equal(second.nextCursor, null);
  const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
  assert.equal(new Set(ids).size, 4);
  // フォルダが先、ノートが後の順序がページをまたいで維持される
  assert.equal(first.entries[0]?.type, "folder");
  if (first.entries[0]?.type === "folder") {
    assert.equal(first.entries[0].name, "sub");
  }
});

test("non-owner sees only discoverable notes inside a granted folder", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await upsertFolderPolicy(env, owner.id, "team", "signed_in", "signed_in");
  await replaceGrants(env, owner.id, "folder", "team", [
    { email: viewer.email },
  ]);

  const inherited = await notes.create(owner, {
    folder: "team",
    inheritAccess: true,
    markdown: "# Inherited",
    title: "Inherited",
  });
  assert.ok(!("error" in inherited));
  const privateNote = await notes.create(owner, {
    folder: "team",
    markdown: "# Hidden",
    permission: "private",
    title: "Hidden",
  });
  assert.ok(!("error" in privateNote));

  const team = await getFolderByPath(env, owner.id, "team");
  assert.ok(team);
  const result = await listFolderChildren(
    env,
    owner.id,
    "team",
    team.id,
    viewer,
  );

  assert.deepEqual(
    result.entries.map((entry) =>
      entry.type === "folder" ? entry.name : entry.title,
    ),
    ["Inherited"],
  );
  // 非オーナーには noteCount を出さない
  assert.equal(
    result.entries.every(
      (entry) => entry.type !== "folder" || entry.noteCount === undefined,
    ),
    true,
  );
});

test("link-only child folders are not enumerated for non-owners", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());

  await upsertFolderPolicy(env, owner.id, "known", "link", "self");
  await ensureFolderRow(env, owner.id, "known/inherited");
  await upsertFolderPolicy(env, owner.id, "known/other-link", "link", "self");
  await ensureFolderRow(env, owner.id, "known/other-link");

  const known = await getFolderByPath(env, owner.id, "known");
  assert.ok(known);
  const result = await listFolderChildren(
    env,
    owner.id,
    "known",
    known.id,
    viewer,
  );

  assert.deepEqual(
    result.entries.map((entry) =>
      entry.type === "folder" ? entry.name : entry.title,
    ),
    ["inherited"],
  );
});

test("non-owner folder.path hides undiscoverable ancestor names", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());

  // 深いフォルダだけに共有を付け、祖先は非公開のままにする。
  await upsertFolderPolicy(
    env,
    owner.id,
    "hidden/inner/leaf",
    "signed_in",
    "signed_in",
  );
  await replaceGrants(env, owner.id, "folder", "hidden/inner/leaf", [
    { email: viewer.email },
  ]);

  const leaf = await getFolderByPath(env, owner.id, "hidden/inner/leaf");
  assert.ok(leaf);
  const result = await listFolderChildren(
    env,
    owner.id,
    "hidden/inner/leaf",
    leaf.id,
    viewer,
  );

  assert.equal(result.folder.name, "leaf");
  // 祖先 hidden / inner は発見不可なので見せない
  assert.deepEqual(result.folder.path, ["leaf"]);

  // 途中の祖先にも発見可能な共有があれば、その suffix が見える
  await upsertFolderPolicy(
    env,
    owner.id,
    "hidden/inner",
    "signed_in",
    "signed_in",
  );
  await replaceGrants(env, owner.id, "folder", "hidden/inner", [
    { email: viewer.email },
  ]);
  const widened = await listFolderChildren(
    env,
    owner.id,
    "hidden/inner/leaf",
    leaf.id,
    viewer,
  );
  assert.deepEqual(widened.folder.path, ["inner", "leaf"]);

  // オーナーは引き続き完全なパスを見る
  const owned = await listFolderChildren(
    env,
    owner.id,
    "hidden/inner/leaf",
    leaf.id,
    owner,
  );
  assert.deepEqual(owned.folder.path, ["hidden", "inner", "leaf"]);
});

test("folder.path hides undiscoverable ancestors for link viewers", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());

  // 祖先は非公開、末端だけリンク共有。
  await upsertFolderPolicy(
    env,
    owner.id,
    "hidden-link/published",
    "link",
    "self",
  );
  const leaf = await getFolderByPath(env, owner.id, "hidden-link/published");
  assert.ok(leaf);

  // ゲストとログイン済みユーザーのどちらにも祖先名を出さない
  for (const user of [undefined, viewer]) {
    const result = await listFolderChildren(
      env,
      owner.id,
      "hidden-link/published",
      leaf.id,
      user,
    );
    assert.equal(result.folder.name, "published");
    assert.deepEqual(result.folder.path, ["published"]);
  }
});

test("listFolderNotes returns direct or recursive folder notes", async (t) => {
  const { env, owner, sqlite } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await notes.create(owner, { folder: "docs", markdown: "# A", title: "A" });
  await notes.create(owner, {
    folder: "docs/deep",
    markdown: "# B",
    title: "B",
  });

  const docs = await getFolderByPath(env, owner.id, "docs");
  assert.ok(docs);
  const direct = await notes.listFolderNotes(owner, docs.id);
  assert.equal(direct.kind, "ok");
  if (direct.kind === "ok") {
    assert.deepEqual(
      direct.notes.map((note) => note.title),
      ["A"],
    );
  }

  const recursive = await notes.listFolderNotes(owner, docs.id, true);
  assert.equal(recursive.kind, "ok");
  if (recursive.kind === "ok") {
    assert.deepEqual(recursive.notes.map((note) => note.title).sort(), [
      "A",
      "B",
    ]);
  }
});

test("listFolderNotes hides granted folder notes that lack discovery", async (t) => {
  const { env, owner, sqlite, viewer } = await createEnv();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  await upsertFolderPolicy(env, owner.id, "team", "signed_in", "signed_in");
  await replaceGrants(env, owner.id, "folder", "team", [
    { email: viewer.email },
  ]);
  await notes.create(owner, {
    folder: "team",
    inheritAccess: true,
    markdown: "# Inherited",
    title: "Inherited",
  });
  await notes.create(owner, {
    folder: "team",
    markdown: "# Hidden",
    permission: "private",
    title: "Hidden",
  });

  const team = await getFolderByPath(env, owner.id, "team");
  assert.ok(team);
  const result = await notes.listFolderNotes(viewer, team.id);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.deepEqual(
      result.notes.map((note) => note.title),
      ["Inherited"],
    );
  }
});
