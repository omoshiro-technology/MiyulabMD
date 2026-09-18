import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("settings device cache clear removes private data after confirmation", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
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
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.goto("/settings/profile");
  await page.evaluate(async (source) => {
    const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.putNote({ ...source, id: "settings-clear-note" });
    } finally {
      cache.close();
    }
  }, note);
  const readNote = () =>
    page.evaluate(async () => {
      const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getNote("settings-clear-note"))?.note.id ?? null;
      } finally {
        cache.close();
      }
    });
  await expect.poll(readNote).toBe("settings-clear-note");

  await page
    .getByRole("button", { name: "この端末のキャッシュを削除" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "削除" }).click();
  await expect(page.getByText("削除しました")).toBeVisible();
  await expect.poll(readNote).toBeNull();
});
