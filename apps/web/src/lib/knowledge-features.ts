import {
  DEFAULT_KNOWLEDGE_SETTINGS,
  KNOWLEDGE_FEATURE_KEYS,
  type KnowledgeFeatureKey,
  type KnowledgeSettings,
  normalizeKnowledgeSettings,
  type SessionUser,
} from "@miyulabmd/shared";
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import {
  ensureDefaultMedallionSet,
  fetchMe,
  updateKnowledgeSettings,
} from "./api.ts";

// --- feature registry (specs/knowledge-management.html §2.7) ----------------

export type KnowledgeFeatureSurfaces = {
  /** ホーム画面の専用セクション（PARA のスペース一覧など） */
  homeSection?: boolean;
  /** フォルダ/ノートのコンテキストメニュー項目 */
  contextMenu?: boolean;
  /** エディタヘッダーへの差し込み（メダルバッジなど） */
  editorHeader?: boolean;
};

/** 有効化に副作用がある機能のセットアップ入口。P1 では未使用の拡張スロット。 */
export type KnowledgeFeatureSetupContext = {
  userId: string;
};
export type KnowledgeFeatureSetupOutcome = {
  ok: boolean;
  error?: string;
};

export type KnowledgeFeature = {
  key: KnowledgeFeatureKey;
  label: string;
  description: string;
  /** true = 新規ユーザーにデフォルト ON（後方互換の既存機能のみ） */
  defaultEnabled: boolean;
  setup?: (
    ctx: KnowledgeFeatureSetupContext,
  ) => Promise<KnowledgeFeatureSetupOutcome>;
  surfaces: KnowledgeFeatureSurfaces;
};

export const KNOWLEDGE_FEATURES: Record<KnowledgeFeatureKey, KnowledgeFeature> =
  {
    layers: {
      defaultEnabled: true,
      description:
        "フォルダに割り当てる「情報の種類」の表示ラベル（raw / knowledge / output など）。無効化するとメダル表示と割当メニューを隠します。割当データやノートの編集ロックは残ります。",
      key: "layers",
      label: "メダリオン層",
      // §2.6: enabling the feature seeds the built-in 精緻度 set (idempotent).
      setup: async () => {
        const result = await ensureDefaultMedallionSet();
        return result.ok ? { ok: true } : { error: result.error, ok: false };
      },
      surfaces: { contextMenu: true, editorHeader: true },
    },
    para: {
      defaultEnabled: false,
      description:
        "Projects / Areas / Resources / Archives の 4 バケツをスペース単位で管理します。有効化するとスペースとバケツフォルダを作成します。無効化してもデータは残ります。",
      key: "para",
      label: "PARA メソッド",
      surfaces: { contextMenu: true, homeSection: true },
    },
    schemes: {
      defaultEnabled: true,
      description:
        "Johnny Decimal や Zettelkasten などの命名規則をフォルダに設定し、新規フォルダ名を自動採番します。無効化すると設定メニューを隠します。設定済みのルールは残ります。",
      key: "schemes",
      label: "命名規則",
      surfaces: { contextMenu: true },
    },
  };

export const KNOWLEDGE_FEATURE_LIST: KnowledgeFeature[] =
  KNOWLEDGE_FEATURE_KEYS.map((key) => KNOWLEDGE_FEATURES[key]);

// --- client mirror (§2.3: sessionStorage mirror + per-user localStorage hint)

export const KNOWLEDGE_MIRROR_SESSION_KEY = "miyulabmd:knowledge-features";

export function knowledgeMirrorHintKey(userId: string): string {
  return `miyulabmd:knowledge-features:${userId}`;
}

export type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type KnowledgeMirrorStorages = {
  /** セッション内ミラー（本命）。未注入時は sessionStorage。 */
  session?: StorageLike | null;
  /** 再訪問時の初回ペイント用ヒント（ユーザー別キー）。未注入時は localStorage。 */
  hint?: StorageLike | null;
};

function defaultStorages(): KnowledgeMirrorStorages {
  return {
    hint: typeof localStorage === "undefined" ? null : localStorage,
    session: typeof sessionStorage === "undefined" ? null : sessionStorage,
  };
}

function safeGet(storage: StorageLike | null | undefined, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(
  storage: StorageLike | null | undefined,
  key: string,
  value: string,
) {
  try {
    storage?.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeRemove(storage: StorageLike | null | undefined, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    // ignore
  }
}

/** ミラー/ヒントは必ず userId 紐付け。不一致なら他人のフラグなので破棄する。 */
function parseMirrorPayload(
  raw: string | null,
  userId: string,
): KnowledgeSettings | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as {
      knowledge?: unknown;
      userId?: unknown;
    };
    if (value.userId !== userId) {
      return null;
    }
    return normalizeKnowledgeSettings(value.knowledge);
  } catch {
    return null;
  }
}

