import type { SessionUser } from "@miyulabmd/shared";

import { ApiCommunicationError, requestJson } from "./api-transport.ts";
import { clearIdentityCache } from "./identity-lifecycle.ts";
import { persistCachedViewerId, readCachedViewerId } from "./offline-cache.ts";

export type ViewerContext = {
  mode: "authenticated" | "guest" | "cached" | "unavailable";
  user: SessionUser | null;
  cacheViewerId: string | null;
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
): ViewerContext {
  return { cacheViewerId, mode, user };
}

async function cachedOrUnavailable(
  signal?: AbortSignal,
): Promise<ViewerContext> {
  try {
    const cacheViewerId = await readCachedViewerId({ signal });
    return cacheViewerId
      ? context("cached", cacheViewerId)
      : context("unavailable", null);
  } catch {
    signal?.throwIfAborted();
    return context("unavailable", null);
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
    await persistCachedViewerId(user.id, { signal });
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
    return cachedOrUnavailable(signal);
  }
  return context("unavailable", null);
}

export async function resolveViewerContext(
  options: ResolveViewerOptions = {},
): Promise<ViewerContext> {
  const { signal } = options;
  let result: Awaited<ReturnType<typeof requestJson<MeResponse>>>;
  try {
    result = await requestJson<MeResponse>("/api/me", {
      credentials: "include",
      signal,
    });
  } catch (error) {
    if (error instanceof ApiCommunicationError) {
      return cachedOrUnavailable(signal);
    }
    throw error;
  }
  signal?.throwIfAborted();
  return resolveViewerResult(result, options);
}
