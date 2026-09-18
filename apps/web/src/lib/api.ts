import type { TaskCheckboxUpdate } from "@miyulabmd/markdown";
import type {
  AccessGrantInput,
  AccessScope,
  ArticleSource,
  ArticleSourceStatus,
  CreateNoteInput,
  FolderAccess,
  FolderChildrenResult,
  FolderRecord,
  KnowledgeSettings,
  MedallionAssignment,
  MedallionLayer,
  MedallionResolution,
  MedallionSet,
  MoveFolderContentsResult,
  MoveFolderResult,
  MoveNotesResult,
  Note,
  NoteHistoryPage,
  NoteLinksResult,
  NoteRevisionBody,
  NoteRevisionRestore,
  NoteSummary,
  ParaBucketKey,
  ParaEnableInput,
  ParaEnableResult,
  ParaListResult,
  ParaPlan,
  PermissionPreset,
  SchemeRootEntry,
  SchemeSuggestion,
  SessionUser,
  WorkspaceSearchResult,
} from "@miyulabmd/shared";
import { apiFetch as fetch } from "./api-fetch.ts";
import { ApiHttpError, requestJson } from "./api-transport.ts";
import { notifyArticleChanged } from "./article-changed.ts";
import type { OgPreview } from "./embeds.ts";
import { fetchNoteRequest } from "./note-request.ts";

const fetchOpts: RequestInit = { credentials: "include" };

/** Custom-domain Worker cannot fetch same-zone CNAMEs; workers.dev can. */
const OG_FALLBACK_ORIGIN = "https://miyulabmd.wakuwakup.workers.dev";

function ogFallbackOrigin(): string | null {
  if (
    typeof window !== "undefined" &&
    window.location.origin === OG_FALLBACK_ORIGIN
  ) {
    return null;
  }
  return OG_FALLBACK_ORIGIN;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export type ReadOptions = {
  signal?: AbortSignal;
  viewerId?: string | null;
  /**
   * Durable purge fence captured when the read started. Forwarded to the
   * shared note transport so a post-purge read never joins a pre-purge
   * in-flight request.
   */
  purgeFence?:
    | Promise<{ device: number; user: number } | null>
    | { device: number; user: number }
    | null;
};

export {
  ApiCommunicationError,
  ApiHttpError,
  ApiIdentityError,
} from "./api-transport.ts";

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export type AuthConfig = {
  access: boolean;
  mock: boolean;
};

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const result = await requestJson<AuthConfig>("/api/auth/config", fetchOpts);
  if (!result.ok) {
    return { access: false, mock: false };
  }
  return result.data;
}

export async function fetchMe(): Promise<SessionUser | null> {
  const result = await requestJson<{ user: SessionUser | null }>(
    "/api/me",
    fetchOpts,
  );
  if (!result.ok) {
    return null;
  }
  return result.data.user;
}

