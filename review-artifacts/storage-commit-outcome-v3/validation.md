# Storage commit outcome v3 review artifact

## Captured sources

- `apps/web/src/lib/note-read-session.ts.txt` and `offline-cache.ts.txt` are
  the exact accepted originals.
- `apps/web/src/lib/note-read-session.candidate.ts.txt` and
  `offline-cache.candidate.ts.txt` are the exact sources used for validation.
- `hashmanifest.txt` records original, candidate, and rejected v2 snapshot
  SHA-256 hashes. The candidate hashes differ from the originals and from the
  rejected v2 snapshot.

## Validation

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit 0.
- `pnpm --filter @miyulabmd/web test:browser note-read-session.spec.ts viewer-context.spec.ts offline-cache.spec.ts offline-cache-cleanup.spec.ts offline-folder-cache.spec.ts offline-note-list-cache.spec.ts storage-platform.spec.ts` — exit 0; 17 passed.
- `pnpm --filter @miyulabmd/web test` — exit 0; 117 passed.
- `pnpm --filter @miyulabmd/web typecheck` — exit 0.
- `pnpm exec biome check --write apps/web/src/lib/note-read-session.ts apps/web/src/lib/offline-cache.ts` — exit 0.
- `git diff --check` — exit 0.
