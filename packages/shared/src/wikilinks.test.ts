import assert from "node:assert/strict";
import test from "node:test";

import { lineForOffset, maskCodeRegions, parseNoteLinks } from "./wikilinks.ts";

test("parses a plain wiki link with offsets", () => {
  const md = "See [[Alpha]] for details.";
  const [link] = parseNoteLinks(md);
  assert.ok(link);
  assert.equal(link.type, "wiki");
  assert.equal(link.target, "Alpha");
  assert.equal(link.display, null);
  assert.equal(link.heading, null);
  assert.equal(md.slice(link.start, link.end), "[[Alpha]]");
});

test("parses folder path, alias, and heading forms", () => {
  const md = "[[work/Note|表示]] [[Note#見出し]] [[#self]]";
  const links = parseNoteLinks(md);
  assert.equal(links.length, 3);
  assert.equal(links[0]?.target, "work/Note");
  assert.equal(links[0]?.display, "表示");
  assert.equal(links[1]?.target, "Note");
  assert.equal(links[1]?.heading, "見出し");
  assert.equal(links[2]?.target, "");
  assert.equal(links[2]?.heading, "self");
});

test("parses markdown links to /n/{uuid}", () => {
  const id = "6b1f2a34-1234-4abc-9def-0123456789ab";
  const md = `[開く](/n/${id}) and [other](https://example.com)`;
  const links = parseNoteLinks(md);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.type, "md");
  assert.equal(links[0]?.target, id);
});

test("skips links inside fenced code and inline code", () => {
  const md = [
    "before [[Keep]]",
    "```",
    "[[Skip]]",
    "```",
    "inline `[[Skip2]]` end",
    "after [[Keep2]]",
  ].join("\n");
  const links = parseNoteLinks(md);
  assert.deepEqual(
    links.map((l) => l.target),
    ["Keep", "Keep2"],
  );
});

test("skips tilde fences and multi-backtick spans", () => {
  const md = "~~~\n[[Skip]]\n~~~\n``a [[Skip2]] b`` [[Keep]]";
  const links = parseNoteLinks(md);
  assert.deepEqual(
    links.map((l) => l.target),
    ["Keep"],
  );
});

test("ignores empty and malformed links", () => {
  const md = "[[]] [[  ]] [[unclosed [[ok]]";
  const links = parseNoteLinks(md);
  assert.deepEqual(
    links.map((l) => l.target),
    ["ok"],
  );
});

test("maskCodeRegions preserves offsets", () => {
  const md = "a `x` b\n```\nc\n```\nd";
  const masked = maskCodeRegions(md);
  assert.equal(masked.length, md.length);
  assert.equal(masked[0], "a");
  assert.equal(masked[md.length - 1], "d");
});

test("lineForOffset returns 1-based lines", () => {
  const md = "one\ntwo\nthree";
  assert.equal(lineForOffset(md, 0), 1);
  assert.equal(lineForOffset(md, 4), 2);
  assert.equal(lineForOffset(md, 8), 3);
});
