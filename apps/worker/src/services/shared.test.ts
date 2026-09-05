import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { upsertUserByEmail } from "../db/users.ts";
import {
  ensureFolderRow,
  listPublicSharedFolders,
  listSharedFolders,
  replaceGrants,
  resolveFolderAccess,
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

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.query).all(...this.binds);
    return { results: rows as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...this.binds);
    return (row as T | null) ?? null;
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.query).run(...this.binds);
    return { success: true };
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
}

async function createEnvWithSeededData() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  const env = {
    DB: new D1DatabaseAdapter(sqlite),
    ALLOW_ANONYMOUS: "false",
    ALLOW_ANONYMOUS_EDITS: "true",
    ALLOW_ANONYMOUS_VIEWS: "true",
    DEFAULT_PERMISSION: "editable",
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    DEV_AUTH: "false",
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");
  const viewer = await upsertUserByEmail(env, "viewer@example.com", "Viewer");

  const notes = createNoteService(env);

  const directSignedIn = await notes.create(owner, {
    title: "Direct signed-in note",
    folder: "inbox",
    permission: "limited",
    markdown:
      "# Direct signed-in note\nThis markdown contains shared-token for direct-signed-in note.",
  });
  if ("error" in directSignedIn) {
    throw new Error(directSignedIn.error);
  }

  const inheritedSignedIn = await notes.create(owner, {
    title: "Inherited signed-in note",
    folder: "shared/docs",
    inheritAccess: true,
    markdown:
      "# Inherited signed-in note\nThis markdown contains shared-token for inherited signed-in note.",
  });
  if ("error" in inheritedSignedIn) {
    throw new Error(inheritedSignedIn.error);
  }

  const privateOverride = await notes.create(owner, {
    title: "Self-only override note",
    folder: "team/private",
    permission: "private",
    markdown:
      "# Self-only override note\nThis markdown contains private-only token that must stay hidden.",
  });
  if ("error" in privateOverride) {
    throw new Error(privateOverride.error);
  }

  const explicitGrant = await notes.create(owner, {
    title: "Explicit grant note",
    folder: "secure",
    readScope: "users",
    writeScope: "users",
    markdown:
      "# Explicit grant note\nThis markdown contains shared-token via explicit grant to this note.",
  });
  if ("error" in explicitGrant) {
    throw new Error(explicitGrant.error);
  }

  const publicLinkOnly = await notes.create(owner, {
    title: "Public-link-only note",
    folder: "public-link",
    permission: "locked",
    markdown:
      "# Public-link-only note\nThis markdown contains public-link-only token.",
  });
  if ("error" in publicLinkOnly) {
    throw new Error(publicLinkOnly.error);
  }

  const explicitGrantRow = await replaceGrants(
    env,
    owner.id,
    "note",
    explicitGrant.id,
    [{ email: viewer.email }],
  );
  if ("error" in explicitGrantRow) {
    throw new Error(explicitGrantRow.error);
  }

  // Duplicate folder candidates: direct folder grant + inherited signed_in policy.
  await upsertFolderPolicy(env, owner.id, "team", "signed_in", "signed_in");
  const teamGrant = await replaceGrants(env, owner.id, "folder", "team", [
    { email: viewer.email },
  ]);
  if ("error" in teamGrant) {
    throw new Error(teamGrant.error);
  }

  await upsertFolderPolicy(env, owner.id, "shared", "signed_in", "signed_in");

  // Ensure own folders are excluded in listSharedFolders.
  await upsertFolderPolicy(env, viewer.id, "mine", "signed_in", "signed_in");

  return {
    env,
    owner,
    viewer,
    sqlite,
  };
}

