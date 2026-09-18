# Note denial policy v2 validation

Commands and results:

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --filter @miyulabmd/web test:browser:install` — exit 0.
- Requested browser suite (22 tests) — exit 0, 22 passed.
- `pnpm --filter @miyulabmd/web test` — exit 0, 117 passed.
- `pnpm --filter @miyulabmd/web typecheck` — exit 0.
- `pnpm exec biome check apps/web/src/lib/offline-cache.ts apps/web/src/lib/note-read-session.ts` — exit 0.
- `git diff --check` — exit 0.
