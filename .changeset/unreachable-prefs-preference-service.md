---
'@qbit/preference-service': patch
---

Remove the settings of the wallet this one was forked from that nothing reads, with their accessors and `BasePreferenceStore` fields: `currency`, `showSafeNotice`, `acceptLowFeeMode`, `guideReaded`, `rateUsStatus` (and the `RateUsStatus` type), `walletSavedList`, `editingKeyringIndex`, `editingAccount`, `uiCachedData`, `addressSummary`, `watchAddressPreference` and `currentVersion`; also `hasOtherProvider`, the `currency:changed` event and the `MobilePreferenceStore` type. `init` drops those keys from a store an earlier release saved, as it already dropped `enableSignData`, and saves the store once without them; every other stored setting loads and is saved back as it was.
