import type { SessionUser } from "@miyulabmd/shared";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";

import type { AuthConfig } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";

import { MutedText } from "../ui/Text.tsx";
import { AccountMenu } from "./AccountMenu.tsx";
import { SitePublishButton } from "./SitePublishButton.tsx";

type Props = {
  actions?: ReactNode;
  end?: ReactNode;
  folder?: string | null;
  user: SessionUser | null;
  loading: boolean;
  authConfig: AuthConfig;
};

export function AppHeader({
  actions,
  end,
  folder,
  user,
  loading,
  authConfig,
}: Props) {
  const headerRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
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
      ref={headerRef}
      className={cn(
        "fixed inset-x-0 top-[var(--app-offset-top,0px)] z-40 grid min-h-[3.25rem] items-center gap-2 border-b border-border bg-surface px-[0.9rem] py-[0.4rem] max-[900px]:px-3 max-[640px]:gap-1 max-[640px]:px-2",
        actions
          ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
          : "grid-cols-[minmax(0,1fr)_auto]",
      )}
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center">
        <Link
          to="/"
          aria-label="MiyulabMD ホーム"
          className="shrink-0 font-bold text-inherit no-underline"
        >
          MiyulabMD
        </Link>
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
        <SitePublishButton user={user} folder={folder} />
        {end}
        {loading ? (
          <MutedText className="m-0">…</MutedText>
        ) : (
          <AccountMenu user={user} authConfig={authConfig} />
        )}
      </nav>
    </header>
  );
}
