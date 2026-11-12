---
'@qbit/wallet-state': major
---

Add `setKeyringColor(keyring, color)` to the `WalletController` interface, and `keyringsActions.updateKeyringColor`, which sets the color of the wallet it is given in the current wallet and the wallet list (#177). The placeholder wallet before the first load has a palette key too. The restore flow's word step no longer suggests "HD Wallet #N" as `walletName`, which nothing read: the background names a wallet when it adds it. With that, the `WalletController` interface drops `getTotalKeyringCount`, which nothing else called. `RouteParamList` drops `CreateAccountScreen`, whose screen became a dialog over the account switcher (#177).
