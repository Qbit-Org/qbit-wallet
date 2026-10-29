---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-state': patch
---

Show the balance split of an account over the explorer's UTXO limit once the wallet has read its outputs, and show Unavailable as unknown on the send screen while that split is unknown.

`getAddressBalanceV2` now takes the split of an over-limit address from the latest output read from its history on that network (`getQbitUtxoSnapshot`, which the send screen runs), and only while the address statistics read as they did when that read's walk verified them: any new transaction for the address changes them. Available is what a send may select from that read, less the outputs the send guard reserves, never more than the total; Unavailable is the rest of the total, and `immatureBalance` and `pendingBalance` stay `null`. Without such a read, or when the reservations cannot be read within the balance read's bounded wait for the send guard, the split stays unknown (`availableBalance: null`); an over-limit address keeps `utxoLimitExceeded` either way. The wallet keeps only the latest read per address and network, in memory, from a read that completed; a read that started later replaces one that started earlier, even when it found less history, as after an eviction. The split uses the statistics the balance read's limit check fetched, without reading them again. For this `getQbitSpendableBalanceV2` takes an optional `readOutputs(stats)`, `readQbitAddressUtxos` returns the outputs with the statistics the walk verified (`QbitClassifiedUtxos.historyStats`), and `QbitLatestAnswers` keeps the latest answer per scope and slot. The `QbitBalanceSummary.utxoLimitExceeded` documentation describes the split.

`useBalanceCardLogic` shows that split as the background reports it. `useTxCreateScreenLogic` now returns `--` for `unavailableAmount` whenever it shows Available as `--`, with `showUnavailable` true, instead of showing the whole balance as unavailable.

`createSendQbitPsbt` and `createSendAllQbitPsbt` require `qbitUtxoAddress` with `qbitUtxos`, the account the outputs were read for, and refuse the request when it is missing or not the selected account; `usePrepareSendQBTCallback` always passes it. `createSendQbitPsbt` also refuses an output without a scriptPubKey, or with one other than the selected account's, instead of taking it for the account's own or leaving it out. Only this builder checks outputs this way: the send-all builder and the recovery migration still take an output without a scriptPubKey as the account's own. The send screen no longer counts an output without a scriptPubKey as spendable (`getQbitP2mrSpendableUtxos`), so Available and its preflight never include one.

In `@qbit/wallet-state`, `WalletController.createSendQbitPsbt` and `WalletController.createSendAllQbitPsbt` now require `qbitUtxoAddress`.
