import { cacheNames, setCacheNameDetails } from "workbox-core";
import {
  matchPrecache,
  type PrecacheEntry,
  precacheAndRoute,
} from "workbox-precaching";
import { registerRoute } from "workbox-routing";

declare global {
  // Interface merging augments Workbox's worker manifest declaration.
  // biome-ignore lint/style/useConsistentTypeDefinitions: declaration merging required
  interface WorkerGlobalScope {
    __WB_MANIFEST: Array<string | PrecacheEntry>;
  }
}

setCacheNameDetails({ prefix: "miyulabmd" });

const appPrecachePrefix = "miyulabmd-precache-";
const serviceWorkerScope = self as unknown as ServiceWorkerGlobalScope;

// Remove only superseded precaches owned by this app and registration scope.
// The active Workbox cache is explicitly retained for clients during updates.
serviceWorkerScope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(appPrecachePrefix) &&
                name.endsWith(serviceWorkerScope.registration.scope) &&
                name !== cacheNames.precache,
            )
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

const isShellNavigation = (pathname: string) =>
  pathname === "/" ||
  /^\/f\/[^/]+\/?$/.test(pathname) ||
  /^\/(?:n|s)\/[^/]+\/?$/.test(pathname);

const shellFallback = async (): Promise<Response> =>
  (await matchPrecache("/index.html")) ?? Response.error();

// Keep document navigations online-first. In particular, this avoids storing
// SSR note HTML, auth redirects, or API-derived bootstrap data in a shell
// cache. A network error (or temporary 5xx) can use the pure precached shell.
registerRoute(
  ({ request, url, sameOrigin }) =>
    request.method === "GET" &&
    request.mode === "navigate" &&
    sameOrigin &&
    isShellNavigation(url.pathname),
  async ({ request }) => {
    try {
      const response = await fetch(request);
      return response.status >= 500 ? shellFallback() : response;
    } catch {
      return shellFallback();
    }
  },
);

// This is intentionally the only cache population performed by this worker:
// generated app assets, the pure index shell, and the local manifest/icon.
precacheAndRoute(self.__WB_MANIFEST);
