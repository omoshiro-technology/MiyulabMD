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
  type FolderChildrenResult,
  type FolderCrumb,
  type FolderEntry,
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
    return { canAdmin: false, canEdit: false, canView: false };
  }
  if (!allowAnonymousEdits) {
    return { ...flags, canAdmin: false, canEdit: false };
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
  scheme?: string | null;
  scheme_id?: string | null;
  scheme_title?: string | null;
  scheme_root?: string | null;
};

function parseScope(value: string | null | undefined): AccessScope | null {
  if (!value) {
    return null;
  }
  return isAccessScope(value) ? value : null;
}

function rowToGrant(row: GrantRow): AccessGrant {
  return {
    canWrite: row.can_write === 1,
    email: row.email,
    userId: row.user_id,
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

/**
 * 1リクエスト内でノート一覧を組み立てるためのプリロード済みアクセスデータ。
 * folder_policies / access_grants / folders をオーナー単位で一括取得し、
 * ノート毎の per-row クエリ(N+1)を避ける。
 */
export type AccessSnapshot = {
  /** owner_id -> folder path -> policy */
  policies: Map<
    string,
    Map<string, { readScope: AccessScope; writeScope: AccessScope }>
  >;
  /** owner_id -> raw grant rows (target_kind/target_key 付き) */
  grants: Map<string, SnapshotGrantRow[]>;
  /** owner_id -> folder path -> row */
  foldersByPath: Map<string, Map<string, FolderRow>>;
  /** folder id -> row */
  foldersById: Map<string, FolderRow>;
};

type SnapshotGrantRow = GrantRow & {
  owner_id: string;
  target_kind: string;
  target_key: string;
};

/** D1 のバインド上限(100)を下回るオーナー単位のチャンク幅。 */
const SNAPSHOT_OWNER_CHUNK = 50;

export async function buildAccessSnapshot(
  env: Env,
  ownerIds: readonly string[],
): Promise<AccessSnapshot> {
  const snapshot: AccessSnapshot = {
    foldersById: new Map(),
    foldersByPath: new Map(),
    grants: new Map(),
    policies: new Map(),
  };
  const unique = [...new Set(ownerIds)];
  if (unique.length === 0) {
    return snapshot;
  }
  // D1 のバインド上限(100)を超えないようオーナーをチャンクに分けて取得する。
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += SNAPSHOT_OWNER_CHUNK) {
    chunks.push(unique.slice(i, i + SNAPSHOT_OWNER_CHUNK));
  }
  const inClause = (owners: string[]) => owners.map(() => "?").join(", ");
  const runChunked = async <T>(
    query: (owners: string[]) => Promise<{ results: T[] }>,
  ): Promise<T[]> => {
    const results = await Promise.all(chunks.map((owners) => query(owners)));
    return results.flatMap((result) => result.results ?? []);
  };
  const [policyRows, grantRows, folderRows] = await Promise.all([
    runChunked<FolderPolicyRow>((owners) =>
      db(env)
        .prepare(
          `SELECT owner_id, folder, read_scope, write_scope
           FROM folder_policies WHERE owner_id IN (${inClause(owners)})`,
        )
        .bind(...owners)
        .all<FolderPolicyRow>(),
    ),
    runChunked<SnapshotGrantRow>((owners) =>
      db(env)
        .prepare(
          `SELECT owner_id, target_kind, target_key, email, user_id, can_write
           FROM access_grants WHERE owner_id IN (${inClause(owners)}) ORDER BY email`,
        )
        .bind(...owners)
        .all<SnapshotGrantRow>(),
    ),
    runChunked<FolderRow>((owners) =>
      db(env)
        .prepare(
          `SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at
           FROM folders WHERE owner_id IN (${inClause(owners)})`,
        )
        .bind(...owners)
        .all<FolderRow>(),
    ),
  ]);

  for (const row of policyRows) {
    indexPolicyRow(snapshot, row);
  }
  for (const row of grantRows) {
    const list = snapshot.grants.get(row.owner_id);
    if (list) {
      list.push(row);
    } else {
      snapshot.grants.set(row.owner_id, [row]);
    }
  }
  for (const row of folderRows) {
    indexFolderRow(snapshot, row);
  }
  return snapshot;
}

function indexPolicyRow(snapshot: AccessSnapshot, row: FolderPolicyRow): void {
  const readScope = parseScope(row.read_scope);
  const writeScope = parseScope(row.write_scope);
  if (!(readScope && writeScope)) {
    return;
  }
  let byFolder = snapshot.policies.get(row.owner_id);
  if (!byFolder) {
    byFolder = new Map();
    snapshot.policies.set(row.owner_id, byFolder);
  }
  byFolder.set(row.folder, {
    readScope,
    writeScope: clampWriteScope(readScope, writeScope),
  });
}

function indexFolderRow(snapshot: AccessSnapshot, row: FolderRow): void {
  let byPath = snapshot.foldersByPath.get(row.owner_id);
  if (!byPath) {
    byPath = new Map();
    snapshot.foldersByPath.set(row.owner_id, byPath);
  }
  byPath.set(row.folder, row);
  snapshot.foldersById.set(row.id, row);
}

const EMPTY_POLICY_MAP: Map<
  string,
  { readScope: AccessScope; writeScope: AccessScope }
> = new Map();

/** loadGrants と同じ結果をスナップショットから組み立てる。 */
function snapshotGrants(
  snapshot: AccessSnapshot,
  ownerId: string,
  noteId: string | null,
  folders: string[],
): AccessGrant[] {
  const rows = snapshot.grants.get(ownerId);
  if (!rows) {
    return [];
  }
  const folderKeys = folders.length > 0 ? folders : [""];
  const folderSet = new Set(folderKeys);
  const seen = new Map<string, AccessGrant>();
  for (const row of rows) {
    const matches =
      row.target_kind === "note"
        ? noteId !== null && row.target_key === noteId
        : row.target_kind === "folder" && folderSet.has(row.target_key);
    if (!matches) {
      continue;
    }
    const grant = rowToGrant(row);
    const current = seen.get(grant.email);
    if (!current || (grant.canWrite && !current.canWrite)) {
      seen.set(grant.email, grant);
    }
  }
  return [...seen.values()].sort((a, b) => (a.email < b.email ? -1 : 1));
}

/** resolveNoteAccess と同じ結果をスナップショットから同期的に組み立てる。 */
export function resolveNoteAccessSnapshot(
  env: Env,
  note: NoteAccessFields,
  user: SessionUser | null | undefined,
  snapshot: AccessSnapshot,
): NoteAccess {
  const inherit = note.readScope === null && note.writeScope === null;
  const ancestors = folderAncestors(note.folder);
  const policies = snapshot.policies.get(note.ownerId) ?? EMPTY_POLICY_MAP;
  const grants = snapshotGrants(snapshot, note.ownerId, note.id, ancestors);

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
    effectiveReadScope,
    effectiveWriteScope,
    flags,
    grants,
    inherit,
    readScope: note.readScope,
    source,
    sourceFolder,
    writeScope: note.writeScope,
  };
}

