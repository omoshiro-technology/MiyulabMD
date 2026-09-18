import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNoteToc, shouldShowPreviewToc } from "./note-toc.ts";

test("extractNoteToc collects h1–h3 and ignores code fences", () => {
  const markdown = [
    "# Alpha",
    "",
    "```md",
    "# Not a heading",
    "## Also skipped",
    "```",
    "",
    "## Beta [link](https://example.com)",
    "### `Gamma` **bold**",
    "#### Too deep",
  ].join("\n");

  assert.deepEqual(extractNoteToc(markdown), [
    { id: "user-content-alpha", level: 1, line: 1, text: "Alpha" },
    { id: "user-content-beta-link", level: 2, line: 8, text: "Beta link" },
    { id: "user-content-gamma-bold", level: 3, line: 9, text: "Gamma bold" },
  ]);
});

test("extractNoteToc ignores YAML frontmatter", () => {
  const markdown = ["---", "title: Not a heading", "---", "", "# Real"].join(
    "\n",
  );
  const entries = extractNoteToc(markdown);
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["Real"],
  );
  assert.equal(entries[0]?.line, 5);
});

test("extractNoteToc deduplicates slugs like rehype-slug", () => {
  const markdown = ["# Same", "## Same", "### Same"].join("\n");
  assert.deepEqual(
    extractNoteToc(markdown).map((entry) => entry.id),
    ["user-content-same", "user-content-same-1", "user-content-same-2"],
  );
});

test("shouldShowPreviewToc hides on narrow viewports", () => {
  assert.equal(shouldShowPreviewToc(960), false);
});

test("shouldShowPreviewToc shows when card is capped and gutter is wide", () => {
  assert.equal(shouldShowPreviewToc(1280), true);
});
