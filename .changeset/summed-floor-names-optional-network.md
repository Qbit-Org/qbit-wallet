---
'@qbit/wallet-background': patch
---

A restore floor summed across Testnet4 and regtest that reaches the 2^28-signature warning threshold is still refused, and the refusal now says what to do. It names the optional network whose count took the sum there (the local Regtest service on a Testnet4 restore, the Testnet4 explorer on a Regtest one) and whether that count came from address statistics or transaction history. On a Testnet4 restore it says to stop the local Regtest service, or turn off Local Regtest, then retry. The message uses the background translation keys `qbit_restore_summed_floor_{regtest,testnet4}_{stats,history}`, with the derivation index, that network's count and the threshold. The optional network stays in the scan while it answers, so later accounts, gap probes and keyrings still count its signatures.
