import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { canonicalizeEditorMarkdown } from "./embeds.ts";
import {
  buildOffsetMap,
  isPlainMappedOffset,
  mapThrough,
  markdownEquivalent,
  mdToPm,
  pmToMd,
} from "./markdown-pm-map.ts";

function editorFor(markdown: string): Editor {
  return new Editor({
    content: markdown,
    contentType: "markdown",
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown,
    ],
  });
}

function textPos(editor: Editor, text: string, offset = 0): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1 || !node.isText || node.text !== text) {
      return;
    }
    found = pos + offset;
  });
  assert.notEqual(found, -1, `missing text ${text}`);
  return found;
}

test("mapThrough uses 1:1 spans and snaps markdown syntax forward", () => {
  const points = [
    { md: 0, pm: 0 },
    { md: 2, pm: 1 },
    { md: 7, pm: 6 },
  ];
  assert.equal(mapThrough(points, 3, "pm", "md"), 4);
  assert.equal(mapThrough(points, 0, "md", "pm"), 1);
  assert.equal(mapThrough(points, 1, "md", "pm"), 1);
});

test("heading and following paragraph map to visible text", () => {
  const markdown = "# Hello\n\nWorld";
  const editor = editorFor(markdown);
  const map = buildOffsetMap(editor.state.doc, markdown);
  const hello = textPos(editor, "Hello");
  const world = textPos(editor, "World");

  assert.equal(pmToMd(map, hello), 2);
  assert.equal(pmToMd(map, hello + 5), 7);
  assert.equal(pmToMd(map, world), 9);
  assert.equal(mdToPm(map, 2), hello);
  assert.equal(mdToPm(map, 0), hello);
  assert.equal(mdToPm(map, 1), hello);
  assert.equal(mdToPm(map, 9), world);
  editor.destroy();
});

test("bold marks do not shift the mapped text", () => {
  const markdown = "**bold** word";
  const editor = editorFor(markdown);
  const map = buildOffsetMap(editor.state.doc, markdown);
  const bold = textPos(editor, "bold");
  const word = textPos(editor, " word");

  assert.equal(pmToMd(map, bold), 2);
  assert.equal(mdToPm(map, 2), bold);
  assert.equal(pmToMd(map, word), markdown.indexOf(" word"));
  editor.destroy();
});

test("list markers map to the item text", () => {
  const markdown = "- alpha\n- beta";
  const editor = editorFor(markdown);
  const map = buildOffsetMap(editor.state.doc, markdown);
  const alpha = textPos(editor, "alpha");
  const beta = textPos(editor, "beta");

  assert.equal(pmToMd(map, alpha), markdown.indexOf("alpha"));
  assert.equal(pmToMd(map, beta), markdown.indexOf("beta"));
  assert.equal(mdToPm(map, markdown.indexOf("-")), alpha);
  editor.destroy();
});

test("markdownEquivalent ignores youtube default attrs and shorthand", () => {
  const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const source = `![youtube](${url})\n`;
  const editor = `:::youtube {src="${url}" width="640" height="360" start="0"} :::`;
  assert.equal(markdownEquivalent(source, editor), true);
  assert.equal(markdownEquivalent(source, url), true);
  assert.equal(canonicalizeEditorMarkdown(editor), url);
});

test("markdownEquivalent keeps real text changes distinct", () => {
  assert.equal(markdownEquivalent("# 無題\n", "# 無題\n\n追記"), false);
});

test("fence info offsets are not 1:1 with code text", () => {
  const markdown = "```typescript:hoge.ts\nconst x = 1\n```\n";
  const editor = editorFor(markdown);
  const map = buildOffsetMap(editor.state.doc, markdown);
  const fenceInfo = markdown.indexOf("typescript:hoge.ts");
  const code = markdown.indexOf("const");
  assert.equal(isPlainMappedOffset(map, fenceInfo), false);
  assert.equal(isPlainMappedOffset(map, code), true);
  editor.destroy();
});
