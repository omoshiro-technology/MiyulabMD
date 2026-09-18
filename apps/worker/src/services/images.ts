import {
  EDIT_LOCKED_CODE,
  isAccessScope,
  type SessionUser,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import { resolveNoteAccess } from "./access.ts";
import { viewDeniedHttpStatus } from "./permissions.ts";

const MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type NoteRow = {
  id: string;
  owner_id: string;
  folder: string;
  read_scope: string | null;
  write_scope: string | null;
  edit_locked: number;
};

type ImageRow = {
  id: string;
  note_id: string;
  r2_key: string;
  content_type: string;
};

function findNoteRow(env: Env, idOrShortId: string): Promise<NoteRow | null> {
  return db(env)
    .prepare(
      "SELECT id, owner_id, folder, read_scope, write_scope, edit_locked FROM notes WHERE id = ? OR short_id = ?",
    )
    .bind(idOrShortId, idOrShortId)
    .first<NoteRow>();
}

function accessFields(row: NoteRow) {
  return {
    folder: row.folder ?? "",
    id: row.id,
    ownerId: row.owner_id,
    readScope:
      row.read_scope && isAccessScope(row.read_scope) ? row.read_scope : null,
    writeScope:
      row.write_scope && isAccessScope(row.write_scope)
        ? row.write_scope
        : null,
  };
}

function findImageRow(
  env: Env,
  noteId: string,
  imageId: string,
): Promise<ImageRow | null> {
  return db(env)
    .prepare(
      "SELECT id, note_id, r2_key, content_type FROM images WHERE id = ? AND note_id = ?",
    )
    .bind(imageId, noteId)
    .first<ImageRow>();
}

export type UploadImageResult =
  | { kind: "ok"; id: string; url: string }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403; code?: string }
  | { kind: "bad_request"; error: string };

export type GetImageResult =
  | { kind: "ok"; body: ReadableStream; contentType: string }
  | { kind: "not_found" }
  | { kind: "denied"; status: 401 | 403 };

function imageDeniedStatus(
  env: Env,
  flags: { canView: boolean; canEdit: boolean; canAdmin: boolean },
  ownerId: string,
  user: SessionUser | undefined,
): 401 | 403 {
  return user === undefined
    ? viewDeniedHttpStatus({ flags, ownerId }, undefined, env)
    : 403;
}

export function createImageService(env: Env) {
  return {
    async deleteAllForNote(noteId: string): Promise<void> {
      const rows = await db(env)
        .prepare("SELECT r2_key FROM images WHERE note_id = ?")
        .bind(noteId)
        .all<{ r2_key: string }>();

      const keys = rows.results ?? [];
      if (keys.length === 0) {
        return;
      }

      await Promise.all(keys.map((entry) => env.IMAGES.delete(entry.r2_key)));
    },

    async get(
      noteIdOrShortId: string,
      imageId: string,
      user?: SessionUser,
    ): Promise<GetImageResult> {
      const row = await findNoteRow(env, noteIdOrShortId);
      if (!row) {
        return { kind: "not_found" };
      }

      const access = await resolveNoteAccess(env, accessFields(row), user);
      if (!access.flags.canView) {
        return {
          kind: "denied",
          status: imageDeniedStatus(env, access.flags, row.owner_id, user),
        };
      }

      const image = await findImageRow(env, row.id, imageId);
      if (!image) {
        return { kind: "not_found" };
      }

      const object = await env.IMAGES.get(image.r2_key);
      if (!object?.body) {
        return { kind: "not_found" };
      }

      return {
        body: object.body,
        contentType: image.content_type,
        kind: "ok",
      };
    },
    async upload(
      noteIdOrShortId: string,
      user: SessionUser | undefined,
      file: File,
    ): Promise<UploadImageResult> {
      const row = await findNoteRow(env, noteIdOrShortId);
      if (!row) {
        return { kind: "not_found" };
      }

      const access = await resolveNoteAccess(env, accessFields(row), user);
      if (!access.flags.canEdit) {
        return {
          kind: "denied",
          status: imageDeniedStatus(env, access.flags, row.owner_id, user),
        };
      }
      // §2.6: image upload mutates the note — blocked while edit_locked.
      if (row.edit_locked === 1) {
        return { code: EDIT_LOCKED_CODE, kind: "denied", status: 403 };
      }

      const contentType = file.type;
      const ext = EXT_BY_TYPE[contentType];
      if (!ext) {
        return { error: "unsupported content type", kind: "bad_request" };
      }

      if (file.size > MAX_BYTES) {
        return { error: "file exceeds 10MB limit", kind: "bad_request" };
      }

      const imageId = crypto.randomUUID();
      const r2Key = `notes/${row.id}/${imageId}.${ext}`;
      const now = Date.now();

      await env.IMAGES.put(r2Key, file.stream(), {
        httpMetadata: { contentType },
      });

      try {
        await db(env)
          .prepare(
            `INSERT INTO images (id, note_id, r2_key, content_type, byte_size, uploader_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            imageId,
            row.id,
            r2Key,
            contentType,
            file.size,
            user?.id ?? null,
            now,
          )
          .run();
      } catch (error) {
        await env.IMAGES.delete(r2Key);
        throw error;
      }

      return {
        id: imageId,
        kind: "ok",
        url: `/api/notes/${row.id}/images/${imageId}`,
      };
    },
  };
}
