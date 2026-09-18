import {
  type LayerFilterValue,
  layerFilterValue,
  paraFilterValue,
  pathFilterMatches,
  resolveMedallionAssignment,
  type SearchQuery,
  schemeFilterValue,
  tagFilterValue,
} from "@miyulabmd/shared";
import { db } from "../db/client.ts";

/**
 * Worker-side resolution of parsed DSL operators into row-matchable filters.
 * `scheme:`/`jd:`/`para:` resolve to folder-path prefixes under the caller's
 * own drive (a user's scheme metadata is private — non-owner lookups fail
 * closed to "no match"). `layer:` resolves against the caller's folder
 * medallion assignments (nearest ancestor wins).
 */

export type LayerFilter = { value: LayerFilterValue; negated: boolean };
/** One folder assignment row used for effective-layer resolution. */
export type MedallionSearchAssignment = {
  path: string;
  layerKey: string;
  setName: string;
};
export type TagFilter = { value: string; negated: boolean };
export type FolderPrefixFilter = { value: string; negated: boolean };
/**
 * OR-ed set of folder prefixes (e.g. `para:projects` across every space).
 * Positive filters need one matching prefix; negated ones need none to match.
 */
export type FolderPrefixSetFilter = { values: string[]; negated: boolean };

export type ResolvedSearchDsl = {
  parsed: SearchQuery;
  folderPrefixes: FolderPrefixFilter[];
  folderPrefixSets: FolderPrefixSetFilter[];
  layers: LayerFilter[];
  tags: TagFilter[];
  /**
   * The caller's folder medallion assignments, fetched once when any
   * `layer:` filter is present. Empty for guests and unconfigured users.
   */
  medallionAssignments: MedallionSearchAssignment[];
  /** A non-negated filter resolved to nothing — the result set is empty. */
  empty: boolean;
};

/** scheme_id は採番スコープ（ディレクトリ）単位で一意なので複数ヒットし得る。 */
async function folderPathsForSchemeId(
  env: Env,
  ownerId: string,
  schemeId: string,
): Promise<string[]> {
  const rows = await db(env)
    .prepare(
      "SELECT folder FROM folders WHERE owner_id = ? AND scheme_id = ? ORDER BY folder",
    )
    .bind(ownerId, schemeId)
    .all<{ folder: string }>();
  return (rows.results ?? []).map((row) => row.folder);
}

/**
 * `para:projects` → every space's Projects path; `para:work.projects` → the
 * bucket inside that space only. The default space resolves via its materialized
 * rootless row (`para_space_id IS NULL` on its bucket folders).
 */
async function folderPathsForParaBucket(
  env: Env,
  ownerId: string,
  bucket: string,
  spaceName?: string,
): Promise<string[]> {
  if (spaceName === undefined) {
    const rows = await db(env)
      .prepare(
        "SELECT folder FROM folders WHERE owner_id = ? AND para_bucket = ?",
      )
      .bind(ownerId, bucket)
      .all<{ folder: string }>();
    return (rows.results ?? []).map((row) => row.folder);
  }
  const space = await db(env)
    .prepare(
      "SELECT id, root_folder_id FROM para_spaces WHERE owner_id = ? AND name = ?",
    )
    .bind(ownerId, spaceName)
    .first<{ id: string; root_folder_id: string | null }>();
  if (!space) {
    return [];
  }
  const rows =
    space.root_folder_id === null
      ? await db(env)
          .prepare(
            "SELECT folder FROM folders WHERE owner_id = ? AND para_bucket = ? AND para_space_id IS NULL",
          )
          .bind(ownerId, bucket)
          .all<{ folder: string }>()
      : await db(env)
          .prepare(
            "SELECT folder FROM folders WHERE owner_id = ? AND para_bucket = ? AND para_space_id = ?",
          )
          .bind(ownerId, bucket, space.id)
          .all<{ folder: string }>();
  return (rows.results ?? []).map((row) => row.folder);
}

type ResolvedFilter =
  | { kind: "folder"; value: string }
  | { kind: "folder-set"; values: string[] }
  | { kind: "layer"; value: LayerFilterValue }
  | { kind: "tag"; value: string }
  | "drop"
  | "empty";

