---
'@qbit/wallet-background': patch
'@qbit/wallet-core': patch
'@qbit/wallet-shared': patch
---

Name pay-to-anchor outputs in website PSBT approvals and bound their value (#88, #115). A website's `signPsbt` or `signPsbts` is refused before approval, and before any signature counter moves, when its pay-to-anchor (P2A, `51024e73`) outputs carry more than 330 sats together. Anchors within that bound get the `anchor` output role and raise no unrecognised-output risk, and the approval shows them as fee anchors; their value still counts as paid to others when the fee is judged. `decodePsbt` types an output with no address as `p2a` or `unknown_script`, so the approval names it by its script instead of showing an empty recipient; outputs with an address keep their shape.

`@qbit/wallet-core` adds `isPayToAnchorScript`. `@qbit/wallet-shared` adds `QBIT_P2A_MAX_VALUE`, the `anchor` member of `PsbtOutputRole`, and `DecodedPsbtScriptOutput`, the `p2a` and `unknown_script` members of `DecodedPsbtOutput`.
