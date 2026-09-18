import type { WikiLinkMap } from "@miyulabmd/markdown";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import {
  extractNoteToc,
  headingAnchorForLine,
  shouldShowPreviewToc,
  type TocEntry,
} from "../../lib/note-toc.ts";
import type { ImageViewContext } from "../../lib/preview-images.ts";
import {
  documentColumnWidthClass,
  documentViewColumnClass,
  documentViewShellClass,
} from "../ui/prose.ts";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

type Props = {
  markdown: string;
  className?: string;
  scrollRatio?: number;
  onScrollRatio?: (ratio: number) => void;
  documentScroll?: boolean;
  taskNoteId?: string;
  imageContext?: ImageViewContext;
  /** 1-based source line to scroll toward (jumps to the heading above it). */
  focusLine?: number;
  wikiLinks?: WikiLinkMap;
};

function TocNav({ entries }: { entries: TocEntry[] }) {
  if (entries.length === 0) {
    return null;
  }

  function handleClick(id: string) {
    const target = document.getElementById(id);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav
      aria-label="目次"
      className="sticky top-[calc(var(--header-height)+1.5rem)] max-h-[calc(var(--app-height,100dvh)-var(--header-height)-2rem)] w-48 shrink-0 self-start overflow-y-auto pt-2 text-sm"
    >
      <p className="m-0 mb-3 font-semibold text-ink">目次</p>
      <ol className="m-0 list-none space-y-1.5 p-0">
        {entries.map((entry) => (
          <li
            className={cn(
              entry.level === 2 && "pl-3",
              entry.level === 3 && "pl-6",
            )}
            key={entry.id}
          >
            <button
              className="w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-muted no-underline hover:text-accent"
              onClick={() => handleClick(entry.id)}
              type="button"
            >
              {entry.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PreviewWithToc({
  markdown,
  className,
  scrollRatio,
  onScrollRatio,
  documentScroll = true,
  taskNoteId,
  imageContext,
  focusLine,
  wikiLinks,
}: Props) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [showToc, setShowToc] = useState(false);
  const deferredMarkdown = useDeferredValue(markdown);
  const entries = useMemo(
    () => extractNoteToc(deferredMarkdown),
    [deferredMarkdown],
  );

  useEffect(() => {
    if (focusLine == null || entries.length === 0) {
      return;
    }
    const anchor = headingAnchorForLine(entries, focusLine);
    const frame = window.requestAnimationFrame(() => {
      const target = anchor ? document.getElementById(anchor) : null;
      if (target) {
        target.scrollIntoView({ block: "start" });
      } else {
        window.scrollTo({ top: 0 });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries, focusLine]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1200px)");

    function update() {
      const width = layoutRef.current?.clientWidth ?? window.innerWidth;
      setShowToc(media.matches && shouldShowPreviewToc(width));
    }

    update();
    media.addEventListener("change", update);
    const observer = layoutRef.current ? new ResizeObserver(update) : null;
    observer?.observe(layoutRef.current as Element);

    return () => {
      media.removeEventListener("change", update);
      observer?.disconnect();
    };
  }, []);

  const columnClass = cn(documentViewColumnClass, className);

  return (
    <div
      className="relative w-full [[data-layout=editor]_&]:min-h-[calc(var(--app-height,100dvh)-var(--header-height))]"
      ref={layoutRef}
    >
      <div
        className={cn(
          documentViewShellClass,
          "[[data-layout=editor]_&]:min-h-[calc(var(--app-height,100dvh)-var(--header-height))]",
        )}
      >
        <MarkdownPreview
          className={columnClass}
          documentScroll={documentScroll}
          imageContext={imageContext}
          markdown={markdown}
          onScrollRatio={onScrollRatio}
          scrollRatio={scrollRatio}
          taskNoteId={taskNoteId}
          wikiLinks={wikiLinks}
        />
      </div>
      {showToc && entries.length > 0 && (
        <div className="pointer-events-none absolute inset-0 flex justify-center">
          <div className={cn("relative h-full", documentColumnWidthClass)}>
            <div className="pointer-events-auto absolute inset-y-0 left-full ml-8">
              <TocNav entries={entries} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
