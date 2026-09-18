# D38 API mutation candidate validation

## Baseline protection

Live source hashes were recorded before editing and remain unchanged:

```text
apps/web/src/components/layout/AppShell.tsx 35e12ccf2834601f960cce89e9ee4e918b630298391883ce23d1f02e5e8d25da
apps/web/src/components/layout/AppShellContext.ts 0ff5b9d61b118865cde5859b5557eab56c21e76eeafdf2d3d680e47d78de2915
apps/web/src/lib/api.ts 10c1210f0bc3e241e1f8205b857e6e82a7cae5e7f180637ab810f346e7050f53
apps/web/src/lib/api-transport.ts 69bbcb1269d84d5a2fe9609ac4253857935247e2cda0110f1648173cdf8796e3
```

## Commands and results

| Command | Exit/result |
| --- | --- |
| `git diff --check -- review-artifacts/user-cache-suspension-v9-recovered` | 0 |
| `pnpm install --frozen-lockfile` | 0; 625 packages installed |
| `pnpm --filter @miyulabmd/web run test:browser:install` | 0; project-local Chromium installed |
| `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser mutation-api-access.spec.ts` | First run failed because the fixture returns a bare note array while the pre-existing parser expected `{notes}`; candidate adjusted to accept both |
| same focused browser command after the candidate-only parser fix | 0; 1 passed |
| `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all` | 0; candidate lint/typecheck plus 36 browser tests passed |
| `pnpm --filter @miyulabmd/web test` | 0; 117 passed, 0 failed |
| `git diff --check -- review-artifacts/user-cache-suspension-v9-recovered` | 0 |

The all-candidate run includes the focused mutation test and the existing
35 browser tests. No live browser tests were used as evidence for candidate
code; the live unit run is the existing 117-test suite.

## Final candidate hashes

```text
api.ts 8b197da15ad18448f648c8feb8231bef702491b4cf4fed2e6ce5a5fe0c0c2bab
api-fetch.ts 8bd0da4e08e7454ceeeba3204a669f38dbfebf4404dac027b1b4da24efa26e16
api-transport.ts 5d93a39d54b05df8ea02f26b407d064fed77bc80c93ce23b4d7b18d13691a2bb
src/components/layout/AppShell.tsx d012cb0c7d886531527e2ad7ff275ffd6104bb0ae1a904440d55f7ea2616cbd9
src/components/layout/AppShellContext.ts fbe558c87902316fed25b6ed9d9f48dcbf9c7be9f8aeca3792c5412bf7fe49d8
```

## Review correction rerun

The mutation fixture was corrected to return the established `{ notes: [] }`
contract, and the candidate's temporary bare-array compatibility was removed.
The focused candidate browser test passed again: **1 passed**. The requested
candidate `all` command was rerun and currently exits 1 during Biome: the
shortened candidate `api.ts` has 33 formatting/block-structure diagnostics.
No suppression was retained. Restoring the original 545-line API body with
only `apiFetch` substitutions remains required before `all` can pass.
