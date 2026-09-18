import { indentWithTab, toggleTabFocusMode } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
} from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import * as Y from "yjs";
import { uploadImage } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import type { CollabAwareness } from "../../lib/collaboration.ts";
import {
  indentTabSize,
  indentUnitText,
  readIndentUnit,
  readTabKeyMode,
} from "../../lib/editor-tab.ts";
import { readEditorScrollPadPx } from "../../lib/visual-viewport.ts";
import { wikilinkCompletion } from "../../lib/wikilink-complete.ts";
import "../../styles/cm-highlight.css";
import { ContextMenu } from "../notes/ContextMenu.tsx";
import { FileInput } from "../ui/FileInput.tsx";
import {
  markdownEditorHighlight,
  markdownEditorLanguage,
} from "./cmMarkdownExtensions.ts";

type Props = {
  noteId: string;
  yText: Y.Text;
  awareness: CollabAwareness;
  readOnly?: boolean;
  lineNumbers?: boolean;
  scrollRatio?: number;
  onScrollRatio?: (ratio: number) => void;
  /** 1-based source line to scroll into view (e.g. from search results). */
  focusLine?: number;
};

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function imageFileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) {
    return null;
  }

  for (const item of data.items) {
    if (item.kind === "file" && IMAGE_TYPES.has(item.type)) {
      const file = item.getAsFile();
      if (file) {
        return file;
      }
    }
  }

  return null;
}

function imageFileFromDataTransfer(data: DataTransfer | null): File | null {
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

function dataTransferHasImage(data: DataTransfer | null): boolean {
  return imageFileFromDataTransfer(data) !== null;
}

function insertMarkdownImage(view: EditorView, yText: Y.Text, url: string) {
  if (view.state.readOnly) {
    return;
  }
  const markdown = `![](${url})`;
  const pos = view.state.selection.main.head;
  yText.insert(pos, markdown);
  const nextPos = pos + markdown.length;
  view.dispatch({
    selection: { anchor: nextPos, head: nextPos },
  });
}

function imageUploadHandlers(
  noteId: string,
  yText: Y.Text,
  isReadOnly: () => boolean,
  onContextMenu: (event: MouseEvent, view: EditorView) => void,
) {
  async function handleImageFile(view: EditorView, file: File) {
    if (isReadOnly()) {
      return;
    }
    const result = await uploadImage(noteId, file);
    if (!result.ok) {
      console.error("image upload failed:", result.error);
      return;
    }
    if (!isReadOnly() && view.dom.isConnected) {
      insertMarkdownImage(view, yText, result.data.url);
    }
  }

  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (isReadOnly()) {
        return false;
      }
      event.preventDefault();
      const coords = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (coords != null) {
        view.dispatch({ selection: { anchor: coords, head: coords } });
      }
      onContextMenu(event, view);
      return true;
    },
    dragover(event) {
      if (isReadOnly()) {
        return false;
      }
      if (!dataTransferHasImage(event.dataTransfer)) {
        return false;
      }
      event.preventDefault();
      return true;
    },
    drop(event, view) {
      if (isReadOnly()) {
        return false;
      }
      const file = imageFileFromDataTransfer(event.dataTransfer);
      if (!file) {
        return false;
      }

      event.preventDefault();
      void handleImageFile(view, file);
      return true;
    },
    paste(event, view) {
      if (isReadOnly()) {
        return false;
      }
      const file = imageFileFromClipboard(event.clipboardData);
      if (!file) {
        return false;
      }

      event.preventDefault();
      void handleImageFile(view, file);
      return true;
    },
  });
}

function scrollRatioFrom(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : el.scrollTop / max;
}

function applyScrollRatio(el: HTMLElement, ratio: number) {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) {
    return;
  }
  el.scrollTop = max * ratio;
}

function editingExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

// Tab = indent while focused. CodeMirror's built-in hatch applies: Escape
// grants Tab back to the browser for ~2s, and Ctrl-M toggles focus mode.
function tabKeyExtensions() {
  if (readTabKeyMode() === "focus") {
    return [];
  }
  const unit = readIndentUnit();
  return [
    EditorState.tabSize.of(indentTabSize(unit)),
    indentUnit.of(indentUnitText(unit)),
    keymap.of([indentWithTab, { key: "Ctrl-m", run: toggleTabFocusMode }]),
  ];
}

