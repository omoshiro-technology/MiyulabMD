# C2 client identity boundary — bounded candidate checkpoint

## Contract

- `apiFetch(input, init?, { viewerId }?)` and `requestJson(input, init?, { viewerId }?)` capture `viewerId` before network I/O. `undefined` means the caller supplied no expectation; `null` explicitly expects `guest`; a string expects `user:<id>`.
- The protocol header is `SESSION_USER_HEADER = "X-MiyulabMD-Session-User"` (exported from candidate `api-fetch.ts`). It describes the server session actor, **not the note owner**.
- Expected requests require a present, well-formed, exactly matching header on **every status**, including 200, 403, and 503. Empty user IDs, whitespace and comma-joined identities are not valid protocol values.
- A failed check cancels the response body before rejecting with `ApiIdentityError`. Disposal is best effort and does not await an arbitrary stream cancellation promise. Body cleanup failures cannot authorize a response or replace the identity error.
- `ApiIdentityError` extends `Error`, not `ApiHttpError`, `TypeError`, or `ApiCommunicationError`. Its public fields are the real HTTP `status` and captured `expectedViewerId: string | null`; a 200 mismatch remains status 200. There is no fabricated 401 and no communication fallback/retry.
- `ApiIdentityError` is exported by `api-fetch.ts`, re-exported by `api-transport.ts` and `api.ts`.
- `subscribeApiIdentityChange(listener: (error: ApiIdentityError) => void): () => void` is exported by `api-fetch.ts`. It synchronously notifies a snapshot of listeners only after a failed identity check; unsubscribe removes the listener; one throwing listener cannot replace the rejection or prevent other listeners. This is a re-verification hint, **never authority to authenticate a user**. No actual header identity is exposed.
- Effective cancellation is checked before sending and after receiving. An explicit `init.signal`, including `null`, overrides `Request.signal`; `undefined` retains the Request signal. Abort reasons retain object identity. Already-aborted responses are disposed and do not emit an identity event. JSON transport also checks cancellation after body consumption.

## Bounded integration

- Public `fetchNote` and nested `note-request.ts` accept `viewerId?: string | null`, forwarding it into the canonical transport. Existing authenticated request sharing/generation rules are unchanged. Guest and unspecified requests do not share the authenticated in-flight map.
- `fetchNotes`, `fetchFolderTree`, `fetchPublicFolders`, `fetchSharedFolders`, and `fetchFolder` accept the same optional viewer expectation alongside `signal`.
- Home's metadata reader forwards its copied viewer's ID, or explicit `null` for guest, to its network calls.
- MyDrive acquisition forwards its already-captured user ID to tree/folder/list calls. Its existing note call already carries that ID. Identity errors stop the cycle as `auth`, including when the real HTTP status is 503; they are not retried and cannot save the rejected result.
- No cache core, image helper, note-read-session, AppShell, UI, logout, or user-clear orchestration changes are included.

## Test-first evidence

`apps/web/tests/browser/session-identity-client.spec.ts` exercises public note/transport/Home/prefetch interfaces:

1. Bob's response for an Alice-owned shared note initially published (RED), then rejected/disposed (GREEN).
2. Home initially published Bob's metadata and prefetch classified it as network failure (RED); viewer forwarding and auth-stop classification made this GREEN.
3. Guest mismatch, missing/malformed headers, exact real HTTP statuses, matching guest, and explicit unchecked caller behavior.
4. Request/init/null signal precedence, exact cancellation reason, disposal, and mutation of caller options during I/O.
5. Authenticated note-read-session neither overwrites Alice's cached body nor publishes a communication fallback for Bob's response.
6. Prefetch changes identity independently at folder, note-list, and note-body boundaries, including HTTP 503: one attempt, auth-stop, no rejected-data save.
7. Identity subscription initially absent (RED); subscribe/unsubscribe, listener isolation and abort suppression pass (GREEN).

Validation:

```sh
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered browser session-identity-client.spec.ts home-metadata.spec.ts mydrive-prefetch.spec.ts mydrive-prefetch-metadata-retry.spec.ts note-request-sharing.spec.ts note-request-subscribers.spec.ts
node apps/web/scripts/check-offline-candidate.mjs review-artifacts/user-cache-suspension-v9-recovered typecheck
```

- Final selected browser run: **28 passed**, including 9 new identity tests.
- Candidate typecheck passed; Biome checks passed for all six edited candidate modules and all six selected specs.
- Frozen lockfile dependency installation and worktree-local Chromium were used. No stage/commit or live frontend edit.
- One intermediate run had a transient Vite dynamic-import failure before the subscribers test entered its assertions; subsequent complete selected runs passed.

## Fixture migration and merge follow-up

Explicit **server actor** headers were added to affected responses in `home-metadata`, `mydrive-prefetch`, `mydrive-prefetch-metadata-retry`, `note-request-sharing`, and `note-request-subscribers` specs. Bob's subscriber response explicitly uses `user:bob` despite an Alice-owned note. No owner-derived actor, requested-viewer echo, global Response shim, or missing-header production bypass was added.

This is **not a full-suite green claim**. Before fixture repair, the metadata-retry suite demonstrably stopped early on missing server headers (two failures in a `--max-failures=2` run); after explicit actor headers, all four retry cases passed. Other old suites still contain unchecked fakes and were intentionally not bulk-rewritten in this checkpoint. Follow up particularly on the remaining `mydrive-prefetch-*` suites, `note-read-session`, `note-read-publication`, `note-read-denial`, and UI/offline fixtures whose authenticated note/Home paths now supply an expectation. Audit the actual simulated server actor for each response before adding a header.

Image-worker new specs and helper remain untouched: after merge, its canonical call needs `apiFetch(input, init, { viewerId: scope.userId })`, plus explicit actor headers in its own mocks. C1/parent must integrate the narrow event with AppShell re-verification and user-switch cancellation. Existing unspecified callers (including guest paths not yet forwarding `null` from note-read-session) remain outside this bounded acquisition slice and need a later caller audit. No response header may be promoted into an authenticated user.
