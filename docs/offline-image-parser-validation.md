# Offline image parser validation

## Change

`@miyulabmd/markdown` now exports `collectImageUrls(markdown)`. It parses the
frontmatter-stripped and embed-normalized Markdown through the package's
remark/GFM, raw-HTML, and sanitize configuration, then reads sanitized `img`
nodes before stringification. This keeps inline and reference images, decodes
HTML entities as `rehype-raw` does, excludes code/frontmatter/ordinary links,
and preserves stable first-seen deduplication. URLs are not restricted to
application paths; callers at the Web layer remain responsible for filtering.

The renderer continues to use the same rendering pipeline and output behavior.
Image collection intentionally omits highlighting and HTML stringification,
since neither affects image destinations.

## Validation

- Baseline commit hash: `e31f08cb26c73334d99d13f0b5a2db7e125af34e`.
- Frozen install: `pnpm install --frozen-lockfile` — passed.
- Package test suite (including image URL tests): `pnpm --filter
  @miyulabmd/markdown test` — passed, 21/21.
- Package typecheck: `pnpm --filter @miyulabmd/markdown typecheck` — passed.
- Relevant Biome check: `pnpm exec biome check
  packages/markdown/src/render.ts packages/markdown/src/index.ts
  docs/offline-image-parser-validation.md` — passed (2 source files checked;
  Markdown is not a Biome input).
- Diff whitespace check: `git diff --check` — passed.
- Web typecheck: `pnpm --filter @miyulabmd/web typecheck` — passed (application
  and service-worker configurations).
- No image-cache completeness claim is made; this validates parser extraction
  only.

