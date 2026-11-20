---
'@qbit/wallet-state': patch
---

Remove the cold-wallet QR flow, which nothing could reach (#53). `useSignPsbtLogic` and `useSignMessageLogic` no longer have a cold-wallet signing step (`isColdWalletSigning`, `onColdWalletSigningSuccess`, `onColdWalletSigningBack`). The account of a cold wallet a stored vault holds has no P2MR script, so no signing request is made for it; should one reach these hooks, signing is refused as not supported. `WalletContext` drops `createKeyringWithColdWallet`, `deriveAccountsFromXpub` and `getNetworkType`, `useCreateColdWalletCallback` is removed, and `RouteParamList` loses `CreateColdWalletScreen` and `CreatePasswordScreen`'s `fromColdWallet`.
