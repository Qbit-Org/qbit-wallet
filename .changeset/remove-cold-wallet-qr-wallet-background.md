---
'@qbit/wallet-background': patch
---

`WalletController` drops `createKeyringWithColdWallet` and `deriveAccountsFromXpub`, which only refused (#53), and the UI port no longer lists them or `getNetworkType`, which only the removed cold-wallet QR screens called (the background still uses it). `ColdWalletKeyring` stays registered, so a vault that holds one still unlocks; its account still cannot sign.
