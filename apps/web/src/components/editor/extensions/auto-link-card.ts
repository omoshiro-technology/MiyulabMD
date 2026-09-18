import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { youtubeId, youtubeStartSeconds } from "../../../lib/embeds.ts";
import { standaloneLinkUrl } from "../../../lib/standalone-link.ts";

const INVISIBLE = /\u200B|\u200C|\uFEFF/g;

export function paragraphStandaloneHref(node: PMNode): string | null {
  if (node.type.name !== "paragraph") {
    return null;
  }

  const texts: PMNode[] = [];
  let blocked = false;
  node.forEach((child) => {
    if (child.type.name === "hardBreak") {
      return;
    }
    if (!child.isText) {
      blocked = true;
      return;
    }
    texts.push(child);
  });
  if (blocked || texts.length === 0) {
    return null;
  }

  const trimmed = texts
    .map((child) => child.text ?? "")
    .join("")
    .replace(INVISIBLE, "")
    .trim();
  if (!trimmed) {
    return null;
  }

  const bare = standaloneLinkUrl(trimmed);
  if (bare) {
    return bare;
  }

  let href: string | null = null;
  for (const child of texts) {
    const link = child.marks.find((mark) => mark.type.name === "link");
    const next = typeof link?.attrs.href === "string" ? link.attrs.href : "";
    if (!(next && /^https?:\/\//.test(next))) {
      return null;
    }
    if (href && href !== next) {
      return null;
    }
    href = next;
  }
  return href;
}

export function linkParagraphFromHref(
  schema: EditorState["schema"],
  href: string,
): PMNode | null {
  const paragraph = schema.nodes.paragraph;
  const link = schema.marks.link;
  if (!(paragraph && link && href)) {
    return null;
  }
  return paragraph.create(null, schema.text(href, [link.create({ href })]));
}

export function expandOgCard(
  state: EditorState,
  pos: number,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "ogCard") {
    return null;
  }
  const href = typeof node.attrs.href === "string" ? node.attrs.href : "";
  const paragraph = linkParagraphFromHref(state.schema, href);
  if (!paragraph) {
    return null;
  }
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, paragraph);
  const from = pos + 1;
  const to = from + href.length;
  return tr.setSelection(TextSelection.create(tr.doc, from, to));
}

function embedNodeForHref(state: EditorState, href: string): PMNode | null {
  if (youtubeId(href)) {
    const youtube = state.schema.nodes.youtube;
    if (youtube) {
      return youtube.create({
        src: href,
        start: youtubeStartSeconds(href),
      });
    }
  }
  const ogType = state.schema.nodes.ogCard;
  return ogType ? ogType.create({ href }) : null;
}

export function autoLinkCardTransaction(
  state: EditorState,
  includeSelection = false,
): Transaction | null {
  if (!(state.schema.nodes.ogCard || state.schema.nodes.youtube)) {
    return null;
  }

  const replacements: Array<{ from: number; to: number; href: string }> = [];
  const { selection, doc } = state;
  doc.forEach((node, pos) => {
    const href = paragraphStandaloneHref(node);
    if (!href) {
      return;
    }
    const from = pos;
    const to = pos + node.nodeSize;
    if (!includeSelection && selection.from < to && selection.to > from) {
      return;
    }
    replacements.push({ from, href, to });
  });
  if (replacements.length === 0) {
    return null;
  }

  let tr = state.tr;
  for (const { from, to, href } of replacements.reverse()) {
    const embed = embedNodeForHref(state, href);
    if (!embed) {
      continue;
    }
    tr = tr.replaceWith(from, to, embed);
  }
  return tr.docChanged ? tr : null;
}

export const AutoLinkCard = Extension.create({
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (
            !transactions.some(
              (transaction) =>
                transaction.docChanged || transaction.selectionSet,
            )
          ) {
            return null;
          }
          const pasted = transactions.some((transaction) =>
            transaction.getMeta("paste"),
          );
          return autoLinkCardTransaction(newState, pasted);
        },
        key: new PluginKey("autoLinkCard"),
        props: {
          handleClickOn(view, _pos, node, nodePos, event) {
            if (node.type.name !== "ogCard" || !view.editable) {
              return false;
            }
            event.preventDefault();
            const tr = expandOgCard(view.state, nodePos);
            if (!tr) {
              return false;
            }
            view.dispatch(tr);
            return true;
          },
          handlePaste(view, event) {
            if (!view.editable) {
              return false;
            }
            const href = standaloneLinkUrl(
              event.clipboardData?.getData("text/plain") ?? "",
            );
            if (!href) {
              return false;
            }

            const { $from, from, to } = view.state.selection;
            if ($from.parent.type.name !== "paragraph") {
              return false;
            }
            const empty = $from.parent.content.size === 0;
            const whole = from <= $from.start() && to >= $from.end();
            if (!(empty || whole)) {
              return false;
            }

            const embed = embedNodeForHref(view.state, href);
            if (!embed) {
              return false;
            }
            view.dispatch(
              view.state.tr
                .replaceWith($from.before(), $from.after(), embed)
                .setMeta("paste", true),
            );
            return true;
          },
        },
      }),
    ];
  },
  name: "autoLinkCard",
});
