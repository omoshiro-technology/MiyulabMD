import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdownHtml } from "./render.ts";
import type { WikiLinkMap } from "./wikilinks.ts";

test("resolved wiki links render as /n/{id} anchors", () => {
  const links: WikiLinkMap = new Map([["Alpha", "note-uuid-1"]]);
  const html = renderMarkdownHtml("see [[Alpha]] now", new Map(), links);
  assert.match(html, /<a href="\/n\/note-uuid-1"[^>]*class="wikilink"/);
  assert.match(html, />Alpha<\/a>/);
});

test("alias becomes the link label and heading becomes a fragment", () => {
  const links: WikiLinkMap = new Map([["Beta", "note-uuid-2"]]);
  const html = renderMarkdownHtml(
    "[[Beta|表示名]] and [[Beta#Sec]]",
    new Map(),
    links,
  );
  assert.match(html, /<a href="\/n\/note-uuid-2"[^>]*>表示名<\/a>/);
  assert.match(html, /href="\/n\/note-uuid-2#Sec"/);
});

test("missing links render as marked spans, not anchors", () => {
  const links: WikiLinkMap = new Map([["Gone", null]]);
  const html = renderMarkdownHtml("[[Gone]]", new Map(), links);
  assert.match(html, /<span class="wikilink-missing">\[\[Gone\]\]<\/span>/);
  assert.doesNotMatch(html, /<a /);
});

test("without a map wiki links stay literal", () => {
  const html = renderMarkdownHtml("[[Alpha]]");
  assert.match(html, /\[\[Alpha\]\]/);
  assert.doesNotMatch(html, /wikilink/);
});

test("links inside code are not transformed", () => {
  const links: WikiLinkMap = new Map([["Alpha", "note-uuid-1"]]);
  const html = renderMarkdownHtml(
    "`[[Alpha]]`\n\n```\n[[Alpha]]\n```",
    new Map(),
    links,
  );
  assert.doesNotMatch(html, /<a /);
});
