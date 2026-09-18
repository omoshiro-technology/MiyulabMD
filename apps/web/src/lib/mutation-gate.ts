import type { ViewerContext } from "./viewer-context.ts";

export type MutationAccess = {
  viewer: ViewerContext;
  source: "network" | "cache" | "pending";
};

export class ReadOnlyViewingError extends Error {
  constructor() {
    super("Mutations are unavailable while viewing read-only data");
    this.name = "ReadOnlyViewingError";
  }
}

function allowsMutation(access: MutationAccess): boolean {
  return (
    access.source === "network" &&
    (access.viewer.mode === "authenticated" || access.viewer.mode === "guest")
  );
}

export function createMutationGate(readAccess: () => MutationAccess) {
  return {
    canMutate(): boolean {
      return allowsMutation(readAccess());
    },
    run<T>(operation: () => T): T {
      if (!allowsMutation(readAccess())) {
        throw new ReadOnlyViewingError();
      }
      return operation();
    },
  };
}
