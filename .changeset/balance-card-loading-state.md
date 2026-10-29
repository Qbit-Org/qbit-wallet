---
'@qbit/wallet-state': minor
---

Show the balance card as loading until the current account's first balance arrives. `balanceV2Map` is not persisted, so a freshly opened wallet read `useAccountBalance`'s zero placeholder and showed 0 QBT until the explorer answered. `useBalanceCardLogic` adds `balanceLoading`, true while the account has neither a balance for the current chain nor a failed fetch, returns `balanceValue` as `--` until a balance loads, and ignores the detail toggle while loading. A failed first load ends loading and shows the load error. `AccountUpdater` now fetches a newly selected account at once, even while the previous account's fetch is in flight, instead of leaving it to the balance card's 10-second poll.
