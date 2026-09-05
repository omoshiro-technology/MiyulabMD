import {
  type AccessGrant,
  type AccessGrantInput,
  type AccessScope,
  type AccessSource,
  type Actor,
  actorFromUser,
  clampWriteScope,
  type EffectiveAccess,
  evaluateAccess,
  type FolderAccess,
  type FolderCrumb,
  type FolderRecord,
  folderAncestors,
  folderContains,
  grantForActor,
  isAccessScope,
  isDriveRootPath,
  MY_DRIVE_NAME,
  type NoteAccess,
  type PermissionFlags,
  presetFromScopes,
  ROOT_SCOPES,
  rewriteFolderPrefix,
  type SessionUser,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import { findUserByEmail } from "../db/users.ts";
import { instanceFlags } from "../env.ts";

function applyInstanceFlags(
  flags: PermissionFlags,
  actor: Actor,
  env: Env,
): PermissionFlags {
  if (actor.kind !== "guest") {
    return flags;
  }

  const { allowAnonymousViews, allowAnonymousEdits } = instanceFlags(env);
  if (!allowAnonymousViews) {
    return { canView: false, canEdit: false, canAdmin: false };
  }
  if (!allowAnonymousEdits) {
    return { ...flags, canEdit: false, canAdmin: false };
  }
  return flags;
}

export type NoteAccessFields = {
  id: string;
  ownerId: string;
  folder: string;
  readScope: AccessScope | null;
  writeScope: AccessScope | null;
};

type FolderPolicyRow = {
  owner_id: string;
  folder: string;
  read_scope: string;
  write_scope: string;
};

type GrantRow = {
  email: string;
  user_id: string | null;
  can_write: number;
};

export type FolderRow = {
  id: string;
  owner_id: string;
  folder: string;
  created_at: number;
};

function parseScope(value: string | null | undefined): AccessScope | null {
  if (!value) return null;
  return isAccessScope(value) ? value : null;
}

function rowToGrant(row: GrantRow): AccessGrant {
  return {
    email: row.email,
    userId: row.user_id,
    canWrite: row.can_write === 1,
  };
}

export function defaultScopes(_env?: Env): {
  readScope: AccessScope;
  writeScope: AccessScope;
} {
  return { ...ROOT_SCOPES };
}

export function normalizeGrantEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

async function loadFolderPolicies(
  env: Env,
  ownerId: string,
  folders: string[],
): Promise<Map<string, { readScope: AccessScope; writeScope: AccessScope }>> {
  const unique = [...new Set(folders)];
  const map = new Map<
    string,
    { readScope: AccessScope; writeScope: AccessScope }
  >();
  if (unique.length === 0) return map;

  const placeholders = unique.map(() => "?").join(", ");
  const rows = await db(env)
    .prepare(
      `SELECT owner_id, folder, read_scope, write_scope
       FROM folder_policies
       WHERE owner_id = ? AND folder IN (${placeholders})`,
    )
    .bind(ownerId, ...unique)
    .all<FolderPolicyRow>();

  for (const row of rows.results ?? []) {
    const readScope = parseScope(row.read_scope);
    const writeScope = parseScope(row.write_scope);
    if (readScope && writeScope) {
      map.set(row.folder, {
        readScope,
        writeScope: clampWriteScope(readScope, writeScope),
      });
    }
  }
  return map;
}

async function loadGrants(
  env: Env,
  ownerId: string,
  noteId: string | null,
  folders: string[],
): Promise<AccessGrant[]> {
  const folderKeys = folders.length > 0 ? folders : [""];
  const folderPlaceholders = folderKeys.map(() => "?").join(", ");
  const clauses = [
    `(target_kind = 'folder' AND target_key IN (${folderPlaceholders}))`,
  ];
  const binds: unknown[] = [ownerId];
  if (noteId) {
    clauses.unshift("(target_kind = 'note' AND target_key = ?)");
    binds.push(noteId);
  }
  binds.push(...folderKeys);

  const rows = await db(env)
    .prepare(
      `SELECT email, user_id, can_write
       FROM access_grants
       WHERE owner_id = ? AND (${clauses.join(" OR ")})
       ORDER BY email`,
    )
    .bind(...binds)
    .all<GrantRow>();

  const seen = new Map<string, AccessGrant>();
  for (const row of rows.results ?? []) {
    const grant = rowToGrant(row);
    const current = seen.get(grant.email);
    if (!current || (grant.canWrite && !current.canWrite)) {
      seen.set(grant.email, grant);
    }
  }
  return [...seen.values()];
}

function resolveFromPolicies(
  folder: string,
  policies: Map<string, { readScope: AccessScope; writeScope: AccessScope }>,
): Pick<
  EffectiveAccess,
  "effectiveReadScope" | "effectiveWriteScope" | "source" | "sourceFolder"
> {
  for (const ancestor of folderAncestors(folder)) {
    if (ancestor === "") {
      return {
        effectiveReadScope: ROOT_SCOPES.readScope,
        effectiveWriteScope: ROOT_SCOPES.writeScope,
        source: "folder",
        sourceFolder: "",
      };
    }
    const policy = policies.get(ancestor);
    if (policy) {
      return {
        effectiveReadScope: policy.readScope,
        effectiveWriteScope: policy.writeScope,
        source: "folder",
        sourceFolder: ancestor,
      };
    }
  }
  return {
    effectiveReadScope: ROOT_SCOPES.readScope,
    effectiveWriteScope: ROOT_SCOPES.writeScope,
    source: "folder",
    sourceFolder: "",
  };
}

export async function resolveNoteAccess(
  env: Env,
  note: NoteAccessFields,
  user?: SessionUser | null,
): Promise<NoteAccess> {
  const inherit = note.readScope === null && note.writeScope === null;
  const ancestors = folderAncestors(note.folder);
  const [policies, grants] = await Promise.all([
    loadFolderPolicies(env, note.ownerId, ancestors),
    loadGrants(env, note.ownerId, note.id, ancestors),
  ]);

  let source: AccessSource = "note";
  let sourceFolder: string | null = null;
  let effectiveReadScope: AccessScope;
  let effectiveWriteScope: AccessScope;

  if (!inherit && note.readScope && note.writeScope) {
    effectiveReadScope = note.readScope;
    effectiveWriteScope = clampWriteScope(note.readScope, note.writeScope);
  } else {
    const resolved = resolveFromPolicies(note.folder, policies);
    effectiveReadScope = resolved.effectiveReadScope;
    effectiveWriteScope = resolved.effectiveWriteScope;
    source = resolved.source;
    sourceFolder = resolved.sourceFolder;
  }

  const actor = actorFromUser(user, note.ownerId);
  const grant = grantForActor(grants, actor);
  const flags = applyInstanceFlags(
    evaluateAccess(effectiveReadScope, effectiveWriteScope, actor, grant),
    actor,
    env,
  );

  return {
    inherit,
    readScope: note.readScope,
    writeScope: note.writeScope,
    effectiveReadScope,
    effectiveWriteScope,
    source,
    sourceFolder,
    grants,
    flags,
  };
}

export function folderName(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function parentFolderPath(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export async function getFolderById(
  env: Env,
  id: string,
): Promise<FolderRow | null> {
  return (
    (await db(env)
      .prepare(
        "SELECT id, owner_id, folder, created_at FROM folders WHERE id = ?",
      )
      .bind(id)
      .first<FolderRow>()) ?? null
  );
}

export async function getFolderByPath(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<FolderRow | null> {
  return (
    (await db(env)
      .prepare(
        "SELECT id, owner_id, folder, created_at FROM folders WHERE owner_id = ? AND folder = ?",
      )
      .bind(ownerId, folder)
      .first<FolderRow>()) ?? null
  );
}

type FolderPolicyResolved = Omit<
  FolderAccess,
  "id" | "name" | "parentId" | "crumbs" | "children" | "flags"
> & { folder: string };

async function loadFolderEffective(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<FolderPolicyResolved> {
  if (folder === "") {
    return {
      folder: "",
      inherit: false,
      readScope: ROOT_SCOPES.readScope,
      writeScope: ROOT_SCOPES.writeScope,
      effectiveReadScope: ROOT_SCOPES.readScope,
      effectiveWriteScope: ROOT_SCOPES.writeScope,
      source: "folder",
      sourceFolder: "",
      grants: [],
      locked: true,
    };
  }

  const ancestors = folderAncestors(folder);
  const [policies, grants] = await Promise.all([
    loadFolderPolicies(env, ownerId, ancestors),
    loadGrants(env, ownerId, null, ancestors),
  ]);
  const stored = policies.get(folder);
  const inherit = !stored;
  const resolved = stored
    ? {
        effectiveReadScope: stored.readScope,
        effectiveWriteScope: stored.writeScope,
        source: "folder" as const,
        sourceFolder: folder,
      }
    : resolveFromPolicies(folderAncestors(folder).slice(1)[0] ?? "", policies);

  return {
    folder,
    inherit,
    readScope: stored?.readScope ?? null,
    writeScope: stored?.writeScope ?? null,
    effectiveReadScope: resolved.effectiveReadScope,
    effectiveWriteScope: resolved.effectiveWriteScope,
    source: stored ? "folder" : resolved.source,
    sourceFolder: stored ? folder : resolved.sourceFolder,
    grants,
    locked: false,
  };
}

/** 閲覧権限だけでは URL・ID の列挙に同意したことにはならない。 */
export function canDiscoverAccess(
  access: EffectiveAccess & { flags: PermissionFlags },
  ownerId: string,
  user?: SessionUser | null,
): boolean {
  const actor = actorFromUser(user, ownerId);
  return (
    access.flags.canView &&
    (actor.kind === "owner" ||
      access.effectiveReadScope === "public" ||
      grantForActor(access.grants, actor) !== null)
  );
}

async function loadFolderAccessState(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
): Promise<FolderPolicyResolved & { flags: PermissionFlags }> {
  const effective = await loadFolderEffective(env, ownerId, folder);
  const actor = actorFromUser(user, ownerId);
  const grant = grantForActor(effective.grants, actor);
  const flags = applyInstanceFlags(
    evaluateAccess(
      effective.effectiveReadScope,
      effective.effectiveWriteScope,
      actor,
      grant,
    ),
    actor,
    env,
  );
  return { ...effective, flags };
}

export async function folderViewFlags(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
): Promise<PermissionFlags> {
  return (await loadFolderAccessState(env, ownerId, folder, user)).flags;
}

export async function folderDiscoveryAllowed(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
): Promise<boolean> {
  return canDiscoverAccess(
    await loadFolderAccessState(env, ownerId, folder, user),
    ownerId,
    user,
  );
}

async function visibleCrumbs(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
): Promise<FolderCrumb[]> {
  const parts = folder.split("/").filter(Boolean);
  const crumbs: FolderCrumb[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    const path = parts.slice(0, i).join("/");
    const rec = await getFolderByPath(env, ownerId, path);
    if (!rec) continue;
    const access = await loadFolderAccessState(env, ownerId, path, user);
    // 自分自身の URL は既知。祖先の URL は別途発見可能な場合だけ返す。
    if (
      access.flags.canView &&
      (path === folder || canDiscoverAccess(access, ownerId, user))
    ) {
      crumbs.push({ id: rec.id, name: parts[i - 1] ?? rec.id });
    } else {
      crumbs.length = 0;
    }
  }
  return crumbs;
}

async function listVisibleChildren(
  env: Env,
  ownerId: string,
  folder: string,
  currentId: string | null,
  user?: SessionUser | null,
): Promise<FolderRecord[]> {
  const isOwner = user?.id === ownerId;
  const rows = await db(env)
    .prepare(
      "SELECT id, owner_id, folder, created_at FROM folders WHERE owner_id = ? ORDER BY folder",
    )
    .bind(ownerId)
    .all<FolderRow>();

  const children: FolderRecord[] = [];
  for (const row of rows.results ?? []) {
    if (!row.folder || parentFolderPath(row.folder) !== folder) continue;
    const effective = await loadFolderEffective(env, ownerId, row.folder);
    const actor = actorFromUser(user, ownerId);
    const grant = grantForActor(effective.grants, actor);
    const flags = applyInstanceFlags(
      evaluateAccess(
        effective.effectiveReadScope,
        effective.effectiveWriteScope,
        actor,
        grant,
      ),
      actor,
      env,
    );
    if (!flags.canView) continue;
    // 既知のフォルダから継承した子は辿れるが、別のリンク限定設定は列挙しない。
    const inheritsKnownFolder =
      effective.sourceFolder !== null &&
      folderContains(effective.sourceFolder, folder);
    if (
      !inheritsKnownFolder &&
      !canDiscoverAccess({ ...effective, flags }, ownerId, user)
    )
      continue;
    children.push({
      id: row.id,
      name: folderName(row.folder),
      parentId: currentId,
      readScope: effective.effectiveReadScope,
      writeScope: effective.effectiveWriteScope,
      ...(isOwner ? { folder: row.folder } : {}),
    });
  }
  return children.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function presentFolderAccess(
  access: FolderAccess,
  isOwner: boolean,
): FolderAccess {
  if (isOwner) return access;
  return {
    ...access,
    folder: undefined,
    sourceFolder: null,
    grants: [],
    children: access.children.map((child) => ({
      id: child.id,
      name: child.name,
      parentId: child.parentId,
      readScope: child.readScope,
      writeScope: child.writeScope,
    })),
  };
}

export async function resolveFolderAccess(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
): Promise<FolderAccess> {
  const { flags, ...effective } = await loadFolderAccessState(
    env,
    ownerId,
    folder,
    user,
  );
  const id = await ensureFolderRow(env, ownerId, folder);
  const crumbs = folder ? await visibleCrumbs(env, ownerId, folder, user) : [];
  const isOwner = user?.id === ownerId;
  const parentId = folder
    ? crumbs.length >= 2
      ? (crumbs[crumbs.length - 2]?.id ?? null)
      : isOwner
        ? await ensureFolderRow(env, ownerId, "")
        : null
    : null;
  const children = await listVisibleChildren(env, ownerId, folder, id, user);

  return presentFolderAccess(
    {
      ...effective,
      id,
      name: folder ? folderName(folder) : MY_DRIVE_NAME,
      parentId,
      crumbs,
      children,
      flags,
      ...(isOwner ? { folder } : { folder: undefined, sourceFolder: null }),
    },
    isOwner,
  );
}

export async function ensureFolderRow(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<string | null> {
  const parent = parentFolderPath(folder);
  if (folder && parent !== folder) {
    await ensureFolderRow(env, ownerId, parent);
  }

  const existing = await getFolderByPath(env, ownerId, folder);
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  try {
    await db(env)
      .prepare(
        "INSERT INTO folders (id, owner_id, folder, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(id, ownerId, folder, Date.now())
      .run();
    return id;
  } catch {
    const raced = await getFolderByPath(env, ownerId, folder);
    return raced?.id ?? null;
  }
}

export async function listOwnedFolders(
  env: Env,
  ownerId: string,
): Promise<FolderRecord[]> {
  const rows = await db(env)
    .prepare(
      "SELECT id, owner_id, folder, created_at FROM folders WHERE owner_id = ? ORDER BY folder",
    )
    .bind(ownerId)
    .all<FolderRow>();
  const byPath = new Map((rows.results ?? []).map((row) => [row.folder, row]));
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.folder ? folderName(row.folder) : MY_DRIVE_NAME,
    parentId: isDriveRootPath(row.folder)
      ? null
      : (byPath.get(parentFolderPath(row.folder))?.id ?? null),
    folder: row.folder,
  }));
}

export async function listSharedFolders(
  env: Env,
  user: SessionUser,
): Promise<FolderRecord[]> {
  const grants = await listSharedFolderCandidates(env, user);
  const seen = new Set<string>();
  const folders: FolderRecord[] = [];

  for (const grant of grants) {
    if (grant.ownerId === user.id || isDriveRootPath(grant.folder)) continue;
    const access = await resolveFolderAccess(
      env,
      grant.ownerId,
      grant.folder,
      user,
    );
    // resolveFolderAccess は非オーナーの grants を伏せるため、内部状態で判定する。
    if (
      !(await folderDiscoveryAllowed(env, grant.ownerId, grant.folder, user)) ||
      !access.id ||
      seen.has(access.id)
    )
      continue;
    seen.add(access.id);
    folders.push({
      id: access.id,
      name: access.name,
      parentId: access.parentId,
      readScope: access.effectiveReadScope,
      writeScope: access.effectiveWriteScope,
    });
  }

  return folders.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export async function listPublicSharedFolders(
  env: Env,
): Promise<FolderRecord[]> {
  const grants = await listPublicFolderCandidates(env);
  const seen = new Set<string>();
  const folders: FolderRecord[] = [];

  for (const grant of grants) {
    if (isDriveRootPath(grant.folder)) continue;
    const access = await resolveFolderAccess(
      env,
      grant.ownerId,
      grant.folder,
      null,
    );
    if (
      !access.flags.canView ||
      access.effectiveReadScope !== "public" ||
      !access.id
    ) {
      continue;
    }
    if (seen.has(access.id)) continue;
    seen.add(access.id);
    folders.push({
      id: access.id,
      name: access.name,
      parentId: access.parentId,
      readScope: access.effectiveReadScope,
      writeScope: access.effectiveWriteScope,
    });
  }

  return folders.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export async function createOwnedFolder(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
): Promise<FolderAccess> {
  await ensureFolderRow(env, ownerId, folder);
  const current = await resolveFolderAccess(
    env,
    ownerId,
    folder,
    user ?? { id: ownerId, email: "", displayName: null },
  );
  if (current.inherit) {
    await upsertFolderPolicy(
      env,
      ownerId,
      folder,
      current.effectiveReadScope,
      current.effectiveWriteScope,
    );
  }
  return resolveFolderAccess(
    env,
    ownerId,
    folder,
    user ?? { id: ownerId, email: "", displayName: null },
  );
}

export async function listPublicFolderCandidates(
  env: Env,
): Promise<Array<{ ownerId: string; folder: string }>> {
  const rows = await db(env)
    .prepare(
      "SELECT owner_id, folder FROM folder_policies WHERE read_scope = 'public'",
    )
    .all<{ owner_id: string; folder: string }>();

  return (rows.results ?? []).map((row) => ({
    ownerId: row.owner_id,
    folder: row.folder,
  }));
}

export async function replaceGrants(
  env: Env,
  ownerId: string,
  targetKind: "note" | "folder",
  targetKey: string,
  grants: AccessGrantInput[],
): Promise<AccessGrant[] | { error: string }> {
  const normalized: AccessGrant[] = [];
  const seen = new Set<string>();

  for (const input of grants) {
    const email = normalizeGrantEmail(input.email);
    if (!email) {
      return { error: "invalid grant email" };
    }
    if (seen.has(email)) continue;
    seen.add(email);
    const user = await findUserByEmail(env, email);
    normalized.push({
      email,
      userId: user?.id ?? null,
      canWrite: Boolean(input.canWrite),
    });
  }

  await db(env)
    .prepare(
      "DELETE FROM access_grants WHERE owner_id = ? AND target_kind = ? AND target_key = ?",
    )
    .bind(ownerId, targetKind, targetKey)
    .run();

  const now = Date.now();
  for (const grant of normalized) {
    await db(env)
      .prepare(
        `INSERT INTO access_grants (id, owner_id, target_kind, target_key, email, user_id, can_write, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        ownerId,
        targetKind,
        targetKey,
        grant.email,
        grant.userId,
        grant.canWrite ? 1 : 0,
        now,
      )
      .run();
  }

  return normalized;
}

export async function upsertFolderPolicy(
  env: Env,
  ownerId: string,
  folder: string,
  readScope: AccessScope,
  writeScope: AccessScope,
): Promise<void> {
  if (!folder) {
    throw new Error("root folder policy is fixed");
  }
  await ensureFolderRow(env, ownerId, folder);
  const write = clampWriteScope(readScope, writeScope);
  await db(env)
    .prepare(
      `INSERT INTO folder_policies (owner_id, folder, read_scope, write_scope, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, folder) DO UPDATE SET
         read_scope = excluded.read_scope,
         write_scope = excluded.write_scope,
         updated_at = excluded.updated_at`,
    )
    .bind(ownerId, folder, readScope, write, Date.now())
    .run();
}

export async function deleteFolderPolicy(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<void> {
  await db(env)
    .prepare("DELETE FROM folder_policies WHERE owner_id = ? AND folder = ?")
    .bind(ownerId, folder)
    .run();
}

export async function renameFolderTree(
  env: Env,
  ownerId: string,
  from: string,
  to: string,
): Promise<void> {
  if (!from || !to || from === to) return;

  const folderRows = await db(env)
    .prepare("SELECT folder FROM folders WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ folder: string }>();
  const policyRows = await db(env)
    .prepare("SELECT folder FROM folder_policies WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ folder: string }>();
  const grantRows = await db(env)
    .prepare(
      "SELECT id, target_key FROM access_grants WHERE owner_id = ? AND target_kind = 'folder'",
    )
    .bind(ownerId)
    .all<{ id: string; target_key: string }>();

  for (const row of folderRows.results ?? []) {
    const next = rewriteFolderPrefix(row.folder, from, to);
    if (next === null) continue;
    await db(env)
      .prepare(
        "UPDATE folders SET folder = ? WHERE owner_id = ? AND folder = ?",
      )
      .bind(next, ownerId, row.folder)
      .run();
  }

  for (const row of policyRows.results ?? []) {
    const next = rewriteFolderPrefix(row.folder, from, to);
    if (next === null) continue;
    await db(env)
      .prepare(
        "UPDATE folder_policies SET folder = ? WHERE owner_id = ? AND folder = ?",
      )
      .bind(next, ownerId, row.folder)
      .run();
  }

  for (const row of grantRows.results ?? []) {
    const next = rewriteFolderPrefix(row.target_key, from, to);
    if (next === null) continue;
    await db(env)
      .prepare("UPDATE access_grants SET target_key = ? WHERE id = ?")
      .bind(next, row.id)
      .run();
  }
}

export async function deleteFolderTree(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<void> {
  if (!folder) return;
  const rows = await db(env)
    .prepare("SELECT folder FROM folders WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ folder: string }>();

  for (const row of rows.results ?? []) {
    if (!folderContains(folder, row.folder)) continue;
    await deleteFolderPolicy(env, ownerId, row.folder);
    await db(env)
      .prepare(
        "DELETE FROM access_grants WHERE owner_id = ? AND target_kind = 'folder' AND target_key = ?",
      )
      .bind(ownerId, row.folder)
      .run();
    await db(env)
      .prepare("DELETE FROM folders WHERE owner_id = ? AND folder = ?")
      .bind(ownerId, row.folder)
      .run();
  }
}

export async function listSharedFolderCandidates(
  env: Env,
  user: SessionUser,
): Promise<Array<{ ownerId: string; folder: string }>> {
  const rows = await db(env)
    .prepare(
      `SELECT owner_id, target_key
       FROM access_grants
       WHERE target_kind = 'folder' AND (user_id = ? OR email = ?)
       UNION
       SELECT owner_id, folder AS target_key
       FROM folder_policies
       WHERE read_scope = 'public'`,
    )
    .bind(user.id, user.email)
    .all<{ owner_id: string; target_key: string }>();

  return (rows.results ?? []).map((row) => ({
    ownerId: row.owner_id,
    folder: row.target_key,
  }));
}

export function noteMatchesFolderGrant(
  noteFolder: string,
  grantFolder: string,
): boolean {
  return folderContains(grantFolder, noteFolder);
}

export function derivedPermission(
  access: Pick<EffectiveAccess, "effectiveReadScope" | "effectiveWriteScope">,
) {
  return presetFromScopes(
    access.effectiveReadScope,
    access.effectiveWriteScope,
  );
}
