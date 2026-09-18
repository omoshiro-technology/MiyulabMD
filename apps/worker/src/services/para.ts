import {
  DEFAULT_PARA_SPACE_NAME,
  folderContains,
  isParaBucketKey,
  type MoveFolderResult,
  normalizeFolder,
  PARA_BUCKETS,
  type ParaBucket,
  type ParaBucketKey,
  type ParaEnableInput,
  type ParaEnableResult,
  type ParaListResult,
  type ParaPlan,
  type ParaPlanBucket,
  type ParaResolutionKey,
  type ParaSpacePlan,
  type ParaSpaceSelector,
  type ParaSpaceSummary,
  type SessionUser,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import {
  ensureFolderRow,
  folderName,
  getFolderById,
  listFolderChildren,
  parentFolderPath,
} from "./access.ts";
import { escapeLikePattern } from "./articles.ts";
import { type MoveError, moveFolder } from "./move.ts";
import { createNoteService } from "./notes.ts";

type BucketRow = { id: string; folder: string };

type FolderBucketRow = {
  id: string;
  owner_id: string;
  folder: string;
  para_bucket: string | null;
  para_space_id: string | null;
};

type SpaceRow = {
  id: string;
  owner_id: string;
  name: string;
  root_folder_id: string | null;
  created_at: number;
};

const SPACE_COLUMNS = "id, owner_id, name, root_folder_id, created_at";

/**
 * The space a plan/enable call operates on. `rootless` = the default space
 * (buckets at drive root, `para_space_id` NULL on folder rows); `rooted` = an
 * existing named space; `proposed` = a new named space whose root folder is
 * created/adopted during enable.
 */
type SpaceTarget =
  | { kind: "rootless"; row: SpaceRow | null; rootPath: string }
  | {
      kind: "rooted";
      row: SpaceRow;
      root: { id: string; folder: string };
      rootPath: string;
    }
  | { kind: "proposed"; name: string; rootPath: string };

/** `para_space_id` stored on this space's bucket rows. */
function bucketSpaceId(target: SpaceTarget): string | null {
  return target.kind === "rooted" ? target.row.id : null;
}

// --- space rows ---------------------------------------------------------------

async function spaceById(
  env: Env,
  ownerId: string,
  id: string,
): Promise<SpaceRow | null> {
  return (
    (await db(env)
      .prepare(
        `SELECT ${SPACE_COLUMNS} FROM para_spaces WHERE owner_id = ? AND id = ?`,
      )
      .bind(ownerId, id)
      .first<SpaceRow>()) ?? null
  );
}

async function spaceByName(
  env: Env,
  ownerId: string,
  name: string,
): Promise<SpaceRow | null> {
  return (
    (await db(env)
      .prepare(
        `SELECT ${SPACE_COLUMNS} FROM para_spaces WHERE owner_id = ? AND name = ?`,
      )
      .bind(ownerId, name)
      .first<SpaceRow>()) ?? null
  );
}

async function listSpaceRows(env: Env, ownerId: string): Promise<SpaceRow[]> {
  const rows = await db(env)
    .prepare(
      `SELECT ${SPACE_COLUMNS} FROM para_spaces WHERE owner_id = ? ORDER BY created_at, id`,
    )
    .bind(ownerId)
    .all<SpaceRow>();
  return rows.results ?? [];
}

async function rootlessSpaceRow(
  env: Env,
  ownerId: string,
): Promise<SpaceRow | null> {
  return (
    (await db(env)
      .prepare(
        `SELECT ${SPACE_COLUMNS} FROM para_spaces WHERE owner_id = ? AND root_folder_id IS NULL`,
      )
      .bind(ownerId)
      .first<SpaceRow>()) ?? null
  );
}

/** Flat-overlap rule (ADR 0005): a space root cannot double as a bucket. */
async function folderIsSpaceRoot(env: Env, folderId: string): Promise<boolean> {
  const row = await db(env)
    .prepare("SELECT id FROM para_spaces WHERE root_folder_id = ?")
    .bind(folderId)
    .first<{ id: string }>();
  return row !== null;
}

/** "conflict" = a uniqueness rule (name / root / rootless) fired. */
async function insertSpaceRow(
  env: Env,
  ownerId: string,
  name: string,
  rootFolderId: string | null,
): Promise<SpaceRow | "conflict"> {
  const row: SpaceRow = {
    created_at: Date.now(),
    id: crypto.randomUUID(),
    name,
    owner_id: ownerId,
    root_folder_id: rootFolderId,
  };
  try {
    await db(env)
      .prepare(
        "INSERT INTO para_spaces (id, owner_id, name, root_folder_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(row.id, ownerId, name, rootFolderId, row.created_at)
      .run();
    return row;
  } catch {
    return "conflict";
  }
}

/**
 * Materialize the rootless default-space row on first use. Buckets of the
 * default space keep `para_space_id = NULL` — the row exists only so the
 * space itself has an id/name for listing, rename and unassign.
 */
async function ensureRootlessSpace(
  env: Env,
  ownerId: string,
): Promise<SpaceRow | MoveError> {
  const existing = await rootlessSpaceRow(env, ownerId);
  if (existing) {
    return existing;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const name =
      attempt === 0
        ? DEFAULT_PARA_SPACE_NAME
        : `${DEFAULT_PARA_SPACE_NAME}-${attempt}`;
    const inserted = await insertSpaceRow(env, ownerId, name, null);
    if (inserted !== "conflict") {
      return inserted;
    }
    const raced = await rootlessSpaceRow(env, ownerId);
    if (raced) {
      return raced;
    }
  }
  return {
    error: "default スペースを作成できませんでした",
    kind: "invalid",
    status: 409,
  };
}

// --- folder rows ---------------------------------------------------------------

async function bucketRow(
  env: Env,
  ownerId: string,
  key: ParaBucketKey,
  spaceId: string | null,
): Promise<BucketRow | null> {
  const where =
    spaceId === null
      ? "owner_id = ? AND para_bucket = ? AND para_space_id IS NULL"
      : "owner_id = ? AND para_bucket = ? AND para_space_id = ?";
  const statement = db(env)
    .prepare(`SELECT id, folder FROM folders WHERE ${where}`)
    .bind(ownerId, key, ...(spaceId === null ? [] : [spaceId]));
  return (await statement.first<BucketRow>()) ?? null;
}

async function assignBucket(
  env: Env,
  key: ParaBucketKey,
  folderId: string,
  spaceId: string | null,
): Promise<void> {
  await db(env)
    .prepare(
      "UPDATE folders SET para_bucket = ?, para_space_id = ? WHERE id = ?",
    )
    .bind(key, spaceId, folderId)
    .run();
}

async function folderWithBucketById(
  env: Env,
  id: string,
): Promise<FolderBucketRow | null> {
  return (
    (await db(env)
      .prepare(
        "SELECT id, owner_id, folder, para_bucket, para_space_id FROM folders WHERE id = ?",
      )
      .bind(id)
      .first<FolderBucketRow>()) ?? null
  );
}

async function folderWithBucketAtPath(
  env: Env,
  ownerId: string,
  path: string,
): Promise<FolderBucketRow | null> {
  return (
    (await db(env)
      .prepare(
        "SELECT id, owner_id, folder, para_bucket, para_space_id FROM folders WHERE owner_id = ? AND folder = ?",
      )
      .bind(ownerId, path)
      .first<FolderBucketRow>()) ?? null
  );
}

type AssignedBucketRow = {
  bucket: ParaBucketKey;
  id: string;
  path: string;
  spaceId: string | null;
};

/** All bucket rows of one owner, tagged with their space (NULL = default). */
async function allAssignedBucketRows(
  env: Env,
  ownerId: string,
): Promise<AssignedBucketRow[]> {
  const rows = await db(env)
    .prepare(
      "SELECT id, folder, para_bucket, para_space_id FROM folders WHERE owner_id = ? AND para_bucket IS NOT NULL",
    )
    .bind(ownerId)
    .all<{
      id: string;
      folder: string;
      para_bucket: string;
      para_space_id: string | null;
    }>();
  return (rows.results ?? [])
    .filter((row) => isParaBucketKey(row.para_bucket))
    .map((row) => ({
      bucket: row.para_bucket as ParaBucketKey,
      id: row.id,
      path: row.folder,
      spaceId: row.para_space_id,
    }));
}

/**
 * Materialize the four reserved PARA buckets of the default space. An existing
 * top-level folder with the default name is adopted; otherwise the folder is
 * created. The `para_bucket` key follows the row through renames and moves.
 *
 * Legacy helper kept for explicit setup paths (tests, tooling). The HTTP/MCP
 * read paths must NOT call this — opt-in setup goes through enablePara (§2.4).
 */
export async function ensureParaBuckets(
  env: Env,
  ownerId: string,
): Promise<{ bucket: ParaBucketKey; id: string; path: string }[]> {
  const out: { bucket: ParaBucketKey; id: string; path: string }[] = [];
  for (const def of PARA_BUCKETS) {
    let row = await bucketRow(env, ownerId, def.key, null);
    if (!row) {
      const existing = await folderWithBucketAtPath(env, ownerId, def.name);
      if (existing && existing.para_bucket === null) {
        await assignBucket(env, def.key, existing.id, null);
        row = { folder: existing.folder, id: existing.id };
      }
    }
    if (!row) {
      const id = await ensureFolderRow(env, ownerId, def.name);
      if (!id) {
        continue;
      }
      await assignBucket(env, def.key, id, null);
      row = { folder: def.name, id };
    }
    out.push({ bucket: def.key, id: row.id, path: row.folder });
  }
  return out;
}

// --- §2.4/§2.5 plan / enable --------------------------------------------------

async function spaceTargetForRow(
  env: Env,
  row: SpaceRow,
): Promise<SpaceTarget | MoveError> {
  if (row.root_folder_id === null) {
    return { kind: "rootless", rootPath: "", row };
  }
  const root = await getFolderById(env, row.root_folder_id);
  if (!root) {
    return {
      error: "スペースのルートフォルダが見つかりません",
      kind: "invalid",
      status: 400,
    };
  }
  return {
    kind: "rooted",
    root: { folder: root.folder, id: root.id },
    rootPath: root.folder,
    row,
  };
}

async function proposedOrExistingSpace(
  env: Env,
  ownerId: string,
  rawName: string,
): Promise<SpaceTarget | MoveError> {
  const name = normalizeFolder(rawName);
  if (!name || name.includes("/")) {
    return {
      error: "スペース名が不正です",
      kind: "invalid",
      status: 400,
    };
  }
  const existing = await spaceByName(env, ownerId, name);
  if (existing) {
    return spaceTargetForRow(env, existing);
  }
  // A new space's proposed root is the top-level folder carrying its name;
  // resolutions.space.adopt may redirect the root to any owned folder.
  return { kind: "proposed", name, rootPath: name };
}

/**
 * Resolve the space selector of plan/enable:
 * - omitted / "default" → the rootless default space
 * - `{ id }` → an existing space row
 * - `{ name }` / bare string → existing space by name (a bare string tries id
 *   first), otherwise a proposed new space rooted at `<name>` top-level
 */
async function resolveSpaceTarget(
  env: Env,
  ownerId: string,
  selector: ParaSpaceSelector | undefined,
): Promise<SpaceTarget | MoveError> {
  if (selector === undefined || selector === null || selector === "default") {
    const row = await rootlessSpaceRow(env, ownerId);
    return { kind: "rootless", rootPath: "", row };
  }
  if (typeof selector === "object" && "id" in selector) {
    const row = await spaceById(env, ownerId, selector.id);
    if (!row) {
      return { kind: "not_found" };
    }
    return spaceTargetForRow(env, row);
  }
  const name = typeof selector === "string" ? selector : selector.name;
  if (typeof selector === "string") {
    const byId = await spaceById(env, ownerId, selector);
    if (byId) {
      return spaceTargetForRow(env, byId);
    }
  }
  return proposedOrExistingSpace(env, ownerId, name);
}

async function spacePlanFor(
  env: Env,
  ownerId: string,
  target: SpaceTarget,
): Promise<ParaSpacePlan> {
  switch (target.kind) {
    case "rootless":
      return target.row
        ? { name: target.row.name, spaceId: target.row.id, status: "exists" }
        : { status: "exists" };
    case "rooted":
      return {
        existing: { id: target.root.id, name: folderName(target.root.folder) },
        name: target.row.name,
        spaceId: target.row.id,
        status: "exists",
      };
    case "proposed": {
      const occupying = await folderWithBucketAtPath(
        env,
        ownerId,
        target.rootPath,
      );
      if (occupying) {
        return {
          existing: {
            id: occupying.id,
            name: folderName(occupying.folder),
          },
          name: target.name,
          status: "collision",
        };
      }
      return { name: target.name, status: "vacant" };
    }
  }
}

/**
 * Side-effect-free setup inspection for one space. Bucket collision checks
 * are scoped to direct children of the space root (drive root for the
 * default space) — two spaces may both hold a "Projects" bucket.
 */
async function paraPlanFor(
  env: Env,
  ownerId: string,
  target: SpaceTarget,
): Promise<ParaPlan> {
  const space = await spacePlanFor(env, ownerId, target);
  const spaceId = bucketSpaceId(target);
  const buckets: ParaPlanBucket[] = [];
  for (const def of PARA_BUCKETS) {
    if (target.kind !== "proposed") {
      const assigned = await bucketRow(env, ownerId, def.key, spaceId);
      if (assigned) {
        buckets.push({
          bucket: def.key,
          existing: { id: assigned.id, name: folderName(assigned.folder) },
          status: "assigned",
        });
        continue;
      }
    }
    const path = target.rootPath ? `${target.rootPath}/${def.name}` : def.name;
    const occupying = await folderWithBucketAtPath(env, ownerId, path);
    if (occupying) {
      buckets.push({
        bucket: def.key,
        existing: { id: occupying.id, name: folderName(occupying.folder) },
        status: "collision",
      });
    } else {
      buckets.push({ bucket: def.key, status: "vacant" });
    }
  }
  return { buckets, space };
}

export type ParaPlanOutcome =
  | { kind: "ok"; plan: ParaPlan }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "not_found" }
  | { kind: "invalid"; error: string; status: number };

export async function paraPlan(
  env: Env,
  user: SessionUser | undefined,
  space?: ParaSpaceSelector,
): Promise<ParaPlanOutcome> {
  if (!user) {
    return { kind: "denied", status: 401 };
  }
  const target = await resolveSpaceTarget(env, user.id, space);
  if (!("rootPath" in target)) {
    return target;
  }
  return { kind: "ok", plan: await paraPlanFor(env, user.id, target) };
}

// --- resolutions ---------------------------------------------------------------

type NormalizedResolution =
  | { action: "create" }
  | { action: "skip" }
  | { action: "adopt"; target: FolderBucketRow }
  | { action: "rename"; newName: string; target: FolderBucketRow };

type TargetedResolution = Extract<
  NormalizedResolution,
  { target: FolderBucketRow }
>;

function invalidResolution(error: string, status = 400): MoveError {
  return { error, kind: "invalid", status };
}

/** Flat overlap check (ADR 0005): the folder must not already carry a PARA role. */
async function paraRoleConflict(
  env: Env,
  target: FolderBucketRow,
): Promise<MoveError | null> {
  if (target.para_bucket !== null) {
    return invalidResolution(
      "このフォルダは既に PARA バケツに割り当て済みです",
      409,
    );
  }
  if (await folderIsSpaceRoot(env, target.id)) {
    return invalidResolution("このフォルダは既に別スペースのルートです", 409);
  }
  return null;
}

/**
 * Validate an adopt/rename target: exists, owned, and carrying no PARA role
 * yet (flat overlap — neither a bucket nor a space root, ADR 0005).
 * Bucket targets must be direct children of the space root; space-root
 * targets may live anywhere in the caller's own drive (nesting allowed).
 */
async function normalizeTargetedResolution(
  env: Env,
  resolution: {
    action: "adopt" | "rename";
    folderId?: string;
    newName?: string;
  },
  user: SessionUser,
  constraint: { kind: "bucket"; parentPath: string } | { kind: "space-root" },
): Promise<TargetedResolution | MoveError> {
  if (
    typeof resolution.folderId !== "string" ||
    resolution.folderId.length === 0
  ) {
    return invalidResolution("folderId が必要です");
  }
  const target = await folderWithBucketById(env, resolution.folderId);
  if (!target) {
    return { kind: "not_found" };
  }
  if (target.owner_id !== user.id) {
    return { kind: "denied", status: 403 };
  }
  if (constraint.kind === "bucket") {
    if (parentFolderPath(target.folder) !== constraint.parentPath) {
      return invalidResolution(
        constraint.parentPath
          ? "バケツにはスペースルート直下のフォルダのみ指定できます"
          : "バケツにはトップレベルフォルダのみ指定できます",
      );
    }
  } else if (!target.folder) {
    return invalidResolution("マイドライブはスペースルートにできません");
  }
  const roleConflict = await paraRoleConflict(env, target);
  if (roleConflict) {
    return roleConflict;
  }
  if (resolution.action === "adopt") {
    return { action: "adopt", target };
  }
  const newName = normalizeFolder(resolution.newName);
  if (!newName || newName.includes("/")) {
    return invalidResolution("フォルダ名が不正です");
  }
  return { action: "rename", newName, target };
}

function invalidAction(): MoveError {
  return invalidResolution(
    "action は create / adopt / rename / skip のいずれかです",
  );
}

/**
 * The `space` resolution of a proposed space. Adopt may point at any owned
 * folder — its actual path becomes the space root the buckets are checked
 * against (a nested space root is legal, ADR 0005).
 */
async function normalizeSpaceResolution(
  env: Env,
  resolution: unknown,
  user: SessionUser,
  seenTargets: Set<string>,
): Promise<NormalizedResolution | MoveError> {
  if (typeof resolution !== "object" || resolution === null) {
    return invalidResolution("resolution が不正です");
  }
  const action = (resolution as { action?: string }).action;
  if (action === "create" || action === "skip") {
    return { action };
  }
  if (action !== "adopt" && action !== "rename") {
    return invalidAction();
  }
  const normalized = await normalizeTargetedResolution(
    env,
    resolution as { action: "adopt" | "rename"; folderId?: string },
    user,
    { kind: "space-root" },
  );
  if ("kind" in normalized) {
    return normalized;
  }
  if (seenTargets.has(normalized.target.id)) {
    return invalidResolution("同じフォルダを複数の役割に割り当てられません");
  }
  seenTargets.add(normalized.target.id);
  return normalized;
}

async function normalizeOneResolution(
  env: Env,
  key: string,
  resolution: unknown,
  user: SessionUser,
  parentPath: string,
  seenTargets: Set<string>,
): Promise<{ key: ParaBucketKey; value: NormalizedResolution } | MoveError> {
  if (!isParaBucketKey(key)) {
    return invalidResolution(`不明なバケツです: ${key}`);
  }
  if (typeof resolution !== "object" || resolution === null) {
    return invalidResolution("resolution が不正です");
  }
  const action = (resolution as { action?: string }).action;
  if (action === "create" || action === "skip") {
    return { key, value: { action } };
  }
  if (action !== "adopt" && action !== "rename") {
    return invalidAction();
  }
  const normalized = await normalizeTargetedResolution(
    env,
    resolution as { action: "adopt" | "rename"; folderId?: string },
    user,
    { kind: "bucket", parentPath },
  );
  if ("kind" in normalized) {
    return normalized;
  }
  if (seenTargets.has(normalized.target.id)) {
    return invalidResolution("同じフォルダを複数のバケツに割り当てられません");
  }
  seenTargets.add(normalized.target.id);
  return { key, value: normalized };
}

/**
 * Validate every requested resolution before touching the database so a bad
 * entry cannot leave the setup half-applied. The space resolution is
 * validated first because adopting a root folder decides the parent path the
 * bucket resolutions are checked against.
 */
async function normalizeResolutions(
  env: Env,
  input: ParaEnableInput | null | undefined,
  user: SessionUser,
  target: SpaceTarget,
): Promise<
  | {
      buckets: Map<ParaBucketKey, NormalizedResolution>;
      space: NormalizedResolution | undefined;
      rootPath: string;
    }
  | MoveError
> {
  const raw = input?.resolutions ?? {};
  const seenTargets = new Set<string>();

  let space: NormalizedResolution | undefined;
  if (raw.space !== undefined) {
    if (target.kind !== "proposed") {
      return invalidResolution(
        "space resolution は新規スペースでのみ指定できます",
      );
    }
    const normalized = await normalizeSpaceResolution(
      env,
      raw.space,
      user,
      seenTargets,
    );
    if ("kind" in normalized) {
      return normalized;
    }
    space = normalized;
  }

  const rootPath =
    space?.action === "adopt" ? space.target.folder : target.rootPath;

  const buckets = new Map<ParaBucketKey, NormalizedResolution>();
  for (const [key, resolution] of Object.entries(raw)) {
    if (key === "space") {
      continue;
    }
    const normalized = await normalizeOneResolution(
      env,
      key,
      resolution,
      user,
      rootPath,
      seenTargets,
    );
    if ("kind" in normalized) {
      return normalized;
    }
    buckets.set(normalized.key, normalized.value);
  }
  return { buckets, rootPath, space };
}

// --- enable ---------------------------------------------------------------------

/**
 * Create the bucket's default folder under the space root and tag it.
 * Returns false when the name is (still) occupied — the caller reports it as
 * a remaining collision rather than silently adopting the folder.
 */
async function createBucketFolder(
  env: Env,
  ownerId: string,
  def: (typeof PARA_BUCKETS)[number],
  rootPath: string,
  spaceId: string | null,
): Promise<boolean> {
  const path = rootPath ? `${rootPath}/${def.name}` : def.name;
  const occupying = await folderWithBucketAtPath(env, ownerId, path);
  if (occupying) {
    return false;
  }
  const id = await ensureFolderRow(env, ownerId, path);
  if (!id) {
    return false;
  }
  const row = await folderWithBucketById(env, id);
  if (!row || row.para_bucket !== null) {
    return false;
  }
  await assignBucket(env, def.key, id, spaceId);
  return true;
}

export type ParaEnableOutcome =
  | { kind: "ok"; result: ParaEnableResult }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "invalid"; error: string; status: number };

