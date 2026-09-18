# D111 validation

## Exact SHA256

| Artifact | SHA256 |
| --- | --- |
| offline-cache.ts | `251422b7fb3d5e2514ccc63dbf8b48dbbc89b1dca245ef00aa0b32f532cdf057` |
| src/lib/note-access-order.ts | `1edaa959a2733af6ccc9561210238d6c4c2a6217368ff7a93d4031e1813dd68a` |
| note-read-session.ts (unchanged) | `c95e764c923ce243fd972d969ec68ab9830fe248a47987e670077c330483aa7c` |
| tests/short-id-denial-generation.test.mjs | `bcdc3b2a761273c1e0ea8f8f5aaccba5737e8c8586ca04fe25638f001ec53e18` |

## Evidence

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-direct-denial.spec.ts note-denial-ordering.spec.ts note-denial-entry-ordering.spec.ts note-denial-failure.spec.ts note-read-denial.spec.ts note-read-session.spec.ts offline-cache.spec.ts offline-share-view.spec.ts
node --experimental-strip-types --test review-artifacts/user-cache-suspension-v9-recovered/tests/short-id-denial-generation.test.mjs
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all
```

- Explicit denial/order/read/short/Share: **24 passed**. Includes the parent's
  previously RED real short-ID HTTP denial hiding canonical body/list.
- Focused I/O-free generation tests: **3 passed** (current pair fencing,
  obsolete short detachment/user-clear unknown IDs, newly discovered denial).
- Final candidate all: typecheck passed, Biome **22 files** without fixes,
  **99 browser tests passed**. Includes D108 clear/drain and terminal regressions.
- Candidate runner's unchanged-source checks passed.

The all runner's default browser list does not include offline-share-view;
that spec was therefore explicitly run above. Counts overlap, not 126 unique
browser cases. No existing tests were weakened.

Dependencies were initially absent. Installed frozen lockfile dependencies
and project-local Chromium using existing scripts. Node's standalone ledger
test emits a harmless module-type warning; no package configuration was changed.
An intermediate all run caught import ordering/complexity lint problems,
corrected with patches before the final passing run.

These results are same-page generation evidence and durable denial behavior,
not cross-tab persistent fencing certification or permission to adopt live.
