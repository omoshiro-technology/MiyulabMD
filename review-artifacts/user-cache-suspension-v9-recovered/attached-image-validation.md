# C8 first attached-image slice — validation and frozen handoff

Candidate-only. No stage, commit, live source adoption, Service Worker change,
API/Worker change, coordinator change, or validation-runner change was made.
`note-read-session` and `home-metadata-reader` retain the exact incoming hashes
recorded in `attached-image-decisions.md`.

## Final evidence

Commands run from the repository root:

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered typecheck
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered lint
pnpm exec biome check apps/web/tests/browser/offline-image-cache.spec.ts apps/web/tests/browser/offline-image-lifetime.spec.ts apps/web/tests/browser/offline-image-prefetch.spec.ts
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser offline-image-cache.spec.ts offline-image-view.spec.ts offline-image-lifetime.spec.ts offline-image-prefetch.spec.ts
git diff --check
```

- Candidate typecheck: passed.
- Candidate Biome: passed, 29 files, no fixes applied.
- New test Biome: passed, 3 files, no fixes applied.
- Final dedicated image browser run: **12 passed (9.6s)**.
- `git diff --check`: passed.

The 12 tests cover shared parsing/external skip and referenced parent identity;
independent users; expired read/write handles; metadata and actual OPFS subtree
purge; failed binary writes and aborted reference replacement preserving the
prior image; image 403/404 without body loss or stale-image fallback; independent
consumer cancellation with one shared request; body rendering before a held
image response; meaningful missing status; view-owned URLs revoked and removed
on purge; final prefetch image ordering/dedup; late response rejection after
purge; unsupported MIME; suspension; and the parent's real online PNG/offline
HTTP-cache-disabled reload test with naturalWidth 1.

## Wider runs and exact failures

1. Initial environment lacked Vite. Authorized frozen install succeeded:
   `pnpm install --frozen-lockfile` (855 reused, 0 downloaded).
2. First browser launch lacked local Chromium. Authorized repository-local
   `node apps/web/scripts/playwright.mjs install chromium` succeeded.
3. First storage/helper+view run: 6 passed, 1 failed due to a new test expecting
   literal metadata IDs rather than existing base64url IDs. Fixed the test
   expectation and its actual OPFS user-directory assertion; all now pass.
4. Intermediate read-only Biome failures were fixed with `apply_patch` only.
   Formatter suggestions were generated through stdin into temporary scratch
   files, not by writing candidate/live files through a formatter.
5. Wider image/startup/priority/epoch/tab/cleanup run: **28 passed, 1 failed**.
   The cleanup test `committed data survives late cancellation while disposed
   readers do not publish it` failed before application execution at
   `page.goto(storage.html)`, `net::ERR_NO_BUFFER_SPACE`. Focused rerun of the
   whole cleanup file plus the new prefetch tests: **6 passed**, including all
   three cleanup tests. Epoch-terminal and cross-tab cases passed in the wider run.
6. Wider image/share/prefetch-resilience run: **28 passed, 1 failed**.
   All image tests and all seven share tests passed. Existing resilience
   `abort-delay` expected body requests `["first","second"]` but observed an
   extra `"second"`. Focused rerun also failed, observing
   `["first","second","second","third"]`. Its test polls server-side requests
   and sends the abort from Playwright after another 50ms while the browser's
   retry timer is 500ms. Timing is a suspected cause, not proven by a baseline
   comparison. No images exist in that fixture, no image HTTP stage ran, and no
   retry/abort/coordinator code was changed. This remains an explicitly reported
   wider-regression failure for parent review, not a claimed green suite.

## Frozen C8 source hashes

Paths below are relative to this candidate directory:

| Path | SHA256 |
| --- | --- |
| `offline-cache.ts` | `4796393885dffc6b3d9eac4fbfebc6fdee23f8eadec2592d8f3545ca2dc676f4` |
| `src/lib/attached-images.ts` | `583eb0dc7e0317eea6d9b93aaab92154f0de9dff4e33cc2807b23001290ee9d0` |
| `src/lib/preview-images.ts` | `cac257111536e5de00926bdf8ac23f3f3b751ad1ed2d7468b9e81f27e2546470` |
| `src/lib/mydrive-prefetch.ts` | `f3f61ca2c99190f632b558b5e4bc3571b033c0f1084209529a6c9fe9729ae597` |
| `src/components/editor/MarkdownPreview.tsx` | `e14938cbdfc4341e7a8a7bd9a6090f95ebd0f35900e863357fb0676a56dea38e` |
| `src/components/editor/PreviewWithToc.tsx` | `1364090aff7980c52d8765aeadc16efd727ac361d656be71b7121b90f2a6f362` |
| `src/pages/EditorPage.tsx` | `09257b75c4b2d02b0ea2f67058b910fa38954667132b8bfa5754ba3fde121696` |
| `src/pages/SharePage.tsx` | `1e36ed98adc2d99968952ff6bafe6f52750916c9224e44d0c0c8d64adc631242` |

No schema increment was necessary. Existing v4 notes are retained by design.
Old replaced files await later GC; existing user purge removes them now.
Native global clear, persist UI, broader byte budgeting, production Worker/SW
acceptance, and the incoming C2 HTTP identity-header integration are not claimed
as completed by this slice.
