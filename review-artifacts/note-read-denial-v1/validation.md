# Note-read denial invalidation v1

## Scope

Candidate sources implement scoped persistent eviction for confirmed HTTP 403/404 note reads. The reader awaits cache invalidation before publishing the original HTTP failure; cache cleanup remains optional and cannot convert denial into communication success. IndexedDB note and list changes are one transaction, preserving list `cachedAt`; OPFS deletion uses the committed record's exact filename.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- `pnpm --filter @miyulabmd/web test:browser:install`: passed (project-local Chromium).
- Target browser command from the handoff: 20 passed.
- `pnpm --filter @miyulabmd/web test`: 117 passed.
- `pnpm --filter @miyulabmd/web typecheck`: passed.
- Targeted Biome check/write and `git diff --check`: passed after formatting.

The first browser attempt was intentionally retried after the required project-local browser installation because the executable was absent.
candidate snapshots match; both differ from originals

## Restoration proof

- Candidate source bytes match the nested candidate snapshots in this directory.
- Candidate hashes differ from the original hashes captured before implementation.
- After validation, only this agent's additions were removed from the live source files with `apply_patch`; live source hashes now match the captured originals exactly:
  - `apps/web/src/lib/note-read-session.ts`: `8d192d9eef9fb22c7ddd6c378e9754326d645adb9eb92e5bcc6cf33a3e826d5b`
  - `apps/web/src/lib/offline-cache.ts`: `ee53bce82df04d6a75f0caeb8ad552fb425fb1a3c659bd24d1972726bb0f122d`
