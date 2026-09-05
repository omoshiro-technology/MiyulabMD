import type { ArticleSource, SessionUser } from "@miyulabmd/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatchArticleSource, fetchArticleSources } from "../../lib/api.ts";
import { ARTICLE_CHANGED_EVENT } from "../../lib/article-changed.ts";
import { matchingSiteSource } from "../../lib/site-publish.ts";
import { HeaderButton } from "../ui/HeaderButton.tsx";
import { RefreshIcon } from "../ui/icons.tsx";

type Props = {
  user: SessionUser | null;
  folder?: string | null;
};

export function SitePublishButton({ user, folder }: Props) {
  const [sources, setSources] = useState<ArticleSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!user) {
      setSources([]);
      return;
    }
    const result = await fetchArticleSources();
    if (!result.ok) {
      setSources([]);
      return;
    }
    setSources(result.data);
  }, [user]);

  useEffect(() => {
    void reload();
    function onChanged() {
      void reload();
    }
    function onVisible() {
      if (document.visibilityState === "visible") void reload();
    }
    window.addEventListener(ARTICLE_CHANGED_EVENT, onChanged);
    window.addEventListener("focus", onChanged);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(ARTICLE_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const matched = user ? matchingSiteSource(folder, sources) : null;
  const matchedId = matched?.id ?? null;
  const matchedIdRef = useRef(matchedId);
  matchedIdRef.current = matchedId;

  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [matchedId]);

  if (!matched) return null;

  async function handleClick() {
    const id = matchedId;
    if (!id) return;
    setBusy(true);
    setError(null);
    const result = await dispatchArticleSource(id);
    if (matchedIdRef.current !== id) return;
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    await reload();
    if (matchedIdRef.current !== id) return;
    setBusy(false);
  }

  return (
    <span className="relative">
      <HeaderButton
        variant="outline"
        icon={<RefreshIcon />}
        label={busy ? "更新中…" : "サイトを更新"}
        title={`${matched.name} を更新`}
        disabled={busy}
        onClick={() => void handleClick()}
      />
      {error && (
        <span className="absolute top-full left-0 z-50 mt-1 max-w-[16rem] rounded-md bg-canvas px-2 py-1 text-[0.75rem] text-error shadow-modal">
          {error}
        </span>
      )}
    </span>
  );
}
