import {
  collectTaskCheckboxes,
  type TaskCheckbox,
  taskNodes,
} from "./task-list.ts";

type Node = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number; line: number; column: number } };
  children?: Node[];
};
type File = {
  value: unknown;
  data: Record<string, unknown>;
};

/** Remember parser positions, so raw HTML cannot forge interactive controls. */
export function remarkTaskCheckboxes() {
  return (tree: Node, file: File) => {
    const originals = collectTaskCheckboxes(String(file.data.taskSource ?? ""));
    const expanded = collectTaskCheckboxes(String(file.value), tree);
    const nodes = taskNodes(tree);
    const positions = new Map<number, TaskCheckbox>();
    if (
      originals.length === expanded.length &&
      nodes.length === originals.length
    ) {
      for (let index = 0; index < originals.length; index += 1) {
        const original = originals[index];
        const rendered = expanded[index];
        const offset = nodes[index]?.position?.start.offset;
        if (
          original &&
          rendered?.source === original.source &&
          offset !== undefined
        ) {
          positions.set(offset, original);
        }
      }
    }
    file.data.taskPositions = positions;
  };
}

/** Run after sanitization; only inputs belonging to parsed tasks gain metadata. */
export function rehypeTaskCheckboxes() {
  return (tree: Node, file: File) => {
    const positions = file.data.taskPositions as
      | Map<number, TaskCheckbox>
      | undefined;
    function visit(node: Node) {
      const offset = node.position?.start.offset;
      const task = offset === undefined ? undefined : positions?.get(offset);
      if (node.tagName === "li" && task) {
        const input = taskInput(node);
        if (input) {
          input.properties = {
            ...input.properties,
            ariaLabel: task.source.replace(
              /^(?:[-+*]|\d+[.)])[\t ]+\[[ xX]\][\t ]*/,
              "",
            ),
            dataTaskLine: task.line,
          };
        }
      }
      for (const child of node.children ?? []) {
        visit(child);
      }
    }
    visit(tree);
  };
}

function taskInput(node: Node): Node | undefined {
  const children = node.children ?? [];
  return (
    children.find((child) => child.tagName === "input") ??
    children
      .find((child) => child.tagName === "p")
      ?.children?.find((child) => child.tagName === "input")
  );
}
