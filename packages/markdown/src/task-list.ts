import { markdownBody } from "@miyulabmd/shared";
import { remark } from "remark";
import remarkGfm from "remark-gfm";

export type TaskCheckbox = {
  line: number;
  offset: number;
  checked: boolean;
  source: string;
};

export type TaskCheckboxUpdate = {
  line: number;
  contextHash: string;
  checked: boolean;
};

type TaskNode = {
  type: string;
  checked?: boolean | null;
  position?: { start: { line: number; column: number; offset?: number } };
  children?: TaskNode[];
};

const parser = remark().use(remarkGfm);

export function taskNodes(tree: TaskNode): TaskNode[] {
  const result: TaskNode[] = [];
  function visit(node: TaskNode) {
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      result.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }
  visit(tree);
  return result;
}

/** Parse actual GFM tasks; code, HTML and frontmatter are never editable. */
export function collectTaskCheckboxes(
  markdown: string,
  tree?: TaskNode,
): TaskCheckbox[] {
  const body = markdownBody(markdown);
  const lines = markdown.split("\n");
  const lineShift = lines.length - body.split("\n").length;
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const tasks: TaskCheckbox[] = [];
  for (const node of taskNodes(tree ?? parser.parse(body))) {
    if (!node.position) {
      continue;
    }
    const line = node.position.start.line + lineShift;
    const column = node.position.start.column - 1;
    const source = lines[line - 1] ?? "";
    const match = /^(?:[-+*]|\d+[.)])[\t ]+\[([ xX])\]/.exec(
      source.slice(column),
    );
    if (!match) {
      continue;
    }
    tasks.push({
      checked: Boolean(node.checked),
      line,
      offset: (starts[line - 1] ?? 0) + column + match[0].length - 2,
      source: source.slice(column).replace(/\r$/, ""),
    });
  }
  return tasks;
}

/** Ignore only real task states. Any text/line changes require a fresh View. */
export async function taskContextHash(markdown: string): Promise<string> {
  const characters = markdown.split("");
  for (const task of collectTaskCheckboxes(markdown)) {
    characters[task.offset] = " ";
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(characters.join("")),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function isTaskCheckboxUpdate(
  value: unknown,
): value is TaskCheckboxUpdate {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as Partial<TaskCheckboxUpdate>;
  return (
    Number.isSafeInteger(input.line) &&
    Number(input.line) > 0 &&
    typeof input.checked === "boolean" &&
    typeof input.contextHash === "string" &&
    /^[a-f0-9]{64}$/.test(input.contextHash)
  );
}
