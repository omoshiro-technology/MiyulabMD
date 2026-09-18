import { expect, test } from "@playwright/test";

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Window augmentation requires declaration merging.
  interface Window {
    workerCacheCommits: { noteId: string; updatedAt: number }[];
  }
}

test.use({ serviceWorkers: "allow" });

test("real Worker source editor save refreshes offline cache", async ({
  page,
  context,
  baseURL,
}) => {
  // Observe native metadata commits only: forward exactly the original call,
  // never manufacture/modify cache records, and ignore aborted transactions.
  await page.addInitScript(() => {
    window.workerCacheCommits = [];
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = Reflect.apply(put, this, args);
      if (
        this.transaction.db.name === "miyulabmd-offline-cache" &&
        this.name === "notes"
      ) {
        const record = args[0];
        const commit = {
          noteId: record.noteId as string,
          updatedAt: record.note.updatedAt as number,
        };
        this.transaction.addEventListener(
          "complete",
          () => window.workerCacheCommits.push(commit),
          { once: true },
        );
      }
      return request;
    };
  });
  const patches: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH") {
      patches.push(request.url());
    }
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto("/auth/login?email=worker-editor-cache%40example.test");
  await page.waitForURL(`${baseURL}/`);
  const initial =
    "# Editor cache acceptance\n\n- [ ] Preserve task\n\nOLD_EDITOR_BODY";
  const created = await context.request.post("/api/notes", {
    data: { markdown: initial, permission: "private" },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const sockets: string[] = [];
  const saved: Buffer[] = [];
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
    socket.on("framereceived", ({ payload }) => {
      if (Buffer.isBuffer(payload) && payload[0] === 4) {
        saved.push(payload);
      }
    });
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        return registration?.active?.state;
      }),
    )
    .toBe("activated");
  const initialTree = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/folders/tree" &&
      response.status() === 200,
  );
  await page.goto(`/n/${note.id}`);
  await expect(
    page.getByText("OLD_EDITOR_BODY", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#ssr-preview")).toHaveCount(0);
  await initialTree;
  // A tree response proves the initial cycle started; the released lock proves
  // it finished. Merely seeing no lock before its debounce would be a race.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = await navigator.locks.query();
        return [...(state.held ?? []), ...(state.pending ?? [])].some((lock) =>
          lock.name?.startsWith("miyulabmd:mydrive-prefetch:"),
        );
      }),
    )
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.workerCacheCommits.some((commit) => commit.noteId === id),
        note.id,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  const edit = page.getByRole("button", { exact: true, name: "Edit" });
  await edit.click();
  await edit.click();
  await page.getByRole("menuitem", { exact: true, name: "テキスト" }).click();
  const source = page.locator(".cm-content[contenteditable=true]");
  await expect(source).toContainText("OLD_EDITOR_BODY");
  await source.click();
  await source.press("ControlOrMeta+End");
  const suffix = "\n\nNEW_EDITOR_BODY";
  const expected = initial + suffix;
  const savedBefore = saved.length;
  const refreshedTree = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/folders/tree" &&
      response.status() === 200,
  );
  await source.press("Enter");
  await source.press("Enter");
  await source.pressSequentially("NEW_EDITOR_BODY");
  await expect(source).toContainText("NEW_EDITOR_BODY");

  let updatedAt = 0;
  await expect
    .poll(
      async () => {
        const response = await context.request.get(`/api/notes/${note.id}`);
        expect(response.status()).toBe(200);
        const persisted = await response.json();
        updatedAt = persisted.updatedAt;
        return persisted.markdown;
      },
      {
        message: "keyboard edit must reach actual D1 snapshot",
        timeout: 20_000,
      },
    )
    .toBe(expected);
  expect(updatedAt).not.toBe(note.updatedAt);
  await expect
    .poll(() =>
      saved
        .slice(savedBefore)
        .some(
          (frame) => frame[1] === 1 && frame.subarray(2).toString() === note.id,
        ),
    )
    .toBe(true);
  await refreshedTree;
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, timestamp }) =>
          window.workerCacheCommits.some(
            (commit) => commit.noteId === id && commit.updatedAt === timestamp,
          ),
        { id: note.id, timestamp: updatedAt },
      ),
    )
    .toBe(true);
  // Check the actual CodeMirror DOM buffer, not an app test API or Y.Text hook.
  expect(await source.locator(".cm-line").allTextContents()).toEqual(
    expected.split("\n"),
  );
  expect(patches).toEqual([]);
  expect(
    sockets.some((url) => new URL(url).pathname === `/ws/notes/${note.id}`),
  ).toBe(true);
  // Chromium's offline emulation does not block WebSocket upgrades; abort the
  // collaboration handshake explicitly so the offline phase is deterministic.
  await context.route("**/ws/notes/**", (route) => route.abort());
  await context.setOffline(true);
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await response?.text()).not.toContain("NEW_EDITOR_BODY");
  await expect(
    page.getByText("NEW_EDITOR_BODY", { exact: true }),
  ).toBeVisible();
  // オフライン状態はヘッダーのアイコンが示す。
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();
  // オンライン同期済み・資格ありの本人ノートはオフラインでも本文編集に入れる。
  // ?mode=edit がリロードをまたぐため、そのままエディタが復元される。
  await expect(page).toHaveURL(/[?&]mode=edit/);
  await expect(edit).toBeVisible();
  const offlineSource = page.locator(".cm-content[contenteditable=true]");
  await expect(offlineSource).toContainText("NEW_EDITOR_BODY");
  await offlineSource.click();
  await offlineSource.press("ControlOrMeta+End");
  await offlineSource.pressSequentially("\nOFFLINE_DRAFT");
  await expect(offlineSource).toContainText("OFFLINE_DRAFT");
  await expect(
    page.getByRole("status").filter({ hasText: "未送信の編集" }),
  ).toBeVisible();
  expect(patches).toEqual([]);
});
