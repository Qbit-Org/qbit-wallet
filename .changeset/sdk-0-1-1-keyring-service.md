---
'@qbit/keyring-service': patch
---

Use `@qbit-oss/pqc` and `@qbit-oss/protocol` 0.1.1. Keys, addresses, signatures and PSBT bytes are unchanged: new derivation vectors, generated with 0.1.0 from public BIP39 test phrases with and without a passphrase on every network, pass unchanged. Signing now refuses a PSBT that qbit Core would refuse (no inputs or outputs, two inputs spending one output, an input spending the null outpoint, or a PSBT key with data after a type that must stand alone) before any signer call, so no signature counter is spent on it. A derived key's new `publicKey` and `secretKey` names are the same arrays as `pk32` and `sk64`, which the keyring zeroes after each use.
