import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

async function verifyCachedNoteView(
  page: Page,
  failure: "offline" | "note-server-error",
) {
  await page.clock.setFixedTime(new Date("2024-01-02T03:04:05Z"));
  const displayedNote = {
    ...note,
    markdown: `${note.markdown}\n\n- [ ] オフラインでは変更しないタスク\n`,
  };
  let apiUnavailable = false;
  const mutations: string[] = [];
  const collaborationConnections: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/ws/notes/")) {
      collaborationConnections.push(socket.url());
    }
  });
  // Viewing an editable note warms a collaboration session in preview; keep
  // the handshake open without a sync reply so the synced marker is never
  // set and the cached note stays read-only.
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    socket.onMessage(() => {
      // Keep the handshake open without a sync reply.
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) {
      mutations.push(`${request.method()} ${path}`);
    }
    if (apiUnavailable && failure === "offline") {
      await route.abort("internetdisconnected");
      return;
    }
    if (apiUnavailable && path === `/api/notes/${displayedNote.id}`) {
      await route.fulfill({
        headers: { "X-MiyulabMD-Session-User": "user:alice" },
        json: { error: "Unavailable" },
        status: 503,
      });
      return;
    }
    switch (path) {
      case "/api/me":
        await route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
        return;
      case "/api/auth/config":
        await route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { access: false, mock: true },
        });
        return;
      case `/api/notes/${displayedNote.id}`:
        await route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: displayedNote,
        });
        return;
      case "/api/article-sources":
        await route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { sources: [] },
        });
        return;
      default:
        await route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { error: "No test fixture for this API" },
          status: 404,
        });
    }
  });

  await page.goto(`/n/${displayedNote.id}`);
  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
  // オンラインではオフラインアイコンは出ない。
  await expect(page.getByRole("button", { name: "オフライン" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toBeEnabled();

  // Wait for successful caching through its public API, without depending on
  // database names, object stores, OPFS paths, or background write timing.
  await expect
    .poll(() =>
      page.evaluate(
        async ({ moduleUrl, id }) => {
          const { openOfflineCache } = await import(moduleUrl);
          const cache = await openOfflineCache({ userId: "alice" });
          try {
            return (await cache.getNote(id))?.note ?? null;
          } finally {
            cache.close();
          }
        },
        {
          id: displayedNote.id,
          moduleUrl: "/src/lib/offline-cache.ts",
        },
      ),
    )
    .toEqual(displayedNote);

  // Keep the Vite-served shell available to isolate data-layer recovery.
  // Full offline navigation through the service worker is a separate test.
  apiUnavailable = true;
  // The online warmup session legitimately opened a socket; only the offline
  // phase must not start collaboration.
  collaborationConnections.length = 0;
  await page.clock.setFixedTime(new Date("2025-06-07T08:09:10Z"));
  await page.reload();

  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
  if (failure === "offline") {
    // オフラインアイコンがロゴ右に出て、タップで最終同期時刻を表示する。
    const offlineButton = page.getByRole("button", { name: "オフライン" });
    await expect(offlineButton).toBeVisible();
    await offlineButton.click();
    await expect(page.getByText(/最終同期 2024/)).toBeVisible();
  }
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toBeDisabled();

  // Hidden UI is not sufficient: every mutation must be stopped at dispatch.
  const blocked = await page.evaluate(
    async ({ moduleUrl, noteId }) => {
      const api = await import(moduleUrl);
      const operations = [
        () => api.updateNote(noteId, { folder: "moved" }),
        () => api.updateNote(noteId, { permission: "freely" }),
        () => api.createNote({ markdown: "# New note" }),
        () => api.deleteNote(noteId),
        () => api.renameFolder("folder-1", "Renamed"),
        () =>
          api.updateFolderAccess({ folderId: "folder-1", readScope: "self" }),
        () => api.restoreNoteRevision(noteId, "revision-1"),
        () =>
          api.uploadImage(
            noteId,
            new File(["test"], "image.png", { type: "image/png" }),
          ),
      ];
      return Promise.all(
        operations.map(async (operation) => {
          try {
            await operation();
            return "not-blocked";
          } catch (error) {
            return error instanceof Error ? error.name : "UnknownError";
          }
        }),
      );
    },
    { moduleUrl: "/src/lib/api.ts", noteId: displayedNote.id },
  );
  expect(blocked).toEqual(new Array(8).fill("ReadOnlyViewingError"));
  expect(mutations).toEqual([]);
  expect(collaborationConnections).toEqual([]);
}

test("the note view restores a private cached note read-only when APIs are unreachable", async ({
  page,
}) => {
  await verifyCachedNoteView(page, "offline");
});

test("an authenticated viewer still gets read-only cached content when only the note API fails", async ({
  page,
}) => {
  await verifyCachedNoteView(page, "note-server-error");
});
