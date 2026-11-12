---
'@qbit/wallet-shared': major
---

Add wallet colors, as palette keys, and the default wallet name (#177). `WALLET_COLOR_KEYS` lists the eight keys (`green`, `blue`, `orange`, `violet`, `teal`, `pink`, `gold`, `indigo`) and `WalletColorKey` is their type; the UI maps each key to a light-mode and a dark-mode color. `walletColorForSlot(index)` gives a wallet slot's key, wrapping around the palette, `isWalletColorKey(value)` accepts only a palette key, and `resolveWalletColor(stored, index)` gives the stored key, or the slot's when nothing or an unknown key is stored. `WalletKeyring` has a new required field, `color`, with the wallet's resolved key, so code that builds a `WalletKeyring` must set it. `defaultWalletName(position, otherNames)` gives "Wallet N", where N starts at the wallet's place among the wallets in use and goes up while another wallet is named "Wallet N", ignoring case and surrounding or repeated spaces.
