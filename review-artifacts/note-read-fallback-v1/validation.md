# note-read fallback v1 validation

The candidate source was tested before restoration.

- `pnpm install --frozen-lockfile`: exit 0 (dependencies installed)
- `pnpm --filter @miyulabmd/web test:browser:install`: exit 0 (Chromium installed)
- `pnpm exec biome check --write apps/web/src/lib/note-read-session.ts`: exit 0
- `pnpm --filter @miyulabmd/web test:browser note-read-session.spec.ts viewer-context.spec.ts offline-cache.spec.ts offline-cache-cleanup.spec.ts offline-folder-cache.spec.ts offline-note-list-cache.spec.ts storage-platform.spec.ts`: exit 0, 18 passed
- `pnpm --filter @miyulabmd/web test`: exit 0, 117 passed
- `pnpm --filter @miyulabmd/web typecheck`: exit 0
- `git diff --check`: exit 0
