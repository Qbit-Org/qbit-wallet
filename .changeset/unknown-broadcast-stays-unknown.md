---
'@qbit/wallet-background': patch
'@qbit/wallet-state': patch
---

A broadcast whose outcome was unknown can no longer be reported as not sent by a later attempt for the same transaction, such as Retry on the recovery screen. Before, a node rejection of the later attempt followed by lookups that missed the transaction gave `not_sent`, forgot the inputs the first attempt had recorded as possibly spent, and let leaving the screen release them, although the first attempt may have reached another node behind the same endpoint. `WalletController.broadcastQbitTx` now treats that rejection as it treats a rejected re-send within one call: one lookup, and `unknown` unless the transaction is found. The recorded inputs stay reserved, and leaving the screen hands the claim back without releasing it. `QbitSendGuardService` adds `hasUnknownBroadcastOutcome`, which remembers the transactions a dispatched broadcast ended without a verdict for (at most `QBIT_UNKNOWN_BROADCAST_LIMIT`, in memory), and `forgetProvenAbsentBroadcast`, which forgets a proven-absent transaction's inputs only when no such outcome is on record, in the same step. `forgetAbsentBroadcast`, which forgot them without that check, is removed: use `forgetProvenAbsentBroadcast`. A website's own push keeps reporting the node's verdict on its bytes, as before.

In `@qbit/wallet-state`, `mergeQbitBroadcastRetry` never turns an `unknown` verdict into `not_sent`: a retry that went out and was rejected now keeps the screen on `unknown`, with the retry's reason and detail.
