import type { Note } from "@miyulabmd/shared";
import { titleFromMarkdown } from "@miyulabmd/shared";

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function injectNotePage(
  indexHtml: string,
  note: Note,
  previewHtml: string,
  ogCards: Record<string, unknown> = {},
): string {
  const title = titleFromMarkdown(note.markdown) || note.title || "MiyulabMD";
  const preview = `<div id="ssr-preview" class="document-view-shell" data-note-id="${escapeHtml(note.id)}" data-short-id="${escapeHtml(note.shortId)}"><article class="markdown-preview document-prose document-view-column">${previewHtml}</article></div>`;
  const bootstrap = `<script type="application/json" id="note-bootstrap">${jsonForScript(note)}</script>`;
  const ogBootstrap =
    Object.keys(ogCards).length > 0
      ? `<script type="application/json" id="og-bootstrap">${jsonForScript(ogCards)}</script>`
      : "";

  const html = indexHtml.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(title)} · MiyulabMD</title>`,
  );
  if (!html.includes("</body>")) {
    return `${html}${preview}${bootstrap}${ogBootstrap}`;
  }
  return html.replace("</body>", `${preview}${bootstrap}${ogBootstrap}</body>`);
}

export function notePageId(pathname: string): string | null {
  const match = /^\/(?:n|s)\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function isPublicGuestCacheable(note: Note, hasUser: boolean): boolean {
  return (
    !hasUser &&
    (note.access.effectiveReadScope === "public" ||
      note.access.effectiveReadScope === "link")
  );
}
