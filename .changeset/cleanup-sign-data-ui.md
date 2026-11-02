---
'@qbit/wallet-background': major
'@qbit/preference-service': major
'@qbit/wallet-state': major
---

Remove the signData and deriveContextHash approval screens, the developer-mode setting that allowed signData requests, and the background methods behind them. No provider method opened either screen. Breaking change: `WalletController` no longer has `getEnableSignData`, `setEnableSignData` or `deriveContextHash`, and `UI_CONTROLLER_METHODS` no longer lists the first two, so `getUiControllerMethod` refuses them. `PreferenceService` no longer has `getEnableSignData` or `setEnableSignData`, and `BasePreferenceStore` no longer has `enableSignData`. A stored `enableSignData` value is dropped when the preferences load and is not saved again. In `@qbit/wallet-state`, the `WalletController` interface no longer declares `getEnableSignData` or `setEnableSignData`.
