---
'@qbit/wallet-background': patch
---

A balance read no longer waits behind a broadcast. `WalletController.getAddressBalanceV2` counts the outputs a send holds back as unavailable, and reads them from the send guard, whose queue a broadcast holds until the explorer answers it. The read now waits for the guard for at most one second (`qbitBalanceGuardWaitMs`) and then answers without the reservations: `availableBalance`, `immatureBalance` and `pendingBalance` are `null`, `unavailableBalance` is the measured total, and `utxoLimitExceeded` is not set, so the balance card shows the split as `--` until a later read has the reservations again. Recent spenders the guard hands out after the read stopped waiting are still looked up.