async function createEnvWithPublicDiscoverySeededData(
  options: { allowAnonymousViews?: "true" | "false" } = {},
) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  const env = {
    DB: new D1DatabaseAdapter(sqlite),
    ALLOW_ANONYMOUS: "false",
    ALLOW_ANONYMOUS_EDITS: "true",
    ALLOW_ANONYMOUS_VIEWS: options.allowAnonymousViews ?? "true",
    DEFAULT_PERMISSION: "editable",
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    DEV_AUTH: "false",
  } as unknown as Env;

  const owner = await upsertUserByEmail(env, "owner@example.com", "Owner");

  const notes = createNoteService(env);

  const directPublic = await notes.create(owner, {
    title: "Direct public note",
    folder: "public-zone",
    readScope: "public",
    writeScope: "public",
    markdown: "# Direct public note\nThis note should be visible to guests.",
  });
  if ("error" in directPublic) {
    throw new Error(directPublic.error);
  }

  await upsertFolderPolicy(env, owner.id, "shared-public", "public", "public");

  const inheritedPublic = await notes.create(owner, {
    title: "Inherited public note",
    folder: "shared-public/docs",
    inheritAccess: true,
    markdown:
      "# Inherited public note\nThis note should be visible via public folder inheritance.",
  });
  if ("error" in inheritedPublic) {
    throw new Error(inheritedPublic.error);
  }

  const privateOverride = await notes.create(owner, {
    title: "Private override note",
    folder: "shared-public/hidden",
    permission: "private",
    markdown:
      "# Private override note\nThis private note should not appear for guests.",
  });
  if ("error" in privateOverride) {
    throw new Error(privateOverride.error);
  }

  const signedInOverride = await notes.create(owner, {
    title: "Signed-in override note",
    folder: "shared-public/login",
    permission: "limited",
    markdown:
      "# Signed-in override note\nThis signed-in only note should not appear for guests.",
  });
  if ("error" in signedInOverride) {
    throw new Error(signedInOverride.error);
  }

  const usersOverride = await notes.create(owner, {
    title: "Users override note",
    folder: "shared-public/users",
    readScope: "users",
    writeScope: "users",
    markdown:
      "# Users override note\nThis users-only note should not appear for anonymous users.",
  });
  if ("error" in usersOverride) {
    throw new Error(usersOverride.error);
  }

  await upsertFolderPolicy(env, owner.id, "public-only", "public", "public");

  return {
    env,
    owner,
    sqlite,
  };
}

