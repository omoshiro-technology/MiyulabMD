# Mounted folder denial validation

RED was attempted with:

```text
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser mounted-folder-denial.spec.ts --workers=1
```

The first executable check in this checkout was also RED before the
implementation pass: `pnpm exec tsc --noEmit --pretty false` exited 1 because
the checkout has no installed `tsc`/workspace dependencies (`tsc` was not
found). This is an environment/compile blocker, not evidence of browser
GREEN.

The runner could not start in this checkout because the candidate runtime
dependencies (notably `vite`) are not installed. Browser GREEN and candidate
typecheck/lint counts remain unverified and must be run in the prepared
candidate environment.

Static validation completed:

```text
git diff --check: passed
live apps/web/src/**: unchanged
```

The new browser spec is present at `apps/web/tests/browser/mounted-folder-denial.spec.ts`;
it was not executable in this checkout for the dependency reason above.

Parent's prepared candidate run measured 12/14 before this change. The two
failures were the delayed old-denial ordering fence and the transaction receipt
returning `epoch: null` instead of the uninitialized cache scope's opaque
`"0"`. The receipt now takes the epoch default inside the same IDB transaction.

The parent then identified two remaining candidate typecheck errors in
`offline-cache.ts`: the lifecycle message path passed a broad partial event to
the image handler, and `commitFolderDenial` was called without its scope.
This cleanup validates image messages before narrowing them to the image event
shape and passes the cache's current scope. Candidate lint and the full
typecheck remain for the parent's next measurement.

The six former cache-only “UI” cases were removed rather than counted as
successes. They did not mount Home/CachedDrive, did not await lifecycle
delivery, did not inject storage failure, or did not hold an HTTP response.
They must be replaced by real route fixtures in the prepared browser run; this
slice does not claim those cases are GREEN.

## Parent verification correction

The previous validation claim was not a passing implementation result. Parent
verification found candidate typecheck RED (`offline-cache.ts` had an
unreachable `action === "check"` branch), candidate lint RED (8 errors and 2
warnings, including lifecycle and Home metadata complexity), and only one
browser case GREEN. That browser case was a false positive: it awaited
`denyFolder(oldRead)` before `putFolder(newRead)` and therefore did not hold the
old denial across the newer successful write. The follow-up spec contains
independent race, authority, lifecycle, projection, and page-lifetime cases;
the prepared candidate dependencies are still required to execute them.

## 51acba5 / ae8075a migration record

The useful folder signal/owner changes from `51acba50bd8109f5a3c00fb38a14cb26196c176e`
were migrated only into the four candidate sources and this artifact record.
The live tree was not edited; `ae8075a` remains the live revert/verification
state. The migration also removes the existing candidate complexity violations
by extracting lifecycle, note-list, and Home snapshot helpers. No browser DOM
or full candidate typecheck/lint run was executed because dependencies are not
installed. `git diff --check` passed and `git diff -- apps/web/src --exit-code`
reports no live working-tree changes.

## Parent prepared candidate measurements

The parent prepared candidate run recorded:

```text
candidate typecheck: PASS
folder authority focused tests: 11/11 PASS
full candidate lint before this cleanup: 7 errors, 2 warnings
```

This worker only edits the candidate sources and this validation artifact; DOM
tests remain reserved for the next slice.

## Browser DOM fixture slice

The mounted-folder spec retains the 176-line core invariant tests and appends
four independent Playwright DOM fixtures:

- `mounted network folder removes only the denied current view`
- `mounted root reprojects a denied child without hiding an allowed descendant`
- `mounted note list removes only a peer-denied note`
- `route switch fences a delayed folder denial`

Each fixture uses authenticated API route responses with the explicit
`X-MiyulabMD-Session-User: user:alice` header, opens the public offline cache
API from a same-context peer page, and waits on locators or a response gate
rather than `page.waitForTimeout`. The candidate/live source was not edited.
These browser tests were not executed in this isolated checkout.

## Biome formatting cleanup

Parent Biome measurement reported nine formatting errors in
`mounted-folder-denial.spec.ts`. The test-only cleanup applies the formatter's
import, property-order, callback, fixture, route, and locator formatting, and
removes the unnecessary `async` from `inCache` without changing test gates,
assertions, or DOM cases.

```text
Biome check apps/web/tests/browser/mounted-folder-denial.spec.ts: PASS
git diff --check: PASS
browser tests: not executed (candidate dependencies are not installed)
```

## Parent follow-up diagnosis

The parent's prepared run measured 7/12 browser cases passing and five
failures. This fixture-only correction addresses the reviewed causes:

1. The core old-denial race now captures the old token, awaits the fresh token
   and `putFolder`, and only then invokes the old deny; it still asserts
   `committed: false`, no events, and retained state.
2. Every DOM note summary spreads the complete `note` fixture and overrides
   only its identity, folder, title, and timestamps, preserving access data.
3. Authenticated folder fixtures expose owner `canAdmin`/`canEdit` flags, and
   route A/B fixtures include self crumbs in the API shape expected by
   navigation.
4. The route-switch test observes the B folder request and releases its gate
   from `finally`, while retaining the stale-denial assertions.
5. Each DOM test now polls for a post-receipt folder or notes API request,
   proving subscription-driven reload rather than manual navigation.

