import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";
import { TREE_DRAG_MIME } from "../../lib/dnd.ts";
import { IconButton } from "./IconButton.tsx";
import { ChevronDownIcon, MoreIcon } from "./icons.tsx";

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

export type DriveRowToggle = {
  expanded: boolean;
  onToggle: () => void;
};

function dndHandlers(
  dragPayload: string | undefined,
  onDropPayload: ((payload: string) => void) | undefined,
  readonly: boolean,
  setDropActive: (active: boolean) => void,
) {
  const draggable = dragPayload !== undefined && !readonly;
  return {
    draggable,
    onDragLeave: onDropPayload ? () => setDropActive(false) : undefined,
    onDragOver: onDropPayload
      ? (event: React.DragEvent<HTMLLIElement>) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropActive(true);
        }
      : undefined,
    onDragStart:
      dragPayload !== undefined && !readonly
        ? (event: React.DragEvent<HTMLLIElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(TREE_DRAG_MIME, dragPayload);
          }
        : undefined,
    onDrop: onDropPayload
      ? (event: React.DragEvent<HTMLLIElement>) => {
          event.preventDefault();
          setDropActive(false);
          const payload = event.dataTransfer.getData(TREE_DRAG_MIME);
          if (payload) {
            onDropPayload(payload);
          }
        }
      : undefined,
  };
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
  depth = 0,
  toggle,
  dragPayload,
  onDropPayload,
}: {
  href: string;
  name: string;
  icon: ReactNode;
  meta?: ReactNode;
  menuOpen: boolean;
  onMenu?: (event: MouseEvent) => void;
  onPointerEnter?: () => void;
  readonly?: boolean;
  depth?: number;
  /** Tree slot: a chevron toggle, or "leaf" to keep leaf rows aligned. */
  toggle?: DriveRowToggle | "leaf";
  /** Makes the row draggable; the payload is written to the drag event. */
  dragPayload?: string;
  /** Makes the row a drop target; called with the dropped payload. */
  onDropPayload?: (payload: string) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const dnd = dndHandlers(
    dragPayload,
    readonly ? undefined : onDropPayload,
    readonly,
    setDropActive,
  );
  return (
    <li
      className={cn(
        "group flex items-center border-b border-border p-0 last:border-b-0 hover:bg-surface",
        menuOpen && "bg-surface",
        dropActive && "bg-surface shadow-[inset_0_0_0_2px_var(--color-accent)]",
      )}
      onContextMenu={readonly ? undefined : onMenu}
      style={depth > 0 ? { paddingLeft: `${depth * 1.5}rem` } : undefined}
      {...dnd}
    >
      {toggle !== undefined &&
        (toggle === "leaf" ? (
          <span aria-hidden={true} className="ml-[0.45rem] w-6 shrink-0" />
        ) : (
          <IconButton
            aria-expanded={toggle.expanded}
            aria-label={
              toggle.expanded ? `${name} を折りたたむ` : `${name} を展開`
            }
            className="ml-[0.45rem] shrink-0 text-muted"
            onClick={toggle.onToggle}
            size="sm"
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                !toggle.expanded && "-rotate-90",
              )}
            />
          </IconButton>
        ))}
      <Link
        className={cn(
          "flex min-h-12 min-w-0 flex-1 items-center gap-[0.7rem] py-[0.55rem] text-inherit no-underline",
          toggle === undefined ? "px-[0.9rem]" : "pl-[0.45rem] pr-[0.9rem]",
        )}
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
