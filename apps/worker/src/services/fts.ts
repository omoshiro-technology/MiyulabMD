import { db } from "../db/client.ts";

/**
 * FTS5 mirror of note title + snapshot (`notes_fts`, trigram tokenizer).
 * App-side sync: called from the same sites that reindex note_links.
 * The index is a rebuildable projection — failures must not break writes.
 */

export async function syncNoteFts(
  env: Env,
  note: { id: string; title: string; markdown_snapshot: string | null },
): Promise<void> {
  // FTS5 has no unique constraint — delete then insert.
  const database = db(env);
  await database
    .prepare("DELETE FROM notes_fts WHERE note_id = ?")
    .bind(note.id)
    .run()
    .then(() =>
      database
        .prepare(
          "INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)",
        )
        .bind(note.id, note.title, note.markdown_snapshot ?? "")
        .run(),
    )
    .catch(() => undefined);
}

export async function deleteNoteFts(env: Env, noteId: string): Promise<void> {
  await db(env)
    .prepare("DELETE FROM notes_fts WHERE note_id = ?")
    .bind(noteId)
    .run()
    .catch(() => undefined);
}

/** Escape a user term into an FTS5 phrase token for the trigram index. */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** trigram indexes need at least 3 characters to match. */
export const FTS_MIN_TERM_LENGTH = 3;

/**
 * Build an FTS5 MATCH query from parsed DSL terms.
 * Only positive terms go to the index: negated terms must respect the search
 * scope (title/body), which FTS column-agnostic NOT cannot express. Terms
 * shorter than 3 chars also stay app-side (trigram cannot index them).
 * Returns null when nothing can be answered by the index (caller falls back
 * to a full scan).
 */
export function ftsMatchQuery(
  terms: readonly { value: string; negated: boolean }[],
  scope: "all" | "body" | "title" = "all",
): string | null {
  const column = scope === "all" ? "" : `${scope}:`;
  const positives = terms
    .filter((term) => !term.negated && term.value.length >= FTS_MIN_TERM_LENGTH)
    .map((term) => `${column}${ftsPhrase(term.value)}`);
  return positives.length === 0 ? null : positives.join(" ");
}

/**
 * Candidate note IDs matching the FTS query. Returns null when the query is
 * empty or the index is unavailable — callers then scan without narrowing.
 * The FTS set is global (not permission-aware); callers MUST intersect it with
 * permission-filtered rows.
 */
export async function ftsCandidateIds(
  env: Env,
  match: string | null,
): Promise<Set<string> | null> {
  if (!match) {
    return null;
  }
  try {
    const rows = await db(env)
      .prepare("SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?")
      .bind(match)
      .all<{ note_id: string }>();
    return new Set((rows.results ?? []).map((row) => row.note_id));
  } catch {
    return null;
  }
}
