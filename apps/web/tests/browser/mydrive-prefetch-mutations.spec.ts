import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("only successful drive mutations refresh the background cache", async ({
  page,
}) => {
  const rootId = "alice-root";
  const user = {
    displayName: "Alice",
    email: "alice@example.test",
    id: "alice",
  };
  let currentNote = { ...note, folderId: rootId, title: "更新通知の資料" };
  let allowWrite = false;
  let cycles = 0;
  let bodies = 0;
  const root = {
    ...note.access,
    children: [],
    crumbs: [],
    folder: "",
    id: rootId,
    locked: true,
    name: "マイドライブ",
    parentId: null,
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case "/api/me":
        return route.fulfill({ headers, json: { user } });
      case "/api/auth/config":
        return route.fulfill({ headers, json: { access: false, mock: true } });
      case "/api/folders/tree":
        cycles += 1;
        return route.fulfill({
          headers,
          json: {
            folders: [
              { folder: "", id: rootId, name: root.name, parentId: null },
            ],
          },
        });
      case "/api/folders":
      case `/api/folders/${rootId}`:
        return route.fulfill({ headers, json: root });
      case "/api/notes": {
        const { markdown: _markdown, ...summary } = currentNote;
        return route.fulfill({ headers, json: { notes: [summary] } });
      }
      case `/api/notes/${note.id}`:
        if (route.request().method() === "PATCH") {
          if (!allowWrite) {
            return route.fulfill({
              headers,
              json: { error: "Write failed" },
              status: 500,
            });
          }
          const patch = route.request().postDataJSON() as { markdown: string };
          currentNote = {
            ...currentNote,
            markdown: patch.markdown,
            updatedAt: currentNote.updatedAt + 1,
          };
        } else {
          bodies += 1;
        }
        return route.fulfill({ headers, json: currentNote });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: currentNote.title }),
  ).toBeVisible();
  const readBody = () =>
    page.evaluate(async (noteId) => {
      const storageUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(storageUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getNote(noteId))?.note.markdown ?? null;
      } finally {
        cache.close();
      }
    }, note.id);
  await expect.poll(readBody).toBe(currentNote.markdown);
  const ignored = await page.evaluate(async (noteId) => {
    const apiUrl = "/src/lib/api-fetch.ts";
    const coordinatorUrl = "/src/lib/mydrive-prefetch-coordinator.ts";
    const { apiFetch } = await import(apiUrl);
    const { PREFETCH_DEBOUNCE_MS, PREFETCH_MIN_INTERVAL_MS } = await import(
      coordinatorUrl
    );
    const read = await apiFetch("/api/notes");
    const failed = await apiFetch(`/api/notes/${noteId}`, {
      body: JSON.stringify({ markdown: "失敗する変更" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const unrelated = await apiFetch("/api/me", { method: "PATCH" });
    return {
      statuses: [read.status, failed.status, unrelated.status],
      wait: PREFETCH_DEBOUNCE_MS + PREFETCH_MIN_INTERVAL_MS + 100,
    };
  }, note.id);
  expect(ignored.statuses).toEqual([200, 500, 200]);
  await page.waitForTimeout(ignored.wait);
  expect(cycles).toBe(1);
  expect(bodies).toBe(1);

  allowWrite = true;
  const saved = await page.evaluate(async (noteId) => {
    const apiUrl = "/src/lib/api-fetch.ts";
    const { apiFetch } = await import(apiUrl);
    // Use the common API entry point and a real Request, not a direct call to
    // the coordinator or a hand-written cache update.
    const response = await apiFetch(
      new Request(new URL(`/api/notes/${noteId}`, window.location.href), {
        body: JSON.stringify({ markdown: "更新成功後に再取得した本文。" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      }),
    );
    return { data: await response.json(), status: response.status };
  }, note.id);
  expect(saved.status).toBe(200);
  expect(saved.data.markdown).toBe(currentNote.markdown);
  await expect.poll(readBody, { timeout: 10_000 }).toBe(currentNote.markdown);
  expect(cycles).toBe(2);
  expect(bodies).toBe(2);
});
