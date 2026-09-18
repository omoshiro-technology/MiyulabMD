import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { NoteSummary } from "@miyulabmd/shared";
import { fetchNotes } from "./api.ts";

const MAX_OPTIONS = 20;
const QUERY_RE = /\[\[([^\][\n]*)$/;

function linkTargetFor(note: NoteSummary, titleCounts: Map<string, number>) {
  const duplicates = (titleCounts.get(note.title) ?? 0) > 1;
  if (duplicates && note.folder) {
    return `${note.folder}/${note.title}`;
  }
  return note.title;
}

function optionsFor(notes: NoteSummary[], query: string): Completion[] {
  const titleCounts = new Map<string, number>();
  for (const note of notes) {
    titleCounts.set(note.title, (titleCounts.get(note.title) ?? 0) + 1);
  }
  const options: Completion[] = [];
  for (const note of notes) {
    const target = linkTargetFor(note, titleCounts);
    const haystack = `${note.folder}/${note.title}`.toLowerCase();
    if (query && !haystack.includes(query)) {
      continue;
    }
    options.push({
      apply: `${target}]]`,
      detail: note.folder || undefined,
      label: note.title,
      type: "text",
    });
    if (options.length >= MAX_OPTIONS) {
      break;
    }
  }
  return options;
}

/**
 * `[[` triggers note-title completion. Candidates come from the same
 * visibility-filtered note list as the drive, so hidden notes never appear.
 */
export function wikilinkCompletion(): Extension {
  let cache: NoteSummary[] | null = null;

  async function source(
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const match = QUERY_RE.exec(before);
    if (!match) {
      return null;
    }
    const raw = match[1] ?? "";
    const from = ctx.pos - raw.length;

    if (!cache) {
      cache = await fetchNotes().catch(() => [] as NoteSummary[]);
    }
    const options = optionsFor(cache, raw.toLowerCase());
    if (options.length === 0) {
      return null;
    }
    return { from, options, validFor: /^[^\][\n]*$/ };
  }

  return autocompletion({ icons: false, override: [source] });
}
