import { env } from "cloudflare:workers";
import {
  isSearchScope,
  layerFilterValue,
  type WorkspaceSearchResult,
} from "@miyulabmd/shared";
import { Elysia } from "elysia";

import { readSession } from "../auth/session.ts";
import { createNoteService } from "../services/notes.ts";
import { folderIdsForSchemeId } from "../services/schemes.ts";
import { GREP_LIMITS } from "../services/search.ts";

const notes = createNoteService(env);

type RouteSet = { status?: number | string };

function emptyResult(query: string): WorkspaceSearchResult {
  return {
    grep: { matches: [], scannedNotes: 0, truncated: false },
    notes: [],
    query,
  };
}

/**
 * schemeId（`15.22` 等）が指定されたら owner 配下のフォルダ UUID に解決する。
 * 同一 ID が別スキームツリーに存在し得るため複数件を返しうる。
 */
async function folderIdParam(
  url: URL,
  user: { id: string } | null,
): Promise<{ folderIds?: string[]; notFound?: boolean }> {
  const schemeId = url.searchParams.get("schemeId");
  if (!schemeId) {
    const folderId = url.searchParams.get("folderId");
    return { folderIds: folderId ? [folderId] : undefined };
  }
  if (!user) {
    return { notFound: true };
  }
  const folderIds = await folderIdsForSchemeId(env, user.id, schemeId);
  return folderIds.length > 0 ? { folderIds } : { notFound: true };
}

function intParam(
  url: URL,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(Math.trunc(value), max));
}

export const searchRoutes = new Elysia({ prefix: "/api/search" })
  .get("/", async ({ request }) => {
    const user = await readSession(request, env);
    const url = new URL(request.url);
    const query = (
      url.searchParams.get("query") ??
      url.searchParams.get("q") ??
      ""
    ).trim();
    if (!query) {
      return emptyResult(query);
    }
    const context = intParam(url, "context", 1, GREP_LIMITS.maxContext);
    return notes.searchWorkspace(user ?? undefined, query, {
      contextAfter: context,
      contextBefore: context,
    });
  })
  .get(
    "/notes",
    async ({ request, set }: { request: Request; set: RouteSet }) => {
      const user = await readSession(request, env);
      const url = new URL(request.url);
      const query = (url.searchParams.get("query") ?? "").trim();
      if (!query) {
        set.status = 400;
        return { error: "query is required" };
      }
      const scopeParam = url.searchParams.get("scope");
      const scope =
        scopeParam && isSearchScope(scopeParam) ? scopeParam : undefined;
      const layerParam = url.searchParams.get("layer");
      // §2.6: medallion layer key or `set.key` (same grammar as `layer:`).
      const layer =
        layerParam && layerFilterValue(layerParam) ? layerParam : undefined;
      const target = await folderIdParam(url, user);
      if (target.notFound) {
        set.status = 404;
        return { error: "Not found" };
      }
      const result = await notes.searchNotes(user ?? undefined, {
        cursor: url.searchParams.get("cursor") ?? undefined,
        folderIds: target.folderIds,
        layer,
        limit: intParam(url, "limit", 50, 200),
        query,
        scope,
      });
      if (result.kind === "not_found") {
        set.status = 404;
        return { error: "Not found" };
      }
      return { nextCursor: result.nextCursor, notes: result.notes, query };
    },
  )
  .get(
    "/grep",
    async ({ request, set }: { request: Request; set: RouteSet }) => {
      const user = await readSession(request, env);
      const url = new URL(request.url);
      const pattern = url.searchParams.get("pattern") ?? "";
      const target = await folderIdParam(url, user);
      if (target.notFound) {
        set.status = 404;
        return { error: "Not found" };
      }
      const result = await notes.grep(user ?? undefined, {
        caseSensitive: url.searchParams.get("caseSensitive") === "true",
        contextAfter: intParam(url, "contextAfter", 1, GREP_LIMITS.maxContext),
        contextBefore: intParam(
          url,
          "contextBefore",
          1,
          GREP_LIMITS.maxContext,
        ),
        fixedString: url.searchParams.get("fixedString") !== "false",
        folderIds: target.folderIds,
        globTitle: url.searchParams.get("globTitle") ?? undefined,
        maxMatchesPerNote: intParam(
          url,
          "maxMatchesPerNote",
          10,
          GREP_LIMITS.maxMatchesPerNote,
        ),
        maxNotes: intParam(url, "maxNotes", 50, GREP_LIMITS.maxNotes),
        pattern,
      });
      if (result.kind === "not_found") {
        set.status = 404;
        return { error: "Not found" };
      }
      if (result.kind === "bad_request") {
        set.status = 400;
        return { error: result.error };
      }
      const { kind: _kind, ...grep } = result;
      return grep;
    },
  );
