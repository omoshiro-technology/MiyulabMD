# Private read caller audit

This candidate passes the captured session actor (`user:<id>` or explicit guest)
to history/revision, shared-folder, token, and article-source reads. `/api/me`
remains discovery-only; cached viewer IDs are never promoted to authorization.

The generic `apiFetch`/`requestJson` identity check is intentionally opt-in:
callers that do not yet have an explicit actor remain unchecked rather than
guessing ownership. Home metadata, MyDrive acquisition, and cache-core/hover
reads are deliberately outside this candidate because their owning workflows
are reserved by the slice.

Exact metadata request deduplication/coalescing (C5) remains next; this change
does not redesign request sharing. Network-only private reads should likewise
be skipped by cached/unavailable modes rather than authenticated with a cached
ID.
