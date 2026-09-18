import type { FolderChildrenResult, FolderEntry } from "@miyulabmd/shared";

export type ExpansionRequest = "initial" | "more" | "refresh";

export type FolderExpansion = {
  entries: FolderEntry[];
  error: string | null;
  nextCursor: string | null;
  pending: ExpansionRequest | null;
  /** Path of the expanded folder (from the children response). */
  path?: string;
};

export const FOLDER_ENTRIES_PAGE_SIZE = 50;
const FOLDER_ENTRIES_MAX_LIMIT = 200;

function entryKey(entry: FolderEntry): string {
  return `${entry.type}:${entry.id}`;
}

export function startFolderExpansion(
  request: ExpansionRequest,
  previous?: FolderExpansion,
): FolderExpansion {
  return {
    entries: previous?.entries ?? [],
    error: null,
    nextCursor: previous?.nextCursor ?? null,
    pending: request,
  };
}

export function resolveFolderExpansion(
  page: FolderChildrenResult,
  request: ExpansionRequest,
  previous?: FolderExpansion,
): FolderExpansion {
  let entries = page.entries;
  if (request === "more" && previous) {
    const seen = new Set(previous.entries.map(entryKey));
    entries = [
      ...previous.entries,
      ...page.entries.filter((entry) => !seen.has(entryKey(entry))),
    ];
  }
  return {
    entries,
    error: null,
    nextCursor: page.nextCursor,
    path: page.folder.path.join("/"),
    pending: null,
  };
}

export function failFolderExpansion(
  error: string,
  previous?: FolderExpansion,
): FolderExpansion {
  return {
    entries: previous?.entries ?? [],
    error,
    nextCursor: previous?.nextCursor ?? null,
    pending: null,
  };
}

/**
 * Refresh keeps the expanded window stable: one request sized to cover the
 * already-loaded entries instead of collapsing back to the first page.
 */
export function expansionRefreshLimit(expansion: FolderExpansion): number {
  return Math.min(
    Math.max(expansion.entries.length, FOLDER_ENTRIES_PAGE_SIZE),
    FOLDER_ENTRIES_MAX_LIMIT,
  );
}
