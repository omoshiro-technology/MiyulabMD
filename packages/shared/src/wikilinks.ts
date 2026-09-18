import type { NoteSummary } from "./note.ts";

export type NoteLinkType = "wiki" | "md";

export type ParsedNoteLink = {
  type: NoteLinkType;
  /** Resolution key: the [[...]] target text or the /n/{uuid} destination. */
  target: string;
  /** `#見出し` portion of a wiki link, if present. */
  heading: string | null;
  /** `|エイリアス` display text (wiki links only). */
  display: string | null;
  /** UTF-16 offsets into the source markdown. */
  start: number;
  end: number;
};

/** An outgoing link from a note, as stored in the note_links index. */
export type NoteLinkItem = {
  linkType: NoteLinkType;
  target: string;
  heading: string | null;
  display: string | null;
  /** 1-based line in the source markdown. */
  line: number;
  /** Resolved destination; null when missing, ambiguous, or not viewable. */
  note: NoteSummary | null;
};

/** An incoming link to a note. */
export type NoteBacklinkItem = {
  note: NoteSummary;
  linkType: NoteLinkType;
  target: string;
  heading: string | null;
  line: number;
};

export type NoteLinksResult = {
  outgoing: NoteLinkItem[];
  backlinks: NoteBacklinkItem[];
};

/** An unresolved link inside a note the viewer can see. */
export type BrokenLinkItem = {
  note: NoteSummary;
  linkType: NoteLinkType;
  target: string;
  heading: string | null;
  line: number;
};

export type WikiLinkResolution =
  | { status: "resolved"; note: NoteSummary }
  | { status: "ambiguous"; candidates: NoteSummary[] }
  | { status: "missing" };

export const NOTE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WIKI_LINK_RE = /\[\[([^\][\n]+)\]\]/g;
const MD_NOTE_LINK_RE = /\[[^\][\n]*\]\(\s*\/n\/([0-9a-fA-F-]{36})[^)]*\)/g;

function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i += 1) {
    if (chars[i] !== "\n") {
      chars[i] = " ";
    }
  }
}

function maskFences(chars: string[], markdown: string): void {
  let fenceChar = "";
  let fenceLen = 0;
  let pos = 0;
  for (const line of markdown.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const marker = /^(`{3,}|~{3,})/.exec(line.slice(indent))?.[1];
    if (fenceChar === "") {
      if (marker && indent < 4) {
        fenceChar = marker[0] ?? "";
        fenceLen = marker.length;
        blank(chars, pos, pos + line.length);
      }
    } else {
      blank(chars, pos, pos + line.length);
      const closes =
        marker !== undefined &&
        indent < 4 &&
        marker[0] === fenceChar &&
        marker.length >= fenceLen;
      if (closes) {
        fenceChar = "";
      }
    }
    pos += line.length + 1;
  }
}

function maskInlineCode(chars: string[], masked: string): void {
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (masked[i + run] === "`") {
      run += 1;
    }
    const close = masked.indexOf("`".repeat(run), i + run);
    if (close === -1) {
      i += run;
      continue;
    }
    blank(chars, i, close + run);
    i = close + run;
  }
}

/**
 * Copy of the input with fenced code blocks and inline code spans replaced by
 * spaces (offsets preserved), so link syntax inside code is not indexed.
 */
export function maskCodeRegions(markdown: string): string {
  const chars = markdown.split("");
  maskFences(chars, markdown);
  maskInlineCode(chars, chars.join(""));
  return chars.join("");
}

/** Split the inside of `[[...]]` into target / heading / display parts. */
export function parseWikiLinkInner(inner: string): {
  display: string | null;
  heading: string | null;
  target: string;
} | null {
  const pipe = inner.indexOf("|");
  const lhs = pipe === -1 ? inner : inner.slice(0, pipe);
  const display = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
  const hash = lhs.indexOf("#");
  const target = (hash === -1 ? lhs : lhs.slice(0, hash)).trim();
  const heading = hash === -1 ? null : lhs.slice(hash + 1).trim() || null;
  if (!(target || heading)) {
    return null;
  }
  return { display, heading, target };
}

/** Parse `[[wiki links]]` and `[label](/n/{uuid})` note links with offsets. */
export function parseNoteLinks(markdown: string): ParsedNoteLink[] {
  const masked = maskCodeRegions(markdown);
  const links: ParsedNoteLink[] = [];

  for (const match of masked.matchAll(WIKI_LINK_RE)) {
    const inner = parseWikiLinkInner(match[1] ?? "");
    if (!inner) {
      continue;
    }
    links.push({
      ...inner,
      end: match.index + match[0].length,
      start: match.index,
      type: "wiki",
    });
  }

  for (const match of masked.matchAll(MD_NOTE_LINK_RE)) {
    links.push({
      display: null,
      end: match.index + match[0].length,
      heading: null,
      start: match.index,
      target: match[1] ?? "",
      type: "md",
    });
  }

  return links.sort((a, b) => a.start - b.start);
}

/** 1-based line number for a UTF-16 offset into the markdown. */
export function lineForOffset(markdown: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < markdown.length; i += 1) {
    if (markdown.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}
