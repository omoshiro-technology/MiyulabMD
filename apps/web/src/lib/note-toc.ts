import { splitMarkdownFrontmatter } from "@miyulabmd/shared";
import GithubSlugger from "github-slugger";

/** Matches rehype-sanitize default `clobberPrefix`. */
export const TOC_ID_PREFIX = "user-content-";

export type TocEntry = {
  level: 1 | 2 | 3;
  text: string;
  id: string;
  /** 1-based line in the source markdown (frontmatter included). */
  line: number;
};

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

const FRONTMATTER_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

/** First line index after a closed frontmatter block, or 0. */
function bodyStartIndex(markdown: string, lines: readonly string[]): number {
  const split = splitMarkdownFrontmatter(markdown);
  if (split.raw === null || split.unclosed) {
    return 0;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_FENCE.test(lines[index] ?? "")) {
      return index + 1;
    }
  }
  return 0;
}

function headingMatch(
  trimmed: string,
): { level: 1 | 2 | 3; text: string } | null {
  const match = /^(#{1,3})\s+(.+?)\s*(?:#+\s*)?$/.exec(trimmed);
  if (!(match?.[1] && match[2])) {
    return null;
  }
  const text = stripInlineMarkdown(match[2]);
  if (!text) {
    return null;
  }
  return { level: match[1].length as 1 | 2 | 3, text };
}

export function extractNoteToc(markdown: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  const lines = markdown.replace(/^﻿/, "").split(/\r?\n/);
  // Line numbers are relative to the full document so they line up with the
  // markdown_snapshot positions that grep results report.
  const startIndex = bodyStartIndex(markdown, lines);

  let inFence = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = headingMatch(trimmed);
    if (heading) {
      entries.push({
        id: `${TOC_ID_PREFIX}${slugger.slug(heading.text)}`,
        level: heading.level,
        line: index + 1,
        text: heading.text,
      });
    }
  }

  return entries;
}

/** Anchor id of the heading at or before `line`, or null when none precedes. */
export function headingAnchorForLine(
  entries: readonly TocEntry[],
  line: number,
): string | null {
  let found: TocEntry | null = null;
  for (const entry of entries) {
    if (entry.line > line) {
      break;
    }
    found = entry;
  }
  return found?.id ?? null;
}

/** Room for a sticky TOC beside the capped preview card without overlapping it. */
export function shouldShowPreviewToc(
  viewportWidth: number,
  options?: {
    minViewportPx?: number;
    tocWidthRem?: number;
    cardMaxRem?: number;
  },
): boolean {
  const minViewportPx = options?.minViewportPx ?? 1200;
  const tocWidthRem = options?.tocWidthRem ?? 12;
  const cardMaxRem = options?.cardMaxRem ?? 46;
  const horizontalPaddingPx = 32;
  const gapPx = 32;
  const cardMaxPx = cardMaxRem * 16;
  const cardWidthPx = Math.min(viewportWidth - horizontalPaddingPx, cardMaxPx);
  const atCap = cardWidthPx >= cardMaxPx - 1;

  if (!atCap || viewportWidth < minViewportPx) {
    return false;
  }

  const groupWidthPx =
    cardWidthPx + gapPx + tocWidthRem * 16 + horizontalPaddingPx;
  return viewportWidth >= groupWidthPx;
}
