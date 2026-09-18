import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor, Node } from "@tiptap/core";
import Youtube from "@tiptap/extension-youtube";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import {
  autoLinkCardTransaction,
  expandOgCard,
  paragraphStandaloneHref,
} from "../components/editor/extensions/auto-link-card.ts";
import {
  canonicalizeEditorMarkdown,
  normalizeEmbedMarkdown,
} from "./embeds.ts";

const TestOgCard = Node.create({
  addAttributes() {
    return { href: { default: "" } };
  },
  atom: true,
  group: "block",
  name: "ogCard",
  parseHTML() {
    return [{ tag: "div[data-og-card]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes];
  },
});

const TestYoutube = Node.create({
  addAttributes() {
    return { src: { default: "" }, start: { default: 0 } };
  },
  atom: true,
  group: "block",
  name: "youtube",
  parseHTML() {
    return [{ tag: "div[data-youtube-video]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes];
  },
});

function editorFor(markdown: string): Editor {
  return new Editor({
    content: markdown,
    contentType: "markdown",
    extensions: [
      StarterKit.configure({ link: { autolink: true, openOnClick: false } }),
      Markdown,
    ],
  });
}

function cardEditor(markdown: string): Editor {
  return new Editor({
    content: markdown,
    contentType: "markdown",
    extensions: [
      StarterKit.configure({ link: { autolink: true, openOnClick: false } }),
      Markdown,
      TestOgCard,
      TestYoutube,
    ],
  });
}

test("paragraphStandaloneHref cards a lone URL or link paragraph", () => {
  const url = editorFor("https://example.com/a");
  assert.equal(
    paragraphStandaloneHref(url.state.doc.child(0)),
    "https://example.com/a",
  );

  const titled = editorFor("[Example](https://example.com/a)");
  assert.equal(
    paragraphStandaloneHref(titled.state.doc.child(0)),
    "https://example.com/a",
  );

  const inline = editorFor("see https://example.com/a");
  assert.equal(paragraphStandaloneHref(inline.state.doc.child(0)), null);
  url.destroy();
  titled.destroy();
  inline.destroy();
});

test("paragraphStandaloneHref ignores Firefox trailing hardBreaks", () => {
  const editor = editorFor("hello");
  editor.commands.setContent({
    content: [
      {
        content: [
          { text: "https://example.com/a", type: "text" },
          { type: "hardBreak" },
        ],
        type: "paragraph",
      },
    ],
    type: "doc",
  });
  assert.equal(
    paragraphStandaloneHref(editor.state.doc.child(0)),
    "https://example.com/a",
  );

  editor.commands.setContent({
    content: [
      {
        content: [
          {
            marks: [{ attrs: { href: "https://example.com/a" }, type: "link" }],
            text: "Example\u200B",
            type: "text",
          },
          { type: "hardBreak" },
        ],
        type: "paragraph",
      },
    ],
    type: "doc",
  });
  assert.equal(
    paragraphStandaloneHref(editor.state.doc.child(0)),
    "https://example.com/a",
  );
  editor.destroy();
});

test("autoLinkCardTransaction cards a standalone URL once the caret leaves", () => {
  const editor = cardEditor("https://example.com/a\n\nnext");
  assert.equal(autoLinkCardTransaction(editor.state), null);

  const nextPos = editor.state.doc.child(0).nodeSize + 1;
  editor.commands.setTextSelection(nextPos);
  const tr = autoLinkCardTransaction(editor.state);
  assert.ok(tr);
  editor.view.dispatch(tr);

  assert.equal(editor.state.doc.child(0).type.name, "ogCard");
  assert.equal(editor.state.doc.child(0).attrs.href, "https://example.com/a");
  editor.destroy();
});

test("autoLinkCardTransaction cards a pasted standalone URL in place", () => {
  const editor = cardEditor("https://example.com/a");
  const tr = autoLinkCardTransaction(editor.state, true);
  assert.ok(tr);
  editor.view.dispatch(tr);
  assert.equal(editor.state.doc.child(0).type.name, "ogCard");
  assert.equal(editor.state.doc.child(0).attrs.href, "https://example.com/a");
  editor.destroy();
});

test("autoLinkCardTransaction embeds a standalone YouTube URL", () => {
  const href = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const editor = cardEditor(href);
  const tr = autoLinkCardTransaction(editor.state, true);
  assert.ok(tr);
  editor.view.dispatch(tr);
  assert.equal(editor.state.doc.child(0).type.name, "youtube");
  assert.equal(editor.state.doc.child(0).attrs.src, href);
  assert.equal(editor.state.doc.child(0).attrs.start, 0);
  editor.destroy();
});

test("autoLinkCardTransaction keeps a YouTube start time", () => {
  const href = "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s";
  const editor = cardEditor(href);
  const tr = autoLinkCardTransaction(editor.state, true);
  assert.ok(tr);
  editor.view.dispatch(tr);
  assert.equal(editor.state.doc.child(0).type.name, "youtube");
  assert.equal(editor.state.doc.child(0).attrs.src, href);
  assert.equal(editor.state.doc.child(0).attrs.start, 12);
  editor.destroy();
});

test("youtube node reloads from a URL and serializes back to a URL", () => {
  const href = "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s";
  const editor = new Editor({
    content: normalizeEmbedMarkdown(href),
    contentType: "markdown",
    extensions: [
      StarterKit.configure({ link: { autolink: true, openOnClick: false } }),
      Markdown,
      Youtube.extend({
        renderMarkdown: (node) =>
          typeof node.attrs?.src === "string" ? node.attrs.src : "",
      }),
    ],
  });
  assert.equal(editor.state.doc.child(0).type.name, "youtube");
  assert.equal(editor.state.doc.child(0).attrs.src, href);
  assert.equal(Number(editor.state.doc.child(0).attrs.start), 12);
  assert.equal(canonicalizeEditorMarkdown(editor.getMarkdown()), href);
  editor.destroy();
});

test("expandOgCard turns a card into selected link text", () => {
  const editor = cardEditor("next");
  const href = "https://example.com/a";
  editor.commands.insertContentAt(0, { attrs: { href }, type: "ogCard" });

  let cardPos = -1;
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === "ogCard") {
      cardPos = pos;
    }
  });
  assert.notEqual(cardPos, -1);

  const tr = expandOgCard(editor.state, cardPos);
  assert.ok(tr);
  editor.view.dispatch(tr);

  const paragraph = editor.state.doc.child(0);
  assert.equal(paragraph.type.name, "paragraph");
  assert.equal(paragraph.textContent, href);
  assert.ok(
    paragraph.firstChild?.marks.some((mark) => mark.type.name === "link"),
  );
  assert.equal(editor.state.selection.from, 1);
  assert.equal(editor.state.selection.to, 1 + href.length);
  assert.equal(autoLinkCardTransaction(editor.state), null);
  editor.destroy();
});
