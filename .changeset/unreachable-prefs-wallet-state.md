---
'@qbit/wallet-state': patch
---

Remove from the `WalletController` interface the methods the background no longer has, none of which a page called: `getCurrency`, `setCurrency`, `getShowSafeNotice`, `setShowSafeNotice`, `getAcceptLowFeeMode`, `setAcceptLowFeeMode`, `getGuideReaded`, `setGuideReaded`, the rate-us methods, `getEditingKeyring`, `setEditingKeyring`, `getEditingAccount`, `setEditingAccount`, `expireUICachedData`, `setNetworkType`, `getAccountsCount`, `getOpenInSidePanel`, `getPreMnemonics`, `removePreMnemonics` and `getDesc`.
