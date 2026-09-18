import {
  type BrokenLinkItem,
  lineForOffset,
  NOTE_UUID_RE,
  type NoteBacklinkItem,
  type NoteLinkItem,
  type NoteLinksResult,
  type NoteSummary,
  parseNoteLinks,
  type SessionUser,
  type WikiLinkResolution,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import { findUserById, toSessionUser } from "../db/users.ts";
import { resolveNoteAccess } from "./access.ts";
import {
  accessFields,
  findNoteRow,
  listAccessibleRows,
  type NoteRow,
  toSummary,
} from "./notes.ts";

type NoteLinkRow = {
  src_note_id: string;
  dest_note_id: string | null;
  dest_raw: string;
  dest_display: string | null;
  link_type: string;
  heading: string | null;
  offset_start: number;
  offset_end: number;
  dest_status: string;
  updated_at: number;
};

export type LinksResult =
  | { kind: "ok"; result: NoteLinksResult }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 };

export type BacklinksResult =
  | { kind: "ok"; backlinks: NoteBacklinkItem[] }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 };

export type ResolveResult =
  | { kind: "ok"; resolution: WikiLinkResolution }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 };

const BROKEN_LINKS_LIMIT = 500;

async function canViewRow(
  env: Env,
  row: NoteRow,
  viewer?: SessionUser | null,
): Promise<boolean> {
  const access = await resolveNoteAccess(env, accessFields(row), viewer);
  return access.flags.canView;
}

type LinkResolution =
  | { kind: "resolved"; row: NoteRow }
  | { kind: "ambiguous"; rows: NoteRow[] }
  | { kind: "missing" };

type ResolveContext = {
  env: Env;
  /** Owner whose title/folder namespace is searched. */
  ownerId: string;
  /** Folder of the source note, for same-folder title priority. */
  srcFolder: string;
  /** Viewer whose canView scope filters candidates. */
  viewer?: SessionUser | null;
};

async function selectNoteRows(
  env: Env,
  where: string,
  ...params: (string | null)[]
): Promise<NoteRow[]> {
  const result = await db(env)
    .prepare(`SELECT * FROM notes WHERE ${where}`)
    .bind(...params)
    .all<NoteRow>();
  return result.results ?? [];
}

async function viewable(
  ctx: ResolveContext,
  rows: NoteRow[],
): Promise<NoteRow[]> {
  const out: NoteRow[] = [];
  for (const row of rows) {
    if (await canViewRow(ctx.env, row, ctx.viewer)) {
      out.push(row);
    }
  }
  return out;
}

function resolutionOf(rows: NoteRow[]): LinkResolution {
  if (rows.length === 1 && rows[0]) {
    return { kind: "resolved", row: rows[0] };
  }
  if (rows.length > 1) {
    return { kind: "ambiguous", rows };
  }
  return { kind: "missing" };
}

async function resolveByIdentity(
  ctx: ResolveContext,
  where: string,
  value: string,
): Promise<LinkResolution | null> {
  const rows = await selectNoteRows(ctx.env, where, value);
  if (rows.length === 0) {
    return null;
  }
  const visible = await viewable(ctx, rows);
  if (visible.length === 0) {
    return { kind: "missing" };
  }
  return resolutionOf(visible);
}

/**
 * Resolve a wiki-link target. Order: UUID → short_id → alias →
 * folder-qualified title → same-folder title → global title.
 * Rows the viewer cannot see are treated as missing.
 */
export async function resolveLinkTarget(
  ctx: ResolveContext,
  target: string,
): Promise<LinkResolution> {
  const t = target.trim();
  if (!t) {
    return { kind: "missing" };
  }

  if (NOTE_UUID_RE.test(t)) {
    const found = await resolveByIdentity(ctx, "id = ?", t);
    if (found) {
      return found;
    }
  }
  const byShort = await resolveByIdentity(ctx, "short_id = ?", t);
  if (byShort) {
    return byShort;
  }
  const byAlias = await resolveByIdentity(ctx, "alias = ?", t);
  if (byAlias) {
    return byAlias;
  }

  const slash = t.lastIndexOf("/");
  if (slash >= 0) {
    const folder = t.slice(0, slash);
    const title = t.slice(slash + 1).trim();
    if (!title) {
      return { kind: "missing" };
    }
    const rows = await viewable(
      ctx,
      await selectNoteRows(
        ctx.env,
        "owner_id = ? AND folder = ? AND title = ?",
        ctx.ownerId,
        folder,
        title,
      ),
    );
    return resolutionOf(rows);
  }

  if (ctx.srcFolder) {
    const rows = await viewable(
      ctx,
      await selectNoteRows(
        ctx.env,
        "owner_id = ? AND folder = ? AND title = ?",
        ctx.ownerId,
        ctx.srcFolder,
        t,
      ),
    );
    if (rows.length > 0) {
      return resolutionOf(rows);
    }
  }

  const rows = await viewable(
    ctx,
    await selectNoteRows(ctx.env, "owner_id = ? AND title = ?", ctx.ownerId, t),
  );
  return resolutionOf(rows);
}

