import { onDriveChanged } from "./drive-changed.ts";
import {
  type MyDrivePrefetchPriority,
  prefetchMyDrive,
} from "./mydrive-prefetch.ts";
import {
  estimateOfflineStorage,
  requestOfflineStoragePersistence,
} from "./offline-storage-retention.ts";
import type { ViewerContext } from "./viewer-context.ts";

export const PREFETCH_DEBOUNCE_MS = 200;
export const PREFETCH_MIN_INTERVAL_MS = 1000;
export const PREFETCH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const PREFETCH_FAILURE_COOLDOWN_MS = 30_000;
const PREFETCH_LOCK_PREFIX = "miyulabmd:mydrive-prefetch:";

type PrefetchCoordinator = {
  dispose: () => void;
};

function isEligibleViewer(viewer: ViewerContext): boolean {
  return (
    viewer.mode === "authenticated" &&
    viewer.user !== null &&
    viewer.cacheViewerId === viewer.user.id
  );
}

function prefetchLockName(userId: string): string {
  return `${PREFETCH_LOCK_PREFIX}${JSON.stringify(userId)}`;
}

function currentPriority(): MyDrivePrefetchPriority {
  const match = /^\/(f|n|s)\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!match) {
    return null;
  }
  try {
    return {
      id: decodeURIComponent(match[2] ?? ""),
      kind: match[1] === "f" ? "folder" : "note",
    };
  } catch {
    return null;
  }
}

export function attachMyDrivePrefetchCoordinator(
  viewer: ViewerContext,
): PrefetchCoordinator {
  if (!isEligibleViewer(viewer)) {
    return { dispose: () => undefined };
  }

  const user = viewer.user;
  if (!user) {
    return { dispose: () => undefined };
  }
  const userId = user.id;
  const snapshot: ViewerContext = {
    cacheViewerId: viewer.cacheViewerId,
    mode: viewer.mode,
    user: { ...user },
  };
  // Browser storage hints must not delay acquisition, even if a prompt hangs.
  void requestOfflineStoragePersistence();
  void estimateOfflineStorage();
  let disposed = false;
  let timer: number | null = null;
  let activeController: AbortController | null = null;
  let pending = false;
  let lastAttemptAt: number | null = null;
  let refreshInterval: number | null = null;
  let cooldownUntil = 0;

  const schedule = () => {
    if (disposed || timer !== null) {
      return;
    }
    const elapsed =
      lastAttemptAt === null
        ? PREFETCH_MIN_INTERVAL_MS
        : Date.now() - lastAttemptAt;
    const waitForInterval =
      lastAttemptAt === null
        ? 0
        : Math.max(0, PREFETCH_MIN_INTERVAL_MS - elapsed);
    timer = window.setTimeout(
      () => {
        timer = null;
        if (disposed) {
          return;
        }
        if (activeController !== null) {
          pending = true;
          return;
        }
        if (!navigator.locks) {
          return;
        }
        lastAttemptAt = Date.now();
        const controller = new AbortController();
        activeController = controller;
        void navigator.locks
          .request(
            prefetchLockName(userId),
            { ifAvailable: true, mode: "exclusive" },
            async (lock) => {
              if (!lock || disposed || controller.signal.aborted) {
                return;
              }
              const result = await prefetchMyDrive(snapshot, {
                getPriority: currentPriority,
                signal: controller.signal,
              });
              if (result.status === "stopped" && result.reason !== "aborted") {
                cooldownUntil = Date.now() + PREFETCH_FAILURE_COOLDOWN_MS;
              }
            },
          )
          .catch(() => {
            // Prefetch and lock acquisition are both best effort.
          })
          .finally(() => {
            if (activeController === controller) {
              activeController = null;
            }
            if (!disposed && pending) {
              pending = false;
              schedule();
            }
          });
      },
      Math.max(
        PREFETCH_DEBOUNCE_MS,
        waitForInterval,
        cooldownUntil - Date.now(),
      ),
    );
  };

  const requestCycle = () => {
    if (activeController !== null) {
      pending = true;
      return;
    }
    schedule();
  };
  const isDocumentVisible = () => document.visibilityState === "visible";
  const onOnline = () => requestCycle();
  const onVisibilityChange = () => {
    if (isDocumentVisible()) {
      requestCycle();
    }
  };
  const removeDriveChangedListener = onDriveChanged(requestCycle);

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  refreshInterval = window.setInterval(() => {
    if (isDocumentVisible()) {
      requestCycle();
    }
  }, PREFETCH_REFRESH_INTERVAL_MS);
  requestCycle();

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      removeDriveChangedListener();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (refreshInterval !== null) {
        window.clearInterval(refreshInterval);
        refreshInterval = null;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      activeController?.abort();
      activeController = null;
      pending = false;
    },
  };
}
