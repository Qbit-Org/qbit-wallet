---
'@qbit/wallet-shared': minor
---

Add `utxoReadIncomplete` to `QbitBalanceSummary`: the address statistics were read, but the wallet could not finish reading the outputs the explorer lists, so `totalBalance` is measured and the split is unknown (`availableBalance`, `immatureBalance` and `pendingBalance` are `null`). It is never set together with `utxoLimitExceeded`. `utxoReadFailed`, set only with it, says the read of the outputs stopped on a failure rather than ran out of time (#36, #124).
