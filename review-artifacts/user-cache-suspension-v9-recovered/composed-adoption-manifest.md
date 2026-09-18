# Reviewed composed candidate adoption

This manifest authorizes the exact 29 source deltas below, not full offline
completion. Candidate source root is this directory. A flat path maps to
`apps/web/src/lib/<name>`; a `src/` path maps to `apps/web/<path>`.

Verify **full candidate** hashes before any change. Omit only the first comment
line of flat `offline-cache.ts` and `note-read-session.ts`. All other files must
match their candidate bytes exactly; do not rewrite UI, imports, or formatting.
Use literal `apply_patch` edits. Unlisted live files must remain unchanged.

| Candidate path | Full SHA-256 |
|---|---|
| `api-fetch.ts` | `73449b34594015df4ee98ad043f2d4e490f86b6de07dc2dea6289c58cb90ab6d` |
| `api-transport.ts` | `3f4ae80c3ba413cebfd59128b286f2d0668cb12f0d5d434707f2db523a7df95a` |
| `api.ts` | `2bca488b53d8164a594b4ca2610a19bef7ebe8dd6ed5cde1284785199fc76841` |
| `identity-lifecycle.ts` | `4a0e64045be9c42830042ef8d7a5b2fb92caf4655faca83f18324457a960578e` |
| `list-cache.ts` | `33f9bc0a9136878fa196dd661e382e40d5a496c5980fa6ab9b64c3037c198612` |
| `note-cache.ts` | `20a3562eb9faddbe17bb5d9b7c5b361e034f953489eab5374aa0492e5561c59b` |
| `note-read-session.ts` | `4a7e23699172b52d2d4966142eda00b6f472f6e8cfd3b16e16b22ce192290d1b` |
| `offline-cache.ts` | `4e1a3a5eb316618131ce2a8ced2bf541c7f3898f2e6eeb897b8675d15e883af9` |
| `src/components/editor/HistoryPanel.tsx` | `812bba68298b7b8152518face179cac864e6db944c5e528f5f283a294a5e524c` |
| `src/components/editor/MarkdownPreview.tsx` | `e14938cbdfc4341e7a8a7bd9a6090f95ebd0f35900e863357fb0676a56dea38e` |
| `src/components/editor/PreviewWithToc.tsx` | `1364090aff7980c52d8765aeadc16efd727ac361d656be71b7121b90f2a6f362` |
| `src/components/layout/AccountMenu.tsx` | `e64e8ce4d99dc0389546afe860255bb41bf4bb82421643bcb7df24d26bfd5313` |
| `src/components/layout/AppShell.tsx` | `d2c841ebd16dab8afb4e945204c00a89166ed1f625ef79b9856b52d9b1e059b4` |
| `src/lib/attached-images.ts` | `b8445c33ce2e3e60f4b828b9586dd2e4a3b2a268574f73546d74464e5e60298d` |
| `src/lib/home-metadata-reader.ts` | `3cffe751ef749711f68800e33b9531786279bb8dfc542944c2e5239cb0aa281a` |
| `src/lib/mydrive-prefetch-coordinator.ts` | `0d0b91420ca410af4fb3678a96e9161faedc5bd63b8f20650ad8d078810865d0` |
| `src/lib/mydrive-prefetch.ts` | `c6fc55f210ce7d214e070e2227ff11287209e18b9681c6c376cec7678c719dd1` |
| `src/lib/note-request.ts` | `bfbfe71bbbc09e782ee6ab8eb50f41dda9a80037e8942ac4e5c302031fc2be2c` |
| `src/lib/offline-storage-retention.ts` | `7ff5ca3854a0a82d561bdf30c44f2536a59fcb3027ed0ffc2475c28ac133aab2` |
| `src/lib/preview-images.ts` | `cca75004b7f4b7a570240dddb4b31c316c197f49ad861af752058ae40acbf549` |
| `src/pages/EditorPage.tsx` | `fabc54a53867d46740772f553166b2ff3ec382af65f7a2c8b4295fa082285c89` |
| `src/pages/HomePage.tsx` | `d253b4725932b2d4989823875ac304ad84cbdd6e4dc8a84cb95e4ab96414cb8d` |
| `src/pages/SharePage.tsx` | `1e36ed98adc2d99968952ff6bafe6f52750916c9224e44d0c0c8d64adc631242` |
| `src/pages/SharedPage.tsx` | `cb715c955918330e5fd61dea741e4ef1cbb96b7d7774959d4e7383469a085101` |
| `src/pages/editor-page.ts` | `709a3d7d4536f175aa4626d88ce1344296298bc6ff00035103bc8485fac418be` |
| `src/pages/settings/McpSettingsPage.tsx` | `60bbca3f0e5c41eeb831d1392f2a56f14c21bb11b73e26c9e4b760ef8313bfcb` |
| `src/pages/settings/SiteSettingsPage.tsx` | `bf51155a13f5d0e28b29d1eab6c075a092157de44b8b28cf767bcbba908ca2e5` |
| `src/pages/shared-by-me-page.ts` | `504b44ec11ff8e9ee149ef45f8564fafcdce786bc715e13453a78df2fa6c38b7` |
| `viewer-context.ts` | `64f8ee0523f2038baaa4ef148d6cfc45436e20f7bef8b40817e3d572327d7d5d` |

