import type { ArticleMeta } from "./article.ts";
import type {
  AccessScope,
  CollaboratorRole,
  EffectiveAccess,
  PermissionFlags,
  PermissionPreset,
} from "./permission.ts";

export type NoteId = string;

export const NOTE_HISTORY_ACTOR_KINDS = ["user", "agent", "guest"] as const;
export type NoteHistoryActorKind = (typeof NOTE_HISTORY_ACTOR_KINDS)[number];

export const NOTE_EDIT_OPS = [
  "insert",
  "delete",
  "replace",
  "restore",
] as const;
export type NoteEditOp = (typeof NOTE_EDIT_OPS)[number];

export type NoteHistoryActor = {
  kind: NoteHistoryActorKind;
  userId: string | null;
  name: string;
};

export type NoteEditEvent = {
  id: string;
  noteId: NoteId;
  revisionId: string | null;
  actor: NoteHistoryActor;
  startedAt: number;
  endedAt: number;
  startOffset: number;
  endOffset: number;
  op: NoteEditOp;
  excerpt: string;
  createdAt: number;
};

export type NoteRevision = {
  id: string;
  noteId: NoteId;
  eventId: string | null;
  r2Key: string;
  byteSize: number;
  actor: NoteHistoryActor;
  createdAt: number;
};

export type NoteHistoryPage = {
  events: NoteEditEvent[];
  nextBefore: number | null;
};

export type NoteRevisionBody = NoteRevision & {
  markdown: string;
};

export type NoteRevisionRestore = {
  restored: true;
  revisionId: string;
  message: string;
};

export const NOTE_RESTORE_MESSAGE =
  "今の本文を、選んだ時点の全文で置き換えました。同時に編集していた内容は上書きされます。";

// --- edit lock (§2.6) -------------------------------------------------------

/**
 * Error code returned by mutation APIs while a note's `edit_locked` flag is
 * set. Locked notes allow reads and explicit unlock only — body edits,
 * delete, folder move, rename, and access changes are all rejected.
 */
export const EDIT_LOCKED_CODE = "edit_locked";

/**
 * WebSocket close code DocumentRoom uses when the edit lock engages
 * mid-session. The 4400-4499 range is the app-level "permanent" convention:
 * clients must treat the note as read-only instead of retrying the write.
 */
export const EDIT_LOCK_WS_CLOSE_CODE = 4403;
export const EDIT_LOCK_WS_CLOSE_REASON = "edit_locked";

export function isNoteHistoryActorKind(
  value: string,
): value is NoteHistoryActorKind {
  return (NOTE_HISTORY_ACTOR_KINDS as readonly string[]).includes(value);
}

export function isNoteEditOp(value: string): value is NoteEditOp {
  return (NOTE_EDIT_OPS as readonly string[]).includes(value);
}

export type NoteAccess = EffectiveAccess & {
  flags: PermissionFlags;
};

export type FolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  folder?: string;
  /** Effective scopes for list display (not a path leak). */
  readScope?: AccessScope;
  writeScope?: AccessScope;
  /** Owner views only: naming rule declared for this folder's children. */
  scheme?: string | null;
  /** Owner views only: ID minted by a parent's scheme. */
  schemeId?: string | null;
  schemeTitle?: string | null;
};

export type FolderCrumb = {
  id: string;
  name: string;
};

export type FolderEntryFolder = {
  type: "folder";
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: number;
  /** Owner views only: recursive count of notes inside this folder. */
  noteCount?: number;
  /** Owner views only: naming rule declared for this folder's children. */
  scheme?: string | null;
  /** Owner views only: ID minted by a parent's scheme. */
  schemeId?: string | null;
  schemeTitle?: string | null;
};

export type FolderEntryNote = {
  type: "note";
  id: string;
  title: string;
  updatedAt: number;
};

export type FolderEntry = FolderEntryFolder | FolderEntryNote;

export type FolderChildrenResult = {
  folder: { id: string | null; name: string; path: string[] };
  entries: FolderEntry[];
  nextCursor: string | null;
};

export type Note = {
  id: NoteId;
  shortId: string;
  alias: string | null;
  ownerId: string;
  title: string;
  folder: string;
  folderId: string | null;
  /** Scheme ID of the containing folder (e.g. `15.22`), when folderId is visible. */
  folderSchemeId?: string | null;
  /** Title part of the containing folder's scheme name. */
  folderSchemeTitle?: string | null;
  /**
   * §2.6 permanent per-note edit lock. While true every mutation (body,
   * metadata, move, delete, sharing) is rejected; only reads and explicit
   * unlock are allowed. Independent of medallion folder layers.
   */
  editLocked: boolean;
  permission: PermissionPreset;
  access: NoteAccess;
  markdown: string;
  articleMeta: ArticleMeta;
  createdAt: number;
  updatedAt: number;
};

export type NoteSummary = Omit<Note, "markdown">;

export const SEARCH_SCOPES = ["title", "body", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export function isSearchScope(value: string): value is SearchScope {
  return (SEARCH_SCOPES as readonly string[]).includes(value);
}

export type NoteSearchHit = NoteSummary & {
  snippet?: string;
};

export type NoteSearchPage = {
  notes: NoteSearchHit[];
  nextCursor: string | null;
};

export type GrepMatch = {
  noteId: NoteId;
  title: string;
  /** 1-based line number inside markdown_snapshot. */
  line: number;
  /** 1-based column where the match starts. */
  column: number;
  /** Full text of the matching line. */
  text: string;
  before: string[];
  after: string[];
  /** Snapshot freshness — the live document may be newer. */
  snapshotUpdatedAt: number | null;
};

export type GrepResult = {
  matches: GrepMatch[];
  /** True when a scan/match/time limit cut the result short. */
  truncated: boolean;
  scannedNotes: number;
};

/** Combined title hits + line-level body hits for the search palette. */
export type WorkspaceSearchResult = {
  query: string;
  notes: NoteSearchHit[];
  grep: GrepResult;
};

export type NoteCollaborator = {
  noteId: NoteId;
  userId: string;
  email: string;
  role: CollaboratorRole;
  createdAt: number;
};

export type AccessGrantInput = {
  email: string;
  canWrite?: boolean;
};

export type CreateNoteInput = {
  title?: string;
  markdown?: string;
  folder?: string;
  folderId?: string;
  permission?: PermissionPreset;
  inheritAccess?: boolean;
  readScope?: AccessScope;
  writeScope?: AccessScope;
};

export type UpdateNoteMetaInput = {
  title?: string;
  alias?: string | null;
  folder?: string;
  permission?: PermissionPreset;
  inheritAccess?: boolean;
  readScope?: AccessScope | null;
  writeScope?: AccessScope | null;
  grants?: AccessGrantInput[];
};

export type FolderAccess = EffectiveAccess & {
  id: string | null;
  name: string;
  parentId: string | null;
  folder?: string;
  crumbs: FolderCrumb[];
  children: FolderRecord[];
  flags: PermissionFlags;
  locked?: boolean;
  /** Naming rule this folder declares for its children. */
  scheme?: string | null;
  /** ID this folder carries from a parent's scheme. */
  schemeId?: string | null;
  schemeTitle?: string | null;
};

export type UpdateFolderAccessInput = {
  folder?: string;
  folderId?: string;
  inherit?: boolean;
  readScope?: AccessScope;
  writeScope?: AccessScope;
  grants?: AccessGrantInput[];
};

export type { AccessGrant } from "./permission.ts";
