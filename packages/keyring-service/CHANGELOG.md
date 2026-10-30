# @qbit/keyring-service

## 1.4.0

### Minor Changes

- 4091176: Let a restored wallet lift its signing gate when an address's history is too long to enumerate (#61). `observeQbitPqcSignatureActivity` used to throw for an address with more than 6,400 transactions, so the restore floor scan never completed and `PQC_FLOORS_PENDING` locked every signature for good. It now reads such an address's floor from its statistics, `chain_stats.spent_txo_count + mempool_stats.spent_txo_count`. That is the count the full history read must match before it accepts a floor. The statistics read applies only when the statistics themselves show a history the scan does not enumerate: past the transaction cap or, on an Esplora surface, more pending transactions than its mempool listing returns (50; mempool-qbit pages them). It continues the tip-and-statistics bracket the cap check opened, so a block that lands meanwhile holds the retry for the tip-advance settle floor, and it retries per address like the full read. A walk that hits the client's page or transaction ceiling (`pagination_limit`) while the statistics say the history fits still fails, because the two disagree. The default page budget now follows the transaction cap (257 pages for 6,400), enough for an Esplora walk to reach it. It fails closed on invalid statistics, on statistics that list more transactions than outputs they fund or spend, and on statistics that spend more outputs or value than the address was paid. Every other failure still fails the observation. Any unstable floor observation during which the chain tip advanced, or after which the tip cannot be read, now waits out the tip-advance settle floor before its retry, whatever the instability was: moved statistics, a count mismatch, or a shifted history page. `observeQbitPqcSpentOutpoints` still requires the full history.

  `@qbit/wallet-shared` adds `QbitRestoreFloorSource` (`'history' | 'address-stats'`) and `QbitRestoreFloorSourceRecord` (index, pubkey, source). The result now says which read set the floor (`QbitPqcSignatureActivity.floorSource`). `@qbit/keyring-service` passes an observer's `floorSource` through as `QbitPqcRestoreFloorScan.floorSources`, and `QbitRestoreFloorScanSummary.floorSources` carries them to the restore report. The restore report names the accounts read from statistics. No vault field changes.

### Patch Changes

