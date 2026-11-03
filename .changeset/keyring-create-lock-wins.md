---
'@qbit/keyring-service': patch
---

A lock that completes while a keyring is created or imported now wins. `createKeyringWithMnemonics`, `importPrivateKey`, `importPublicKeyOnly`, `importWatchAddress` and `addDiscoveredQbitKeyring` no longer publish the unlocked state (or broadcast UNLOCKED) once a lock has cleared the password: the keyring is still saved, and the wallet stays locked until the next unlock.
