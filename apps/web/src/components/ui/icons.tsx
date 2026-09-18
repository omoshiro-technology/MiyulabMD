import {
  ChevronDown,
  Circle,
  EllipsisVertical,
  Eye,
  FileText,
  Folder,
  GlobeOff,
  History,
  Link2,
  Lock,
  LockOpen,
  Medal,
  Monitor,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sun,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn.ts";

type IconProps = {
  className?: string;
};

export function EyeIcon({ className }: IconProps) {
  return <Eye aria-hidden={true} className={cn("size-4", className)} />;
}

export function SunIcon({ className }: IconProps) {
  return <Sun aria-hidden={true} className={cn("size-4", className)} />;
}

export function MoonIcon({ className }: IconProps) {
  return <Moon aria-hidden={true} className={cn("size-4", className)} />;
}

export function BlackIcon({ className }: IconProps) {
  return (
    <Circle
      aria-hidden={true}
      className={cn("size-4 fill-current", className)}
    />
  );
}

export function MonitorIcon({ className }: IconProps) {
  return <Monitor aria-hidden={true} className={cn("size-4", className)} />;
}

export function PencilIcon({ className }: IconProps) {
  return <Pencil aria-hidden={true} className={cn("size-4", className)} />;
}

export function ChevronDownIcon({ className }: IconProps) {
  return <ChevronDown aria-hidden={true} className={cn("size-3", className)} />;
}

export function CloseIcon({ className }: IconProps) {
  return <X aria-hidden={true} className={cn("size-4", className)} />;
}

export function MoreIcon({ className }: IconProps) {
  return (
    <EllipsisVertical aria-hidden={true} className={cn("size-5", className)} />
  );
}

export function FolderOutlineIcon({ className }: IconProps) {
  return <Folder aria-hidden={true} className={cn("size-4", className)} />;
}

export function PlusIcon({ className }: IconProps) {
  return <Plus aria-hidden={true} className={cn("size-4", className)} />;
}

export function ShareIcon({ className }: IconProps) {
  return <Share2 aria-hidden={true} className={cn("size-4", className)} />;
}

export function HistoryIcon({ className }: IconProps) {
  return <History aria-hidden={true} className={cn("size-4", className)} />;
}

export function RefreshIcon({ className }: IconProps) {
  return <RefreshCw aria-hidden={true} className={cn("size-4", className)} />;
}

export function LinkIcon({ className }: IconProps) {
  return <Link2 aria-hidden={true} className={cn("size-4", className)} />;
}

export function MedalIcon({ className }: IconProps) {
  return <Medal aria-hidden={true} className={cn("size-4", className)} />;
}

export function LockIcon({ className }: IconProps) {
  return <Lock aria-hidden={true} className={cn("size-4", className)} />;
}

export function LockOpenIcon({ className }: IconProps) {
  return <LockOpen aria-hidden={true} className={cn("size-4", className)} />;
}

export function SearchIcon({ className }: IconProps) {
  return <Search aria-hidden={true} className={cn("size-4", className)} />;
}

export function GlobeOffIcon({ className }: IconProps) {
  return <GlobeOff aria-hidden={true} className={cn("size-4", className)} />;
}

export function ArticleIcon({ className }: IconProps) {
  return <FileText aria-hidden={true} className={cn("size-4", className)} />;
}

export function FolderIcon({ className }: IconProps) {
  return (
    <Folder
      aria-hidden={true}
      className={cn("size-[22px] shrink-0 text-folder", className)}
    />
  );
}

export function MarkdownIcon({ className }: IconProps) {
  return (
    <FileText
      aria-hidden={true}
      className={cn("size-[22px] shrink-0 text-note", className)}
    />
  );
}
