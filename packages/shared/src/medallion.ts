/**
 * §2.6 medallion layers: user-defined layer *sets* assigned to folders.
 * Layers are display labels only — editability lives in the independent
 * per-note `edit_locked` flag (see note.ts). A folder carries at most one
 * assignment (`medallion_set_id` + `medallion_layer` key); descendants
 * inherit the nearest ancestor's assignment.
 */

/** One layer entry inside a set. `key` is immutable; `label` is display-only. */
export type MedallionLayer = {
  key: string;
  label: string;
};

export type MedallionSet = {
  id: string;
  name: string;
  /** Ordered layers; order is user-editable and defines badge ranking. */
  layers: MedallionLayer[];
  createdAt: number;
};

/** A folder's stored assignment (folder row + joined set name). */
export type MedallionAssignment = {
  folderId: string;
  /** Folder path (e.g. "knowledge/メモ"). "" never carries an assignment. */
  path: string;
  setId: string;
  setName: string;
  layerKey: string;
  layerLabel: string;
};

/** Effective (nearest-ancestor-resolved) medallion for a folder path. */
export type MedallionResolution = {
  /** Path of the folder that actually carries the assignment. */
  assignedPath: string;
  setId: string;
  setName: string;
  layerKey: string;
  layerLabel: string;
  /** Index of the layer inside its set (drives the medal glyph). */
  layerIndex: number;
};

/** Built-in set seeded when the layers feature is first used. */
export const DEFAULT_MEDALLION_SET_NAME = "精緻度";
export const DEFAULT_MEDALLION_LAYERS: MedallionLayer[] = [
  { key: "raw", label: "raw" },
  { key: "knowledge", label: "knowledge" },
  { key: "output", label: "output" },
];

/** Medal glyph for a layer position inside its set (§3.1 badge). */
const MEDAL_BY_INDEX = ["🥉", "🥈", "🥇"] as const;
export function medalForLayerIndex(index: number): string {
  return MEDAL_BY_INDEX[index] ?? "🏅";
}

export function medalForLayerKey(
  layers: MedallionLayer[],
  key: string,
): string {
  return medalForLayerIndex(layers.findIndex((layer) => layer.key === key));
}

/** Layer keys are path-safe identifiers (used in `layer:<set>.<key>` DSL). */
const LAYER_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
export function isMedallionLayerKey(value: string): boolean {
  return LAYER_KEY_RE.test(value);
}

export function parseMedallionLayers(
  json: string | null | undefined,
): MedallionLayer[] {
  if (!json) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is MedallionLayer =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as MedallionLayer).key === "string" &&
        typeof (entry as MedallionLayer).label === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Nearest-ancestor resolution: pick the assignment whose path is the longest
 * prefix of `folderPath` (exact match counts). Returns null when no ancestor
 * (or the folder itself) is assigned.
 */
export function resolveMedallionAssignment<T extends { path: string }>(
  assignments: readonly T[],
  folderPath: string,
): T | null {
  let best: T | null = null;
  for (const assignment of assignments) {
    const path = assignment.path;
    if (!(folderPath === path || folderPath.startsWith(`${path}/`))) {
      continue;
    }
    if (best === null || path.length > best.path.length) {
      best = assignment;
    }
  }
  return best;
}
