# note-read disposal v1 review artifacts

Candidate snapshots are complete tested copies of the two edited sources:
- `apps/web/src/lib/note-read-session.ts.txt`
- `apps/web/src/lib/offline-cache.ts.txt`

Original snapshots are `note-read-session.original.txt` and `offline-cache.original.txt`.
`hashes.txt` maps SHA-256 hashes for live sources and both snapshot sets.

Validation (all commands run in the worktree before restoring live sources):

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit 0 (project-local browser install).
- `pnpm --filter @miyulabmd/web test:browser note-read-session.spec.ts viewer-context.spec.ts offline-cache.spec.ts offline-folder-cache.spec.ts offline-note-list-cache.spec.ts storage-platform.spec.ts` — exit 0; 14 passed.
- `pnpm --filter @miyulabmd/web test` — exit 0; 117 passed.
- `pnpm --filter @miyulabmd/web typecheck` — exit 0.
- `pnpm --filter @miyulabmd/web exec biome check src/lib/note-read-session.ts src/lib/offline-cache.ts` — exit 0.
- `git diff --check` — exit 0.
