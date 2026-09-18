# C9 SAFE ORPHAN GC foundation — validation

Candidate-only validation. No live `apps/web/src` file, existing test, API,
identity, UI, prefetch, coordinator, or runner file was changed.

## Commands

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; installed 855 workspace packages |
| `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered typecheck` | Passed |
| `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered lint` | Passed |
| `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-cache-gc.spec.ts offline-cache-clear.spec.ts offline-image-cache.spec.ts --workers=1` | Blocked: candidate runner could not locate its isolated Chromium headless-shell executable after the authorized project-local browser install |

The browser command was attempted before and after installing the project-local
Chromium/headless shell (`PLAYWRIGHT_BROWSERS_PATH=0 pnpm --filter
@miyulabmd/web exec playwright install chromium-headless-shell`). It therefore
has no browser red/green claim in this environment; the 14 reported failures
were browser launch failures, not test assertions.

The passing candidate typecheck emitted the candidate `offline-cache.ts` hash
`6294179604bae8fce6e4406e35193470c276f6b629660cd4eb5527466cacb1a7` before
the final lint-only suppression placement. The final implementation hash is
available from the candidate runner on the next validation run. This is a
foundation candidate only, not a C9 completion claim: quota/UI adoption is
still parent-owned.

## Parent browser verification and live adoption

The first parent candidate run executed assertions: **13 passed / 2 failed**.
One fixture missed awaits between directory-handle promises. The other created
an unreferenced hand-written file and incorrectly expected GC to preserve it.
Both fixture issues were corrected without weakening valid-reference safety.

Additional actual RED: an Alice-keyed record with mismatched owner caused GC
to resolve successfully and delete the body (`rejected: false`, body unavailable
after metadata repair). The key-range/record validation repair made it GREEN.

Final focused candidate GC **5 passed**, candidate typecheck and targeted
Biome passed. Coverage includes note/image replacements, cachedAt retention,
Bob and shell isolation, unknown-file retention, unreadable/corrupted
references, equal filenames in different note paths, and real cross-page
public-write lock queuing.

Live adoption used a literal patch and exactly matches the candidate after
omitting its first comment line:

- Candidate full SHA256: `cf91cf7b9eb4846542381af2b274cca01d07de88edfd3c17ed6b2958fcdfbc9a`
- Live SHA256: `638df660f358089a9952f9f754676197af083e16d42f4f710cceb7ccd2adddfc`
- `pnpm --filter @miyulabmd/web typecheck` — app/SW passed.
- `pnpm --filter @miyulabmd/web test:browser offline-cache-gc.spec.ts offline-cache-clear.spec.ts offline-image-cache.spec.ts --workers=1`
  — **17 passed**.
- `pnpm --filter @miyulabmd/web test` — **117 passed**.
- Live cache Biome and `git diff --check` passed.

The four committed mounted-denial RED tests remain separate work. No full-suite
or C9 completion claim is made by this primitive's focused verification.
