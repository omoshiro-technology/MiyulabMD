import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import * as Y from "yjs";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

// A real y-websocket sync-step-2 frame (same shape as editor-disconnect.spec).
function syncFrame(doc: Y.Doc): Buffer {
  const update = Y.encodeStateAsUpdate(doc);
  const length: number[] = [];
  let remaining = update.length;
  while (remaining > 127) {
    length.push((remaining & 127) | 128);
    remaining >>>= 7;
  }
  length.push(remaining);
  return Buffer.from([0, 1, ...length, ...update]);
}

// Apply sync-step-2/update payloads the client flushed after sync, without
// depending on y-protocols in the test workspace.
function applyClientMessage(doc: Y.Doc, raw: string | Buffer) {
  if (typeof raw === "string") {
    return;
  }
  const message = new Uint8Array(raw);
  // messageSync = 0, then syncStep2 = 1 / update = 2.
  if (message[0] !== 0 || (message[1] !== 1 && message[1] !== 2)) {
    return;
  }
  let pos = 2;
  let length = 0;
  let shift = 0;
  for (;;) {
    const byte = message[pos++];
    length |= (byte & 127) << shift;
    if ((byte & 128) === 0) {
      break;
    }
    shift += 7;
  }
  Y.applyUpdate(doc, message.subarray(pos, pos + length));
}

function editCacheUpdateCount(page: Page) {
  return page.evaluate(async () => {
    const name = "miyulabmd-edit:alice:note-1";
    const listed = await indexedDB.databases();
    if (!listed.some((db) => db.name === name)) {
      return 0;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve) => {
      const read = db.transaction("updates").objectStore("updates").count();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => resolve(0);
    });
    db.close();
    return count;
  });
}

async function mockApis(
  page: Page,
  served: () => boolean,
  mutations: string[],
) {
  await page.route("**/api/**", (route) => {
    const request = route.request();
    if (!served()) {
      return route.abort("internetdisconnected");
    }
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ headers, json: note });
    }
    switch (path) {
      case "/api/me":
        return route.fulfill({
          headers,
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ headers, json: { access: false, mock: true } });
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
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
}

