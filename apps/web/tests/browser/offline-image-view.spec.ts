import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("an app-attached image remains visible with its cached note after reload", async ({
  page,
  context,
}) => {
  const imagePath = `/api/notes/${note.id}/images/image-1`;
  const displayed = {
    ...note,
    markdown: `${note.markdown}\n\n![Cached attachment](${imagePath})`,
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  let offline = false;
  await page.route("**/api/**", (route) => {
    if (offline) {
      return route.abort("internetdisconnected");
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === imagePath) {
      return route.fulfill({ body: png, contentType: "image/png", headers });
    }
    if (pathname === `/api/notes/${note.id}`) {
      return route.fulfill({ headers, json: displayed });
    }
    if (pathname === "/api/me") {
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
    if (pathname === "/api/auth/config") {
      return route.fulfill({ headers, json: { access: false, mock: true } });
    }
    if (pathname === "/api/article-sources") {
      return route.fulfill({ headers, json: { sources: [] } });
    }
    return route.fulfill({
      headers,
      json: { error: "No fixture" },
      status: 404,
    });
  });
  await page.goto(`/n/${note.id}`);
  const image = page.getByRole("img", { name: "Cached attachment" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const moduleUrl = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(moduleUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        try {
          return (await cache.getNote(id))?.note.markdown;
        } finally {
          cache.close();
        }
      }, note.id),
    )
    .toBe(displayed.markdown);
  // Keep only the development shell reachable. Actual production shell
  // reload is separately exercised by the real Worker acceptance runner.
  offline = true;
  await page.reload();
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();
  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(1);
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
});