export async function fetchNotes(
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<NoteSummary[]> {
  const res = await fetch(
    "/api/notes",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    throw new ApiHttpError(await parseError(res), res.status);
  }
  const body = (await res.json()) as { notes: NoteSummary[] };
  return body.notes;
}

export function fetchNote(
  id: string,
  options: ReadOptions = {},
): Promise<ApiResult<Note>> {
  return fetchNoteRequest(id, options);
}

export async function updateTaskCheckbox(
  id: string,
  input: TaskCheckboxUpdate,
): Promise<ApiResult<{ ok: true; checked: boolean }>> {
  const res = await fetch(`/api/notes/${id}/task-checkbox`, {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: await res.json(), ok: true };
}

export async function fetchNoteLinks(
  id: string,
  options: ReadOptions = {},
): Promise<ApiResult<NoteLinksResult>> {
  const res = await fetch(
    `/api/notes/${id}/links`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as NoteLinksResult, ok: true };
}

export async function fetchNoteHistory(
  id: string,
  query: { limit?: number; before?: number } = {},
  options: ReadOptions = {},
): Promise<ApiResult<NoteHistoryPage>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.before !== undefined) {
    params.set("before", String(query.before));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(
    `/api/notes/${id}/history${suffix}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as NoteHistoryPage, ok: true };
}

export async function fetchNoteRevision(
  id: string,
  revisionId: string,
  options: ReadOptions = {},
): Promise<ApiResult<NoteRevisionBody>> {
  const res = await fetch(
    `/api/notes/${id}/revisions/${revisionId}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as NoteRevisionBody, ok: true };
}

export async function restoreNoteRevision(
  id: string,
  revisionId: string,
): Promise<ApiResult<NoteRevisionRestore>> {
  const res = await fetch(`/api/notes/${id}/revisions/${revisionId}/restore`, {
    ...fetchOpts,
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as NoteRevisionRestore, ok: true };
}

export async function createNote(
  input: CreateNoteInput = {},
): Promise<ApiResult<Note>> {
  const res = await fetch("/api/notes", {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as Note, ok: true };
}

export async function updateProfile(
  displayName: string | null,
): Promise<ApiResult<SessionUser>> {
  const res = await fetch("/api/me", {
    ...fetchOpts,
    body: JSON.stringify({ displayName }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { user: SessionUser };
  return { data: body.user, ok: true };
}

/** settings.knowledge の部分更新（PATCH /api/me）。 */
export async function updateKnowledgeSettings(
  knowledge: Partial<KnowledgeSettings>,
): Promise<ApiResult<SessionUser>> {
  const res = await fetch("/api/me", {
    ...fetchOpts,
    body: JSON.stringify({ settings: { knowledge } }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { user: SessionUser };
  return { data: body.user, ok: true };
}

export async function updateNote(
  id: string,
  patch: {
    title?: string;
    markdown?: string;
    folder?: string;
    permission?: PermissionPreset;
    inheritAccess?: boolean;
    readScope?: AccessScope | null;
    writeScope?: AccessScope | null;
    grants?: AccessGrantInput[];
  },
): Promise<ApiResult<Note>> {
  const res = await fetch(`/api/notes/${id}`, {
    ...fetchOpts,
    body: JSON.stringify(patch),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  notifyArticleChanged();
  return { data: (await res.json()) as Note, ok: true };
}

export async function fetchFolderTree(
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<FolderRecord[]>> {
  const res = await fetch(
    "/api/folders/tree",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { folders: FolderRecord[] };
  return { data: body.folders, ok: true };
}

export async function fetchPublicFolders(
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<FolderRecord[]>> {
  const res = await fetch(
    "/api/folders/public",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { folders: FolderRecord[] };
  return { data: body.folders, ok: true };
}

export async function fetchSharedFolders(
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<FolderRecord[]>> {
  const res = await fetch(
    "/api/folders/shared",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { folders: FolderRecord[] };
  return { data: body.folders, ok: true };
}

export async function searchWorkspace(
  query: string,
  options: {
    context?: number;
    signal?: AbortSignal;
    viewerId?: string | null;
  } = {},
): Promise<ApiResult<WorkspaceSearchResult>> {
  const params = new URLSearchParams({ query });
  if (options.context !== undefined) {
    params.set("context", String(options.context));
  }
  const res = await fetch(
    `/api/search?${params.toString()}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as WorkspaceSearchResult, ok: true };
}

export async function createFolder(input: {
  name: string;
  parentId?: string | null;
  /** Mint the name from the parent's naming scheme (JD/Zettelkasten). */
  useScheme?: boolean;
  schemeId?: string;
}): Promise<ApiResult<FolderAccess>> {
  const res = await fetch("/api/folders", {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as FolderAccess, ok: true };
}

export async function fetchFolder(
  id?: string | null,
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<FolderAccess>> {
  const res = await fetch(
    id ? `/api/folders/${id}` : "/api/folders",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as FolderAccess, ok: true };
}

export async function fetchFolderChildren(
  id: string,
  options: {
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
    viewerId?: string | null;
  } = {},
): Promise<ApiResult<FolderChildrenResult>> {
  const params = new URLSearchParams();
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(
    `/api/folders/${id}/children${suffix}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as FolderChildrenResult, ok: true };
}

export async function renameFolder(
  id: string,
  name: string,
): Promise<ApiResult<FolderAccess>> {
  const res = await fetch(`/api/folders/${id}`, {
    ...fetchOpts,
    body: JSON.stringify({ name }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as FolderAccess, ok: true };
}

export async function updateFolderAccess(input: {
  folderId: string;
  inherit?: boolean;
  readScope?: AccessScope;
  writeScope?: AccessScope;
  grants?: AccessGrantInput[];
}): Promise<ApiResult<FolderAccess>> {
  const res = await fetch("/api/folders", {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as FolderAccess, ok: true };
}

const ogPreviewCache = new Map<string, OgPreview>();
const ogPreviewInflight = new Map<string, Promise<ApiResult<OgPreview>>>();

export function peekOgPreview(url: string): OgPreview | undefined {
  return ogPreviewCache.get(url);
}

export function seedOgPreviews(
  cards: Record<string, OgPreview> | Map<string, OgPreview>,
): void {
  const entries =
    cards instanceof Map ? cards.entries() : Object.entries(cards);
  for (const [url, card] of entries) {
    if (!card) {
      continue;
    }
    ogPreviewCache.set(url, card);
    if (card.url) {
      ogPreviewCache.set(card.url, card);
    }
  }
}

export async function fetchOgPreview(
  url: string,
): Promise<ApiResult<OgPreview>> {
  const cached = ogPreviewCache.get(url);
  if (cached) {
    return { data: cached, ok: true };
  }
  const inflight = ogPreviewInflight.get(url);
  if (inflight) {
    return inflight;
  }

  const pending = (async () => {
    const path = `/api/og?url=${encodeURIComponent(url)}`;
    let res = await fetch(path, fetchOpts);
    const fallbackOrigin = ogFallbackOrigin();
    if (!res.ok && fallbackOrigin) {
      res = await fetch(`${fallbackOrigin}${path}`, {
        credentials: "omit",
      });
    }
    if (!res.ok) {
      return {
        error: await parseError(res),
        ok: false as const,
        status: res.status,
      };
    }
    const data = (await res.json()) as OgPreview;
    ogPreviewCache.set(url, data);
    return { data, ok: true } as const;
  })().finally(() => {
    ogPreviewInflight.delete(url);
  });

  ogPreviewInflight.set(url, pending);
  return await pending;
}

export async function uploadImage(
  noteId: string,
  file: File,
): Promise<ApiResult<{ id: string; url: string }>> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/notes/${noteId}/images`, {
    ...fetchOpts,
    body: form,
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as { id: string; url: string }, ok: true };
}

export async function moveFolder(
  id: string,
  input: { destFolderId?: string | null; name?: string; dryRun?: boolean },
): Promise<ApiResult<MoveFolderResult>> {
  const res = await fetch(`/api/folders/${id}/move`, {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as MoveFolderResult, ok: true };
}

export async function moveFolderContents(
  id: string,
  input: {
    destFolderId?: string | null;
    includeSubfolders?: boolean;
    dryRun?: boolean;
  },
): Promise<ApiResult<MoveFolderContentsResult>> {
  const res = await fetch(`/api/folders/${id}/move-contents`, {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as MoveFolderContentsResult, ok: true };
}

export async function moveNotes(
  noteIds: string[],
  destFolderId: string | null,
): Promise<ApiResult<MoveNotesResult>> {
  const res = await fetch("/api/notes/move", {
    ...fetchOpts,
    body: JSON.stringify({ destFolderId, noteIds }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as MoveNotesResult, ok: true };
}

export async function fetchPara(
  options: {
    bucket?: ParaBucketKey;
    /** §2.5: space name, id, or "default". Omit = all spaces. */
    space?: string;
    signal?: AbortSignal;
    viewerId?: string | null;
  } = {},
): Promise<ApiResult<ParaListResult>> {
  const params = new URLSearchParams();
  if (options.bucket) {
    params.set("bucket", options.bucket);
  }
  if (options.space) {
    params.set("space", options.space);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(
    `/api/para${suffix}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as ParaListResult, ok: true };
}

/** §2.4/§2.5: side-effect-free setup inspection of one PARA space. */
export async function fetchParaPlan(
  options: {
    /** Space name, id, or "default" (omit = default space). */
    space?: string;
    signal?: AbortSignal;
    viewerId?: string | null;
  } = {},
): Promise<ApiResult<ParaPlan>> {
  const suffix = options.space
    ? `?space=${encodeURIComponent(options.space)}`
    : "";
  const res = await fetch(
    `/api/para/plan${suffix}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as ParaPlan, ok: true };
}

/**
 * §2.4: idempotent PARA enable. Vacant buckets are created; collisions need a
 * resolution (create/adopt/rename/skip). The response `pending` lists bucket
 * keys still blocked by unresolved collisions — re-run after resolving them.
 */
export async function enablePara(
  input: ParaEnableInput = {},
): Promise<ApiResult<ParaEnableResult>> {
  const res = await fetch("/api/para/enable", {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as ParaEnableResult, ok: true };
}

export async function archiveParaProject(
  folderId: string,
  input: { dated?: boolean; name?: string; dryRun?: boolean } = {},
): Promise<ApiResult<MoveFolderResult>> {
  const res = await fetch("/api/para/archive", {
    ...fetchOpts,
    body: JSON.stringify({ folderId, ...input }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as MoveFolderResult, ok: true };
}

/** §2.5: rename a PARA space (owner-unique name; the root folder is untouched). */
export async function renameParaSpace(
  spaceId: string,
  name: string,
): Promise<ApiResult<{ ok: true }>> {
  const res = await fetch(`/api/para/spaces/${spaceId}`, {
    ...fetchOpts,
    body: JSON.stringify({ name }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: { ok: true }, ok: true };
}

/** §2.5: delete = unassign only. Bucket folders and the root folder remain. */
export async function deleteParaSpace(
  spaceId: string,
): Promise<ApiResult<{ ok: true }>> {
  const res = await fetch(`/api/para/spaces/${spaceId}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: { ok: true }, ok: true };
}

export type SchemeSuggestResponse = {
  suggestion: SchemeSuggestion | null;
};

export type SchemeRootsResponse = {
  schemes: SchemeRootEntry[];
};

/** 設定ページ向け: 規則を宣言したフォルダ（採番スコープのルート）の一覧。 */
export async function fetchSchemeRoots(
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<SchemeRootsResponse>> {
  const res = await fetch(
    "/api/schemes",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as SchemeRootsResponse, ok: true };
}

export async function fetchSchemeSuggestion(
  folderId: string,
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<SchemeSuggestResponse>> {
  const res = await fetch(
    `/api/schemes/suggest?folderId=${encodeURIComponent(folderId)}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as SchemeSuggestResponse, ok: true };
}

export async function updateFolderScheme(
  folderId: string,
  scheme: string | null,
): Promise<ApiResult<{ folder: string; id: string; scheme: string | null }>> {
  const res = await fetch(`/api/folders/${folderId}/scheme`, {
    ...fetchOpts,
    body: JSON.stringify({ scheme }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return {
    data: (await res.json()) as {
      folder: string;
      id: string;
      scheme: string | null;
    },
    ok: true,
  };
}

export type SchemeResolveResponse = {
  folder: {
    folder: string;
    id: string;
    name: string;
    scheme: string | null;
    schemeId: string;
    schemeTitle: string | null;
  };
};

export async function resolveSchemeId(
  id: string,
  options: { signal?: AbortSignal; viewerId?: string | null } = {},
): Promise<ApiResult<SchemeResolveResponse>> {
  const res = await fetch(
    `/api/schemes/resolve?id=${encodeURIComponent(id)}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as SchemeResolveResponse, ok: true };
}

// --- medallion layers -------------------------------------------------------

export type EditLockResult =
  | { ok: true; note: NoteSummary }
  | { ok: false; status: number; error?: string };

/**
 * §2.6 permanent edit lock. `locked=false` is the only mutation allowed on a
 * locked note — there is no timed unlock.
 */
export async function setNoteEditLock(
  noteId: string,
  locked: boolean,
): Promise<EditLockResult> {
  const res = await fetch(`/api/notes/${noteId}/lock`, {
    ...fetchOpts,
    body: JSON.stringify({ locked }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    note?: NoteSummary;
  };
  if (!res.ok) {
    return { error: body.error, ok: false, status: res.status };
  }
  // The lock route returns the note itself (not wrapped).
  const note = (body.note ?? body) as NoteSummary;
  return { note, ok: true };
}

// --- medallion layer sets (§2.6) ---------------------------------------------

export async function fetchMedallionSets(
  options: ReadOptions = {},
): Promise<ApiResult<{ sets: MedallionSet[] }>> {
  const res = await fetch(
    "/api/medallion/sets",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as { sets: MedallionSet[] }, ok: true };
}

/** Seed the built-in 精緻度 set (idempotent — call when enabling the feature). */
export async function ensureDefaultMedallionSet(): Promise<
  ApiResult<{ set: MedallionSet }>
> {
  const res = await fetch("/api/medallion/sets/default", {
    ...fetchOpts,
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as { set: MedallionSet }, ok: true };
}

export async function createMedallionSet(input: {
  name: string;
  layers?: MedallionLayer[];
}): Promise<ApiResult<{ set: MedallionSet }>> {
  const res = await fetch("/api/medallion/sets", {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as { set: MedallionSet }, ok: true };
}

export async function updateMedallionSet(
  id: string,
  input: { name?: string; layers?: MedallionLayer[] },
): Promise<ApiResult<{ set: MedallionSet }>> {
  const res = await fetch(`/api/medallion/sets/${id}`, {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as { set: MedallionSet }, ok: true };
}

export type DeleteMedallionSetResult =
  | { ok: true }
  | { ok: false; status: number; error: string; assignedFolders?: number };

export async function deleteMedallionSet(
  id: string,
  confirm: boolean,
): Promise<DeleteMedallionSetResult> {
  const res = await fetch(
    `/api/medallion/sets/${id}${confirm ? "?confirm=1" : ""}`,
    { ...fetchOpts, method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      assignedFolders?: number;
    };
    return {
      assignedFolders: body.assignedFolders,
      error: body.error ?? res.statusText,
      ok: false,
      status: res.status,
    };
  }
  return { ok: true };
}

export async function fetchMedallionAssignments(
  options: ReadOptions = {},
): Promise<ApiResult<{ assignments: MedallionAssignment[] }>> {
  const res = await fetch(
    "/api/medallion/assignments",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return {
    data: (await res.json()) as { assignments: MedallionAssignment[] },
    ok: true,
  };
}

export async function resolveMedallion(
  path: string,
  options: ReadOptions = {},
): Promise<ApiResult<{ medallion: MedallionResolution | null }>> {
  const res = await fetch(
    `/api/medallion/resolve?path=${encodeURIComponent(path)}`,
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return {
    data: (await res.json()) as { medallion: MedallionResolution | null },
    ok: true,
  };
}

export async function assignFolderMedallion(
  folderId: string,
  input: { setId: string; layer: string },
): Promise<ApiResult<{ assignment: MedallionAssignment }>> {
  const res = await fetch(`/api/medallion/folders/${folderId}`, {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return {
    data: (await res.json()) as { assignment: MedallionAssignment },
    ok: true,
  };
}

export async function clearFolderMedallion(
  folderId: string,
): Promise<ApiResult<void>> {
  const res = await fetch(`/api/medallion/folders/${folderId}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: undefined, ok: true };
}

export async function deleteFolder(id: string): Promise<ApiResult<void>> {
  const res = await fetch(`/api/folders/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: undefined, ok: true };
}

export async function deleteNote(id: string): Promise<ApiResult<void>> {
  const res = await fetch(`/api/notes/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: undefined, ok: true };
}

export async function logout(): Promise<void> {
  await globalThis.fetch("/auth/logout", { ...fetchOpts, method: "POST" });
}

export type ApiTokenSummary = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export type ApiTokenCreated = ApiTokenSummary & {
  token: string;
};

export async function fetchTokens(
  options: ReadOptions = {},
): Promise<ApiResult<ApiTokenSummary[]>> {
  const res = await fetch(
    "/api/tokens",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { tokens: ApiTokenSummary[] };
  return { data: body.tokens, ok: true };
}

export async function createToken(
  name: string,
): Promise<ApiResult<ApiTokenCreated>> {
  const res = await fetch("/api/tokens", {
    ...fetchOpts,
    body: JSON.stringify({ name }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as ApiTokenCreated, ok: true };
}

export type ArticleSourceWrite = {
  name?: string;
  folder?: string;
  folderId?: string | null;
  schema?: ArticleSource["schema"];
  webhookUrl?: string | null;
  webhookAuthorization?: string | null;
};

export async function fetchArticleSources(
  options: ReadOptions = {},
): Promise<ApiResult<ArticleSource[]>> {
  const res = await fetch(
    "/api/article-sources",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  const body = (await res.json()) as { sources: ArticleSource[] };
  return { data: body.sources, ok: true };
}

export async function fetchArticleSourceStatus(
  options: ReadOptions = {},
): Promise<ApiResult<ArticleSourceStatus>> {
  const res = await fetch(
    "/api/article-sources/status",
    { ...fetchOpts, signal: options.signal },
    options,
  );
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: (await res.json()) as ArticleSourceStatus, ok: true };
}

export async function createArticleSource(
  input: ArticleSourceWrite,
): Promise<ApiResult<ArticleSource>> {
  const res = await fetch("/api/article-sources", {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  notifyArticleChanged();
  return { data: (await res.json()) as ArticleSource, ok: true };
}

export async function updateArticleSource(
  id: string,
  input: ArticleSourceWrite,
): Promise<ApiResult<ArticleSource>> {
  const res = await fetch(`/api/article-sources/${id}`, {
    ...fetchOpts,
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  notifyArticleChanged();
  return { data: (await res.json()) as ArticleSource, ok: true };
}

export async function deleteArticleSource(
  id: string,
): Promise<ApiResult<void>> {
  const res = await fetch(`/api/article-sources/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  notifyArticleChanged();
  return { data: undefined, ok: true };
}

export async function dispatchArticleSource(
  id: string,
): Promise<ApiResult<void>> {
  const res = await fetch(`/api/article-sources/${id}/dispatch`, {
    ...fetchOpts,
    method: "POST",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: undefined, ok: true };
}

export async function revokeToken(id: string): Promise<ApiResult<void>> {
  const res = await fetch(`/api/tokens/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { error: await parseError(res), ok: false, status: res.status };
  }
  return { data: undefined, ok: true };
}
