import { parseWikiLinkInner } from "@miyulabmd/shared";

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  data?: Record<string, unknown>;
};
type File = {
  data: Record<string, unknown>;
};

/**
 * Resolution map for `[[target]]` keys: note UUID when resolved,
 * null when missing/ambiguous/not viewable.
 */
export type WikiLinkMap = Map<string, string | null>;

const WIKI_LINK_RE = /\[\[([^\][\n]+)\]\]/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function linkNodeFor(
  raw: string,
  inner: NonNullable<ReturnType<typeof parseWikiLinkInner>>,
  links: WikiLinkMap,
): Node {
  const noteId = links.get(inner.target);
  if (!noteId) {
    return {
      type: "html",
      value: `<span class="wikilink-missing">[[${escapeHtml(raw)}]]</span>`,
    };
  }
  const fragment = inner.heading ? `#${encodeURIComponent(inner.heading)}` : "";
  return {
    children: [{ type: "text", value: inner.display ?? raw }],
    data: { hProperties: { className: "wikilink" } },
    type: "link",
    url: `/n/${noteId}${fragment}`,
  };
}

function splitText(node: Node, links: WikiLinkMap): Node[] {
  const value = node.value ?? "";
  const out: Node[] = [];
  let last = 0;
  WIKI_LINK_RE.lastIndex = 0;
  let match = WIKI_LINK_RE.exec(value);
  while (match) {
    const inner = parseWikiLinkInner(match[1] ?? "");
    if (inner) {
      if (match.index > last) {
        out.push({ type: "text", value: value.slice(last, match.index) });
      }
      out.push(linkNodeFor(match[1] ?? "", inner, links));
      last = match.index + match[0].length;
    }
    match = WIKI_LINK_RE.exec(value);
  }
  if (out.length === 0) {
    return [node];
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

function visit(node: Node, links: WikiLinkMap): void {
  if (!Array.isArray(node.children)) {
    return;
  }
  if (node.type === "link") {
    return;
  }
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("[[")) {
      next.push(...splitText(child, links));
    } else {
      visit(child, links);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * Rewrites `[[wiki links]]` in text nodes using the resolution map passed via
 * `file.data.wikiLinks`. Code blocks / inline code are not text nodes, so they
 * are ignored for free. Without a map the syntax is left literal.
 */
export function remarkWikiLinks() {
  return (tree: Node, file: File) => {
    const links = file.data.wikiLinks as WikiLinkMap | undefined;
    if (!links) {
      return;
    }
    visit(tree, links);
  };
}
