---
'@qbit/wallet-background': patch
'@qbit/keyring-service': patch
'@qbit/wallet-shared': minor
'@qbit/wallet-state': patch
---

Let consolidation and recovery work for accounts the explorer cannot list (#343, #344). The consolidation walk (`continueQbitAddressOutputScan`) no longer stops at an empty page after a pending row. qbit-electrs answers a cursor that is the last pending row with an empty page instead of the confirmed rows after it, so an account with a whole page of pending transactions was told nothing was ready. The walk now steps back one row and reads on, and it ends only when that page holds the pending row alone. A page that does not start with that row throws `invalid_cursor`, and the walk starts over. `QbitAddressOutputScan` gains `beforeMempoolCursor` and `overlapTxid`.

`prepareQbitRecoveryMigration` no longer fails the whole pass for a source whose history is longer than the 10,000 transactions the wallet reads (`QbitUtxoHistoryTooLargeError`). It plans the other sources and returns that source in the new `deferredSources` (`QbitRecoveryDeferredSource`), and the migration screen names it. Its funds keep the migration open. `advanceQbitRecoveryMigration` neither archives past such a source nor fails on it, and a check of an archived wallet that finds one reopens its migration. `keyringService.preflightP2mrPsbtSigning` takes `allowMigrationConsolidation`, which `createQbitConsolidationPsbt` passes for an account whose history is past the read limit (`isQbitHistoryOverReadLimit`, read from the same statistics as `qbitAddressOutputCounts`). While a migration is open, the keyring then signs that consolidation, but only if the batch pays everything it spends back to the same script, less a fee within the wallet's highest fee rate, and every input is its own, and only while no plan of the source is open. It checks the last condition again at signing. Every other signing during a migration stays limited to reviewed plans and protected-asset transfers.
