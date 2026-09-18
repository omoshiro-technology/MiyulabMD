# Device private-cache clear adoption manifest

This manifest adopts the device-wide private-cache clear
(`clearOfflineCacheDevice`) from the canonical candidate into the live tree.
The design rationale lives in `device-cache-clear-decisions.md`; the required
browser test plan lives in `device-cache-clear-validation.md`.

Decision: adopt the candidate `offline-cache.ts` wholesale. The candidate is
the current live file plus the device-clear change set only — it already
contains the mounted-folder denial adoption (live hash before adoption matches
the `mounted-folder-adoption-manifest.md` expected live hash), so a byte copy
with the candidate-only banner stripped introduces no unrelated delta. No
other live source file is changed by this adoption; every caller keeps the
same exported names, and the composed epoch remains an opaque
`string | null` to callers.

Scope deliberately excluded: the settings/device-clear UI (C10), prefetch,
editor, and worker integration. The browser specs `manual-cache-clear.spec.ts`
and `manual-cache-clear-tabs.spec.ts` are the acceptance gate and are tracked
with the live test suite, not this manifest.

| Candidate path | Live path | Candidate SHA-256 | Adopted live SHA-256 |
|---|---|---|---|
| `offline-cache.ts` | `apps/web/src/lib/offline-cache.ts` | `90ac8fd47a612177e30bfde1c05e3db0da293fa5a41694ca4e80c99e4a773b09` | `1e038159ffcae78e1df126f702af5cb705590517f16d01592d07ad9adb4f425d` |

The flat `offline-cache.ts` candidate begins with one candidate-only comment:
`// Canonical candidate v9; see decisions.md for transaction-terminal rationale.`
That line is removed in the live file. The comment-stripped candidate hash is
`4499dcb2c6d47d17e4b8bf32505116336e1f0c46672c041815ea8e48aa270ad9`.

Before adoption, the live hash was
`cd0f9cfb9a9cd14ff1f910e00a2fa53c88530a71ef26c0fe91352c76b006df65`.
No unlisted live source is authorized by this manifest.

## Post-adoption deltas (browser-gate driven)

The adopted live file intentionally differs from the comment-stripped
candidate by four reviewed changes, each required by the committed browser
gates. Candidate validation ran without a browser, so these were caught only
after adoption:

1. `removeDeviceFiles` recreates the empty OPFS application root after the
   recursive removal. `manual-cache-clear.spec.ts` resolves
   `getDirectoryHandle("miyulabmd-offline-cache-v1")` without `create` after a
   clear; removal is still complete, only the empty root remains.
2. `openOfflineCache` no longer rejects a per-user suspended identity. The
   pre-adoption contract is that open resolves and every handle operation
   fails closed (`user-cache-suspension.spec.ts`). Open still rejects while a
   user clear or a device clear is in progress.
3. Shared lock paths (`userStorageLock` shared, `globalSharedStorageLock`)
   fall back to running the operation directly when `navigator.locks` is
   unavailable. Exclusive paths (GC, user clear, device clear) still reject.
   This restores the pre-adoption degraded mode where ordinary opens, reads,
   and writes never needed Web Locks (`mydrive-prefetch-tabs.spec.ts` keeps
   the online UI working). The durable composed-epoch and
   `device-clear-state` transaction fences remain the correctness guard;
   locks only order operations where the API exists.
4. `readScopeEpochs` resolves from the three requests' `onsuccess` handlers
   instead of `transaction.oncomplete`. `offline-epoch-terminal.spec.ts`
   holds the final authority read by intercepting the `user-epoch:` request
   handler; resolving from `oncomplete` would complete the read while its
   handler is still held, defeating the gate.

Two gate updates accompany the adoption rather than implementation changes:
`offline-cache-gc.spec.ts` and `offline-cache-tabs.spec.ts` poll for the
pending exclusive lock, whose name is now
`miyulabmd-offline-cache:user:<id>` after the `user:`/`global` split.

Known pre-existing failures (red before adoption, unrelated):
`offline-epoch-terminal.spec.ts` home-folder-denial and
`offline-folder-denial.spec.ts` stale-navigation cases.

## Live UI entry point

`ProfileSettingsPage` mounts a `この端末のキャッシュを削除` danger button that
opens `ConfirmDialog` and calls `clearOfflineCacheDevice`. The copy states the
scope: every account's offline notes, folders, lists, and images on this
device are removed, while server data and the app shell survive, and
in-flight cache work in other tabs is invalidated. Failure is retryable —
the dialog reports `削除を完了できませんでした。もう一度実行してください。`
and keeps the purging marker semantics from the core. The gate is
`settings-device-cache.spec.ts`, which seeds a cached note, confirms the
dialog, and observes the note is gone.

Placement choice: the control lives under アカウント → ユーザー設定 rather
than a new settings group, because it is a per-device privacy operation that
must work even when the account form cannot (the section renders outside the
login gate).
