# @qbit/wallet-state

## 4.0.0

### Major Changes

- 6f06a0b: Bind each approval to an id, so that a window settles only the approval it rendered (#311). `ApprovalService.requestApproval` now gives every approval a random 128-bit id, and `getApproval()` returns `{ id, data }` instead of the bare data (`undefined` when none is pending). `resolveApproval(id, data?, forceReject?)` and `rejectApproval(id, err?, stay?, isInternal?)` take that id first. They settle the approval only while it is still the pending one, checking and settling in one step, and return `true`; for any other id they settle nothing, close no window, emit no event and return `false`. Previously a window that rendered approval A resolved or rejected approval B when B replaced A between the window's read and its answer, for example after a lock or unlock, a window close or a dapp retry. `openNotification(winProps?, approvalId?)` opens the window for `approvalId`, by default the pending approval. `handleWindowRemoved` now rejects only the approval its window was opened for and returns whether it did, and a window that finishes opening after its approval settled is closed instead of becoming the approval window. An approval whose window fails to open is now rejected with `ErrorCodes.UNKNOWN` (`Approval window failed to open`), and one whose window is closed before it finishes opening with `UserCancel`, instead of staying pending and refusing every later request as already pending. `Approval['data']` is now `ApprovalData`: either a provider request (`ProviderApprovalData`, whose `state` and `approvalType` are optional because the provider omits them) or the provider's unlock request (`UnlockApprovalData`, `{ lock: true }`). These types and `PendingApproval` are exported from the package root.

  The wallet controller's `getApproval`, `resolveApproval` and `rejectApproval` change the same way, and `resolveUnlockApproval` still resolves only the unlock request, in one step. In `wallet-state`, `WalletController` and `ApprovalContextType` take the approval id as the first argument of `resolveApproval` and `rejectApproval`, which now resolve to whether they settled it, and `getApproval` returns the new `PendingApproval`. `ApprovalContextType` accepts `undefined` from a screen that rendered no approval, which settles nothing. `SignPsbtProps` and `SignMessageProps` take an optional `approvalId`, the approval their default handlers settle.

  Breaking change: callers must pass the id from `getApproval` to settle an approval. A call with any other value, including the old `(data, forceReject)` and `(reason, stay)` arguments, is ignored.

- 6f06a0b: Remove `clearKeyrings` from `walletController` and from the `WalletController` interface (#260). It emptied the live keyrings without locking the wallet, so the next vault write durably committed a vault without them. No UI called it; callers that need to drop the decrypted keyrings must call `lockWallet` instead.
- 6f06a0b: Stop an unlock from approving whatever request is pending (#267). `useUnlockCallback` used to call `resolveApproval()` after every password or TouchID unlock, which resolved any pending approval, so a Connect or SwitchChain request left open across an auto-lock was approved without the user. The wallet controller now exposes `resolveUnlockApproval()`, which resolves the pending approval only when the keyring is unlocked and that approval is the provider's unlock request (`{ lock: true }`). It checks and resolves in one step, so a second unlock can never approve the approval that follows, and it returns whether it resolved. `useUnlockCallback` calls it after unlocking, waits for the answer, ignores a failed call, and no longer uses the approval context or navigates; routing after the unlock is the caller's.

  Breaking change in `wallet-state`: `WalletContext` controller implementations must provide `resolveUnlockApproval(): Promise<boolean>`.

### Minor Changes

- 6f06a0b: Choose Qbit send inputs by value and keep every transaction within the standard size (#275, #276). Sends now rank outputs by effective value (the value less the fee the 3,762 vB input adds at the chosen rate), skip outputs that cannot pay for themselves, and take the largest first. A send no longer spends every small output the explorer listed before one that covers the amount, and no longer reports `Insufficient balance.` when one output could pay. No transaction carries more than the 106 single-key inputs that fit qbit Core's 400,000 WU `MAX_STANDARD_TX_WEIGHT` (with no witness discount, the finalized size). An amount only more inputs could reach fails before any signature budget is preflighted and names the largest amount one transaction can send. Send-all spends the 106 largest outputs and reports the others in the new `ToSignData.leftBehindInputCount` and `leftBehindSats`. `@qbit/wallet-shared` adds `QBIT_MAX_STANDARD_TX_WEIGHT`, `isQbitStandardTxSize`, `qbitP2mrMaxStandardInputCount`, `qbitP2mrInputFee`, `sortQbitCoinsByValue` and the selectors `selectQbitP2mrSendCoins` and `selectQbitP2mrSendAllCoins`, which both the controller and the wallet-state previews (`estimateQbitP2mrSendPreflight`, `estimateQbitP2mrSendAllPreflight`) use, so a preview matches the transaction that is built. Confirmed outputs are still spent before the account's own unconfirmed change, so an earlier payment keeps no descendant and stays eligible for a fee bump: `getQbitAddressUtxos` marks that change with the new optional `UTXO.unconfirmed` / `UnspentOutput.unconfirmed`, and the selector ranks it after the confirmed outputs, by value alone only when that order cannot build a standard transaction. The send preview now also reports `exceedsStandardSize`, `maxInputCount` and `maxStandardAmount`, and the send-all preview `leftBehindInputCount` and `leftBehindSats`; the send screen explains both cases.

  Recovery sweeps plan one transaction per batch of at most 106 inputs, all paying the source's destination account. The inputs fill the fewest batches, spread so the batches are even in value as well as in size, and the inputs of a batch too small to pay a dust output join a batch with room or form full batches of their own. Preparation drops an unsigned plan that exceeds the standard size and plans its inputs again. `advanceQbitRecoveryMigration` drops a signed plan whose transaction is gone and whose rebroadcast fails when the node rejects it as `tx-size` or its bytes exceed the standard size, since the same bytes can never be accepted, so the next preparation plans those inputs again instead of every pass failing. Other rejections, `dust` included, still fail the pass as before. `keyringService.preflightP2mrPsbtSigning` and `signP2mrPsbtWithCounter` refuse a PSBT whose signed size would exceed the standard limit before any signature counter is reserved.

  Show accounts whose outputs the explorer will not list (#277). When the explorer answers HTTP 500 for an address's output list while its statistics show more than 500 confirmed unspent outputs (the electrs `--utxos-limit` default), `getAddressBalanceV2` reports the statistics total as unavailable with the new `QbitBalanceSummary.utxoLimitExceeded` instead of failing, so the balance card no longer shows 0. The card labels that total, and the send screen says the wallet cannot choose inputs for such an account. The recovery review lists each account mapping once when a source is swept by several plans. A failed balance poll no longer leaves an unhandled rejection.

- 6f06a0b: Let accounts holding more outputs than the explorer lists spend, consolidate and migrate their funds (#277). When the explorer refuses an address's output list (HTTP 500 from `/address/:a/utxo` while its statistics show more than 500 confirmed unspent outputs), `getQbitUtxos`, `getQbitUtxoSnapshot`, `getAddressUtxo` and recovery preparation now read the outputs from the address's complete history instead, through the new `getQbitAddressUtxosClassifiedFromHistory` and `getQbitAddressUtxosClassifiedPastLimit`. The read fails closed: the statistics must match before and after the walk, the walk must hold their exact transaction counts, and the outputs it finds funded and spent must reconcile with their counts and sums. A history that moved or does not reconcile is read again a bounded number of times and otherwise fails. It never yields a smaller set. A history longer than `QBIT_UTXO_HISTORY_MAX_TRANSACTIONS` (10,000 transactions), or one the client's page ceiling cuts short, throws `QbitUtxoHistoryTooLargeError` before any partial result. The balance poll still reports the statistics total with `utxoLimitExceeded` and never walks history. Protected-asset lookups now run at most 16 at a time.

  The new `createQbitConsolidationPsbt` and `getQbitConsolidationStatus` let such an account sweep its outputs to its own address one batch at a time through the ordinary confirm, sign and broadcast flow. Each batch takes the largest mature confirmed outputs, at most 106, so it stays within the standard weight. It leaves out outputs worth no more than the fee their input adds, and reads on until the batch pays its fee and a dust output. Its inputs come from a newest-first walk of the history (`continueQbitAddressOutputScan`, new `getAddressHistoryPage` on both wallet clients) that resumes where the previous batch stopped, with a page budget per batch, so it also works for histories past the read limit. Every input is checked at `/tx/:txid/outspends` (`findQbitSpentOutpoints`) when the batch is built. It is checked again in `signPsbtV2` before any signature counter is reserved, including for a batch built here whose request has lost its details. A built batch's inputs stay out of later batches while a claim or recent spend holds them, and return once the explorer shows them unspent. Inputs a send claim, signing lock or recent broadcast holds stay out, so an interrupted run resumes without spending anything twice. `ToSignData.qbitConsolidation` (`QbitConsolidationBatch`) carries the batch's details. `@qbit/wallet-state` adds `useQbitConsolidationScreenLogic`, which publishes only the latest batch for the current account, network and fee rate. It also adds the `QbitConsolidationScreen` route. The send screen offers consolidation for an over-limit account (`showConsolidate`, `onClickConsolidate`) and shows Available as unknown (`--`) while the account's outputs cannot be read. The success screen after a batch offers the next one (`TxSuccessScreen.consolidation`, `onClickContinueConsolidation`).

### Patch Changes

- 6f06a0b: Refuse a Qbit fee bump that would evict a later payment (#274). qbit Core evicts every transaction spending an output of the transaction it replaces once the replacement's fee covers theirs, so a bump of a payment whose change had already funded a later payment could cancel that later payment without warning. `getQbitFeeBumpEligibility` and `createBumpFeeQbitPsbt` now check, before pricing, whether anything spends an output of the original: a claim, an external signing lock or a recent broadcast held by `qbitSendGuardService` (the new `hasDependentSpend`, across every account), or a transaction the explorer reports at `/tx/:txid/outspends`. Such a bump is reported with the new `QbitFeeBumpUnavailableReason` `has_descendants`, and an outspends answer that is not exactly one well-formed entry per output as `unverifiable`. Because a later payment can still be made while the bump waits for review, `runWithBroadcastClaim` and `broadcastIfAllowed` refuse to sign or broadcast a fee bump, with `A later payment depends on the transaction this fee bump replaces`, while a claim, lock or recent broadcast spends one of its original's outputs.

  Send only from confirmed outputs and the account's own unconfirmed change (#279). Under full RBF the payer of an unconfirmed payment can replace it, evicting every send built on it, so an unconfirmed output now becomes selectable only when its transaction and every unconfirmed ancestor of it spend only outputs of the same script, and only while a send spending all such change together stays within qbit Core's limit of 25 in-mempool ancestors. An ancestor the explorer cannot produce leaves that output out of the read instead of failing it. `getQbitUtxos`, `getQbitUtxoSnapshot` and `getAddressUtxo` return confirmed outputs first, so coin selection prefers them, followed by that change. `getAddressBalanceV2` counts the change in `availableBalance`, and `pendingBalance` is now the rest of the unconfirmed value on the script, no longer capped at the net mempool value. The send screen (`useTxCreateScreenLogic`) shows as Available the total that the fee preflight checks against and Max fills, once the outputs have loaded, including 0 when a pending send holds them all. Unavailable shows the rest of the balance, including outputs a pending send holds.

- 6f06a0b: Take the Qbit SDK from npm. `@qbit/pqc`, `@qbit/protocol` and `@qbit/api` are now the npm packages `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` at exactly 0.1.0, published with provenance from the signed `v0.1.0` tags of Qbit-Org/qbit-pqc and Qbit-Org/qbit-js. Keys, addresses, descriptors, sighashes and signatures are unchanged. Through the new SDK the wallet refuses, before signing, a PSBT input that requests a sighash type other than `SIGHASH_DEFAULT`, a PSBT that pays an output qbit Core's restricted-output rule rejects, and a message with an unpaired UTF-16 surrogate. A finalized provider PSBT keeps the input fields qbit Core keeps, and one carrying another key's signature on the account's input now finalizes. P2MR message approvals and `verifyMessage` bind the proof to the expected address through `verifyP2mrMessageProof`'s new options, and only the canonical lowercase proof address verifies. A broadcast that `@qbit-oss/api` reports as `unknown_outcome` keeps its network, timeout, server or invalid-response reason and stays inconclusive; raw transaction bytes the client refuses make a fee bump `unverifiable`; and address-history reads pass twice the one-read budget, because the client reads an address again when its statistics move during the first read.
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0
  - @qbit/keyring-service@1.3.3

## 3.0.1

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1
  - @qbit/keyring-service@1.3.2

## 3.0.0

### Major Changes

- 8366980: Include the Qbit broadcast-recovery work from 053943b (#235). Add `broadcastQbitTx` and `checkQbitBroadcastStatus` with structured outcomes that distinguish a proven `not_sent` transaction from an `unknown` payment status and recognize transactions already pending or confirmed after a lost broadcast response. Recovery retains the exact signed bytes in memory and reuses them, the expected txid, the original network, and the send claim for retries without signing again or consuming another one-time P2MR signature. The failure screen offers retry, status check, and wallet-home actions with localized guidance and sanitized technical details; inconclusive outcomes keep input reservations and warn against replacement payments. The provider-facing `pushTx` contract is unchanged.

  Breaking changes in `wallet-background` and `wallet-state`: callers supplying `qbitUtxos` to `createSendQbitPsbt` or `createSendAllQbitPsbt` must also supply the network those outputs were loaded on as `qbitUtxoChain`. Use `getQbitUtxoSnapshot()` to obtain the paired `utxos` and `chain`; stale or unbound outputs are rejected instead of being used on the currently selected network. Wallet-state controller implementations must provide the new broadcast, status-check, UTXO-snapshot, external-signature reservation, and claim-release methods. `TxFailScreen` route parameters now require a structured `result: QbitBroadcastFailure` instead of `error: string`, with optional retained broadcast data for recovery. Externally signed wallet sends use `reserveExternallySignedQbitSend` to bind the signed result to the approved transaction before broadcast.

  The `wallet-shared` additions are non-breaking: exported broadcast result, failure, status-check, retained-payload, identity, and UTXO-snapshot types; optional broadcast identity on signing requests and results; and broadcast-detail sanitization helpers. Retained signed payloads stay in route memory and must not be persisted, logged, or stored in Redux.

- 6eb4ec2: Remove the positive spending-amount detail from `useActionOverviewSectionLogic` (04458cb, #227). For outgoing transactions the hook no longer pushes a `PsbtActionDetailType.SATOSHIS` entry labelled with the `spending_amount` message into `commonDetails`; the network fee is already itemized in the fee overview section, so the aggregate row was redundant. The receive-side entry for incoming value is unchanged. Consumers that rendered or asserted on the spending row must drop that expectation, and the `spending_amount` message key is no longer requested from the i18n provider.

### Patch Changes

- 0abd814: Make local Qbit Regtest available in the Chrome Web Store build behind an optional host-permission gate: the store manifest declares `http://127.0.0.1:3002/*` only as an optional host permission (E2E keeps it required), the background owns a `locked` / `checking` / `available` / `unreachable` / `unexpected_service` capability that re-reads `chrome.permissions.contains()`, a versioned in-app acknowledgement, and a bounded read-only identity check of the local service (`/block-height/0` against the reviewed Qbit regtest genesis hash plus `/blocks/tip/height`) before any UI, dapp, direct-controller, startup or revocation path may enter regtest. The synchronous store-channel `disable` flag and the preference-service regtest rewrite are replaced by capability-aware startup that falls back to Mainnet, and permission revocation while regtest is active returns the wallet to Mainnet through the normal serialized chain transition.
- 0a7576c: Stop the Qbit restore floor scan from failing on unrelated new blocks: a per-address observation interrupted by a chain-tip advance, shifted history pagination or moving address evidence is now retried a bounded number of times per address with exponential back-off instead of failing the whole scan, and a manually derived account whose in-band scan still does not complete resolves with `floorScanPending: true` (signing stays locked until a deferred scan succeeds) instead of rejecting an account that was already created.
- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0
  - @qbit/keyring-service@1.3.1

## 2.0.0

### Major Changes

- 96c9608: Keep account state focused on Qbit balances and transaction-signing safety metadata.

### Minor Changes

- a1458e0: Make mnemonic restore custody-safe: gap-limit-20 address discovery (including spent-only addresses) replaces the opt-in fixed-10 scan, restored keyrings refuse to sign until on-chain PQC signature-counter floors are reconstructed (serialized pqcFloorsPending gate with typed PQC_FLOORS_PENDING error, auto-retried at unlock and re-armed on cross-network HD path changes), and the restore flow ends in a recovery report with stale-backup, two-live-wallet, truncation, and wrong-network warnings.
- a63aaf3: Add durable, network-scoped P2MR receive intents with gap-limit-20 rotation, counter-provenance and exhaustion safety, previous-address custody status, and amount/label `qbit:` URI sharing.
- 3c57bcf: History lifecycle truth (F5): BIP125 replaceable flags derived from input sequences, session-level replaced-transaction detection (pending txs that vanish from the mempool are retained and flagged instead of silently disappearing), 60-second history auto-refresh matching block cadence so confirmations tick and reorged transactions flip back to pending, and honest pending/replaced/confirmation-count rendering in the history list and detail views.
- 2c8ef79: Send-flow transparency (F4): optional OP_RETURN memo behind an Advanced disclosure (80-byte cap with backend byte semantics; refused loudly on send-all instead of silently dropped), a PQC signature-budget row on the confirm screen (signatures used + remaining), and create-screen fee detail (input count, predicted size, sub-dust change-fold note) sourced from the existing preflight estimator.
- c83de12: Finish Qbit send/history closeout: add live-verified fee replacement that preserves recipient and memo intent while enforcing exact-size dust and higher absolute/rate fees, route replacement signing through persisted PQC counter reservations with immediate displayed-counter refresh, and include memo bytes in send-all construction and fee accounting. Harden pending lifecycle verification against stale Electrs status responses and prove replacement, fee delta, broadcast-failure retry, and counter behavior against regtest.
- 0cd8709: Add provider-aware qbit fee targets, network-scoped quote freshness and explicit
  relay-floor fallback metadata, centralized fee safety limits, and exact P2MR
  paid-fee and input-dominance previews with dust-fold disclosure.

### Patch Changes

- f1bb656: Match qbit Core P2MR transaction sizing and its 2,855-sat dust policy across address decoding, sends, and transaction UTXO helpers; expose the shared estimator; and add an explicit ESM Qbit keyring entry for the live conformance runner.
- b2a1b1a: Serve discovery from a release-pinned Qbit ecosystem catalog and persist only current wallet preferences.
- 3f39e95: Keep qbit Available, Immature, and Pending balance buckets disjoint while preserving unconfirmed UTXO spend policy and the exact coinbase maturity boundary.
- 64cc0ee: Split immature coinbase from pending in the send-screen balance buckets: UTXO classification now tags confirmed-but-immature coinbase outputs instead of silently dropping them, QbitBalanceSummary carries an optional immatureBalance, and the send screen shows immature (coinbase) and pending sub-buckets beneath Unavailable when immature funds exist.
- 1f51f23: Prevent mnemonic restore messages from turning omitted gap-limit options into `null` before address discovery.
- 917a499: Build block-explorer links from validated chain configuration and fail closed to copy-only transaction states when no web explorer is available.
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
  - @qbit/keyring-service@1.3.0
  - @qbit/wallet-shared@1.0.0

## 1.2.3

### Patch Changes

- Stabilize account balance refreshes by using the current account address as the hook dependency.

## 1.2.1

### Minor Changes

- fix: stabilize ui callbacks

## 1.2.0

### Minor Changes

- release: minor wave for accumulated wallet toolkit updates since the previous package release.

### Patch Changes

- Updated dependencies
  - @qbit/keyring-service@1.2.0
  - @qbit/wallet-shared@0.3.0

## 1.1.0

### Minor Changes

- release: minor wave for accumulated package updates.

### Patch Changes

- Updated dependencies
  - @qbit/base-utils@0.2.0
  - @qbit/keyring-service@1.1.0
  - @qbit/wallet-shared@0.2.0
  - @qbit/wallet-types@1.1.0

## 1.0.6

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/base-utils@0.1.4
  - @qbit/keyring-service@1.0.1
  - @qbit/wallet-shared@0.1.3
  - @qbit/wallet-types@1.0.1

## 1.0.5

### Patch Changes

- Updated dependencies
  - @qbit/base-utils@0.1.3

## 1.0.4

### Patch Changes

- fix
- Updated dependencies
  - @qbit/wallet-shared@0.1.2

## 1.0.3

### Patch Changes

- fix

## 1.0.2

### Patch Changes

- fix

## 1.0.1

### Patch Changes

- fix
- Updated dependencies
  - @qbit/base-utils@0.1.2
  - @qbit/wallet-shared@0.1.1
