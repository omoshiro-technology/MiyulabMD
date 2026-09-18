import type { FolderAccess, ParaListResult } from "@miyulabmd/shared";
import { expect, type Page, test } from "@playwright/test";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

// Server returns folders in lexical path order; the tree must re-sort the
// numbered ones numerically (10.9 < 10.11 < 10.20).
const rootFolder: FolderAccess = {
  children: [
    {
      folder: "10-19 仕事",
      id: "f-area",
      name: "10-19 仕事",
      parentId: "alice-root",
      scheme: "jd",
      schemeId: "10-19",
      schemeTitle: "仕事",
    },
    {
      folder: "docs",
      id: "f-docs",
      name: "docs",
      parentId: "alice-root",
    },
  ],
  crumbs: [],
  effectiveReadScope: "self",
  effectiveWriteScope: "self",
  flags: { canAdmin: true, canEdit: true, canView: true },
  folder: "",
  grants: [],
  id: "alice-root",
  inherit: true,
  locked: true,
  name: "マイドライブ",
  parentId: null,
  readScope: null,
  scheme: "jd",
  source: "default",
  sourceFolder: null,
  writeScope: null,
};

const jdCategoryChildren = {
  entries: [
    {
      id: "f-1011",
      name: "10.11 経費",
      parentId: "f-cat",
      schemeId: "10.11",
      type: "folder",
      updatedAt: 1,
    },
    {
      id: "f-1020",
      name: "10.20 請求",
      parentId: "f-cat",
      schemeId: "10.20",
      type: "folder",
      updatedAt: 1,
    },
    {
      id: "f-1009",
      name: "10.09 メモ",
      parentId: "f-cat",
      schemeId: "10.09",
      type: "folder",
      updatedAt: 1,
    },
  ],
  folder: { id: "f-cat", name: "10 経理", path: ["10-19 仕事", "10 経理"] },
  nextCursor: null,
};

const areaChildren = {
  entries: [
    {
      id: "f-cat",
      name: "10 経理",
      parentId: "f-area",
      scheme: "jd",
      schemeId: "10",
      schemeTitle: "経理",
      type: "folder",
      updatedAt: 1,
    },
  ],
  folder: { id: "f-area", name: "10-19 仕事", path: ["10-19 仕事"] },
  nextCursor: null,
};

const emptyPara: ParaListResult = { buckets: [] };

async function mockHome(page: Page) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
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
      case "/api/para":
        return route.fulfill({ headers, json: emptyPara });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [] } });
      case "/api/schemes/suggest": {
        const folderId = url.searchParams.get("folderId");
        if (folderId === "alice-root") {
          return route.fulfill({
            headers,
            json: {
              suggestion: {
                level: "area",
                name: "20-29 無題",
                path: "20-29 無題",
                scheme: "jd",
                schemeId: "20-29",
                title: "無題",
              },
            },
          });
        }
        return route.fulfill({ headers, json: { suggestion: null } });
      }
      case "/api/schemes/resolve":
        return route.fulfill({
          headers,
          json: {
            children: { entries: [], nextCursor: null },
            folder: {
              folder: "10-19 仕事/10 経理/10.22 旅費",
              id: "f-1022",
              name: "10.22 旅費",
              scheme: null,
              schemeId: "10.22",
              schemeTitle: "旅費",
            },
          },
        });
      case "/api/search":
        return route.fulfill({
          headers,
          json: {
            grep: { matches: [], scannedNotes: 0, truncated: false },
            notes: [],
            query: "",
          },
        });
      case "/api/folders":
        return route.fulfill({ headers, json: rootFolder });
      case "/api/folders/f-area/children":
        return route.fulfill({ headers, json: areaChildren });
      case "/api/folders/f-cat/children":
        return route.fulfill({ headers, json: jdCategoryChildren });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
}

test("コンテキストメニューからフォルダに命名規則を設定できる", async ({
  page,
}) => {
  const posts: unknown[] = [];
  await mockHome(page);
  await page.route("**/api/folders/f-docs/scheme", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: { folder: "docs", id: "f-docs", scheme: "jd" },
    });
  });
  await page.goto("/tests/browser/fixtures/home-owner.html");

  await page.getByRole("button", { name: "docs の操作" }).click();
  await page.getByRole("menuitem", { name: "命名規則…" }).click();

  const dialog = page.getByRole("dialog", { name: /命名規則/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("命名規則").selectOption("jd");
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ scheme: "jd" });
  await expect(dialog).toHaveCount(0);
});

test("命名規則フォルダでは作成ダイアログに次の番号が表示される", async ({
  page,
}) => {
  const posts: unknown[] = [];
  await mockHome(page);
  await page.route("**/api/folders", (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        headers,
        json: { ...rootFolder, id: "f-2029", name: "20-29 私事" },
        status: 201,
      });
    }
    return route.fulfill({ headers, json: rootFolder });
  });
  await page.goto("/tests/browser/fixtures/home-owner.html");

  await page.getByRole("button", { name: "フォルダ" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/次の番号は/)).toContainText("20-29");

  await dialog.getByLabel("フォルダ名").fill("私事");
  await dialog.getByRole("button", { name: "作成" }).click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({
    name: "私事",
    parentId: "alice-root",
    useScheme: true,
  });
});

test("採番済みフォルダは辞書順ではなく数値順に並ぶ", async ({ page }) => {
  await mockHome(page);
  await page.goto("/tests/browser/fixtures/home-owner.html");

  const area = page.getByRole("link", { name: "10-19 仕事" });
  await expect(area).toBeVisible();
  await page.getByRole("button", { name: "10-19 仕事 を展開" }).click();
  const cat = page.getByRole("link", { name: "10 経理" });
  await expect(cat).toBeVisible();
  await page.getByRole("button", { name: "10 経理 を展開" }).click();

  const list = page.getByRole("list").last();
  await expect(list.getByRole("link", { name: "10.09 メモ" })).toBeVisible();
  const names = await list.getByRole("link").allTextContents();
  const jdNames = names.filter((name) => name.startsWith("10."));
  expect(jdNames).toEqual(["10.09 メモ", "10.11 経費", "10.20 請求"]);
});

test("検索パレットでスキーム ID からフォルダを開ける", async ({ page }) => {
  await mockHome(page);
  await page.goto("/tests/browser/fixtures/home-owner.html");

  await page.keyboard.press("Control+k");
  const input = page.getByLabel("ノートを検索");
  await expect(input).toBeVisible();
  await input.fill("10.22");

  const dialog = page.getByRole("dialog", { name: "検索" });
  const hit = dialog.getByRole("option", { name: /10\.22 旅費/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(dialog).toHaveCount(0);
});
