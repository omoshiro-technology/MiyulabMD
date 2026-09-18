import { env } from "cloudflare:workers";
import {
  ACCESS_SCOPES,
  EDIT_LOCKED_CODE,
  MCP_NOTE_URL_HINT,
  NOTE_RESTORE_MESSAGE,
  type Note,
  type SessionUser,
} from "@miyulabmd/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { db } from "../db/client.ts";
import type { ApplyEditResult } from "../durable-objects/DocumentRoom.ts";
import { actorFromSessionUser } from "../durable-objects/history-edit.ts";
import {
  type InsertPosition,
  markdownOutline,
  numberMarkdownLines,
} from "../durable-objects/markdown-edit.ts";
import {
  ensureFolderRow,
  folderViewFlags,
  getFolderById,
  listFolderChildren,
} from "../services/access.ts";
import { getNoteRevision, listNoteEditEvents } from "../services/history.ts";
import {
  listBacklinks,
  listBrokenLinks,
  listNoteLinks,
  resolveWikilink,
} from "../services/links.ts";
import {
  assignFolderMedallion,
  clearFolderMedallion,
  listMedallionAssignments,
  listMedallionSets,
  type MedallionResult,
} from "../services/medallion.ts";
import {
  type MoveError,
  moveFolder,
  moveFolderContents,
  moveNotes,
} from "../services/move.ts";
import {
  createNoteService,
  type GetNoteResult,
  type MutateNoteResult,
} from "../services/notes.ts";
import { paraArchiveProject, paraList } from "../services/para.ts";
import {
  createSchemeChild,
  folderIdsForSchemeId,
  jdAllocateId,
  jdListCategory,
  type SchemeError,
  schemeGet,
  setFolderScheme,
  validateSchemeTree,
} from "../services/schemes.ts";

function textResult(data: unknown) {
  return {
    content: [{ text: JSON.stringify(data, null, 2), type: "text" as const }],
  };
}

function textError(message: string) {
  return {
    content: [{ text: message, type: "text" as const }],
    isError: true as const,
  };
}

async function listNotesForTool(
  notes: ReturnType<typeof createNoteService>,
  user: SessionUser,
  options: {
    folderId?: string;
    query?: string;
    recursive: boolean;
  },
): Promise<
  { notes: Awaited<ReturnType<typeof notes.listForUser>> } | { error: string }
> {
  let list: Awaited<ReturnType<typeof notes.listForUser>>;
  if (options.folderId) {
    const result = await notes.listFolderNotes(
      user,
      options.folderId,
      options.recursive,
    );
    if (result.kind === "not_found") {
      return { error: "Not found" };
    }
    if (result.kind === "denied") {
      return { error: result.status === 401 ? "Unauthorized" : "Forbidden" };
    }
    list = result.notes;
  } else {
    list = await notes.listForUser(user);
  }
  const trimmedQuery = options.query?.trim();
  if (trimmedQuery) {
    const needle = trimmedQuery.toLowerCase();
    list = list.filter((note) => note.title.toLowerCase().includes(needle));
  }
  return { notes: list };
}

function medallionToolError(
  result: Exclude<MedallionResult<unknown>, { kind: "ok" }>,
) {
  if (result.kind === "not_found") {
    return textError("Not found");
  }
  if (result.kind === "denied") {
    return textError("Forbidden");
  }
  if (result.kind === "confirm_required") {
    return textError(
      `confirm_required: ${result.assignedFolders} folder(s) still reference this set`,
    );
  }
  return textError(result.message ?? "Invalid request");
}

/** Denied-result text that surfaces the §2.6 edit-lock code when present. */
function deniedToolError(result: { status: number; code?: string }) {
  if (result.code === EDIT_LOCKED_CODE) {
    return textError(
      `${EDIT_LOCKED_CODE}: this note is edit-locked. Call set_edit_lock with locked=false first.`,
    );
  }
  return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
}

/** folder_id か scheme_id（`15.22` 等）から対象フォルダ UUID を決める。 */
async function folderIdArg(
  user: SessionUser,
  folderId: string | undefined,
  schemeId: string | undefined,
): Promise<{ folderId?: string } | { error: string }> {
  if (!schemeId) {
    return { folderId };
  }
  if (folderId) {
    return { error: "Specify either folder_id or scheme_id, not both" };
  }
  const resolved = await folderIdsForSchemeId(env, user.id, schemeId);
  if (resolved.length === 0) {
    return { error: "Not found" };
  }
  if (resolved.length > 1) {
    return {
      error:
        "scheme_id is ambiguous across multiple scheme roots; specify folder_id instead",
    };
  }
  return { folderId: resolved[0] };
}

function moveToolError(result: MoveError | SchemeError) {
  if (result.kind === "not_found") {
    return textError("Not found");
  }
  if (result.kind === "denied") {
    return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
  }
  return textError(result.error);
}

function requireUser(): SessionUser | null {
  const raw = getMcpAuthContext()?.props.user;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") {
    return null;
  }

  return {
    displayName:
      typeof candidate.displayName === "string" ? candidate.displayName : null,
    email: candidate.email,
    id: candidate.id,
  };
}

