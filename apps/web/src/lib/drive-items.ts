import type { NoteSummary } from "@miyulabmd/shared";

/** マイドライブに混ぜない共有ノート。 */
export function sharedNotesForUser(
  notes: NoteSummary[],
  userId: string,
): NoteSummary[] {
  return notes
    .filter((note) => note.ownerId !== userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
