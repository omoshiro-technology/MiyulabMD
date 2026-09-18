import type { ArticleSource, SessionUser } from "@miyulabmd/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatchArticleSource, fetchArticleSources } from "../../lib/api.ts";
import { ARTICLE_CHANGED_EVENT } from "../../lib/article-changed.ts";
import { matchingSiteSource } from "../../lib/site-publish.ts";
import { HeaderButton } from "../ui/HeaderButton.tsx";
import { RefreshIcon } from "../ui/icons.tsx";
import { MenuItem, MenuSeparator } from "../ui/Menu.tsx";

type Props = {
  user: SessionUser | null;
  folder?: string | null;
};

export type SitePublish = {
  busy: boolean;
  error: string | null;
  /** 現在フォルダに一致する記事ソース。対象外なら null。 */
  matched: ArticleSource | null;
  publish: () => void;
};

/**
 * フォルダ一致する記事ソースの購読と dispatch をまとめたフック。
 * ヘッダーボタンと「⋯」メニュー項目（SitePublishMenuItem）で共有する。
 */
export function useSitePublish(
  user: SessionUser | null,
  folder: string | null | undefined,
): SitePublish {
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
      if (document.visibilityState === "visible") {
        void reload();
      }
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

  const publish = useCallback(() => {
    const id = matchedId;
    if (!id) {
      return;
    }
    void (async () => {
      setBusy(true);
      setError(null);
      const result = await dispatchArticleSource(id);
      if (matchedIdRef.current !== id) {
        return;
      }
      if (!result.ok) {
        setError(result.error);
        setBusy(false);
        return;
      }
      await reload();
      if (matchedIdRef.current !== id) {
        return;
      }
      setBusy(false);
    })();
  }, [matchedId, reload]);

  return { busy, error, matched, publish };
}

export function SitePublishButton({ user, folder }: Props) {
  const { busy, error, matched, publish } = useSitePublish(user, folder);

  if (!matched) {
    return null;
  }

  return (
    <span className="relative [[data-layout=editor]_&]:max-[900px]:hidden">
      <HeaderButton
        disabled={busy}
        icon={<RefreshIcon />}
        label={busy ? "更新中…" : "サイトを更新"}
        onClick={publish}
        title={`${matched.name} を更新`}
        variant="outline"
      />
      {error && (
        <span className="absolute top-full left-0 z-50 mt-1 max-w-[16rem] rounded-md bg-canvas px-2 py-1 text-[0.75rem] text-error shadow-modal">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * 「⋯ ノート」メニュー内の「サイトを更新」項目（§3.2: <900px はメニューへ退避）。
 * 一致する記事ソースがないときは描画しない。
 */
export function SitePublishMenuItem({ user, folder }: Props) {
  const { busy, error, matched, publish } = useSitePublish(user, folder);

  if (!matched) {
    return null;
  }

  return (
    <>
      <MenuSeparator />
      <MenuItem disabled={busy} onClick={publish}>
        <span className="flex items-center gap-2">
          <RefreshIcon />
          {busy ? "サイトを更新中…" : `サイトを更新: ${matched.name}`}
        </span>
      </MenuItem>
      {error && (
        <p className="m-0 px-4 py-1 text-[0.75rem] text-error">{error}</p>
      )}
    </>
  );
}
