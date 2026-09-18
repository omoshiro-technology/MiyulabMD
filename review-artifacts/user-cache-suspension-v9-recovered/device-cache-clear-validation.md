# Device private-cache clear validation (candidate)

The browser test plan is `manual-cache-clear.spec.ts` and
`manual-cache-clear-tabs.spec.ts`. It must use real IndexedDB, OPFS, Web Locks,
native `createWritable`/`close` gates, and a Cache Storage shell assertion.
The required cases are: complete multi-user deletion with viewer-id and shell
retained; fresh writes after success; stale scope/handle rejection; disabled
BroadcastChannel and held transport; unknown-user writes draining; held image
acquisition; OPFS failure with retry; IndexedDB failure before OPFS deletion;
lock-order progress; and abort with no implicit retry.

The lock-order audit is: `global` shared, then `user:<encoded user>` shared or
exclusive for every user-scoped IDB/OPFS operation (including handle methods,
authority wrappers, open, orphan collection, and user clear). `persist` takes
that pair only for its short authority capture; its deliberately gated metadata
write runs after both Web Locks are released. The write performs an immediate
scope/lifetime admission check and its readwrite transaction fences on the
captured composed epoch plus active `device-clear-state`, so a clear can make
progress without allowing a stale identity to commit.
`readCachedViewerId` takes only global shared; device clear takes only global
exclusive. No path reacquires a lock already held. Epoch authority capture and
note/folder denial readers read and compare the composed
`composeEpoch(global,user)` from one readonly metadata transaction. Write
transactions also read and validate `device-clear-state` in the transaction;
malformed and purging metadata remains fail-closed.

This change was implemented without the browser dependencies available in this
environment, so the browser matrix and candidate typecheck remain unexecuted.
UI, prefetch, editor, and live `apps/web/src/**` integration are intentionally
out of scope.
