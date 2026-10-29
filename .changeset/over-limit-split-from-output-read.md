---
'@qbit/wallet-state': major
'@qbit/wallet-background': patch
---

Show the balance split of an account over the explorer's UTXO limit once the send screen has read its outputs, and show Unavailable as unknown on the send screen while that split is unknown.

`useTxCreateScreenLogic` now returns `--` for `unavailableAmount` whenever it shows Available as `--` (an account over the explorer's limit whose outputs are still being read from history, or a balance figure that is unknown), with `showUnavailable` true, instead of showing the whole balance as unavailable.

`useBalanceCardLogic` takes the split of an over-limit account from the outputs the send screen read for the same account on the same network: Available is what those outputs can spend, never more than the total, and Unavailable is the rest of the total. It uses a read only while no broadcast from this window (a send, fee bump or consolidation batch) has happened since the read started, and for at most two minutes after it landed (`BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS`); otherwise the split stays `--` with its note. The other unknown splits (no balance read yet, a failed read, a send holding the send guard) stay `--` as before. The transactions store records when each output read landed (`utxosReadAt`) and this window's broadcast count when it started (`utxosBroadcasts`), and counts this window's broadcasts (`broadcasts`) as each txid is published to `qbitTx`.

`createSendQbitPsbt` takes `qbitUtxoAddress`, the account the outputs were read for, and refuses the request when it is not the selected account; `usePrepareSendQBTCallback` always passes it. The builder also refuses an output without a scriptPubKey, or with one other than the selected account's, instead of taking it for the account's own or leaving it out.

Breaking change in `@qbit/wallet-state`: `WalletController.createSendQbitPsbt` requires `qbitUtxoAddress`, and `TransactionsState` has the new required fields `utxosReadAt`, `utxosBroadcasts` and `broadcasts`, so code that calls the former or builds the latter must supply them. In `@qbit/wallet-background` the parameter is optional and checked whenever it is given.
