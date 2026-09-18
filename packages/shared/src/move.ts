import type { FolderChildrenResult } from "./note.ts";

/**
 * Reserved PARA buckets. `key` is a stable identifier stored on the folders row
 * (`para_bucket`) so bucket membership survives renames and moves; `name` is the
 * default top-level folder name used when materializing a missing bucket.
 */
export const PARA_BUCKETS = [
  { key: "projects", name: "Projects" },
  { key: "areas", name: "Areas" },
  { key: "resources", name: "Resources" },
  { key: "archives", name: "Archives" },
] as const;

export type ParaBucketKey = (typeof PARA_BUCKETS)[number]["key"];

export function isParaBucketKey(value: string): value is ParaBucketKey {
  return PARA_BUCKETS.some((bucket) => bucket.key === value);
}

/**
 * §2.5: stored `name` of the rootless default space row in `para_spaces`.
 * Bucket folders of the default space keep `para_space_id = NULL`; the row
 * exists so the space has a stable id/name for listing, rename and delete.
 */
export const DEFAULT_PARA_SPACE_NAME = "default";

export type ParaBucket = {
  key: ParaBucketKey;
  folderId: string;
  /** Current folder name — may differ from the default after renames. */
  name: string;
  path: string;
  /** Recursive count of notes inside the bucket. */
  noteCount: number;
};

/** §2.5: a PARA space = a user-named root folder + the four buckets under it. */
export type ParaSpaceSummary = {
  id: string;
  name: string;
  /** True for the rootless default space (buckets live at drive root). */
  isDefault: boolean;
  rootFolderId: string | null;
  /** Root folder path; "" for the default space. */
  rootPath: string;
  /** Assigned buckets in canonical order. */
  buckets: ParaBucket[];
};

export type ParaListResult = {
  /** §2.5 spaces, default space first. */
  spaces: ParaSpaceSummary[];
  /** Default-space buckets — kept for backward compatibility. */
  buckets: ParaBucket[];
  /** Present when a single bucket is requested. */
  children?: FolderChildrenResult;
};

// --- §2.4 enable flow: plan (side-effect-free) + enable (resolutions) -------

export type ParaPlanStatus = "assigned" | "vacant" | "collision";

export type ParaPlanExisting = {
  id: string;
  name: string;
};

export type ParaPlanBucket = {
  bucket: ParaBucketKey;
  /**
   * assigned = para_bucket already set on a folder / vacant = default name is
   * free to create / collision = a top-level folder holds the default name but
   * is not bucket-assigned.
   */
  status: ParaPlanStatus;
  /** For collision: the folder occupying the default name. For assigned: the
   * folder fulfilling the bucket (name may differ after renames). */
  existing?: ParaPlanExisting;
};

export type ParaSpacePlan = {
  /**
   * exists = the space is already set up (default space always is) /
   * vacant = a new space root folder may be created /
   * collision = an unassigned folder already holds the proposed root name.
   */
  status: "exists" | "vacant" | "collision";
  /** For collision: the folder occupying the root name. For exists: the
   * current root folder (undefined for the rootless default space). */
  existing?: ParaPlanExisting;
  /** Space name being planned (named spaces only). */
  name?: string;
  /** Existing space id when status === "exists" and a row is materialized. */
  spaceId?: string;
};

/**
 * Side-effect-free setup inspection for one PARA space (§2.4 + §2.5).
 */
export type ParaPlan = {
  space: ParaSpacePlan;
  buckets: ParaPlanBucket[];
};

export type ParaBucketResolution =
  | { action: "create" }
  | { action: "adopt"; folderId: string }
  | { action: "rename"; folderId: string; newName: string }
  | { action: "skip" };

/**
 * §2.5 space selector. `{ name }` = space name (resolves to an existing space
 * or proposes a new one rooted at a top-level folder of that name);
 * `{ id }` = an existing space id; `"default"`/omitted = the rootless default
 * space. A bare string resolves as an id first, then as a name, then proposes
 * a new space with that name (query-param friendly form).
 */
export type ParaSpaceRef = { id: string } | { name: string };
export type ParaSpaceSelector = ParaSpaceRef | "default" | string | null;

/** Resolution key: the four buckets plus the space root itself. */
export type ParaResolutionKey = ParaBucketKey | "space";

export type ParaEnableInput = {
  space?: ParaSpaceSelector;
  resolutions?: Partial<Record<ParaResolutionKey, ParaBucketResolution>>;
};

export type ParaEnableResult = {
  /** Post-enable plan; skipped buckets keep their pre-enable status. */
  plan: ParaPlan;
  /**
   * Entries still unassigned because a name collision was not resolved —
   * includes "space" when the space root itself is blocked. Non-empty means
   * the caller should collect resolutions and re-run enable.
   */
  pending: ParaResolutionKey[];
};

/** Max entities (notes + folders) one move request may touch. */
export const MOVE_MAX_ITEMS = 500;

/** Counts of entities a folder relocation will rewrite. */
export type MovePlan = {
  notes: number;
  folders: number;
  policies: number;
  grants: number;
  articleSources: number;
};

export type MoveItemStatus = "moved" | "skipped" | "failed";

export type MoveItemReason =
  | "not_found"
  | "denied"
  | "owner_mismatch"
  | "same_folder"
  | "conflict"
  | "cycle"
  | "locked";

export type MoveNoteItem = {
  noteId: string;
  status: MoveItemStatus;
  reason?: MoveItemReason;
  from?: string;
  to?: string;
};

export type MoveFolderItem = {
  folderId: string;
  status: MoveItemStatus;
  reason?: MoveItemReason;
  from?: string;
  to?: string;
};

export type MoveFolderResult = {
  from: string;
  to: string;
  plan: MovePlan;
  dryRun: boolean;
};

export type MoveNotesResult = {
  destFolderId: string | null;
  destPath: string;
  items: MoveNoteItem[];
  moved: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
};

export type MoveFolderContentsResult = {
  destFolderId: string | null;
  destPath: string;
  notes: MoveNoteItem[];
  folders: MoveFolderItem[];
  moved: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
};
