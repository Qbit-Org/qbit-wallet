---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
---

Show relative locks in a website's PSBT approval. `decodePsbt` now returns `relativeLocks`: one `PsbtRelativeLock` for each input whose sequence sets a BIP68 relative lock on a transaction with version 2 or more, read as qbit Core reads them. A lock is in blocks, or in seconds of the network's median time (512-second units), after the coin the input spends is mined. A sequence with its disable bit set, or a lock of 0, sets none. The approval shows such locks in their own row, one line for each input. A finalized PSBT with one no longer says the site can broadcast it now, but once the coins it spends are old enough, and once its lock time has passed as well when it has one. The field is optional on `DecodedPsbt`, so code that builds one is unaffected, and it is for display only: the cold signer's request leaves it out, and nothing is signed, sized, finalized or broadcast differently.