function documentRoom(noteId: string) {
  return env.DOCUMENT_ROOM.get(env.DOCUMENT_ROOM.idFromName(noteId));
}

function agentOf(user: SessionUser) {
  return {
    displayName: user.displayName?.trim() || user.email,
    userId: user.id,
  };
}

function editToolResult(noteId: string, result: ApplyEditResult) {
  if (!result.ok) {
    const suffix =
      result.matches === undefined ? "" : ` (matches: ${result.matches})`;
    return textError(`${result.message}${suffix}`);
  }
  return textResult({
    applied: true,
    cursor: result.cursor,
    excerpt: result.excerpt,
    id: noteId,
    markdownLength: result.markdownLength,
  });
}

function getNoteToolError(result: GetNoteResult) {
  if (result.kind === "not_found") {
    return textError("Not found");
  }
  if (result.kind === "denied") {
    return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
  }
  return null;
}

function mutateNoteToolResponse(result: MutateNoteResult) {
  if (result.kind === "not_found") {
    return textError("Not found");
  }
  if (result.kind === "denied") {
    return deniedToolError(result);
  }
  if (result.kind === "bad_request") {
    return textError(result.error);
  }
  return textResult({ note: result.note });
}

function resolveInsertPosition(
  at: "start" | "end" | undefined,
  after: string | undefined,
  before: string | undefined,
): InsertPosition | { error: string } {
  const specified = [at !== undefined, Boolean(after), Boolean(before)].filter(
    Boolean,
  ).length;
  if (specified !== 1) {
    return { error: "Provide exactly one of: at, after, before" };
  }
  if (at !== undefined) {
    return { at };
  }
  if (after) {
    return { after };
  }
  if (before) {
    return { before };
  }
  return { error: "Provide exactly one of: at, after, before" };
}

type ToolTextResult =
  | ReturnType<typeof textResult>
  | ReturnType<typeof textError>;

async function requireViewableNote(
  notes: ReturnType<typeof createNoteService>,
  id: string,
  user: SessionUser,
): Promise<{ ok: true; note: Note } | { ok: false; error: ToolTextResult }> {
  const loaded = await notes.get(id, user);
  const error = getNoteToolError(loaded);
  if (error) {
    return { error, ok: false };
  }
  if (loaded.kind !== "ok") {
    return { error: textError("Not found"), ok: false };
  }
  return { note: loaded.note, ok: true };
}

async function requireEditableNote(
  notes: ReturnType<typeof createNoteService>,
  id: string,
  user: SessionUser,
): Promise<{ ok: true; note: Note } | { ok: false; error: ToolTextResult }> {
  const loaded = await requireViewableNote(notes, id, user);
  if (!loaded.ok) {
    return loaded;
  }
  if (!loaded.note.access.flags.canEdit) {
    return { error: textError("Forbidden"), ok: false };
  }
  if (loaded.note.editLocked) {
    return {
      error: textError(
        `${EDIT_LOCKED_CODE}: this note is edit-locked. Call set_edit_lock with locked=false first.`,
      ),
      ok: false,
    };
  }
  return loaded;
}

function grantsWithCollaborator(
  grants: Note["access"]["grants"],
  email: string,
  canWrite: boolean | undefined,
) {
  const next = grants
    .filter((grant) => grant.email !== email.trim().toLowerCase())
    .map((grant) => ({ canWrite: grant.canWrite, email: grant.email }));
  next.push({ canWrite: Boolean(canWrite), email });
  return next;
}

async function insertInNoteTool(
  notes: ReturnType<typeof createNoteService>,
  input: {
    id: string;
    text: string;
    at?: "start" | "end";
    after?: string;
    before?: string;
  },
): Promise<ToolTextResult> {
  const user = requireUser();
  if (!user) {
    return textError("Unauthorized");
  }

  const position = resolveInsertPosition(input.at, input.after, input.before);
  if ("error" in position) {
    return textError(position.error);
  }

  const loaded = await requireEditableNote(notes, input.id, user);
  if (!loaded.ok) {
    return loaded.error;
  }

  const result = await documentRoom(loaded.note.id).applyEdit({
    agent: agentOf(user),
    noteId: loaded.note.id,
    op: "insert",
    position,
    text: input.text,
  });
  return editToolResult(loaded.note.id, result);
}

async function listNoteHistoryTool(
  notes: ReturnType<typeof createNoteService>,
  input: { id: string; limit?: number; before?: number },
): Promise<ToolTextResult> {
  const user = requireUser();
  if (!user) {
    return textError("Unauthorized");
  }

  const loaded = await requireViewableNote(notes, input.id, user);
  if (!loaded.ok) {
    return loaded.error;
  }

  const page = await listNoteEditEvents(env, loaded.note.id, {
    before: input.before,
    limit: input.limit,
  });
  return textResult(page);
}

async function getRevisionTool(
  notes: ReturnType<typeof createNoteService>,
  input: { id: string; revisionId: string },
): Promise<ToolTextResult> {
  const user = requireUser();
  if (!user) {
    return textError("Unauthorized");
  }

  const loaded = await requireViewableNote(notes, input.id, user);
  if (!loaded.ok) {
    return loaded.error;
  }

  const revision = await getNoteRevision(env, loaded.note.id, input.revisionId);
  if (!revision) {
    return textError("Not found");
  }
  return textResult(revision);
}

