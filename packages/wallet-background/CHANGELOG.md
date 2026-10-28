# @qbit/wallet-background

## 7.0.0

### Major Changes

- 6f06a0b: Bind each approval to an id, so that a window settles only the approval it rendered (#311). `ApprovalService.requestApproval` now gives every approval a random 128-bit id, and `getApproval()` returns `{ id, data }` instead of the bare data (`undefined` when none is pending). `resolveApproval(id, data?, forceReject?)` and `rejectApproval(id, err?, stay?, isInternal?)` take that id first. They settle the approval only while it is still the pending one, checking and settling in one step, and return `true`; for any other id they settle nothing, close no window, emit no event and return `false`. Previously a window that rendered approval A resolved or rejected approval B when B replaced A between the window's read and its answer, for example after a lock or unlock, a window close or a dapp retry. `openNotification(winProps?, approvalId?)` opens the window for `approvalId`, by default the pending approval. `handleWindowRemoved` now rejects only the approval its window was opened for and returns whether it did, and a window that finishes opening after its approval settled is closed instead of becoming the approval window. An approval whose window fails to open is now rejected with `ErrorCodes.UNKNOWN` (`Approval window failed to open`), and one whose window is closed before it finishes opening with `UserCancel`, instead of staying pending and refusing every later request as already pending. `Approval['data']` is now `ApprovalData`: either a provider request (`ProviderApprovalData`, whose `state` and `approvalType` are optional because the provider omits them) or the provider's unlock request (`UnlockApprovalData`, `{ lock: true }`). These types and `PendingApproval` are exported from the package root.

  The wallet controller's `getApproval`, `resolveApproval` and `rejectApproval` change the same way, and `resolveUnlockApproval` still resolves only the unlock request, in one step. In `wallet-state`, `WalletController` and `ApprovalContextType` take the approval id as the first argument of `resolveApproval` and `rejectApproval`, which now resolve to whether they settled it, and `getApproval` returns the new `PendingApproval`. `ApprovalContextType` accepts `undefined` from a screen that rendered no approval, which settles nothing. `SignPsbtProps` and `SignMessageProps` take an optional `approvalId`, the approval their default handlers settle.

  Breaking change: callers must pass the id from `getApproval` to settle an approval. A call with any other value, including the old `(data, forceReject)` and `(reason, stay)` arguments, is ignored.

- 6f06a0b: Remove `clearKeyrings` from `walletController` and from the `WalletController` interface (#260). It emptied the live keyrings without locking the wallet, so the next vault write durably committed a vault without them. No UI called it; callers that need to drop the decrypted keyrings must call `lockWallet` instead.

### Minor Changes

- 6f06a0b: Refuse a Qbit fee bump that would evict a later payment (#274). qbit Core evicts every transaction spending an output of the transaction it replaces once the replacement's fee covers theirs, so a bump of a payment whose change had already funded a later payment could cancel that later payment without warning. `getQbitFeeBumpEligibility` and `createBumpFeeQbitPsbt` now check, before pricing, whether anything spends an output of the original: a claim, an external signing lock or a recent broadcast held by `qbitSendGuardService` (the new `hasDependentSpend`, across every account), or a transaction the explorer reports at `/tx/:txid/outspends`. Such a bump is reported with the new `QbitFeeBumpUnavailableReason` `has_descendants`, and an outspends answer that is not exactly one well-formed entry per output as `unverifiable`. Because a later payment can still be made while the bump waits for review, `runWithBroadcastClaim` and `broadcastIfAllowed` refuse to sign or broadcast a fee bump, with `A later payment depends on the transaction this fee bump replaces`, while a claim, lock or recent broadcast spends one of its original's outputs.

  Send only from confirmed outputs and the account's own unconfirmed change (#279). Under full RBF the payer of an unconfirmed payment can replace it, evicting every send built on it, so an unconfirmed output now becomes selectable only when its transaction and every unconfirmed ancestor of it spend only outputs of the same script, and only while a send spending all such change together stays within qbit Core's limit of 25 in-mempool ancestors. An ancestor the explorer cannot produce leaves that output out of the read instead of failing it. `getQbitUtxos`, `getQbitUtxoSnapshot` and `getAddressUtxo` return confirmed outputs first, so coin selection prefers them, followed by that change. `getAddressBalanceV2` counts the change in `availableBalance`, and `pendingBalance` is now the rest of the unconfirmed value on the script, no longer capped at the net mempool value. The send screen (`useTxCreateScreenLogic`) shows as Available the total that the fee preflight checks against and Max fills, once the outputs have loaded, including 0 when a pending send holds them all. Unavailable shows the rest of the balance, including outputs a pending send holds.

- 6f06a0b: Let accounts holding more outputs than the explorer lists spend, consolidate and migrate their funds (#277). When the explorer refuses an address's output list (HTTP 500 from `/address/:a/utxo` while its statistics show more than 500 confirmed unspent outputs), `getQbitUtxos`, `getQbitUtxoSnapshot`, `getAddressUtxo` and recovery preparation now read the outputs from the address's complete history instead, through the new `getQbitAddressUtxosClassifiedFromHistory` and `getQbitAddressUtxosClassifiedPastLimit`. The read fails closed: the statistics must match before and after the walk, the walk must hold their exact transaction counts, and the outputs it finds funded and spent must reconcile with their counts and sums. A history that moved or does not reconcile is read again a bounded number of times and otherwise fails. It never yields a smaller set. A history longer than `QBIT_UTXO_HISTORY_MAX_TRANSACTIONS` (10,000 transactions), or one the client's page ceiling cuts short, throws `QbitUtxoHistoryTooLargeError` before any partial result. The balance poll still reports the statistics total with `utxoLimitExceeded` and never walks history. Protected-asset lookups now run at most 16 at a time.

  The new `createQbitConsolidationPsbt` and `getQbitConsolidationStatus` let such an account sweep its outputs to its own address one batch at a time through the ordinary confirm, sign and broadcast flow. Each batch takes the largest mature confirmed outputs, at most 106, so it stays within the standard weight. It leaves out outputs worth no more than the fee their input adds, and reads on until the batch pays its fee and a dust output. Its inputs come from a newest-first walk of the history (`continueQbitAddressOutputScan`, new `getAddressHistoryPage` on both wallet clients) that resumes where the previous batch stopped, with a page budget per batch, so it also works for histories past the read limit. Every input is checked at `/tx/:txid/outspends` (`findQbitSpentOutpoints`) when the batch is built. It is checked again in `signPsbtV2` before any signature counter is reserved, including for a batch built here whose request has lost its details. A built batch's inputs stay out of later batches while a claim or recent spend holds them, and return once the explorer shows them unspent. Inputs a send claim, signing lock or recent broadcast holds stay out, so an interrupted run resumes without spending anything twice. `ToSignData.qbitConsolidation` (`QbitConsolidationBatch`) carries the batch's details. `@qbit/wallet-state` adds `useQbitConsolidationScreenLogic`, which publishes only the latest batch for the current account, network and fee rate. It also adds the `QbitConsolidationScreen` route. The send screen offers consolidation for an over-limit account (`showConsolidate`, `onClickConsolidate`) and shows Available as unknown (`--`) while the account's outputs cannot be read. The success screen after a batch offers the next one (`TxSuccessScreen.consolidation`, `onClickContinueConsolidation`).

- 6f06a0b: Release a provider `sendQbit` send claim when the request fails after the approval window signed it (#269). Signing a provider send registers its claim in the background, and the request released it only when the approval's answer carried that claim. A request rejected after signing therefore left the claim held until the background restarted: the user pressed Reject, for example after the website check refused the signed bytes, or the approval window closed while the signature was being made. Its inputs were missing from every later send's coin selection, and a wallet send over them was refused as spending an input claimed by an approved send. The provider flow now opens a send request for the claim its approval carries before the approval is shown, through the new `openQbitProviderSendRequest`, and settles it however the request ends, through the new `settleQbitProviderSendRequest`. Local signing registers a provider claim through the new guard method `runWithProviderBroadcastClaim`, which files it under the open request carrying exactly that claim, and `promoteExternalSigningLockToBroadcastClaim` now files an external signer's claim the same way. Both refuse a claim that no open request carries, so a signature that reaches the wallet after its request settled spends no one-time signature and reserves nothing. Settling a request decides only the claim filed under it. A request that failed before its broadcast, or whose broadcast was proven not sent, releases it; after a successful send, or one whose outcome is unknown, the claim goes but its inputs stay reserved as recently spent, as before. A second provider request for a transaction that an open request is already sending is refused with `Another Qbit provider request is already sending this transaction`. The new guard methods are `openProviderSendRequest`, `runWithProviderBroadcastClaim` and `settleProviderSendRequest`, and the new type is `QbitProviderSendRequest`.
- 6f06a0b: Keep the inputs of a broadcast Qbit transaction reserved after its send claim is consumed (#278). Previously, an accepted broadcast released its inputs at once. A send built from an output list the explorer had not yet updated, or from the UI's cached copy of it, could then spend them again, and under full RBF that second transaction could silently replace the first payment. `qbitSendGuardService` now keeps an in-memory record of recently spent inputs. Each record holds the network, the outpoint, the spending txid and the account. Inputs are recorded when a broadcast is accepted, when a lookup proves that a lost answer was accepted, and when a `broadcastQbitTx` broadcast ends without a verdict (`unknown`). A failed provider `pushTx` or `pushPsbt` records nothing, so a dapp cannot freeze the account's outputs by pushing bytes it cannot get accepted. When absence is proven, they fall back to the transaction a fee bump replaced, if any, or are forgotten. Recorded inputs are excluded from coin selection. Minting, restoring, signing without a claim (provider `signPsbt` and `signPsbts`, including external-signer locks) or broadcasting any other transaction that spends them is refused with `Qbit transaction spends an input a recent broadcast already spent`, since signed bytes can be broadcast outside the wallet. `runWithNoOverlap` and `assertNoOverlap` take an optional txid of the transaction being signed, which may itself be the recorded spender. The same transaction may go out again, and a wallet-built fee bump may take over the inputs of exactly the transaction it replaces, provided it spends all of them. A record is evicted when a lifecycle probe of its spender finds it confirmed, or finds it gone at least 10 minutes after it was recorded or last found pending; a gone fee bump hands the input back to its original. Probes run when outputs are filtered: at most every 30 seconds per spender, for at most eight spenders at a time, and an output read waits at most 2 seconds for them. Records also expire 24 hours after a probe last found the spender pending, and at most 1,024 inputs are kept, dropping claim-less (dapp-pushed) records first. The explorer no longer listing an output never evicts a record. The record lives in memory only and does not survive a background restart. `runWithBroadcastClaim` takes an optional fourth argument, the txid a wallet-owned claim replaces. The new guard methods are `takeRecentSpendersToProbe`, `settleRecentSpendProbe`, `recordAcceptedBroadcast`, `consumeBroadcastClaim`, `recordInconclusiveBroadcast`, `forgetAbsentBroadcast` and `observePendingSpender` (a status check that finds the transaction pending renews its records).

  The provider's `sendQbit` now broadcasts through `broadcastQbitTx` instead of `pushTx` (#268). An accepted transaction, or one a follow-up lookup finds, resolves with its txid. A transaction proven not sent rejects with a plain error and releases its send claim. When the outcome is unknown, `sendQbit` rejects with the new `ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN` (`-32010`, in the JSON-RPC server-error range so that the page provider passes it through) and `data: { outcome: 'unknown', chain, txid }`. The request's claim goes, but its inputs stay reserved as recently spent until a probe settles them. Dapps should look up that txid instead of retrying into a second payment; see `docs/api/sign-transaction.md`. The provider's `pushTx` and `pushPsbt` resolve and reject as before, except that they, like `signPsbt` and `signPsbts`, now refuse a transaction that spends an input a recent broadcast of another transaction spent, so a pending transaction cannot be replaced through them.

- 6f06a0b: Only the extension's own pages can now reach the wallet controller (#259). The new `isExtensionPageSender(sender)` accepts a port or runtime message only when `sender.id` is the extension id and the sender URL is served from the extension origin. When the browser also reports `sender.origin`, that origin must match too. The sender must also be a top-level document (`frameId` absent or 0), because MV2 builds make `index.html` web-accessible and a site could otherwise frame a wallet page. The comparison uses scheme and host because `URL.origin` is `"null"` for `chrome-extension:` URLs outside Chromium. Content scripts carry the extension id too and can open a port under any name, so neither the id nor the port name is enough. `PhishingController` now answers `SKIP_PHISHING_PROTECTION` and `FORCE_UPDATE_PHISHING_LIST` from any other sender with `{ error: 'Unauthorized sender' }`. It does the same for the declared but unhandled `ADD_TO_WHITELIST` and `FORCE_RELOAD_PHISHING_LISTS` types. Other phishing messages are unchanged.

  The new `UI_CONTROLLER_METHODS` lists the controller methods a UI port may call: the `wallet.<method>` calls in the extension UI and `@qbit/wallet-state`, plus the reads used by the e2e harness. The new `getUiControllerMethod(controller, method)` resolves an allowlisted name only when the controller itself holds the function, either as an instance property or as a method of its own class. Otherwise it throws `Unknown wallet method: <name>`. As a result, TypeScript-private, inherited and `Object.prototype` members cannot be called. Hosts that dispatch UI requests to the controller should use both functions. The extension's background now does so, and it no longer serves the unused `UI_BROADCAST` and `UI_OPENAPI` message types.

- 6f06a0b: Stop an unlock from approving whatever request is pending (#267). `useUnlockCallback` used to call `resolveApproval()` after every password or TouchID unlock, which resolved any pending approval, so a Connect or SwitchChain request left open across an auto-lock was approved without the user. The wallet controller now exposes `resolveUnlockApproval()`, which resolves the pending approval only when the keyring is unlocked and that approval is the provider's unlock request (`{ lock: true }`). It checks and resolves in one step, so a second unlock can never approve the approval that follows, and it returns whether it resolved. `useUnlockCallback` calls it after unlocking, waits for the answer, ignores a failed call, and no longer uses the approval context or navigates; routing after the unlock is the caller's.

  Breaking change in `wallet-state`: `WalletContext` controller implementations must provide `resolveUnlockApproval(): Promise<boolean>`.

### Patch Changes

- 6f06a0b: Bind Qbit fee bumps to the transaction the account signed (#261). `getQbitFeeBumpEligibility` and `createBumpFeeQbitPsbt` no longer copy the original's inputs and outputs from the explorer's `/tx/:txid` JSON. They read the raw transaction from `/tx/:txid/hex`, require it to hash to the requested txid, and require every input to carry a single-key P2MR witness whose signature verifies against the current account key under `SIGHASH_DEFAULT`, the type the wallet signs with, which commits to every output and to the explorer-supplied prevout amounts and scripts. An original that is unsigned, spends an input another key signed, carries an explicit sighash type, misreports a prevout, or has an output other than P2MR or a zero-value `OP_RETURN` is now reported as `unverifiable` instead of being replaced, as is any bump for an account whose stored `p2mr.leafScript` or `p2mr.scriptPubKey` is not the single-key leaf of its public key; a raw transaction the explorer no longer serves is reported as `gone`. The bump's action details now list each recipient as a `to` address and `amount` pair right after `replaces_transaction`. Hosts must initialize `@qbit-oss/pqc` before fee bumps can verify, as they already must for P2MR signing; without it every bump is reported as `unverifiable`.
- 6f06a0b: Choose Qbit send inputs by value and keep every transaction within the standard size (#275, #276). Sends now rank outputs by effective value (the value less the fee the 3,762 vB input adds at the chosen rate), skip outputs that cannot pay for themselves, and take the largest first. A send no longer spends every small output the explorer listed before one that covers the amount, and no longer reports `Insufficient balance.` when one output could pay. No transaction carries more than the 106 single-key inputs that fit qbit Core's 400,000 WU `MAX_STANDARD_TX_WEIGHT` (with no witness discount, the finalized size). An amount only more inputs could reach fails before any signature budget is preflighted and names the largest amount one transaction can send. Send-all spends the 106 largest outputs and reports the others in the new `ToSignData.leftBehindInputCount` and `leftBehindSats`. `@qbit/wallet-shared` adds `QBIT_MAX_STANDARD_TX_WEIGHT`, `isQbitStandardTxSize`, `qbitP2mrMaxStandardInputCount`, `qbitP2mrInputFee`, `sortQbitCoinsByValue` and the selectors `selectQbitP2mrSendCoins` and `selectQbitP2mrSendAllCoins`, which both the controller and the wallet-state previews (`estimateQbitP2mrSendPreflight`, `estimateQbitP2mrSendAllPreflight`) use, so a preview matches the transaction that is built. Confirmed outputs are still spent before the account's own unconfirmed change, so an earlier payment keeps no descendant and stays eligible for a fee bump: `getQbitAddressUtxos` marks that change with the new optional `UTXO.unconfirmed` / `UnspentOutput.unconfirmed`, and the selector ranks it after the confirmed outputs, by value alone only when that order cannot build a standard transaction. The send preview now also reports `exceedsStandardSize`, `maxInputCount` and `maxStandardAmount`, and the send-all preview `leftBehindInputCount` and `leftBehindSats`; the send screen explains both cases.

  Recovery sweeps plan one transaction per batch of at most 106 inputs, all paying the source's destination account. The inputs fill the fewest batches, spread so the batches are even in value as well as in size, and the inputs of a batch too small to pay a dust output join a batch with room or form full batches of their own. Preparation drops an unsigned plan that exceeds the standard size and plans its inputs again. `advanceQbitRecoveryMigration` drops a signed plan whose transaction is gone and whose rebroadcast fails when the node rejects it as `tx-size` or its bytes exceed the standard size, since the same bytes can never be accepted, so the next preparation plans those inputs again instead of every pass failing. Other rejections, `dust` included, still fail the pass as before. `keyringService.preflightP2mrPsbtSigning` and `signP2mrPsbtWithCounter` refuse a PSBT whose signed size would exceed the standard limit before any signature counter is reserved.

  Show accounts whose outputs the explorer will not list (#277). When the explorer answers HTTP 500 for an address's output list while its statistics show more than 500 confirmed unspent outputs (the electrs `--utxos-limit` default), `getAddressBalanceV2` reports the statistics total as unavailable with the new `QbitBalanceSummary.utxoLimitExceeded` instead of failing, so the balance card no longer shows 0. The card labels that total, and the send screen says the wallet cannot choose inputs for such an account. The recovery review lists each account mapping once when a source is swept by several plans. A failed balance poll no longer leaves an unhandled rejection.

- 6f06a0b: Make MV3 phishing blocking take effect (#266). `PhishingController` now installs one dynamic `declarativeNetRequest` `block` rule whose `requestDomains` are the bundled denylist, for `main_frame` and `sub_frame` requests. The earlier per-domain `redirect` rules needed host access to every denylisted host, which the manifest does not grant, so they never fired. The update replaces every existing dynamic rule in one call, including those redirect rules. `SKIP_PHISHING_PROTECTION` (Proceed) now adds a session-scoped `allow` rule for top-level (`main_frame`) requests to the host and its subdomains at a higher priority than the block rule, so other sites still cannot frame the host. It answers `{ success: true }` only once the rule is in place. It answers `{ error: 'Invalid hostname parameter' }` for a hostname that is malformed or not covered by the bundled denylist, and `{ error }` when the rule update fails. After a service-worker restart, the controller restores the in-memory bypass from those session rules before it answers `CHECK_PHISHING`, `REDIRECT_TO_PHISHING_PAGE` or `CHECK_NAVIGATION`, so a page the user proceeded to is not sent back to the warning page. `CHECK_PHISHING` also answers `isDenylisted`, which ignores Proceed, and the extension injects its provider only when both `isPhishing` and `isDenylisted` are `false`. If a denylist entry is not a canonical hostname, it is left out of the block rule and logged, because DNR would reject the whole rule. Both redirect messages now pass the blocked URL to the warning page as `href` only when it is an http(s) URL on the warned host, and an empty `href` otherwise.

  In `@qbit/phishing-detect`, an `addToWhitelist()` bypass now also covers subdomains of the host, matching the DNR rule, and an empty hostname is ignored. `checkWebsite()` still ignores every bypass.

- 6f06a0b: Treat a denylisted host as denylisted whatever its DNS label syntax (#335). `PhishingService.checkWebsite()` now checks the bundled denylist before classifying the rest of an http(s) origin. A denylisted host is therefore always `BLOCKED`, even when its origin uses HTTP, has a path, or has a label outside DNS syntax such as `a_b.<entry>`. Before, those origins were only `UNVERIFIED`, so an approval showed a warning the user could acknowledge.

  `PhishingService.isDenylisted(hostname)` is new. It reports whether the bundled denylist covers a hostname, and it ignores navigation bypasses and DNS syntax.

  `PhishingController` now answers the `isDenylisted` field of `CHECK_PHISHING` with `isDenylisted()`. Before, after Proceed on a denylisted host, a subdomain such as `a_b.<entry>` loaded with the wallet provider, because the old check accepted only hostnames in DNS syntax. Proceed and the DNR block rule still accept only well-formed public hostnames, which DNR requires.

- 6f06a0b: Make a click on a link to a denylisted host end on the phishing warning page (#320). The link's own navigation, which the DNR block rule turns into Chrome's blocked page, raced the redirect to the warning page and could replace it. After `CHECK_NAVIGATION` or `REDIRECT_TO_PHISHING_PAGE` sends a tab to the warning page, `PhishingController` now waits up to 5 seconds for the tab to stop loading and redirects it once more if it shows neither one of the extension's pages nor a page whose content script answers a probe, which Chrome's blocked page never runs. It leaves the tab alone when the user has proceeded to the host in the meantime, when a newer redirect of the same tab has started, and when the tab closes or is still loading at the timeout. The check runs only with the DNR block rule and `chrome.runtime.getContexts` (Chrome 116). The answers to both messages are unchanged. The extension's content script now also cancels a plain click on such a link itself, before the browser starts the navigation, and then asks for the warning page.

  `@qbit/wallet-shared` exports the probe's message type as `PHISHING_PAGE_PROBE`.

- 6f06a0b: Finalize a provider PSBT only when the wallet's signatures complete it, and validate `signPsbt` and `signPsbts` options at the provider entry (#272). The provider finalized every signed PSBT unless `autoFinalized` was `false`, so a multi-party PSBT with another signer's input, or an input with P2MR entries that finalize rejects (qbit-js issue #49), failed with an internal error after the approval had spent a signature. `prepareQbitProviderPsbt` now signs the plans with a placeholder and runs them through finalize and extract before the approval and before the signature-budget preflight. With `autoFinalized` omitted, the PSBT is finalized only when that succeeds and otherwise comes back signed but unfinalized. An explicit `autoFinalized: true` that the wallet cannot meet is rejected before approval with `-32602`, and `false` never finalizes, as before. An input another signer had already finalized in the request may now come back in a partially signed result, and with either setting it must keep its final witness and witness UTXO unchanged; an input the approval itself finalized is still refused when finalizing was not requested. The provider flow now rejects with `-32602` an options object that is not an object, has any key other than `chain` and `autoFinalized` (such as `toSignInputs`, which the wallet ignored while signing every matching input), or has a non-boolean `autoFinalized` (the string `"false"` used to finalize). A `signPsbts` call without one options entry for each of 1-20 PSBTs is rejected with `-32602` instead of `4901`. Unknown and mismatched chains are still rejected with `4901`.
- 6f06a0b: Bind provider sessions to the browser's security origin for the requesting document (#265). `tabCheckin` now takes `port.sender.origin` as the origin authority instead of deriving it from `port.sender.url`, and rejects the check-in with `Cannot verify request origin` when the sender origin is missing, empty or `"null"`, when the sender URL is missing, malformed or not `http(s)`, or when the two disagree. A document served with `Content-Security-Policy: sandbox` keeps its host's URL but runs with an opaque origin, so it previously inherited the host origin's connected session and accounts and its approvals were labelled with the host origin. A malformed sender URL now fails with the same error instead of a `TypeError`. Hosts must supply `sender.origin`, which Chromium provides from version 80 and Firefox from version 126; senders without it can no longer check in. The extension's Edge and Brave manifests now require Chromium 114, matching Chrome, and its Firefox manifest requires Firefox 126.
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
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/approval-service@2.0.0
  - @qbit/wallet-shared@1.2.0
  - @qbit/keyring-service@1.3.3
  - @qbit/phishing-detect@0.3.0
  - @qbit/wallet-core@1.1.4
  - @qbit/notification-service@1.1.7
  - @qbit/preference-service@0.3.4
  - @qbit/tx-helpers@1.2.7
  - @qbit/wallet-api@2.1.3
  - @qbit/contact-book@1.1.5
  - @qbit/permission-service@1.1.6

## 6.0.1

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1
  - @qbit/approval-service@1.1.5
  - @qbit/keyring-service@1.3.2
  - @qbit/notification-service@1.1.6
  - @qbit/phishing-detect@0.2.3
  - @qbit/preference-service@0.3.3
  - @qbit/tx-helpers@1.2.6
  - @qbit/wallet-api@2.1.2
  - @qbit/wallet-core@1.1.3
  - @qbit/contact-book@1.1.4
  - @qbit/permission-service@1.1.5

## 6.0.0

### Major Changes

- 8366980: Include the Qbit broadcast-recovery work from 053943b (#235). Add `broadcastQbitTx` and `checkQbitBroadcastStatus` with structured outcomes that distinguish a proven `not_sent` transaction from an `unknown` payment status and recognize transactions already pending or confirmed after a lost broadcast response. Recovery retains the exact signed bytes in memory and reuses them, the expected txid, the original network, and the send claim for retries without signing again or consuming another one-time P2MR signature. The failure screen offers retry, status check, and wallet-home actions with localized guidance and sanitized technical details; inconclusive outcomes keep input reservations and warn against replacement payments. The provider-facing `pushTx` contract is unchanged.

  Breaking changes in `wallet-background` and `wallet-state`: callers supplying `qbitUtxos` to `createSendQbitPsbt` or `createSendAllQbitPsbt` must also supply the network those outputs were loaded on as `qbitUtxoChain`. Use `getQbitUtxoSnapshot()` to obtain the paired `utxos` and `chain`; stale or unbound outputs are rejected instead of being used on the currently selected network. Wallet-state controller implementations must provide the new broadcast, status-check, UTXO-snapshot, external-signature reservation, and claim-release methods. `TxFailScreen` route parameters now require a structured `result: QbitBroadcastFailure` instead of `error: string`, with optional retained broadcast data for recovery. Externally signed wallet sends use `reserveExternallySignedQbitSend` to bind the signed result to the approved transaction before broadcast.

  The `wallet-shared` additions are non-breaking: exported broadcast result, failure, status-check, retained-payload, identity, and UTXO-snapshot types; optional broadcast identity on signing requests and results; and broadcast-detail sanitization helpers. Retained signed payloads stay in route memory and must not be persisted, logged, or stored in Redux.

### Minor Changes

- 4181d28: Reject duplicate account derivations (90bb3ee, #226). `WalletController.deriveNewAccountFromMnemonic` now tracks derivations in flight per keyring, keyed by keyring type and the first account's public key (or its address, or the keyring key when no account exists yet). A second call for the same keyring while one is still queued or running rejects with an `Error` whose message is the `account_creation_already_in_progress` i18n key; hosts that bind `bgI18n.t`, as the extension does, receive the localized text instead. The chain-state queue serializes derivations but never removed duplicates, so a re-mounted screen, a reopened popup or a second window could each enqueue another derive while a restored wallet's floor scan was still running, and every queued request added one more account. The guard clears when the queued derivation settles, whether it succeeds or fails, so a retry after a failure is accepted. Callers that intentionally issue overlapping derivations must serialize them and should surface the rejection rather than report a failed derivation.

### Patch Changes

- 4181d28: Include the dependency-hardening changes from 118d786 (#166). The shipped runtime requirements for `lodash` and `lodash-es` move from `^4.17.21` to `^4.18.1`, so consumers must resolve Lodash 4.18.1 or later; the range stays within the 4.x major and the imported API is unchanged. `createSendAllQbitPsbt` now falls back to the 1 bit/vB relay floor when the caller omits `feeRate` and the fee summary has no "normal" tier, instead of failing the fee-policy assertion with a `RangeError`; an explicitly supplied `feeRate` is validated exactly as before, and `createSendQbitPsbt` still rejects the same missing-tier case. The P2TR probe in `formatPsbt` also skips inputs without a `witnessUtxo.script` instead of relying on the probe to throw, which leaves the signing decision unchanged.
- 0abd814: Make local Qbit Regtest available in the Chrome Web Store build behind an optional host-permission gate: the store manifest declares `http://127.0.0.1:3002/*` only as an optional host permission (E2E keeps it required), the background owns a `locked` / `checking` / `available` / `unreachable` / `unexpected_service` capability that re-reads `chrome.permissions.contains()`, a versioned in-app acknowledgement, and a bounded read-only identity check of the local service (`/block-height/0` against the reviewed Qbit regtest genesis hash plus `/blocks/tip/height`) before any UI, dapp, direct-controller, startup or revocation path may enter regtest. The synchronous store-channel `disable` flag and the preference-service regtest rewrite are replaced by capability-aware startup that falls back to Mainnet, and permission revocation while regtest is active returns the wallet to Mainnet through the normal serialized chain transition.
- 0a7576c: Stop the Qbit restore floor scan from failing on unrelated new blocks: a per-address observation interrupted by a chain-tip advance, shifted history pagination or moving address evidence is now retried a bounded number of times per address with exponential back-off instead of failing the whole scan, and a manually derived account whose in-band scan still does not complete resolves with `floorScanPending: true` (signing stays locked until a deferred scan succeeds) instead of rejecting an account that was already created.
- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0
  - @qbit/preference-service@0.3.2
  - @qbit/approval-service@1.1.4
  - @qbit/keyring-service@1.3.1
  - @qbit/notification-service@1.1.5
  - @qbit/phishing-detect@0.2.2
  - @qbit/tx-helpers@1.2.5
  - @qbit/wallet-api@2.1.1
  - @qbit/wallet-core@1.1.2
  - @qbit/contact-book@1.1.3
  - @qbit/permission-service@1.1.4

## 5.0.0

### Patch Changes

- Updated dependencies [7379e1e]
  - @qbit/wallet-api@2.1.0
  - @qbit/notification-service@1.1.4

## 4.0.0

### Minor Changes

- a1458e0: Make mnemonic restore custody-safe: gap-limit-20 address discovery (including spent-only addresses) replaces the opt-in fixed-10 scan, restored keyrings refuse to sign until on-chain PQC signature-counter floors are reconstructed (serialized pqcFloorsPending gate with typed PQC_FLOORS_PENDING error, auto-retried at unlock and re-armed on cross-network HD path changes), and the restore flow ends in a recovery report with stale-backup, two-live-wallet, truncation, and wrong-network warnings.
- 213b242: Require software Qbit HD keyrings for signing and return the typed
  `hardware_wallet_not_supported` error for cold-wallet creation and account derivation. The
  extension explains the current signing requirement, with hardware integration tracked in #44.
- a63aaf3: Add durable, network-scoped P2MR receive intents with gap-limit-20 rotation, counter-provenance and exhaustion safety, previous-address custody status, and amount/label `qbit:` URI sharing.
- 3c57bcf: History lifecycle truth (F5): BIP125 replaceable flags derived from input sequences, session-level replaced-transaction detection (pending txs that vanish from the mempool are retained and flagged instead of silently disappearing), 60-second history auto-refresh matching block cadence so confirmations tick and reorged transactions flip back to pending, and honest pending/replaced/confirmation-count rendering in the history list and detail views.
- 64cc0ee: Split immature coinbase from pending in the send-screen balance buckets: UTXO classification now tags confirmed-but-immature coinbase outputs instead of silently dropping them, QbitBalanceSummary carries an optional immatureBalance, and the send screen shows immature (coinbase) and pending sub-buckets beneath Unavailable when immature funds exist.
- c83de12: Finish Qbit send/history closeout: add live-verified fee replacement that preserves recipient and memo intent while enforcing exact-size dust and higher absolute/rate fees, route replacement signing through persisted PQC counter reservations with immediate displayed-counter refresh, and include memo bytes in send-all construction and fee accounting. Harden pending lifecycle verification against stale Electrs status responses and prove replacement, fee delta, broadcast-failure retry, and counter behavior against regtest.
- 0cd8709: Add provider-aware qbit fee targets, network-scoped quote freshness and explicit
  relay-floor fallback metadata, centralized fee safety limits, and exact P2MR
  paid-fee and input-dominance previews with dust-fold disclosure.

### Patch Changes

- f1bb656: Match qbit Core P2MR transaction sizing and its 2,855-sat dust policy across address decoding, sends, and transaction UTXO helpers; expose the shared estimator; and add an explicit ESM Qbit keyring entry for the live conformance runner.
- b2a1b1a: Serve discovery from a release-pinned Qbit ecosystem catalog and persist only current wallet preferences.
- 3f39e95: Keep qbit Available, Immature, and Pending balance buckets disjoint while preserving unconfirmed UTXO spend policy and the exact coinbase maturity boundary.
- 7115669: Add a stable, bounded qbit history observer for restored PQC counter floors and preserve spent-only addresses during restore discovery.
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
  - @qbit/wallet-core@1.1.1
  - @qbit/tx-helpers@1.2.4
  - @qbit/preference-service@0.3.1
  - @qbit/wallet-api@2.0.0
  - @qbit/approval-service@1.1.3
  - @qbit/notification-service@1.1.3
  - @qbit/phishing-detect@0.2.1
  - @qbit/contact-book@1.1.2
  - @qbit/permission-service@1.1.3

## 3.0.2

### Patch Changes

- Release with the latest permission service config initialization fixes.
- Updated dependencies
  - @qbit/permission-service@1.1.2

## 3.0.0

### Minor Changes

- release: minor wave for accumulated wallet toolkit updates since the previous package release.

### Patch Changes

- Updated dependencies
  - @qbit/keyring-service@1.2.0
  - @qbit/preference-service@0.3.0
  - @qbit/tx-helpers@1.2.0
  - @qbit/wallet-api@1.2.0
  - @qbit/wallet-shared@0.3.0
  - @qbit/notification-service@1.1.2
  - @qbit/approval-service@1.1.2
  - @qbit/contact-book@1.1.1
  - @qbit/permission-service@1.1.1

## 2.0.0

### Patch Changes

- Updated dependencies
  - @qbit/base-utils@0.2.0
  - @qbit/contact-book@1.1.0
  - @qbit/keyring-service@1.1.0
  - @qbit/permission-service@1.1.0
  - @qbit/phishing-detect@0.2.0
  - @qbit/preference-service@0.2.0
  - @qbit/tx-helpers@1.1.0
  - @qbit/wallet-api@1.1.0
  - @qbit/wallet-core@1.1.0
  - @qbit/wallet-shared@0.2.0
  - @qbit/wallet-types@1.1.0
  - @qbit/notification-service@1.1.1
  - @qbit/approval-service@1.1.1

## 1.0.0

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/approval-service@1.1.0
  - @qbit/notification-service@1.1.0
  - @qbit/base-utils@0.1.4
  - @qbit/contact-book@1.0.1
  - @qbit/keyring-service@1.0.1
  - @qbit/permission-service@1.0.1
  - @qbit/phishing-detect@0.1.3
  - @qbit/preference-service@0.1.7
  - @qbit/tx-helpers@1.0.1
  - @qbit/wallet-api@1.0.1
  - @qbit/wallet-core@1.0.1
  - @qbit/wallet-shared@0.1.3
  - @qbit/wallet-types@1.0.1

## 0.1.10

### Patch Changes

- Updated dependencies
  - @qbit/base-utils@0.1.3

## 0.1.9

### Patch Changes

- fix

## 0.1.8

### Patch Changes

- fix
- Updated dependencies
  - @qbit/wallet-shared@0.1.2
  - @qbit/preference-service@0.1.6

## 0.1.7

### Patch Changes

- Updated dependencies
  - @qbit/base-utils@0.1.2
  - @qbit/preference-service@0.1.5

## 0.1.6

### Patch Changes

- fix
- Updated dependencies
  - @qbit/base-utils@0.1.1
  - @qbit/preference-service@0.1.4

## 0.1.5

### Patch Changes

- fix

## 0.1.4

### Patch Changes

- Updated dependencies

## 0.1.3

### Patch Changes

- fix

## 0.1.2

### Patch Changes

- fix

## 0.1.1

### Patch Changes

- fix
- fix
