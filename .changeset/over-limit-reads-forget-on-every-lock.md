---
'@qbit/wallet-background': patch
---

Every lock and every reset now forgets the output reads the wallet keeps for the balance split of an address over the explorer's UTXO limit, not only a lock through `lockWallet`. `resetAllData` forgets them before the keyring reset writes and again once it ends, even when it fails, and `changeAddressType` forgets them when a change the keyring service cannot roll back leaves the wallet locked. The auto-lock timer already locked through `lockWallet`. While the wallet reads locked, `getAddressBalanceV2` takes no split from a kept read, so a lock the keyring service makes on its own serves no split while it waits, as a lock through `lockWallet` already did. The keyring reset marks the wallet locked only after its writes, so while they run only a read that completes during them can give a split.

When an address-type change fails and the keyring service locks the wallet because it cannot roll the change back, `changeAddressType` now tells the pages and the wallet's UI that the wallet locked, with the same notifications `lockWallet` sends, before it passes the error on. Until now they kept treating the wallet as unlocked.
