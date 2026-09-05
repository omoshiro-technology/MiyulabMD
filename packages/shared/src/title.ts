import { markdownBody } from "./markdown-frontmatter.ts";

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Markdown 本文の最初の見出しをノートタイトルにする。 */
export function titleFromMarkdown(markdown: string): string {
  const body = markdownBody(markdown);
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const atx = ATX_HEADING.exec(lines[i] ?? "");
    if (atx?.[2]) {
      const title = atx[2].trim();
      if (title) return title;
    }

    const current = (lines[i] ?? "").trim();
    const next = lines[i + 1] ?? "";
    if (current && /^=+\s*$/.test(next)) {
      return current;
    }
  }

  return "無題";
}

export function defaultNoteMarkdown(title = "無題"): string {
  return `# ${title}\n`;
}

/** `work/infra` 形式。先頭末尾の / と `..` を除去する。 */
export function normalizeFolder(folder: string | null | undefined): string {
  if (!folder) return "";
  return folder
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
}

export function folderUrl(folderId: string | null | undefined): string {
  if (!folderId) return "/";
  return `/f/${folderId}`;
}

export const MY_DRIVE_NAME = "マイドライブ";
export const SHARED_PATH = "/shared";

export function isDriveRootPath(folder: string | null | undefined): boolean {
  return !folder;
}
