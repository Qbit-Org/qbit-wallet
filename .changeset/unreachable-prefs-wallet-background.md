---
'@qbit/wallet-background': patch
---

Remove `WalletController` methods that no wallet page may call (none is on the UI-port allowlist) and nothing calls inside the background: `getCurrency`, `setCurrency`, `getShowSafeNotice`, `setShowSafeNotice`, `getAcceptLowFeeMode`, `setAcceptLowFeeMode`, `getGuideReaded`, `setGuideReaded`, the rate-us methods, `getHighlightWalletList`, `updateHighlightWalletList`, `getEditingKeyring`, `setEditingKeyring`, `getEditingAccount`, `setEditingAccount`, `expireUICachedData`, `listContact`, `setNetworkType`, `getNetworkName`, `getAddressUtxo`, `getAccountsCount`, `getKeyringByType`, `getOpenInSidePanel`, `reportErrors`, `getBackgroundInited`, `getPreMnemonics`, `removePreMnemonics` and `getDesc`. Adding or restoring a wallet no longer writes the unread `showSafeNotice` preference.