function folderEffectiveSnapshot(
  ownerId: string,
  folder: string,
  snapshot: AccessSnapshot,
): FolderPolicyResolved {
  if (folder === "") {
    return {
      effectiveReadScope: ROOT_SCOPES.readScope,
      effectiveWriteScope: ROOT_SCOPES.writeScope,
      folder: "",
      grants: [],
      inherit: false,
      locked: true,
      readScope: ROOT_SCOPES.readScope,
      source: "folder",
      sourceFolder: "",
      writeScope: ROOT_SCOPES.writeScope,
    };
  }
  const ancestors = folderAncestors(folder);
  const policies = snapshot.policies.get(ownerId) ?? EMPTY_POLICY_MAP;
  const grants = snapshotGrants(snapshot, ownerId, null, ancestors);
  const stored = policies.get(folder);
  const inherit = !stored;
  const resolved = stored
    ? {
        effectiveReadScope: stored.readScope,
        effectiveWriteScope: stored.writeScope,
        source: "folder" as const,
        sourceFolder: folder,
      }
    : resolveFromPolicies(folderAncestors(folder).at(1) ?? "", policies);

  return {
    effectiveReadScope: resolved.effectiveReadScope,
    effectiveWriteScope: resolved.effectiveWriteScope,
    folder,
    grants,
    inherit,
    locked: false,
    readScope: stored?.readScope ?? null,
    source: stored ? "folder" : resolved.source,
    sourceFolder: stored ? folder : resolved.sourceFolder,
    writeScope: stored?.writeScope ?? null,
  };
}

