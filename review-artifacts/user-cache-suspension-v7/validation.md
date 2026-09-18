# User-wide offline-cache suspension v7

## INVALID HANDOFF — do not adopt these snapshots

The parent verified that both saved source snapshots contain the accepted
baseline, NOT the tested candidate. `hashmanifest.txt` describes those baseline
bytes. The tested candidate is unavailable in this artifact directory.

The worker reported these hashes for the lost tested candidate:

- offline-cache.ts: `2b9e1a3765301da28db0241946e131488c00bf903159ff2abe853d972d66bec3`
- note-read-session.ts: `ebc609fc3f44665c3c719fe015a74f1f3c93d3deda4879830efe322ae3ef8217`

The test results below are the worker's report for that candidate; they do not
validate the snapshots in this directory. The parent has not adopted this change.
Both live source files were independently verified to match the accepted
baseline hashes below.

## Baselines verified before editing

- offline-cache baseline and durable original: `ee53bce82df04d6a75f0caeb8ad552fb425fb1a3c659bd24d1972726bb0f122d`
- note-read-session baseline and durable original: `8d192d9eef9fb22c7ddd6c378e9754326d645adb9eb92e5bcc6cf33a3e826d5b`

## Worker-reported validation of the unavailable candidate (all exit 0)

- `pnpm install --frozen-lockfile`
- `pnpm --filter @miyulabmd/web test:browser:install`
- targeted browser command from handoff: 27 passed
- `pnpm --filter @miyulabmd/web test`: 117 passed
- `pnpm --filter @miyulabmd/web typecheck`
- `pnpm --filter @miyulabmd/web exec biome check src/lib/offline-cache.ts src/lib/note-read-session.ts`
- `git diff --check`
