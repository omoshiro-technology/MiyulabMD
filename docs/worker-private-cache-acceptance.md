# Real Worker private-cache acceptance

These specs run through `node apps/web/scripts/test-worker.mjs`, using built
production assets and actual local Workers, authenticated cookies, D1, R2,
Durable Objects, IndexedDB, OPFS and the installed Service Worker. No application
test API or synthetic saved/identity event is used.

## Image persistence

`apps/web/tests/worker/worker-image-cache.spec.ts`:

1. Log in through the real login flow.
2. Create a private parent note and upload a PNG through its actual image API.
3. Create another private note referencing that attachment.
4. Disable browser HTTP caching; observe a native image metadata transaction
   commit without modifying the write.
5. Reload offline through the production shell and verify body plus decoded
   image, readonly controls, and no new note/image API or WebSocket requests.

Baseline command:
`node apps/web/scripts/test-worker.mjs --grep 'real private attachment'`

Actual pre-adoption **RED**: online image retained its network
`/api/notes/<parent>/images/<image>` source instead of the required view-owned
`blob:` URL. The body and real upload succeeded. Runtime cleanup completed.

## Explicit logout and peer cache removal

`apps/web/tests/worker/worker-logout-cache.spec.ts`:

1. Real login and private-note creation; display the note in two tabs.
2. Verify that native IDB records, OPFS user subtree, and shell cache exist.
3. Use the real account menu logout action.
4. Verify guest server session, removal of the peer's private body, absence of
   the user's IDB data and OPFS subtree, and preservation of shell Cache Storage.
5. Reload the peer offline and verify that private content cannot reappear.

The initial fixture attempt waited for Service Worker control before allowing
the next navigation. Since the production worker deliberately does not claim
existing clients, that setup failed. The fixture now waits for activation
before navigating to the note, matching the established offline acceptance.

Baseline command:
`node apps/web/scripts/test-worker.mjs --grep 'real logout removes'`

Actual pre-adoption **RED** after that setup correction: native server logout
returned its redirect, but the peer still displayed `Private logout body.`
(one element instead of zero). Runtime cleanup completed.

Both baselines used unchanged live frontend source before the29-file candidate
adoption. Post-adoption GREEN and combined runtime results remain to be recorded.
These tests do not cover manual all-device clear, production Access edge
behavior, safe orphan GC, or every missed-message scenario.

## Post-adoption evidence

Both focused cases passed after live adoption and the Node/browser compatibility
follow-up: **2 passed**, including actual R2 image bytes and physical OPFS
subtree absence after logout.

The first combined Worker run had **10 passed / 1 failed**: the image case
observed one image request while transitioning from its still-running online
document to offline reload. Its original listener did not distinguish document
ownership. The test now records CDP loader IDs and asserts no note/image API
requests from the **reloaded offline document**; it does not conflate an old
document's in-flight acquisition with the new offline reader.

Final `node apps/web/scripts/test-worker.mjs`: **11 passed (42.8s)**.
The image case reported `{ offlineDocument: 0, previousDocument: 0 }` in that
run; the earlier unclassified request is retained as a failed observation, not
retroactively assigned a loader ID. Build/runtime cleanup completed.

Also verified on the live app:

- `pnpm --filter @miyulabmd/web typecheck` — app and SW passed.
- `pnpm --filter @miyulabmd/web test:browser --workers=1` — **198 passed**.
- `pnpm --filter @miyulabmd/web test` — **117 passed**.
- `pnpm --filter @miyulabmd/web test:pwa` — production build and **9 passed**.

These checks confirm the adopted slice, not the unfinished manual device-clear,
orphan-GC/quota, mounted-denial notification, or final requirements checklist.
