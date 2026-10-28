---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-state': patch
---

Show the balance split of an account over the explorer's UTXO limit as unknown instead of a measured 0 (#341). `QbitBalanceSummary.availableBalance` is now `number | null`, and `immatureBalance` and `pendingBalance` may also be `null`, which means the value could not be measured. When the explorer will not list an address's outputs, `getQbitSpendableBalanceV2` now reports `availableBalance`, `immatureBalance` and `pendingBalance` as `null` instead of 0. It still takes `totalBalance` from the address statistics and keeps `unavailableBalance` equal to it. When `availableBalance` is `null`, `useBalanceCardLogic` returns `null` for `availableBalance` and `unavailableBalance` and `--` for `availableAmount` and `unavailableAmount`, with the new `balanceSplitUnknown` and `balanceSplitUnknownText` (`utxo_limit_exceeded_balance_detail`), which the balance card shows in its expanded rows. When `useTxCreateScreenLogic` falls back to an unknown balance figure, it shows Available as `--`, Max fills nothing, and Next stays disabled without an error. A measured 0 still shows as 0.
