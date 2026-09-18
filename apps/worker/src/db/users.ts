import type { SessionUser } from "@miyulabmd/shared";

import { db } from "./client.ts";

export type DbUser = {
  id: string;
  email: string;
  displayName: string | null;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toSessionUser(user: DbUser): SessionUser {
  return {
    displayName: user.displayName,
    email: user.email,
    id: user.id,
  };
}

export async function upsertUserByEmail(
  env: Env,
  email: string,
  displayName?: string | null,
): Promise<DbUser> {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();

  const existing = await db(env)
    .prepare("SELECT id, email, display_name FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<UserRow>();

  if (existing) {
    const nextDisplayName = existing.display_name ?? displayName ?? null;
    await db(env)
      .prepare(
        "UPDATE users SET last_login_at = ?, display_name = COALESCE(display_name, ?) WHERE id = ?",
      )
      .bind(now, displayName ?? null, existing.id)
      .run();

    return {
      displayName: nextDisplayName,
      email: existing.email,
      id: existing.id,
    };
  }

  const id = crypto.randomUUID();
  await db(env)
    .prepare(
      "INSERT INTO users (id, email, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, normalizedEmail, displayName ?? null, now, now)
    .run();

  return {
    displayName: displayName ?? null,
    email: normalizedEmail,
    id,
  };
}

export async function findUserByEmail(
  env: Env,
  email: string,
): Promise<DbUser | null> {
  const row = await db(env)
    .prepare("SELECT id, email, display_name FROM users WHERE email = ?")
    .bind(normalizeEmail(email))
    .first<UserRow>();
  if (!row) {
    return null;
  }
  return {
    displayName: row.display_name,
    email: row.email,
    id: row.id,
  };
}

export async function findUserById(
  env: Env,
  id: string,
): Promise<DbUser | null> {
  const row = await db(env)
    .prepare("SELECT id, email, display_name FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!row) {
    return null;
  }
  return {
    displayName: row.display_name,
    email: row.email,
    id: row.id,
  };
}

export async function updateDisplayName(
  env: Env,
  userId: string,
  displayName: string | null,
): Promise<DbUser | null> {
  const normalized = displayName?.trim() || null;
  await db(env)
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .bind(normalized, userId)
    .run();

  const row = await db(env)
    .prepare("SELECT id, email, display_name FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!row) {
    return null;
  }
  return {
    displayName: row.display_name,
    email: row.email,
    id: row.id,
  };
}
