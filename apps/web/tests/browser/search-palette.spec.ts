import type { WorkspaceSearchResult } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

// Blank lines keep each filler as its own paragraph so the preview is tall
// enough to scroll.
const markdown = [
  "# Search target",
  ...Array.from({ length: 39 }, (_, index) => `filler line ${index + 1}\n`),
  "## Deep section",
  "needle deep body line",
  ...Array.from({ length: 39 }, (_, index) => `tail line ${index + 1}\n`),
].join("\n");

const hitNote = {
  ...note,
  id: "n-hit",
  markdown,
  title: "Search target",
};

const searchResult: WorkspaceSearchResult = {
  grep: {
    matches: [
      {
        after: ["", "tail line 1"],
        before: ["## Deep section", ""],
        column: 1,
        line: 81,
        noteId: "n-hit",
        snapshotUpdatedAt: 1,
        text: "needle deep body line",
        title: "Search target",
      },
    ],
    scannedNotes: 1,
    truncated: true,
  },
  notes: [
    {
      ...hitNote,
      snippet: "needle deep body line",
    },
  ],
  query: "needle",
};

async function mockApp(page: import("@playwright/test").Page) {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
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
      case "/api/search":
        return route.fulfill({ headers, json: searchResult });
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [] } });
      case "/api/folders":
        return route.fulfill({
          headers,
          json: { children: [], id: null, name: "", path: [] },
        });
      case `/api/notes/${hitNote.id}`:
        return route.fulfill({ headers, json: hitNote });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.goto("/tests/browser/fixtures/search-palette.html");
  await expect(page.getByText("検索フィクスチャのホーム")).toBeVisible();
}

test("Ctrl+K opens the palette and a line match jumps to the editor line", async ({
  page,
}) => {
  await mockApp(page);
  await page.keyboard.press("Control+k");
  const input = page.getByLabel("ノートを検索");
  await expect(input).toBeVisible();
  await input.fill("needle");

  const dialog = page.getByRole("dialog", { name: "検索" });
  const titleHit = dialog.getByRole("option", {
    exact: true,
    name: "Search target",
  });
  const lineHit = dialog.getByRole("option", {
    name: /needle deep body line/,
  });
  await expect(titleHit).toBeVisible();
  await expect(lineHit).toBeVisible();
  await expect(
    dialog.getByText("結果が多いため一部のみ表示しています"),
  ).toBeVisible();

  await lineHit.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Deep section" }),
  ).toBeVisible();
  // ?line=43 scrolls the preview to the nearest preceding heading.
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
});

test("Enter opens the first title hit and Escape closes the palette", async ({
  page,
}) => {
  await mockApp(page);
  await page.keyboard.press("Control+k");
  const input = page.getByLabel("ノートを検索");
  await input.fill("needle");

  const dialog = page.getByRole("dialog", { name: "検索" });
  await expect(
    dialog.getByRole("option", { exact: true, name: "Search target" }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: "Search target" }),
  ).toBeVisible();

  // The palette stays reachable from the editor too.
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("ノートを検索")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
