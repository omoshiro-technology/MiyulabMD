import {
  collectStandaloneLinkUrls,
  mapLinesOutsideFences,
  standaloneLinkUrl,
} from "./standalone-link.ts";

export type OgPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
};

const YOUTUBE_IMAGE = /!\[youtube]\((https?:\/\/[^)\s]+)\)/gi;
const OGP_LINK = /\[ogp]\((https?:\/\/[^)\s]+)\)/gi;
const YOUTUBE_BLOCK = /:::youtube\s*\{([^}]*)\}(?:\s*:::)?/g;
const OGP_BLOCK = /:::ogCard\s*\{([^}]*)\}(?:\s*:::)?/g;
const YOUTUBE_ID = /^[\w-]{11}$/;
const YOUTUBE_VIDEO_PATH = /^\/(embed|shorts|live)\/([^/?#]+)/;

export function attr(source: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]+)"`).exec(source);
  return match?.[1] ?? null;
}

function hostnameIs(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function videoId(value: string | null | undefined): string | null {
  return value && YOUTUBE_ID.test(value) ? value : null;
}

export function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (hostnameIs(parsed.hostname, "youtu.be")) {
      return videoId(parsed.pathname.split("/").find(Boolean));
    }
    if (
      !(
        hostnameIs(parsed.hostname, "youtube.com") ||
        hostnameIs(parsed.hostname, "youtube-nocookie.com")
      )
    ) {
      return null;
    }
    if (parsed.pathname === "/watch" || parsed.pathname.startsWith("/watch/")) {
      return videoId(parsed.searchParams.get("v"));
    }
    const path = YOUTUBE_VIDEO_PATH.exec(parsed.pathname);
    return videoId(path?.[2]);
  } catch {
    return null;
  }
}

function parseYoutubeTime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)$/.exec(trimmed);
  if (!match || match[0] === "") {
    return 0;
  }
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}

export function youtubeStartSeconds(url: string): number {
  try {
    const parsed = new URL(url);
    const fromQuery =
      parsed.searchParams.get("start") ?? parsed.searchParams.get("t") ?? "";
    if (fromQuery) {
      return parseYoutubeTime(fromQuery);
    }
    const hash = /^#t=(.+)$/.exec(parsed.hash);
    return hash?.[1] ? parseYoutubeTime(hash[1]) : 0;
  } catch {
    return 0;
  }
}

export function youtubeEmbedUrl(url: string): string | null {
  const id = youtubeId(url);
  if (!id) {
    return null;
  }
  const start = youtubeStartSeconds(url);
  const base = `https://www.youtube-nocookie.com/embed/${id}`;
  return start > 0 ? `${base}?start=${start}` : base;
}

function youtubeBlock(url: string): string {
  const start = youtubeStartSeconds(url);
  return start > 0
    ? `:::youtube {src="${url}" start="${start}"} :::`
    : `:::youtube {src="${url}"} :::`;
}

function ogCardBlock(url: string): string {
  return `:::ogCard {href="${url}"} :::`;
}

function embedBlockForUrl(url: string): string {
  return youtubeId(url) ? youtubeBlock(url) : ogCardBlock(url);
}

export function normalizeEmbedMarkdown(markdown: string): string {
  const withLegacy = markdown
    .replace(YOUTUBE_IMAGE, (_all, url: string) => youtubeBlock(url))
    .replace(OGP_LINK, (_all, url: string) => ogCardBlock(url));
  return mapLinesOutsideFences(withLegacy, (line) => {
    const url = standaloneLinkUrl(line);
    return url ? embedBlockForUrl(url) : line;
  });
}

export function canonicalizeEditorMarkdown(markdown: string): string {
  YOUTUBE_BLOCK.lastIndex = 0;
  OGP_BLOCK.lastIndex = 0;
  return normalizeEmbedMarkdown(markdown)
    .replace(YOUTUBE_BLOCK, (_all, attrs: string) => attr(attrs, "src") ?? "")
    .replace(OGP_BLOCK, (_all, attrs: string) => attr(attrs, "href") ?? "");
}

export function collectOgUrls(markdown: string): string[] {
  const urls = new Set<string>(collectStandaloneLinkUrls(markdown));
  for (const match of markdown.matchAll(OGP_BLOCK)) {
    const href = attr(match[1] ?? "", "href");
    if (href) {
      urls.add(href);
    }
  }
  for (const match of markdown.matchAll(OGP_LINK)) {
    urls.add(match[1] ?? "");
  }
  return [...urls].filter((url) => url && !youtubeId(url));
}

export function renderOgCardHtml(href: string, card?: OgPreview): string {
  const title = card?.title || href;
  const description = card?.description
    ? `<span class="embed-og-desc">${escapeHtml(card.description)}</span>`
    : "";
  const image = card?.image
    ? `<img src="${escapeHtml(card.image)}" alt="" />`
    : "";
  const site = card?.siteName
    ? `<small>${escapeHtml(card.siteName)}</small>`
    : "";
  return `<div class="embed-og-wrap"><a class="embed-og" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${image}<span class="embed-og-body"><strong>${escapeHtml(title)}</strong>${description}${site}</span></a></div>`;
}

function renderYoutubeHtml(src: string): string {
  const embed = youtubeEmbedUrl(src);
  if (!embed) {
    return "";
  }
  return `<div class="embed-youtube"><iframe src="${embed}" title="YouTube" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>`;
}

function renderStandaloneEmbedHtml(
  url: string,
  cards: Map<string, OgPreview>,
): string {
  return youtubeId(url)
    ? renderYoutubeHtml(url)
    : renderOgCardHtml(url, cards.get(url));
}

export function expandEmbedsForPreview(
  markdown: string,
  cards: Map<string, OgPreview>,
): string {
  const normalized = normalizeEmbedMarkdown(markdown);
  const expanded = normalized
    .replace(YOUTUBE_BLOCK, (_all, attrs: string) =>
      renderYoutubeHtml(attr(attrs, "src") ?? ""),
    )
    .replace(OGP_BLOCK, (_all, attrs: string) => {
      const href = attr(attrs, "href") ?? "";
      return renderStandaloneEmbedHtml(href, cards);
    });
  return mapLinesOutsideFences(expanded, (line) => {
    const url = standaloneLinkUrl(line);
    return url ? renderStandaloneEmbedHtml(url, cards) : line;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
