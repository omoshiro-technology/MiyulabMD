import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";

type PanelProps = {
  children: ReactNode;
  align?: "start" | "end";
  role?: "menu" | "dialog";
  labelledBy?: string;
  width?: string;
  style?: CSSProperties;
};

const panelClass =
  "z-40 min-w-40 rounded-xl border border-border bg-canvas py-[0.35rem] shadow-menu";

export function MenuPanel({
  children,
  align = "end",
  role = "menu",
  labelledBy,
  width,
  style,
}: PanelProps) {
  return (
    <div
      aria-labelledby={labelledBy}
      className={cn(
        panelClass,
        "absolute top-[calc(100%+0.45rem)]",
        align === "end" ? "right-0" : "left-0",
      )}
      role={role}
      style={{ minWidth: width, ...style }}
    >
      {children}
    </div>
  );
}

export function MenuFixed({
  children,
  x,
  y,
  role = "menu",
}: {
  children: ReactNode;
  x: number;
  y: number;
  role?: "menu";
}) {
  return (
    <div
      className={cn(panelClass, "fixed")}
      role={role}
      style={{ left: x, top: y }}
    >
      {children}
    </div>
  );
}

type ItemProps = {
  children: ReactNode;
  active?: boolean;
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  to?: string;
  href?: string;
};

export function MenuItem({
  children,
  active,
  className: itemClassName,
  danger,
  disabled,
  onClick,
  to,
  href,
}: ItemProps) {
  const className = cn(
    "block w-full cursor-pointer border-0 bg-transparent px-4 py-2 text-left text-inherit no-underline",
    "hover:bg-surface",
    active && "bg-surface",
    danger && "text-error",
    disabled && "cursor-default opacity-65",
    itemClassName,
  );

  if (to) {
    return (
      <Link className={className} onClick={onClick} role="menuitem" to={to}>
        {children}
      </Link>
    );
  }

  if (href) {
    return (
      <a className={className} href={href} role="menuitem">
        {children}
      </a>
    );
  }

  return (
    <button
      className={className}
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="my-[0.35rem] h-px border-0 bg-border" />;
}

export function MenuRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      {children}
    </div>
  );
}

export function MenuHeader({
  name,
  email,
  children,
}: {
  name: string;
  email?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-[0.45rem] px-[1.15rem] pt-4 pb-[0.85rem] text-center">
      {children}
      <p className="m-0 font-semibold">{name}</p>
      {email && <p className="m-0 text-[0.85rem] text-muted">{email}</p>}
    </div>
  );
}
