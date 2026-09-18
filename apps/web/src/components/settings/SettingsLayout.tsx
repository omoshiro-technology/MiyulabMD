import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";
import { cn } from "../../lib/cn.ts";
import type { AppShellContext } from "../layout/AppShellContext.ts";
import { Select } from "../ui/Select.tsx";

type SettingsItem = { to: string; label: string };
type SettingsGroup = { label: string; items: SettingsItem[] };

const GROUPS: SettingsGroup[] = [
  {
    items: [{ label: "ユーザー設定", to: "/settings/profile" }],
    label: "アカウント",
  },
  {
    items: [{ label: "エディタ設定", to: "/settings/editor" }],
    label: "エディタ",
  },
  {
    items: [
      { label: "PARA メソッド", to: "/settings/knowledge/para" },
      { label: "命名規則", to: "/settings/knowledge/schemes" },
      { label: "メダリオン層", to: "/settings/knowledge/layers" },
    ],
    label: "ナレッジ管理",
  },
  {
    items: [{ label: "MCP設定", to: "/settings/mcp" }],
    label: "開発者",
  },
  {
    items: [{ label: "サイト設定", to: "/settings/site" }],
    label: "サイト",
  },
];

const ALL_ITEMS = GROUPS.flatMap((group) => group.items);

export function SettingsLayout() {
  const context = useOutletContext<AppShellContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const current =
    ALL_ITEMS.find((item) => location.pathname === item.to)?.to ??
    "/settings/profile";

  return (
    <div className="flex gap-8 max-[900px]:flex-col max-[900px]:gap-4">
      <aside className="w-[240px] shrink-0 max-[900px]:hidden">
        <h1 className="m-0 mb-4 text-xl font-bold">設定</h1>
        <nav aria-label="設定">
          {GROUPS.map((group) => (
            <div className="mb-4" key={group.label}>
              <p className="m-0 mb-1 px-2 text-[0.72rem] font-semibold tracking-wide text-muted uppercase">
                {group.label}
              </p>
              <ul className="m-0 list-none p-0">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      className={({ isActive }) =>
                        cn(
                          "block rounded-md border-l-2 px-2 py-1.5 text-[0.95rem] no-underline",
                          isActive
                            ? "border-accent bg-fill font-medium text-ink"
                            : "border-transparent text-ink hover:bg-fill",
                        )
                      }
                      to={item.to}
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="hidden max-[900px]:block">
        <h1 className="m-0 mb-3 text-xl font-bold">設定</h1>
        <Select
          aria-label="設定セクション"
          className="w-full rounded-lg px-3 py-2.5"
          onChange={(event) => navigate(event.target.value)}
          value={current}
        >
          {ALL_ITEMS.map((item) => (
            <option key={item.to} value={item.to}>
              {item.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="min-w-0 max-w-2xl flex-1">
        <Outlet context={context} />
      </div>
    </div>
  );
}