/** scheme:/jd: resolve to a folder path; para: to a per-space path set. */
async function folderPathForFilter(
  env: Env,
  user: { id: string } | undefined,
  filter: { kind: string; value: string },
): Promise<ResolvedFilter | null> {
  if (!user) {
    return null;
  }
  if (filter.kind === "para") {
    const parsed = paraFilterValue(filter.value);
    if (!parsed) {
      return null;
    }
    const paths = await folderPathsForParaBucket(
      env,
      user.id,
      parsed.bucket,
      parsed.space,
    );
    return paths.length > 0 ? { kind: "folder-set", values: paths } : null;
  }
  const schemeId = schemeFilterValue(filter.value);
  const paths = schemeId
    ? await folderPathsForSchemeId(env, user.id, schemeId)
    : [];
  return paths.length > 0 ? { kind: "folder-set", values: paths } : null;
}

/**
 * Resolve one DSL filter. `"drop"` means the filter cannot apply (negated or
 * unknown); `"empty"` means a non-negated filter resolved to nothing, making
 * the whole result set empty.
 */
async function resolveFilter(
  env: Env,
  user: { id: string } | undefined,
  filter: { kind: string; value: string; negated: boolean },
): Promise<ResolvedFilter> {
  const miss = filter.negated ? "drop" : ("empty" as const);
  switch (filter.kind) {
    case "path":
      return { kind: "folder", value: filter.value };
    case "tag":
      return {
        kind: "tag",
        value: tagFilterValue(filter.value).toLowerCase(),
      };
    case "layer": {
      const layer = layerFilterValue(filter.value);
      return layer ? { kind: "layer", value: layer } : miss;
    }
    case "scheme":
    case "jd":
    case "para": {
      const resolved = await folderPathForFilter(env, user, filter);
      return resolved === null ? miss : resolved;
    }
    default:
      return "drop";
  }
}

export async function loadMedallionAssignments(
  env: Env,
  userId: string,
): Promise<MedallionSearchAssignment[]> {
  const { results } = await db(env)
    .prepare(
      `SELECT f.folder AS path, f.medallion_layer AS layer_key,
              s.name AS set_name
         FROM folders f JOIN medallion_sets s ON s.id = f.medallion_set_id
        WHERE f.owner_id = ? AND f.medallion_set_id IS NOT NULL`,
    )
    .bind(userId)
    .all<{ path: string; layer_key: string | null; set_name: string }>();
  return (results ?? []).map((row) => ({
    layerKey: row.layer_key ?? "",
    path: row.path,
    setName: row.set_name,
  }));
}

type CollectedFilters = {
  empty: boolean;
  folderPrefixes: FolderPrefixFilter[];
  folderPrefixSets: FolderPrefixSetFilter[];
  layers: LayerFilter[];
  tags: TagFilter[];
};

/** Resolves each parsed DSL filter into its row-matchable bucket. */
async function collectFilters(
  env: Env,
  user: { id: string } | undefined,
  parsed: SearchQuery,
): Promise<CollectedFilters> {
  const collected: CollectedFilters = {
    empty: false,
    folderPrefixes: [],
    folderPrefixSets: [],
    layers: [],
    tags: [],
  };
  for (const filter of parsed.filters) {
    const resolved = await resolveFilter(env, user, filter);
    if (resolved === "empty") {
      collected.empty = true;
      continue;
    }
    if (resolved === "drop") {
      continue;
    }
    if (resolved.kind === "folder") {
      collected.folderPrefixes.push({
        negated: filter.negated,
        value: resolved.value,
      });
    } else if (resolved.kind === "folder-set") {
      collected.folderPrefixSets.push({
        negated: filter.negated,
        values: resolved.values,
      });
    } else if (resolved.kind === "layer") {
      collected.layers.push({ negated: filter.negated, value: resolved.value });
    } else {
      collected.tags.push({ negated: filter.negated, value: resolved.value });
    }
  }
  return collected;
}

