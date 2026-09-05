import { SHARED_PATH } from "@miyulabmd/shared";
import {
  type LucideIcon,
  Settings2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useNavigate } from "react-router";
import { Switch } from "../ui/Switch.tsx";

type Place = "drive" | "shared" | "shared-by-me";

const places: {
  value: Place;
  label: string;
  ariaLabel: string;
  path: string;
  icon: LucideIcon;
}[] = [
  {
    value: "drive",
    label: "個人",
    ariaLabel: "個人（マイドライブ）",
    path: "/",
    icon: UserRound,
  },
  {
    value: "shared",
    label: "共有",
    ariaLabel: "共有（共有されているアイテム）",
    path: SHARED_PATH,
    icon: UsersRound,
  },
  {
    value: "shared-by-me",
    label: "管理",
    ariaLabel: "管理（自分が共有済みのアイテム）",
    path: "/shared-by-me",
    icon: Settings2,
  },
];

export function DrivePlaceNav({ current }: { current: Place }) {
  const navigate = useNavigate();
  return (
    <Switch
      label="場所"
      size="md"
      items={places.map(({ icon: Icon, ...place }) => ({
        value: place.value,
        ariaLabel: place.ariaLabel,
        label: (
          <>
            <Icon aria-hidden className="size-4" />
            <span className="whitespace-nowrap max-[900px]:hidden">
              {place.label}
            </span>
          </>
        ),
        pressed: current === place.value,
        onClick: () => navigate(place.path),
      }))}
    />
  );
}
