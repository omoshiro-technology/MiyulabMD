import type { MedallionResolution, Note } from "@miyulabmd/shared";

/**
 * エディタヘッダーの 3 層分類（specs/knowledge-management.html §3）。
 * 常時表示 / 条件付き表示 / 「⋯ ノート」オーバーフローメニューに分け、
 * 既存ブレークポイント 900px / 640px（AppHeader・HeaderButton・PresenceBar
 * と同じ CSS メディアクエリ方式）で tier を決める。
 */
export const HEADER_FULL_MIN_WIDTH = 900;
export const HEADER_COMPACT_MIN_WIDTH = 640;

export type EditorHeaderTier = "full" | "compact" | "minimal";

export function headerTierForWidth(width: number): EditorHeaderTier {
  if (!Number.isFinite(width) || width >= HEADER_FULL_MIN_WIDTH) {
    return "full";
  }
  return width >= HEADER_COMPACT_MIN_WIDTH ? "compact" : "minimal";
}

export type EditorHeaderFlags = {
  /** 共同編集ピアが存在する */
  hasPeers?: boolean;
  /** 現在フォルダが記事ソースに一致（⟳ サイトを更新が出せる） */
  hasSiteSource?: boolean;
};

/** 右 nav に並ぶ要素。中央の表示モード切替とメダルバッジは別スロット。 */
export type EditorBarItem =
  | "search"
  | "siteUpdate"
  | "presence"
  | "folder"
  | "overflow"
  | "share"
  | "account";

/**
 * 右 nav の可視要素（§3.2）。DOM 上の並び順をそのまま返す。
 * - full: 検索・サイト更新・presence・フォルダボタンも bar に残す
 * - compact: サイト更新は ⋯ へ退避、副次要素はアイコンのみ（CSS 側）
 * - minimal: ⋯ + 共有 + アカウントのみ（検索は ⋯ の先頭項目へ）
 */
export function headerBarItems(
  tier: EditorHeaderTier,
  flags: EditorHeaderFlags = {},
): EditorBarItem[] {
  const items: EditorBarItem[] = [];
  if (tier !== "minimal") {
    items.push("search");
    if (tier === "full" && flags.hasSiteSource) {
      items.push("siteUpdate");
    }
    if (flags.hasPeers) {
      items.push("presence");
    }
    if (tier === "full") {
      items.push("folder");
    }
  }
  items.push("overflow", "share", "account");
  return items;
}

/** 「⋯ ノート」メニューの項目キー。 */
export type EditorMenuItemKey =
  | "search"
  | "folder"
  | "links"
  | "history"
  | "lock"
  | "siteUpdate"
  | "presence";

/**
 * ⋯ メニューの項目（§3.2）。DOM 上の並び順をそのまま返す。
 * - full: フォルダ / リンク / 履歴 / 編集ロック
 * - compact: 同上 + サイトを更新（一致時のみ）
 * - minimal: 先頭に検索、末尾に presence 情報行
 */
export function overflowMenuItems(
  tier: EditorHeaderTier,
  flags: EditorHeaderFlags = {},
): EditorMenuItemKey[] {
  const items: EditorMenuItemKey[] = [];
  if (tier === "minimal") {
    items.push("search");
  }
  items.push("folder", "links", "history", "lock");
  if (tier !== "full" && flags.hasSiteSource) {
    items.push("siteUpdate");
  }
  if (tier === "minimal" && flags.hasPeers) {
    items.push("presence");
  }
  return items;
}

/**
 * メニュー項目を担当 tier 外で隠す Tailwind クラス。
 * レスポンシブ分岐は CSS で行うため、UI とテストが共有する唯一の実体。
 */
export function menuItemTierClass(key: EditorMenuItemKey): string {
  switch (key) {
    case "search":
    case "presence":
      return "min-[640px]:hidden";
    case "siteUpdate":
      return "min-[900px]:hidden";
    default:
      return "";
  }
}

/** 「フォルダ」項目に添える現在値（§3.1 の現在地表示の代替）。 */
export function folderMenuContext(folder: string): string {
  return folder.trim() || "なし";
}

/**
 * 「編集ロック」項目に添える現在値（§2.6）。
 * 層はフォルダのメダリオン表示のみで、ロックとは独立している。
 */
export function lockMenuContext(
  note: Pick<Note, "editLocked">,
  medallion?: MedallionResolution | null,
): string {
  if (note.editLocked) {
    return "ロック中";
  }
  return medallion?.layerLabel ?? "未ロック";
}
