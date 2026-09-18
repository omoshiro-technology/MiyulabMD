import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

const lockedNote = {
  ...note,
  editLocked: true,
  id: "locked-note",
  markdown: "# Locked note\n\nlocked body",
  title: "Locked note",
};

const editableNote = {
  ...note,
  editLocked: false,
  id: "editable-note",
  markdown: "# Editable note\n\nbody",
  title: "Editable note",
};

async function mockApp(page: Page, fixture: typeof lockedNote) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === `/api/notes/${fixture.id}/lock`) {
      // The lock route returns the note itself (not wrapped).
      return route.fulfill({
        headers,
        json: { ...fixture, editLocked: !fixture.editLocked },
      });
    }
    switch (pathname) {
      case "/api/me":
        return route.fulfill({
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ json: { access: false, mock: true } });
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [] } });
      case "/api/folders":
        return route.fulfill({
          headers,
          json: { children: [], id: null, name: "", path: [] },
        });
      case `/api/notes/${fixture.id}`:
        return route.fulfill({ headers, json: fixture });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
}

test("編集ロック中は preview 強制・ロック表示・解除で編集可能に戻る", async ({
  page,
}) => {
  await mockApp(page, lockedNote);
  await page.goto(`/n/${lockedNote.id}`);
  await expect(page.getByText("locked body")).toBeVisible();

  // 編集モード切替は出ず、ロックバナーが表示される。
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  await expect(page.getByText("編集ロックされています")).toBeVisible();

  // 「⋯ ノート」→「編集ロック」サブビューから解除。
  await page.getByRole("button", { name: "ノートメニュー" }).click();
  await page.getByRole("menuitem", { name: "編集ロック" }).click();
  await expect(page.getByText("ロック中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ロックを解除" }).click();

  await expect(page.getByText("編集ロックされています")).toHaveCount(0);
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toBeVisible();
});

test("未ロックのノートは「⋯ ノート」メニューからロックできる", async ({
  page,
}) => {
  await mockApp(page, editableNote);
  await page.goto(`/n/${editableNote.id}`);
  await expect(page.getByText("body")).toBeVisible();

  await page.getByRole("button", { name: "ノートメニュー" }).click();
  await page.getByRole("menuitem", { name: "編集ロック" }).click();
  await page.getByRole("button", { name: "編集をロック" }).click();

  await expect(page.getByText("編集ロックされています")).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
});
