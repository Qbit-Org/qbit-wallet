---
'@qbit/wallet-shared': patch
---

Remove `disableUtxoTools` from `WalletConfig`. It only hid the home screen's UTXO tools button, which every release kept hidden and which has been removed. The field was never stored, so nothing needs migrating.
