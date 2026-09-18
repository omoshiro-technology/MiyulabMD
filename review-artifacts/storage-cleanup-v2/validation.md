# Storage cleanup v2 review artifact

## Captured sources

- `apps/web/src/lib/note-read-session.ts.txt` and `offline-cache.ts.txt`: exact originals captured before implementation.
- `apps/web/src/lib/note-read-session.candidate.ts.txt` and `offline-cache.candidate.ts.txt`: exact sources used for the passing validation runs.
- `hash-manifest.txt`: SHA-256 hashes for both sets.

## Validation commands and results

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit 0.
- `pnpm --filter @miyulabmd/web test:browser note-read-session.spec.ts viewer-context.spec.ts offline-cache.spec.ts offline-cache-cleanup.spec.ts offline-folder-cache.spec.ts offline-note-list-cache.spec.ts storage-platform.spec.ts` — exit 0; 16 passed.
- `pnpm --filter @miyulabmd/web test` — exit 0; 117 passed.
- `pnpm --filter @miyulabmd/web typecheck` — exit 0.
- `pnpm exec biome check --write apps/web/src/lib/note-read-session.ts apps/web/src/lib/offline-cache.ts` — exit 0.
- `git diff --check` — pending after source restoration.

The initial browser test attempt before installing the project-local browser exited 1 (16 launch failures); it was rerun after the required install and passed.
