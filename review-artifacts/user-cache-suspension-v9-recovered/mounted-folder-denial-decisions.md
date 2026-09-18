# Mounted folder denial projection

Folder denial remains durable authority in the existing IndexedDB metadata
transaction. This slice adds a typed folder receipt with route/root aliases,
epoch, and generation. A receipt is emitted only after the marker transaction
commits; failure emits an unknown-generation receipt and suspends the cache
instead of claiming cleanup succeeded.

Readers project authority at read time. `getFolder` removes only denied
children and detaches descendants below a denied crumb to the nearest visible
parent. `getNoteList` additionally removes summaries directly assigned to a
denied folder while retaining notes in independently visible descendants.
Mounted views subscribe to the receipt channel and reload only their current
projection.

## 51acba5 migration correction

`51acba50bd8109f5a3c00fb38a14cb26196c176e` was accidentally applied to live
and was reverted by `ae8075a`. Live remains the verification baseline and is
not edited by this candidate-only migration. The useful source changes are
carried here with the existing `4bfbf87` authority/projection implementation:
the denial signal is observed through transaction commit, stale owners do not
produce cleanup warnings, and Home/CachedDrive receipt handling re-reads
durable authority before reloading projections. Route relations are not
decided from a target alias alone; a receipt causes the active user's
projection to be re-read.
