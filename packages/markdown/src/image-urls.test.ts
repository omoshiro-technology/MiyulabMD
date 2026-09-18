import assert from "node:assert/strict";
import { test } from "node:test";
import { collectImageUrls } from "./index.ts";

test("image destinations follow rendered Markdown and sanitized raw HTML", () => {
  const markdown = [
    "---",
    'title: "![](/api/notes/n/images/frontmatter)"',
    "---",
    "![inline](/api/notes/n/images/inline)",
    "![reference][Photo]",
    '[photo]: /api/notes/other/images/reference "Photo"',
    '<img src="/api/notes/n/images/raw?x=1&amp;y=2" alt="raw">',
    "![external](https://images.example/logo.png)",
    "![duplicate](/api/notes/n/images/inline)",
    "[ordinary link](/api/notes/n/images/not-an-image)",
    "`![inline code](/api/notes/n/images/code)`",
    "```md",
    "![fenced](/api/notes/n/images/fenced)",
    "```",
    '<img src="javascript:alert(1)" alt="unsafe">',
  ].join("\n\n");
  assert.deepEqual(collectImageUrls(markdown), [
    "/api/notes/n/images/inline",
    "/api/notes/other/images/reference",
    "/api/notes/n/images/raw?x=1&y=2",
    "https://images.example/logo.png",
  ]);
});

test("empty and ordinary text have no image destinations", () => {
  assert.deepEqual(collectImageUrls(""), []);
  assert.deepEqual(collectImageUrls("# Text\n\nhttps://example.test/"), []);
});
