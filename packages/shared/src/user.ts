import type { UserSettings } from "./knowledge.ts";

export type User = {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: number;
  /**
   * ユーザー設定ストア（users.settings JSON の正規化済み値）。
   * /api/me でのみ載る。JWT 由来のセッションでは未設定になり得るため optional。
   */
  settings?: UserSettings;
};

export type SessionUser = Pick<
  User,
  "id" | "email" | "displayName" | "settings"
>;
