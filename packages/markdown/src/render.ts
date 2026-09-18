import { markdownBody } from "@miyulabmd/shared";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import {
  rehypeCodeFilename,
  rehypeCodeFilenameWrap,
  remarkFenceInfo,
} from "./code-filename.ts";
import {
  expandEmbedsForPreview,
  normalizeEmbedMarkdown,
  type OgPreview,
} from "./embeds.ts";
import {
  rehypeTaskCheckboxes,
  remarkTaskCheckboxes,
} from "./task-list-render.ts";
import { remarkWikiLinks, type WikiLinkMap } from "./wikilinks.ts";

const TABLE_TAGS = [
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "colgroup",
  "col",
] as const;

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: ["href", "target", "rel", "className"],
    code: ["className", "dataFilename"],
    div: ["className"],
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    iframe: [
      "src",
      "title",
      "allow",
      "allowFullScreen",
      "loading",
      "width",
      "height",
    ],
    img: ["src", "alt"],
    pre: ["className"],
    span: ["className"],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "iframe",
    "small",
    ...TABLE_TAGS,
  ],
};

function createProcessor(render: boolean) {
  const configured = remark()
    .use(remarkGfm)
    .use(remarkFenceInfo)
    .use(remarkTaskCheckboxes)
    .use(remarkWikiLinks)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);

  if (render) {
    configured
      .use(rehypeCodeFilename)
      .use(rehypeHighlight)
      .use(rehypeCodeFilenameWrap)
      .use(rehypeSlug);
  }

  configured.use(rehypeSanitize, schema).use(rehypeTaskCheckboxes);
  if (render) {
    configured.use(rehypeStringify);
  }
  return configured;
}

const processor = createProcessor(true);
const imageProcessor = createProcessor(false);

function collectImageNodes(node: unknown, urls: Set<string>): void {
  if (!node || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "element" && record.tagName === "img") {
    const properties = record.properties;
    if (properties && typeof properties === "object") {
      const src = (properties as Record<string, unknown>).src;
      if (typeof src === "string" && src) {
        urls.add(src);
      }
    }
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      collectImageNodes(child, urls);
    }
  }
}

/** Collect image destinations using the same Markdown and sanitization rules as rendering. */
export function collectImageUrls(markdown: string): string[] {
  const normalized = normalizeEmbedMarkdown(markdownBody(markdown));
  const tree = imageProcessor.runSync(imageProcessor.parse(normalized));
  const urls = new Set<string>();
  collectImageNodes(tree, urls);
  return [...urls];
}

/** Sync HTML for View / Worker SSR. Does not fetch OGP. */
export function renderMarkdownHtml(
  markdown: string,
  cards: Map<string, OgPreview> = new Map(),
  wikiLinks?: WikiLinkMap,
): string {
  const expanded = expandEmbedsForPreview(
    normalizeEmbedMarkdown(markdownBody(markdown)),
    cards,
  );
  return String(
    processor.processSync({
      data: { taskSource: markdown, wikiLinks },
      value: expanded,
    }),
  );
}
