import {
  type ArticleCollection,
  type ArticleEntry,
  type ArticleEntryPage,
  type ArticleSchemaField,
  type ArticleSource,
  type ArticleSourceStatus,
  articleEditUrl,
  articleMetaFromNote,
  articleSlug,
  folderMatchesSource,
  isArticleSourceDirty,
  mergeArticleData,
  parseArticleSchema,
  readArticleFrontmatter,
  resolveArticleListFolder,
  rewriteFolderPrefix,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import { ensureFolderRow, getFolderById, getFolderByPath } from "./access.ts";

type SourceRow = {
  id: string;
  owner_id: string;
  folder: string;
  folder_id: string | null;
  name: string;
  schema_json: string;
  webhook_url: string | null;
  webhook_authorization: string | null;
  last_dispatched_at: number | null;
  created_at: number;
  updated_at: number;
};

type NoteArticleRow = {
  id: string;
  short_id: string;
  alias: string | null;
  title: string;
  folder: string;
  markdown_snapshot: string;
  article_meta: string | null;
  created_at: number;
  updated_at: number;
};

export type ArticleSourceWrite = {
  name?: string;
  folder?: string;
  folderId?: string | null;
  schema?: unknown;
  webhookUrl?: string | null;
  webhookAuthorization?: string | null;
};

function parseSchemaJson(raw: string): ArticleSchemaField[] {
  try {
    const parsed = parseArticleSchema(JSON.parse(raw) as unknown);
    return "error" in parsed ? [] : parsed;
  } catch {
    return [];
  }
}

function presentSource(row: SourceRow): ArticleSource {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    folderId: row.folder_id,
    schema: parseSchemaJson(row.schema_json),
    webhookUrl: row.webhook_url,
    webhookAuthorizationSet: Boolean(row.webhook_authorization),
    lastDispatchedAt: row.last_dispatched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentCollection(row: SourceRow): ArticleCollection {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    schema: parseSchemaJson(row.schema_json),
  };
}

export function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

async function resolveFolderPath(
  env: Env,
  ownerId: string,
  input: { folder?: string; folderId?: string | null },
): Promise<{ folder: string; folderId: string | null } | { error: string }> {
  if (input.folderId) {
    const rec = await getFolderById(env, input.folderId);
    if (!rec || rec.owner_id !== ownerId) {
      return { error: "フォルダが見つかりません" };
    }
    if (!rec.folder) {
      return { error: "マイドライブは記事ソースにできません" };
    }
    return { folder: rec.folder, folderId: rec.id };
  }
  if (input.folder === undefined) {
    return { error: "folder または folderId が必要です" };
  }
  const folder = input.folder.trim().replace(/^\/+|\/+$/g, "");
  if (!folder) {
    return { error: "マイドライブは記事ソースにできません" };
  }
  const folderId = await ensureFolderRow(env, ownerId, folder);
  return { folder, folderId };
}

async function loadSource(
  env: Env,
  ownerId: string,
  id: string,
): Promise<SourceRow | null> {
  return db(env)
    .prepare("SELECT * FROM article_sources WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
    .first<SourceRow>();
}

export function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/** ソース（または指定パス）直下と、何階層下のノートも含める。 */
export function sourceNoteFilter(folder: string): {
  sql: string;
  binds: string[];
} {
  return {
    sql: "(folder = ? OR folder LIKE ? ESCAPE '\\')",
    binds: [folder, `${escapeLikePattern(folder)}/%`],
  };
}

async function maxNoteUpdatedAt(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<number | null> {
  const filter = sourceNoteFilter(folder);
  const row = await db(env)
    .prepare(
      `SELECT MAX(updated_at) AS max_updated
       FROM notes
       WHERE owner_id = ? AND ${filter.sql}`,
    )
    .bind(ownerId, ...filter.binds)
    .first<{ max_updated: number | null }>();
  return row?.max_updated ?? null;
}

function toEntry(
  row: NoteArticleRow,
  schema: ArticleSchemaField[],
  origin: string,
  includeMarkdown: boolean,
): ArticleEntry {
  const frontmatter = readArticleFrontmatter(row.markdown_snapshot);
  const data = mergeArticleData({
    schema,
    noteMeta: articleMetaFromNote(row.markdown_snapshot, row.article_meta),
    title: row.title,
  });
  const slug = articleSlug(row.alias, row.short_id);
  const entry: ArticleEntry = {
    id: row.id,
    slug,
    title: typeof data.title === "string" ? data.title : row.title,
    folder: row.folder,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data,
    editUrl: articleEditUrl(origin, row.short_id),
  };
  if (includeMarkdown) entry.markdown = frontmatter.body;
  return entry;
}

export function createArticleService(env: Env) {
  return {
    async listSources(ownerId: string): Promise<ArticleSource[]> {
      const rows = await db(env)
        .prepare(
          "SELECT * FROM article_sources WHERE owner_id = ? ORDER BY folder",
        )
        .bind(ownerId)
        .all<SourceRow>();
      return (rows.results ?? []).map(presentSource);
    },

    async getSource(
      ownerId: string,
      id: string,
    ): Promise<ArticleSource | null> {
      const row = await loadSource(env, ownerId, id);
      return row ? presentSource(row) : null;
    },

    async createSource(
      ownerId: string,
      input: ArticleSourceWrite,
    ): Promise<ArticleSource | { error: string; status: number }> {
      const name = input.name?.trim();
      if (!name) return { error: "name が必要です", status: 400 };

      const folder = await resolveFolderPath(env, ownerId, input);
      if ("error" in folder) return { error: folder.error, status: 400 };

      const schema = parseArticleSchema(input.schema ?? []);
      if ("error" in schema) return { error: schema.error, status: 400 };

      const webhookUrl =
        input.webhookUrl === undefined || input.webhookUrl === null
          ? null
          : input.webhookUrl.trim();
      if (webhookUrl && !isAllowedWebhookUrl(webhookUrl)) {
        return {
          error: "webhookUrl は https である必要があります",
          status: 400,
        };
      }
      const webhookAuthorization = input.webhookAuthorization?.trim() || null;

      const existing = await db(env)
        .prepare(
          "SELECT id FROM article_sources WHERE owner_id = ? AND folder = ?",
        )
        .bind(ownerId, folder.folder)
        .first<{ id: string }>();
      if (existing) {
        return { error: "このディレクトリは既に登録されています", status: 409 };
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      await db(env)
        .prepare(
          `INSERT INTO article_sources (
             id, owner_id, folder, folder_id, name, schema_json,
             webhook_url, webhook_authorization, last_dispatched_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .bind(
          id,
          ownerId,
          folder.folder,
          folder.folderId,
          name,
          JSON.stringify(schema),
          webhookUrl,
          webhookAuthorization,
          now,
          now,
        )
        .run();

      const created = await loadSource(env, ownerId, id);
      if (!created) throw new Error("article source insert failed");
      return presentSource(created);
    },

    async updateSource(
      ownerId: string,
      id: string,
      input: ArticleSourceWrite,
    ): Promise<ArticleSource | { error: string; status: number } | null> {
      const row = await loadSource(env, ownerId, id);
      if (!row) return null;

      let folder = row.folder;
      let folderId = row.folder_id;
      if (input.folder !== undefined || input.folderId !== undefined) {
        const resolved = await resolveFolderPath(env, ownerId, input);
        if ("error" in resolved) return { error: resolved.error, status: 400 };
        folder = resolved.folder;
        folderId = resolved.folderId;
      }

      let schemaJson = row.schema_json;
      if (input.schema !== undefined) {
        const schema = parseArticleSchema(input.schema);
        if ("error" in schema) return { error: schema.error, status: 400 };
        schemaJson = JSON.stringify(schema);
      }

      const name = input.name !== undefined ? input.name.trim() : row.name;
      if (!name) return { error: "name が必要です", status: 400 };

      let webhookUrl = row.webhook_url;
      if (input.webhookUrl !== undefined) {
        webhookUrl = input.webhookUrl?.trim() || null;
        if (webhookUrl && !isAllowedWebhookUrl(webhookUrl)) {
          return {
            error: "webhookUrl は https である必要があります",
            status: 400,
          };
        }
      }

      let webhookAuthorization = row.webhook_authorization;
      if (input.webhookAuthorization !== undefined) {
        webhookAuthorization = input.webhookAuthorization?.trim() || null;
      }

      if (folder !== row.folder) {
        const conflict = await db(env)
          .prepare(
            "SELECT id FROM article_sources WHERE owner_id = ? AND folder = ? AND id != ?",
          )
          .bind(ownerId, folder, id)
          .first<{ id: string }>();
        if (conflict) {
          return {
            error: "このディレクトリは既に登録されています",
            status: 409,
          };
        }
      }

      const now = Date.now();
      await db(env)
        .prepare(
          `UPDATE article_sources
           SET folder = ?, folder_id = ?, name = ?, schema_json = ?,
               webhook_url = ?, webhook_authorization = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          folder,
          folderId,
          name,
          schemaJson,
          webhookUrl,
          webhookAuthorization,
          now,
          id,
        )
        .run();

      const updated = await loadSource(env, ownerId, id);
      return updated ? presentSource(updated) : null;
    },

    async deleteSource(ownerId: string, id: string): Promise<boolean> {
      const result = await db(env)
        .prepare("DELETE FROM article_sources WHERE id = ? AND owner_id = ?")
        .bind(id, ownerId)
        .run();
      return result.meta.changes > 0;
    },

    async status(ownerId: string): Promise<ArticleSourceStatus> {
      const sources = await db(env)
        .prepare(
          "SELECT * FROM article_sources WHERE owner_id = ? ORDER BY folder",
        )
        .bind(ownerId)
        .all<SourceRow>();
      const items = [];
      for (const row of sources.results ?? []) {
        const maxUpdated = await maxNoteUpdatedAt(env, ownerId, row.folder);
        items.push({
          id: row.id,
          name: row.name,
          dirty: isArticleSourceDirty(row.last_dispatched_at, maxUpdated),
        });
      }
      return {
        dirty: items.some((item) => item.dirty),
        sources: items,
      };
    },

    async dispatch(
      ownerId: string,
      id: string,
    ): Promise<{ ok: true } | { error: string; status: number } | null> {
      const row = await loadSource(env, ownerId, id);
      if (!row) return null;
      if (!row.webhook_url) {
        return { error: "Webhook URL が設定されていません", status: 400 };
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      };
      if (row.webhook_authorization) {
        headers.Authorization = row.webhook_authorization;
      }

      let response: Response;
      try {
        response = await fetch(row.webhook_url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            event_type: "miyulabmd-publish",
            client_payload: {
              collectionId: row.id,
              folder: row.folder,
            },
          }),
        });
      } catch {
        return { error: "Webhook の送信に失敗しました", status: 502 };
      }

      if (!response.ok) {
        return {
          error: `Webhook が ${response.status} を返しました`,
          status: 502,
        };
      }

      await db(env)
        .prepare(
          "UPDATE article_sources SET last_dispatched_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(Date.now(), Date.now(), id)
        .run();
      return { ok: true };
    },

    async listCollections(ownerId: string): Promise<ArticleCollection[]> {
      const rows = await db(env)
        .prepare(
          "SELECT * FROM article_sources WHERE owner_id = ? ORDER BY folder",
        )
        .bind(ownerId)
        .all<SourceRow>();
      return (rows.results ?? []).map(presentCollection);
    },

    async listEntries(
      ownerId: string,
      id: string,
      origin: string,
      query: { page: number; perPage: number; folder: string | null },
    ): Promise<ArticleEntryPage | { error: string; status: number } | null> {
      const row = await loadSource(env, ownerId, id);
      if (!row) return null;
      const folder = resolveArticleListFolder(row.folder, query.folder);
      if (typeof folder !== "string") {
        return { error: folder.error, status: 400 };
      }
      const schema = parseSchemaJson(row.schema_json);
      const filter = sourceNoteFilter(folder);
      const countRow = await db(env)
        .prepare(
          `SELECT COUNT(*) AS total FROM notes
           WHERE owner_id = ? AND ${filter.sql}`,
        )
        .bind(ownerId, ...filter.binds)
        .first<{ total: number }>();
      const total = Number(countRow?.total ?? 0);
      const offset = (query.page - 1) * query.perPage;
      const notes = await db(env)
        .prepare(
          `SELECT id, short_id, alias, title, folder, markdown_snapshot,
                  article_meta, created_at, updated_at
           FROM notes
           WHERE owner_id = ? AND ${filter.sql}
           ORDER BY updated_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(ownerId, ...filter.binds, query.perPage, offset)
        .all<NoteArticleRow>();
      return {
        collection: presentCollection(row),
        entries: (notes.results ?? []).map((note) =>
          toEntry(note, schema, origin, false),
        ),
        page: query.page,
        perPage: query.perPage,
        total,
        hasMore: offset + query.perPage < total,
      };
    },

    async getEntry(
      ownerId: string,
      id: string,
      slug: string,
      origin: string,
    ): Promise<{ collection: ArticleCollection; entry: ArticleEntry } | null> {
      const row = await loadSource(env, ownerId, id);
      if (!row) return null;
      const schema = parseSchemaJson(row.schema_json);
      const note = await db(env)
        .prepare(
          `SELECT id, short_id, alias, title, folder, markdown_snapshot,
                  article_meta, created_at, updated_at
           FROM notes
           WHERE owner_id = ? AND (alias = ? OR short_id = ?)`,
        )
        .bind(ownerId, slug, slug)
        .first<NoteArticleRow>();
      if (!note || !folderMatchesSource(row.folder, note.folder)) {
        return null;
      }
      return {
        collection: presentCollection(row),
        entry: toEntry(note, schema, origin, true),
      };
    },
  };
}

export async function rewriteArticleSourceFolders(
  env: Env,
  ownerId: string,
  from: string,
  to: string,
): Promise<void> {
  const rows = await db(env)
    .prepare("SELECT id, folder FROM article_sources WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ id: string; folder: string }>();
  for (const row of rows.results ?? []) {
    const next = rewriteFolderPrefix(row.folder, from, to);
    if (next === null) continue;
    const rec = await getFolderByPath(env, ownerId, next);
    await db(env)
      .prepare(
        "UPDATE article_sources SET folder = ?, folder_id = ? WHERE id = ?",
      )
      .bind(next, rec?.id ?? null, row.id)
      .run();
  }
}

export async function deleteArticleSourcesInFolder(
  env: Env,
  ownerId: string,
  folder: string,
): Promise<void> {
  const rows = await db(env)
    .prepare("SELECT id, folder FROM article_sources WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ id: string; folder: string }>();
  for (const row of rows.results ?? []) {
    if (!folderMatchesSource(folder, row.folder)) continue;
    await db(env)
      .prepare("DELETE FROM article_sources WHERE id = ?")
      .bind(row.id)
      .run();
  }
}