Expected live hashes for the two comment-line exceptions:

- `offline-cache.ts`: `ffd3d5d51d178e4e7bc4ab08d1676d8804b30c9ad88648f255eb955a4a64e170`
- `note-read-session.ts`: `e3a8ca0de0bcf5804d632f471044f90f25e5d1ca849ec762b56dbeeb7f39a7a4`

## Parent evidence

- Final candidate command:
  `node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered all --workers=1`
  — typecheck passed, source Biome **40 files**, **198 browser tests passed**.
- Earlier full runs: **188/193**, then **196/197**, then **197/197**; failures
  and their fixes were retained. Do not combine overlapping counts.
- Added no-message post-purge request-sharing repro after 197/197: RED was
  one HTTP request instead of two. Capturing purge epoch with the note denial
  sequence and including both in sharing identity made it GREEN; final198
  includes it.
- Web unit regression: **117 passed**.
- History UI: paging, preview, confirmation and real restore handler work.
  Revision failure was observed RED before adding rejection handling; revision,
  pagination and post-restore refresh failures now terminate visibly without
  unhandled promises. Existing UI/actions remain present.
- Babel AST comparison with React JSX-text normalization: Site settings'
  complete rendered subtree is unchanged. MCP differs only in the intentional
  authenticated-context visibility predicates; an incidental text-space change
  was corrected. The initial attempt to use the TypeScript7 native package's
  absent compiler AST API was not validation evidence.
- Read-only Luna review found no additional actionable authority race in its
  snapshot. Actual IDB/OPFS/browser tests, not that static report alone, are the
  adoption evidence.

Remaining: mounted note/folder denial notifications, manual device clear/UI,
safe orphan GC/quota handling, remaining list/hover integration, production
image/logout acceptance, and final all-requirements validation.

## D126 runtime compatibility follow-up

The adopter verified the exact29-file mapping above, but native Node strip-only
unit execution rejected `ApiIdentityError` parameter properties. Parent replaced
them with ordinary declared fields and constructor assignments, retaining class,
status, message and expected actor behavior. Browser lifecycle channels are now
created only in a window environment, not by Node's global BroadcastChannel.
The final result-copy subscriber fixture now supplies its publicly captured
authority before testing transport settlement, like the other subscriber cases.

Only these original source hash rows are superseded by this follow-up:

| Source | Current candidate SHA-256 | Current live SHA-256 |
|---|---|---|
| `api-fetch.ts` | `764989a56160c4cc81aa7e8e4db182d164da42f09edf37184c3ab3655a6db2a9` | `764989a56160c4cc81aa7e8e4db182d164da42f09edf37184c3ab3655a6db2a9` |
| `offline-cache.ts` | `619be66981f9a8cebea597422508825d3b9294de426ebe4fcdf340ce3b1ebdea` | `3b279bd4f6370f5ea95c8be8351f70512a85e73f97f8e08a64d32d42aa01ad99` |
| `identity-lifecycle.ts` | `6c16411ef99e6a670254bde76d02a184fcc70218f2f7a95a90621913fab30c28` | `6c16411ef99e6a670254bde76d02a184fcc70218f2f7a95a90621913fab30c28` |

Parent live verification: browser198, unit117, PWA9, app/SW typecheck passed.
Actual Worker suite11 passed, including the new image and logout cases; see
`docs/worker-private-cache-acceptance.md` for failed attempts and final evidence.
