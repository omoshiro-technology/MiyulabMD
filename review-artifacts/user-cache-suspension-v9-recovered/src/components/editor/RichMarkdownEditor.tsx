import { markdownBody, withClosedFrontmatter } from "@miyulabmd/shared";
import { Extension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { NodeRange } from "@tiptap/extension-node-range";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import Youtube from "@tiptap/extension-youtube";
import { Markdown } from "@tiptap/markdown";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type * as Y from "yjs";
import { fetchOgPreview, uploadImage } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import type { CollabAwareness } from "../../lib/collaboration.ts";
import {
  canonicalizeEditorMarkdown,
  normalizeEmbedMarkdown,
  youtubeId,
  youtubeStartSeconds,
} from "../../lib/embeds.ts";
import {
  buildOffsetMap,
  clampPos,
  isPlainMappedOffset,
  markdownEquivalent,
  mdToPm,
  type OffsetMap,
  pmToMd,
} from "../../lib/markdown-pm-map.ts";
import {
  readRemoteMarkdownCursors,
  writeMarkdownCursor,
} from "../../lib/rich-awareness.ts";
import {
  readEditorScrollPadPx,
  scrollDeltaForPaddedRect,
} from "../../lib/visual-viewport.ts";
import {
  applyTextDiff,
  inspectPlainTextDelta,
  type YTextDeltaItem,
} from "../../lib/y-text-diff.ts";
import { FileInput } from "../ui/FileInput.tsx";
import {
  documentScrollPadClass,
  editorLoadingClass,
  richEditorTiptapClass,
} from "../ui/prose.ts";
import { BlockHandle } from "./BlockHandle.tsx";
import { CodeBlockView } from "./CodeBlockView.tsx";
import { AutoLinkCard } from "./extensions/auto-link-card.ts";
import { HighlightedCodeBlock } from "./extensions/code-block.ts";
import { CollabCarets, collabCaretsKey } from "./extensions/collab-carets.ts";
import { OgCard } from "./extensions/og-card.ts";
import { SafeParagraph } from "./extensions/safe-paragraph.ts";
import { LinkModal } from "./LinkModal.tsx";
import { SelectionToolbar } from "./SelectionToolbar.tsx";
import { SlashCommandMenu } from "./SlashCommandMenu.tsx";

type Props = {
  noteId: string;
  yText: Y.Text;
  awareness: CollabAwareness;
  readOnly?: boolean;
};

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function scrollRichSelectionIntoView(view: EditorView): boolean {
  const scroller = view.dom.closest(".rich-editor-content");
  if (!(scroller instanceof HTMLElement)) {
    return false;
  }
  const coords = view.coordsAtPos(view.state.selection.head);
  if (!coords) {
    return false;
  }
  const box = scroller.getBoundingClientRect();
  const delta = scrollDeltaForPaddedRect(
    box.top,
    box.bottom,
    coords.top,
    coords.bottom,
    readEditorScrollPadPx(scroller),
  );
  if (delta !== 0) {
    scroller.scrollTop += delta;
  }
  return true;
}

function firstImageFile(data: DataTransfer | null): File | null {
  if (!data) {
    return null;
  }
  for (const file of data.files) {
    if (IMAGE_TYPES.has(file.type)) {
      return file;
    }
  }
  return null;
}

function editorMarkdown(editor: Editor): string {
  return canonicalizeEditorMarkdown(editor.getMarkdown());
}

function trySurgicalApply(
  editor: Editor,
  map: OffsetMap,
  delta: YTextDeltaItem[],
): boolean {
  const plain = inspectPlainTextDelta(delta);
  if (!plain) {
    return false;
  }

  if (plain.kind === "insert") {
    if (!isPlainMappedOffset(map, plain.index)) {
      return false;
    }
    const pos = clampPos(editor.state.doc, mdToPm(map, plain.index));
    const $pos = editor.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock) {
      return false;
    }
    editor.view.dispatch(
      editor.state.tr
        .insertText(plain.text, pos)
        .setMeta("addToHistory", false),
    );
    return true;
  }

  if (
    !(
      isPlainMappedOffset(map, plain.index) &&
      isPlainMappedOffset(map, plain.index + plain.length)
    )
  ) {
    return false;
  }
  const from = clampPos(editor.state.doc, mdToPm(map, plain.index));
  const to = clampPos(
    editor.state.doc,
    mdToPm(map, plain.index + plain.length),
  );
  if (from === to) {
    return false;
  }
  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(to);
  if ($from.parent !== $to.parent || !$from.parent.isTextblock) {
    return false;
  }
  editor.view.dispatch(
    editor.state.tr.delete(from, to).setMeta("addToHistory", false),
  );
  return true;
}

