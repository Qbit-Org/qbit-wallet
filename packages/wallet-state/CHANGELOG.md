# @qbit/wallet-state

## 5.0.0

### Major Changes

- 4091176: Show what a transaction takes from the wallet, and flag abnormal fees and unrecognised outputs, in PSBT approvals and on the send screen (#13). `decodePsbt(psbtHex, website, options?)` now computes a `spendSummary` (`PsbtSpendSummary`) from the exact PSBT bytes for the current account: the value spent from any of the wallet's accounts, the value paid back to them, the net spend between them (absent when an input lacks its spent output), a role for each output (`wallet`, `recipient`, `data` or `unrecognised`) and a fee assessment. `options.statedRecipients` (`DecodePsbtOptions`) names the recipients the request itself states; other outputs that do not pay the wallet are unrecognised. A decode refuses to publish a summary when the current account changes while it reads the fee quote. `risks` is now populated: `HIGH_FEE_RATE` (warning) for an abnormal fee, and the new `RiskType.UNRECOGNISED_OUTPUT` (danger) for an output with no address, or one beside a stated recipient. `shouldWarnFeeRate` follows the assessment, and `recommendedFeeRate` is the fastest live tier or the relay floor when there is none. Breaking change: `DecodedPsbt.spendSummary` is required, so code that builds a `DecodedPsbt` must supply it, and `recommendedFeeRate` now means the fastest live tier instead of the Normal tier.

  `@qbit/wallet-shared` adds `assessQbitFee`, `qbitRecommendedFeeRate`, `qbitWalletOwnership` and `qbitWalletOwns` (the accounts that can sign, by this wallet or an external or cold signer; watch-only accounts are not the wallet's), and the thresholds `QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE` (10), `QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE` (100), `QBIT_FEE_WARNING_AMOUNT_PERCENT` (25) and `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE` (2). A fee is abnormal at 10 times the fastest live recommended rate, at 100 times the relay floor whatever the explorer recommends, or at 25% of the amount sent to others while its rate is at least twice the recommendation. Without a live quote only the bounds that need none apply, and the assessment records that no recommendation was compared. Fees, amounts and rates must be bounded, integer where they are amounts, and finite.

  In `@qbit/wallet-state`, `useSignPsbtLogic` passes the request's `ADDRESS` action details as its stated recipients, keys each decode by the current account, re-decodes when the account changes, and treats a summary computed for another account as a decode error. `useActionOverviewSectionLogic` returns `spend` (`ActionOverviewSpend`) in place of `commonDetails`, which is removed. `useTxCreateScreenLogic` returns `spendSummary` (`TxCreateSpendSummary`) with the total leaving the wallet (only the fee when the recipient is one of the wallet's accounts) and the fee warning for its preview.

- 4091176: Quick multi-sign of a local (non-provider) batch now runs the abnormal-fee and unrecognised-output checks of a single approval, and needs the same explicit confirmation before it signs a flagged PSBT. `analyzeLocalPsbts(toSignDatas)` reviews each PSBT from its exact bytes, for the current account and fee quote and with the recipients its own request names, and returns its `risks` (`HIGH_FEE_RATE`, `UNRECOGNISED_OUTPUT`) and `spendSummary`, with the `account` and `chain` the batch was analyzed for. It refuses to answer when the current account or network changes while it reads them. The new `signLocalBatchPsbt(toSignData, review)` (`LocalPsbtBatchReview`) reviews the PSBT's bytes again before it signs them, and refuses a provider request, a recovery migration, a PSBT that does not decode, an account or network other than the one in `review`, a critical risk, and any risk not in `review.confirmedRisks`. Breaking change: `PsbtLocalInfo.risks`, `LocalPsbtSummary.account` and `LocalPsbtSummary.chain` are required.

  `@qbit/wallet-shared` exports `LocalPsbtBatchReview` and `statedPsbtRecipients`, which moves there from `@qbit/wallet-state`'s `useSignPsbtLogic` module so the background reads a request's named recipients the same way.

  In `@qbit/wallet-state`, `WalletController` adds `signLocalBatchPsbt`. `useSignPsbtLogic` analyzes the batch again when the account changes, ignores a late analysis for an earlier account, shows only an analysis for the current account, and analyzes the batch again when quick-signing. A flagged batch opens a review (`batchRiskReview`, with the flagged PSBTs in `batchRiskIndexes`) instead of signing; `onBatchRiskConfirm` signs the batch once, passing each PSBT's confirmed risks, and `onBatchRiskClose` signs nothing; an account switch closes the review. Quick-sign skips the PSBTs already signed, so a retry after a refusal signs only what is left. A batch analyzed for another account is refused.

### Minor Changes

- 4091176: Show the balance card as loading until the current account's first balance arrives. `balanceV2Map` is not persisted, so a freshly opened wallet read `useAccountBalance`'s zero placeholder and showed 0 QBT until the explorer answered. `useBalanceCardLogic` adds `balanceLoading`, true while the account has neither a balance for the current chain nor a failed fetch, returns `balanceValue` as `--` until a balance loads, and ignores the detail toggle while loading. A failed first load ends loading and shows the load error. `AccountUpdater` now fetches a newly selected account at once, even while the previous account's fetch is in flight, instead of leaving it to the balance card's 10-second poll.
- 4091176: Show an explorer outage on the balance card instead of a zero balance. `useFetchBalanceCallback` now records a failed refresh per address in the new `balanceStatusMap` (`setBalanceError`) and keeps the last known balance. It orders overlapping refreshes, so an older response cannot replace the outcome of a newer one. `useAccountBalanceStatus` reports whether the current account has a balance and whether its latest refresh failed. `useBalanceCardLogic` adds `balanceLoadFailed`, `balanceRefreshFailed`, `balanceErrorText`, `retryBalance` and `isRetryingBalance`, and its detail toggle does nothing until a balance loads. `AccountUpdater` no longer leaves an unhandled rejection when its balance fetch fails.
- 4091176: Keep the send screen's cached outputs with the account they were read for (#56). For an account over the explorer's output limit the read walks the address history, which can take minutes. A walk that landed after the user had switched accounts replaced the new account's cached outputs, so its send screen showed 0 available and Next failed with `Amount exceeds your available balance` or `Insufficient balance.` until the screen was opened again. `QbitUtxoSnapshot` now names the `address` it was read for, and the transactions slice keeps it as `utxosAddress`, with the read that loaded the outputs as `utxosRead`. `useFetchUtxosCallback` caches an answer only when its caller has not aborted it (the new optional `signal`), its account and network are still the selected ones, and the cache does not already hold a later read's answer for them. It rejects an answer for any account or network other than the ones it asked for. `useUtxos` now returns the cached outputs only for the selected account on the active network, and the new `useUtxosLoaded` says whether the cache holds them; `useUtxosChain` still reports the cache's network whichever account it holds. Preparing a send reloads a cache that holds another account's outputs instead of spending from it. The send screen reads again, without covering the screen, when its account or network changes, and abandons its read when it closes. `getQbitUtxoSnapshot` joins a read already running for the same account through the same API client, while the address statistics read the same as when it started, instead of starting another history walk, and applies the send reservations to each answer after the read. `getQbitUtxos` always reads afresh.

### Patch Changes

- 4091176: Keep a balance that arrives after a newer refresh failed. The balance card polls every 10 seconds without waiting for a slow refresh, and a newer refresh that failed first made the reducer drop the slower one's balance as stale, so a card with no balance yet kept showing the load error until a later poll succeeded. An older balance is now dropped only when a newer balance is stored: otherwise it is stored, the newer failure stays the latest outcome, and the card shows the balance as possibly out of date. `BalanceRefreshStatus` adds `balanceRequestId`, the refresh whose balance is stored.
- 4091176: Show the balance split of an account over the explorer's UTXO limit as unknown instead of a measured 0 (#24). `QbitBalanceSummary.availableBalance` is now `number | null`, and `immatureBalance` and `pendingBalance` may also be `null`, which means the value could not be measured. When the explorer will not list an address's outputs, `getQbitSpendableBalanceV2` now reports `availableBalance`, `immatureBalance` and `pendingBalance` as `null` instead of 0. It still takes `totalBalance` from the address statistics and keeps `unavailableBalance` equal to it. When `availableBalance` is `null`, `useBalanceCardLogic` returns `null` for `availableBalance` and `unavailableBalance` and `--` for `availableAmount` and `unavailableAmount`, with the new `balanceSplitUnknown` and `balanceSplitUnknownText` (`utxo_limit_exceeded_balance_detail`), which the balance card shows in its expanded rows. When `useTxCreateScreenLogic` falls back to an unknown balance figure, it shows Available as `--`, Max fills nothing, and Next stays disabled without an error. A measured 0 still shows as 0.
- 4091176: Let consolidation and recovery work for accounts the explorer cannot list (#25, #58). The consolidation walk (`continueQbitAddressOutputScan`) no longer stops at an empty page after a pending row. qbit-electrs answers a cursor that is the last pending row with an empty page instead of the confirmed rows after it, so an account with a whole page of pending transactions was told nothing was ready. The walk now steps back one row and reads on, and it ends only when that page holds the pending row alone. A page that does not start with that row throws `invalid_cursor`, and the walk starts over. `QbitAddressOutputScan` gains `beforeMempoolCursor` and `overlapTxid`.

  `prepareQbitRecoveryMigration` no longer fails the whole pass for a source whose history is longer than the 10,000 transactions the wallet reads (`QbitUtxoHistoryTooLargeError`). It plans the other sources and returns that source in the new `deferredSources` (`QbitRecoveryDeferredSource`), and the migration screen names it. Its funds keep the migration open. `advanceQbitRecoveryMigration` neither archives past such a source nor fails on it, and a check of an archived wallet that finds one reopens its migration. `keyringService.preflightP2mrPsbtSigning` takes `allowMigrationConsolidation`, which `createQbitConsolidationPsbt` passes for an account whose history is past the read limit (`isQbitHistoryOverReadLimit`, read from the same statistics as `qbitAddressOutputCounts`). While a migration is open, the keyring then signs that consolidation, but only if the batch pays everything it spends back to the same script, less a fee within the wallet's highest fee rate, and every input is its own, and only while no plan of the source is open. It checks the last condition again at signing. Every other signing during a migration stays limited to reviewed plans and protected-asset transfers.

- 4091176: Show Unavailable as unknown on the send screen while Available is, for an account over the explorer's UTXO limit (#24). Until the send screen has read the account's outputs from its history (while that read runs, after it fails, and always for an account without a P2MR script), `useTxCreateScreenLogic` showed Available as `--` but Unavailable as the whole balance, taken from `unavailableBalance`, which equals the total while the split is unknown. It now returns `--` for `unavailableAmount` whenever it shows Available as `--`, with `showUnavailable` true, as the balance card does. Once the outputs are read, both rows show the amounts read, a measured 0 included.
- 4091176: Stop losing stored settings and contacts (#18). `PreferenceService.setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` now return a promise that resolves once the new value is on disk, instead of leaving it to the store's 1-second debounced save, so quitting the browser or reloading the extension straight after the change no longer brings the old value back. These changes run one at a time; a failed write rejects and puts the previous value back, and saves it again at once, unless the store was reset or the value changed some other way in the meantime. The wallet controller's `setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` wait for that write. The sign-data and auto-lock settings show the error and keep the setting as it was when the change cannot be saved, and the send screen's RBF switch logs a failure to save the default instead of leaving the rejection unhandled.

  `BaseProxyStorageAdapter.createPersistentProxy` no longer writes the template over the stored data when it cannot read them. It retries the read twice and then rejects, so the service using the store fails to start instead of starting from defaults. Plain objects and arrays below the top level of a persistent proxy are now frozen copies, so a nested write throws instead of changing memory without ever being saved; `PreferenceService` now reassigns the top-level key when it fills in default wallet and account names and UI cache entries. A new `reset` option (`PersistentProxyOptions`) replaces the stored data with the template without reading it, and only the newest proxy for a key saves. The new `flushPersistentProxy` saves a proxy at once, in a single write, and rejects for a proxy that a newer one replaced; `PreferenceService.persist` uses it when the adapter has it. `PreferenceService.resetAllData` can therefore no longer be undone by a save the previous store still had pending or by a `persist` that runs while it resets.

  `ContactBookService` applies each change to a copy of the contact book and keeps it only once it is saved, one change at a time, so a failed write rejects and leaves the contacts as they are on disk. `resetAllData` now returns a promise. The wallet controller's `addContact`, `updateContact` and `removeContact` wait for the write. The extension's background storage now returns all data from `get()` without a key, accepts a write before the first read or after a failed one, keeps a write made while the first read is in flight, makes writes one at a time in call order so a read sees the writes requested before it, and stores and returns copies, so a caller changing an object it read or wrote no longer changes the cache.

  Breaking change: `@qbit/wallet-background` no longer exports `initPersistStoreStorage`, and its unused `createPersistStore` and duplicate `webapi/storage` wrapper are removed.

- 4091176: Keep a Qbit send that spends the account's own unconfirmed change within qbit Core's ancestor size limit (#47). The node refuses a transaction whose in-mempool ancestors, itself included, total more than 404,000 vB (`DEFAULT_ANCESTOR_SIZE_LIMIT_KVB`), so a send that joined the change of a large unconfirmed send to many confirmed inputs was signed and then rejected as `too-long-mempool-chain`. `getQbitUtxos`, `getQbitUtxoSnapshot` and `getAddressUtxo` now list each change output's unconfirmed transactions with their sizes (`unconfirmedAncestors`, `QbitUnconfirmedAncestor`). Change whose transactions the explorer does not size is left out, like change of unreadable ancestry. `selectQbitP2mrSendCoins` keeps every selection that holds change within the new `QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT` together with those transactions, counting a shared one once and passing over change that would cross it. It reports a send that only this limit stops as `exceeds_ancestor_size`, and `selectQbitP2mrSendAllCoins` reports `exceedsAncestorSize`. `createSendQbitPsbt` and `createSendAllQbitPsbt` refuse such a send before signing with `send_exceeds_ancestor_size`. The send screen's preflight (`exceedsAncestorSize`) shows the same message: wait for the earlier send to confirm, or send a smaller amount. Fee bumps keep the original's inputs and never grow it, so they stay within the package the node already accepted.
- 4091176: Stop holding the inputs of a wallet send with an unknown broadcast outcome until the background restarts (#57). Such a send's claim stayed held after its recovery screen was left, because the popup or tab, and its UI port, usually stay open. If the transaction never reached the node, its inputs stayed unavailable to every send long after lifecycle probes found it gone. If it landed, "Speed up" was refused with `Qbit transaction spends an input claimed by an approved send` before any signature was made. `qbitSendGuardService` now consumes a wallet-owned claim whose last dispatched broadcast was inconclusive into recent spends once its owner is gone, instead of keeping it held. Its owner is gone when the UI port disconnects, or when the recovery or confirm screen is left on any verdict other than a matching `not_sent`. The UI then calls the new `WalletController.abandonQbitSendBroadcastClaim` (`qbitSendGuardService.abandonBroadcastClaim`). Only the port that owns the claim can abandon it, and a claim no broadcast left the wallet for is released. The recent spends keep the inputs reserved until a lifecycle probe finds the transaction confirmed, or gone at least 10 minutes after it was recorded or last found pending, or for at most 24 hours. Meanwhile a fee bump of exactly that transaction may take them over. A lifecycle probe that finds a wallet-owned claim's transaction pending now consumes that claim into recent spends while its recovery screen is still open, and one that finds it confirmed drops it. This applies only to a claim registered before the probe was handed out. A probe miss never releases a held claim, nor drops the records of its transaction, so later probes keep watching for a transaction that lands late. `getAddressBalanceV2` now probes due spenders and counts outputs that a claim, an external signing lock or a recent broadcast reserves as unavailable, read after the outputs are listed. The balance card and the send screen therefore agree on what is available. `getQbitSpendableBalanceV2` takes an optional `readReserved` reader for this.
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
  - @qbit/keyring-service@1.4.0

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