export function readKnowledgeMirror(
  userId: string,
  storages: KnowledgeMirrorStorages = defaultStorages(),
): KnowledgeSettings | null {
  const session = parseMirrorPayload(
    safeGet(storages.session, KNOWLEDGE_MIRROR_SESSION_KEY),
    userId,
  );
  if (session) {
    return session;
  }
  return parseMirrorPayload(
    safeGet(storages.hint, knowledgeMirrorHintKey(userId)),
    userId,
  );
}

export function writeKnowledgeMirror(
  userId: string,
  knowledge: KnowledgeSettings,
  storages: KnowledgeMirrorStorages = defaultStorages(),
): void {
  const payload = JSON.stringify({ knowledge, userId });
  safeSet(storages.session, KNOWLEDGE_MIRROR_SESSION_KEY, payload);
  safeSet(storages.hint, knowledgeMirrorHintKey(userId), payload);
}

export function clearKnowledgeMirror(
  userId: string | null,
  storages: KnowledgeMirrorStorages = defaultStorages(),
): void {
  safeRemove(storages.session, KNOWLEDGE_MIRROR_SESSION_KEY);
  if (userId) {
    safeRemove(storages.hint, knowledgeMirrorHintKey(userId));
  }
}

/**
 * 有効フラグの解決: サーバー値（viewer.user.settings.knowledge）を権威とし、
 * 未確定の間はセッションミラー→永続ヒント→デフォルトの順で埋める。
 * サーバー値が取れたときはミラーへ write-through する。
 */
export function resolveKnowledgeSettings(
  user: SessionUser | null | undefined,
  storages: KnowledgeMirrorStorages = defaultStorages(),
): KnowledgeSettings {
  const serverKnowledge = user?.settings?.knowledge;
  if (user && serverKnowledge) {
    const knowledge = normalizeKnowledgeSettings(serverKnowledge);
    writeKnowledgeMirror(user.id, knowledge, storages);
    return knowledge;
  }
  if (user) {
    const mirrored = readKnowledgeMirror(user.id, storages);
    if (mirrored) {
      return mirrored;
    }
  }
  return { ...DEFAULT_KNOWLEDGE_SETTINGS };
}

// --- hooks -----------------------------------------------------------------

/**
 * opt-in 連動ルール（§3.3）用の出し分けフック。
 * viewer.user.settings.knowledge を読み、未確定時はミラーで埋める。
 */
export function useKnowledgeFeature(key: KnowledgeFeatureKey): boolean {
  const { user } = useOutletContext<AppShellContext>();
  const knowledge = resolveKnowledgeSettings(user);
  return knowledge[key];
}

export type KnowledgeFeatureToggle = {
  enabled: boolean;
  error: string | null;
  saving: boolean;
  setEnabled: (next: boolean) => Promise<void>;
};

/**
 * 設定ページ用のトグル。PATCH /api/me で部分更新し、成功時は viewer と
 * ミラーの両方へ反映する。マウント時に /api/me を取り直して最新値に揃える
 * （§2.3: 設定画面はミラーに依存しない）。
 */
export function useKnowledgeFeatureToggle(
  key: KnowledgeFeatureKey,
): KnowledgeFeatureToggle {
  const { setUser } = useOutletContext<AppShellContext>();
  const enabled = useKnowledgeFeature(key);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMe().then((fresh) => {
      if (!cancelled && fresh) {
        setUser(fresh);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  // Features with a setup step (e.g. layers seeds 精緻度) run it after the
  // flag lands. A failed setup surfaces an error but keeps the flag on — the
  // step is idempotent and retried on the next enable/page visit.
  const runFeatureSetup = useCallback(
    async (featureKey: KnowledgeFeatureKey, userId: string) => {
      const setup = KNOWLEDGE_FEATURES[featureKey].setup;
      const outcome = await setup?.({ userId });
      if (outcome && !outcome.ok) {
        setError(outcome.error ?? "初期データの作成に失敗しました。");
      }
    },
    [],
  );

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (saving) {
        return;
      }
      setSaving(true);
      setError(null);
      const result = await updateKnowledgeSettings({
        [key]: next,
      } as Partial<KnowledgeSettings>);
      if (!result.ok) {
        setError(
          result.status === 401
            ? "設定を変更するにはログインが必要です。"
            : result.error,
        );
        setSaving(false);
        return;
      }
      setUser(result.data);
      if (result.data.settings?.knowledge) {
        writeKnowledgeMirror(result.data.id, result.data.settings.knowledge);
      }
      if (next) {
        await runFeatureSetup(key, result.data.id);
      }
      setSaving(false);
    },
    [key, saving, setUser, runFeatureSetup],
  );

  return { enabled, error, saving, setEnabled };
}