type SpaceApplyResult =
  | { kind: "ok"; rootPath: string; spaceRow: SpaceRow }
  | "skipped"
  | "collision"
  | MoveError;

/**
 * Materialize a proposed space: resolve its root folder (create / adopt /
 * rename the colliding one / skip) then insert the para_spaces row.
 * "collision" = the root name is still occupied — the space is aborted and
 * reported pending so the caller can resolve and re-run.
 */
/**
 * Decide the space root folder: adopt the target / rename the colliding one
 * then create / create outright. "collision" = the root name is still
 * occupied after applying the resolution.
 */
async function resolveSpaceRootFolder(
  env: Env,
  notes: ReturnType<typeof createNoteService>,
  user: SessionUser,
  target: Extract<SpaceTarget, { kind: "proposed" }>,
  resolution: NormalizedResolution | undefined,
): Promise<
  { rootFolderId: string; rootPath: string } | "collision" | MoveError
> {
  if (resolution?.action === "adopt") {
    // Re-check: the folder may have gained a PARA role since validation.
    const fresh = await folderWithBucketById(env, resolution.target.id);
    if (
      !fresh ||
      fresh.para_bucket !== null ||
      (await folderIsSpaceRoot(env, fresh.id))
    ) {
      return "collision";
    }
    return { rootFolderId: fresh.id, rootPath: fresh.folder };
  }
  if (resolution?.action === "rename") {
    const renamed = await notes.renameFolder(
      resolution.target.id,
      resolution.newName,
      user,
    );
    if (renamed.kind !== "ok") {
      return renamed;
    }
    // The proposed root name is now free — fall through to create it.
  }
  const occupying = await folderWithBucketAtPath(env, user.id, target.rootPath);
  if (occupying) {
    return "collision";
  }
  const created = await ensureFolderRow(env, user.id, target.rootPath);
  if (!created) {
    return invalidResolution("スペースルートを作成できませんでした", 500);
  }
  return { rootFolderId: created, rootPath: target.rootPath };
}

