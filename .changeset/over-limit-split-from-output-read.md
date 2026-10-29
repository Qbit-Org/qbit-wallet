---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-state': major
---

Show the balance split of an account over the explorer's UTXO limit once the wallet has read its outputs, and show Unavailable as unknown on the send screen while that split is unknown.

`getAddressBalanceV2` now takes the split of an over-limit address from the latest output read for that address on that network (`getQbitUtxoSnapshot`, which the send screen runs), and only while the address statistics read as they did for that read: any new transaction for the address changes them. Available is what a send may select from that read, less the outputs the send guard reserves, never more than the total; Unavailable is the rest of the total, and `immatureBalance` and `pendingBalance` stay `null`. Without such a read, or when the reservations cannot be read within the balance read's bounded wait for the send guard, the split stays unknown (`availableBalance: null`); an over-limit address keeps `utxoLimitExceeded` either way. The wallet keeps only the latest completed read per address and network, in memory. For this `getQbitSpendableBalanceV2` takes an optional `readOutputs(stats)`, `QbitSharedReads.run` takes an optional slot, and `QbitSharedReads.latest` returns the latest completed answer for a slot with the key it ran under. The `QbitBalanceSummary.utxoLimitExceeded` documentation describes the split.

`useBalanceCardLogic` shows that split as the background reports it. `useTxCreateScreenLogic` now returns `--` for `unavailableAmount` whenever it shows Available as `--`, with `showUnavailable` true, instead of showing the whole balance as unavailable.

`createSendQbitPsbt` takes `qbitUtxoAddress`, the account the outputs were read for, and refuses the request when it is not the selected account; `usePrepareSendQBTCallback` always passes it. `createSendQbitPsbt` also refuses an output without a scriptPubKey, or with one other than the selected account's, instead of taking it for the account's own or leaving it out. Only this builder checks outputs this way: the send-all builder and the recovery migration still take an output without a scriptPubKey as the account's own.

Breaking change in `@qbit/wallet-state`: `WalletController.createSendQbitPsbt` requires `qbitUtxoAddress`, so code that calls it must supply it. In `@qbit/wallet-background` the parameter is optional and checked whenever it is given.
