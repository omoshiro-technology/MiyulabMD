import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdownHtml } from "./render.ts";
import {
  collectTaskCheckboxes,
  isTaskCheckboxUpdate,
  taskContextHash,
} from "./task-list.ts";

test("tasks retain source lines and UTF-16 offsets through frontmatter, CRLF and nesting", () => {
  const markdown =
    "---\r\ntitle: test\r\n---\r\n\r\n# 🐈\r\n\r\n- [ ] first\r\n  - [X] nested\r\n\r\n> 1. [x] quoted\r\n";
  const tasks = collectTaskCheckboxes(markdown);
  assert.deepEqual(
    tasks.map(({ line, checked }) => ({ checked, line })),
    [
      { checked: false, line: 7 },
      { checked: true, line: 8 },
      { checked: true, line: 10 },
    ],
  );
  assert.deepEqual(
    tasks.map((task) => markdown[task.offset]),
    [" ", "X", "x"],
  );
  const html = renderMarkdownHtml(markdown);
  assert.deepEqual(
    [...html.matchAll(/data-task-line="(\d+)"/g)].map((match) =>
      Number(match[1]),
    ),
    [7, 8, 10],
  );
});

test("code blocks, raw HTML and frontmatter cannot forge interactive tasks", () => {
  const markdown =
    '---\ntitle: "- [ ] metadata"\n---\n\n```md\n- [ ] code\n```\n\n    - [ ] indented\n\n<li class="task-list-item"><input type="checkbox" data-task-line="12"></li>\n\n- [ ] real\n';
  assert.equal(collectTaskCheckboxes(markdown).length, 1);
  const html = renderMarkdownHtml(markdown);
  assert.equal([...html.matchAll(/data-task-line=/g)].length, 1);
  assert.match(html, /data-task-line="13"/);
  assert.match(html, /<input type="checkbox" disabled>/);
});

test("multiline embeds and loose lists still map to original source lines", () => {
  const markdown =
    '<ogp\n href="https://example.com"\n></ogp>\n\n- [ ] first\n\n  paragraph\n\n- [x] second\n';
  const html = renderMarkdownHtml(markdown);
  assert.deepEqual(
    [...html.matchAll(/data-task-line="(\d+)"/g)].map((match) =>
      Number(match[1]),
    ),
    [5, 9],
  );
});

test("context ignores only task states and detects duplicate-line shifts and other text edits", async () => {
  const original = "- [ ] same\n- [x] same\n\nbody";
  const hash = await taskContextHash(original);
  assert.equal(await taskContextHash("- [X] same\n- [ ] same\n\nbody"), hash);
  assert.notEqual(await taskContextHash(`- [ ] same\n${original}`), hash);
  assert.notEqual(
    await taskContextHash(original.replace("body", "changed")),
    hash,
  );
  assert.notEqual(
    await taskContextHash(`${original}\n\`[x]\``),
    await taskContextHash(`${original}\n\`[ ]\``),
  );
});

test("API input rejects malformed and unbounded line identifiers", () => {
  const valid = { checked: true, contextHash: "a".repeat(64), line: 1 };
  assert.equal(isTaskCheckboxUpdate(valid), true);
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, line: 0 },
    { ...valid, line: 1.5 },
    { ...valid, line: Number.MAX_VALUE },
    { ...valid, checked: "true" },
    { ...valid, contextHash: "bad" },
  ]) {
    assert.equal(isTaskCheckboxUpdate(invalid), false);
  }
});