async function applySpaceSetup(
  env: Env,
  notes: ReturnType<typeof createNoteService>,
  user: SessionUser,
  target: Extract<SpaceTarget, { kind: "proposed" }>,
  resolution: NormalizedResolution | undefined,
): Promise<SpaceApplyResult> {
  if (resolution?.action === "skip") {
    return "skipped";
  }
  const root = await resolveSpaceRootFolder(
    env,
    notes,
    user,
    target,
    resolution,
  );
  if (root === "collision") {
    return "collision";
  }
  if ("kind" in root) {
    return root;
  }
  const spaceRow = await insertSpaceRow(
    env,
    user.id,
    target.name,
    root.rootFolderId,
  );
  if (spaceRow === "conflict") {
    return invalidResolution("同名のスペースが既に存在します", 409);
  }
  return { kind: "ok", rootPath: root.rootPath, spaceRow };
}

/**
 * Apply one bucket's resolution (or the implicit create for a vacant name).
 * "skipped" = the caller asked to leave it unassigned; a MoveError aborts the
 * whole enable so the caller can surface it.
 */
async function applyBucketSetup(
  env: Env,
  notes: ReturnType<typeof createNoteService>,
  user: SessionUser,
  def: (typeof PARA_BUCKETS)[number],
  resolution: NormalizedResolution | undefined,
  rootPath: string,
  spaceId: string | null,
): Promise<"ok" | "skipped" | MoveError> {
  if (resolution?.action === "skip") {
    return "skipped";
  }
  if (resolution?.action === "adopt") {
    // Re-check: the folder may have been assigned since validation.
    const fresh = await folderWithBucketById(env, resolution.target.id);
    if (
      fresh &&
      fresh.para_bucket === null &&
      !(await folderIsSpaceRoot(env, fresh.id))
    ) {
      await assignBucket(env, def.key, fresh.id, spaceId);
    }
    return "ok";
  }
  if (resolution?.action === "rename") {
    const renamed = await notes.renameFolder(
      resolution.target.id,
      resolution.newName,
      user,
    );
    if (renamed.kind !== "ok") {
      return renamed;
    }
    // The default name is now free — fall through to create the bucket.
  }
  // create (explicit, post-rename, or the default action for a vacant name)
  await createBucketFolder(env, user.id, def, rootPath, spaceId);
  return "ok";
}

