---
'@qbit/preference-service': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-state': patch
---

Keep the stored sign-data, auto-lock and replace-by-fee settings in line with what the wallet reports when a change of one of them fails to save. Before, the previous value put back after a failed save was saved once more and a failure of that save was only logged, so when another save of the preferences had written the rejected value in the meantime, that value stayed on disk: a failed attempt to turn sign-data requests on could still turn them on at the next start. `setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` now try to save the previous value up to three times, 100 and 200 ms apart, and stop early when a newer change of the same setting is waiting or the store has been reset, as that change decides what is stored. When the previous value still cannot be saved, they reject with a `WalletError` whose code is the new `ErrorCodes.PREFERENCE_NOT_RESTORED` instead of the error of the first save. The sign-data setting and the auto-lock time page (`useLockTimePageLogic`) then say that the change was not saved and that the stored setting may have changed (`setting_not_saved_may_have_changed`). The stored preference format does not change.
