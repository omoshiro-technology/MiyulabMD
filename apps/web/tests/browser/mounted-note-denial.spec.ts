import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

for (const mode of ["network", "cached", "storage-failure"] as const) {
  for (const routePath of [
    `/n/${note.id}`,
    `/n/${note.shortId}`,
    `/s/${note.id}`,
    `/s/${note.shortId}`,
  ]) {
    test(`${mode} mounted note ${routePath} disappears on peer denial without clearing another note`, async ({
      page,
      context,
    }) => {
      const headers = { "X-MiyulabMD-Session-User": "user:alice" };
      const user = {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      };
      const independent = {
        ...note,
        id: "independent-note",
        markdown: "Independent visible body.",
        shortId: "independent-short",
      };
      let targetReads = 0;
      await context.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/me") {
          return route.fulfill({ headers, json: { user } });
        }
        if (
          path === `/api/notes/${note.id}` ||
          path === `/api/notes/${note.shortId}`
        ) {
          targetReads += 1;
          return route.fulfill({ headers, json: note });
        }
        if (path === `/api/notes/${independent.id}`) {
          return route.fulfill({ headers, json: independent });
        }
        if (path === "/api/article-sources") {
          return route.fulfill({ headers, json: { sources: [] } });
        }
        if (path === "/api/auth/config") {
          return route.fulfill({
            headers,
            json: { access: false, mock: true },
          });
        }
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
      });
      await page.goto(routePath);
      const body = page.getByText("通信なしでも読みたい本文。", {
        exact: true,
      });
      const editButton = page.getByRole("button", {
        exact: true,
        name: "Edit",
      });
      await expect(body).toBeVisible();
      if (mode === "cached") {
        await page.route("**/api/me", (route) =>
          route.abort("internetdisconnected"),
        );
        await page.reload();
        await expect(body).toBeVisible();
        await expect(editButton).toHaveCount(0);
      }
      const other = await context.newPage();
      const peer = await context.newPage();
      const independentBody = other.getByText(independent.markdown, {
        exact: true,
      });
      try {
        await other.goto(`/n/${independent.id}`);
        await expect(independentBody).toBeVisible();
        await peer.goto("/tests/browser/fixtures/storage.html");
        if (mode === "storage-failure") {
          await peer.evaluate(() => {
            IDBFactory.prototype.open = () => {
              throw new DOMException("Denied storage", "UnknownError");
            };
          });
        }
        await peer.route(`**/api/notes/${note.id}`, (route) =>
          route.fulfill({ headers, json: { error: "Forbidden" }, status: 403 }),
        );
        const beforeDenial = targetReads;
        const result = await peer.evaluate(
          async ({ id, user }) => {
            const url = "/src/lib/note-read-session.ts";
            const { createNoteReadSession } = await import(url);
            const session = createNoteReadSession({
              cacheViewerId: user.id,
              mode: "authenticated",
              user,
            });
            try {
              return await session.read(id);
            } finally {
              session.dispose();
            }
          },
          { id: note.id, user },
        );
        expect(result).toMatchObject({ ok: false, status: 403 });
        if (mode === "storage-failure") {
          expect(result.cacheWarning).toBeTruthy();
          await expect(
            page.getByText(/端末キャッシュを削除してください/),
          ).toBeVisible();
        }
        await expect(body).toHaveCount(0);
        await expect(page).not.toHaveTitle(new RegExp(note.title));
        await expect(editButton).toHaveCount(0);
        await expect(independentBody).toBeVisible();
        expect(targetReads).toBe(beforeDenial);
      } finally {
        await peer.close();
        await other.close();
      }
    });
  }
}
