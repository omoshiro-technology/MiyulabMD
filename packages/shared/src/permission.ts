/** 読み取り・書き込みそれぞれの公開範囲。 */
export const ACCESS_SCOPES = [
  "public",
  "link",
  "signed_in",
  "users",
  "self",
] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export const ACCESS_SCOPE_LABELS: Record<AccessScope, string> = {
  public: "公開",
  link: "リンクを知っている全員",
  signed_in: "ログイン済みのみ",
  users: "指定ユーザーのみ",
  self: "自分のみ",
};

export const ACCESS_SCOPE_HINTS: Record<AccessScope, string> = {
  public: "誰でもアクセスでき、公開一覧にも表示されます",
  link: "リンクを知っている全員がアクセスできます（公開一覧には表示されません）",
  signed_in:
    "リンクを知っているログイン済みユーザーがアクセスできます（公開一覧には表示されません）",
  users: "追加したユーザーだけがアクセスできます",
  self: "あなただけがアクセスできます",
};

/** マイドライブ（ユーザー root）の公開範囲。変更不可。 */
export const ROOT_SCOPES = {
  readScope: "self",
  writeScope: "self",
} as const satisfies { readScope: AccessScope; writeScope: AccessScope };

const ACCESS_SCOPE_RANK: Record<AccessScope, number> = {
  public: 0,
  link: 0,
  signed_in: 1,
  users: 2,
  self: 3,
};

export function isAccessScope(value: string): value is AccessScope {
  return (ACCESS_SCOPES as readonly string[]).includes(value);
}

/** 書き込み範囲は読み取り範囲より広くできない。 */
export function clampWriteScope(
  readScope: AccessScope,
  writeScope: AccessScope,
): AccessScope {
  return ACCESS_SCOPE_RANK[writeScope] < ACCESS_SCOPE_RANK[readScope]
    ? readScope
    : writeScope;
}

export type AccessGrant = {
  email: string;
  userId: string | null;
  canWrite: boolean;
};

export type AccessSource = "note" | "folder" | "default";

export type EffectiveAccess = {
  inherit: boolean;
  readScope: AccessScope | null;
  writeScope: AccessScope | null;
  effectiveReadScope: AccessScope;
  effectiveWriteScope: AccessScope;
  source: AccessSource;
  sourceFolder: string | null;
  grants: AccessGrant[];
};

/** 既存インスタンス設定・移行用。新しい UI では使わない。 */
export const PERMISSION_PRESETS = [
  "freely",
  "editable",
  "limited",
  "locked",
  "protected",
  "private",
] as const;

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

export const COLLABORATOR_ROLES = ["viewer", "editor"] as const;
export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

export type ActorKind = "owner" | "signed_in" | "guest";

export type Actor = {
  kind: ActorKind;
  userId?: string;
  email?: string;
};

export type PermissionFlags = {
  canView: boolean;
  canEdit: boolean;
  canAdmin: boolean;
};

export function scopesFromPreset(preset: PermissionPreset): {
  readScope: AccessScope;
  writeScope: AccessScope;
} {
  switch (preset) {
    case "freely":
      return { readScope: "link", writeScope: "link" };
    case "editable":
      return { readScope: "link", writeScope: "signed_in" };
    case "limited":
      return { readScope: "signed_in", writeScope: "signed_in" };
    case "locked":
      return { readScope: "link", writeScope: "self" };
    case "protected":
      return { readScope: "signed_in", writeScope: "self" };
    case "private":
      return { readScope: "self", writeScope: "self" };
  }
}

export function presetFromScopes(
  readScope: AccessScope,
  writeScope: AccessScope,
): PermissionPreset {
  const write = clampWriteScope(readScope, writeScope);
  if (write === "public" || write === "link") return "freely";
  if (write === "signed_in") {
    return readScope === "public" || readScope === "link"
      ? "editable"
      : "limited";
  }
  if (readScope === "public" || readScope === "link") return "locked";
  if (readScope === "self") return "private";
  return "protected";
}

export function isPermissionPreset(value: string): value is PermissionPreset {
  return (PERMISSION_PRESETS as readonly string[]).includes(value);
}

export function actorFromUser(
  user: { id: string; email?: string } | null | undefined,
  ownerId: string,
): Actor {
  if (!user) return { kind: "guest" };
  if (user.id === ownerId) {
    return { kind: "owner", userId: user.id, email: user.email };
  }
  return { kind: "signed_in", userId: user.id, email: user.email };
}

export function grantForActor(
  grants: AccessGrant[],
  actor: Actor,
): AccessGrant | null {
  if (!actor.userId && !actor.email) return null;
  const email = actor.email?.trim().toLowerCase();
  return (
    grants.find((grant) => {
      if (actor.userId && grant.userId === actor.userId) return true;
      return Boolean(email && grant.email === email);
    }) ?? null
  );
}

function scopeAllows(
  scope: AccessScope,
  actor: Actor,
  grant: AccessGrant | null,
  needWrite: boolean,
): boolean {
  if (actor.kind === "owner") return true;
  if (scope === "public" || scope === "link") return true;
  if (scope === "signed_in") return actor.kind === "signed_in";
  if (scope === "users") {
    if (!grant) return false;
    return needWrite ? grant.canWrite : true;
  }
  return false;
}

export function evaluateAccess(
  readScope: AccessScope,
  writeScope: AccessScope,
  actor: Actor,
  grant: AccessGrant | null = null,
): PermissionFlags {
  if (actor.kind === "owner") {
    return { canView: true, canEdit: true, canAdmin: true };
  }

  const write = clampWriteScope(readScope, writeScope);
  const canView = scopeAllows(readScope, actor, grant, false);
  const canEdit = canView && scopeAllows(write, actor, grant, true);
  return { canView, canEdit, canAdmin: false };
}

/** @deprecated 旧プリセット互換。新規コードは evaluateAccess を使う。 */
export function evaluatePermission(
  preset: PermissionPreset,
  actor: Actor,
  collaboratorRole?: CollaboratorRole,
): PermissionFlags {
  const { readScope, writeScope } = scopesFromPreset(preset);
  const grant =
    collaboratorRole === "editor"
      ? {
          email: actor.email ?? "",
          userId: actor.userId ?? null,
          canWrite: true,
        }
      : collaboratorRole === "viewer"
        ? {
            email: actor.email ?? "",
            userId: actor.userId ?? null,
            canWrite: false,
          }
        : null;
  return evaluateAccess(readScope, writeScope, actor, grant);
}

export function folderAncestors(folder: string): string[] {
  const parts = folder.split("/").filter(Boolean);
  const paths: string[] = [];
  for (let i = parts.length; i >= 1; i -= 1) {
    paths.push(parts.slice(0, i).join("/"));
  }
  paths.push("");
  return paths;
}

export function folderContains(parent: string, folder: string): boolean {
  if (parent === "") return true;
  return folder === parent || folder.startsWith(`${parent}/`);
}

/** `from` 配下のパスを `to` 配下へ付け替える。範囲外なら null。 */
export function rewriteFolderPrefix(
  folder: string,
  from: string,
  to: string,
): string | null {
  if (!from || !folderContains(from, folder)) return null;
  if (folder === from) return to;
  return `${to}${folder.slice(from.length)}`;
}
