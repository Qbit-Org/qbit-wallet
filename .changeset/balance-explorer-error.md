---
'@qbit/wallet-state': minor
---

Show an explorer outage on the balance card instead of a zero balance. `useFetchBalanceCallback` now records a failed refresh per address in the new `balanceStatusMap` (`setBalanceError`) and keeps the last known balance. It orders overlapping refreshes, so an older response cannot replace the outcome of a newer one. `useAccountBalanceStatus` reports whether the current account has a balance and whether its latest refresh failed. `useBalanceCardLogic` adds `balanceLoadFailed`, `balanceRefreshFailed`, `balanceErrorText`, `retryBalance` and `isRetryingBalance`, and its detail toggle does nothing until a balance loads. `AccountUpdater` no longer leaves an unhandled rejection when its balance fetch fails.