- 4091176: Let consolidation and recovery work for accounts the explorer cannot list (#25, #58). The consolidation walk (`continueQbitAddressOutputScan`) no longer stops at an empty page after a pending row. qbit-electrs answers a cursor that is the last pending row with an empty page instead of the confirmed rows after it, so an account with a whole page of pending transactions was told nothing was ready. The walk now steps back one row and reads on, and it ends only when that page holds the pending row alone. A page that does not start with that row throws `invalid_cursor`, and the walk starts over. `QbitAddressOutputScan` gains `beforeMempoolCursor` and `overlapTxid`.

  `prepareQbitRecoveryMigration` no longer fails the whole pass for a source whose history is longer than the 10,000 transactions the wallet reads (`QbitUtxoHistoryTooLargeError`). It plans the other sources and returns that source in the new `deferredSources` (`QbitRecoveryDeferredSource`), and the migration screen names it. Its funds keep the migration open. `advanceQbitRecoveryMigration` neither archives past such a source nor fails on it, and a check of an archived wallet that finds one reopens its migration. `keyringService.preflightP2mrPsbtSigning` takes `allowMigrationConsolidation`, which `createQbitConsolidationPsbt` passes for an account whose history is past the read limit (`isQbitHistoryOverReadLimit`, read from the same statistics as `qbitAddressOutputCounts`). While a migration is open, the keyring then signs that consolidation, but only if the batch pays everything it spends back to the same script, less a fee within the wallet's highest fee rate, and every input is its own, and only while no plan of the source is open. It checks the last condition again at signing. Every other signing during a migration stays limited to reviewed plans and protected-asset transfers.

- 4091176: Refuse a PQC signature, counter change or keyring change that a lock and unlock cut off from the live keyrings. A signature resolved its keyring before it waited for the account's counter lock. If the wallet was locked and unlocked meanwhile, it reserved its counter on the old keyring, and `persistAllKeyrings` then wrote the keyrings the unlock had loaded, which lacked the reservation, under the new session's password. The signature was released anyway, and the next signature on that account reused its count. Every counter operation (`signPqcDigestWithCounter`, `signP2mrMessageWithCounter`, `signP2mrPsbtWithCounter`, their preflights, `reservePqcSignatureCounter`, `applyPqcSignatureCounterFloor`, `restorePqcSignatureCounterFloors`, `rearmQbitRestoreFloors` and `rearmQbitRestoreFloorsForKeyring`) now checks, under the counter lock, that its keyring is still live, and fails without signing when it is not. `persistAllKeyrings(changedKeyrings)` now requires the keyrings whose changes the write commits (`[]` for a write with no change) and fails, without writing, when any of them is no longer live once the write reaches the persistence queue, so a signature is released only after the vault holds its reservation. `addKeyring` and the create and import paths, `addNewAccount`, `removeAccount`, `changeAddressType`, `removeKeyring`, `syncQbitHdPath`, the receive-state and recovery-state mutations and the migration keyring pass the keyrings they change, as do their failure rollbacks, so they now fail instead of reporting success when a lock and unlock lost their change, and a rollback no longer rewrites a session it did not change. A signature whose reservation was saved before a lock now fails when its signature-cache write lands after the lock. These failures report `The keyring was locked, removed or replaced while this operation was in progress`. No vault field changes.
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-shared@2.0.0
  - @qbit/wallet-storage@0.3.0
  - @qbit/wallet-core@1.1.5

## 1.3.3

### Patch Changes

- 6f06a0b: Stop failed keyring mutations from rewinding persisted PQC signature counters (#263). When the vault write of `addKeyring`, `changeAddressType`, `syncQbitHdPath`, `setQbitReceiveIntent`, `markQbitReceiveIndexesIssued`, `recordQbitReceiveActivity` or `removeKeyring` failed, the rollback wrote back the vault captured before the mutation. A signature on another account that persisted its counter and signature cache in the meantime was then rewound, and a restart or a re-unlock before the next successful write reloaded the lower counter. Each of these mutations now undoes its own change on the live keyrings and re-persists them, so the vault keeps every counter advance. If that write fails too, the store keeps the newest vault a write built and the live keyrings stay authoritative for the next successful write. When `changeAddressType` cannot restore the HD path it still locks the wallet, but it first re-persists the vault with a copy of that keyring rebuilt from its state before the change. If the wallet locks while that copy is being built, the change now fails without changing anything. The rollbacks of these mutations, and of `addNewAccount` and `removeAccount`, no longer persist, change or lock a session that was locked and unlocked again while the failed write was in flight. `removeKeyring` now rejects an index with no keyring instead of corrupting the live keyring list.
- 6f06a0b: Choose Qbit send inputs by value and keep every transaction within the standard size (#275, #276). Sends now rank outputs by effective value (the value less the fee the 3,762 vB input adds at the chosen rate), skip outputs that cannot pay for themselves, and take the largest first. A send no longer spends every small output the explorer listed before one that covers the amount, and no longer reports `Insufficient balance.` when one output could pay. No transaction carries more than the 106 single-key inputs that fit qbit Core's 400,000 WU `MAX_STANDARD_TX_WEIGHT` (with no witness discount, the finalized size). An amount only more inputs could reach fails before any signature budget is preflighted and names the largest amount one transaction can send. Send-all spends the 106 largest outputs and reports the others in the new `ToSignData.leftBehindInputCount` and `leftBehindSats`. `@qbit/wallet-shared` adds `QBIT_MAX_STANDARD_TX_WEIGHT`, `isQbitStandardTxSize`, `qbitP2mrMaxStandardInputCount`, `qbitP2mrInputFee`, `sortQbitCoinsByValue` and the selectors `selectQbitP2mrSendCoins` and `selectQbitP2mrSendAllCoins`, which both the controller and the wallet-state previews (`estimateQbitP2mrSendPreflight`, `estimateQbitP2mrSendAllPreflight`) use, so a preview matches the transaction that is built. Confirmed outputs are still spent before the account's own unconfirmed change, so an earlier payment keeps no descendant and stays eligible for a fee bump: `getQbitAddressUtxos` marks that change with the new optional `UTXO.unconfirmed` / `UnspentOutput.unconfirmed`, and the selector ranks it after the confirmed outputs, by value alone only when that order cannot build a standard transaction. The send preview now also reports `exceedsStandardSize`, `maxInputCount` and `maxStandardAmount`, and the send-all preview `leftBehindInputCount` and `leftBehindSats`; the send screen explains both cases.

  Recovery sweeps plan one transaction per batch of at most 106 inputs, all paying the source's destination account. The inputs fill the fewest batches, spread so the batches are even in value as well as in size, and the inputs of a batch too small to pay a dust output join a batch with room or form full batches of their own. Preparation drops an unsigned plan that exceeds the standard size and plans its inputs again. `advanceQbitRecoveryMigration` drops a signed plan whose transaction is gone and whose rebroadcast fails when the node rejects it as `tx-size` or its bytes exceed the standard size, since the same bytes can never be accepted, so the next preparation plans those inputs again instead of every pass failing. Other rejections, `dust` included, still fail the pass as before. `keyringService.preflightP2mrPsbtSigning` and `signP2mrPsbtWithCounter` refuse a PSBT whose signed size would exceed the standard limit before any signature counter is reserved.

  Show accounts whose outputs the explorer will not list (#277). When the explorer answers HTTP 500 for an address's output list while its statistics show more than 500 confirmed unspent outputs (the electrs `--utxos-limit` default), `getAddressBalanceV2` reports the statistics total as unavailable with the new `QbitBalanceSummary.utxoLimitExceeded` instead of failing, so the balance card no longer shows 0. The card labels that total, and the send screen says the wallet cannot choose inputs for such an account. The recovery review lists each account mapping once when a source is swept by several plans. A failed balance poll no longer leaves an unhandled rejection.

- 6f06a0b: Take the Qbit SDK from npm. `@qbit/pqc`, `@qbit/protocol` and `@qbit/api` are now the npm packages `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` at exactly 0.1.0, published with provenance from the signed `v0.1.0` tags of Qbit-Org/qbit-pqc and Qbit-Org/qbit-js. Keys, addresses, descriptors, sighashes and signatures are unchanged. Through the new SDK the wallet refuses, before signing, a PSBT input that requests a sighash type other than `SIGHASH_DEFAULT`, a PSBT that pays an output qbit Core's restricted-output rule rejects, and a message with an unpaired UTF-16 surrogate. A finalized provider PSBT keeps the input fields qbit Core keeps, and one carrying another key's signature on the account's input now finalizes. P2MR message approvals and `verifyMessage` bind the proof to the expected address through `verifyP2mrMessageProof`'s new options, and only the canonical lowercase proof address verifies. A broadcast that `@qbit-oss/api` reports as `unknown_outcome` keeps its network, timeout, server or invalid-response reason and stays inconclusive; raw transaction bytes the client refuses make a fee bump `unverifiable`; and address-history reads pass twice the one-read budget, because the client reads an address again when its statistics move during the first read.
- 6f06a0b: Keep the persisted vault intact while an unlock rebuilds the keyrings (#260). `unlockKeyrings` now reads the vault under the persistence lock, decrypts and restores it into local arrays, and replaces the live keyrings in one step. It reads the vault again (up to three times) when a reset or rollback replaced it during the read. `submitPassword` loads the keyrings, sets the password and runs the encryption upgrades in that same locked section. A vault write that lands during an unlock now waits for the whole vault to be live instead of committing an empty or partial vault, which could erase every wallet on the next restart. A write still in flight when the wallet locks commits before the next unlock reads the vault, and one still in flight when the wallet is reset now fails instead of bringing the wiped vault back. `submitPassword` on an already-unlocked wallet that has live keyrings now only verifies the password and republishes the unlocked state; it no longer reloads the keyrings or runs `beforeUnlock`. It also no longer publishes an unlock when a reset cleared the session during `beforeUnlock`. `clearKeyrings` now locks the wallet instead of emptying the keyrings while the password stays set; prefer `setLocked`.
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0
  - @qbit/wallet-core@1.1.4
  - @qbit/wallet-storage@0.2.6

## 1.3.2

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1
  - @qbit/wallet-core@1.1.3
  - @qbit/wallet-storage@0.2.5

## 1.3.1

### Patch Changes

- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0
  - @qbit/wallet-core@1.1.2
  - @qbit/wallet-storage@0.2.4

## 1.3.0

### Minor Changes

- a1458e0: Make mnemonic restore custody-safe: gap-limit-20 address discovery (including spent-only addresses) replaces the opt-in fixed-10 scan, restored keyrings refuse to sign until on-chain PQC signature-counter floors are reconstructed (serialized pqcFloorsPending gate with typed PQC_FLOORS_PENDING error, auto-retried at unlock and re-armed on cross-network HD path changes), and the restore flow ends in a recovery report with stale-backup, two-live-wallet, truncation, and wrong-network warnings.
- 213b242: Require software Qbit HD keyrings for signing and return the typed
  `hardware_wallet_not_supported` error for cold-wallet creation and account derivation. The
  extension explains the current signing requirement, with hardware integration tracked in #44.
- a63aaf3: Add durable, network-scoped P2MR receive intents with gap-limit-20 rotation, counter-provenance and exhaustion safety, previous-address custody status, and amount/label `qbit:` URI sharing.

### Patch Changes

- f1bb656: Match qbit Core P2MR transaction sizing and its 2,855-sat dust policy across address decoding, sends, and transaction UTXO helpers; expose the shared estimator; and add an explicit ESM Qbit keyring entry for the live conformance runner.
- Updated dependencies [a1458e0]
- Updated dependencies [f1bb656]
- Updated dependencies [b2a1b1a]
- Updated dependencies [688e9cb]
- Updated dependencies [213b242]
- Updated dependencies [3f39e95]
- Updated dependencies [a63aaf3]
- Updated dependencies [a25cee5]
- Updated dependencies [3c57bcf]
- Updated dependencies [64cc0ee]
- Updated dependencies [c83de12]
- Updated dependencies [917a499]
- Updated dependencies [0cd8709]
  - @qbit/wallet-shared@1.0.0
  - @qbit/wallet-core@1.1.1
  - @qbit/wallet-storage@0.2.3

## 1.2.0

### Minor Changes

- release: minor wave for accumulated wallet toolkit updates since the previous package release.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.3.0
  - @qbit/wallet-storage@0.2.2

## 1.1.0

### Minor Changes

- release: minor wave for accumulated package updates.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-core@1.1.0
  - @qbit/wallet-shared@0.2.0
  - @qbit/wallet-types@1.1.0
  - @qbit/wallet-storage@0.2.1

## 1.0.1

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/wallet-storage@0.2.0
  - @qbit/wallet-core@1.0.1
  - @qbit/wallet-shared@0.1.3
  - @qbit/wallet-types@1.0.1

## 1.0.0

### Major Changes

- release first major version

### Patch Changes

- Updated dependencies
  - @qbit/wallet-core@1.0.0
  - @qbit/wallet-types@1.0.0

## 0.2.2

### Patch Changes

- fix

## 0.2.1

### Patch Changes

- fix
- Updated dependencies
  - @qbit/wallet-types@0.2.1
  - @qbit/wallet-core@0.2.1

## 0.2.0

### Minor Changes

- reorg

### Patch Changes

- Updated dependencies
  - @qbit/wallet-core@0.2.0
  - @qbit/wallet-types@0.2.0

## 0.1.30

### Patch Changes

- fix
- Updated dependencies
  - @qbit/wallet-core@0.1.13

## 0.1.29

### Patch Changes

- Updated dependencies
  - @qbit/wallet-core@0.1.12

## 0.1.28

### Patch Changes

- Updated dependencies
  - @qbit/wallet-core@0.1.11

## 0.1.27

### Patch Changes

- Updated dependencies
  - @qbit/wallet-core@0.1.10

## 0.1.26

### Patch Changes

- fix: readonly keyring
- Updated dependencies
  - @qbit/wallet-core@0.1.9

## 0.1.25

### Patch Changes

- feat: add readonly keyring

## 0.1.24

### Patch Changes

- fix: export types

## 0.1.23

### Patch Changes

- fix keystong sdk