test("a synced self-owned note edits its local document offline and merges after reconnect", async ({
  page,
}) => {
  let apiAvailable = true;
  let syncReplies = true;
  const mutations: string[] = [];
  await mockApis(page, () => apiAvailable, mutations);
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:editor-edit-mode", "source");
  });

  const serverDoc = new Y.Doc();
  serverDoc.getText("markdown").insert(0, note.markdown);
  const sockets: WebSocketRoute[] = [];
  const clientMessages = new Map<WebSocketRoute, (string | Buffer)[]>();
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    sockets.push(socket);
    clientMessages.set(socket, []);
    socket.onMessage((message) => {
      clientMessages.get(socket)?.push(message);
      // While the "server" is up, answer the first sync request.
      if (syncReplies && clientMessages.get(socket)?.length === 1) {
        socket.send(syncFrame(serverDoc));
      }
    });
  });

  try {
    // Online: just viewing the note warms the edit cache — the warmup session
    // syncs the server document into y-indexeddb without entering edit mode.
    await page.goto(`/n/${note.id}`);
    await expect(
      page.getByText("通信なしでも読みたい本文。", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("miyulabmd:yjs-synced:alice:note-1"),
        ),
      )
      .toBe("1");
    await expect.poll(() => editCacheUpdateCount(page)).toBeGreaterThan(0);

    // Offline: the cached view must still allow editing the local Y.Doc.
    apiAvailable = false;
    syncReplies = false;
    await page.reload();

    await expect(
      page.getByText("通信なしでも読みたい本文。", { exact: true }),
    ).toBeVisible();
    // オフライン状態はヘッダーのアイコンが示し、タップで最終同期時刻を表示する。
    const offlineButton = page.getByRole("button", { name: "オフライン" });
    await expect(offlineButton).toBeVisible();
    await offlineButton.click();
    await expect(page.getByText(/最終同期/)).toBeVisible();
    await page.getByRole("button", { exact: true, name: "Edit" }).click();
    // The edit mode is carried by the URL (?mode=edit) so a reload or a
    // viewer switch keeps the session instead of falling back to preview.
    await expect(page).toHaveURL(/[?&]mode=edit/);

    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("通信なしでも読みたい本文。");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\noffline draft");
    await expect(editor).toContainText("offline draft");
    await expect(
      page.getByRole("status").filter({ hasText: "未送信の編集" }),
    ).toBeVisible();
    expect(mutations).toEqual([]);

    // Non-body REST mutations stay behind the read-only gate while offline.
    const blocked = await page.evaluate(async () => {
      const api = await import("/src/lib/api.ts");
      try {
        await api.updateNote("note-1", { folder: "moved" });
        return "not-blocked";
      } catch (error) {
        return error instanceof Error ? error.name : "UnknownError";
      }
    });
    expect(blocked).toBe("ReadOnlyViewingError");
    expect(mutations).toEqual([]);

    // ?mode=edit persists across reloads: the editor remounts straight into
    // the locally persisted document without another mode switch.
    await page.reload();
    await expect(page.locator(".cm-content")).toContainText("offline draft");

    // Reconnect: once sync completes the pending update reaches the server
    // document and the unsent marker clears.
    syncReplies = true;
    const latest = () => sockets.at(-1);
    await expect.poll(() => latest()).toBeTruthy();
    latest().send(syncFrame(serverDoc));
    await expect(
      page.getByRole("status").filter({ hasText: "未送信の編集" }),
    ).toHaveCount(0);
    await expect
      .poll(() => (clientMessages.get(latest()) ?? []).length)
      .toBeGreaterThan(1);
    for (const message of clientMessages.get(latest()) ?? []) {
      applyClientMessage(serverDoc, message);
    }
    expect(serverDoc.getText("markdown").toString()).toContain("offline draft");
  } finally {
    serverDoc.destroy();
  }
});

test("a synced marker without the edit cache document stays unwritable offline", async ({
  page,
}) => {
  // localStorage marker survives while y-indexeddb was evicted: entering edit
  // mode must not unlock a blank local Y.Doc, or later merges could duplicate
  // or displace the real body.
  let apiAvailable = true;
  const mutations: string[] = [];
  await mockApis(page, () => apiAvailable, mutations);
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:editor-edit-mode", "source");
  });

  const serverDoc = new Y.Doc();
  serverDoc.getText("markdown").insert(0, note.markdown);
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    socket.onMessage(() => {
      if (apiAvailable) {
        socket.send(syncFrame(serverDoc));
      }
    });
  });

  try {
    // Online: viewing the note warms the synced marker and the edit cache.
    await page.goto(`/n/${note.id}`);
    await expect(
      page.getByText("通信なしでも読みたい本文。", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("miyulabmd:yjs-synced:alice:note-1"),
        ),
      )
      .toBe("1");
    await expect.poll(() => editCacheUpdateCount(page)).toBeGreaterThan(0);

    // Offline: evict only the edit cache, keeping the marker and display cache.
    apiAvailable = false;
    await page.goto(`/n/${note.id}`);
    await expect(
      page.getByText("通信なしでも読みたい本文。", { exact: true }),
    ).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(
            "miyulabmd-edit:alice:note-1",
          );
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
        }),
    );

    // Edit mode restores an empty document: the editor must stay unwritable
    // instead of exposing a blank document for edits. Wait until the
    // persistence layer recreated the database (whenSynced already fired).
    await page.getByRole("button", { exact: true, name: "Edit" }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          indexedDB
            .databases()
            .then((dbs) =>
              dbs.some((db) => db.name === "miyulabmd-edit:alice:note-1"),
            ),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(500);
    await expect(page.getByText("共同編集に接続中…")).toBeVisible();
    await expect(page.locator(".cm-content")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "未送信の編集" }),
    ).toHaveCount(0);
    expect(mutations).toEqual([]);
  } finally {
    serverDoc.destroy();
  }
});

