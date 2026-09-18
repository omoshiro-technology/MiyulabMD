import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("API mutation dispatch follows AppShell's actual viewing access without blocking reads", async ({
  page,
}) => {
  const writes: string[] = [];
  let logouts = 0;
  let offlineViewer = false;
  const user = {
    displayName: "Alice",
    email: "alice@example.test",
    id: "alice",
  };
  const headers = { "X-MiyulabMD-Session-User": "user:alice" };
  await page.route("**/auth/logout", (route) => {
    logouts += 1;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ headers, json: note });
    }
    switch (path) {
      case "/api/me":
        return offlineViewer
          ? route.abort("internetdisconnected")
          : route.fulfill({ headers, json: { user } });
      case "/api/auth/config":
        return route.fulfill({ headers, json: { access: false, mock: true } });
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [] } });
      case `/api/notes/${note.id}`:
        return route.fulfill({ headers, json: note });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.goto("/tests/browser/fixtures/app-shell.html");
  const state = async () =>
    JSON.parse((await page.getByLabel("Viewer context").textContent()) ?? "{}");
  await expect.poll(state).toMatchObject({
    hasViewing: true,
    userLoading: false,
    viewer: { mode: "authenticated", user },
  });
  const update = () =>
    page.evaluate(async (id) => {
      const moduleUrl = "/src/lib/api.ts";
      const { updateNote } = await import(moduleUrl);
      try {
        return (await updateNote(id, { title: "Updated" })).ok;
      } catch (error) {
        return error instanceof Error ? error.name : "UnknownError";
      }
    }, note.id);
  expect(await update()).toBe(true);
  expect(writes).toHaveLength(1);

  await page.getByRole("button", { name: "Use cached viewing" }).click();
  const blocked = await page.evaluate(async (id) => {
    const moduleUrl = "/src/lib/api.ts";
    const api = await import(moduleUrl);
    const operations = [
      () => api.updateNote(id, { folder: "moved" }),
      () => api.updateNote(id, { permission: "freely" }),
      () => api.createNote({ markdown: "# New note" }),
      () => api.deleteNote(id),
      () => api.renameFolder("folder-1", "Renamed"),
      () => api.updateFolderAccess({ folderId: "folder-1", readScope: "self" }),
      () => api.restoreNoteRevision(id, "revision-1"),
      () =>
        api.uploadImage(
          id,
          new File(["test"], "image.png", { type: "image/png" }),
        ),
      () =>
        api.updateTaskCheckbox(id, {
          checked: true,
          contextHash: "test",
          line: 0,
        }),
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
  }, note.id);
  expect(blocked).toEqual(new Array(9).fill("ReadOnlyViewingError"));
  expect(writes).toHaveLength(1);
  const reads = await page.evaluate(async (id) => {
    const moduleUrl = "/src/lib/api.ts";
    const api = await import(moduleUrl);
    await api.logout();
    return {
      list: await api.fetchNotes(),
      note: (await api.fetchNote(id)).ok,
    };
  }, note.id);
  expect(reads).toEqual({ list: [], note: true });
  expect(logouts).toBe(1);

  await page.getByRole("button", { name: "Use network viewing" }).click();
  expect(await update()).toBe(true);
  expect(writes).toHaveLength(2);
  offlineViewer = true;
  await page.reload();
  await expect.poll(state).toMatchObject({
    hasViewing: true,
    userLoading: false,
    viewer: { cacheViewerId: "alice", mode: "cached", user: null },
  });
  expect(await update()).toBe("ReadOnlyViewingError");
  await page.evaluate(async () => {
    const moduleUrl = "/src/lib/api.ts";
    const api = await import(moduleUrl);
    await api.logout();
  });
  expect(logouts).toBe(2);
  expect(writes).toHaveLength(2);
});
