# D97 viewer recovery validation

Candidate checkpoint: `5e7f7c0`.

## Commands and exact results

Dependencies and the project-local browser were installed first:

```text
pnpm install --frozen-lockfile
exit 0
pnpm --filter @miyulabmd/web test:browser:install
exit 0
```

Focused candidate browser tests were run serially:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser viewer-recovery.spec.ts
exit 0
2 passed (6.7s)

node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser app-shell-viewer.spec.ts
exit 0
2 passed (3.0s)

node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-note-view.spec.ts
exit 0
2 passed (5.4s)
```

Full candidate validation:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
83 passed (26.2s)
```

Live unit suite:

```text
pnpm --filter @miyulabmd/web test
exit 0
117 passed
```

Static checks:

```text
pnpm exec biome check review-artifacts/user-cache-suspension-v9-recovered/src/components/layout/AppShell.tsx
exit 0
Checked 1 file in 1244ms. No fixes applied.

git diff --check
exit 0
```

The candidate `AppShell.tsx` SHA256 after implementation is:

```text
44491b9483c6d70f6545e791effda4d16bfccd671d1c64ad9e43f7eea3c7d6c4
```

No command failed. The two viewer-recovery cases cover cached Alice recovery
and immediate Bob replacement without document reload; later failure and
ownership-race coverage remains a parent pre-adoption requirement.

## D98 validation

The candidate was changed only in `src/components/layout/AppShell.tsx`; this
decision and validation record were appended as the allowed review artifacts.

Exact commands and results:

```text
pnpm install --frozen-lockfile
exit 0

pnpm --filter @miyulabmd/web test:browser:install
exit 0

node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser viewer-recovery.spec.ts
exit 0
3 passed (4.5s)

node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser app-shell-viewer.spec.ts
exit 0
2 passed (2.5s)

node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
exit 0
84 passed (20.3s)

pnpm --filter @miyulabmd/web test
exit 0
117 passed

pnpm exec biome check review-artifacts/user-cache-suspension-v9-recovered/src/components/layout/AppShell.tsx
exit 0
Checked 1 file in 1726ms. No fixes applied.

git diff --check
exit 0
```

The D98 candidate `AppShell.tsx` SHA256 is:

```text
743d25bc602ebb1788f9fe5de0de4d7b6dc80dd5050a6b9c9185d1d3f5c46590
```

The first full-candidate attempt after the initial inline implementation exited
1 because Biome reported cognitive complexity 16 (maximum 15). The predicate
was then extracted into the same allowed file, and the exact full validation
above passed. No live source or test files were changed.