test("listForUser excludes link and signed-in notes without an explicit grant", async (t) => {
  const { env, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const rows = await notes.listForUser(viewer);

  const titles = rows.map((row) => row.title).sort();
  assert.deepEqual(titles, ["Explicit grant note"]);

  assert.equal(
    rows.every((row) => row.title !== "Self-only override note"),
    true,
  );
});

test("searchForUser excludes unlisted scopes and keeps explicit grants", async (t) => {
  const { env, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const hits = await notes.searchForUser(viewer, "shared-token");

  assert.equal(hits.length, 1);
  const hitTitles = hits.map((hit) => hit.title).sort();
  assert.deepEqual(hitTitles, ["Explicit grant note"]);

  for (const hit of hits) {
    assert.equal(typeof hit.snippet, "string");
    assert.equal(hit.snippet?.includes("shared-token"), true);
  }

  const blocked = await notes.searchForUser(viewer, "private-only");
  assert.equal(blocked.length, 0);
});

test("listSharedFolders deduplicates duplicate candidates and excludes own folders", async (t) => {
  const { env, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());

  const folders = await listSharedFolders(env, viewer);

  const folderNames = folders.map((folder) => folder.name).sort();
  assert.deepEqual(folderNames, ["team"]);
  assert.equal(folders.filter((folder) => folder.name === "team").length, 1);
  assert.equal(folderNames.includes("mine"), false);
  assert.equal(
    new Set(folders.map((folder) => folder.id)).size,
    folders.length,
  );
});

test("signed-in discovery includes public folders and inherited notes without grants", async (t) => {
  const { env, sqlite } = await createEnvWithPublicDiscoverySeededData({
    allowAnonymousViews: "false",
  });
  t.after(() => sqlite.close());
  const viewer = await upsertUserByEmail(env, "viewer@example.com", "Viewer");
  const notes = createNoteService(env);
  const rows = await notes.listForUser(viewer);
  assert.deepEqual(rows.map((row) => row.title).sort(), [
    "Direct public note",
    "Inherited public note",
  ]);
  const hits = await notes.searchForUser(viewer, "public");
  assert.deepEqual(hits.map((hit) => hit.title).sort(), [
    "Direct public note",
    "Inherited public note",
  ]);
  await upsertFolderPolicy(env, viewer.id, "my-public", "public", "self");
  const folders = await listSharedFolders(env, viewer);
  assert.deepEqual(folders.map((folder) => folder.name).sort(), [
    "public-only",
    "shared-public",
  ]);
});

test("listForGuest exposes public notes and hides non-public overrides", async (t) => {
  const { env, sqlite } = await createEnvWithPublicDiscoverySeededData();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const rows = await notes.listForGuest();
  const titles = rows.map((row) => row.title).sort();

  assert.deepEqual(titles, ["Direct public note", "Inherited public note"]);
  assert.equal(
    rows.every((row) => row.title !== "Private override note"),
    true,
  );
  assert.equal(
    rows.every((row) => row.title !== "Signed-in override note"),
    true,
  );
  assert.equal(
    rows.every((row) => row.title !== "Users override note"),
    true,
  );
});

test("listPublicSharedFolders exposes explicitly public folders", async (t) => {
  const { env, sqlite } = await createEnvWithPublicDiscoverySeededData();
  t.after(() => sqlite.close());

  const folders = await listPublicSharedFolders(env);

  const names = folders.map((folder) => folder.name).sort();
  assert.deepEqual(names, ["public-only", "shared-public"]);
});

test("guest discovery is disabled when anonymous views is false", async (t) => {
  const { env, sqlite } = await createEnvWithPublicDiscoverySeededData({
    allowAnonymousViews: "false",
  });
  t.after(() => sqlite.close());
  const notes = createNoteService(env);

  const rows = await notes.listForGuest();
  const folders = await listPublicSharedFolders(env);

  assert.equal(rows.length, 0);
  assert.equal(folders.length, 0);
});

test("link overrides stay out of discovery even below public folders", async (t) => {
  const { env, owner, sqlite } = await createEnvWithPublicDiscoverySeededData();
  t.after(() => sqlite.close());
  const viewer = await upsertUserByEmail(env, "viewer@example.com", "Viewer");
  const notes = createNoteService(env);
  await upsertFolderPolicy(env, owner.id, "shared-public/link", "link", "self");
  for (const inheritAccess of [false, true]) {
    const created = await notes.create(owner, {
      folder: "shared-public/link",
      inheritAccess,
      ...(inheritAccess
        ? {}
        : ({ readScope: "link", writeScope: "self" } as const)),
      markdown: "# link-discovery-regression",
    });
    if ("error" in created) throw new Error(created.error);
    assert.equal((await notes.get(created.id)).kind, "ok");
    assert.equal((await notes.get(created.id, viewer)).kind, "ok");
    assert.equal(
      (await notes.listForUser(owner)).some((n) => n.id === created.id),
      true,
    );
    assert.equal(
      (await notes.listForUser(viewer)).some((n) => n.id === created.id),
      false,
    );
    assert.equal(
      (await notes.listForGuest()).some((n) => n.id === created.id),
      false,
    );
  }
  assert.deepEqual(
    await notes.searchForUser(viewer, "link-discovery-regression"),
    [],
  );
  assert.equal(
    (await listSharedFolders(env, viewer)).some((f) => f.name === "link"),
    false,
  );
  assert.equal(
    (await listPublicSharedFolders(env)).some((f) => f.name === "link"),
    false,
  );

  await replaceGrants(env, owner.id, "folder", "shared-public/link", [
    { email: viewer.email },
  ]);
  const hits = await notes.searchForUser(viewer, "link-discovery-regression");
  assert.equal(hits.length, 2);
  assert.equal(
    hits.every((hit) => hit.access.grants.length === 0),
    true,
  );
});

test("a direct grant makes a link-only note discoverable to its recipient", async (t) => {
  const { env, owner, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);
  const link = (await notes.listForUser(owner)).find(
    (n) => n.title === "Public-link-only note",
  )!;
  await replaceGrants(env, owner.id, "note", link.id, [
    { email: viewer.email },
  ]);
  assert.equal(
    (await notes.listForUser(viewer)).some((n) => n.id === link.id),
    true,
  );
  assert.equal(
    (await notes.searchForUser(viewer, "public-link-only")).length,
    1,
  );
  assert.equal(
    (await notes.listForGuest()).some((n) => n.id === link.id),
    false,
  );
});

test("legacy signed-in presets require a URL or explicit sharing", async (t) => {
  const { env, owner, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);
  for (const permission of ["limited", "protected"] as const) {
    const created = await notes.create(owner, {
      permission,
      markdown: `# legacy-unlisted-${permission}`,
    });
    if ("error" in created) throw new Error(created.error);
    assert.equal((await notes.get(created.id, viewer)).kind, "ok");
    assert.equal((await notes.get(created.id)).kind, "denied");
    assert.equal(
      (await notes.listForUser(owner)).some((n) => n.id === created.id),
      true,
    );
    assert.deepEqual(
      await notes.searchForUser(viewer, `legacy-unlisted-${permission}`),
      [],
    );
    assert.equal(
      (await notes.listForUser(viewer)).some((n) => n.id === created.id),
      false,
    );
    await replaceGrants(env, owner.id, "note", created.id, [
      { email: viewer.email },
    ]);
    assert.equal(
      (await notes.searchForUser(viewer, `legacy-unlisted-${permission}`))
        .length,
      1,
    );
  }

  const folder = await resolveFolderAccess(env, owner.id, "shared", viewer);
  assert.equal(folder.flags.canView, true);
  await replaceGrants(env, owner.id, "folder", "shared", [
    { email: viewer.email },
  ]);
  assert.equal(
    (await notes.searchForUser(viewer, "Inherited signed-in")).length,
    1,
  );
  assert.equal(
    (await listSharedFolders(env, viewer)).some((f) => f.name === "shared"),
    true,
  );
});

test("public children never reveal unlisted ancestor IDs or grants", async (t) => {
  const { env, owner, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());
  const notes = createNoteService(env);
  for (const scope of ["link", "signed_in"] as const) {
    const parent = `hidden-${scope}`;
    const child = `${parent}/published`;
    await upsertFolderPolicy(env, owner.id, parent, scope, "self");
    await upsertFolderPolicy(env, owner.id, child, "public", "self");
    const parentId = await ensureFolderRow(env, owner.id, parent);
    const childId = await ensureFolderRow(env, owner.id, child);
    await replaceGrants(env, owner.id, "folder", parent, [
      { email: "collaborator@example.com" },
    ]);
    const created = await notes.create(owner, {
      folder: parent,
      readScope: "public",
      writeScope: "self",
      markdown: `# parent-id-regression-${scope}`,
    });
    if ("error" in created) throw new Error(created.error);

    for (const user of [undefined, viewer]) {
      const access = await resolveFolderAccess(env, owner.id, child, user);
      assert.equal(access.parentId, null);
      assert.deepEqual(access.crumbs, [{ id: childId, name: "published" }]);
      assert.deepEqual(access.grants, []);
      const folders = user
        ? await listSharedFolders(env, user)
        : await listPublicSharedFolders(env);
      assert.equal(folders.find((f) => f.id === childId)?.parentId, null);
      assert.equal(JSON.stringify(folders).includes(parentId!), false);
      const listed = user
        ? await notes.listForUser(user)
        : await notes.listForGuest();
      assert.equal(listed.find((n) => n.id === created.id)?.folderId, null);
      const direct = await notes.get(created.id, user);
      assert.equal(direct.kind, "ok");
      if (direct.kind !== "ok") throw new Error("expected readable note");
      assert.equal(direct.note.folderId, null);
    }
    const search = await notes.searchForUser(
      viewer,
      `parent-id-regression-${scope}`,
    );
    assert.equal(search[0]?.folderId, null);
    assert.equal(
      (await resolveFolderAccess(env, owner.id, child, owner)).parentId,
      parentId,
    );

    await replaceGrants(env, owner.id, "folder", parent, [
      { email: viewer.email },
    ]);
    const shared = await resolveFolderAccess(env, owner.id, child, viewer);
    assert.equal(shared.parentId, parentId);
    assert.equal(
      (await notes.searchForUser(viewer, `parent-id-regression-${scope}`))[0]
        ?.folderId,
      parentId,
    );
  }
});

test("known link folders expose inherited children, not separately unlisted children", async (t) => {
  const { env, owner, viewer, sqlite } = await createEnvWithSeededData();
  t.after(() => sqlite.close());
  await upsertFolderPolicy(env, owner.id, "known", "link", "self");
  await ensureFolderRow(env, owner.id, "known/inherited");
  await upsertFolderPolicy(env, owner.id, "known/other-link", "link", "self");
  await ensureFolderRow(env, owner.id, "known/other-link");
  await upsertFolderPolicy(
    env,
    owner.id,
    "known/other-login",
    "signed_in",
    "self",
  );
  await ensureFolderRow(env, owner.id, "known/other-login");
  for (const user of [undefined, viewer]) {
    const access = await resolveFolderAccess(env, owner.id, "known", user);
    assert.equal(access.flags.canView, true);
    assert.deepEqual(
      access.children.map((f) => f.name),
      ["inherited"],
    );
  }
});
