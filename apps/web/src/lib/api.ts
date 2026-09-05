import type {
  AccessGrantInput,
  AccessScope,
  ArticleSource,
  ArticleSourceStatus,
  CreateNoteInput,
  FolderAccess,
  FolderRecord,
  Note,
  NoteSummary,
  PermissionPreset,
  SessionUser,
} from "@miyulabmd/shared";
import { notifyArticleChanged } from "./article-changed.ts";
import type { OgPreview } from "./embeds.ts";

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
  const res = await fetch("/api/auth/config", fetchOpts);
  if (!res.ok) {
    return { access: false, mock: true };
  }
  return (await res.json()) as AuthConfig;
}

export async function fetchMe(): Promise<SessionUser | null> {
  const res = await fetch("/api/me", fetchOpts);
  if (!res.ok) return null;
  const body = (await res.json()) as { user: SessionUser | null };
  return body.user;
}

export async function fetchNotes(): Promise<NoteSummary[]> {
  const res = await fetch("/api/notes", fetchOpts);
  if (!res.ok) return [];
  const body = (await res.json()) as { notes: NoteSummary[] };
  return body.notes;
}

export async function fetchNote(id: string): Promise<ApiResult<Note>> {
  const res = await fetch(`/api/notes/${id}`, fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as Note };
}

export async function createNote(
  input: CreateNoteInput = {},
): Promise<ApiResult<Note>> {
  const res = await fetch("/api/notes", {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as Note };
}

export async function updateProfile(
  displayName: string | null,
): Promise<ApiResult<SessionUser>> {
  const res = await fetch("/api/me", {
    ...fetchOpts,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  const body = (await res.json()) as { user: SessionUser };
  return { ok: true, data: body.user };
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
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  notifyArticleChanged();
  return { ok: true, data: (await res.json()) as Note };
}

export async function fetchFolderTree(): Promise<ApiResult<FolderRecord[]>> {
  const res = await fetch("/api/folders/tree", fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  const body = (await res.json()) as { folders: FolderRecord[] };
  return { ok: true, data: body.folders };
}

export async function fetchPublicFolders(): Promise<ApiResult<FolderRecord[]>> {
  const res = await fetch("/api/folders/public", fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  const body = (await res.json()) as { folders: FolderRecord[] };
  return { ok: true, data: body.folders };
}

export async function fetchSharedFolders(): Promise<ApiResult<FolderRecord[]>> {
  const res = await fetch("/api/folders/shared", fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  const body = (await res.json()) as { folders: FolderRecord[] };
  return { ok: true, data: body.folders };
}

export async function createFolder(input: {
  name: string;
  parentId?: string | null;
}): Promise<ApiResult<FolderAccess>> {
  const res = await fetch("/api/folders", {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as FolderAccess };
}

export async function fetchFolder(
  id?: string | null,
): Promise<ApiResult<FolderAccess>> {
  const res = await fetch(
    id ? `/api/folders/${id}` : "/api/folders",
    fetchOpts,
  );
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as FolderAccess };
}

export async function renameFolder(
  id: string,
  name: string,
): Promise<ApiResult<FolderAccess>> {
  const res = await fetch(`/api/folders/${id}`, {
    ...fetchOpts,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as FolderAccess };
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
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as FolderAccess };
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
    if (!card) continue;
    ogPreviewCache.set(url, card);
    if (card.url) ogPreviewCache.set(card.url, card);
  }
}

export async function fetchOgPreview(
  url: string,
): Promise<ApiResult<OgPreview>> {
  const cached = ogPreviewCache.get(url);
  if (cached) return { ok: true, data: cached };
  const inflight = ogPreviewInflight.get(url);
  if (inflight) return inflight;

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
        ok: false as const,
        status: res.status,
        error: await parseError(res),
      };
    }
    const data = (await res.json()) as OgPreview;
    ogPreviewCache.set(url, data);
    return { ok: true, data } as const;
  })().finally(() => {
    ogPreviewInflight.delete(url);
  });

  ogPreviewInflight.set(url, pending);
  return pending;
}

export async function uploadImage(
  noteId: string,
  file: File,
): Promise<ApiResult<{ id: string; url: string }>> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/notes/${noteId}/images`, {
    ...fetchOpts,
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as { id: string; url: string } };
}

export async function deleteFolder(id: string): Promise<ApiResult<void>> {
  const res = await fetch(`/api/folders/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: undefined };
}

export async function deleteNote(id: string): Promise<ApiResult<void>> {
  const res = await fetch(`/api/notes/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: undefined };
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { ...fetchOpts, method: "POST" });
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

export async function fetchTokens(): Promise<ApiResult<ApiTokenSummary[]>> {
  const res = await fetch("/api/tokens", fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  const body = (await res.json()) as { tokens: ApiTokenSummary[] };
  return { ok: true, data: body.tokens };
}

export async function createToken(
  name: string,
): Promise<ApiResult<ApiTokenCreated>> {
  const res = await fetch("/api/tokens", {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as ApiTokenCreated };
}

export type ArticleSourceWrite = {
  name?: string;
  folder?: string;
  folderId?: string | null;
  schema?: ArticleSource["schema"];
  webhookUrl?: string | null;
  webhookAuthorization?: string | null;
};

export async function fetchArticleSources(): Promise<
  ApiResult<ArticleSource[]>
> {
  const res = await fetch("/api/article-sources", fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  const body = (await res.json()) as { sources: ArticleSource[] };
  return { ok: true, data: body.sources };
}

export async function fetchArticleSourceStatus(): Promise<
  ApiResult<ArticleSourceStatus>
> {
  const res = await fetch("/api/article-sources/status", fetchOpts);
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: (await res.json()) as ArticleSourceStatus };
}

export async function createArticleSource(
  input: ArticleSourceWrite,
): Promise<ApiResult<ArticleSource>> {
  const res = await fetch("/api/article-sources", {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  notifyArticleChanged();
  return { ok: true, data: (await res.json()) as ArticleSource };
}

export async function updateArticleSource(
  id: string,
  input: ArticleSourceWrite,
): Promise<ApiResult<ArticleSource>> {
  const res = await fetch(`/api/article-sources/${id}`, {
    ...fetchOpts,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  notifyArticleChanged();
  return { ok: true, data: (await res.json()) as ArticleSource };
}

export async function deleteArticleSource(
  id: string,
): Promise<ApiResult<void>> {
  const res = await fetch(`/api/article-sources/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  notifyArticleChanged();
  return { ok: true, data: undefined };
}

export async function dispatchArticleSource(
  id: string,
): Promise<ApiResult<void>> {
  const res = await fetch(`/api/article-sources/${id}/dispatch`, {
    ...fetchOpts,
    method: "POST",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: undefined };
}

export async function revokeToken(id: string): Promise<ApiResult<void>> {
  const res = await fetch(`/api/tokens/${id}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await parseError(res) };
  }
  return { ok: true, data: undefined };
}
