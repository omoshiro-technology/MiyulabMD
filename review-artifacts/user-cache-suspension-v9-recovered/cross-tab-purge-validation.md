# D111 cross-tab purge validation

All browser runs were serial (`--workers=1`) using local Chromium. Dependencies
were installed with `pnpm install --frozen-lockfile`; the lockfile was not changed.

## Actual RED

Against the current live baseline, without copying historical candidate bytes:

```sh
pnpm --filter @miyulabmd/web test:browser tests/browser/offline-cache-tabs.spec.ts --workers=1
```

**4 failed**, as intended:

1. Parent regression: another tab's late NoteReadSession response publishes `true`.
2. Missed-message old Alice handle saves successfully and recreates Alice's OPFS
   directory; Bob remains independently writable.
3. Purge never queues an exclusive app/user Web Lock behind the gated OPFS write.
4. With BroadcastChannel unavailable, the late HTTP response still publishes.

The first three were also run separately before the fourth was added. The original
parent regression remains unchanged.

## Focused GREEN

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-cache-tabs.spec.ts offline-cache-clear.spec.ts home-metadata.spec.ts note-denial-entry-ordering.spec.ts note-denial-ordering.spec.ts mydrive-prefetch-stops.spec.ts --workers=1
```

**24 passed.** This includes all four cross-tab cases, explicit fresh Alice saves,
Bob isolation, pending actual OPFS operations, missed-message durable fencing,
same-page purge, failed purge/retry, exact cancellation reasons, committed
snapshots, denial entry ordering, and acquisition close/storage/auth outcomes.

The OPFS test gates a real storage operation and observes the actual Web Locks
queue. It has no fixed sleeps and never holds a network request under a lock.

```sh
pnpm exec biome check apps/web/tests/browser/offline-cache-tabs.spec.ts
```

Passed after formatting only the newly appended cases.

## Full candidate run

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1
```

Candidate lint and typechecking passed. Lint reports three existing
`RichMarkdownEditor` exhaustive-dependency warnings.

Browser result: **111 passed, 2 failed**. Both failures are the startup transient
retry expectations in `mydrive-prefetch-triggers.spec.ts` (`online` and
`visibilitychange`); each sees a null cached body.

This isolated snapshot still has acquisition
`3fed3078feaac884e3590e1872a33d51564a8147d9f7bc9e971dd45ca5cea77c` and coordinator
`728306e697af0c4c91692755691580f4da55038ea4841c70639962ffb4000630`, while the parent
reports newer acquisition `cfc6aa9a…` / coordinator `2190227…` with independently
passing retry tests. The two failures are therefore reported as a **known
snapshot mismatch requiring merged revalidation**, not silently excluded or
claimed to be proven unrelated to this core.

An earlier development run also exposed four timing regressions caused by opening
and closing authority-reader database connections for each check. The current
single realm authority-reader connection fixes the underlying lifecycle/overhead
problem; all four original tests now pass unchanged.

No live implementation, runner, acquisition, coordinator, existing tests outside
the append-only cross-tab spec, UI, editor, Worker, PWA, or API files were edited
by this slice. No files were staged or committed.

## Final candidate hashes

The final full serial run reproduced 111 passed / 2 snapshot-mismatch failures.
`git diff --check` passed.

| Candidate file | SHA256 |
| --- | --- |
| `offline-cache.ts` | `6c8c8ab3971dd2651100ba41b0853147883351e16d0f7504cfd0503ad100e42e` |
| `note-read-session.ts` | `94aecbc156efa969d20fdef6d5dbe618cebd6aa8732f64a8ae08ba4c9fc9e19f` |
| `src/lib/home-metadata-reader.ts` | `f4f99ff1ef7cda71529c755fabd3fd02f4a8cc3d9abe057bca6d38773beb724f` |
| `src/lib/note-access-order.ts` (unchanged) | `1edaa959a2733af6ccc9561210238d6c4c2a6217368ff7a93d4031e1813dd68a` |

## Parent recovery after token-limit interruption

The stopped terminal-guard worker's edits were not present in the parent.
The parent recreated actual-IDB regressions in `offline-epoch-terminal.spec.ts`:
two cache-open failures were RED, then four final-publication cases were RED.
Open now closes the acquired connection on epoch failure and preserves abort
precedence. Note/Home publication checks local ownership after the final
authority await, including Home's outer wrapper.

After adding simultaneous failure/cancellation coverage, the focused command
with epoch, clear, tabs, Home and note-publication specs passed **27 tests**
(including eight new terminal cases). Candidate typecheck and targeted Biome
passed. One duplicate focused invocation is not counted as additional coverage.

The parent then ran unfiltered candidate `all --workers=1`: **144 passed,
1 failed**. The only failure is the separately recorded attached-image RED;
the newer acquisition, priority and editor candidates are now included.

Current reviewed hashes:

- Cache: `963fef222a16c99829cbad6fc888cc042c76ee1e341fa241eaaff9be31374893`
- Note session: `8487ab5bf0761da41bed6f1356e4d84541a00bda9f070ca9baf072a7705f4482`
- Home reader: `eaa4cb40537d44649b018758930a598f61862d81cba76a976a3f473fbeaeee33`
