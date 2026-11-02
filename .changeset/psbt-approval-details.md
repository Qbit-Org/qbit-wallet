---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
---

Show more of what a website's PSBT does in its approval. `decodePsbt` now returns the transaction's `version` and `locktime` (nLockTime), and `outputOwners`: one `PsbtOutputOwner` for each output. An output paying the account signing the PSBT is `change` only when the wallet funds every input and the request does not name its address as the recipient, and `this_account` otherwise, since it may be the payment itself. An output paying another of the wallet's accounts is `other_account`, and any other output is `none`. An owner is recognised only from the scripts and addresses the wallet derives for its accounts, never from records the PSBT carries, such as derivation paths a website adds. The three fields are optional on `DecodedPsbt`, so code that builds one is unaffected. They are for display only: nothing is signed, sized, finalized or broadcast differently.
