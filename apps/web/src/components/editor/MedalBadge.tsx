/**
 * ノート所属フォルダ由来のメダル + パス表示（specs/knowledge-management.html
 * §3.1 条件付き表示 / §4.1 中央スロット）。情報表示のみ・操作なし。
 *
 * メダリオン層のフォルダ割当 API は KM-E2 で実装されるため、現状は常に
 * `medal = null` が渡されて何も描画しない（スロットだけ確保するスタブ）。
 */
export type NoteMedal = {
  /** メダル絵文字（🥉 / 🥈 / 🥇 など、層セット定義の表示用メダル） */
  medal: string;
  /** フォルダパス表示（例: "knowledge/メモ"） */
  path: string;
};

export function MedalBadge({ medal }: { medal: NoteMedal | null }) {
  if (!medal) {
    return null;
  }
  return (
    <span
      className="inline-flex max-w-40 items-center gap-1 truncate rounded-full border border-dashed border-border px-2 py-[0.15rem] text-[0.75rem] text-muted"
      title={medal.path}
    >
      <span aria-hidden={true}>{medal.medal}</span>
      <span className="truncate max-[640px]:hidden">{medal.path}</span>
    </span>
  );
}
