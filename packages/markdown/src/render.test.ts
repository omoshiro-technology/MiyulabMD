import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdownHtml } from "./render.ts";

test("renderMarkdownHtml renders GFM tables", () => {
  const html = renderMarkdownHtml(`| A | B |
| --- | --- |
| 1 | 2 |`);
  assert.match(html, /<table[\s>]/i);
  assert.match(html, /<th[\s>]/i);
  assert.match(html, /<td[\s>]/i);
  assert.match(html, />A</);
  assert.match(html, />1</);
});

test("renderMarkdownHtml prefixes heading ids for TOC", () => {
  const html = renderMarkdownHtml("# Hello world\n");
  assert.match(html, /id="user-content-hello-world"/);
});

test("renderMarkdownHtml is sync and does not need OGP cards", () => {
  const html = renderMarkdownHtml("https://example.com/preview-perf\n");
  assert.match(html, /example\.com\/preview-perf/);
});

test("renderMarkdownHtml highlights fenced code and shows filename", () => {
  const html = renderMarkdownHtml(
    "```typescript:hoge.ts\nconst answer = 42;\n```\n",
  );
  assert.match(html, /class="md-code-filename"/);
  assert.match(html, />hoge\.ts</);
  assert.match(html, /language-typescript/);
  assert.match(html, /hljs-/);
  assert.doesNotMatch(html, /language-typescript:hoge\.ts/);
});

test("renderMarkdownHtml skips YAML frontmatter", () => {
  const html = renderMarkdownHtml(
    "---\ntitle: Hidden\n---\n\n# Visible heading\n",
  );
  assert.match(html, /Visible heading/);
  assert.doesNotMatch(html, /Hidden/);
});

test("renderMarkdownHtml infers highlight language from a filename fence", () => {
  const html = renderMarkdownHtml("```hoge.ts\nconst answer = 42;\n```\n");
  assert.match(html, />hoge\.ts</);
  assert.match(html, /language-typescript/);
});

test("renderMarkdownHtml embeds a standalone YouTube URL", () => {
  const html = renderMarkdownHtml(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw\n",
  );
  assert.match(html, /embed-youtube/);
  assert.match(html, /youtube-nocookie\.com\/embed\/jNQXAC9IVRw/);
});

test("renderMarkdownHtml keeps a YouTube start time on the embed", () => {
  const html = renderMarkdownHtml(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s\n",
  );
  assert.match(html, /embed\/jNQXAC9IVRw\?start=12/);
});

test("renderMarkdownHtml does not embed an inline YouTube URL", () => {
  const html = renderMarkdownHtml("see https://youtu.be/yI81_De3Hjk\n");
  assert.doesNotMatch(html, /embed-youtube/);
  assert.match(html, /youtu\.be\/yI81_De3Hjk/);
});
