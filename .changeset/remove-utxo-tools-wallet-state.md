---
'@qbit/wallet-state': patch
---

Remove `navToUtxoTools` from the navigation context and `disableUtxoTools` from the settings slice's `walletConfig`. The navigation call opened the website UTXO page for the home screen's UTXO tools button, which every release kept hidden and which has been removed.
