# Storage retention hints

The coordinator requests browser persistence once per page lifetime after
authenticated cache eligibility is established. Repeated coordinator attachment
does not repeatedly prompt. Denial, unavailable APIs, synchronous throws and
rejections are nonfatal. Neither the request nor an unanswered browser prompt
blocks foreground display or background acquisition.

Storage estimates are origin-wide approximate bytes, not a user budget. The
latest valid estimate is exposed as a defensive snapshot for the cache settings
explanation; negative/nonfinite/missing values are unknown. Available bytes are
clamped at zero. A full estimate never gates writes: actual storage failures
remain authoritative. No estimate is persisted as cache metadata.

This slice prepares retention/estimate integration. It does not implement safe
orphan collection, quota recovery, or the cache-management settings UI.

Validation with the candidate overlay:

- Initial public coordinator test RED: persistence and estimate call counts
  were both zero.
- First implementation GREEN: acquisition proceeds while persistence never
  settles, even with a full-storage estimate.
- `browser offline-storage-retention.spec.ts identity-lifecycle.spec.ts --workers=1`
  — **12 passed** (5 retention, 7 identity). Candidate typecheck passed.
- Added coverage: unsupported/rejected/denied storage, single retention request,
  advisory estimate normalization and defensive snapshot.
- Initial Biome failures were unnecessary return and import formatting;
  corrected using literal patches.
- Final parent run including `mydrive-prefetch-triggers.spec.ts`: **15 passed**;
  targeted Biome on the four changed source/spec files and diffcheck passed.

No live source adoption or full C9/C10 completion is claimed.
