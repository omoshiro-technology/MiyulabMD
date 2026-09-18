import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import * as Y from "yjs";
import { note } from "./fixtures/note.ts";

// Disconnect changes transport availability, not the server session actor.
const headers = { "X-MiyulabMD-Session-User": "user:alice" };

// A real y-websocket sync-step-2 frame. Client updates are intentionally not
// acknowledged/stored: the entered text below is an unsent in-memory buffer.
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

async function checkDisconnect(page: Page, mode: "source" | "rich" | "split") {
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${path}`);
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
  await page.addInitScript((editMode) => {
    localStorage.setItem("miyulabmd:editor-edit-mode", editMode);
  }, mode);
  const serverDoc = new Y.Doc();
  serverDoc.getText("markdown").insert(0, note.markdown);
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    sockets.push(socket);
    let initialized = false;
    socket.onMessage(() => {
      if (sockets.length === 1 && !initialized) {
        initialized = true;
        socket.send(syncFrame(serverDoc));
      }
    });
  });
  try {
    await page.goto(`/n/${note.id}`);
    await page.getByRole("button", { exact: true, name: "Edit" }).click();
    const editor = page.locator(mode === "rich" ? ".tiptap" : ".cm-content");
    await expect(editor).toContainText("通信なしでも読みたい本文。");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(" entered buffer");
    await expect(editor).toContainText("entered buffer");
    const originalEditor = await editor.elementHandle();
    const selection = await page.evaluate(() => {
      const value = window.getSelection();
      return [value?.anchorOffset, value?.focusOffset];
    });

    await sockets[0].close();
    const paused = page
      .getByRole("status")
      .filter({ hasText: "共同編集の接続" });
    await expect(paused).toContainText("再同期");
    expect(
      await originalEditor?.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(
      await page.evaluate(() => {
        const value = window.getSelection();
        return [value?.anchorOffset, value?.focusOffset];
      }),
    ).toEqual(selection);
    await expect(editor).toBeFocused();
    await page.keyboard.insertText(" MUST NOT ENTER");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor).toContainText("entered buffer");
    await expect(editor).not.toContainText("MUST NOT ENTER");
    expect(
      await page.evaluate(() => {
        const value = window.getSelection();
        return [value?.anchorOffset, value?.focusOffset];
      }),
    ).toEqual(selection);
    for (const name of ["Edit", "フォルダ", "共有", "履歴"]) {
      await expect(page.getByRole("button", { exact: true, name })).toHaveCount(
        0,
      );
    }
    expect(writes).toEqual([]);

    // A browser online hint and an open WebSocket are not a completed sync.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => sockets.length).toBe(2);
    await expect(paused).toBeVisible();
    await page.keyboard.insertText(" STILL BLOCKED");
    await expect(editor).not.toContainText("STILL BLOCKED");
    sockets[1].send(syncFrame(serverDoc));
    await expect(paused).toHaveCount(0);
    expect(
      await originalEditor?.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(
      await page.evaluate(() => {
        const value = window.getSelection();
        return [value?.anchorOffset, value?.focusOffset];
      }),
    ).toEqual(selection);
    await page.keyboard.insertText(" resumed");
    await expect(editor).toContainText("entered buffer resumed");
    await expect(
      page.getByRole("button", { exact: true, name: "フォルダ" }),
    ).toBeVisible();
    expect(writes).toEqual([]);

    // An already-open mutation dialog follows the same lifecycle boundary.
    await page.getByRole("button", { exact: true, name: "共有" }).click();
    const inherit = page.getByRole("checkbox", {
      name: "ディレクトリの設定に従う",
    });
    await expect(inherit).toBeEnabled();
    await sockets[1].close();
    await expect(paused).toBeVisible();
    await expect(inherit).toBeDisabled();
    const scopes = page.getByRole("dialog").getByRole("combobox");
    await expect(scopes).toHaveCount(2);
    for (const scope of await scopes.all()) {
      await expect(scope).toBeDisabled();
    }
    await expect(
      page.getByLabel("共有するユーザーのメールアドレス"),
    ).toBeDisabled();
    expect(writes).toEqual([]);
  } finally {
    serverDoc.destroy();
  }
}

for (const mode of ["source", "rich", "split"] as const) {
  test(`a synced ${mode} editor retains its buffer and selection across disconnect until a new sync`, async ({
    page,
  }) => {
    await checkDisconnect(page, mode);
  });
}

async function openRichSession(page: Page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
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
    }
    if (path === "/api/auth/config") {
      return route.fulfill({ headers, json: { access: false, mock: true } });
    }
    if (path === "/api/article-sources") {
      return route.fulfill({ headers, json: { sources: [] } });
    }
    if (path === `/api/notes/${note.id}`) {
      return route.fulfill({ headers, json: note });
    }
    return route.fulfill({
      headers,
      json: { error: "No fixture" },
      status: 404,
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:editor-edit-mode", "rich");
  });
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, note.markdown);
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    sockets.push(socket);
    let initialized = false;
    socket.onMessage(() => {
      if (sockets.length === 1 && !initialized) {
        initialized = true;
        socket.send(syncFrame(doc));
      }
    });
  });
  await page.goto(`/n/${note.id}`);
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(page.locator(".tiptap")).toContainText(
    "通信なしでも読みたい本文。",
  );
  return { doc, sockets };
}

test("rich IME buffer entered before disconnect survives a changed remote sync", async ({
  page,
}) => {
  const { doc, sockets } = await openRichSession(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await cdp.send("Input.imeSetComposition", {
      selectionEnd: 3,
      selectionStart: 3,
      text: "入力中",
    });
    await expect(editor).toContainText("入力中");
    const original = await editor.elementHandle();
    const selection = await page.evaluate(() => {
      const value = window.getSelection();
      return [value?.anchorOffset, value?.focusOffset];
    });
    await sockets[0].close();
    const paused = page
      .getByRole("status")
      .filter({ hasText: "共同編集の接続" });
    await expect(paused).toBeVisible();
    await expect(editor).toBeFocused();
    expect(
      await page.evaluate(() => {
        const value = window.getSelection();
        return [value?.anchorOffset, value?.focusOffset];
      }),
    ).toEqual(selection);
    await page.keyboard.insertText(" OFFLINE INPUT");
    await expect(editor).not.toContainText("OFFLINE INPUT");
    // Blur finishes the actual Chromium composition after editability changed.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    doc.getText("markdown").insert(0, "---\ntitle: Remote change\n---\n\n");
    await expect.poll(() => sockets.length).toBe(2);
    sockets[1].send(syncFrame(doc));
    await expect(paused).toHaveCount(0);
    await expect(editor).toContainText("入力中");
    expect(await original?.evaluate((element) => element.isConnected)).toBe(
      true,
    );
  } finally {
    await cdp.detach();
    doc.destroy();
  }
});

async function checkShareCompletion(page: Page, success: boolean) {
  const { doc, sockets } = await openRichSession(page);
  let writes = 0;
  let resolveRequest: (() => void) | undefined;
  const response = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  await page.route(`**/api/notes/${note.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      return route.fallback();
    }
    writes++;
    await response;
    await route.fulfill({
      headers,
      // A successful canonical response can differ from the optimistic draft.
      json: success ? note : { error: "Deferred share failure" },
      status: success ? 200 : 500,
    });
  });
  try {
    await page.getByRole("button", { exact: true, name: "共有" }).click();
    const inherit = page.getByRole("checkbox", {
      name: "ディレクトリの設定に従う",
    });
    await expect(inherit).toBeChecked();
    await inherit.uncheck();
    await expect.poll(() => writes).toBe(1);
    await sockets[0].close();
    await expect(inherit).toBeDisabled();
    resolveRequest?.();
    if (!success) {
      await expect(
        page.getByRole("dialog").getByText("Deferred share failure"),
      ).toBeVisible();
    }
    await expect(inherit).toBeChecked();
    await expect.poll(() => sockets.length).toBe(2);
    sockets[1].send(syncFrame(doc));
    await expect(inherit).toBeEnabled();
    await expect(inherit).toBeChecked();
    expect(writes).toBe(1);
  } finally {
    resolveRequest?.();
    doc.destroy();
  }
}

for (const success of [false, true]) {
  test(`share ${success ? "success" : "failure"} issued while synced reconciles during disconnect without retry`, async ({
    page,
  }) => {
    await checkShareCompletion(page, success);
  });
}