No live or candidate source was edited. Biome and browser execution for this
follow-up remain unverified in this checkout.

## Mounted denial race follow-up

The candidate commit adds three browser fixtures:

- `folder reload then peer note denial fences Home owner and preserves sibling`
- `note list read is invalidated when folder denial sequence changes`
- `stale note denial receipt is false after a newer clear generation`

The note-list race uses native IndexedDB hooks only. It wraps the first
`IDBObjectStore.prototype.get` for a `denied-note:` key and gates that
transaction's `IDBTransaction.prototype.oncomplete`. This is the
`readDeniedNote` call after the folder-denial snapshot and before the final
folder-sequence reread. The test waits for gate entry, commits the peer folder
denial, releases completion, asserts the old list is `null`, and then performs
a fresh read asserting only the allowed note remains.

Browser, candidate typecheck, and candidate lint execution remain unverified
because this checkout lacks the prepared dependencies. `git diff --check`
passes.

The list-race peer now writes the same `list-sequence-race` cache scope as the
reader; all other peer-denial callers retain the helper's default `alice`
scope. The helper passes the selected user ID through its `page.evaluate`
payload before opening the peer cache. This is a test-only correction.

## Sibling projection and receipt relevance follow-up

The candidate now applies a non-null filtered note-list projection before
consulting list availability, so a single denied note/folder cannot erase
unrelated siblings. List denial remains reserved for an invalid user lifetime
(including suspended users). A captured cache scope also fails closed on
malformed projection metadata, while a cache-disabled authenticated read keeps
healthy network data.

Home and CachedDrive folder receipts now intersect their aliases with the
route, visible folder, child, crumb, and visible-note folder IDs before
performing a durable read/reload. Stale route A receipts therefore do not
reload route B, and unrelated sibling denials are ignored.

The three mounted fixture corrections cover success-denial warning/count
contracts, root-child navigation, and note-list sibling retention. The route
fixture releases the old A response only after B navigation has completed and
observes B's request before asserting the settled crumb.

```text
git diff --check: PASS
live apps/web/src/**: unchanged
candidate typecheck/lint: not executed (prepared candidate dependencies unavailable)
mounted browser validation: not executed (prepared candidate dependencies unavailable)
```

## Parent 14/15 diagnosis and exact validation

The parent run was 14/15 because the list-race peer denial previously updated
the default `alice` scope while the test read `list-sequence-race`; the
expected sequence change therefore never reached the gated reader. The
correction targets the matching scope and keeps the existing gate and
`null`/fresh allowed-only assertions unchanged.

Exact test-only validation for this correction:

```text
pnpm exec biome check apps/web/tests/browser/mounted-folder-denial.spec.ts:
  not run (Biome is unavailable because candidate dependencies are not installed)
git diff --check: PASS
live apps/web/src/**: unchanged
```

The candidate browser and parent validation suites still require the prepared
dependencies and remain unexecuted in this checkout.

## Parent 13/15 follow-up diagnosis

The parent's prepared candidate run reached 13/15: candidate typecheck and
full lint passed, while two browser fixtures remained RED. The list-race
fixture gated `IDBTransaction.prototype.oncomplete`, but the gate was installed
after the relevant `get` and `readMetadataRecord` assigned
`IDBRequest.prototype.onsuccess`; consequently `__listRaceEntered` was never
reached. The fixture now marks the next `denied-note:` request in
`IDBObjectStore.prototype.get` and wraps the following native request
`onsuccess`, restoring both descriptors in `finally`.

The stale-receipt fixture also used a hard-coded epoch/generation and omitted
the required third `clearNoteDenial` argument. It now captures note authority
after denial, fails if the epoch is null, builds the old event from that
authority, clears with its generation, and verifies the old event is false
after the `denied: false` marker.

This worker changed only the browser fixture and this validation record.
Candidate typecheck/lint and browser execution were not rerun here.

## Remaining mounted RED corrections

The Home metadata projection now applies the cached root folder and denied root
state instead of returning early for the root route. The mounted browser
fixtures also use a mutable 403 response for the current folder, capture a
fresh current-folder read generation after the unrelated denial, and rewrite
the route-switch case as settled A-then-B navigation followed by a late A
receipt. These changes were not executable in this checkout because the
candidate browser dependencies are not installed.

```text
git diff --check: PASS
Biome/typecheck: not executed (candidate dependencies unavailable)
mounted browser validation: not executed (candidate dependencies unavailable)
```

## Parent live verification record

The parent verification was run against the adopted live tree and passed:

```text
live/candidate4 comment-stripped manifest: cd0f9cf... (offline-cache.ts)
live/candidate4 home-metadata manifest: 9ee950... (home-metadata-reader.ts)
live/candidate4 Home manifest: bc67c... (HomePage.tsx; already committed)
live/candidate4 Cached manifest: 41350... (CachedDriveView.tsx)
live app + service worker typecheck: PASS
Biome live4 + mounted spec/docs: PASS
browser mounted-folder-denial/folder-denial-http/home-folder-denial/
  mydrive-prefetch-denial/note-denial-events/mounted-note-denial: 38/38 PASS
Web unit tests: 117/117 PASS
git diff --check: PASS
```

These results validate the listed live workflows and adopted source hashes;
they do not claim that every offline workflow is complete.
