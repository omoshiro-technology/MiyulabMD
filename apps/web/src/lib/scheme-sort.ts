import {
  isZettelId,
  parseJdArea,
  parseJdCategory,
  parseJdId,
} from "@miyulabmd/shared";

function schemeIdValue(id: string): number | null {
  const jdId = parseJdId(id);
  if (jdId) {
    return jdId.category * 100 + jdId.id;
  }
  const area = parseJdArea(id);
  if (area) {
    return area.start;
  }
  const category = parseJdCategory(id);
  if (category !== null) {
    return category;
  }
  if (isZettelId(id)) {
    return Number(id);
  }
  return null;
}

/**
 * 命名規則 ID 持ちフォルダを数値順に並べる比較関数。
 * 両方 schemeId 持ち → 数値比較、片方のみ → ID 持ちを先、両方なし → 名前順。
 */
export function compareSchemeFolders<
  T extends { name: string; schemeId?: string | null },
>(a: T, b: T): number {
  const av = a.schemeId ? schemeIdValue(a.schemeId) : null;
  const bv = b.schemeId ? schemeIdValue(b.schemeId) : null;
  if (av !== null && bv !== null) {
    return av - bv;
  }
  if (av !== null) {
    return -1;
  }
  if (bv !== null) {
    return 1;
  }
  return a.name.localeCompare(b.name, "ja");
}
