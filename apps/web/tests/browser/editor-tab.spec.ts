import { expect, type Page, test } from "@playwright/test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

const tabNote = {
  ...note,
  id: "tab-note",
  markdown: "# Tab test\n\nbody line",
  title: "Tab test",
};

// Minimal y-websocket peer: accept the room and answer every sync message
// with SyncStep1 + SyncStep2 so the provider reports synced.
function mockCollab(page: Page, markdown: string) {
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, markdown);
  return page.routeWebSocket("**/ws/notes/**", (ws) => {
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

async function mockApp(page: Page, markdown = tabNote.markdown) {
  await mockCollab(page, markdown);
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
        return route.fulfill({ headers, json: { notes: [] } });
      case "/api/folders":
        return route.fulfill({
          headers,
          json: { children: [], id: null, name: "", path: [] },
        });
      case `/api/notes/${tabNote.id}`:
        return route.fulfill({
          headers,
          json: { ...tabNote, markdown },
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

async function openSourceEditor(page: Page) {
  await page.goto(`/n/${tabNote.id}`);
  await expect(page.getByText("body line")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  const content = page.locator(".cm-content");
  await expect(content).toBeVisible();
  await content.click({ position: { x: 6, y: 6 } });
  return content;
}

function focusInEditor(page: Page, selector: string) {
  return page.evaluate(
    (sel) =>
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest(sel) !== null,
    selector,
  );
}

test("Tab indents and Shift-Tab dedents without leaving the source editor", async ({
  page,
}) => {
  await mockApp(page);
  const content = await openSourceEditor(page);

  // The first-use hint explains the escape hatch and can be dismissed.
  const hint = page.getByRole("note");
  await expect(hint).toContainText("Esc → Tab、または Ctrl-M");
  await hint.getByRole("button", { name: "閉じる" }).click();
  await expect(hint).toHaveCount(0);

  // Dismissing the hint took focus; put the caret back on the first line.
  await content.click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.locator(".cm-line").first().textContent())
    .toBe("  # Tab test");
  expect(await focusInEditor(page, ".cm-editor")).toBe(true);

  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => page.locator(".cm-line").first().textContent())
    .toBe("# Tab test");
  expect(await focusInEditor(page, ".cm-editor")).toBe(true);
});

test("Escape then Tab moves focus out of the source editor", async ({
  page,
}) => {
  await mockApp(page);
  await page.addInitScript(() =>
    localStorage.setItem("miyulabmd:editor-tab-hint-dismissed", "1"),
  );
  await openSourceEditor(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect.poll(() => focusInEditor(page, ".cm-editor")).toBe(false);
});

test("Ctrl-M toggles Tab back to focus movement", async ({ page }) => {
  await mockApp(page);
  await page.addInitScript(() =>
    localStorage.setItem("miyulabmd:editor-tab-hint-dismissed", "1"),
  );
  const content = await openSourceEditor(page);
  await page.keyboard.press("Control+m");
  await page.keyboard.press("Tab");
  await expect.poll(() => focusInEditor(page, ".cm-editor")).toBe(false);

  await content.click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Control+m");
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.locator(".cm-line").first().textContent())
    .toBe("  # Tab test");
});

test("the focus setting keeps Tab as focus movement", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("miyulabmd:editor-tab-key", "focus"),
  );
  await mockApp(page);
  await openSourceEditor(page);
  await page.keyboard.press("Tab");
  await expect.poll(() => focusInEditor(page, ".cm-editor")).toBe(false);
  await expect
    .poll(() => page.locator(".cm-line").first().textContent())
    .toBe("# Tab test");
});

test("Tab indents in the rich editor too", async ({ page }) => {
  await mockApp(page);
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:editor-tab-hint-dismissed", "1");
    localStorage.setItem("miyulabmd:editor-mode", "rich");
    localStorage.setItem("miyulabmd:editor-edit-mode", "rich");
  });
  await page.goto(`/n/${tabNote.id}`);
  await expect(page.getByText("body line")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  const rich = page.locator(".tiptap");
  await expect(rich).toBeVisible();
  await rich.locator("h1").click({ position: { x: 4, y: 4 } });

  await page.keyboard.press("Tab");
  await expect.poll(() => rich.locator("h1").textContent()).toBe("  Tab test");
  expect(await focusInEditor(page, ".tiptap")).toBe(true);

  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => rich.locator("h1").textContent()).toBe("Tab test");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect.poll(() => focusInEditor(page, ".tiptap")).toBe(false);
});

test("Escape pass-through lets Tab leave a rich-editor list item", async ({
  page,
}) => {
  await mockApp(page, "# Tab test\n\n- one\n- two\n");
  await page.addInitScript(() => {
    localStorage.setItem("miyulabmd:editor-tab-hint-dismissed", "1");
    localStorage.setItem("miyulabmd:editor-mode", "rich");
    localStorage.setItem("miyulabmd:editor-edit-mode", "rich");
  });
  await page.goto(`/n/${tabNote.id}`);
  await expect(page.getByText("two")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  const rich = page.locator(".tiptap");
  await expect(rich).toBeVisible();
  await rich.locator("li", { hasText: "two" }).click();

  // Indent mode still sinks the item via the list keymap.
  await page.keyboard.press("Tab");
  await expect(rich.locator("ul ul > li")).toHaveText("two");

  // In the Escape window the list keymap must not lift the item back; the
  // browser moves focus instead.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focusInEditor(page, ".tiptap")).toBe(false);
  await expect(rich.locator("ul ul > li")).toHaveText("two");
});

test("the settings page switches Tab behavior and documents the escape hatch", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/settings/editor");
  const select = page.getByLabel("Tab キーの動作");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("indent");
  await expect(page.getByText(/Esc → Tab、または Ctrl-M/)).toBeVisible();
  await select.selectOption("focus");
  expect(
    await page.evaluate(() => localStorage.getItem("miyulabmd:editor-tab-key")),
  ).toBe("focus");
});