/**
 * §2.4/§2.5 enable: apply resolutions for one space. Idempotent — already
 * assigned buckets are no-ops and skip is not persisted. A proposed space
 * whose root stays in collision (or is skipped) aborts that space only; the
 * root and any unresolved buckets come back in `pending` so the caller can
 * collect resolutions and re-run.
 */
/**
 * Step 2 of enable: apply every bucket resolution under the space root.
 * Returns the set of keys the caller asked to skip, or a MoveError.
 */
async function applyAllBuckets(
  env: Env,
  notes: ReturnType<typeof createNoteService>,
  user: SessionUser,
  rootPath: string,
  spaceId: string | null,
  buckets: Map<ParaBucketKey, NormalizedResolution>,
): Promise<Set<ParaResolutionKey> | MoveError> {
  const skipped = new Set<ParaResolutionKey>();
  for (const def of PARA_BUCKETS) {
    if (await bucketRow(env, user.id, def.key, spaceId)) {
      continue; // already assigned: no-op
    }
    const applied = await applyBucketSetup(
      env,
      notes,
      user,
      def,
      buckets.get(def.key),
      rootPath,
      spaceId,
    );
    if (applied === "skipped") {
      skipped.add(def.key);
      continue;
    }
    if (applied !== "ok") {
      return applied;
    }
  }
  return skipped;
}