export function RichMarkdownEditor({
  noteId,
  yText,
  awareness,
  readOnly = false,
}: Props) {
  const applyingRemote = useRef(false);
  const composing = useRef(false);
  const pendingRemote = useRef(false);
  const lastYMarkdown = useRef(yText.toString());
  const mapRef = useRef<OffsetMap | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const refreshMap = useCallback(
    (editor: Editor, markdown = markdownBody(yText.toString())) => {
      mapRef.current = buildOffsetMap(editor.state.doc, markdown);
      return mapRef.current;
    },
    [yText],
  );

  const publishCursor = useCallback(
    (editor: Editor) => {
      const full = yText.toString();
      const body = markdownBody(full);
      const offset = full.length - body.length;
      const map = refreshMap(editor, body);
      writeMarkdownCursor(
        awareness,
        yText,
        pmToMd(map, editor.state.selection.anchor) + offset,
        pmToMd(map, editor.state.selection.head) + offset,
      );
    },
    [awareness, yText, refreshMap],
  );

  const refreshCarets = useCallback(
    (editor: Editor) => {
      refreshMap(editor);
      editor.view.dispatch(editor.state.tr.setMeta(collabCaretsKey, true));
    },
    [refreshMap],
  );

  const applyRemote = useCallback(
    (editor: Editor, delta: YTextDeltaItem[]) => {
      const next = yText.toString();
      const nextBody = markdownBody(next);
      if (markdownEquivalent(editorMarkdown(editor), nextBody)) {
        lastYMarkdown.current = next;
        refreshMap(editor, nextBody);
        return;
      }

      const prevBody = markdownBody(lastYMarkdown.current);
      const map = buildOffsetMap(editor.state.doc, prevBody);
      const mdFrom = pmToMd(map, editor.state.selection.from);
      const mdTo = pmToMd(map, editor.state.selection.to);

      applyingRemote.current = true;
      const surgical =
        nextBody === next ? trySurgicalApply(editor, map, delta) : false;
      if (!surgical) {
        editor.commands.setContent(normalizeEmbedMarkdown(nextBody), {
          contentType: "markdown",
          emitUpdate: false,
        });
        const restored = buildOffsetMap(editor.state.doc, nextBody);
        editor.commands.setTextSelection({
          from: clampPos(editor.state.doc, mdToPm(restored, mdFrom)),
          to: clampPos(editor.state.doc, mdToPm(restored, mdTo)),
        });
      }
      applyingRemote.current = false;
      lastYMarkdown.current = next;
      refreshCarets(editor);
      publishCursor(editor);
    },
    [yText, refreshMap, refreshCarets, publishCursor],
  );

  // Persist the already-accepted ProseMirror state, not new DOM input.
  // Ordinary updates defer this during IME; the writable -> paused boundary
  // must commit it before remote reconciliation can replace the document.
  const commitLocal = useCallback(
    (editor: Editor) => {
      const next = withClosedFrontmatter(
        lastYMarkdown.current || yText.toString(),
        editorMarkdown(editor),
      );
      if (
        markdownEquivalent(lastYMarkdown.current, next) ||
        markdownEquivalent(yText.toString(), next)
      ) {
        lastYMarkdown.current = yText.toString();
        refreshMap(editor);
        return;
      }
      applyTextDiff(yText, next, "rich");
      lastYMarkdown.current = yText.toString();
      refreshMap(editor);
      publishCursor(editor);
    },
    [yText, refreshMap, publishCursor],
  );

  const flushLocal = (editor: Editor) => {
    if (applyingRemote.current || composing.current || readOnlyRef.current) {
      return;
    }
    commitLocal(editor);
  };

  const editor = useEditor({
    content: normalizeEmbedMarkdown(markdownBody(yText.toString())),
    contentType: "markdown",
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: richEditorTiptapClass,
        tabindex: "0",
      },
      handleDOMEvents: {
        compositionend: () => {
          composing.current = false;
          const current = editorRef.current;
          if (current) {
            flushLocal(current);
            if (pendingRemote.current) {
              pendingRemote.current = false;
              applyRemote(current, []);
            }
          }
          return false;
        },
        compositionstart: () => {
          composing.current = true;
          return false;
        },
        keydown: (_view, event) => {
          if (
            readOnlyRef.current &&
            (event.ctrlKey || event.metaKey) &&
            ["z", "y"].includes(event.key.toLowerCase())
          ) {
            // ProseMirror skips editable keymaps when setEditable(false).
            // Do not let the browser's native undo move the retained caret.
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      handleDrop(_view, event) {
        if (readOnlyRef.current) {
          return false;
        }
        const file = firstImageFile(event.dataTransfer);
        if (!file) {
          return false;
        }
        event.preventDefault();
        void insertImageFile(file);
        return true;
      },
      handlePaste(_view, event) {
        if (readOnlyRef.current) {
          return false;
        }
        const file = firstImageFile(event.clipboardData);
        if (!file) {
          return false;
        }
        event.preventDefault();
        void insertImageFile(file);
        return true;
      },
      handleScrollToSelection: scrollRichSelectionIntoView,
      scrollMargin: readEditorScrollPadPx(),
      scrollThreshold: readEditorScrollPadPx(),
    },
    extensions: [
      // setEditable controls DOM input; the transaction filter also rejects
      // commands (including undo and delayed UI callbacks) while paused.
      Extension.create({
        addProseMirrorPlugins() {
          return [
            new Plugin({
              filterTransaction: (transaction) =>
                !(transaction.docChanged && readOnlyRef.current) ||
                applyingRemote.current,
            }),
          ];
        },
        name: "editorReadOnly",
      }),
      StarterKit.configure({
        codeBlock: false,
        dropcursor: {
          color: "var(--color-overlay)",
          width: 2,
        },
        link: { autolink: true, openOnClick: false },
        paragraph: false,
      }),
      HighlightedCodeBlock.extend({
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
      }),
      NodeRange,
      SafeParagraph,
      TableKit.configure({
        table: { resizable: false },
      }),
      Markdown,
      Image,
      Youtube.extend({
        renderMarkdown: (node) => {
          const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
          return src;
        },
      }).configure({
        controls: true,
        height: 360,
        nocookie: true,
        width: 640,
      }),
      OgCard,
      AutoLinkCard,
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node }) => {
          if (node.type.name === "heading") {
            return `見出し ${node.attrs.level}`;
          }
          return "「/」でブロックを挿入";
        },
      }),
      CollabCarets.configure({
        getMap: () => mapRef.current,
        getPeers: () => {
          const full = yText.toString();
          const offset = full.length - markdownBody(full).length;
          return readRemoteMarkdownCursors(awareness, yText).map((peer) => ({
            ...peer,
            anchor: Math.max(0, peer.anchor - offset),
            head: Math.max(0, peer.head - offset),
          }));
        },
      }),
    ],
    immediatelyRender: false,
    onCreate: ({ editor: next }) => {
      editorRef.current = next;
      lastYMarkdown.current = yText.toString();
      refreshMap(next);
    },
    onSelectionUpdate: ({ editor: next }) => {
      if (!applyingRemote.current) {
        publishCursor(next);
      }
    },
    onUpdate: ({ editor: next }) => {
      flushLocal(next);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
    if (editor) {
      refreshMap(editor);
    }
  }, [editor, refreshMap]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const sync = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.local) {
        lastYMarkdown.current = yText.toString();
        return;
      }
      if (composing.current) {
        pendingRemote.current = true;
        return;
      }
      applyRemote(editor, event.delta as YTextDeltaItem[]);
    };

    yText.observe(sync);
    return () => yText.unobserve(sync);
  }, [editor, yText, applyRemote]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const onAwareness = () => refreshCarets(editor);
    awareness.on("change", onAwareness);
    refreshCarets(editor);
    return () => {
      awareness.off("change", onAwareness);
    };
  }, [editor, awareness, refreshCarets]);

  useLayoutEffect(() => {
    if (editor?.isEditable && readOnly) {
      commitLocal(editor);
      composing.current = false;
      if (pendingRemote.current) {
        pendingRemote.current = false;
        applyRemote(editor, []);
      }
    }
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly, commitLocal, applyRemote]);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const [linkModal, setLinkModal] = useState<"card" | "inline" | null>(null);

  async function insertImageFile(file: File) {
    if (readOnlyRef.current || !editor || editor.isDestroyed) {
      return;
    }
    const result = await uploadImage(noteId, file);
    if (result.ok && !readOnlyRef.current && !editor.isDestroyed) {
      editor.chain().focus().setImage({ src: result.data.url }).run();
    }
  }

  function insertYoutube() {
    if (readOnlyRef.current) {
      return;
    }
    const url = window.prompt("YouTube の URL");
    if (!(url && editor) || readOnlyRef.current) {
      return;
    }
    editor
      .chain()
      .focus()
      .setYoutubeVideo({ src: url, start: youtubeStartSeconds(url) })
      .run();
  }

  async function insertStandaloneLink(url: string) {
    if (!editor || readOnlyRef.current || editor.isDestroyed) {
      return;
    }
    if (youtubeId(url)) {
      editor
        .chain()
        .focus()
        .setYoutubeVideo({ src: url, start: youtubeStartSeconds(url) })
        .run();
      return;
    }
    await fetchOgPreview(url);
    if (readOnlyRef.current || editor.isDestroyed) {
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent({ attrs: { href: url }, type: "ogCard" })
      .run();
  }

  function applyInlineLink(url: string) {
    if (!readOnlyRef.current) {
      editor?.chain().focus().setLink({ href: url }).run();
    }
  }

  if (!editor) {
    return <div className={editorLoadingClass}>読み込み中…</div>;
  }

  const commandHandlers = {
    onImage: () => imageInputRef.current?.click(),
    onOgCard: () => setLinkModal("card"),
    onYoutube: insertYoutube,
  };

  return (
    <div className="flex min-h-96 flex-col overflow-hidden [[data-layout=editor]_&]:h-full [[data-layout=editor]_&]:min-h-0">
      <FileInput
        accept={[...IMAGE_TYPES].join(",")}
        aria-label="画像をアップロード"
        disabled={readOnly}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void insertImageFile(file);
          }
        }}
        ref={imageInputRef}
      />
      <EditorContent
        className={cn(
          "rich-editor-content flex min-h-0 flex-1 justify-center overflow-auto",
          documentScrollPadClass,
        )}
        editor={editor}
      />
      {!readOnly && (
        <>
          <SlashCommandMenu editor={editor} handlers={commandHandlers} />
          <BlockHandle editor={editor} handlers={commandHandlers} />
          <SelectionToolbar
            editor={editor}
            onLink={() => setLinkModal("inline")}
          />
        </>
      )}
      {linkModal && !readOnly && (
        <LinkModal
          initial={
            linkModal === "inline"
              ? String(editor.getAttributes("link").href ?? "")
              : ""
          }
          onClose={() => setLinkModal(null)}
          onSubmit={(url) => {
            if (linkModal === "card") {
              void insertStandaloneLink(url);
            } else {
              applyInlineLink(url);
            }
            setLinkModal(null);
          }}
          submitLabel="挿入"
          title={linkModal === "card" ? "リンクカード" : "リンク"}
        />
      )}
    </div>
  );
}
