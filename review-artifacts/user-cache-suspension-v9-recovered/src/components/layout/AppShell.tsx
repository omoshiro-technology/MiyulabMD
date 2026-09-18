import type { SessionUser } from "@miyulabmd/shared";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Outlet, useLocation } from "react-router";
import { type AuthConfig, fetchAuthConfig } from "../../lib/api.ts";
import { subscribeApiIdentityChange } from "../../lib/api-fetch.ts";
import { cn } from "../../lib/cn.ts";
import { subscribeIdentityLifecycle } from "../../lib/identity-lifecycle.ts";
import { attachMyDrivePrefetchCoordinator } from "../../lib/mydrive-prefetch-coordinator.ts";
import {
  resolveViewerContext,
  type ViewerContext,
} from "../../lib/viewer-context.ts";
import {
  bindMutationAccess,
  createViewingAccess,
} from "../../lib/viewing-access.ts";
import { AppHeader } from "./AppHeader.tsx";
import type { AppShellContext } from "./AppShellContext.ts";

function isEditorPath(pathname: string): boolean {
  return pathname.startsWith("/n/") || pathname.startsWith("/s/");
}

function isCurrentViewerRequest(
  active: boolean,
  generationRef: { current: number },
  generation: number,
  signal: AbortSignal,
): boolean {
  return active && generationRef.current === generation && !signal.aborted;
}

const unavailableViewer: ViewerContext = {
  cacheViewerId: null,
  mode: "unavailable",
  user: null,
};