/**
 * Step 1 of enable for an already-existing space: the effective root path
 * and space id. A rowless default space is materialized so it can be
 * listed/unassigned.
 */
async function existingSpaceContext(
  env: Env,
  user: SessionUser,
  target: SpaceTarget,
): Promise<{ rootPath: string; spaceId: string | null } | MoveError> {
  if (target.kind === "rootless" && target.row === null) {
    const row = await ensureRootlessSpace(env, user.id);
    if (!("id" in row)) {
      return row;
    }
  }
  return { rootPath: target.rootPath, spaceId: bucketSpaceId(target) };
}

export async function enablePara(
  env: Env,
  input: ParaEnableInput | null | undefined,
  user: SessionUser | undefined,
): Promise<ParaEnableOutcome> {
  if (!user) {
    return { kind: "denied", status: 401 };
  }
  const target = await resolveSpaceTarget(env, user.id, input?.space);
  if (!("rootPath" in target)) {
    return target;
  }

  const normalized = await normalizeResolutions(env, input, user, target);
  if ("kind" in normalized) {
    return normalized;
  }

  const notes = createNoteService(env);

  // 1. Resolve the space itself.
  let spaceId: string | null;
  let rootPath: string;
  if (target.kind === "proposed") {
    const applied = await applySpaceSetup(
      env,
      notes,
      user,
      target,
      normalized.space,
    );
    if (applied === "skipped" || applied === "collision") {
      return finishEnable(
        env,
        user.id,
        input?.space,
        target,
        applied,
        new Set(),
      );
    }
    if (applied.kind !== "ok") {
      return applied;
    }
    spaceId = applied.spaceRow.id;
    rootPath = applied.rootPath;
  } else {
    const context = await existingSpaceContext(env, user, target);
    if ("kind" in context) {
      return context;
    }
    rootPath = context.rootPath;
    spaceId = context.spaceId;
  }

  // 2. Buckets under the (effective) space root.
  const skipped = await applyAllBuckets(
    env,
    notes,
    user,
    rootPath,
    spaceId,
    normalized.buckets,
  );
  if (!(skipped instanceof Set)) {
    return skipped;
  }

  return finishEnable(env, user.id, input?.space, target, "ok", skipped);
}

