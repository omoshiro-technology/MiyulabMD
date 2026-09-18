# User cache suspension v9 validation

Validation is intentionally recorded only after the final candidate bytes are
stable. Required commands from the repository root:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9 browser user-cache-write-lifecycle.spec.ts
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9 all
pnpm --filter @miyulabmd/web test
git diff --check
```

The first command is the focused RED-to-GREEN evidence; `all` is the
typecheck/Biome/29-browser evidence. The ordinary web test is the 117-case
live-web regression suite and is supplementary to the candidate runner.

## Results

* `pnpm install --frozen-lockfile`: exit 0 (dependencies restored).
* `pnpm --filter @miyulabmd/web test:browser:install`: exit 0 (Chromium
  installed).
* Focused candidate command: the two lifecycle tests passed, but the command
  exited 1 afterward because the runner's candidate-load assertion reports
  `Candidate was not loaded: note-read-session.ts` (that spec exercises only
  the offline-cache module).
* `node apps/web/scripts/check-offline-candidate.mjs
  review-artifacts/user-cache-suspension-v9 all`: exit 0; typecheck/Biome and
  all 29 browser tests passed.
* `pnpm --filter @miyulabmd/web test`: exit 0; 117 tests passed, 0 failed.
* `git diff --check --cached`: exit 0.

Final SHA256:

```text
offline-cache.ts    515a9c378f86e65e6def3427074c32a423743d0058ffd1099ae8047637958fcd
note-read-session.ts 081bb2dbd02aedecf096b7f6cec7cfde13979a64e0cc2c00c23c1c363da260b7
```

No `apps/web/src/**` file was changed.
