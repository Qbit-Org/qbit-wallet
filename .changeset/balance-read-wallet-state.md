---
'@qbit/wallet-state': major
---

Show the balance total while the wallet has not finished reading an account's outputs, and poll the balance politely (#36, #124).

- `setBalanceV2` stores `utxoReadIncomplete`, and `useBalanceCardLogic` returns `utxoReadIncomplete`, `utxoReadIncompleteText` (`balance_outputs_incomplete`) and `utxoReadIncompleteDetailText` (`balance_outputs_incomplete_detail`): the card shows the total with a note, Available and Unavailable as `--`, and the load error only when the read itself failed.
- The card's poll never runs a tick beside one of its reads that is still in flight, unless that read has been in flight for 60 seconds (one that falls due meanwhile runs 2 seconds after the reads settle, so the several reads an account with thousands of outputs needs follow each other closely), pauses while the page is hidden and reads when it is shown again once a read is due, and waits 10, 20, 40 seconds and so on, at most 2 minutes, after each failed read ends (a rejection, an answer whose read of the outputs got no further, `utxoReadFailed`, or a read given up on after 60 seconds, counted from the give-up) until one succeeds. An answer that ran out of time part of the way through the outputs keeps the normal pace; one that kept nothing new carries `utxoReadFailed` and backs off. Try again still reads at once. A change of account or network starts a new cadence.
- `useFetchBalanceCallback` resolves with the balance it read (undefined without an account).
- `useFetchBalanceCallback` no longer calls `getAddressSummary` before the balance: nothing read its answer, and its failure failed the balance. `getAddressSummary` is removed from the `WalletController` proxy type.