async function finishEnable(
  env: Env,
  ownerId: string,
  selector: ParaSpaceSelector | undefined,
  target: SpaceTarget,
  spaceOutcome: "ok" | "skipped" | "collision",
  skipped: Set<ParaResolutionKey>,
): Promise<ParaEnableOutcome> {
  // Re-resolve so a just-created space plans as rooted.
  const retarget = await resolveSpaceTarget(env, ownerId, selector);
  const plan = await paraPlanFor(
    env,
    ownerId,
    "rootPath" in retarget ? retarget : target,
  );
  const pending: ParaResolutionKey[] = [];
  if (spaceOutcome === "collision") {
    pending.push("space");
  }
  if (spaceOutcome === "ok") {
    for (const bucket of plan.buckets) {
      if (bucket.status !== "assigned" && !skipped.has(bucket.bucket)) {
        pending.push(bucket.bucket);
      }
    }
  }
  return { kind: "ok", result: { pending, plan } };
}

// --- read paths ---------------------------------------------------------------

async function countNotesInSubtree(
  env: Env,
  ownerId: string,
  path: string,
): Promise<number> {
  const row = await db(env)
    .prepare(
      `SELECT COUNT(*) AS c FROM notes
       WHERE owner_id = ? AND (folder = ? OR folder LIKE ? ESCAPE '\\')`,
    )
    .bind(ownerId, path, `${escapeLikePattern(path)}/%`)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export type ParaListOutcome =
  | { kind: "ok"; result: ParaListResult }
  | { kind: "denied"; status: 401 }
  | { kind: "invalid"; error: string; status: number };

function findListedSpace(
  spaces: ParaSpaceSummary[],
  selector: ParaSpaceSelector | undefined,
): ParaSpaceSummary | null {
  if (selector === undefined || selector === null || selector === "default") {
    return spaces.find((space) => space.isDefault) ?? null;
  }
  const needle = typeof selector === "string" ? selector : null;
  const id =
    typeof selector === "object" && "id" in selector ? selector.id : needle;
  const name =
    typeof selector === "object" && "name" in selector ? selector.name : needle;
  return (
    spaces.find(
      (space) => (id && space.id === id) || (name && space.name === name),
    ) ?? null
  );
}

/**
 * List the caller's PARA spaces with their buckets. With `bucket`, also
 * returns the direct children of that bucket — inside `space` when given,
 * the default space otherwise (backward compatible).
 * Read-only per §2.4: an unset-up drive returns `{ spaces: [], buckets: [] }`.
 */
/** Assigned buckets of one space, in canonical PARA order, with note counts. */
async function paraBucketSummaries(
  env: Env,
  ownerId: string,
  rows: AssignedBucketRow[],
): Promise<ParaBucket[]> {
  const buckets: ParaBucket[] = [];
  for (const def of PARA_BUCKETS) {
    const assigned = rows.find((entry) => entry.bucket === def.key);
    if (assigned) {
      buckets.push({
        folderId: assigned.id,
        key: def.key,
        name: folderName(assigned.path),
        noteCount: await countNotesInSubtree(env, ownerId, assigned.path),
        path: assigned.path,
      });
    }
  }
  return buckets;
}

/**
 * Materialize every space row into a summary. `bySpace` is consumed; rows
 * left under the null key (a DB pre-dating the 0016 backfill) still list
 * under a synthesized default space.
 */
async function listSpaceSummaries(
  env: Env,
  ownerId: string,
  spaceRows: SpaceRow[],
  bySpace: Map<string | null, AssignedBucketRow[]>,
): Promise<ParaSpaceSummary[]> {
  const spaces: ParaSpaceSummary[] = [];
  for (const row of spaceRows) {
    const isDefault = row.root_folder_id === null;
    const root =
      row.root_folder_id === null
        ? null
        : await getFolderById(env, row.root_folder_id);
    const buckets = await paraBucketSummaries(
      env,
      ownerId,
      bySpace.get(isDefault ? null : row.id) ?? [],
    );
    spaces.push({
      buckets,
      id: row.id,
      isDefault,
      name: row.name,
      rootFolderId: row.root_folder_id,
      rootPath: isDefault ? "" : (root?.folder ?? ""),
    });
    bySpace.delete(isDefault ? null : row.id);
  }
  const orphanDefault = bySpace.get(null);
  if (orphanDefault?.length) {
    spaces.unshift({
      buckets: await paraBucketSummaries(env, ownerId, orphanDefault),
      id: "default",
      isDefault: true,
      name: DEFAULT_PARA_SPACE_NAME,
      rootFolderId: null,
      rootPath: "",
    });
  }
  spaces.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return spaces;
}

function groupBucketsBySpace(
  rows: AssignedBucketRow[],
): Map<string | null, AssignedBucketRow[]> {
  const bySpace = new Map<string | null, AssignedBucketRow[]>();
  for (const row of rows) {
    const list = bySpace.get(row.spaceId) ?? [];
    list.push(row);
    bySpace.set(row.spaceId, list);
  }
  return bySpace;
}

export async function paraList(
  env: Env,
  user: SessionUser | undefined,
  bucket?: string,
  spaceSelector?: ParaSpaceSelector,
): Promise<ParaListOutcome> {
  if (!user) {
    return { kind: "denied", status: 401 };
  }
  if (bucket !== undefined && !isParaBucketKey(bucket)) {
    return {
      error: "bucket は projects/areas/resources/archives のいずれかです",
      kind: "invalid",
      status: 400,
    };
  }

  const [spaceRows, bucketRows] = await Promise.all([
    listSpaceRows(env, user.id),
    allAssignedBucketRows(env, user.id),
  ]);
  const spaces = await listSpaceSummaries(
    env,
    user.id,
    spaceRows,
    groupBucketsBySpace(bucketRows),
  );
  const defaultSpace = spaces.find((space) => space.isDefault);
  const result: ParaListResult = {
    buckets: defaultSpace?.buckets ?? [],
    spaces,
  };

  const scoped =
    spaceSelector === undefined || spaceSelector === null
      ? defaultSpace
      : findListedSpace(spaces, spaceSelector);
  if (spaceSelector !== undefined && spaceSelector !== null) {
    if (!scoped) {
      return {
        error: "スペースが見つかりません",
        kind: "invalid",
        status: 400,
      };
    }
    result.spaces = [scoped];
    result.buckets = scoped.buckets;
  }
  if (bucket && scoped) {
    const target = scoped.buckets.find((entry) => entry.key === bucket);
    if (target) {
      result.children = await listFolderChildren(
        env,
        user.id,
        target.path,
        target.folderId,
        user,
      );
    }
  }
  return { kind: "ok", result };
}

export type ParaSpaceMutationOutcome =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "invalid"; error: string; status: number };

