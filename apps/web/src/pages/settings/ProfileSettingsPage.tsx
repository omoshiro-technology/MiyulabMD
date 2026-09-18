import { type FormEvent, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { AppShellContext } from "../../components/layout/AppShellContext.ts";
import { ConfirmDialog } from "../../components/notes/ConfirmDialog.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Field, Row } from "../../components/ui/Field.tsx";
import { Input } from "../../components/ui/Input.tsx";
import { ErrorText, MutedText } from "../../components/ui/Text.tsx";
import { updateProfile } from "../../lib/api.ts";
import { clearOfflineCacheDevice } from "../../lib/offline-cache.ts";

export function ProfileSettingsPage() {
  const { user, setUser } = useOutletContext<AppShellContext>();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
  }, [user?.displayName]);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const result = await updateProfile(displayName.trim() || null);
    if (!result.ok) {
      setError(
        result.status === 401
          ? "表示名を保存するにはログインが必要です。"
          : result.error,
      );
      setSaving(false);
      return;
    }

    setUser(result.data);
    setSaving(false);
    setSaved(true);
  }

  return (
    <section>
      <h2 className="m-0 text-[1.5em] font-bold">ユーザー設定</h2>
      <p>
        共同編集中のカーソル名に使います。空欄ならメールアドレスを表示します。必須ではありません。
      </p>
      {user ? (
        <form onSubmit={(event) => void handleSave(event)}>
          <Field htmlFor="display-name" label="表示名">
            <Row className="mt-[0.35rem] max-[640px]:flex-col">
              <Input
                className="flex-1"
                disabled={saving}
                id="display-name"
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={user.email}
                type="text"
                value={displayName}
              />
              <Button disabled={saving} type="submit" variant="outline">
                {saving ? "保存中…" : "保存"}
              </Button>
            </Row>
          </Field>
          {saved && <MutedText className="mt-1">保存しました。</MutedText>}
          {error && <ErrorText>{error}</ErrorText>}
        </form>
      ) : (
        <ErrorText>表示名を設定するにはログインしてください。</ErrorText>
      )}

      <h3 className="text-[1.1em] font-bold">オフラインキャッシュ</h3>
      <p>
        オフライン閲覧用にこの端末へ保存されたノート・フォルダ・一覧・画像を、すべてのアカウント分まとめて削除します。サーバー上のデータとアプリの起動資産は残ります。ほかのタブで進行中のキャッシュ処理も無効になります。
      </p>
      <Button
        onClick={() => {
          setClearError(null);
          setConfirmOpen(true);
        }}
        variant="danger"
      >
        この端末のキャッシュを削除
      </Button>
      {cleared && <MutedText className="mt-1">削除しました。</MutedText>}
      {confirmOpen && (
        <ConfirmDialog
          busy={clearing}
          confirmLabel="削除"
          error={clearError}
          message="この端末に保存されたオフラインキャッシュをすべて削除します。元に戻せません。"
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            setClearing(true);
            setClearError(null);
            void clearOfflineCacheDevice()
              .then(() => {
                setConfirmOpen(false);
                setCleared(true);
              })
              .catch(() => {
                setClearError(
                  "削除を完了できませんでした。もう一度実行してください。",
                );
              })
              .finally(() => setClearing(false));
          }}
          title="端末のキャッシュを削除"
        />
      )}
    </section>
  );
}