/** Parse the note's snapshot and rewrite its note_links rows. */
export async function reindexNoteLinks(env: Env, row: NoteRow): Promise<void> {
  const owner = await findUserById(env, row.owner_id);
  const viewer = owner ? toSessionUser(owner) : undefined;
  const ctx: ResolveContext = {
    env,
    ownerId: row.owner_id,
    srcFolder: row.folder ?? "",
    viewer,
  };
  const markdown = row.markdown_snapshot ?? "";
  const links = parseNoteLinks(markdown);
  const now = Date.now();

  await db(env)
    .prepare("DELETE FROM note_links WHERE src_note_id = ?")
    .bind(row.id)
    .run();

  const insert = db(env).prepare(
    `INSERT INTO note_links
       (src_note_id, dest_note_id, dest_raw, dest_display, link_type,
        heading, offset_start, offset_end, dest_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const link of links) {
    let destId: string | null = null;
    let status = "missing";
    if (!link.target && link.heading) {
      // `[[#見出し]]` is a self link.
      destId = row.id;
      status = "resolved";
    } else {
      const resolution = await resolveLinkTarget(ctx, link.target);
      if (resolution.kind === "resolved") {
        destId = resolution.row.id;
        status = "resolved";
      } else if (resolution.kind === "ambiguous") {
        status = "ambiguous";
      }
    }
    await insert
      .bind(
        row.id,
        destId,
        link.target,
        link.display,
        link.type,
        link.heading,
        link.start,
        link.end,
        status,
        now,
      )
      .run();
  }
}

/**
 * Re-resolve links that point to (or may point to) a note whose
 * title/folder/alias changed. `prev` holds the values before the change.
 */
export async function reindexLinksToNote(
  env: Env,
  note: NoteRow,
  prev: { alias: string | null; folder: string; title: string },
): Promise<void> {
  const keys = new Set(
    [
      prev.title,
      note.title,
      `${prev.folder}/${prev.title}`,
      `${note.folder}/${note.title}`,
      prev.alias,
      note.alias,
      note.short_id,
    ].filter((key): key is string => Boolean(key)),
  );
  const placeholders = [...keys].map(() => "?").join(", ");
  const srcIds = new Set<string>();
  const rows = await db(env)
    .prepare(
      `SELECT DISTINCT src_note_id FROM note_links
       WHERE dest_note_id = ? OR dest_raw IN (${placeholders})`,
    )
    .bind(note.id, ...keys)
    .all<{ src_note_id: string }>();
  for (const r of rows.results ?? []) {
    srcIds.add(r.src_note_id);
  }
  for (const srcId of srcIds) {
    if (srcId === note.id) {
      continue;
    }
    const src = await findNoteRow(env, srcId);
    if (src) {
      await reindexNoteLinks(env, src);
    }
  }
}

async function requireViewableNote(
  env: Env,
  idOrShortId: string,
  user?: SessionUser | null,
): Promise<
  | { kind: "ok"; row: NoteRow }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 }
> {
  const row = await findNoteRow(env, idOrShortId);
  if (!row) {
    return { kind: "not_found" };
  }
  const access = await resolveNoteAccess(env, accessFields(row), user);
  if (!access.flags.canView) {
    return { kind: "denied", status: user ? 403 : 401 };
  }
  return { kind: "ok", row };
}

async function summaryForLink(
  env: Env,
  noteId: string | null,
  viewer?: SessionUser | null,
): Promise<NoteSummary | null> {
  if (!noteId) {
    return null;
  }
  const row = await findNoteRow(env, noteId);
  if (!(row && (await canViewRow(env, row, viewer)))) {
    return null;
  }
  return toSummary(env, row, viewer);
}

async function linkRowsFor(
  env: Env,
  srcNoteId: string,
): Promise<NoteLinkRow[]> {
  const result = await db(env)
    .prepare(
      "SELECT * FROM note_links WHERE src_note_id = ? ORDER BY offset_start",
    )
    .bind(srcNoteId)
    .all<NoteLinkRow>();
  return result.results ?? [];
}

