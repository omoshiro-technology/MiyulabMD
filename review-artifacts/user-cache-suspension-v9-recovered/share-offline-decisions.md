# C4 Share offline candidate

Use the existing viewer-owned note reader for canonical IDs and short IDs.
Article aliases are not supported by the generic note API and are not added.
Do not seed rendering from the global legacy note maps: those maps do not
carry the shell viewer's cache ownership or read provenance.

The page keeps an owned viewing scope for its display lifetime. Results are
tagged with the requested ID and viewer identity; render-time checks hide a
previous viewer's result before effects run. Disposal and scope publication
guards reject late reads. Unavailable viewer state issues no note request.

Cache snapshots display provenance and saved time and stay readonly through
the existing preview (no task binding or collaboration). Online guest login,
403, 404, title, and SSR-preview removal remain page responsibilities.
No reader interface changes, live adoption, or shell fallback changes.

## Discovered dependency

The focused real short-ID test exposes a missing core behavior: the existing
cache looks up only the exact canonical note key. The page deliberately does
not invent a second lookup policy, scan lists, or change seeded canonical IDs.
The parent owns user-scoped short-ID resolution and its denial guards.
Until that lands, canonical offline reads work, online short-ID reads work,
but the short-ID offline acceptance case remains RED.
