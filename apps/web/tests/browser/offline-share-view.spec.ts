import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

async function verifyCachedShare(page: Page, id: string) {
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/ws/notes/")) {
      sockets.push(socket.url());
    }
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/notes/")) {
      requests.push(path);
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.clock.setFixedTime(new Date("2024-01-02T03:04:05Z"));
  await page.evaluate(async (note) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache, persistCachedViewerId } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.putNote({
        ...note,
        markdown: `${note.markdown}\n\n- [ ] 読み取り専用タスク`,
      });
      await persistCachedViewerId("alice");
    } finally {
      cache.close();
    }
  }, note);
  await page.goto(`/s/${id}`);
  await expect(page.getByText("通信なしでも読みたい本文。")).toBeVisible();
  const status = page.getByRole("status").filter({ hasText: "キャッシュ" });
  await expect(status).toContainText("2024");
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(sockets).toEqual([]);

  await page.evaluate(async () => {
    const url = "/src/lib/offline-cache.ts";
    const { persistCachedViewerId } = await import(url);
    await persistCachedViewerId("bob");
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    page.getByText("このノートはオフラインキャッシュに保存されていません。"),
  ).toBeVisible();
  await expect(page.getByText("通信なしでも読みたい本文。")).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(sockets).toEqual([]);
}

for (const id of [note.id, note.shortId]) {
  test(`share ${id} restores only the cached viewer's private readonly note`, async ({
    page,
  }) => {
    await verifyCachedShare(page, id);
  });
}

for (const status of [200, 401, 403, 404, 503]) {
  test(`online guest share preserves status ${status} UX`, async ({ page }) => {
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/me") {
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "guest" },
          json: { user: null },
        });
      }
      if (path === "/api/auth/config") {
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "guest" },
          json: { access: false, mock: true },
        });
      }
      return route.fulfill({
        headers: { "X-MiyulabMD-Session-User": "guest" },
        json: status === 200 ? note : { error: "Server failure" },
        status,
      });
    });
    await page.goto(`/s/${note.shortId}`);
    if (status === 200) {
      await expect(page.getByText("通信なしでも読みたい本文。")).toBeVisible();
    } else if (status === 401) {
      await expect(
        page.getByRole("link", { exact: true, name: "ログイン" }),
      ).toHaveAttribute("href", "/auth/login?email=dev@example.com");
    } else if (status === 403) {
      await expect(
        page.getByRole("heading", { name: "閲覧できません" }),
      ).toBeVisible();
    } else if (status === 404) {
      await expect(page.getByText("ノートが見つかりません。")).toBeVisible();
    } else {
      await expect(page.getByText("Server failure")).toBeVisible();
    }
    await expect(
      page.getByRole("status").filter({ hasText: "キャッシュ" }),
    ).toHaveCount(0);
  });
}
