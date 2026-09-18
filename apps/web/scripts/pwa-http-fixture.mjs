import { readFile } from "node:fs/promises";
import path from "node:path";

async function serveFixture(request, response, server, webRoot, state) {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  if (
    request.method === "POST" &&
    /^\/__pwa_version\/[012]$/.test(url.pathname)
  ) {
    state.version = Number(url.pathname.at(-1));
    response.statusCode = 204;
    response.end();
    return true;
  }
  if (request.method !== "GET") {
    return false;
  }
  switch (url.pathname) {
    case "/sw.js": {
      const worker = await readFile(
        state.version === 0
          ? new URL("../tests/pwa/fixtures/legacy-sw.js", import.meta.url)
          : path.join(webRoot, "dist/sw.js"),
        "utf8",
      );
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      // Test-only byte change and observer; the candidate's fetch/lifecycle
      // implementation is unchanged between the two deployed variants.
      response.end(`${worker}
self.addEventListener("message", (event) => {
  if (event.data === "pwa-fixture-version") {
    event.ports[0]?.postMessage(${state.version});
    event.ports[0]?.close();
  }
});`);
      return true;
    }
    case "/__pwa_seed":
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        "<!doctype html><title>PWA storage fixture</title><p>Ready</p>",
      );
      return true;
    case "/n/pwa-foreign-fixture":
      response.statusCode = 503;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end("<!doctype html><h1>PWA_FOREIGN_FAILURE</h1>");
      return true;
    case "/n/pwa-redirect-fixture": {
      const address = server.httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Preview address unavailable");
      }
      response.statusCode = 302;
      response.setHeader(
        "Location",
        `http://localhost:${address.port}/n/pwa-foreign-fixture`,
      );
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return true;
    }
    case "/s/pwa-ssr-fixture":
    case "/n/pwa-ssr-fixture": {
      const shell = await readFile(
        path.join(webRoot, "dist/index.html"),
        "utf8",
      );
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-PWA-SSR-Fixture", "1");
      response.end(
        shell.replace(
          "</body>",
          '<div id="ssr-preview" data-note-id="pwa-ssr-fixture">PWA_PRIVATE_SSR_SENTINEL</div></body>',
        ),
      );
      return true;
    }
    default:
      return false;
  }
}

// Test-only HTTP behavior layered in front of production-preview assets.
// This plugin is not part of the app's Vite configuration or deployed Worker.
export function pwaHttpFixture(webRoot) {
  const state = { version: 1 };
  return {
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        void serveFixture(request, response, server, webRoot, state).then(
          (handled) => {
            if (!handled) {
              next();
            }
          },
          next,
        );
      });
    },
    name: "pwa-http-fixture",
  };
}
