---
'@qbit/wallet-background': patch
---

Every lock and every reset now forgets the output reads the wallet keeps for the balance split of an address over the explorer's UTXO limit, not only a lock through `lockWallet`. `resetAllData` forgets them once the keyring reset ends, even when it fails, and `changeAddressType` forgets them when a change the keyring service cannot roll back leaves the wallet locked. The auto-lock timer already locked through `lockWallet`. While the wallet reads locked, `getAddressBalanceV2` takes no split from a kept read, so a reset, or a lock the keyring service makes on its own, serves no split while it waits, as a lock through `lockWallet` already did.
