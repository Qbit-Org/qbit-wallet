---
'@qbit/wallet-shared': patch
---

Add the rules a transaction's input sequences set, for showing a website's PSBT in its approval. `psbtRelativeLocks(version, inputs)` returns the BIP68 relative lock each input sets, in input order: a number of confirmations the coin it spends needs, or an age in seconds of median block time (512-second units). Nodes enforce these from version 2, read as qbit Core reads it, as an unsigned number. A sequence with its disable bit set, a lock of 0, or an unknown sequence sets none. `isPsbtLocktimeEnforced(locktime, inputs)` says whether nLockTime holds the transaction back, which it does unless it is 0 or every input's sequence is `SEQUENCE_FINAL`. The approval reads both from the version and the input sequences that `decodePsbt` already returns, so `DecodedPsbt` is unchanged, and nothing is signed, sized, finalized or broadcast differently.
