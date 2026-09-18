import {
  createMutationGate,
  type MutationAccess,
  ReadOnlyViewingError,
} from "./mutation-gate.ts";
import type { ViewerContext } from "./viewer-context.ts";

type ViewerAssociation = {
  mode: ViewerContext["mode"];
  cacheViewerId: string | null;
  userId: string | null;
};

type Scope = {
  owner: ViewerContext;
  ownerAssociation: ViewerAssociation;
  token: object;
  access: MutationAccess;
};

function association(viewer: ViewerContext): ViewerAssociation {
  return {
    cacheViewerId: viewer.cacheViewerId,
    mode: viewer.mode,
    userId: viewer.user?.id ?? null,
  };
}

function sameAssociation(
  left: ViewerAssociation,
  right: ViewerAssociation,
): boolean {
  return (
    left.mode === right.mode &&
    left.cacheViewerId === right.cacheViewerId &&
    left.userId === right.userId
  );
}

function snapshotViewer(viewer: ViewerContext): ViewerContext {
  return {
    cachedUser: viewer.cachedUser
      ? {
          displayName: viewer.cachedUser.displayName,
          email: viewer.cachedUser.email,
          id: viewer.cachedUser.id,
        }
      : null,
    cacheViewerId: viewer.cacheViewerId,
    mode: viewer.mode,
    user: viewer.user
      ? {
          displayName: viewer.user.displayName,
          email: viewer.user.email,
          id: viewer.user.id,
        }
      : null,
  };
}

function snapshotAccess(access: MutationAccess): MutationAccess {
  return { source: access.source, viewer: snapshotViewer(access.viewer) };
}

export function createViewingAccess(readViewer: () => ViewerContext): {
  getAccess: () => MutationAccess;
  beginView: (ownerViewer: ViewerContext) => {
    isCurrent: () => boolean;
    publish: (access: MutationAccess) => boolean;
    dispose: () => void;
  };
} {
  let scope: Scope | undefined;

  const getAccess = (): MutationAccess => {
    const currentViewer = readViewer();
    if (!scope) {
      return snapshotAccess({ source: "network", viewer: currentViewer });
    }

    if (scope.owner !== currentViewer) {
      return snapshotAccess({ source: "pending", viewer: currentViewer });
    }
    return snapshotAccess(scope.access);
  };

  const beginView = (ownerViewer: ViewerContext) => {
    if (readViewer() !== ownerViewer) {
      return {
        dispose: () => {
          // This handle never owned a scope.
        },
        isCurrent: () => false,
        publish: () => false,
      };
    }

    const token = {};
    scope = {
      access: { source: "pending", viewer: snapshotViewer(ownerViewer) },
      owner: ownerViewer,
      ownerAssociation: association(ownerViewer),
      token,
    };

    return {
      dispose(): void {
        if (scope?.token === token) {
          scope = undefined;
        }
      },
      isCurrent(): boolean {
        const current = scope;
        return Boolean(
          current &&
            current.token === token &&
            current.owner === readViewer() &&
            sameAssociation(
              current.ownerAssociation,
              association(readViewer()),
            ),
        );
      },
      publish(access: MutationAccess): boolean {
        const current = scope;
        if (
          !current ||
          current.token !== token ||
          current.owner !== readViewer() ||
          !sameAssociation(current.ownerAssociation, association(access.viewer))
        ) {
          return false;
        }
        current.access = snapshotAccess(access);
        return true;
      },
    };
  };

  return { beginView, getAccess };
}

let latestBinding:
  | {
      token: object;
      gate: ReturnType<typeof createMutationGate>;
    }
  | undefined;

export function bindMutationAccess(
  getAccess: () => MutationAccess,
): () => void {
  const token = {};
  latestBinding = { gate: createMutationGate(getAccess), token };
  return () => {
    if (latestBinding?.token === token) {
      latestBinding = undefined;
    }
  };
}

export function runMutation<T>(operation: () => T): T {
  if (!latestBinding) {
    throw new ReadOnlyViewingError();
  }
  return latestBinding.gate.run(operation);
}
