# Mounted folder denial adoption manifest

This is the adoption manifest for the four reviewed mounted-folder files. The
candidate hashes below were measured immediately before adoption. The existing
D125 `composed-adoption-manifest.md` remains an historical record; these four
rows supersede its same-path historical hashes for the live adoption. Tests and
documentation are tracked separately from source adoption.

| Candidate path | Live path | Candidate SHA-256 | Expected adopted live SHA-256 |
|---|---|---|---|
| `offline-cache.ts` | `apps/web/src/lib/offline-cache.ts` | `2ea3121351de33a00cf77ed980a115449f957151794589a1b70ec75de0a0dc4d` | `cd0f9cfb9a9cd14ff1f910e00a2fa53c88530a71ef26c0fe91352c76b006df65` |
| `src/lib/home-metadata-reader.ts` | `apps/web/src/lib/home-metadata-reader.ts` | `9ee9504373f9bfd571807eb3c3028230aad8b40bc8926b6ca081c967b695c26d` | `9ee9504373f9bfd571807eb3c3028230aad8b40bc8926b6ca081c967b695c26d` |
| `src/pages/HomePage.tsx` | `apps/web/src/pages/HomePage.tsx` | `bc67c9b74c81f6130a7925f0b29656db8287fcccb3b9d94cd541ac64139af086` | `bc67c9b74c81f6130a7925f0b29656db8287fcccb3b9d94cd541ac64139af086` |
| `src/pages/CachedDriveView.tsx` | `apps/web/src/pages/CachedDriveView.tsx` | `41350b39fdd9f65c97f3c33421b58246fe5f0ee919a3a7a69ca03edf269c1d6e` | `41350b39fdd9f65c97f3c33421b58246fe5f0ee919a3a7a69ca03edf269c1d6e` |

The flat `offline-cache.ts` candidate begins with one candidate-only comment:
`// Canonical candidate v9; see decisions.md for transaction-terminal rationale.`
That line is removed in the live file; the second hash in its row is the
comment-stripped candidate hash. The other three files must be byte-identical.

Before adoption, the live hashes were `46838ca6e6fad7bae23dd86a77a4575563fd49cb3064f9000c65b210bfdf7368`,
`3cffe751ef749711f68800e33b9531786279bb8dfc542944c2e5239cb0aa281a`,
`d253b4725932b2d4989823875ac304ad84cbdd6e4dc8a84cb95e4ab96414cb8d`, and
`6de3791a57fd05b62ac3183bdadf3e5a6e196b7f254332e6e20f4f863ffe20ea`,
respectively. No unlisted live source is authorized by this manifest.
