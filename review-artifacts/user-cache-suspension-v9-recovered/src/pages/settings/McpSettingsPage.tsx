import { type FormEvent, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { AppShellContext } from "../../components/layout/AppShellContext.ts";
import { McpClientGuide } from "../../components/settings/McpClientGuide.tsx";
import { McpSetupHelp } from "../../components/settings/McpSetupHelp.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Field, Row } from "../../components/ui/Field.tsx";
import { Input } from "../../components/ui/Input.tsx";
import { ErrorText, MutedText } from "../../components/ui/Text.tsx";
import {
  type ApiTokenCreated,
  type ApiTokenSummary,
  createToken,
  fetchTokens,
  revokeToken,
} from "../../lib/api.ts";

function formatTimestamp(ms: number | null): string {
  if (ms === null) {
    return "未使用";
  }
  return new Date(ms).toLocaleString();
}

export function McpSettingsPage() {
  const { user } = useOutletContext<AppShellContext>();
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<ApiTokenCreated | null>(
    null,
  );

  async function loadTokens(actorId: string | null) {
    const result = await fetchTokens({ viewerId: actorId });
    return result;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: Preserve the existing request lifecycle.
  useEffect(() => {
    let current = true;
    setLoading(Boolean(user));
    setError(null);
    if (!user) {
      setTokens([]);
      setLoading(false);
      return () => {
        current = false;
      };
    }
    void loadTokens(user.id)
      .then((result) => {
        if (!current) {
          return;
        }
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setTokens(result.data);
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [user]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("トークン名を入力してください。");
      return;
    }

    setCreating(true);
    setError(null);

    const result = await createToken(trimmedName);
    if (!result.ok) {
      setError(
        result.status === 401
          ? "トークンを発行するにはログインが必要です。"
          : result.error,
      );
      setCreating(false);
      return;
    }

    setCreatedToken(result.data);
    setName("");
    setCreating(false);
    if (user) {
      const refreshed = await loadTokens(user.id);
      if (refreshed.ok) {
        setTokens(refreshed.data);
      }
    }
  }

  async function handleRevoke(id: string) {
    setError(null);
    const result = await revokeToken(id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (createdToken?.id === id) {
      setCreatedToken(null);
    }
    if (user) {
      const refreshed = await loadTokens(user.id);
      if (refreshed.ok) {
        setTokens(refreshed.data);
      }
    }
  }

  return (
    <section>
      <h2 className="m-0 text-[1.5em] font-bold">MCP設定</h2>
      <p>
        Cursor / Claude Code / VS Code などの MCP クライアントから{" "}
        <code className="font-mono">/mcp</code>{" "}
        に接続するためのトークンです。同じトークンで記事 API（
        <code className="font-mono">/api/articles</code>、
        <code className="font-mono">/openapi.json</code>
        ）も使えます。発行時に接続先とクライアント別の設定を一度だけ表示します。ノートのブラウザ
        URL は <code className="font-mono">{"/n/{id}"}</code>（UUID）です。
        <code className="font-mono">{"/{shortId}"}</code> では開けません。
      </p>

      {!user && (
        <ErrorText>トークンを管理するにはログインしてください。</ErrorText>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {user && (
        <>
          <form onSubmit={(event) => void handleCreate(event)}>
            <Field htmlFor="token-name" label="トークン名">
              <Row className="mt-[0.35rem] max-[640px]:flex-col">
                <Input
                  className="flex-1"
                  disabled={creating}
                  id="token-name"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例: Cursor on laptop"
                  type="text"
                  value={name}
                />
                <Button disabled={creating} type="submit" variant="outline">
                  {creating ? "発行中…" : "トークンを発行"}
                </Button>
              </Row>
            </Field>
          </form>

          {createdToken ? (
            <McpSetupHelp
              onClose={() => setCreatedToken(null)}
              origin={window.location.origin}
              token={createdToken.token}
              tokenName={createdToken.name}
            />
          ) : (
            <McpClientGuide origin={window.location.origin} />
          )}

          {loading && <p>読み込み中…</p>}
          {!loading && tokens.length === 0 && (
            <p>発行済みトークンはありません。</p>
          )}
          {!loading && tokens.length > 0 && (
            <ul className="list-none p-0">
              {tokens.map((token) => (
                <li
                  className="flex justify-between gap-4 border-b border-border py-3 max-[640px]:flex-col max-[640px]:items-start"
                  key={token.id}
                >
                  <div>
                    <strong>{token.name}</strong>
                    <MutedText className="mt-1">
                      作成: {formatTimestamp(token.createdAt)} / 最終利用:{" "}
                      {formatTimestamp(token.lastUsedAt)}
                    </MutedText>
                  </div>
                  <Button
                    onClick={() => void handleRevoke(token.id)}
                    variant="outline"
                  >
                    失効
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
