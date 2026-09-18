import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("real logout removes private cache and peer content without deleting the production shell", async ({
  page,
  context,
  baseURL,
}) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/auth/login?email=worker-logout%40example.test");
  await page.waitForURL(`${baseURL}/`);
  const { user } = await (await context.request.get("/api/me")).json();
  const created = await context.request.post("/api/notes", {
    data: {
      markdown: "# Logout acceptance\n\nPrivate logout body.",
      permission: "private",
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration("/"))?.active?.state,
      ),
    )
    .toBe("activated");
  await page.goto(`/n/${note.id}`);
  const peer = await context.newPage();
  try {
    await peer.goto(`/n/${note.id}`);
    for (const target of [page, peer]) {
      await expect(
        target.getByText("Private logout body.", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          target.evaluate(() => Boolean(navigator.serviceWorker.controller)),
        )
        .toBe(true);
    }
    const inspectCache = async (userId: string) => {
      const encoded = btoa(
        String.fromCharCode(...new TextEncoder().encode(userId)),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("miyulabmd-offline-cache");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      let records = 0;
      try {
        for (const name of ["notes", "folders", "note-lists"]) {
          records += await new Promise<number>((resolve, reject) => {
            const request = database
              .transaction(name)
              .objectStore(name)
              .getAll();
            request.onsuccess = () =>
              resolve(
                (request.result as { userId: string }[]).filter(
                  (row) => row.userId === userId,
                ).length,
              );
            request.onerror = () => reject(request.error);
          });
        }
      } finally {
        database.close();
      }
      let directory = false;
      try {
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
        await app.getDirectoryHandle(encoded);
        directory = true;
      } catch (error) {
        if (
          !(error instanceof DOMException && error.name === "NotFoundError")
        ) {
          throw error;
        }
      }
      return { directory, records, shell: await caches.keys() };
    };
    await expect
      .poll(() => page.evaluate(inspectCache, user.id))
      .toMatchObject({ directory: true });
    const before = await page.evaluate(inspectCache, user.id);
    expect(before.records).toBeGreaterThan(0);
    expect(before.shell.length).toBeGreaterThan(0);

    await page
      .getByRole("button", {
        exact: true,
        name: user.displayName || user.email,
      })
      .click();
    await page
      .getByRole("menuitem", { exact: true, name: "ログアウト" })
      .click();
    await page.waitForURL(`${baseURL}/`);
    await expect(
      peer.getByText("Private logout body.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      peer.getByRole("button", { exact: true, name: "ゲスト" }),
    ).toBeVisible();
    const me = await context.request.get("/api/me");
    expect(me.headers()["x-miyulabmd-session-user"]).toBe("guest");
    expect((await me.json()).user).toBeNull();
    await expect
      .poll(() => peer.evaluate(inspectCache, user.id))
      .toEqual({
        directory: false,
        records: 0,
        shell: before.shell,
      });
    await context.setOffline(true);
    const response = await peer.reload({ waitUntil: "domcontentloaded" });
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(
      peer.getByText("Private logout body.", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await peer.close();
  }
});
