import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeEditorMarkdown,
  collectOgUrls,
  expandEmbedsForPreview,
  renderOgCardHtml,
  youtubeEmbedUrl,
  youtubeId,
  youtubeStartSeconds,
} from "./embeds.ts";

const WATCH = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const SHORT = "https://youtu.be/yI81_De3Hjk";
const WATCH_EMBED = "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw";

test("canonicalizeEditorMarkdown writes og cards as a normal URL", () => {
  assert.equal(
    canonicalizeEditorMarkdown(':::ogCard {href="https://example.com/a"} :::'),
    "https://example.com/a",
  );
  assert.equal(
    canonicalizeEditorMarkdown("[ogp](https://example.com/a)"),
    "https://example.com/a",
  );
  assert.equal(
    canonicalizeEditorMarkdown("https://example.com/a"),
    "https://example.com/a",
  );
});

test("collectOgUrls finds standalone links and leftover card syntax", () => {
  const markdown = [
    "hello https://inline.example",
    "https://alone.example",
    "[ogp](https://legacy.example)",
    ':::ogCard {href="https://block.example"} :::',
  ].join("\n");
  assert.deepEqual(collectOgUrls(markdown).sort(), [
    "https://alone.example",
    "https://block.example",
    "https://legacy.example",
  ]);
});

test("renderOgCardHtml puts text in a body that can be height-clamped", () => {
  const html = renderOgCardHtml("https://example.com/a", {
    description: "A long description",
    image: "https://example.com/og.png",
    siteName: "Example",
    title: "Hello",
    url: "https://example.com/a",
  });
  assert.match(html, /class="embed-og-body"/);
  assert.match(html, /embed-og-desc/);
  assert.match(html, /og\.png/);
});

test("expandEmbedsForPreview cards a standalone URL but not an inline one", () => {
  const cards = new Map();
  const html = expandEmbedsForPreview(
    "see https://inline.example\n\nhttps://alone.example",
    cards,
  );
  assert.match(html, /embed-og.*https:\/\/alone\.example/);
  assert.match(html, /see https:\/\/inline\.example/);
  assert.doesNotMatch(html, /see[\s\S]*embed-og[\s\S]*inline\.example/);
});

test("youtubeId accepts watch, youtu.be, and video paths", () => {
  assert.equal(youtubeId(WATCH), "jNQXAC9IVRw");
  assert.equal(youtubeId(`${WATCH}&t=12s`), "jNQXAC9IVRw");
  assert.equal(youtubeId(SHORT), "yI81_De3Hjk");
  assert.equal(
    youtubeId("https://www.youtube.com/embed/jNQXAC9IVRw"),
    "jNQXAC9IVRw",
  );
  assert.equal(
    youtubeId("https://www.youtube.com/shorts/jNQXAC9IVRw"),
    "jNQXAC9IVRw",
  );
  assert.equal(
    youtubeId("https://www.youtube.com/live/jNQXAC9IVRw"),
    "jNQXAC9IVRw",
  );
  assert.equal(youtubeId("https://www.youtube.com/channel/UCxxxxxx"), null);
  assert.equal(youtubeId("https://www.youtube.com/"), null);
  assert.equal(youtubeId("https://example.com/watch?v=jNQXAC9IVRw"), null);
});

test("youtubeStartSeconds reads t, start, and hash times", () => {
  assert.equal(youtubeStartSeconds(WATCH), 0);
  assert.equal(youtubeStartSeconds(`${WATCH}&t=12s`), 12);
  assert.equal(youtubeStartSeconds(`${WATCH}&t=1m30s`), 90);
  assert.equal(youtubeStartSeconds(`${WATCH}&start=15`), 15);
  assert.equal(youtubeStartSeconds(`${SHORT}?t=45`), 45);
  assert.equal(
    youtubeStartSeconds("https://www.youtube.com/watch?v=jNQXAC9IVRw#t=1h2s"),
    3602,
  );
  assert.equal(youtubeEmbedUrl(`${WATCH}&t=12s`), `${WATCH_EMBED}?start=12`);
});

test("canonicalizeEditorMarkdown writes youtube embeds as a normal URL", () => {
  assert.equal(
    canonicalizeEditorMarkdown(`:::youtube {src="${WATCH}"} :::`),
    WATCH,
  );
  assert.equal(
    canonicalizeEditorMarkdown(
      `:::youtube {src="${WATCH}" width="640" height="360" start="0"} :::`,
    ),
    WATCH,
  );
  assert.equal(canonicalizeEditorMarkdown(`![youtube](${WATCH})`), WATCH);
  assert.equal(canonicalizeEditorMarkdown(WATCH), WATCH);
  assert.equal(canonicalizeEditorMarkdown(SHORT), SHORT);
});

test("collectOgUrls skips YouTube URLs", () => {
  const markdown = [WATCH, "https://alone.example"].join("\n");
  assert.deepEqual(collectOgUrls(markdown), ["https://alone.example"]);
});

test("expandEmbedsForPreview embeds a standalone YouTube URL but not an inline one", () => {
  const html = expandEmbedsForPreview(`see ${WATCH}\n\n${SHORT}`, new Map());
  assert.match(html, /embed-youtube/);
  assert.match(html, /youtube-nocookie\.com\/embed\/yI81_De3Hjk/);
  assert.match(html, new RegExp(`see ${WATCH.replaceAll("?", "\\?")}`));
  assert.doesNotMatch(html, /youtube-nocookie\.com\/embed\/jNQXAC9IVRw/);
});
