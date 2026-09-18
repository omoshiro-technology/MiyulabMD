import { expect, type Page, test } from "@playwright/test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

const srcNote = {
  ...note,
  id: "link-src",
  markdown: "# Link source\n\nSee [[Target Note]] and [[Missing Note]] here.\n",
  title: "Link source",
};

const targetNote = {
  ...note,
  id: "link-target",
  markdown: "# Target Note\n\nDestination body.\n",
  title: "Target Note",
};

const { markdown: _srcMd, ...srcSummary } = srcNote;
const { markdown: _targetMd, ...targetSummary } = targetNote;

const srcLinks = {
  backlinks: [
    {
      heading: null,
      line: 1,
      linkType: "wiki",
      note: targetSummary,
      target: "Link source",
    },
  ],
  outgoing: [
    {
      display: null,
      heading: null,
      line: 3,
      linkType: "wiki",
      note: targetSummary,
      target: "Target Note",
    },
    {
      display: null,
      heading: null,
      line: 3,
      linkType: "wiki",
      note: null,
      target: "Missing Note",
    },
  ],
};

function mockCollab(page: Page, markdownByNoteId: Record<string, string>) {
  const docs = new Map<string, Y.Doc>();
  const docFor = (noteId: string) => {
    let doc = docs.get(noteId);
    if (!doc) {
      doc = new Y.Doc();
      doc.getText("markdown").insert(0, markdownByNoteId[noteId] ?? "");
      docs.set(noteId, doc);
    }
    return doc;
  };
  return page.routeWebSocket("**/ws/notes/**", (ws) => {
    const noteId = new URL(ws.url()).pathname.split("/").pop() ?? "";
    const doc = docFor(noteId);
    ws.onMessage((data) => {
      const bytes =
        data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) !== 0) {
        return;
      }
      const step1 = encoding.createEncoder();
      encoding.writeVarUint(step1, 0);
      sync.writeSyncStep1(step1, doc);
      ws.send(Buffer.from(encoding.toUint8Array(step1)));
      const step2 = encoding.createEncoder();
      encoding.writeVarUint(step2, 0);
      sync.writeSyncStep2(step2, doc);
      ws.send(Buffer.from(encoding.toUint8Array(step2)));
    });
  });
}

async function mockApp(page: Page) {
  await mockCollab(page, {
    [srcNote.id]: srcNote.markdown,
    [targetNote.id]: targetNote.markdown,
  });
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
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
      case "/api/notes":
        return route.fulfill({
          headers,
          json: { notes: [srcSummary, targetSummary] },
        });
      case "/api/folders":
        return route.fulfill({
          headers,
          json: { children: [], id: null, name: "", path: [] },
        });
      case `/api/notes/${srcNote.id}`:
        return route.fulfill({ headers, json: srcNote });
      case `/api/notes/${srcNote.id}/links`:
        return route.fulfill({ headers, json: srcLinks });
      case `/api/notes/${targetNote.id}`:
        return route.fulfill({ headers, json: targetNote });
      case `/api/notes/${targetNote.id}/links`:
        return route.fulfill({
          headers,
          json: { backlinks: [], outgoing: [] },
        });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
}

test("preview renders resolved wiki links and they navigate", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto(`/n/${srcNote.id}`);

  const link = page.locator('a.wikilink[href="/n/link-target"]');
  await expect(link).toHaveText("Target Note");

  const missing = page.locator("span.wikilink-missing");
  await expect(missing).toHaveText("[[Missing Note]]");

  await link.click();
  await expect(page).toHaveURL(/\/n\/link-target/);
  await expect(page.getByText("Destination body.")).toBeVisible();
});

test("the links panel lists outgoing links and backlinks", async ({ page }) => {
  await mockApp(page);
  await page.goto(`/n/${srcNote.id}`);
  await expect(page.getByText("See")).toBeVisible();

  // リンクパネルは「⋯ ノート」オーバーフローメニューから開く（§3.1）。
  await page.getByRole("button", { name: "ノートメニュー" }).click();
  await page.getByRole("menuitem", { name: "リンク" }).click();
  const panel = page.getByRole("complementary", { name: "リンク" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Backlinks" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Outgoing" })).toBeVisible();
  await expect(panel.getByText("Target Note").first()).toBeVisible();
  await expect(panel.getByText("Missing Note")).toBeVisible();

  await panel.getByRole("button", { name: "閉じる" }).click();
  await expect(panel).toHaveCount(0);
});

test("[[ autocomplete inserts a wiki link", async ({ page }) => {
  await mockApp(page);
  await page.addInitScript(() =>
    localStorage.setItem("miyulabmd:editor-tab-hint-dismissed", "1"),
  );
  await page.goto(`/n/${srcNote.id}`);
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  const content = page.locator(".cm-content");
  await expect(content).toBeVisible();

  await content.click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("End");
  await page.keyboard.type("[[Tar");

  const options = page.locator(".cm-tooltip-autocomplete li");
  await expect(options.first()).toBeVisible();
  await expect(options.first()).toContainText("Target Note");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.locator(".cm-line").first().textContent())
    .toContain("[[Target Note]]");
});