async function restoreRevisionTool(
  notes: ReturnType<typeof createNoteService>,
  input: { id: string; revisionId: string },
): Promise<ToolTextResult> {
  const user = requireUser();
  if (!user) {
    return textError("Unauthorized");
  }

  const loaded = await requireEditableNote(notes, input.id, user);
  if (!loaded.ok) {
    return loaded.error;
  }

  const revision = await getNoteRevision(env, loaded.note.id, input.revisionId);
  if (!revision) {
    return textError("Not found");
  }

  const applied = await documentRoom(loaded.note.id).restoreMarkdown(
    loaded.note.id,
    revision.markdown,
    actorFromSessionUser(user),
  );
  if (!applied.ok) {
    return textError(applied.message);
  }

  return textResult({
    message: NOTE_RESTORE_MESSAGE,
    restored: true,
    revisionId: revision.id,
  });
}

async function inviteCollaboratorTool(
  notes: ReturnType<typeof createNoteService>,
  input: { id: string; email: string; canWrite?: boolean },
): Promise<ToolTextResult> {
  const user = requireUser();
  if (!user) {
    return textError("Unauthorized");
  }

  const current = await notes.get(input.id, user);
  const currentError = getNoteToolError(current);
  if (currentError) {
    return currentError;
  }
  if (current.kind !== "ok") {
    return textError("Not found");
  }

  const result = await notes.updateMeta(input.id, user, {
    grants: grantsWithCollaborator(
      current.note.access.grants,
      input.email,
      input.canWrite,
    ),
    inheritAccess: current.note.access.inherit,
    readScope: current.note.access.inherit
      ? undefined
      : current.note.access.effectiveReadScope,
    writeScope: current.note.access.inherit
      ? undefined
      : current.note.access.effectiveWriteScope,
  });
  return mutateNoteToolResponse(result);
}

/**
 * §2.6/KM-E: tool exposure follows *configured* state, not the UI feature
 * flags. A feature's tools register only when the user already has the
 * backing configuration rows — an unconfigured feature offers no tools
 * instead of failing at call time.
 */
async function featureConfig(env_: Env, user: SessionUser | null) {
  if (!user) {
    return { hasMedallion: false, hasPara: false, hasSchemes: false };
  }
  const [para, medallion, scheme] = await Promise.all([
    db(env_)
      .prepare("SELECT 1 AS x FROM para_spaces WHERE owner_id = ? LIMIT 1")
      .bind(user.id)
      .first<{ x: number }>(),
    db(env_)
      .prepare(
        "SELECT 1 AS x FROM medallion_sets WHERE owner_user_id = ? LIMIT 1",
      )
      .bind(user.id)
      .first<{ x: number }>(),
    db(env_)
      .prepare(
        "SELECT 1 AS x FROM folders WHERE owner_id = ? AND scheme IS NOT NULL LIMIT 1",
      )
      .bind(user.id)
      .first<{ x: number }>(),
  ]);
  return {
    hasMedallion: medallion !== null,
    hasPara: para !== null,
    hasSchemes: scheme !== null,
  };
}

/**
 * createMcpHandler に渡す MCP サーバーファクトリ。
 * Async so it can read the caller's feature configuration inside the auth
 * context (createMcpHandler awaits the factory per request).
 */
