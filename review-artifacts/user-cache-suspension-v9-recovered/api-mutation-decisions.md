# D38 API mutation dispatch decisions

## Scope

This candidate binds the existing `viewing-access.ts` gate at the `AppShell`
lifetime boundary and applies it to the web API transport. The live
`apps/web/src` tree is intentionally untouched.

## Chosen options

- `AppShell` creates one `createViewingAccess(() => viewerRef.current)` controller
  for its lifetime, exposes that same controller as `context.viewing`, and binds
  it from `useLayoutEffect`. The helper's tokenized cleanup is retained for
  React StrictMode.
- `api-fetch.ts` is the single dispatch rule: `GET`, `HEAD`, and `OPTIONS` use
  `globalThis.fetch` directly; every other method calls `runMutation` immediately
  around the native fetch invocation.
- `api-transport.ts` uses the same boundary for `requestJson`, preserving
  cancellation and communication-error behavior. `api.ts` routes all of its
  direct API fetches through `apiFetch`.
- The browser/global fetch function is never replaced. Existing request
  options, credentials, bodies, headers, signals, response parsing, and native
  errors remain owned by each API export.
- Authentication navigation, including `logout`, remains a normal explicit
  action; this slice adds no queue, storage write, editor inference, or global
  viewer cache.

## Deliberately not chosen

Per-export mutation flags would duplicate the method classification and could
miss a write. A global fetch monkey-patch would affect unrelated requests and
test interception. Recreating policy/controller state on render would make
ownership and StrictMode cleanup observable.