export async function resolveSearchDsl(
  env: Env,
  user: { id: string } | undefined,
  parsed: SearchQuery,
): Promise<ResolvedSearchDsl> {
  const collected = await collectFilters(env, user, parsed);
  // Fetch folder assignments once when a layer filter needs them. Guests have
  // no medallion config, so the empty list below also covers that case:
  // positive layer filters match nothing, negated ones just pass.
  const medallionAssignments =
    collected.layers.length > 0 && user
      ? await loadMedallionAssignments(env, user.id)
      : [];
  const empty =
    collected.empty ||
    (collected.layers.length > 0 &&
      medallionAssignments.length === 0 &&
      collected.layers.some((layer) => !layer.negated));
  return {
    ...collected,
    empty,
    medallionAssignments,
    parsed,
  };
}

/**
 * Appends the `searchNotes` `layer` option (`key` or `set.key`, same value
 * shape as the `layer:` DSL term) as a positive filter, lazily loading the
 * caller's folder medallion assignments when the DSL didn't already need them.
 */
export async function applyLayerOption(
  env: Env,
  user: { id: string } | undefined,
  resolved: ResolvedSearchDsl,
  layer: string | undefined,
): Promise<void> {
  const layerValue = layer ? layerFilterValue(layer) : null;
  if (!layerValue) {
    return;
  }
  resolved.layers.push({ negated: false, value: layerValue });
  if (user && resolved.medallionAssignments.length === 0) {
    resolved.medallionAssignments = await loadMedallionAssignments(
      env,
      user.id,
    );
  }
}

/**
 * `#foo` matches `#foo` and nested `#foo/bar`, but not `#foobar`.
 * Tag characters are word chars, `-`, and `/` (nested tags).
 */
function bodyHasTag(body: string, tag: string): boolean {
  let from = 0;
  for (;;) {
    const index = body.indexOf(tag, from);
    if (index < 0) {
      return false;
    }
    const next = body.charAt(index + tag.length);
    if (next === "" || !/[\w-]/.test(next)) {
      return true;
    }
    from = index + 1;
  }
}

/**
 * Authoritative in-memory check: every positive term must appear (per scope),
 * every negated term must be absent, and every resolved filter must hold.
 * Runs after permission filtering — it never widens visibility.
 */
function termFound(
  term: { value: string },
  title: string,
  body: string,
  scope: "all" | "body" | "title",
): boolean {
  if (scope === "title") {
    return title.includes(term.value);
  }
  if (scope === "body") {
    return body.includes(term.value);
  }
  return title.includes(term.value) || body.includes(term.value);
}

/**
 * Every resolved `layer:` filter must hold against the note's effective
 * (nearest-ancestor) folder medallion assignment, resolved lazily once.
 */
function layerFiltersMatch(
  resolved: ResolvedSearchDsl,
  folder: string,
): boolean {
  let effective: MedallionSearchAssignment | null | undefined;
  for (const layer of resolved.layers) {
    if (effective === undefined) {
      effective = resolveMedallionAssignment(
        resolved.medallionAssignments,
        folder,
      );
    }
    const matches =
      effective !== null &&
      effective.layerKey === layer.value.layer &&
      (layer.value.set === undefined || effective.setName === layer.value.set);
    if (matches === layer.negated) {
      return false;
    }
  }
  return true;
}

export function rowMatchesSearchDsl(
  row: {
    title: string;
    folder: string;
    markdown_snapshot: string | null;
  },
  resolved: ResolvedSearchDsl,
  scope: "all" | "body" | "title",
): boolean {
  const title = row.title.toLowerCase();
  const body = (row.markdown_snapshot ?? "").toLowerCase();
  for (const term of resolved.parsed.terms) {
    if (termFound(term, title, body, scope) === term.negated) {
      return false;
    }
  }
  for (const prefix of resolved.folderPrefixes) {
    if (pathFilterMatches(row.folder, prefix.value) === prefix.negated) {
      return false;
    }
  }
  for (const set of resolved.folderPrefixSets) {
    const any = set.values.some((value) =>
      pathFilterMatches(row.folder, value),
    );
    if (any === set.negated) {
      return false;
    }
  }
  for (const tag of resolved.tags) {
    if (bodyHasTag(body, tag.value) === tag.negated) {
      return false;
    }
  }
  if (!layerFiltersMatch(resolved, row.folder)) {
    return false;
  }
  return true;
}
