---
'@qbit/keyring-service': patch
---

Remove `KeyringService` methods nothing calls: `getMemStore`, `getKeyringByType`, `unlockKeyrings`, `restoreKeyring` (`_restoreKeyring` stays), `getAllVisibleAccountsArray`, `getAllPubkeys`, `hasPubkey` and `clearKeyrings`.
