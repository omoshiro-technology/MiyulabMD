/**
 * Naming schemes: a folder may declare a rule (`scheme`) that names its direct
 * children, and a folder minted by a parent's scheme carries `scheme_id` +
 * `scheme_title`. Numbering and `scheme_id` uniqueness are scoped to the
 * declaring directory (`scheme_root`), so each configured folder is an
 * independent scheme tree.
 */

export const NAMING_SCHEMES = ["jd", "zettel"] as const;
export type NamingScheme = (typeof NAMING_SCHEMES)[number];

export function isNamingScheme(value: string): value is NamingScheme {
  return (NAMING_SCHEMES as readonly string[]).includes(value);
}

/** Human-facing label for the scheme picker / menus. */
export const NAMING_SCHEME_LABELS: Record<NamingScheme, string> = {
  jd: "Johnny.Decimal",
  zettel: "Zettelkasten（日時）",
};

// --- Johnny.Decimal ---------------------------------------------------------

/** `.00`–`.10` stay reserved for meta use; auto-allocation starts at .11. */
export const JD_RESERVED_MAX = 10;
export const JD_ID_MAX = 99;
/** Areas per JD root and categories per area. */
export const JD_GROUP_MAX = 10;

const JD_AREA_RE = /^(\d{2})-(\d{2})$/;
const JD_CATEGORY_RE = /^\d{2}$/;
const JD_ID_RE = /^(\d{2})\.(\d{2})$/;
const ZETTEL_RE = /^\d{12}$/;

export type JdLevel = "root" | "area" | "category" | "id";

/** Level of a JD node from its scheme_id (null = the JD tree root itself). */
export function jdLevelOf(schemeId: string | null): JdLevel | null {
  if (schemeId === null) {
    return "root";
  }
  if (JD_AREA_RE.test(schemeId)) {
    return "area";
  }
  if (JD_CATEGORY_RE.test(schemeId)) {
    return "category";
  }
  if (JD_ID_RE.test(schemeId)) {
    return "id";
  }
  return null;
}

/** Child level a JD container allocates for, or null if it takes no children. */
export function jdChildLevel(schemeId: string | null): JdLevel | null {
  const level = jdLevelOf(schemeId);
  if (level === "root") {
    return "area";
  }
  if (level === "area") {
    return "category";
  }
  if (level === "category") {
    return "id";
  }
  return null;
}

export function parseJdArea(
  value: string,
): { end: number; start: number } | null {
  const match = JD_AREA_RE.exec(value);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 10 || start > 90 || start % 10 !== 0 || end !== start + 9) {
    return null;
  }
  return { end, start };
}

export function parseJdCategory(value: string): number | null {
  if (!JD_CATEGORY_RE.test(value)) {
    return null;
  }
  const num = Number(value);
  return num >= 10 && num <= 99 ? num : null;
}

export function parseJdId(
  value: string,
): { category: number; id: number } | null {
  const match = JD_ID_RE.exec(value);
  if (!match) {
    return null;
  }
  const category = Number(match[1]);
  const id = Number(match[2]);
  if (category < 10 || category > 99 || id < 0 || id > JD_ID_MAX) {
    return null;
  }
  return { category, id };
}

export function formatJdId(category: number, id: number): string {
  return `${category}.${String(id).padStart(2, "0")}`;
}

export function formatJdArea(start: number): string {
  return `${start}-${start + 9}`;
}

export function formatSchemeFolderName(
  schemeId: string,
  title: string,
): string {
  return `${schemeId} ${title}`;
}

// --- Zettelkasten -----------------------------------------------------------

/** UTC `YYYYMMDDHHmm` stamp used for Zettelkasten-style IDs. */
export function zettelStamp(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  );
}

export function isZettelId(value: string): boolean {
  return ZETTEL_RE.test(value);
}

// --- shared helpers ---------------------------------------------------------

/** Whether a query looks like a scheme ID worth quick-resolving. */
export function looksLikeSchemeId(query: string): boolean {
  const trimmed = query.trim();
  return (
    JD_AREA_RE.test(trimmed) ||
    JD_CATEGORY_RE.test(trimmed) ||
    JD_ID_RE.test(trimmed) ||
    ZETTEL_RE.test(trimmed)
  );
}

export type SchemeSuggestion = {
  level: JdLevel | "zettel";
  name: string;
  path: string;
  scheme: NamingScheme;
  schemeId: string;
  title: string;
};

/** 規則を宣言したフォルダ（採番スコープのルート）の一覧エントリ。 */
export type SchemeRootEntry = {
  /** フォルダパス（'' = マイドライブ直下） */
  folder: string;
  id: string;
  /** 採番スコープ内のフォルダ数 */
  mintedCount: number;
  name: string;
  /** 次に採番される ID（採番できない場合 null） */
  next: { level: JdLevel | "zettel"; schemeId: string } | null;
  scheme: string;
};

export type SchemeValidationIssue = {
  code:
    | "area_count"
    | "category_count"
    | "depth"
    | "duplicate_id"
    | "id_range"
    | "invalid_scheme"
    | "name_mismatch"
    | "wrong_parent"
    | "reserved";
  folderId: string;
  message: string;
  path: string;
};

export type SchemeValidateResult = {
  folders: number;
  issues: SchemeValidationIssue[];
};
