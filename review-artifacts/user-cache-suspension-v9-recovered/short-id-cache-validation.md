# C4 short-ID cache validation

Validated offline-cache SHA256:
`41ecf364fcc5e0af41f79c64b4f4fa9e8161f3c9d30b45d6a5af131119575d38`.

The parent supplied the previously RED browser test:
`cached short IDs resolve the current user snapshot and respect canonical denial`.
This worker did not edit tests, runner, read sessions, request sharing, or live
source files.

## Environment

The first attempt was blocked by missing `vite`; installed existing dependencies
with `pnpm install --frozen-lockfile` (no resolution changes). The next browser
attempt was blocked by missing local Chromium, not assertion failures. Installed
the workspace-local browser using
`pnpm --filter @miyulabmd/web test:browser:install`.

## Passing checks

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-cache.spec.ts offline-cache-clear.spec.ts offline-direct-denial.spec.ts note-denial-ordering.spec.ts note-denial-entry-ordering.spec.ts note-denial-failure.spec.ts note-read-denial.spec.ts user-cache-suspension.spec.ts
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
```

- Focused cache/denial/purge/suspension: **20 passed**, including the parent's
  short-ID regression and all six D108 same-page purge cases.
- Candidate all: typecheck passed, Biome checked **21 files** without fixes,
  **98 browser tests passed**.
- The runner's candidate/live-source unchanged checks passed.

These checks do not claim complete SharePage C4 integration, article alias
support, alias-aware network denial ordering, or cross-tab purge support.
