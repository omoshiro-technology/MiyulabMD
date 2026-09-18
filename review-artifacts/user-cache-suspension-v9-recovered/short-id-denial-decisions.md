# D111: current short-ID denial identity

Candidate only, layered on short lookup `41ecf364fcc5e0af41f79c64b4f4fa9e8161f3c9d30b45d6a5af131119575d38`.

## Rule

One user's canonical ID and current short ID form one denial identity when
actual cached metadata or a successful Note establishes the pair. The shared
I/O-free note-access-order ledger owns both names' generations; there is no
second counter or request/subscriber coordination system.

Joining takes the maximum generation. A successful write must retain its
original token, not replace it with that maximum. A stale successful Note can
fence its canonical name but cannot replace the current pair. Changing the
short ID detaches the old name; user clear drops pair bindings while retaining
the existing unknown-ID clear-generation fence.

## Storage boundary

Denial discovers identity from the current body metadata, falling back to the
user's cached list when no body remains. Both denial markers are written in
one terminal metadata transaction before canonical physical cleanup starts.
Discovery/marker failure suspends that user's cache, including transaction
abort. Cleanup failure leaves durable denial authoritative.

Fresh successful revalidation establishes its current pair in putNote and
clearNoteDenial clears only that pair, checking the original token for each
name. Historical short names are not swept. Existing pending OPFS write drain,
user separation, and transaction-terminal mechanics are unchanged.

## Scope

No live adoption, API changes, UI changes, shared note-request subscriber
changes, read-session changes, article aliases, or existing-test/runner edits.
Cross-tab persistent generation fencing remains NEXT scope. The new ledger
tests are run explicitly rather than included in the flat candidate overlay.
