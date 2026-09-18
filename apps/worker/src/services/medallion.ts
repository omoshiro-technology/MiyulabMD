import {
  DEFAULT_MEDALLION_LAYERS,
  DEFAULT_MEDALLION_SET_NAME,
  isMedallionLayerKey,
  type MedallionAssignment,
  type MedallionLayer,
  type MedallionResolution,
  type MedallionSet,
  normalizeFolder,
  parseMedallionLayers,
  resolveMedallionAssignment,
  type SessionUser,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";

// --- rows ---------------------------------------------------------------------

type SetRow = {
  id: string;
  owner_user_id: string;
  name: string;
  layers: string;
  created_at: number;
};

type FolderRow = {
  id: string;
  owner_id: string;
  folder: string;
  medallion_set_id: string | null;
  medallion_layer: string | null;
};

export type MedallionResult<T> =
  | { kind: "ok"; result: T }
  | { kind: "denied" }
  | { kind: "not_found" }
  | { kind: "invalid"; message?: string }
  | { kind: "confirm_required"; assignedFolders: number };

function setFromRow(row: SetRow): MedallionSet {
  return {
    createdAt: row.created_at,
    id: row.id,
    layers: parseMedallionLayers(row.layers),
    name: row.name,
  };
}

async function setById(env: Env, id: string): Promise<SetRow | null> {
  return await db(env)
    .prepare(
      "SELECT id, owner_user_id, name, layers, created_at FROM medallion_sets WHERE id = ?",
    )
    .bind(id)
    .first<SetRow>();
}

async function folderById(env: Env, id: string): Promise<FolderRow | null> {
  return await db(env)
    .prepare(
      "SELECT id, owner_id, folder, medallion_set_id, medallion_layer FROM folders WHERE id = ?",
    )
    .bind(id)
    .first<FolderRow>();
}

function validateLayers(
  layers: MedallionLayer[] | undefined,
): MedallionLayer[] | null {
  if (layers === undefined) {
    return DEFAULT_MEDALLION_LAYERS;
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  for (const layer of layers) {
    if (
      typeof layer?.key !== "string" ||
      typeof layer?.label !== "string" ||
      !isMedallionLayerKey(layer.key) ||
      seen.has(layer.key)
    ) {
      return null;
    }
    seen.add(layer.key);
  }
  return layers.map((layer) => ({ key: layer.key, label: layer.label }));
}

// --- queries -------------------------------------------------------------------

export async function listMedallionSets(
  env: Env,
  user: SessionUser,
): Promise<MedallionSet[]> {
  const { results } = await db(env)
    .prepare(
      "SELECT id, owner_user_id, name, layers, created_at FROM medallion_sets WHERE owner_user_id = ? ORDER BY created_at, id",
    )
    .bind(user.id)
    .all<SetRow>();
  return results.map(setFromRow);
}

export async function findMedallionSet(
  env: Env,
  user: SessionUser,
  id: string,
): Promise<MedallionSet | null> {
  const row = await setById(env, id);
  if (!row || row.owner_user_id !== user.id) {
    return null;
  }
  return setFromRow(row);
}

/** Seed the built-in 精緻度 set the first time the feature is used. */
export async function ensureDefaultMedallionSet(
  env: Env,
  user: SessionUser,
): Promise<MedallionSet> {
  const existing = await db(env)
    .prepare(
      "SELECT id, owner_user_id, name, layers, created_at FROM medallion_sets WHERE owner_user_id = ? AND name = ? ORDER BY created_at, id",
    )
    .bind(user.id, DEFAULT_MEDALLION_SET_NAME)
    .first<SetRow>();
  if (existing) {
    return setFromRow(existing);
  }
  const created = await createMedallionSet(env, user, {
    layers: DEFAULT_MEDALLION_LAYERS,
    name: DEFAULT_MEDALLION_SET_NAME,
  });
  if (created.kind !== "ok") {
    // Lost a race with a concurrent seed — re-read.
    const row = await db(env)
      .prepare(
        "SELECT id, owner_user_id, name, layers, created_at FROM medallion_sets WHERE owner_user_id = ? AND name = ?",
      )
      .bind(user.id, DEFAULT_MEDALLION_SET_NAME)
      .first<SetRow>();
    if (row) {
      return setFromRow(row);
    }
    throw new Error("failed to seed default medallion set");
  }
  return created.result;
}

// --- mutations ------------------------------------------------------------------

export async function createMedallionSet(
  env: Env,
  user: SessionUser,
  input: { name?: string; layers?: MedallionLayer[] },
): Promise<MedallionResult<MedallionSet>> {
  const name = input.name?.trim();
  if (!name) {
    return { kind: "invalid", message: "name required" };
  }
  const layers = validateLayers(input.layers);
  if (!layers) {
    return { kind: "invalid", message: "invalid layers" };
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await db(env)
    .prepare(
      "INSERT INTO medallion_sets (id, owner_user_id, name, layers, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, user.id, name, JSON.stringify(layers), now)
    .run();
  return { kind: "ok", result: { createdAt: now, id, layers, name } };
}

export async function updateMedallionSet(
  env: Env,
  user: SessionUser,
  setId: string,
  input: { name?: string; layers?: MedallionLayer[] },
): Promise<MedallionResult<MedallionSet>> {
  const row = await setById(env, setId);
  if (!row) {
    return { kind: "not_found" };
  }
  if (row.owner_user_id !== user.id) {
    return { kind: "denied" };
  }
  const current = setFromRow(row);

  let layers = current.layers;
  if (input.layers !== undefined) {
    const validated = validateLayers(input.layers);
    if (!validated) {
      return { kind: "invalid", message: "invalid layers" };
    }
    // Keys are immutable: the same key set must be present after the edit.
    const currentKeys = new Set(current.layers.map((layer) => layer.key));
    const nextKeys = new Set(validated.map((layer) => layer.key));
    if (
      currentKeys.size !== nextKeys.size ||
      [...currentKeys].some((key) => !nextKeys.has(key))
    ) {
      return {
        kind: "invalid",
        message: "layer keys cannot be added or removed",
      };
    }
    layers = validated;
  }

  const name = input.name === undefined ? current.name : input.name.trim();
  if (!name) {
    return { kind: "invalid", message: "name required" };
  }

  await db(env)
    .prepare("UPDATE medallion_sets SET name = ?, layers = ? WHERE id = ?")
    .bind(name, JSON.stringify(layers), setId)
    .run();
  return {
    kind: "ok",
    result: { createdAt: current.createdAt, id: setId, layers, name },
  };
}

export async function deleteMedallionSet(
  env: Env,
  user: SessionUser,
  setId: string,
  confirm: boolean,
): Promise<MedallionResult<null>> {
  const row = await setById(env, setId);
  if (!row) {
    return { kind: "not_found" };
  }
  if (row.owner_user_id !== user.id) {
    return { kind: "denied" };
  }
  const assigned = await db(env)
    .prepare("SELECT COUNT(*) AS c FROM folders WHERE medallion_set_id = ?")
    .bind(setId)
    .first<{ c: number }>();
  const count = assigned?.c ?? 0;
  if (count > 0 && !confirm) {
    return { assignedFolders: count, kind: "confirm_required" };
  }
  // Unassign folders first; the FK is ON DELETE SET NULL but doing it
  // explicitly keeps medallion_layer cleared too.
  await db(env)
    .prepare(
      "UPDATE folders SET medallion_set_id = NULL, medallion_layer = NULL WHERE medallion_set_id = ?",
    )
    .bind(setId)
    .run();
  await db(env)
    .prepare("DELETE FROM medallion_sets WHERE id = ?")
    .bind(setId)
    .run();
  return { kind: "ok", result: null };
}

// --- folder assignment ------------------------------------------------------------

export async function assignFolderMedallion(
  env: Env,
  user: SessionUser,
  folderId: string,
  setId: string,
  layerKey: string,
): Promise<MedallionResult<MedallionAssignment>> {
  const folder = await folderById(env, folderId);
  if (!folder) {
    return { kind: "not_found" };
  }
  if (folder.owner_id !== user.id) {
    return { kind: "denied" };
  }
  const setRow = await setById(env, setId);
  if (!setRow) {
    return { kind: "not_found" };
  }
  if (setRow.owner_user_id !== user.id) {
    return { kind: "denied" };
  }
  const set = setFromRow(setRow);
  const layer = set.layers.find((entry) => entry.key === layerKey);
  if (!layer) {
    return { kind: "invalid", message: "unknown layer key" };
  }
  await db(env)
    .prepare(
      "UPDATE folders SET medallion_set_id = ?, medallion_layer = ? WHERE id = ?",
    )
    .bind(setId, layerKey, folderId)
    .run();
  return {
    kind: "ok",
    result: {
      folderId,
      layerKey,
      layerLabel: layer.label,
      path: folder.folder,
      setId,
      setName: set.name,
    },
  };
}

export async function clearFolderMedallion(
  env: Env,
  user: SessionUser,
  folderId: string,
): Promise<MedallionResult<null>> {
  const folder = await folderById(env, folderId);
  if (!folder) {
    return { kind: "not_found" };
  }
  if (folder.owner_id !== user.id) {
    return { kind: "denied" };
  }
  await db(env)
    .prepare(
      "UPDATE folders SET medallion_set_id = NULL, medallion_layer = NULL WHERE id = ?",
    )
    .bind(folderId)
    .run();
  return { kind: "ok", result: null };
}

export async function listMedallionAssignments(
  env: Env,
  user: SessionUser,
): Promise<MedallionAssignment[]> {
  const { results } = await db(env)
    .prepare(
      `SELECT f.id AS folder_id, f.folder AS path, f.medallion_layer AS layer_key,
              s.id AS set_id, s.name AS set_name, s.layers AS layers
         FROM folders f JOIN medallion_sets s ON s.id = f.medallion_set_id
        WHERE f.owner_id = ? AND f.medallion_set_id IS NOT NULL
        ORDER BY f.folder`,
    )
    .bind(user.id)
    .all<{
      folder_id: string;
      path: string;
      layer_key: string | null;
      set_id: string;
      set_name: string;
      layers: string;
    }>();
  return results.map((row) => {
    const layers = parseMedallionLayers(row.layers);
    const layer = layers.find((entry) => entry.key === row.layer_key);
    return {
      folderId: row.folder_id,
      layerKey: row.layer_key ?? "",
      layerLabel: layer?.label ?? row.layer_key ?? "",
      path: row.path,
      setId: row.set_id,
      setName: row.set_name,
    };
  });
}

/**
 * Effective medallion for a folder path: the nearest ancestor (or the folder
 * itself) that carries an assignment. `path` may also be a note's folder.
 */
export async function resolveMedallion(
  env: Env,
  user: SessionUser,
  path: string,
): Promise<MedallionResolution | null> {
  const normalized = normalizeFolder(path);
  if (!normalized) {
    return null;
  }
  const assignments = await listMedallionAssignments(env, user);
  const best = resolveMedallionAssignment(assignments, normalized);
  if (!best) {
    return null;
  }
  const set = await findMedallionSet(env, user, best.setId);
  const layerIndex =
    set?.layers.findIndex((layer) => layer.key === best.layerKey) ?? -1;
  return {
    assignedPath: best.path,
    layerIndex,
    layerKey: best.layerKey,
    layerLabel: best.layerLabel,
    setId: best.setId,
    setName: best.setName,
  };
}
