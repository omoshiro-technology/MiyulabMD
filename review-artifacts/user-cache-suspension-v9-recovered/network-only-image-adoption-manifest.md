# Network-only image supplemental adoption manifest

This supplemental manifest records the checked preview-image slice after the
review fixes. The historical `composed-adoption-manifest.md` remains unchanged:
it is the D125/D126 record of what was composed at that time, and must not be
rewritten to retroactively claim these new files or later review fixes.

## Source mapping

| Candidate source | Live adoption target | Candidate SHA-256 | Live SHA-256 |
|---|---|---|---|
| `src/lib/attached-image-target.ts` | `apps/web/src/lib/attached-image-target.ts` (new) | `9bc74675400f13024da4cb2c1b72a0f6dc4a0d53df8dc6b25b80c56e2d538283` | `9bc74675400f13024da4cb2c1b72a0f6dc4a0d53df8dc6b25b80c56e2d538283` |
| `src/lib/network-attached-images.ts` | `apps/web/src/lib/network-attached-images.ts` (new) | `b37644637441650fa11d96ac5a130c12fe57c5fa78f024f4f807e500bbb7deb0` | `b37644637441650fa11d96ac5a130c12fe57c5fa78f024f4f807e500bbb7deb0` |
| `src/lib/attached-images.ts` | `apps/web/src/lib/attached-images.ts` (existing) | `faf09006ced38829248f6aa1bb31e8ca4805999bdfc41f89c5d252bd3c4a1d9e` | `faf09006ced38829248f6aa1bb31e8ca4805999bdfc41f89c5d252bd3c4a1d9e` |
| `src/lib/preview-images.ts` | `apps/web/src/lib/preview-images.ts` (existing) | `7b17915f0534d210169f61ac7bcb20e0f0c4ff6718b443590acab282c82a3ad6` | `7b17915f0534d210169f61ac7bcb20e0f0c4ff6718b443590acab282c82a3ad6` |

## Tests and validation

Browser tests and validation records are separate from the source mapping:

- `apps/web/tests/browser/network-only-preview-image.spec.ts`
- `apps/web/tests/browser/offline-image-lifetime.spec.ts`
- `network-only-image-decisions.md`
- `network-only-image-validation.md`
