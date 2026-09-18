import type { SessionUser } from "@miyulabmd/shared";
import type { ReactNode } from "react";
import type { ViewerContext } from "../../lib/viewer-context.ts";
import type { createViewingAccess } from "../../lib/viewing-access.ts";

export type HeaderLayout = "page" | "editor";

export type AppShellContext = {
  user: SessionUser | null;
  userLoading: boolean;
  viewer: ViewerContext;
  viewing: ReturnType<typeof createViewingAccess>;
  /** 検索パレットを開く。<640px では「⋯」メニュー内の検索項目がこれを呼ぶ。 */
  openSearch: () => void;
  setUser: (user: SessionUser | null) => void;
  setHeader: (
    header: {
      actions?: ReactNode;
      end?: ReactNode;
      layout?: HeaderLayout;
      /** 一覧・編集中のフォルダ。未設定ならサイト更新ボタンは出さない。 */
      folder?: string | null;
    } | null,
  ) => void;
};
