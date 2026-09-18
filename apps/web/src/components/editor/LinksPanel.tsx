import type {
  NoteBacklinkItem,
  NoteLinkItem,
  NoteLinksResult,
} from "@miyulabmd/shared";
import { useNavigate } from "react-router";
import { cn } from "../../lib/cn.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { CloseIcon } from "../ui/icons.tsx";
import { ErrorText, MutedText } from "../ui/Text.tsx";

type Props = {
  error: string | null;
  links: NoteLinksResult | null;
  loading: boolean;
  onClose: () => void;
};

const itemButtonClass =
  "w-full cursor-pointer rounded-lg border border-transparent bg-transparent px-3 py-2 text-left hover:bg-fill-hover";

function OutgoingItem({ item }: { item: NoteLinkItem }) {
  const navigate = useNavigate();
  const label = item.display ?? item.target;
  if (!item.note) {
    return (
      <li className="px-3 py-2">
        <p className="m-0 text-[0.85rem] text-muted">
          {label}
          <span className="ml-2 text-[0.75rem]">未解決</span>
        </p>
        <p className="m-0 text-[0.75rem] text-muted">L{item.line}</p>
      </li>
    );
  }
  return (
    <li>
      <button
        className={itemButtonClass}
        onClick={() => navigate(`/n/${item.note?.id}`)}
        type="button"
      >
        <p className="m-0 text-[0.85rem] font-medium">
          {item.note.title}
          {item.display && (
            <span className="ml-2 text-[0.75rem] font-normal text-muted">
              {item.display}
            </span>
          )}
        </p>
        <p className="m-0 text-[0.75rem] text-muted">
          L{item.line}
          {item.heading ? ` · #${item.heading}` : ""}
        </p>
      </button>
    </li>
  );
}

function BacklinkItem({ item }: { item: NoteBacklinkItem }) {
  const navigate = useNavigate();
  return (
    <li>
      <button
        className={itemButtonClass}
        onClick={() => navigate(`/n/${item.note.id}`)}
        type="button"
      >
        <p className="m-0 text-[0.85rem] font-medium">{item.note.title}</p>
        <p className="m-0 text-[0.75rem] text-muted">
          L{item.line}
          {item.heading ? ` · #${item.heading}` : ""}
        </p>
      </button>
    </li>
  );
}

function Section({
  title,
  children,
  empty,
  count,
}: {
  title: string;
  children: React.ReactNode;
  empty: string;
  count: number;
}) {
  return (
    <section>
      <h3 className="m-0 px-1 text-[0.8rem] font-semibold text-muted">
        {title}
        <span className="ml-2 font-normal">{count}</span>
      </h3>
      {count === 0 ? (
        <MutedText className="px-1">{empty}</MutedText>
      ) : (
        <ul className="m-0 list-none p-0">{children}</ul>
      )}
    </section>
  );
}

/** 右ペイン: outgoing links / backlinks。本文はクリック可能なまま。 */
export function LinksPanel({ error, links, loading, onClose }: Props) {
  const outgoing = links?.outgoing ?? [];
  const backlinks = links?.backlinks ?? [];
  return (
    <aside
      aria-label="リンク"
      className={cn(
        "fixed top-[var(--header-height)] right-0 bottom-0 z-30 flex w-72 flex-col gap-4 overflow-y-auto border-border border-l bg-surface p-4 shadow-lg",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-sm font-semibold">リンク</h2>
        <IconButton aria-label="閉じる" onClick={onClose} title="閉じる">
          <CloseIcon />
        </IconButton>
      </div>
      {loading && !links && <MutedText>読み込み中…</MutedText>}
      {error && <ErrorText>{error}</ErrorText>}
      {links && (
        <>
          <Section
            count={backlinks.length}
            empty="このノートへのリンクはありません。"
            title="Backlinks"
          >
            {backlinks.map((item) => (
              <BacklinkItem
                item={item}
                key={`${item.note.id}:${item.line}:${item.target}`}
              />
            ))}
          </Section>
          <Section
            count={outgoing.length}
            empty="このノートからのリンクはありません。"
            title="Outgoing"
          >
            {outgoing.map((item) => (
              <OutgoingItem
                item={item}
                key={`${item.target}:${item.line}:${item.heading ?? ""}`}
              />
            ))}
          </Section>
        </>
      )}
    </aside>
  );
}