/**
 * §2.5 space delete = unassign only: bucket tags and the space row are
 * removed; the folders themselves stay (same spirit as feature OFF).
 */
export async function paraDeleteSpace(
  env: Env,
  spaceId: string,
  user: SessionUser | undefined,
): Promise<ParaSpaceMutationOutcome> {
  if (!user) {
    return { kind: "denied", status: 401 };
  }
  const row = await spaceById(env, user.id, spaceId);
  if (!row) {
    return { kind: "not_found" };
  }
  if (row.root_folder_id === null) {
    await db(env)
      .prepare(
        "UPDATE folders SET para_bucket = NULL, para_space_id = NULL WHERE owner_id = ? AND para_space_id IS NULL AND para_bucket IS NOT NULL",
      )
      .bind(user.id)
      .run();
  } else {
    await db(env)
      .prepare(
        "UPDATE folders SET para_bucket = NULL, para_space_id = NULL WHERE owner_id = ? AND para_space_id = ?",
      )
      .bind(user.id, row.id)
      .run();
  }
  await db(env)
    .prepare("DELETE FROM para_spaces WHERE id = ? AND owner_id = ?")
    .bind(row.id, user.id)
    .run();
  return { kind: "ok" };
}

/** Rename a space. The name is unique per owner (DSL/plan name resolution). */
export async function paraRenameSpace(
  env: Env,
  spaceId: string,
  name: string,
  user: SessionUser | undefined,
): Promise<ParaSpaceMutationOutcome> {
  if (!user) {
    return { kind: "denied", status: 401 };
  }
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized || normalized.includes("/") || normalized.includes(":")) {
    return invalidResolution("スペース名が不正です");
  }
  const row = await spaceById(env, user.id, spaceId);
  if (!row) {
    return { kind: "not_found" };
  }
  try {
    await db(env)
      .prepare("UPDATE para_spaces SET name = ? WHERE id = ? AND owner_id = ?")
      .bind(normalized, row.id, user.id)
      .run();
  } catch {
    return invalidResolution("同名のスペースが既に存在します", 409);
  }
  return { kind: "ok" };
}