export function MarkdownEditor({
  noteId,
  yText,
  awareness,
  readOnly = false,
  lineNumbers: showLineNumbers = false,
  scrollRatio,
  onScrollRatio,
  focusLine,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onContextMenuRef = useRef<
    (event: MouseEvent, view: EditorView) => void
  >(() => undefined);
  const onScrollRatioRef = useRef(onScrollRatio);
  const readOnlyRef = useRef(readOnly);
  const editing = useRef(new Compartment());
  const applyingScroll = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  onContextMenuRef.current = (event) => {
    setMenu({ x: event.clientX, y: event.clientY });
  };
  onScrollRatioRef.current = onScrollRatio;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const undoManager = new Y.UndoManager(yText);
    // y-codemirror's undo commands mutate Y.Text before a CM transaction, so
    // guard the manager as well as local CodeMirror document transactions.
    const undo = undoManager.undo.bind(undoManager);
    const redo = undoManager.redo.bind(undoManager);
    undoManager.undo = () => (readOnlyRef.current ? null : undo());
    undoManager.redo = () => (readOnlyRef.current ? null : redo());

    const state = EditorState.create({
      doc: yText.toString(),
      extensions: [
        ...tabKeyExtensions(),
        markdownEditorLanguage,
        wikilinkCompletion(),
        ...markdownEditorHighlight,
        ...(showLineNumbers
          ? [lineNumbers(), highlightActiveLineGutter()]
          : []),
        highlightActiveLine(),
        scrollPastEnd(),
        EditorView.scrollMargins.of((view) => {
          const pad = readEditorScrollPadPx(view.dom);
          return { bottom: pad, top: pad };
        }),
        EditorView.lineWrapping,
        EditorView.theme({
          ".cm-activeLine": {
            backgroundColor: "var(--color-preview)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--cm-gutter-active-bg)",
          },
          ".cm-content": { caretColor: "var(--color-ink)" },
          ".cm-gutters": {
            backgroundColor: "var(--cm-gutter-bg)",
            borderRight: "1px solid var(--color-border)",
            color: "var(--color-muted)",
          },
          ".cm-line": { caretColor: "var(--color-ink)" },
          "&": {
            backgroundColor: "var(--color-canvas)",
            color: "var(--color-ink)",
          },
        }),
        yCollab(yText, awareness, { undoManager }),
        EditorView.contentAttributes.of({ tabindex: "0" }),
        editing.current.of(editingExtensions(readOnlyRef.current)),
        EditorState.transactionFilter.of((transaction) =>
          readOnlyRef.current &&
          transaction.docChanged &&
          !transaction.annotation(ySyncAnnotation)
            ? []
            : transaction,
        ),
        imageUploadHandlers(
          noteId,
          yText,
          () => readOnlyRef.current,
          (event, view) => {
            onContextMenuRef.current(event, view);
          },
        ),
        EditorView.domEventHandlers({
          scroll(_event, view) {
            if (applyingScroll.current) {
              return false;
            }
            onScrollRatioRef.current?.(scrollRatioFrom(view.scrollDOM));
            return false;
          },
        }),
      ],
    });

    const view = new EditorView({ parent: container, state });
    viewRef.current = view;

    return () => {
      view.destroy();
      undoManager.destroy();
      viewRef.current = null;
    };
  }, [noteId, yText, awareness, showLineNumbers]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: editing.current.reconfigure(editingExtensions(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || focusLine == null) {
      return;
    }
    const target = Math.min(Math.max(1, focusLine), view.state.doc.lines);
    const pos = view.state.doc.line(target).from;
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      selection: { anchor: pos, head: pos },
    });
  }, [focusLine]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || scrollRatio == null) {
      return;
    }
    if (Math.abs(scrollRatioFrom(view.scrollDOM) - scrollRatio) < 0.004) {
      return;
    }
    applyingScroll.current = true;
    applyScrollRatio(view.scrollDOM, scrollRatio);
    const timer = window.requestAnimationFrame(() => {
      applyingScroll.current = false;
    });
    return () => window.cancelAnimationFrame(timer);
  }, [scrollRatio]);

  async function uploadAtCursor(file: File) {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) {
      return;
    }
    const result = await uploadImage(noteId, file);
    if (!result.ok) {
      console.error("image upload failed:", result.error);
      return;
    }
    if (!readOnlyRef.current && viewRef.current === view) {
      insertMarkdownImage(view, yText, result.data.url);
    }
  }

  return (
    <>
      <div
        className={cn(
          "min-h-96 overflow-hidden rounded-md border border-border",
          "[[data-layout=editor]_&]:h-full [[data-layout=editor]_&]:min-h-0 [[data-layout=editor]_&]:rounded-none [[data-layout=editor]_&]:border-0",
          "[&_.cm-editor]:h-full [&_.cm-editor]:min-h-96 [[data-layout=editor]_&_.cm-editor]:min-h-0",
          "[&_.cm-scroller]:font-mono [&_.cm-scroller]:text-[0.95rem]",
          "[&_.cm-editor]:caret-ink [&_.cm-content]:caret-ink [&_.cm-line]:caret-ink",
          "[&_.cm-cursor]:!border-l-ink [&_.cm-cursor-primary]:!border-l-ink",
          "[&_.cm-ySelectionInfo]:!opacity-100 [&_.cm-ySelectionInfo]:![transition-delay:0s]",
          "[&_.cm-ySelectionCaret]:border-x-2",
        )}
        ref={containerRef}
      />
      <FileInput
        accept={[...IMAGE_TYPES].join(",")}
        aria-label="画像をアップロード"
        disabled={readOnly}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void uploadAtCursor(file);
          }
        }}
        ref={fileInputRef}
      />
      {menu && !readOnly && (
        <ContextMenu
          items={[
            {
              label: "画像をアップロード",
              onSelect: () => fileInputRef.current?.click(),
            },
          ]}
          onClose={() => setMenu(null)}
          x={menu.x}
          y={menu.y}
        />
      )}
    </>
  );
}
