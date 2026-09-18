import {
  KNOWLEDGE_FEATURE_KEYS,
  normalizeKnowledgeSettings,
  parseUserSettingsObject,
  type UserSettings,
} from "@miyulabmd/shared";
import { db } from "../db/client.ts";

type SettingsRow = {
  settings: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 移行ルール（specs/knowledge-management.html §2.3）:
 * knowledge.para が未保存なら、para_bucket 割当済みフォルダの有無で導出する。
 */
async function hasParaBucketFolder(env: Env, userId: string): Promise<boolean> {
  const row = await db(env)
    .prepare(
      "SELECT 1 AS found FROM folders WHERE owner_id = ? AND para_bucket IS NOT NULL LIMIT 1",
    )
    .bind(userId)
    .first();
  return row !== null;
}

async function persistSettings(
  env: Env,
  userId: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await db(env)
    .prepare("UPDATE users SET settings = ? WHERE id = ?")
    .bind(JSON.stringify(raw), userId)
    .run();
}

/**
 * users.settings を読み、デフォルトを埋めた UserSettings を返す。
 * knowledge.para が未保存なら導出値を永続化する（遅延移行）。
 * ユーザー行が無い場合はデフォルトを返すだけで永続化しない。
 */
export async function readUserSettings(
  env: Env,
  userId: string,
): Promise<UserSettings> {
  const row = await db(env)
    .prepare("SELECT settings FROM users WHERE id = ?")
    .bind(userId)
    .first<SettingsRow>();

  const raw = parseUserSettingsObject(row?.settings);
  const storedKnowledge = isRecord(raw.knowledge) ? raw.knowledge : {};
  const knowledge = normalizeKnowledgeSettings(storedKnowledge);

  if (row && typeof storedKnowledge.para !== "boolean") {
    knowledge.para = await hasParaBucketFolder(env, userId);
    await persistSettings(env, userId, {
      ...raw,
      knowledge: { ...storedKnowledge, para: knowledge.para },
    });
  }

  return { knowledge };
}

/**
 * settings.knowledge の部分更新。パッチは既知キーの真偽値のみ採用し、
 * 保存済みの未知キー・トップレベルキーは保持する。
 * knowledge.para が結果として未設定なら導出して埋める。
 * ユーザーが存在しなければ null。
 */
export async function updateUserKnowledgeSettings(
  env: Env,
  userId: string,
  patch: Record<string, unknown>,
): Promise<UserSettings | null> {
  const row = await db(env)
    .prepare("SELECT settings FROM users WHERE id = ?")
    .bind(userId)
    .first<SettingsRow>();
  if (!row) {
    return null;
  }

  const raw = parseUserSettingsObject(row.settings);
  const storedKnowledge = isRecord(raw.knowledge) ? raw.knowledge : {};
  const nextKnowledge: Record<string, unknown> = { ...storedKnowledge };
  for (const key of KNOWLEDGE_FEATURE_KEYS) {
    const value = patch[key];
    if (typeof value === "boolean") {
      nextKnowledge[key] = value;
    }
  }
  if (typeof nextKnowledge.para !== "boolean") {
    nextKnowledge.para = await hasParaBucketFolder(env, userId);
  }
  raw.knowledge = nextKnowledge;

  await persistSettings(env, userId, raw);
  return { knowledge: normalizeKnowledgeSettings(nextKnowledge) };
}
