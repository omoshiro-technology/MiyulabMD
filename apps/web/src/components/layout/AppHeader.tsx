import type { SessionUser } from "@miyulabmd/shared";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";

import type { AuthConfig } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";

import { IconButton } from "../ui/IconButton.tsx";
import { SearchIcon } from "../ui/icons.tsx";
import { MutedText } from "../ui/Text.tsx";
import { AccountMenu } from "./AccountMenu.tsx";
import { OfflineStatusBadge } from "./OfflineStatusBadge.tsx";
import { SitePublishButton } from "./SitePublishButton.tsx";

type Props = {
  actions?: ReactNode;
  cachedUser?: SessionUser | null;
  end?: ReactNode;
  folder?: string | null;
  /** サーバーと疎通できずローカルキャッシュで表示しているとき true。 */
  offline?: boolean;
  user: SessionUser | null;
  loading: boolean;
  authConfig: AuthConfig;
  onOpenSearch?: () => void;
};

export function AppHeader({
  actions,
  cachedUser,
  end,
  folder,
  offline,
  user,
  loading,
  authConfig,
  onOpenSearch,
}: Props) {
  const headerRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) {
      return;
    }
    const update = () => {
      document.documentElement.style.setProperty(
        "--header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--header-height");
    };
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-[var(--app-offset-top,0px)] z-40 grid min-h-[3.25rem] items-center gap-2 border-b border-border bg-surface px-[0.9rem] py-[0.4rem] max-[900px]:px-3 max-[640px]:gap-1 max-[640px]:px-2",
        actions
          ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
          : "grid-cols-[minmax(0,1fr)_auto]",
      )}
      ref={headerRef}
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1">
        <Link
          aria-label="MiyulabMD ホーム"
          className="shrink-0 font-bold text-inherit no-underline"
          to="/"
        >
          MiyulabMD
        </Link>
        {onOpenSearch && (
          <IconButton
            aria-label="検索 (Ctrl+K)"
            onClick={onOpenSearch}
            title="検索 (Ctrl+K)"
            variant="ghost"
          >
            <SearchIcon />
          </IconButton>
        )}
        {offline && <OfflineStatusBadge />}
      </div>
      {actions && (
        <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-center">
          {actions}
        </div>
      )}
      <nav
        className={cn(
          "row-start-1 flex min-w-0 items-center justify-end gap-2 max-[900px]:gap-1",
          actions ? "col-start-3" : "col-start-2",
        )}
      >
        <SitePublishButton folder={folder} user={user} />
        {end}
        {loading ? (
          <MutedText className="m-0">…</MutedText>
        ) : (
          <AccountMenu
            authConfig={authConfig}
            cachedUser={cachedUser}
            user={user}
          />
        )}
      </nav>
    </header>
  );
}
