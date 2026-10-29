---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-state': patch
---

Give each explorer-backed operation one deadline, so a slow or trickling connection no longer holds the wallet for about 15 minutes. Every explorer read an operation makes shares its deadline, and the reads still running when it passes are aborted. A broadcast, with its fee bump check, its submissions and its lookups, has 120 seconds (`QBIT_BROADCAST_DEADLINE_MS`); a lookup the deadline cuts short leaves the outcome `unknown` and the inputs reserved, and a pass not yet sent by then sends nothing. Check status has 30 seconds (`QBIT_BROADCAST_STATUS_CHECK_DEADLINE_MS`), the Speed up assessment 120 seconds (`QBIT_FEE_BUMP_ASSESSMENT_DEADLINE_MS`) and a consolidation batch's Prepare 180 seconds (`QBIT_CONSOLIDATION_BATCH_DEADLINE_MS`). A lifecycle lookup reads the whole transaction only to see that the explorer still has it, within 15 seconds (`QBIT_LIFECYCLE_TX_READ_DEADLINE_MS`); past that it is unknown. A history page or transaction read now has its 5-minute ceiling for all its attempts together, so an attempt cut off there while bytes were still arriving is not tried again.

Speed up no longer reads the original transaction's raw bytes when the replacement is broadcast. The assessment counts the original's outputs from the bytes it verified before the user signs (`QbitFeeBumpDetails.originalOutputCount`), the wallet's send claim carries that count in memory (`QbitSendBroadcastClaim.replacedOutputCount`), and the broadcast only asks the explorer what spends those outputs, within 15 seconds (`QBIT_FEE_BUMP_RECHECK_WAIT_MS`, 10 before), aborting the read when it gives up. A fee bump's claim without the count is refused before signing, restoring or broadcasting.

The send screen's read of an account past the explorer's output limit now stops once nothing waits for it. `getQbitUtxoSnapshot(readId)` can be abandoned with the new `abandonQbitUtxoSnapshot(readId)`, which the send screen calls when it is left, and a page whose UI port disconnects abandons its reads. A read for the same account and network whose address statistics have moved replaces the running walk, which stops; the callers that waited for it receive the newer answer.

In `@qbit/wallet-state`, `useFetchUtxosCallback` passes its caller's abort through to the background, and `WalletController` declares `abandonQbitUtxoSnapshot` and the optional `readId`.