export async function createMcpServerFactory() {
  const server = new McpServer({
    name: "miyulabmd",
    version: "0.1.0",
  });
  const notes = createNoteService(env);
  const features = await featureConfig(env, requireUser());

  server.registerTool(
    "list_notes",
    {
      description: `List notes owned by or shared with the authenticated user. Do not enumerate everything — browse folders with list_folder_entries first. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        folder_id: z
          .string()
          .optional()
          .describe("Restrict to notes inside this folder UUID"),
        query: z
          .string()
          .optional()
          .describe("Optional title filter (case-insensitive substring)"),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "With folder_id, include notes in descendant folders (default: direct children only)",
          ),
        scheme_id: z
          .string()
          .optional()
          .describe(
            "Restrict to the folder carrying this naming-scheme ID (e.g. `15.22`, `202609171230`); alternative to folder_id",
          ),
      },
    },
    async ({ folder_id, query, recursive, scheme_id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const target = await folderIdArg(user, folder_id, scheme_id);
      if ("error" in target) {
        return textError(target.error);
      }
      const result = await listNotesForTool(notes, user, {
        folderId: target.folderId,
        query,
        recursive: recursive ?? false,
      });
      if ("error" in result) {
        return textError(result.error);
      }
      return textResult({ notes: result.notes });
    },
  );

  server.registerTool(
    "list_folder_entries",
    {
      description: `List direct children (subfolders and notes) of a folder — one level only. Browse folders with this instead of enumerating all notes. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous nextCursor"),
        folder_id: z
          .string()
          .optional()
          .describe("Folder UUID; omit for the drive root"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max entries to return (default 50, max 200)"),
      },
    },
    async ({ cursor, folder_id, limit }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      let ownerId = user.id;
      let folderPath = "";
      let currentId: string | null;
      if (folder_id) {
        const rec = await getFolderById(env, folder_id);
        if (!rec) {
          return textError("Not found");
        }
        ownerId = rec.owner_id;
        folderPath = rec.folder;
        currentId = rec.id;
      } else {
        currentId = await ensureFolderRow(env, user.id, "");
      }

      const flags = await folderViewFlags(env, ownerId, folderPath, user);
      if (!flags.canView) {
        return textError("Not found");
      }
      return textResult(
        await listFolderChildren(env, ownerId, folderPath, currentId, user, {
          cursor,
          limit,
        }),
      );
    },
  );

  server.registerTool(
    "get_note",
    {
      description: `Get note metadata and the live collaborative markdown (not a stale D1 snapshot). Shows an AI(username) cursor to people editing in the browser. Includes a heading outline. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
        numbered: z
          .boolean()
          .optional()
          .describe("Prefix each markdown line with its 1-based line number"),
      },
    },
    async ({ id, numbered }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const result = await notes.get(id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }

      const note = result.note;
      const markdown = await documentRoom(note.id).readForAgent(
        note.id,
        agentOf(user),
      );
      const live = { ...note, markdown };

      return textResult({
        note: live,
        outline: markdownOutline(markdown),
        ...(numbered
          ? { numberedMarkdown: numberMarkdownLines(markdown) }
          : {}),
      });
    },
  );

  server.registerTool(
    "create_note",
    {
      description: `Create a new note owned by the authenticated user. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        folder: z.string().optional(),
        inheritAccess: z.boolean().optional(),
        markdown: z.string().optional(),
        readScope: z.enum(ACCESS_SCOPES).optional(),
        title: z.string().optional(),
        writeScope: z.enum(ACCESS_SCOPES).optional(),
      },
    },
    async ({
      title,
      markdown,
      folder,
      inheritAccess,
      readScope,
      writeScope,
    }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const created = await notes.create(user, {
        folder,
        inheritAccess,
        markdown,
        readScope,
        title,
        writeScope,
      });
      if ("error" in created) {
        return textError(created.error);
      }

      return textResult({ note: created });
    },
  );

  server.registerTool(
    "replace_in_note",
    {
      description:
        "Replace a unique old_string with new_string in the live note. If old_string matches more than once and replace_all is not true, the call fails. Prefer this over update_note. Shows an AI(username) cursor at the edit.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
        new_string: z.string().describe("Replacement text"),
        old_string: z
          .string()
          .describe("Exact text to find. Include unique surrounding context."),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every non-overlapping match"),
      },
    },
    async ({ id, old_string, new_string, replace_all }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const loaded = await notes.get(id, user);
      if (loaded.kind === "not_found") {
        return textError("Not found");
      }
      if (loaded.kind === "denied") {
        return textError(loaded.status === 401 ? "Unauthorized" : "Forbidden");
      }
      if (!loaded.note.access.flags.canEdit) {
        return textError("Forbidden");
      }
      if (loaded.note.editLocked) {
        return textError(
          `${EDIT_LOCKED_CODE}: this note is edit-locked. Call set_edit_lock with locked=false first.`,
        );
      }

      const result = await documentRoom(loaded.note.id).applyEdit({
        agent: agentOf(user),
        newString: new_string,
        noteId: loaded.note.id,
        oldString: old_string,
        op: "replace",
        replaceAll: replace_all,
      });
      return editToolResult(loaded.note.id, result);
    },
  );

  server.registerTool(
    "insert_in_note",
    {
      description:
        "Insert text into the live note. Provide exactly one of: at (start|end), after (unique context), or before (unique context). Prefer unique surrounding text when editing the middle. Shows an AI(username) cursor at the insert.",
      inputSchema: {
        after: z
          .string()
          .optional()
          .describe("Insert immediately after this unique text"),
        at: z.enum(["start", "end"]).optional(),
        before: z
          .string()
          .optional()
          .describe("Insert immediately before this unique text"),
        id: z.string().describe("Note UUID or short ID"),
        text: z.string().describe("Text to insert, including any newlines"),
      },
    },
    async ({ id, text, at, after, before }) =>
      insertInNoteTool(notes, { after, at, before, id, text }),
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Last-resort full replace of the live note markdown. Concurrent human edits may be disrupted. Prefer replace_in_note or insert_in_note. Shows an AI(username) cursor.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
        markdown: z.string().describe("Full markdown body"),
      },
    },
    async ({ id, markdown }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const result = await notes.get(id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }

      const note = result.note;
      if (!note.access.flags.canEdit) {
        return textError("Forbidden");
      }
      if (note.editLocked) {
        return textError(
          `${EDIT_LOCKED_CODE}: this note is edit-locked. Call set_edit_lock with locked=false first.`,
        );
      }

      const applied = await documentRoom(note.id).applyEdit({
        agent: agentOf(user),
        markdown,
        noteId: note.id,
        op: "set",
      });
      if (!applied.ok) {
        return textError(applied.message);
      }

      return textResult({
        applied: true,
        cursor: applied.cursor,
        excerpt: applied.excerpt,
        id: note.id,
        markdownLength: applied.markdownLength,
        shortId: note.shortId,
        title: note.title,
      });
    },
  );

  server.registerTool(
    "delete_note",
    {
      description: "Delete a note (requires canAdmin).",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
      },
    },
    async ({ id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const result = await notes.remove(id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return deniedToolError(result);
      }
      if (result.kind !== "ok") {
        return textError("Failed to delete note");
      }

      return textResult({ deleted: true, id: result.note.id });
    },
  );

  server.registerTool(
    "set_note_access",
    {
      description:
        "Change note read/write access (requires owner). inheritAccess follows the folder policy.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
        inheritAccess: z.boolean().optional(),
        readScope: z.enum(ACCESS_SCOPES).optional(),
        writeScope: z.enum(ACCESS_SCOPES).optional(),
      },
    },
    async ({ id, inheritAccess, readScope, writeScope }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const result = await notes.updateMeta(id, user, {
        inheritAccess,
        readScope,
        writeScope,
      });
      return mutateNoteToolResponse(result);
    },
  );

  server.registerTool(
    "invite_collaborator",
    {
      description: "Grant a user read or write access to a note by email.",
      inputSchema: {
        canWrite: z.boolean().optional(),
        email: z.string().email(),
        id: z.string().describe("Note UUID or short ID"),
      },
    },
    async ({ id, email, canWrite }) =>
      inviteCollaboratorTool(notes, { canWrite, email, id }),
  );

  server.registerTool(
    "search_notes",
    {
      description:
        'Search accessible notes by title or markdown snapshot. Query supports a small DSL: `word`, `"exact phrase"`, `-excluded`, and filters `path:folder`, `tag:name`, `layer:key` or `layer:set.key` (folder medallion assignment, inherited by descendants), `scheme:`/`jd:15.22`, `para:projects`. Use scope=title for fast title-only lookup; use grep_notes for line-level body hits.',
      inputSchema: {
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous next_cursor"),
        folder_id: z
          .string()
          .optional()
          .describe("Restrict to notes inside this folder UUID (recursive)"),
        layer: z
          .string()
          .optional()
          .describe(
            "Restrict to a medallion layer — a layer key (`output`) or set-qualified (`set.key`)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max notes to return (default 50, max 200)"),
        query: z.string().describe("Search query"),
        scheme_id: z
          .string()
          .optional()
          .describe(
            "Restrict to the folder carrying this naming-scheme ID (e.g. `15.22`); alternative to folder_id",
          ),
        scope: z
          .enum(["title", "body", "all"])
          .optional()
          .describe("Where to match (default: all)"),
      },
    },
    async ({ query, scope, folder_id, layer, limit, cursor, scheme_id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        return textError("query is required");
      }
      const target = await folderIdArg(user, folder_id, scheme_id);
      if ("error" in target) {
        return textError(target.error);
      }

      const result = await notes.searchNotes(user, {
        cursor,
        folderIds: target.folderId ? [target.folderId] : undefined,
        layer,
        limit,
        query: trimmedQuery,
        scope,
      });
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      return textResult({
        next_cursor: result.nextCursor,
        notes: result.notes,
        query: trimmedQuery,
      });
    },
  );

  server.registerTool(
    "grep_notes",
    {
      description: `Line-level search over the markdown body of accessible notes — like grep. Returns 1-based line/column plus context lines so results can feed replace_in_note. Reads the D1 markdown snapshot which lags live edits by a few seconds; check snapshot_updated_at per match. pattern is a fixed string by default; set fixed_string=false for a JS regular expression. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        case_sensitive: z
          .boolean()
          .optional()
          .describe("Match case (default: false)"),
        context_after: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Lines of context after each hit (default 1, max 5)"),
        context_before: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Lines of context before each hit (default 1, max 5)"),
        fixed_string: z
          .boolean()
          .optional()
          .describe(
            "Treat pattern as a literal string (default: true). Set false for a JS regex.",
          ),
        folder_id: z
          .string()
          .optional()
          .describe("Restrict to notes inside this folder UUID (recursive)"),
        glob_title: z
          .string()
          .optional()
          .describe("Only scan notes whose title matches this glob (* ?)"),
        max_matches_per_note: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Cap hits per note (default 10, max 50)"),
        max_notes: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Cap notes with hits (default 50, max 200)"),
        pattern: z
          .string()
          .min(1)
          .max(500)
          .describe("Text or regex to find in note bodies"),
        scheme_id: z
          .string()
          .optional()
          .describe(
            "Restrict to the folder carrying this naming-scheme ID (e.g. `15.22`); alternative to folder_id",
          ),
      },
    },
    async ({
      pattern,
      case_sensitive,
      context_after,
      context_before,
      fixed_string,
      folder_id,
      glob_title,
      max_matches_per_note,
      max_notes,
      scheme_id,
    }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const target = await folderIdArg(user, folder_id, scheme_id);
      if ("error" in target) {
        return textError(target.error);
      }

      const result = await notes.grep(user, {
        caseSensitive: case_sensitive,
        contextAfter: context_after,
        contextBefore: context_before,
        fixedString: fixed_string,
        folderIds: target.folderId ? [target.folderId] : undefined,
        globTitle: glob_title,
        maxMatchesPerNote: max_matches_per_note,
        maxNotes: max_notes,
        pattern,
      });
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "bad_request") {
        return textError(result.error);
      }
      return textResult({
        matches: result.matches.map((match) => ({
          after: match.after,
          before: match.before,
          column: match.column,
          line: match.line,
          note_id: match.noteId,
          snapshot_updated_at: match.snapshotUpdatedAt,
          text: match.text,
          title: match.title,
        })),
        scanned_notes: result.scannedNotes,
        truncated: result.truncated,
      });
    },
  );

  server.registerTool(
    "list_note_links",
    {
      description: `List outgoing links from a note ([[wiki links]] and /n/{id} markdown links). Unresolved links have note=null. Only notes the caller can see are resolved; hidden targets look missing. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
      },
    },
    async ({ id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const result = await listNoteLinks(env, id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }
      return textResult(result.result);
    },
  );

  server.registerTool(
    "list_backlinks",
    {
      description: `List notes linking to the given note (incoming links). Only sources the caller can see are listed. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
      },
    },
    async ({ id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const result = await listBacklinks(env, id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }
      return textResult({ backlinks: result.backlinks });
    },
  );

  server.registerTool(
    "list_broken_links",
    {
      description:
        "List unresolved links (missing or ambiguous) across notes the caller can see. Use before renaming or promoting notes.",
      inputSchema: {},
    },
    async () => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      return textResult({ broken: await listBrokenLinks(env, user) });
    },
  );

  server.registerTool(
    "resolve_wikilink",
    {
      description: `Resolve a [[wiki link]] target to a note the caller can see. Order: UUID → short_id → alias → folder/Title → same-folder title → global title. Pass context_id to scope folder-relative resolution to that note's folder. ${MCP_NOTE_URL_HINT}`,
      inputSchema: {
        context_id: z
          .string()
          .optional()
          .describe(
            "Source note UUID or short ID; scopes folder/title resolution",
          ),
        target: z
          .string()
          .min(1)
          .describe("The link target text inside [[...]]"),
      },
    },
    async ({ target, context_id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const result = await resolveWikilink(env, user, target, context_id);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }
      return textResult(result.resolution);
    },
  );

  server.registerTool(
    "agent_join",
    {
      description:
        "Show an AI(username) cursor on an open note. The name is the token owner's display name. Edit and get_note tools join automatically.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
      },
    },
    async ({ id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const result = await notes.get(id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }

      await documentRoom(result.note.id).setAgentPresence(
        result.note.id,
        agentOf(user),
      );
      return textResult({ id: result.note.id, joined: true });
    },
  );

  server.registerTool(
    "agent_leave",
    {
      description: "Hide the AI(username) cursor on a note.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
      },
    },
    async ({ id }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }

      const result = await notes.get(id, user);
      if (result.kind === "not_found") {
        return textError("Not found");
      }
      if (result.kind === "denied") {
        return textError(result.status === 401 ? "Unauthorized" : "Forbidden");
      }

      await documentRoom(result.note.id).clearAgentPresence();
      return textResult({ id: result.note.id, left: true });
    },
  );

  server.registerTool(
    "list_note_history",
    {
      description:
        "List edit events for a note, newest first. Use before (created_at) to page.",
      inputSchema: {
        before: z
          .number()
          .optional()
          .describe("Return events created before this epoch millisecond"),
        id: z.string().describe("Note UUID or short ID"),
        limit: z.number().optional().describe("Page size (default 30)"),
      },
    },
    async ({ id, limit, before }) =>
      listNoteHistoryTool(notes, { before, id, limit }),
  );

  server.registerTool(
    "get_revision",
    {
      description: "Get the markdown stored for a note revision.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
        revisionId: z.string().describe("Revision UUID"),
      },
    },
    async ({ id, revisionId }) => getRevisionTool(notes, { id, revisionId }),
  );

  server.registerTool(
    "restore_revision",
    {
      description:
        "Replace the live note with a stored revision. Concurrent edits are overwritten. Requires canEdit.",
      inputSchema: {
        id: z.string().describe("Note UUID or short ID"),
        revisionId: z.string().describe("Revision UUID to restore"),
      },
    },
    async ({ id, revisionId }) =>
      restoreRevisionTool(notes, { id, revisionId }),
  );

  server.registerTool(
    "move_folder",
    {
      description:
        "Move a folder (with all contents) under another folder, or to the drive root. Detects cycles, conflicts, and the 500-item cap. Set dry_run first to preview counts.",
      inputSchema: {
        dest_folder_id: z
          .string()
          .nullable()
          .optional()
          .describe("Destination folder UUID; null/omitted = drive root"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report planned counts without writing"),
        folder_id: z.string().describe("Folder UUID to move"),
        name: z.string().optional().describe("Rename the folder while moving"),
      },
    },
    async ({ folder_id, dest_folder_id, name, dry_run }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const result = await moveFolder(
        env,
        folder_id,
        { destFolderId: dest_folder_id, dryRun: dry_run, name },
        user,
      );
      if (result.kind !== "ok") {
        return moveToolError(result);
      }
      return textResult(result.result);
    },
  );

  server.registerTool(
    "move_folder_contents",
    {
      description:
        "Move the direct notes (and optionally direct subfolders with their subtrees) of a folder into another folder. The source folder itself stays. Set dry_run first to preview counts and skip reasons.",
      inputSchema: {
        dest_folder_id: z
          .string()
          .nullable()
          .optional()
          .describe("Destination folder UUID; null/omitted = drive root"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report planned moves without writing"),
        folder_id: z.string().describe("Source folder UUID"),
        include_subfolders: z
          .boolean()
          .optional()
          .describe("Also move direct child folders (default false)"),
      },
    },
    async ({ folder_id, dest_folder_id, include_subfolders, dry_run }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const result = await moveFolderContents(
        env,
        folder_id,
        {
          destFolderId: dest_folder_id,
          dryRun: dry_run,
          includeSubfolders: include_subfolders,
        },
        user,
      );
      if (result.kind !== "ok") {
        return moveToolError(result);
      }
      return textResult(result.result);
    },
  );

  server.registerTool(
    "move_notes",
    {
      description:
        "Move notes (by UUID or short ID) into a folder in the caller's own drive. Returns per-note moved/skipped/failed with reasons. Max 500 IDs per call. Set dry_run first to preview.",
      inputSchema: {
        dry_run: z
          .boolean()
          .optional()
          .describe("Report planned moves without writing"),
        folder_id: z
          .string()
          .nullable()
          .optional()
          .describe("Destination folder UUID; null/omitted = drive root"),
        note_ids: z
          .array(z.string())
          .min(1)
          .describe("Note UUIDs or short IDs to move"),
      },
    },
    async ({ note_ids, folder_id, dry_run }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      const result = await moveNotes(
        env,
        { destFolderId: folder_id, dryRun: dry_run, noteIds: note_ids },
        user,
      );
      if (result.kind !== "ok") {
        return moveToolError(result);
      }
      return textResult(result.result);
    },
  );

  // para_* tools exist only once a PARA space is configured.
  if (features.hasPara) {
    server.registerTool(
      "para_list",
      {
        description:
          "List the caller's PARA spaces with their buckets (Projects/Areas/Resources/Archives). Buckets keep stable keys across renames. With bucket, also returns the direct children (e.g. active projects).",
        inputSchema: {
          bucket: z
            .enum(["projects", "areas", "resources", "archives"])
            .optional()
            .describe("Return direct children of this bucket too"),
          space: z
            .string()
            .optional()
            .describe(
              "PARA space name or id; 'default' = the rootless space. Omit = all spaces; bucket children resolve in the default space unless space is given.",
            ),
        },
      },
      async ({ bucket, space }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await paraList(env, user, bucket, space);
        if (result.kind === "denied") {
          return textError("Unauthorized");
        }
        if (result.kind === "invalid") {
          return textError(result.error);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "para_archive_project",
      {
        description:
          "Move a folder inside the Projects bucket into Archives. dated adds a YYYY-MM- prefix to the name. Set dry_run first to preview counts.",
        inputSchema: {
          dated: z
            .boolean()
            .optional()
            .describe("Prefix the archived name with YYYY-MM-"),
          dry_run: z
            .boolean()
            .optional()
            .describe("Report planned counts without writing"),
          folder_id: z
            .string()
            .describe("Folder UUID inside the Projects bucket"),
          name: z
            .string()
            .optional()
            .describe("Override the archived folder name"),
        },
      },
      async ({ folder_id, dated, name, dry_run }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await paraArchiveProject(
          env,
          folder_id,
          { dated, dryRun: dry_run, name },
          user,
        );
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );
  }

  // scheme_*/jd_* tools exist only once a naming-scheme folder is configured.
  if (features.hasSchemes) {
    server.registerTool(
      "set_folder_scheme",
      {
        description:
          "Opt-in naming rule for a folder's future children. 'jd' = Johnny.Decimal (10 areas / 10 categories / 100 IDs), 'zettel' = Zettelkasten UTC timestamp IDs (YYYYMMDDHHmm). Existing children keep their names — the scheme only affects new creates. Pass null to clear. Owner only.",
        inputSchema: {
          folder_id: z
            .string()
            .describe("Folder UUID that declares the naming rule"),
          scheme: z
            .enum(["jd", "zettel"])
            .nullable()
            .describe("Naming rule to apply, or null to clear"),
        },
      },
      async ({ folder_id, scheme }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await setFolderScheme(env, folder_id, scheme, user);
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "scheme_get",
      {
        description:
          "Resolve a naming-scheme ID (e.g. '15.22' or '202609171230') to the folder that carries it in the caller's own drive, and list its direct children.",
        inputSchema: {
          id: z
            .string()
            .describe("Scheme ID such as '15.22' or '202609171230'"),
        },
      },
      async ({ id }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await schemeGet(env, id, user);
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "jd_allocate_id",
      {
        description:
          "Allocate the next Johnny.Decimal ID under a JD folder without creating anything. Under a JD root returns an area ('10-19'), under an area a category ('15'), under a category an ID ('15.22'). Category-local max+1 — gaps are never reused and .00–.10 stay reserved. Errors once a category reaches 100 IDs.",
        inputSchema: {
          folder_id: z
            .string()
            .describe("JD root, area, or category folder UUID"),
        },
      },
      async ({ folder_id }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await jdAllocateId(env, folder_id, user);
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "jd_create_id_folder",
      {
        description:
          "Allocate a Johnny.Decimal ID and create the child folder ('15.22 Title') under a JD root/area/category. title defaults to 無題 — rename later. Pass scheme_id to claim a specific number instead of the next one.",
        inputSchema: {
          folder_id: z
            .string()
            .describe("JD root, area, or category folder UUID"),
          scheme_id: z
            .string()
            .optional()
            .describe(
              "Explicit ID ('10-19' / '15' / '15.22') instead of auto-allocation",
            ),
          title: z
            .string()
            .optional()
            .describe("Title after the ID (default 無題)"),
        },
      },
      async ({ folder_id, scheme_id, title }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await createSchemeChild(
          env,
          folder_id,
          { schemeId: scheme_id, title },
          user,
        );
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "jd_get",
      {
        description:
          "Resolve a Johnny.Decimal ID such as '15.22' to its folder and list the direct children. Same resolution as scheme_get but JD-only.",
        inputSchema: {
          id: z.string().describe("JD ID such as '10-19', '15', or '15.22'"),
        },
      },
      async ({ id }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await schemeGet(env, id, user);
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "jd_list_category",
      {
        description:
          "List a JD container's numbered children in numeric order — areas under a JD root, categories under an area, IDs under a category.",
        inputSchema: {
          folder_id: z
            .string()
            .describe("JD root, area, or category folder UUID"),
        },
      },
      async ({ folder_id }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await jdListCategory(env, folder_id, user);
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );

    server.registerTool(
      "jd_validate_tree",
      {
        description:
          "Validate the caller's naming-scheme tree: JD area/category/ID counts, naming-pattern deviations ('15.22 Title'), duplicate IDs, reserved .00–.10 usage, and IDs moved outside their expected parent. Returns a structured issue list.",
        inputSchema: {},
      },
      async () => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await validateSchemeTree(env, user);
        if (result.kind !== "ok") {
          return moveToolError(result);
        }
        return textResult(result.result);
      },
    );
  }

  // §2.6 permanent edit lock — always available (not feature-gated).
  server.registerTool(
    "set_edit_lock",
    {
      description:
        "Lock or unlock a note for editing. While locked every mutation — body edits, metadata, folder move, delete, sharing — is rejected until explicit unlock (locked=false). There is no timed unlock. Requires canAdmin. Unlocking (locked=false) additionally requires confirm=true.",
      inputSchema: {
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true when locked=false (unlock is gated like promote_note's confirm)",
          ),
        id: z.string().describe("Note UUID or short ID"),
        locked: z
          .boolean()
          .describe("true to lock (read-only), false to unlock"),
      },
    },
    async ({ id, locked, confirm }) => {
      const user = requireUser();
      if (!user) {
        return textError("Unauthorized");
      }
      // §2.6: unlocking via MCP requires an explicit confirm so a tool call
      // cannot silently reopen a preserved note.
      if (!locked && confirm !== true) {
        return textError(
          "confirm=true is required to unlock a note (set_edit_lock with locked=false)",
        );
      }
      const result = await notes.setEditLock(id, user, locked);
      return mutateNoteToolResponse(result);
    },
  );

  // medallion_* tools exist only once a medallion set is configured.
  if (features.hasMedallion) {
    server.registerTool(
      "medallion_list_sets",
      {
        description:
          "List the caller's medallion layer sets (name + ordered key/label layers) and the folders assigned to them. Medallion layers are folder-level display labels — they do not affect editability (see set_edit_lock).",
        inputSchema: {},
      },
      async () => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        return textResult({
          assignments: await listMedallionAssignments(env, user),
          sets: await listMedallionSets(env, user),
        });
      },
    );

    server.registerTool(
      "medallion_assign_folder",
      {
        description:
          "Assign a medallion set layer to a folder. Descendant folders and their notes inherit the nearest assigned ancestor's layer. One assignment per folder; reassigning overwrites it.",
        inputSchema: {
          folder_id: z.string().describe("Folder UUID"),
          layer: z
            .string()
            .describe("Layer key inside the set (e.g. 'output')"),
          set_id: z.string().describe("Medallion set UUID"),
        },
      },
      async ({ folder_id, set_id, layer }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await assignFolderMedallion(
          env,
          user,
          folder_id,
          set_id,
          layer,
        );
        if (result.kind !== "ok") {
          return medallionToolError(result);
        }
        return textResult({ assignment: result.result });
      },
    );

    server.registerTool(
      "medallion_unassign_folder",
      {
        description:
          "Clear a folder's medallion assignment. Descendants then inherit from the next assigned ancestor (or none).",
        inputSchema: {
          folder_id: z.string().describe("Folder UUID"),
        },
      },
      async ({ folder_id }) => {
        const user = requireUser();
        if (!user) {
          return textError("Unauthorized");
        }
        const result = await clearFolderMedallion(env, user, folder_id);
        if (result.kind !== "ok") {
          return medallionToolError(result);
        }
        return textResult({ cleared: true, folder_id });
      },
    );
  }

  return server;
}