function folderAccessStateFromEffective(
  env: Env,
  effective: FolderPolicyResolved,
  ownerId: string,
  user: SessionUser | null | undefined,
): FolderPolicyResolved & { flags: PermissionFlags } {
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

function folderAccessStateSnapshot(
  env: Env,
  ownerId: string,
  folder: string,
  user: SessionUser | null | undefined,
  snapshot: AccessSnapshot,
): FolderPolicyResolved & { flags: PermissionFlags } {
  return folderAccessStateFromEffective(
    env,
    folderEffectiveSnapshot(ownerId, folder, snapshot),
    ownerId,
    user,
  );
}

/** folderDiscoveryAllowed と同じ結果をスナップショットから返す。 */
export function folderDiscoveryAllowedSnapshot(
  env: Env,
  ownerId: string,
  folder: string,
  user: SessionUser | null | undefined,
  snapshot: AccessSnapshot,
): boolean {
  return canDiscoverAccess(
    folderAccessStateSnapshot(env, ownerId, folder, user, snapshot),
    ownerId,
    user,
  );
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
  if (unique.length === 0) {
    return map;
  }

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
    effectiveReadScope,
    effectiveWriteScope,
    flags,
    grants,
    inherit,
    readScope: note.readScope,
    source,
    sourceFolder,
    writeScope: note.writeScope,
  };
}

