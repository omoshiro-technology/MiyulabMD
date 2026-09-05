import {
  ARTICLE_FIELD_TYPES,
  type ArticleSchemaField,
  type ArticleSource,
  type FolderRecord,
} from "@miyulabmd/shared";
import { type FormEvent, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { AppShellContext } from "../../components/layout/AppShellContext.ts";
import { FolderHierarchySelect } from "../../components/settings/FolderHierarchySelect.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { CheckLabel, Field, Row } from "../../components/ui/Field.tsx";
import { Input } from "../../components/ui/Input.tsx";
import { Select } from "../../components/ui/Select.tsx";
import { ErrorText, MutedText } from "../../components/ui/Text.tsx";
import {
  createArticleSource,
  deleteArticleSource,
  fetchArticleSources,
  fetchFolderTree,
  updateArticleSource,
} from "../../lib/api.ts";
import { hasSelectableSourceFolders } from "../../lib/folder-tree.ts";

type DraftField = ArticleSchemaField & { rowId: string };

type Draft = {
  id?: string;
  name: string;
  folder: string;
  schema: DraftField[];
  webhookUrl: string;
  webhookAuthorization: string;
  webhookAuthorizationSet: boolean;
};

function newRowId(): string {
  return crypto.randomUUID();
}

function emptyDraft(): Draft {
  return {
    name: "",
    folder: "",
    schema: [],
    webhookUrl: "",
    webhookAuthorization: "",
    webhookAuthorizationSet: false,
  };
}

function draftFromSource(source: ArticleSource): Draft {
  return {
    id: source.id,
    name: source.name,
    folder: source.folder,
    schema: source.schema.map((field) => ({ ...field, rowId: newRowId() })),
    webhookUrl: source.webhookUrl ?? "",
    webhookAuthorization: "",
    webhookAuthorizationSet: source.webhookAuthorizationSet,
  };
}

function defaultForType(type: ArticleSchemaField["type"]): string {
  if (type === "boolean") return "false";
  if (type === "number") return "";
  if (type === "string[]") return "";
  return "";
}

function parseDefault(
  type: ArticleSchemaField["type"],
  raw: string,
): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (type === "boolean") return trimmed === "true";
  if (type === "number") {
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
  }
  if (type === "string[]") {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return trimmed;
}

function defaultToInput(
  type: ArticleSchemaField["type"],
  value: unknown,
): string {
  if (value === undefined || value === null) return "";
  if (type === "string[]" && Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function SiteSettingsPage() {
  const { user } = useOutletContext<AppShellContext>();
  const [sources, setSources] = useState<ArticleSource[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [sourceResult, folderResult] = await Promise.all([
      fetchArticleSources(),
      fetchFolderTree(),
    ]);
    if (!sourceResult.ok) {
      setError(sourceResult.error);
      setSources([]);
    } else {
      setSources(sourceResult.data);
    }
    if (folderResult.ok) setFolders(folderResult.data);
    setLoading(false);
  }

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    void reload();
  }, [user]);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim() || !draft.folder) {
      setError("名前とディレクトリを入力してください。");
      return;
    }
    setSaving(true);
    setError(null);

    const schema = draft.schema
      .filter((field) => field.key.trim())
      .map((field) => {
        const next: ArticleSchemaField = {
          key: field.key.trim(),
          type: field.type,
        };
        if (field.required) next.required = true;
        if (field.fixed) next.fixed = true;
        if (field.enum?.length) next.enum = field.enum;
        const fallback = parseDefault(
          field.type,
          defaultToInput(field.type, field.default),
        );
        if (fallback !== undefined) next.default = fallback;
        return next;
      });

    const input = {
      name: draft.name.trim(),
      folder: draft.folder,
      schema,
      webhookUrl: draft.webhookUrl.trim() || null,
      ...(draft.webhookAuthorization.trim()
        ? { webhookAuthorization: draft.webhookAuthorization.trim() }
        : {}),
    };

    const result = draft.id
      ? await updateArticleSource(draft.id, input)
      : await createArticleSource(input);
    if (!result.ok) {
      setError(result.error);
      setSaving(false);
      return;
    }

    setDraft(null);
    setSaving(false);
    await reload();
  }

  async function handleDelete(id: string) {
    setError(null);
    const result = await deleteArticleSource(id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (draft?.id === id) setDraft(null);
    await reload();
  }

  function updateField(index: number, patch: Partial<DraftField>) {
    if (!draft) return;
    const schema = draft.schema.map((field, i) =>
      i === index ? { ...field, ...patch } : field,
    );
    setDraft({ ...draft, schema });
  }

  if (!user) {
    return (
      <section>
        <h2 className="m-0 text-[1.5em] font-bold">サイト設定</h2>
        <ErrorText>サイト設定を変更するにはログインしてください。</ErrorText>
      </section>
    );
  }

  const canPickSourceFolder = hasSelectableSourceFolders(folders);

  return (
    <section>
      <h2 className="m-0 text-[1.5em] font-bold">サイト設定</h2>
      <p>
        ディレクトリを記事コレクションとして公開します。メタデータはノート先頭の
        YAML frontmatter です。Astro は PAT で{" "}
        <code className="font-mono">/api/articles</code> と{" "}
        <code className="font-mono">/openapi.json</code> を読めます。Webhook
        はヘッダーの「サイトを更新」から送ります。
      </p>

      {error && <ErrorText>{error}</ErrorText>}
      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <ul className="list-none p-0">
          {sources.length === 0 && (
            <li>
              <MutedText>記事ソースはまだありません。</MutedText>
            </li>
          )}
          {sources.map((source) => (
            <li
              key={source.id}
              className="flex justify-between gap-4 border-b border-border py-3 max-[640px]:flex-col max-[640px]:items-start"
            >
              <div>
                <strong>{source.name}</strong>
                <MutedText className="mt-1">{source.folder}</MutedText>
              </div>
              <Row>
                <Button
                  variant="outline"
                  onClick={() => setDraft(draftFromSource(source))}
                >
                  編集
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void handleDelete(source.id)}
                >
                  削除
                </Button>
              </Row>
            </li>
          ))}
        </ul>
      )}

      {!draft && (
        <Button
          className="mt-4"
          variant="accent"
          disabled={!canPickSourceFolder}
          onClick={() => setDraft(emptyDraft())}
        >
          ソースを追加
        </Button>
      )}
      {!draft && !canPickSourceFolder && (
        <MutedText className="mt-2">先にフォルダを作成してください。</MutedText>
      )}

      {draft && (
        <form
          className="mt-6 grid gap-4"
          onSubmit={(event) => void handleSave(event)}
        >
          <h3 className="m-0 text-[1.15rem] font-semibold">
            {draft.id ? "ソースを編集" : "ソースを追加"}
          </h3>
          <Field label="名前" htmlFor="source-name">
            <Input
              id="source-name"
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              placeholder="お知らせ"
            />
          </Field>
          <div className="grid gap-[0.35rem]">
            <span className="text-[0.85rem] text-muted">ディレクトリ</span>
            <FolderHierarchySelect
              id="source-folder"
              folders={folders}
              value={draft.folder}
              onChange={(folder) => setDraft({ ...draft, folder })}
            />
          </div>

          <div>
            <p className="m-0 mb-2 text-[0.85rem] text-muted">
              スキーマ（新規ノートの frontmatter と形式チェック）
            </p>
            <div className="grid gap-3">
              {draft.schema.map((field, index) => (
                <div
                  key={field.rowId}
                  className="grid gap-2 rounded-xl border border-border p-3"
                >
                  <Row className="max-[640px]:flex-col">
                    <Input
                      className="flex-1"
                      placeholder="key"
                      value={field.key}
                      onChange={(event) =>
                        updateField(index, { key: event.target.value })
                      }
                    />
                    <Select
                      className="rounded-lg px-3 py-2.5"
                      value={field.type}
                      onChange={(event) =>
                        updateField(index, {
                          type: event.target
                            .value as ArticleSchemaField["type"],
                          default: undefined,
                        })
                      }
                    >
                      {ARTICLE_FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          schema: draft.schema.filter((_, i) => i !== index),
                        })
                      }
                    >
                      削除
                    </Button>
                  </Row>
                  <Input
                    placeholder={
                      field.type === "string[]"
                        ? "default（カンマ区切り）"
                        : "default"
                    }
                    value={defaultToInput(field.type, field.default)}
                    onChange={(event) =>
                      updateField(index, {
                        default: parseDefault(field.type, event.target.value),
                      })
                    }
                  />
                  {field.type === "string" && (
                    <Input
                      placeholder="enum（カンマ区切り、任意）"
                      value={(field.enum ?? []).join(", ")}
                      onChange={(event) =>
                        updateField(index, {
                          enum: event.target.value
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  )}
                  <Row>
                    <CheckLabel>
                      <input
                        type="checkbox"
                        checked={Boolean(field.required)}
                        onChange={(event) =>
                          updateField(index, { required: event.target.checked })
                        }
                      />
                      必須
                    </CheckLabel>
                    <CheckLabel>
                      <input
                        type="checkbox"
                        checked={Boolean(field.fixed)}
                        onChange={(event) =>
                          updateField(index, { fixed: event.target.checked })
                        }
                      />
                      固定
                    </CheckLabel>
                  </Row>
                </div>
              ))}
            </div>
            <Button
              className="mt-2"
              variant="outline"
              onClick={() =>
                setDraft({
                  ...draft,
                  schema: [
                    ...draft.schema,
                    {
                      rowId: newRowId(),
                      key: "",
                      type: "string",
                      default: defaultForType("string"),
                    },
                  ],
                })
              }
            >
              フィールドを追加
            </Button>
          </div>

          <Field label="Webhook URL" htmlFor="webhook-url">
            <Input
              id="webhook-url"
              type="url"
              value={draft.webhookUrl}
              onChange={(event) =>
                setDraft({ ...draft, webhookUrl: event.target.value })
              }
              placeholder="https://api.github.com/repos/org/repo/dispatches"
            />
          </Field>
          <Field label="Webhook Authorization" htmlFor="webhook-auth">
            <Input
              id="webhook-auth"
              type="password"
              value={draft.webhookAuthorization}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  webhookAuthorization: event.target.value,
                })
              }
              placeholder={
                draft.webhookAuthorizationSet
                  ? "設定済み（変更するときだけ入力）"
                  : "Bearer ghp_..."
              }
              autoComplete="off"
            />
          </Field>

          <Row>
            <Button variant="accent" type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              キャンセル
            </Button>
          </Row>
        </form>
      )}
    </section>
  );
}