export type ParaArchiveInput = {
  /** Prefix the archived folder name with the current `YYYY-MM-`. */
  dated?: boolean;
  /** Override the archived folder name. */
  name?: string;
  dryRun?: boolean;
};

export async function paraArchiveProject(
  env: Env,
  folderId: string,
  input: ParaArchiveInput,
  user: SessionUser | undefined,
): Promise<MoveError | { kind: "ok"; result: MoveFolderResult }> {
  const rec = await getFolderById(env, folderId);
  if (!rec) {
    return { kind: "not_found" };
  }
  if (!user || user.id !== rec.owner_id) {
    return { kind: "denied", status: user === undefined ? 401 : 403 };
  }
  if (!rec.folder) {
    return {
      error: "マイドライブはアーカイブできません",
      kind: "invalid",
      status: 400,
    };
  }
  const buckets = await allAssignedBucketRows(env, rec.owner_id);
  // The space owning the deepest Projects subtree containing the folder wins
  // (nested spaces: the inner assignment wins, ADR 0005).
  const projects = buckets
    .filter(
      (row) =>
        row.bucket === "projects" &&
        rec.folder !== row.path &&
        folderContains(row.path, rec.folder),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!projects) {
    return {
      error: "Projects 配下のフォルダのみアーカイブできます",
      kind: "invalid",
      status: 400,
    };
  }
  const archives = buckets.find(
    (row) => row.bucket === "archives" && row.spaceId === projects.spaceId,
  );
  if (!archives) {
    return {
      error: "このスペースには Archives バケツがありません",
      kind: "invalid",
      status: 400,
    };
  }
  let name = input.name?.trim() || folderName(rec.folder);
  if (name.includes("/")) {
    return { error: "フォルダ名が不正です", kind: "invalid", status: 400 };
  }
  if (input.dated) {
    const stamp = new Date().toISOString().slice(0, 7);
    name = `${stamp}-${name}`;
  }
  if (archives.path && folderContains(archives.path, rec.folder)) {
    return {
      error: "このフォルダは既に Archives 配下です",
      kind: "invalid",
      status: 400,
    };
  }
  return moveFolder(
    env,
    folderId,
    {
      destFolderId: archives.id,
      dryRun: input.dryRun,
      name,
    },
    user,
  );
}