export function folderName(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
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
        "SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at FROM folders WHERE id = ?",
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
        "SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at FROM folders WHERE owner_id = ? AND folder = ?",
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
      effectiveReadScope: ROOT_SCOPES.readScope,
      effectiveWriteScope: ROOT_SCOPES.writeScope,
      folder: "",
      grants: [],
      inherit: false,
      locked: true,
      readScope: ROOT_SCOPES.readScope,
      source: "folder",
      sourceFolder: "",
      writeScope: ROOT_SCOPES.writeScope,
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
    : resolveFromPolicies(folderAncestors(folder).at(1) ?? "", policies);

  return {
    effectiveReadScope: resolved.effectiveReadScope,
    effectiveWriteScope: resolved.effectiveWriteScope,
    folder,
    grants,
    inherit,
    locked: false,
    readScope: stored?.readScope ?? null,
    source: stored ? "folder" : resolved.source,
    sourceFolder: stored ? folder : resolved.sourceFolder,
    writeScope: stored?.writeScope ?? null,
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
  snapshot?: AccessSnapshot,
): Promise<FolderPolicyResolved & { flags: PermissionFlags }> {
  const effective = snapshot
    ? folderEffectiveSnapshot(ownerId, folder, snapshot)
    : await loadFolderEffective(env, ownerId, folder);
  return folderAccessStateFromEffective(env, effective, ownerId, user);
}

export async function folderViewFlags(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
  snapshot?: AccessSnapshot,
): Promise<PermissionFlags> {
  return (await loadFolderAccessState(env, ownerId, folder, user, snapshot))
    .flags;
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

function snapshotFolderRow(
  snapshot: AccessSnapshot | undefined,
  ownerId: string,
  folder: string,
): FolderRow | null {
  return snapshot?.foldersByPath.get(ownerId)?.get(folder) ?? null;
}

async function visibleCrumbs(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
  snapshot?: AccessSnapshot,
): Promise<FolderCrumb[]> {
  const parts = folder.split("/").filter(Boolean);
  const crumbs: FolderCrumb[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    const path = parts.slice(0, i).join("/");
    const rec = snapshot
      ? snapshotFolderRow(snapshot, ownerId, path)
      : await getFolderByPath(env, ownerId, path);
    if (!rec) {
      continue;
    }
    const access = await loadFolderAccessState(
      env,
      ownerId,
      path,
      user,
      snapshot,
    );
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

async function projectVisibleChildFolder(
  env: Env,
  ownerId: string,
  row: FolderRow,
  parentFolder: string,
  currentId: string | null,
  user: SessionUser | null | undefined,
  isOwner: boolean,
  snapshot?: AccessSnapshot,
): Promise<FolderRecord | null> {
  if (!row.folder || parentFolderPath(row.folder) !== parentFolder) {
    return null;
  }
  const effective = snapshot
    ? folderEffectiveSnapshot(ownerId, row.folder, snapshot)
    : await loadFolderEffective(env, ownerId, row.folder);
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
  if (!flags.canView) {
    return null;
  }
  // 既知のフォルダから継承した子は辿れるが、別のリンク限定設定は列挙しない。
  const inheritsKnownFolder =
    effective.sourceFolder !== null &&
    folderContains(effective.sourceFolder, parentFolder);
  if (
    !(
      inheritsKnownFolder ||
      canDiscoverAccess({ ...effective, flags }, ownerId, user)
    )
  ) {
    return null;
  }
  return {
    id: row.id,
    name: folderName(row.folder),
    parentId: currentId,
    readScope: effective.effectiveReadScope,
    writeScope: effective.effectiveWriteScope,
    ...(isOwner
      ? {
          folder: row.folder,
          scheme: row.scheme ?? null,
          schemeId: row.scheme_id ?? null,
          schemeTitle: row.scheme_title ?? null,
        }
      : {}),
  };
}

function snapshotFolderRows(
  snapshot: AccessSnapshot | undefined,
  ownerId: string,
): FolderRow[] {
  return [...(snapshot?.foldersByPath.get(ownerId)?.values() ?? [])];
}

async function listVisibleChildren(
  env: Env,
  ownerId: string,
  folder: string,
  currentId: string | null,
  user?: SessionUser | null,
  snapshot?: AccessSnapshot,
): Promise<FolderRecord[]> {
  const isOwner = user?.id === ownerId;
  const rows = snapshot
    ? snapshotFolderRows(snapshot, ownerId)
    : ((
        await db(env)
          .prepare(
            "SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at FROM folders WHERE owner_id = ? ORDER BY folder",
          )
          .bind(ownerId)
          .all<FolderRow>()
      ).results ?? []);

  const children: FolderRecord[] = [];
  for (const row of rows) {
    const child = await projectVisibleChildFolder(
      env,
      ownerId,
      row,
      folder,
      currentId,
      user,
      isOwner,
      snapshot,
    );
    if (child) {
      children.push(child);
    }
  }
  return children.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function presentFolderAccess(
  access: FolderAccess,
  isOwner: boolean,
): FolderAccess {
  if (isOwner) {
    return access;
  }
  return {
    ...access,
    children: access.children.map((child) => ({
      id: child.id,
      name: child.name,
      parentId: child.parentId,
      readScope: child.readScope,
      writeScope: child.writeScope,
    })),
    folder: undefined,
    grants: [],
    sourceFolder: null,
  };
}

function snapshotAwareFolderId(
  env: Env,
  snap: AccessSnapshot | undefined,
  ownerId: string,
  folder: string,
): Promise<string | null> {
  const id = snapshotFolderRow(snap, ownerId, folder)?.id;
  return id === undefined
    ? ensureFolderRow(env, ownerId, folder)
    : Promise.resolve(id);
}

function snapshotAwareFolderRow(
  env: Env,
  snap: AccessSnapshot | undefined,
  ownerId: string,
  folder: string,
): Promise<FolderRow | null> {
  return snap
    ? Promise.resolve(snapshotFolderRow(snap, ownerId, folder))
    : getFolderByPath(env, ownerId, folder);
}

/** スナップショットに無いフォルダ行は ensureFolderRow が作成し得るため取り直す。 */
async function ensureSnapshotCoversFolder(
  env: Env,
  snap: AccessSnapshot | undefined,
  ownerId: string,
  folder: string,
): Promise<AccessSnapshot | undefined> {
  if (!snap || snapshotFolderRow(snap, ownerId, folder)) {
    return snap;
  }
  await ensureFolderRow(env, ownerId, folder);
  return buildAccessSnapshot(env, [ownerId]);
}

function folderAccessParentId(
  env: Env,
  snap: AccessSnapshot | undefined,
  ownerId: string,
  folder: string,
  crumbs: FolderCrumb[],
  isOwner: boolean,
): Promise<string | null> {
  if (folder && crumbs.length >= 2) {
    return Promise.resolve(crumbs.at(-2)?.id ?? null);
  }
  if (!(folder && isOwner)) {
    return Promise.resolve(null);
  }
  return snapshotAwareFolderId(env, snap, ownerId, "");
}

export async function resolveFolderAccess(
  env: Env,
  ownerId: string,
  folder: string,
  user?: SessionUser | null,
  snapshot?: AccessSnapshot,
): Promise<FolderAccess> {
  const snap = await ensureSnapshotCoversFolder(env, snapshot, ownerId, folder);
  const { flags, ...effective } = await loadFolderAccessState(
    env,
    ownerId,
    folder,
    user,
    snap,
  );
  const id = await snapshotAwareFolderId(env, snap, ownerId, folder);
  const crumbs = folder
    ? await visibleCrumbs(env, ownerId, folder, user, snap)
    : [];
  const isOwner = user?.id === ownerId;
  const parentId = await folderAccessParentId(
    env,
    snap,
    ownerId,
    folder,
    crumbs,
    isOwner,
  );
  const children = await listVisibleChildren(
    env,
    ownerId,
    folder,
    id,
    user,
    snap,
  );
  const row = await snapshotAwareFolderRow(env, snap, ownerId, folder);

  return presentFolderAccess(
    {
      ...effective,
      children,
      crumbs,
      flags,
      id,
      name: folder ? folderName(folder) : MY_DRIVE_NAME,
      parentId,
      scheme: row?.scheme ?? null,
      schemeId: row?.scheme_id ?? null,
      schemeTitle: row?.scheme_title ?? null,
      ...(isOwner ? { folder } : { folder: undefined, sourceFolder: null }),
    },
    isOwner,
  );
}

const FOLDER_ENTRIES_DEFAULT_LIMIT = 50;
const FOLDER_ENTRIES_MAX_LIMIT = 200;

type FolderEntryNoteRow = {
  id: string;
  owner_id: string;
  title: string;
  folder: string;
  read_scope: string | null;
  write_scope: string | null;
  updated_at: number;
};

function decodeFolderEntriesCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function folderEntryOf(
  record: FolderRecord,
  row: FolderRow,
  noteCounts: Map<string, number>,
  isOwner: boolean,
): FolderEntry {
  return {
    id: record.id,
    name: record.name,
    parentId: record.parentId,
    type: "folder",
    updatedAt: row.created_at,
    ...(isOwner
      ? {
          noteCount: noteCounts.get(row.id) ?? 0,
          scheme: row.scheme ?? null,
          schemeId: row.scheme_id ?? null,
          schemeTitle: row.scheme_title ?? null,
        }
      : {}),
  };
}

async function visibleChildFolders(
  env: Env,
  ownerId: string,
  rows: FolderRow[],
  folder: string,
  currentId: string | null,
  user: SessionUser | null | undefined,
  isOwner: boolean,
  snapshot?: AccessSnapshot,
): Promise<{ row: FolderRow; record: FolderRecord }[]> {
  const children: { row: FolderRow; record: FolderRecord }[] = [];
  for (const row of rows) {
    const record = await projectVisibleChildFolder(
      env,
      ownerId,
      row,
      folder,
      currentId,
      user,
      isOwner,
      snapshot,
    );
    if (record) {
      children.push({ record, row });
    }
  }
  return children;
}

function childNoteCounts(
  noteFolders: { folder: string }[],
  children: { row: FolderRow }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { folder: noteFolder } of noteFolders) {
    for (const child of children) {
      if (folderContains(child.row.folder, noteFolder)) {
        counts.set(child.row.id, (counts.get(child.row.id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

async function noteEntryVisible(
  env: Env,
  folder: string,
  row: FolderEntryNoteRow,
  ownerId: string,
  user?: SessionUser | null,
  snapshot?: AccessSnapshot,
): Promise<boolean> {
  const fields = {
    folder: row.folder ?? "",
    id: row.id,
    ownerId: row.owner_id,
    readScope: parseScope(row.read_scope),
    writeScope: parseScope(row.write_scope),
  };
  const access = snapshot
    ? resolveNoteAccessSnapshot(env, fields, user, snapshot)
    : await resolveNoteAccess(env, fields, user);
  if (!access.flags.canView) {
    return false;
  }
  const inheritsKnownFolder =
    access.sourceFolder !== null && folderContains(access.sourceFolder, folder);
  return inheritsKnownFolder || canDiscoverAccess(access, ownerId, user);
}

async function loadFolderEntryData(
  env: Env,
  ownerId: string,
  folder: string,
  isOwner: boolean,
  snapshot: AccessSnapshot | undefined,
): Promise<{
  folderRows: FolderRow[];
  noteRows: FolderEntryNoteRow[];
  noteFolderRows: { folder: string }[];
}> {
  const [noteRows, noteFolderRows, folderRows] = await Promise.all([
    db(env)
      .prepare(
        `SELECT id, owner_id, title, folder, read_scope, write_scope, updated_at
           FROM notes WHERE owner_id = ? AND folder = ?`,
      )
      .bind(ownerId, folder)
      .all<FolderEntryNoteRow>(),
    isOwner
      ? db(env)
          .prepare(
            "SELECT folder FROM notes WHERE owner_id = ? AND folder != ''",
          )
          .bind(ownerId)
          .all<{ folder: string }>()
      : Promise.resolve(null),
    snapshot
      ? Promise.resolve(null)
      : db(env)
          .prepare(
            "SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at FROM folders WHERE owner_id = ? ORDER BY folder",
          )
          .bind(ownerId)
          .all<FolderRow>(),
  ]);
  return {
    folderRows: snapshot
      ? snapshotFolderRows(snapshot, ownerId)
      : (folderRows?.results ?? []),
    noteFolderRows: noteFolderRows?.results ?? [],
    noteRows: noteRows.results ?? [],
  };
}

/** 直下の子フォルダとノートを1レスポンスで返す。発見可能性は resolveFolderAccess と同じ規則。 */
export async function listFolderChildren(
  env: Env,
  ownerId: string,
  folder: string,
  currentId: string | null,
  user?: SessionUser | null,
  options: { cursor?: string; limit?: number } = {},
  snapshot?: AccessSnapshot,
): Promise<FolderChildrenResult> {
  const requested = options.limit ?? FOLDER_ENTRIES_DEFAULT_LIMIT;
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), FOLDER_ENTRIES_MAX_LIMIT)
    : FOLDER_ENTRIES_DEFAULT_LIMIT;
  const offset = decodeFolderEntriesCursor(options.cursor);
  const isOwner = user?.id === ownerId;

  const data = await loadFolderEntryData(
    env,
    ownerId,
    folder,
    isOwner,
    snapshot,
  );

  const children = await visibleChildFolders(
    env,
    ownerId,
    data.folderRows,
    folder,
    currentId,
    user,
    isOwner,
    snapshot,
  );

  const noteCounts = isOwner
    ? childNoteCounts(data.noteFolderRows, children)
    : new Map<string, number>();

  const entries: FolderEntry[] = children.map(({ record, row }) =>
    folderEntryOf(record, row, noteCounts, isOwner),
  );
  for (const row of data.noteRows) {
    if (
      isOwner ||
      (await noteEntryVisible(env, folder, row, ownerId, user, snapshot))
    ) {
      entries.push({
        id: row.id,
        title: row.title,
        type: "note",
        updatedAt: row.updated_at,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    const byName = (a.type === "folder" ? a.name : a.title).localeCompare(
      b.type === "folder" ? b.name : b.title,
      "ja",
    );
    return byName === 0 ? a.id.localeCompare(b.id) : byName;
  });

  const page = entries.slice(offset, offset + limit);
  // 非オーナーには resolveFolderAccess の crumbs と同じ規則で、
  // 発見可能な祖先の suffix だけを返す。
  const path = isOwner
    ? folder.split("/").filter(Boolean)
    : (await visibleCrumbs(env, ownerId, folder, user, snapshot)).map(
        (crumb) => crumb.name,
      );
  return {
    entries: page,
    folder: {
      id: currentId,
      name: folder ? folderName(folder) : MY_DRIVE_NAME,
      path,
    },
    nextCursor: offset + limit < entries.length ? String(offset + limit) : null,
  };
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
  if (existing) {
    return existing.id;
  }

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
      "SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at FROM folders WHERE owner_id = ? ORDER BY folder",
    )
    .bind(ownerId)
    .all<FolderRow>();
  const byPath = new Map((rows.results ?? []).map((row) => [row.folder, row]));
  return (rows.results ?? []).map((row) => ({
    folder: row.folder,
    id: row.id,
    name: row.folder ? folderName(row.folder) : MY_DRIVE_NAME,
    parentId: isDriveRootPath(row.folder)
      ? null
      : (byPath.get(parentFolderPath(row.folder))?.id ?? null),
    scheme: row.scheme ?? null,
    schemeId: row.scheme_id ?? null,
    schemeTitle: row.scheme_title ?? null,
  }));
}

export async function listSharedFolders(
  env: Env,
  user: SessionUser,
): Promise<FolderRecord[]> {
  const grants = await listSharedFolderCandidates(env, user);
  const seen = new Set<string>();
  const folders: FolderRecord[] = [];
  const snapshot = await buildAccessSnapshot(
    env,
    grants.map((grant) => grant.ownerId),
  );

  for (const grant of grants) {
    if (grant.ownerId === user.id || isDriveRootPath(grant.folder)) {
      continue;
    }
    const access = await resolveFolderAccess(
      env,
      grant.ownerId,
      grant.folder,
      user,
      snapshot,
    );
    // resolveFolderAccess は非オーナーの grants を伏せるため、内部状態で判定する。
    if (
      !(
        folderDiscoveryAllowedSnapshot(
          env,
          grant.ownerId,
          grant.folder,
          user,
          snapshot,
        ) && access.id
      ) ||
      seen.has(access.id)
    ) {
      continue;
    }
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
  const snapshot = await buildAccessSnapshot(
    env,
    grants.map((grant) => grant.ownerId),
  );

  for (const grant of grants) {
    if (isDriveRootPath(grant.folder)) {
      continue;
    }
    const access = await resolveFolderAccess(
      env,
      grant.ownerId,
      grant.folder,
      null,
      snapshot,
    );
    if (
      !access.flags.canView ||
      access.effectiveReadScope !== "public" ||
      !access.id
    ) {
      continue;
    }
    if (seen.has(access.id)) {
      continue;
    }
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
    user ?? { displayName: null, email: "", id: ownerId },
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
    user ?? { displayName: null, email: "", id: ownerId },
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
    folder: row.folder,
    ownerId: row.owner_id,
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
    if (seen.has(email)) {
      continue;
    }
    seen.add(email);
    const user = await findUserByEmail(env, email);
    normalized.push({
      canWrite: Boolean(input.canWrite),
      email,
      userId: user?.id ?? null,
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

export async function deleteFolderTree(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<void> {
  if (!folder) {
    return;
  }
  const rows = await db(env)
    .prepare("SELECT folder FROM folders WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ folder: string }>();

  for (const row of rows.results ?? []) {
    if (!folderContains(folder, row.folder)) {
      continue;
    }
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
    folder: row.target_key,
    ownerId: row.owner_id,
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
