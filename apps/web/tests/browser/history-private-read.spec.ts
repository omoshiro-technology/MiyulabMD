import type { NoteEditEvent } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";

function entry(id: string, time: number): NoteEditEvent {
  return {
    actor: { kind: "user", name: "Alice", userId: "alice" },
    createdAt: time,
    endedAt: time,
    endOffset: 10,
    excerpt: `Change ${id}`,
    id,
    noteId: "history-note",
    op: "replace",
    revisionId: id,
    startedAt: time,
    startOffset: 0,
  };
}

test("scoped history preserves paging, revision preview and confirmed restoration", async ({
  page,
}) => {
  const headers = { "X-MiyulabMD-Session-User": "user:alice" };
  let restores = 0;
  let pages = 0;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/me") {
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
    if (url.pathname === "/api/notes/history-note/history") {
      if (url.searchParams.get("before") === "100") {
        pages += 1;
        return route.fulfill({
          headers,
          json: { events: [entry("older", 50)], nextBefore: null },
        });
      }
      return route.fulfill({
        headers,
        json: { events: [entry("latest", 100)], nextBefore: 100 },
      });
    }
    if (url.pathname.endsWith("/restore")) {
      expect(route.request().method()).toBe("POST");
      expect(url.pathname).toBe(
        "/api/notes/history-note/revisions/older/restore",
      );
      restores += 1;
      return route.fulfill({
        headers,
        json: {
          message: "Original restoration completed",
          restored: true,
          revisionId: "older",
        },
      });
    }
    if (url.pathname.includes("/revisions/")) {
      return route.fulfill({
        headers,
        json: { markdown: `# Revision ${url.pathname.split("/").at(-1)}` },
      });
    }
    return route.fulfill({
      headers,
      json: { error: "No fixture" },
      status: 404,
    });
  });
  await page.goto("/tests/browser/fixtures/history-panel.html");
  await expect(
    page.getByRole("heading", { name: "Revision latest" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "さらに表示" }).click();
  await page.getByRole("button", { name: /Change older/ }).click();
  await expect(
    page.getByRole("heading", { name: "Revision older" }),
  ).toBeVisible();
  expect(pages).toBe(1);
  await page.getByRole("button", { name: "この版に戻す" }).click();
  expect(restores).toBe(0);
  await page.getByRole("button", { exact: true, name: "置き換える" }).click();
  await expect(page.getByText("Original restoration completed")).toBeVisible();
  expect(restores).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Revision latest" }),
  ).toBeVisible();
});

for (const failure of ["revision", "pagination", "refresh"] as const) {
  test(`a failed ${failure} read reports an error instead of leaking an unhandled rejection`, async ({
    page,
  }) => {
    let restored = false;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const headers = { "X-MiyulabMD-Session-User": "user:alice" };
    const historyFails = (url: URL) =>
      (failure === "pagination" && url.searchParams.has("before")) ||
      (failure === "refresh" && restored);
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
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
      if (path.endsWith("/history")) {
        if (historyFails(url)) {
          return route.abort("internetdisconnected");
        }
        return route.fulfill({
          headers,
          json: { events: [entry("latest", 100)], nextBefore: 100 },
        });
      }
      if (path.endsWith("/restore")) {
        restored = true;
        return route.fulfill({
          headers,
          json: { message: "Restored", restored: true, revisionId: "latest" },
        });
      }
      if (path.includes("/revisions/")) {
        return failure === "revision"
          ? route.abort("internetdisconnected")
          : route.fulfill({ headers, json: { markdown: "# Revision latest" } });
      }
      return route.fulfill({ headers, json: [], status: 200 });
    });
    await page.goto("/tests/browser/fixtures/history-panel.html");
    if (failure === "pagination") {
      await page.getByRole("button", { name: "さらに表示" }).click();
    }
    if (failure === "refresh") {
      await page.getByRole("button", { name: "この版に戻す" }).click();
      await page
        .getByRole("button", { exact: true, name: "置き換える" })
        .click();
    }
    await expect(
      page.getByText(
        failure === "revision"
          ? "プレビューを取得できませんでした。"
          : "履歴を取得できませんでした。",
      ),
    ).toBeVisible();
    await expect(page.getByText("プレビューを読み込み中…")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