function toLinkItem(
  srcMarkdown: string,
  row: NoteLinkRow,
  note: NoteSummary | null,
): NoteLinkItem {
  return {
    display: row.dest_display,
    heading: row.heading,
    line: lineForOffset(srcMarkdown, row.offset_start),
    linkType: row.link_type === "md" ? "md" : "wiki",
    note,
    target: row.dest_raw,
  };
}

export async function listNoteLinks(
  env: Env,
  idOrShortId: string,
  user?: SessionUser | null,
): Promise<LinksResult> {
  const found = await requireViewableNote(env, idOrShortId, user);
  if (found.kind !== "ok") {
    return found;
  }
  const src = found.row;
  const rows = await linkRowsFor(env, src.id);
  const outgoing: NoteLinkItem[] = [];
  for (const row of rows) {
    outgoing.push(
      toLinkItem(
        src.markdown_snapshot,
        row,
        await summaryForLink(env, row.dest_note_id, user),
      ),
    );
  }
  const back = await listBacklinks(env, src.id, user);
  return {
    kind: "ok",
    result: {
      backlinks: back.kind === "ok" ? back.backlinks : [],
      outgoing,
    },
  };
}

export async function listBacklinks(
  env: Env,
  idOrShortId: string,
  user?: SessionUser | null,
): Promise<BacklinksResult> {
  const found = await requireViewableNote(env, idOrShortId, user);
  if (found.kind !== "ok") {
    return found;
  }
  const rows = await db(env)
    .prepare(
      "SELECT * FROM note_links WHERE dest_note_id = ? ORDER BY updated_at DESC",
    )
    .bind(found.row.id)
    .all<NoteLinkRow>();
  const backlinks: NoteBacklinkItem[] = [];
  for (const row of rows.results ?? []) {
    const src = await findNoteRow(env, row.src_note_id);
    if (!(src && (await canViewRow(env, src, user)))) {
      continue;
    }
    backlinks.push({
      heading: row.heading,
      line: lineForOffset(src.markdown_snapshot, row.offset_start),
      linkType: row.link_type === "md" ? "md" : "wiki",
      note: await toSummary(env, src, user),
      target: row.dest_raw,
    });
  }
  return { backlinks, kind: "ok" };
}

export async function listBrokenLinks(
  env: Env,
  user: SessionUser,
): Promise<BrokenLinkItem[]> {
  const { rows: accessible } = await listAccessibleRows(env, user);
  const byId = new Map(accessible.map((row) => [row.id, row]));
  if (byId.size === 0) {
    return [];
  }
  const rows = await db(env)
    .prepare(
      `SELECT * FROM note_links
       WHERE dest_status IN ('missing', 'ambiguous')
       ORDER BY updated_at DESC`,
    )
    .all<NoteLinkRow>();
  const broken: BrokenLinkItem[] = [];
  for (const row of rows.results ?? []) {
    const src = byId.get(row.src_note_id);
    if (!src) {
      continue;
    }
    broken.push({
      heading: row.heading,
      line: lineForOffset(src.markdown_snapshot, row.offset_start),
      linkType: row.link_type === "md" ? "md" : "wiki",
      note: await toSummary(env, src, user),
      target: row.dest_raw,
    });
    if (broken.length >= BROKEN_LINKS_LIMIT) {
      break;
    }
  }
  return broken;
}

export async function resolveWikilink(
  env: Env,
  user: SessionUser,
  target: string,
  contextNoteId?: string,
): Promise<ResolveResult> {
  let ownerId = user.id;
  let srcFolder = "";
  if (contextNoteId) {
    const found = await requireViewableNote(env, contextNoteId, user);
    if (found.kind !== "ok") {
      return found;
    }
    ownerId = found.row.owner_id;
    srcFolder = found.row.folder ?? "";
  }
  const resolution = await resolveLinkTarget(
    { env, ownerId, srcFolder, viewer: user },
    target,
  );
  if (resolution.kind === "resolved") {
    return {
      kind: "ok",
      resolution: {
        note: await toSummary(env, resolution.row, user),
        status: "resolved",
      },
    };
  }
  if (resolution.kind === "ambiguous") {
    const candidates: NoteSummary[] = [];
    for (const row of resolution.rows.slice(0, 10)) {
      candidates.push(await toSummary(env, row, user));
    }
    return { kind: "ok", resolution: { candidates, status: "ambiguous" } };
  }
  return { kind: "ok", resolution: { status: "missing" } };
}