function shouldPreserveViewerIdentity(
  previousViewer: ViewerContext,
  nextViewer: ViewerContext,
): boolean {
  return (
    previousViewer.user?.id === nextViewer.user?.id &&
    previousViewer.mode === nextViewer.mode &&
    previousViewer.cacheViewerId === nextViewer.cacheViewerId
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const [viewer, setViewer] = useState<ViewerContext>(unavailableViewer);
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    access: false,
    mock: true,
  });
  const [loading, setLoading] = useState(true);
  const [identityWarning, setIdentityWarning] = useState<string | null>(null);
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  const [headerEnd, setHeaderEnd] = useState<ReactNode>(null);
  const [headerFolder, setHeaderFolder] = useState<string | null>(null);
  const viewerRef = useRef(viewer);
  const [viewing] = useState(() =>
    createViewingAccess(() => viewerRef.current),
  );
  const viewerRequestRef = useRef<{
    controller: AbortController;
    generation: number;
  } | null>(null);
  const generationRef = useRef(0);
  const editor = isEditorPath(pathname);

  useLayoutEffect(() => bindMutationAccess(viewing.getAccess), [viewing]);

  useEffect(() => {
    let active = true;
    const pendingIdentity = new Set<string>();
    let reverifyRequested = false;
    const requestViewer = (initial: boolean) => {
      if (!active || viewerRequestRef.current || pendingIdentity.size) {
        return;
      }

      const controller = new AbortController();
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const request = { controller, generation };
      viewerRequestRef.current = request;
      let requestWarning = false;
      const applyViewer = (nextViewer: ViewerContext): void => {
        const previousViewer = viewerRef.current;
        if (!shouldPreserveViewerIdentity(previousViewer, nextViewer)) {
          viewerRef.current = nextViewer;
          setViewer(nextViewer);
        }
        if (!requestWarning) {
          setIdentityWarning(null);
        }
        if (initial) {
          setLoading(false);
        }
      };

      void resolveViewerContext({
        onWarning: (message) => {
          if (
            isCurrentViewerRequest(
              active,
              generationRef,
              generation,
              controller.signal,
            )
          ) {
            requestWarning = true;
            setIdentityWarning(message);
          }
        },
        previousViewer: viewerRef.current,
        signal: controller.signal,
      })
        .then((nextViewer) => {
          if (
            !isCurrentViewerRequest(
              active,
              generationRef,
              generation,
              controller.signal,
            )
          ) {
            return;
          }
          applyViewer(nextViewer);
        })
        .catch((error: unknown) => {
          if (!active || controller.signal.aborted) {
            return;
          }
          if (generationRef.current === generation) {
            const nextViewer = unavailableViewer;
            viewerRef.current = nextViewer;
            setViewer(nextViewer);
            setLoading(false);
            setIdentityWarning(
              "本人確認またはキャッシュ削除を完了できませんでした。ローカルキャッシュの利用を停止しています。",
            );
          }
          console.error("Failed to resolve viewer context", error);
        })
        .finally(() => {
          if (viewerRequestRef.current === request) {
            viewerRequestRef.current = null;
          }
          if (
            active &&
            reverifyRequested &&
            !viewerRequestRef.current &&
            !pendingIdentity.size
          ) {
            reverifyRequested = false;
            requestViewer(false);
          }
        });
    };

    const retryCachedViewer = () => requestViewer(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        retryCachedViewer();
      }
    };

    window.addEventListener("online", retryCachedViewer);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const unsubscribe = subscribeIdentityLifecycle(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: lifecycle transitions intentionally guard stale requests and peer messages together.
      (event, peer) => {
        if (event.phase === "begin") {
          const current = viewerRef.current;
          if (
            current.user?.id !== event.userId &&
            current.cacheViewerId !== event.userId &&
            !(
              peer &&
              viewerRequestRef.current &&
              current.mode === "unavailable"
            )
          ) {
            return;
          }
          if (peer || event.reason === "logout") {
            pendingIdentity.add(event.id);
            generationRef.current += 1;
            viewerRequestRef.current?.controller.abort();
            viewerRequestRef.current = null;
          }
          viewerRef.current = unavailableViewer;
          setViewer(unavailableViewer);
          setHeaderActions(null);
          setHeaderEnd(null);
          setHeaderFolder(null);
          setLoading(false);
        } else if (event.phase === "failed") {
          if (pendingIdentity.has(event.id) || !peer) {
            setIdentityWarning(
              "ログアウトまたはキャッシュ削除を完了できませんでした。ローカルキャッシュの利用を停止しています。",
            );
          }
        } else if (pendingIdentity.delete(event.id) && peer) {
          requestViewer(false);
        }
      },
    );
    const unsubscribeApiIdentity = subscribeApiIdentityChange((error) => {
      // A mismatched API response is never allowed to promote its header to an
      // authenticated viewer. Reverify through /api/me instead. Defer while a
      // lifecycle transition or viewer request is already in flight so the
      // observer cannot abort the request that reported the mismatch.
      const current = viewerRef.current;
      const appliesToCurrent =
        error.expectedViewerId === null
          ? current.user === null
          : current.user?.id === error.expectedViewerId ||
            current.cacheViewerId === error.expectedViewerId;
      if (appliesToCurrent) {
        generationRef.current += 1;
        viewerRef.current = unavailableViewer;
        setViewer(unavailableViewer);
        setHeaderActions(null);
        setHeaderEnd(null);
        setHeaderFolder(null);
        setLoading(false);
      }
      reverifyRequested = true;
      if (!(viewerRequestRef.current || pendingIdentity.size)) {
        reverifyRequested = false;
        requestViewer(false);
      }
    });
    requestViewer(true);

    return () => {
      active = false;
      unsubscribe();
      unsubscribeApiIdentity();
      window.removeEventListener("online", retryCachedViewer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const request = viewerRequestRef.current;
      request?.controller.abort();
      if (request) {
        viewerRequestRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const coordinator = attachMyDrivePrefetchCoordinator(viewer);
    return () => coordinator.dispose();
  }, [viewer]);

  useEffect(() => {
    let active = true;
    void fetchAuthConfig()
      .then((config) => {
        if (active) {
          setAuthConfig(config);
        }
      })
      .catch(() => {
        // Keep the existing mock-friendly default when optional config is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  const setUser = useCallback((nextUser: SessionUser | null) => {
    const request = viewerRequestRef.current;
    generationRef.current += 1;
    request?.controller.abort();
    viewerRequestRef.current = null;

    const previousViewer = viewerRef.current;
    const nextViewer: ViewerContext = nextUser
      ? {
          cacheViewerId:
            previousViewer.user?.id === nextUser.id
              ? previousViewer.cacheViewerId
              : null,
          mode: "authenticated",
          user: nextUser,
        }
      : unavailableViewer;
    viewerRef.current = nextViewer;
    setViewer(nextViewer);
    setLoading(false);
  }, []);

  const setHeader = useCallback(
    (next: Parameters<AppShellContext["setHeader"]>[0]) => {
      setHeaderActions(next?.actions ?? null);
      setHeaderEnd(next?.end ?? null);
      setHeaderFolder(next?.folder ?? null);
    },
    [],
  );

  const context: AppShellContext = {
    setHeader,
    setUser,
    user: viewer.user,
    userLoading: loading,
    viewer,
    viewing,
  };

  return (
    <div
      className={cn(
        "flex flex-col",
        editor ? "h-full min-h-0" : "min-h-[var(--app-height,100dvh)]",
      )}
      data-layout={editor ? "editor" : "page"}
    >
      <AppHeader
        actions={headerActions}
        authConfig={authConfig}
        end={headerEnd}
        folder={headerFolder}
        loading={loading}
        user={viewer.user}
      />
      <main
        className={
          editor
            ? "flex min-h-0 w-full flex-1 flex-col pt-[var(--header-height)]"
            : "mx-auto w-full max-w-[1400px] flex-1 p-5 pt-[calc(var(--header-height)+1.25rem)] max-[640px]:px-3"
        }
      >
        {identityWarning && <p role="alert">{identityWarning}</p>}
        <Outlet
          context={context}
          key={viewer.user?.id ?? viewer.cacheViewerId ?? "unavailable"}
        />
      </main>
    </div>
  );
}
