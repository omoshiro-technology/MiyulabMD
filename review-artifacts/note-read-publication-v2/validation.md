# note-read-publication-v2 validation

The candidate was tested before restoring the accepted source.

- Original source: `c937729ff15d9f9183d99fb3552149eca5c89215023b149ad54dc7e60524f940`
- Candidate source: `8d192d9eef9fb22c7ddd6c378e9754326d645adb9eb92e5bcc6cf33a3e826d5b`
- Snapshot source: `8d192d9eef9fb22c7ddd6c378e9754326d645adb9eb92e5bcc6cf33a3e826d5b`

Commands and results:

- `pnpm install --frozen-lockfile` — exit 0
- `pnpm --filter @miyulabmd/web typecheck` — exit 0
- `pnpm exec biome check apps/web/src/lib/note-read-session.ts && git diff --check` — exit 0
- `pnpm --filter @miyulabmd/web test:browser:install` — exit 0
- `pnpm --filter @miyulabmd/web test:browser note-read-session.spec.ts note-read-publication.spec.ts viewer-context.spec.ts offline-cache.spec.ts offline-cache-cleanup.spec.ts offline-folder-cache.spec.ts offline-note-list-cache.spec.ts storage-platform.spec.ts` — exit 0, 19 passed
- `pnpm --filter @miyulabmd/web test` — exit 0, 117 passed

The candidate and snapshot were byte-identical and differed from the original.
