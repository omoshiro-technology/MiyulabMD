import type { SessionUser } from "@miyulabmd/shared";

import { ApiCommunicationError, requestJson } from "./api-transport.ts";
import { clearIdentityCache } from "./identity-lifecycle.ts";
import {
  persistCachedViewer,
  readCachedViewer,
  readCachedViewerId,
} from "./offline-cache.ts";

export type ViewerContext = {
  mode: "authenticated" | "guest" | "cached" | "unavailable";
  user: SessionUser | null;
  cacheViewerId: string | null;
  /**
   * Display-only profile of the last signed-in viewer, restored from local
   * storage in "cached" mode. It is not proof of authentication — mutations
   * and permission checks must keep relying on `mode`/`user`.
   */
  cachedUser?: SessionUser | null;
  /**
   * The live /api/me check could not be answered (connection failure or 5xx),
   * so this context was resolved from local state alone. Callers should keep
   * retrying rather than treat it as a stable answer. Absent/false whenever
   * the server produced a definitive response.
   */
  liveCheckFailed?: boolean;
};

type MeResponse = { user: SessionUser | null };

function isSessionUser(value: unknown): value is SessionUser {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    user.id.length > 0 &&
    typeof user.email === "string" &&
    (typeof user.displayName === "string" || user.displayName === null)
  );
}

function isMeResponse(value: unknown): value is MeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "user" in value &&
    (value.user === null || isSessionUser(value.user))
  );
}

function context(
  mode: ViewerContext["mode"],
  cacheViewerId: string | null,
  user: SessionUser | null = null,
  cachedUser: SessionUser | null = null,
): ViewerContext {
  return { cachedUser, cacheViewerId, mode, user };
}

async function cachedOrUnavailable(
  signal: AbortSignal | undefined,
  liveCheckFailed = false,
): Promise<ViewerContext> {
  try {
    const cached = await readCachedViewer({ signal });
    return cached
      ? { ...context("cached", cached.id, null, cached.user), liveCheckFailed }
      : { ...context("unavailable", null), liveCheckFailed };
  } catch {
    signal?.throwIfAborted();
    return { ...context("unavailable", null), liveCheckFailed };
  }
}

async function authenticatedContext(
  user: SessionUser,
  options: ResolveViewerOptions,
): Promise<ViewerContext> {
  const { signal } = options;
  let storageWarning = false;
  let remembered: string | null = null;
  try {
    remembered = await readCachedViewerId({ signal });
  } catch {
    signal?.throwIfAborted();
    storageWarning = true;
  }
  const priorIds = new Set([
    remembered,
    options.previousViewer?.user?.id,
    options.previousViewer?.cacheViewerId,
  ]);
  for (const priorId of priorIds) {
    signal?.throwIfAborted();
    if (priorId && priorId !== user.id) {
      try {
        await clearIdentityCache(priorId);
      } catch {
        signal?.throwIfAborted();
        storageWarning = true;
      }
    }
  }
  signal?.throwIfAborted();
  if (storageWarning) {
    options.onWarning?.(
      "本人確認は完了しましたが、ローカルキャッシュを確認または削除できませんでした。キャッシュを利用せずオンラインデータを表示しています。",
    );
    return context("authenticated", null, user);
  }
  try {
    await persistCachedViewer(user, { signal });
    signal?.throwIfAborted();
    return context("authenticated", user.id, user);
  } catch {
    signal?.throwIfAborted();
    options.onWarning?.(
      "本人確認は完了しましたが、ローカルキャッシュを保存できませんでした。キャッシュを利用せずオンラインデータを表示しています。",
    );
    return context("authenticated", null, user);
  }
}

export type ResolveViewerOptions = {
  signal?: AbortSignal;
  previousViewer?: ViewerContext;
  onWarning?: (message: string) => void;
};

async function resolveViewerResult(
  result: Awaited<ReturnType<typeof requestJson<MeResponse>>>,
  options: ResolveViewerOptions,
): Promise<ViewerContext> {
  const { signal } = options;
  if (result.ok) {
    markLastLiveSync();
    if (!isMeResponse(result.data)) {
      return context("unavailable", null);
    }
    if (result.data.user) {
      return authenticatedContext(result.data.user, options);
    }
    const cached = await cachedOrUnavailable(signal);
    return cached.mode === "cached" ? cached : context("guest", null);
  }
  if (result.status === 401) {
    const cached = await cachedOrUnavailable(signal);
    return cached.mode === "cached" ? cached : context("guest", null);
  }
  if (result.status >= 500 && result.status <= 599) {
    return cachedOrUnavailable(signal, true);
  }
  return context("unavailable", null);
}

// Bound the live check: a stalled socket would otherwise hold the
// single-flight viewer request open and starve every scheduled retry
// until the OS gives up on it.
const LIVE_CHECK_TIMEOUT_MS = 15_000;

const LAST_LIVE_SYNC_KEY = "miyulabmd:last-live-sync";

/**
 * サーバーと最後に疎通できた時刻。オフライン表示の「最終同期」ポップアップ用。
 * localStorage なので冷起動のオフラインでも読める。
 */
export function readLastLiveSyncAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_LIVE_SYNC_KEY);
    const at = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

function markLastLiveSync(): void {
  try {
    localStorage.setItem(LAST_LIVE_SYNC_KEY, String(Date.now()));
  } catch {
    // 永続化できない環境では最終同期時刻を持たない。
  }
}

export async function resolveViewerContext(
  options: ResolveViewerOptions = {},
): Promise<ViewerContext> {
  const { signal } = options;
  const meSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS)])
    : AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS);
  let result: Awaited<ReturnType<typeof requestJson<MeResponse>>>;
  try {
    result = await requestJson<MeResponse>("/api/me", {
      credentials: "include",
      signal: meSignal,
    });
  } catch (error) {
    if (
      error instanceof ApiCommunicationError ||
      (error instanceof DOMException && error.name === "TimeoutError")
    ) {
      return cachedOrUnavailable(signal, true);
    }
    throw error;
  }
  signal?.throwIfAborted();
  return resolveViewerResult(result, options);
}
