import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { loadOgCards, renderMarkdownHtml } from "../../lib/markdown.ts";
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
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const applyingScroll = useRef(false);
  const deferredMarkdown = useDeferredValue(markdown);
  const [enhanced, setEnhanced] = useState<{ md: string; html: string } | null>(
    null,
  );

  const rendered = useMemo(() => {
    try {
      return { html: renderMarkdownHtml(deferredMarkdown), error: null };
    } catch {
      return { html: "", error: "プレビューの生成に失敗しました。" };
    }
  }, [deferredMarkdown]);

  useEffect(() => {
    let cancelled = false;
    void loadOgCards(markdown).then((cards) => {
      if (cancelled || cards.size === 0) return;
      setEnhanced({
        md: markdown,
        html: renderMarkdownHtml(markdown, cards),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  const html = enhanced?.md === markdown ? enhanced.html : rendered.html;
  const error = rendered.error;

  useEffect(() => {
    if (documentScroll) return;
    const el = scrollRef.current;
    if (!el || scrollRatio == null) return;
    if (Math.abs(scrollRatioFrom(el) - scrollRatio) < 0.004) return;
    applyingScroll.current = true;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = max * scrollRatio;
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
        ref={scrollRef}
        className={cn(
          documentPaneScrollClass,
          "[[data-layout=editor]_&]:h-full [[data-layout=editor]_&]:min-h-0",
        )}
      >
        <article className={cn(columnClass, "text-error")}>{error}</article>
      </div>
    );
  }

  const article = (
    <article
      className={columnClass}
      // HTML は rehype-sanitize 済み。
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );

  if (documentScroll) {
    return article;
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        documentPaneScrollClass,
        "[[data-layout=editor]_&]:h-full [[data-layout=editor]_&]:min-h-0",
      )}
      onScroll={(event) => {
        if (applyingScroll.current) return;
        onScrollRatio?.(scrollRatioFrom(event.currentTarget));
      }}
    >
      {article}
    </div>
  );
}
