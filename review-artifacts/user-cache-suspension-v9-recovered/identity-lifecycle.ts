import { invalidateFolderCache, invalidateNotesCache } from "./list-cache.ts";
import { invalidateNoteCache } from "./note-cache.ts";
import {
  clearOfflineCacheUser,
  subscribeOfflineCacheInvalidation,
} from "./offline-cache.ts";

type IdentityEvent = {
  id: string;
  userId: string;
  reason: "switch" | "logout";
  phase: "begin" | "complete" | "failed";
};
const listeners = new Set<(event: IdentityEvent, peer: boolean) => void>();
let channel: BroadcastChannel | null = null;

function isIdentityEvent(value: unknown): value is IdentityEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Partial<IdentityEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.userId === "string" &&
    (event.reason === "switch" || event.reason === "logout") &&
    (event.phase === "begin" ||
      event.phase === "complete" ||
      event.phase === "failed")
  );
}

if (typeof window !== "undefined") {
  try {
    channel = new BroadcastChannel("miyulabmd-identity-invalidation");
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!isIdentityEvent(data)) {
        return;
      }
      notifyListeners(data, true);
    };
  } catch {
    // Storage epochs still protect cache reads when messaging is unavailable.
  }
}

export function subscribeIdentityLifecycle(
  listener: (event: IdentityEvent, peer: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(event: IdentityEvent, peer: boolean): void {
  for (const listener of listeners) {
    listener(event, peer);
  }
}

function emit(event: IdentityEvent): void {
  notifyListeners(event, false);
  channel?.postMessage(event);
}

function clearMemory(): void {
  // These older memory caches are realm-wide, not partitioned by actor.
  invalidateNoteCache();
  invalidateNotesCache();
  invalidateFolderCache();
}
subscribeOfflineCacheInvalidation(clearMemory);

export async function clearIdentityCache(userId: string): Promise<void> {
  const event: IdentityEvent = {
    id: crypto.randomUUID(),
    phase: "begin",
    reason: "switch",
    userId,
  };
  emit(event);
  clearMemory();
  try {
    await clearOfflineCacheUser(userId);
    emit({ ...event, phase: "complete" });
  } catch (error) {
    emit({ ...event, phase: "failed" });
    throw error;
  }
}

let logoutOperation: Promise<void> | null = null;

/** Clear local identities, confirm the server actor, then use native Access navigation. */
export function logoutAndClearIdentity(capturedUserId: string): Promise<void> {
  if (logoutOperation) {
    return logoutOperation;
  }
  logoutOperation = performLogout(capturedUserId).finally(() => {
    logoutOperation = null;
  });
  return logoutOperation;
}

async function performLogout(capturedUserId: string): Promise<void> {
  const events: IdentityEvent[] = [];
  const clear = async (userId: string) => {
    if (events.some((event) => event.userId === userId)) {
      return;
    }
    const event: IdentityEvent = {
      id: crypto.randomUUID(),
      phase: "begin",
      reason: "logout",
      userId,
    };
    events.push(event);
    emit(event);
    clearMemory();
    await clearOfflineCacheUser(userId);
  };
  try {
    await clear(capturedUserId);
    // This opt-in response never redirects. GET remains a native navigation,
    // not fetch following a cross-origin Cloudflare Access redirect.
    const response = await globalThis.fetch("/auth/logout", {
      cache: "no-store",
      credentials: "include",
      headers: { "X-MiyulabMD-Logout": "prepare" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const actor = response.headers.get("X-MiyulabMD-Session-User");
    const validActor =
      actor === "guest" || (actor !== null && /^user:.+/.test(actor));
    if (!response.ok || response.redirected || !validActor) {
      throw new Error("Server logout preparation could not be confirmed");
    }
    if (actor?.startsWith("user:")) {
      await clear(actor.slice(5));
    }
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("ok" in body) ||
      body.ok !== true
    ) {
      throw new Error("Invalid logout preparation response");
    }
    for (const event of events) {
      emit({ ...event, phase: "complete" });
    }
    window.location.assign("/auth/logout");
  } catch (error) {
    for (const event of events) {
      emit({ ...event, phase: "failed" });
    }
    throw error;
  }
}
