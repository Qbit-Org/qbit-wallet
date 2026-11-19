---
'@qbit/wallet-core': patch
---

`eccManager` uses only tiny-secp256k1, and the package no longer depends on `@bitcoinerlab/secp256k1`. That pure-JS curve was chosen only when a React Native platform was detected, which never happens in the extension, yet it was loaded and an ECPair built on it at every start. `eccManager.eccType`, `eccManager.setEccType()` and the `EccType` enum are removed; `eccManager.ecc`, `eccManager.eccPair` and the ECC library set for bitcoinjs-lib are unchanged.
