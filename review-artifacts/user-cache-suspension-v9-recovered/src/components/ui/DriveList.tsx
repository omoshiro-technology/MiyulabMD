import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";
import { IconButton } from "./IconButton.tsx";
import { MoreIcon } from "./icons.tsx";

export function DriveList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "m-0 list-none overflow-hidden rounded-xl border border-border bg-canvas p-0",
        className,
      )}
    >
      {children}
    </ul>
  );
}

export function DriveRow({
  href,
  name,
  icon,
  meta,
  menuOpen,
  onMenu,
  onPointerEnter,
  readonly = false,
}: {
  href: string;
  name: string;
  icon: ReactNode;
  meta?: ReactNode;
  menuOpen: boolean;
  onMenu?: (event: MouseEvent) => void;
  onPointerEnter?: () => void;
  readonly?: boolean;
}) {
  return (
    <li
      className={cn(
        "group flex items-center border-b border-border p-0 last:border-b-0 hover:bg-surface",
        menuOpen && "bg-surface",
      )}
      onContextMenu={readonly ? undefined : onMenu}
    >
      <Link
        className="flex min-h-12 min-w-0 flex-1 items-center gap-[0.7rem] px-[0.9rem] py-[0.55rem] text-inherit no-underline"
        onPointerEnter={onPointerEnter}
        to={href}
      >
        {icon}
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {name}
        </span>
      </Link>
      {meta ? <span className="mr-1 shrink-0">{meta}</span> : null}
      {!readonly && (
        <IconButton
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={`${name} の操作`}
          className={cn(
            "mr-[0.4rem] size-9 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
            menuOpen && "opacity-100",
          )}
          onClick={onMenu}
          onContextMenu={onMenu}
        >
          <MoreIcon />
        </IconButton>
      )}
    </li>
  );
}
