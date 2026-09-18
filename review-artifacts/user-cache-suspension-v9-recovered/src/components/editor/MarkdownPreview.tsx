import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { loadOgCards, renderMarkdownHtml } from "../../lib/markdown.ts";
import {
  type ImageViewContext,
  resolvePreviewImages,
  usePreviewImages,
} from "../../lib/preview-images.ts";
import { useTaskCheckboxes } from "../../lib/task-checkboxes.ts";
import {
  documentPaneScrollClass,
  documentProseClass,
  documentViewColumnClass,
} from "../ui/prose.ts";

type Props = {
  markdown: string;
  scrollRatio?: number;
  onScrollRatio?: (ratio: number) => void;
  className?: string;
  documentScroll?: boolean;
  taskNoteId?: string;
  imageContext?: ImageViewContext;
};

function scrollRatioFrom(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : el.scrollTop / max;
}

export function MarkdownPreview({
  markdown,
  scrollRatio,
  onScrollRatio,
  className,
  documentScroll = false,
  taskNoteId,
  imageContext,
}: Props) {
  const articleRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const applyingScroll = useRef(false);
  const deferredMarkdown = useDeferredValue(markdown);
  const images = usePreviewImages(deferredMarkdown, imageContext);
  const [enhanced, setEnhanced] = useState<{ md: string; html: string } | null>(
    null,
  );

  const rendered = useMemo(() => {
    try {
      return { error: null, html: renderMarkdownHtml(deferredMarkdown) };
    } catch {
      return { error: "プレビューの生成に失敗しました。", html: "" };
    }
  }, [deferredMarkdown]);

  useEffect(() => {
    let cancelled = false;
    void loadOgCards(markdown).then((cards) => {
      if (cancelled || cards.size === 0) {
        return;
      }
      setEnhanced({
        html: renderMarkdownHtml(markdown, cards),
        md: markdown,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  const sourceHtml = enhanced?.md === markdown ? enhanced.html : rendered.html;
  const html = useMemo(
    () => resolvePreviewImages(sourceHtml, images),
    [sourceHtml, images],
  );
  // Keep React from replacing imperatively updated checkboxes on unrelated renders.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);
  const error = rendered.error;
  const taskUpdates = useTaskCheckboxes(
    articleRef,
    html,
    deferredMarkdown,
    taskNoteId,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reapply the scroll ratio when rendered content changes height.
  useEffect(() => {
    if (documentScroll) {
      return;
    }
    const el = scrollRef.current;
    if (!el || scrollRatio == null) {
      return;
    }
    if (Math.abs(scrollRatioFrom(el) - scrollRatio) < 0.004) {
      return;
    }
    applyingScroll.current = true;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) {
      el.scrollTop = max * scrollRatio;
    }
    const timer = window.requestAnimationFrame(() => {
      applyingScroll.current = false;
    });
    return () => window.cancelAnimationFrame(timer);
  }, [documentScroll, html, scrollRatio]);

  const columnClass = cn(
    "markdown-preview min-h-96",
    documentScroll
      ? cn(
          "[[data-layout=editor]_&]:overflow-visible [[data-layout=editor]_&]:min-h-0",
          className,
        )
      : cn(
          documentViewColumnClass,
          "[[data-layout=editor]_&]:min-h-0",
          className,
        ),
    documentProseClass,
  );

  if (error) {
    if (documentScroll) {
      return (
        <article className={cn(columnClass, "text-error")}>{error}</article>
      );
    }
    return (
      <div
        className={cn(
          documentPaneScrollClass,
          "[[data-layout=editor]_&]:h-full [[data-layout=editor]_&]:min-h-0",
        )}
        ref={scrollRef}
      >
        <article className={cn(columnClass, "text-error")}>{error}</article>
      </div>
    );
  }

  const article = (
    <>
      <article
        className={columnClass}
        // HTML is sanitized before view-owned image URL resolution.
        dangerouslySetInnerHTML={innerHtml}
        ref={articleRef}
      />
      {taskUpdates.error && (
        <div
          className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg border border-border bg-surface p-4 text-ink shadow-lg"
          role="alert"
        >
          <p className="m-0 mb-3">{taskUpdates.error}</p>
          <div className="flex justify-end gap-4">
            <button
              className="cursor-pointer text-muted"
              onClick={taskUpdates.dismissError}
              type="button"
            >
              閉じる
            </button>
            <button
              className="cursor-pointer text-accent"
              onClick={() => window.location.reload()}
              type="button"
            >
              再読み込み
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (documentScroll) {
    return article;
  }

  return (
    <div
      className={cn(
        documentPaneScrollClass,
        "[[data-layout=editor]_&]:h-full [[data-layout=editor]_&]:min-h-0",
      )}
      onScroll={(event) => {
        if (applyingScroll.current) {
          return;
        }
        onScrollRatio?.(scrollRatioFrom(event.currentTarget));
      }}
      ref={scrollRef}
    >
      {article}
    </div>
  );
}