test("a note body cleared offline stays writable after re-entering edit mode", async ({
  page,
}) => {
  // Clearing the body offline persists delete updates, so the restored doc is
  // empty but has history. Re-entering edit mode must stay writable instead
  // of being mistaken for a lost edit cache.
  let apiAvailable = true;
  await mockApis(page, () => apiAvailable, []);
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:editor-edit-mode", "source");
  });

  const serverDoc = new Y.Doc();
  serverDoc.getText("markdown").insert(0, note.markdown);
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    socket.onMessage(() => {
      if (apiAvailable) {
        socket.send(syncFrame(serverDoc));
      }
    });
  });

  try {
    // Online: sync once so the synced marker and the edit cache both exist.
    await page.goto(`/n/${note.id}`);
    await page.getByRole("button", { exact: true, name: "Edit" }).click();
    await expect(page.locator(".cm-content")).toContainText(
      "通信なしでも読みたい本文。",
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("miyulabmd:yjs-synced:alice:note-1"),
        ),
      )
      .toBe("1");

    // Offline: ?mode=edit survives the reload, so the editor restores the
    // local document directly. Clear the whole body and persist the update.
    apiAvailable = false;
    await page.reload();
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("通信なしでも読みたい本文。");
    const updatesBeforeClear = await editCacheUpdateCount(page);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await expect(editor).not.toContainText("通信なしでも読みたい本文。");
    await expect
      .poll(() => editCacheUpdateCount(page))
      .toBeGreaterThan(updatesBeforeClear);

    // Reload again: the display cache still holds the old snapshot, but the
    // restored doc has history and must stay writable.
    await page.reload();
    await expect(editor).toBeAttached();
    await expect(editor).not.toContainText("通信なしでも読みたい本文。");
    await editor.click();
    await page.keyboard.insertText("rewritten");
    await expect(editor).toContainText("rewritten");
  } finally {
    serverDoc.destroy();
  }
});

test("a synced note that is not self-scoped stays read-only offline", async ({
  page,
}) => {
  // The synced marker alone is not enough: the cached note must also pass the
  // offline edit eligibility check (owner + effectiveWriteScope "self").
  const sharedNote = {
    ...note,
    access: { ...note.access, effectiveWriteScope: "signed_in" as const },
  };
  let apiAvailable = true;
  const mutations: string[] = [];
  const collaborationConnections: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/ws/notes/")) {
      collaborationConnections.push(socket.url());
    }
  });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    if (!apiAvailable) {
      return route.abort("internetdisconnected");
    }
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ headers, json: sharedNote });
    }
    switch (path) {
      case "/api/me":
        return route.fulfill({
          headers,
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ headers, json: { access: false, mock: true } });
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
      case `/api/notes/${sharedNote.id}`:
        return route.fulfill({ headers, json: sharedNote });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:yjs-synced:alice:note-1", "1");
    localStorage.setItem("miyulabmd:editor-edit-mode", "source");
  });

  // Seed the display cache, then go offline.
  await page.goto(`/n/${sharedNote.id}`);
  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
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
        { id: sharedNote.id, moduleUrl: "/src/lib/offline-cache.ts" },
      ),
    )
    .not.toBeNull();

  apiAvailable = false;
  await page.reload();

  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
  // オフラインアイコンがロゴ右に出て、タップで最終同期時刻を表示する。
  const offlineButton = page.getByRole("button", { name: "オフライン" });
  await expect(offlineButton).toBeVisible();
  await offlineButton.click();
  await expect(page.getByText(/最終同期/)).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(collaborationConnections).toEqual([]);
});
