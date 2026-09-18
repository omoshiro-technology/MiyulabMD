# D36 viewing/mutation validation

## Parent adoption verification

The parent reran candidate `all`: typecheck, Biome and 35 browser tests passed.
The live `apps/web/src/lib/viewing-access.ts` was then created through apply_patch
and verified byte-for-byte against the candidate (same SHA-256 below).
The live public-policy browser test passed; live Web unit117, typecheck,
targeted Biome and diff-check also passed.

This adopts the policy module only. API and page consumers are not connected yet.
The original worker record follows.

Candidate: `review-artifacts/user-cache-suspension-v9-recovered/viewing-access.ts`

The parent RED browser test was run through the candidate runner after the
implementation:

```text
node apps/web/scripts/check-offline-candidate.mjs \
  review-artifacts/user-cache-suspension-v9-recovered browser viewing-access.spec.ts
```

Result: **1 passed** (exit 0).

The candidate source was also checked with:

```text
node apps/web/scripts/check-offline-candidate.mjs \
  review-artifacts/user-cache-suspension-v9-recovered all
```

Result: **candidate typecheck, Biome, and 35 browser tests passed** (exit 0).

The required live regression command was run separately:

```text
pnpm --filter @miyulabmd/web test
```

Result: **117 live tests passed** (exit 0). `git diff --check` passed (exit 0).
Live source, tests, runner, and existing core/UI candidates were not modified.

Final source SHA-256 is recorded after the last edit:

```text
439b32f697a82f9fdbb5ee7f1d3953b17ca8d632d9a6e7d307950363388b5214
```
