---
'@qbit/wallet-shared': major
---

Remove the constants `GAS_LEVEL_TEXT`, `MINIMUM_GAS_LIMIT`, `WALLETCONNECT_STATUS_MAP` and `KEYRING_CLASS` from the package root. Nothing in this repository used them; code that imports them must define its own values.
