import type { SessionUser } from "@miyulabmd/shared";
import { type FormEvent, useRef, useState } from "react";
import { useDismiss } from "../../hooks/use-dismiss.ts";
import type { AuthConfig } from "../../lib/api.ts";
import { logoutAndClearIdentity } from "../../lib/identity-lifecycle.ts";
import { colorForEmail } from "../../lib/user-style.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Button } from "../ui/Button.tsx";
import { Input } from "../ui/Input.tsx";
import {
  MenuHeader,
  MenuItem,
  MenuPanel,
  MenuRow,
  MenuSeparator,
} from "../ui/Menu.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";

const GUEST_LABEL = "ゲスト";

type Props = {
  user: SessionUser | null;
  authConfig: AuthConfig;
};

export function AccountMenu({ user, authConfig }: Props) {
  const [open, setOpen] = useState(false);
  const [loginEmail, setLoginEmail] = useState("dev@example.com");
  const rootRef = useRef<HTMLDivElement>(null);
  const label = user?.displayName?.trim() || user?.email || GUEST_LABEL;
  const mockLogin = !(user || authConfig.access) && authConfig.mock;
  useDismiss(open, () => setOpen(false), rootRef);

  function handleLoginSubmit(event: FormEvent) {
    event.preventDefault();
    const email = loginEmail.trim();
    if (!email) {
      return;
    }
    window.location.href = `/auth/login?email=${encodeURIComponent(email)}`;
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="grid cursor-pointer place-items-center rounded-full border-2 border-transparent bg-transparent p-0 hover:border-soft aria-expanded:border-soft"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Avatar
          color={colorForEmail(user?.email, user?.id)}
          name={label}
          size="md"
        />
      </button>
      {open && (
        <MenuPanel width="20rem">
          <MenuHeader email={user?.email} name={label}>
            <Avatar
              color={colorForEmail(user?.email, user?.id)}
              name={label}
              size="lg"
            />
          </MenuHeader>
          <MenuSeparator />
          <MenuRow>
            <span className="text-[0.85rem] text-muted">テーマ</span>
            <ThemeSwitch />
          </MenuRow>
          <MenuSeparator />
          {user && (
            <>
              <MenuItem onClick={() => setOpen(false)} to="/settings">
                設定
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  void logoutAndClearIdentity(user.id).catch(
                    (error: unknown) => {
                      // AppShell owns the warning after this menu's user disappears.
                      console.error("Logout did not complete", error);
                    },
                  );
                }}
              >
                ログアウト
              </MenuItem>
            </>
          )}
          {!user && mockLogin && (
            <form className="grid gap-2 px-4 py-2" onSubmit={handleLoginSubmit}>
              <Input
                aria-label="ログイン用メールアドレス"
                className="w-full"
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder="email"
                type="email"
                value={loginEmail}
                variant="pill"
              />
              <Button type="submit" variant="outline">
                ログイン
              </Button>
            </form>
          )}
          {!(user || mockLogin) && (
            <MenuItem href="/auth/login">ログイン</MenuItem>
          )}
        </MenuPanel>
      )}
    </div>
  );
}
