# C6 acquisition resilience validation

Candidate only; no staging, commit, live adoption, runner edits, or dependency
changes. Installed the frozen dependency set with
`pnpm install --frozen-lockfile --offline` and the authorized worktree-local
Chromium with `pnpm --filter @miyulabmd/web run test:browser:install`.

## RED → GREEN

Runner prefix throughout:

```sh
node apps/web/scripts/check-offline-candidate.mjs \
  review-artifacts/user-cache-suspension-v9-recovered
```

1. Before implementation, `browser mydrive-prefetch-resilience.spec.ts
   --workers=1`: **2 failed**. Network failure requested only the failed note
   (independent note was starved); HTTP 503 requested failed/independent once
   each (no spaced retry).
2. After acquisition implementation but before cooldown: **8 passed / 2
   failed**. Transport-wrapped note communication needed the existing
   `ApiCommunicationError` classification; cooldown RED observed **5 tree
   requests instead of 2** under repeated online triggers.
3. After classification and cooldown fixes, focused `all` with all eight
   existing prefetch specs plus resilience: **23 passed**, candidate typecheck
   and Biome passed. New test formatting was corrected separately with patches.
4. Added metadata-path coverage, post-cancellation observation, committed body
   checks, and cooldown expiry/resumption. Final serial candidate `all`, using
   every default spec plus both new specs: **111 passed / 1 failed (112 total)**,
   typecheck passed and Biome checked all 21 candidate sources successfully.
   The sole failure is the short-ID cache case described below. The serial
   command was run twice with the same result.

Final standalone Biome check of both new specs and `git diff --check` passed.

New specs (parent must pass these explicitly; runner default is unchanged):

- `mydrive-prefetch-resilience.spec.ts`: 10 cases — network and 503 bounded
  spacing, recovery, communication circuit stop, abort during delay, immediate
  auth stop, quota stop, malformed JSON without retry, next-cycle fresh
  candidates/unchanged-body skip, and bounded trigger cooldown plus expiry.
- `mydrive-prefetch-metadata-retry.spec.ts`: 4 cases — tree/folder/list 503
  recovery, and exhausted folder detail with independent body acquisition.

To reproduce the complete serial run without changing the runner or silently
dropping its default specs:

```sh
node -e '
const fs = require("node:fs"), cp = require("node:child_process");
const runner = "apps/web/scripts/check-offline-candidate.mjs";
const source = fs.readFileSync(runner, "utf8");
const block = source.slice(
  source.indexOf("...(specs.length"), source.indexOf("if (loaded.size")
);
const specs = [...block.matchAll(/"([^"]+\.spec\.ts)"/g)].map(m => m[1]);
const result = cp.spawnSync(process.execPath, [
  runner, "review-artifacts/user-cache-suspension-v9-recovered", "all",
  ...specs, "mydrive-prefetch-resilience.spec.ts",
  "mydrive-prefetch-metadata-retry.spec.ts", "--workers=1"
], { stdio: "inherit" });
process.exit(result.status);
'
```

## Known incompatible assumptions and isolated-scope failure

An earlier **parallel default** candidate run (without the 14 new cases) had
**95 passed / 3 failed**. It is not the deterministic baseline.

Two failures were the existing online/visibility burst cases in
`mydrive-prefetch-triggers.spec.ts`. Their `cycles` variable counts
`/api/folders/tree` HTTP requests, not coordinator cycles. The fixture aborts
only the first request with `internetdisconnected`; every subsequent request
succeeds. It assumes that failure immediately terminates the first cycle,
that no retry occurs before the Home link renders, and that the final request
count is exactly two. C6 correctly permits initial request + in-cycle retry +
the already-supported single pending follow-up cycle, giving three requests
when observed late enough. Both cases passed serial, but that does not prove
the old timing-dependent assumption compatible.

Existing assertions were **not weakened or edited**. Recommendation for a
separate trigger-test update: observe cycle completion separately from HTTP
attempts, or give the scheduling-only test a non-retryable first response and
control the cooldown clock explicitly. Keep exact scheduling/body assertions;
do not suppress actual retries or discard pending reevaluation for old counts.

The serial sole failure is `offline-cache.spec.ts` “cached short IDs resolve the
current user snapshot and respect canonical denial”: expected the original
snapshot through its short ID, received null. Parent confirmed that this is
fixed in its newer cache candidate, which is absent in this isolated clone.
No cache code was restored or edited here. Full combined GREEN remains a
parent-side validation requirement after integrating the independent cache
slice and deliberately updating trigger-test assumptions.

All unchanged prefetch ownership, denial, storage/auth/terminal-close,
cross-tab, mutation, periodic, and trigger tests passed in the serial run.
Browser coverage uses real IndexedDB/OPFS and routed API fixtures, not deployed
production/PWA behavior. This slice makes no full offline/PWA release claim.
