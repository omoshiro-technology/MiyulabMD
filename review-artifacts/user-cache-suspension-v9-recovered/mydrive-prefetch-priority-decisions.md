# C6 current-route priority and complete-list following

Candidate only. This slice changes only `src/lib/mydrive-prefetch.ts` and
`src/lib/mydrive-prefetch-coordinator.ts` under this candidate directory, plus
two new browser specs and this document. No live adoption, staging, commit,
core/session/UI/API/runner/dependency source changes.

## Interface and ordering

`prefetchMyDrive(viewer, { signal, getPriority })` accepts an optional callback
returning `{ kind: "folder" | "note", id: string } | null`. The callback reference
is captured at entry alongside the signal; the existing copied viewer/user
remains fixed for the entire acquisition.

The coordinator supplies a callback reading this tab's current pathname:
`/f/:folderId`, `/n/:id`, and `/n/:shortId` (URI-decoded, optional trailing slash).
Other paths and malformed escapes have no preference. No navigation listener,
second scheduler, persisted queue, or new trigger is introduced.

The acquisition selects anew from its remaining local work between operations.
Current `/f` folder details precede other pending folders; current `/n` canonical
or short-ID note, or notes in current `/f`, precede unrelated eligible bodies.
Canonical note IDs take precedence over short-ID matches. Ordinary work retains
the current server-list order. Root intent remains `asDriveRoot: folder.id ===
root.id`, never inferred from which detail request happens first.

**Foreground versus background:** actual foreground reads remain immediate and
ungated. The background still needs the authoritative tree/list to establish
owned membership, and retains the existing folder-metadata/list-before-body
barrier. Priority is among eligible pending background work, not a promise to
fetch any route's body before metadata. A route hint cannot admit another user's
shared/public note, a null-folder note, or a note outside the current owned tree.
This distinction was explicitly confirmed by the parent coordinator.

There is still only one awaited background request at a time. A request already
in progress (including its existing bounded retry) is not preempted. Navigation
affects the next selection, not its viewer, signal, retry budget, or transport
subscriber. Existing request-sharing, timestamp skips, cooldown, auth/storage
stops, and terminal cancellation/close behavior are unchanged.

## Complete-list following and its limits

The new second-cycle test uses current successful, complete tree/list/root
fixtures. Existing contracts already replace root child navigation and the note
list; candidates are rebuilt from that cycle's tree and owned note membership.
It verifies:

- A removed note and a note moved outside MyDrive do not appear in offline
  MyDrive root navigation; the removed folder link also disappears.
- No departed folder/body request is made on the second cycle, and the unchanged
  retained body is skipped by its current `updatedAt`.
- The all-accessible-note list retains the out-of-MyDrive shared summary, while
  MyDrive navigation excludes it by folder membership. The global list is not
  incorrectly narrowed to owned candidates.
- A still-readable cached shared body absent from the new listing survives
  byte-for-byte. Its absence is not a 403; neither that body nor another departed
  body's cache is automatically denied/deleted.

No cache-core implementation was needed for those assertions. This is not a
stronger atomic completeness guarantee:

- The cache API has individual `putFolder`/`putNoteList`, not a transaction that
  persists/reconciles an entire owned tree. A departed folder's old detail record
  can still be read by a direct old `/f/:id` route, although the refreshed root
  no longer links to it. Removing stale direct-route membership while preserving
  independently valid shared folder snapshots needs a scoped cache contract,
  not `denyFolder` on absence.
- Tree, folder detail, and note list are separate successful API responses, with
  no common server snapshot/revision token. We cannot prove they describe the
  same instant under concurrent server mutations, nor manufacture a snapshot
  version. Cross-response atomic completeness needs an explicit server contract
  plus a cache reconciliation boundary.
- Partial/exhausted acquisition retains existing best-effort outcomes; this slice
  does not turn a partial folder cycle into permission denial or blanket eviction.

## Validation

Frozen dependencies installed with `pnpm install --frozen-lockfile --offline`;
authorized project-local Chromium installed using
`pnpm --filter @miyulabmd/web run test:browser:install`.

RED: the three new current-route browser cases initially all failed with
`ordinary, preferred` request order instead of `preferred, ordinary`.
After implementation, they pass. Final cases additionally hold the preferred
body, change the location again to `/n/later-short`, verify no second background
request while held, then verify `later` precedes still-pending `ordinary`.
The complete-list test passed against the existing replacement contract; no
artificial implementation change was made just to produce a RED.

Focused command (final assertions): **22 passed**; candidate typecheck passed;
Biome checked all 24 candidate sources, with only three preexisting
`RichMarkdownEditor` hook-dependency warnings. New-spec standalone Biome passed.

```sh
node apps/web/scripts/check-offline-candidate.mjs \
  review-artifacts/user-cache-suspension-v9-recovered all \
  mydrive-prefetch-priority.spec.ts mydrive-prefetch-membership.spec.ts \
  mydrive-prefetch-resilience.spec.ts mydrive-prefetch-metadata-retry.spec.ts \
  mydrive-prefetch-ownership.spec.ts mydrive-prefetch.spec.ts \
  note-request-sharing.spec.ts --workers=1
```

Full serial `all`: all runner-default spec files plus the two new specs,
**127 passed / 1 failed (128 total)**, repeated with the same result. The sole
failure is the parent's separately known cross-tab core case:
`offline-cache-tabs.spec.ts:71`, `published` expected false but received true.
It was not weakened or edited. The full run includes the final dynamic
body-gating assertions; the subsequent stronger explicit shared-body assertion
was additionally confirmed by the final focused run above.

Reproduce full serial selection without editing or dropping runner defaults:

```sh
node -e '
const fs = require("node:fs"), cp = require("node:child_process");
const runner = "apps/web/scripts/check-offline-candidate.mjs";
const source = fs.readFileSync(runner, "utf8");
const block = source.slice(source.indexOf("...(specs.length"),
  source.indexOf("if (loaded.size"));
const specs = [...new Set([...block.matchAll(/"([^"]+\.spec\.ts)"/g)]
  .map(m => m[1]).concat(["mydrive-prefetch-priority.spec.ts",
    "mydrive-prefetch-membership.spec.ts"]))];
const result = cp.spawnSync(process.execPath, [runner,
  "review-artifacts/user-cache-suspension-v9-recovered", "all",
  ...specs, "--workers=1"], { stdio: "inherit" });
process.exit(result.status);
'
```

Candidate SHA256:

- Acquisition: `ae24b9596672530830984bd58703656c938d8a57c371bf26a884d2506bbe0907`
- Coordinator: `9d3bf7a8b808a028b2521cd96df095245f4745d9786f482c358a09865d601c6f`

These tests use Chromium's real IndexedDB/OPFS and public exported entry points
with routed API fixtures, plus actual offline MyDrive rendering. They do not
claim deployed server snapshot consistency, Service Worker offline startup, or
a broader foreground/preemption guarantee than the observations above.
