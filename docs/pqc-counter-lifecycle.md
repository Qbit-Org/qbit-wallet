# PQC Signature Counter Lifecycle

qbit P2MR keys have a finite SLH-DSA signing budget. The wallet tracks that
budget per 32-byte P2MR pubkey inside the encrypted keyring vault.

## Current Guarantees

- `QbitHdKeyring` stores `pqcSignatureCounters` and
  `pqcSignatureCounterProvenance` in the encrypted keyring payload.
- Counter states match qbit Core thresholds: normal, warning, critical, and
  exhausted at `2^30`.
- `KeyringService.signPqcDigestWithCounter` is the integration point for C5/C7
  signing. It serializes by P2MR pubkey, checks the deterministic signature
  cache, reserves one counter unit, persists the encrypted vault, invokes the
  signer callback, caches the signature, persists again, and only then returns
  the signature.
- A failed pre-sign vault write prevents the signer callback from running, so a
  signature cannot be returned before the increment is persisted.
- Byte-identical signing input can reuse the persisted signature cache without a
  second counter increment.
- `applyPqcSignatureCounterFloor` raises counters from observed chain spends and
  marks provenance as `restored-floor`; it never lowers a local counter.

## Restore Safety

- Mnemonic restore runs `WalletController.restoreQbitKeyringWithFloors`:
  gap-limit-20 address discovery on a throwaway keyring (spent-only addresses
  count as active), then a persisted keyring covering every discovered index
  with `pqcFloorsPending: true`, then a floor scan through
  `restorePqcSignatureCounterFloors` fed by `observeQbitPqcSignatureActivity`
  (complete, stability-checked Esplora history snapshots).
- Each per-address observation brackets its reads with the chain tip and the
  address's own stats and mempool membership; any of them moving fails it as
  unstable. A tip advance counts even when the address looks unchanged,
  because the address endpoints cannot show whether their index has caught up
  with the block the tip endpoint reports, so an immediate unchanged re-read
  would not rule out a spend in that block. Unstable observations are retried
  per address with the same bounded exponential back-off as the account
  history loader (`stabilityRetries`), observing the address again from
  scratch; a retry caused by a tip advance additionally waits out
  `tipAdvanceSettleMs` (10 s in the restore controller, covering an electrs
  5 s block poll plus indexing) so it does not read the address before the
  index holds the block. The wait applies to any unstable attempt during
  which the tip advanced, however the instability showed (moved statistics,
  a count mismatch, a shifted history page): a pending spend can leave the
  mempool before the index holds the block that confirmed it. A tip that
  cannot be read after the failure counts as advanced. Retrying per address
  keeps one churning address from restarting the whole scan, and the cap
  keeps an endlessly churning mempool from hanging it.
- The full read covers at most 6,400 transactions per address, with a page
  budget (257 by default) that lets an Esplora walk reach that cap. When the
  address statistics show a history the read does not enumerate, the address
  takes its floor from those statistics instead. That covers a history past
  the cap, and, on an Esplora surface, more pending transactions than its
  mempool listing returns (50; mempool-qbit pages them, and the read steps
  back over the empty page qbit-electrs answers after a whole page of them,
  failing as a moving history if they change meanwhile). The floor is
  `chain_stats.spent_txo_count + mempool_stats.spent_txo_count`: one signature
  by its key for each of its outputs spent so far. The full read accepts a
  floor only when its own count equals that sum, so both reads trust the same
  explorer and agree wherever both can run. The statistics read keeps the
  tip-and-stats bracket, the per-address retries and the tip-advance settle
  wait. It continues the bracket the cap check opened, so a block that lands
  meanwhile still holds the retry for the settle floor. It fails closed on
  invalid statistics, on statistics that list more transactions than outputs
  they fund or spend, and on statistics that spend more outputs or value than
  the address was paid. Every other failure of the full read still fails the
  observation and leaves the gate closed: an outage, a malformed row, a
  history that keeps moving, or a walk that hits the client's page or
  transaction ceiling (`pagination_limit`) while the statistics say the
  history fits. In that last case the two disagree, and the statistics may be
  the stale side. The restore report lists which read set each account's floor
  (`floorSources`) and names the accounts read from statistics. Spender
  evidence for recovery migration (`observeQbitPqcSpentOutpoints`) still needs
  the full history.
- Until a scan completes, signing stays locked and receiving is unaffected.
  The password-gated P2MR descriptor export (`exportP2mrDescriptors`) is the
  only other way to the funds, through Qbit Core.
- While `pqcFloorsPending` is set, `assertPqcSignatureCounterAvailable` and
  `reservePqcSignatureCounter` throw `QbitPqcFloorsPendingError`
  (`code: 'PQC_FLOORS_PENDING'`): a restored wallet cannot sign until its
  floors are reconstructed. The flag lives in the encrypted vault, so a crash
  mid-restore keeps the gate closed; unlock retries the scan automatically.
- The scan's `lookahead` probe doubles as two-live-wallet detection: activity
  beyond the restored range sets `possibleConcurrentInstance`, surfaced in the
  restore report UI. The hazard also latches as a vault-persisted
  `pqcConcurrentInstanceHint` (never auto-cleared), so a scan that completes on
  a deferred unlock/chain-switch path still records it;
  `getQbitConcurrentInstanceHint` exposes it for F3 to render.
- `changeHdPath` re-arms the gate for mnemonic-restored keyrings whenever the
  path actually changes (network switches re-derive keys whose floors were
  never observed on the new network); chain switches kick a fresh scan.
- Manually deriving an account on a mnemonic-restored keyring re-arms the
  gate, commits and selects the account, then rescans in-band. If that scan
  still fails after the account is committed, `deriveNewAccountFromMnemonic`
  resolves with `floorScanPending: true` instead of rejecting a creation that
  already happened; the gate stays closed until a deferred scan completes.
- Floors are minimums: message signatures, never-broadcast transactions and
  transactions a fee bump replaced are invisible on-chain, so neither the full
  history read nor the statistics read can count them. Each Speed up signs
  every input again, and the transaction it replaces drops out of the
  history. This understates the signature budget used; it does not reuse a
  one-time key. The restore report warns about stale backups accordingly.
  The opposite case, a floor that is too high, cannot be undone, because no
  path lowers a floor. The statistics read therefore refuses statistics that
  list more funded or spent outputs than their transactions can carry (a
  transaction fits in the 2,000,000-byte block, so it carries at most 46,511
  outputs paying a P2MR address and 536 inputs spending one), and a floor at
  or above the warning threshold (`PQC_WARNING_SIGNATURE_THRESHOLD`, 2^28
  signatures). The threshold also applies to the floor summed across
  testnet4 and regtest, which share a counter, when either was read from
  statistics. Either refusal fails the scan like any other, so the gate
  stays closed and the scan can be retried. The active network's own floor
  stays below the threshold, so a summed refusal means the optional
  sibling's share took the sum there, whether that share came from
  statistics or from history. The share stays in the sum while the sibling
  answers. The refused keyring's scan stops at the refused account, and the
  refusal does not mark the sibling unavailable, so keyrings scanned after
  it in the same scan still read the sibling. The refusal shows both
  networks' counts, each with the read it came from, and says what to do,
  by the restored network and by whose share is strictly the larger:
  - On a Testnet4 restore, the user can stop the local Regtest service or
    turn off Local Regtest. The retry then leaves regtest out, as it does any
    optional network that does not answer, and completes on the Testnet4
    floor alone, without the signatures regtest reported. That holds when
    Testnet4's own share is the larger one too: the Testnet4 floor, which can
    then be anything up to just under the threshold, is accepted on its own,
    like any single-network floor below it, and it can never be lowered. This is the residual the
    threshold leaves, and the refusal says so when Testnet4's share is the
    larger one.
  - On a Regtest restore, the Testnet4 explorer cannot be turned off, so the
    keyring stays locked until a retry succeeds. When the local Regtest
    service's own share is the larger one, the refusal points at that
    service instead. Either way the qbit Core recovery descriptors reach the
    funds meanwhile.
- The durable warning, exact-request signing challenge, fresh-seed migration,
  and archived-source resume semantics are specified in
  [Seed-only restored Qbit wallet safety](seed-only-restored-wallet-safety.md).

## Send Plans

A send plan (#188) signs one signature per input of every transaction it
sends: every merge's inputs, then the payment's, which has one input for each
merge's output and one for each output it spends directly. 214 outputs sent
in two merges of 106 and a payment of 4 inputs take 216 signatures. The send
screen and the review state the count, and the review shows the signatures
left before and after the plan.

- One approval covers the whole plan. Preparing the review opens one
  signature batch (`openP2mrPsbtSigningBatch`) with an entry for each
  transaction, and the review's confirmation is that batch's approval. Each
  transaction then signs under its own entry's approved figures; when a
  figure no longer continues that approval, the plan pauses rather than sign
  with another.
- The background signs the plan whether or not a wallet window is open, but
  only in a session the user authorised by confirming the plan or by
  Continue: never while the wallet is locked, and never after a restart of
  the browser or the extension until the user presses Continue, which the
  wallet offers and accepts only while it is unlocked. A lock
  stops the signing before its next signature, and so does a switch to
  another network. The plan carries on after the next unlock in the same
  session whenever the only change since the approval is what its own
  signatures took: the counter moved by exactly the signatures the keyring
  reported for the plan, plus at most one for each signing that was cut
  short (the keyring takes an input's count before it makes the signature),
  and every transaction left signs the inputs it was approved for under the
  same limit. Anything else, such as a signature another request made with
  the key meanwhile, waits for Continue, which approves the signatures left
  and opens a new batch for them. Continue records the figures it approves
  as a review does, for every transaction that may still need a signature:
  each merge that has not confirmed, and the payment while it is unsigned.
  The plan never signs on figures no start or Continue approved: a merge
  that had confirmed when Continue was pressed and is later reorganised out
  for good waits for another Continue.
- The signed payment is kept in the plan's store and broadcast as signed, so
  a resumed plan never signs it again, unless the stored bytes cannot be
  read; then Continue signs the same transaction again. Signed merges are
  kept only in memory and broadcast as soon as they are signed. A merge sent,
  or whose broadcast had no verdict, is looked up and never signed again
  while it may exist. A merge whose bytes a restart lost before it reached
  the network, or that is proven absent after a restart, is signed again
  after Continue: the same transaction with the same id. So is a transaction
  whose signing a lock, a network switch or a restart cut short, from its
  first input. The key's signature cache keeps its 16 most recent
  signatures, and signing a transaction again from its first input evicts
  them before it reaches them: a transaction cut short within its first 16
  inputs costs nothing more, and one cut short later is signed again in
  full, each input counted again before it is signed, up to 105 extra
  signatures for a full merge.
- A plan whose review is changed (Review again after a refused merge or
  payment) is priced and approved as a new plan, and signs its new
  transactions under a new batch. Signatures the earlier version made for
  transactions it never sent stay counted.
- On a seed-only restored wallet, the review carries the restored-floor
  confirmation for the plan's first signature, which the user gives once for
  the whole plan. The background confirms each later signature's challenge
  itself, one at a time, just before that signature and only in an
  authorised session.

## Integration Rules

C5 transaction signing and C7 message signing should call
`signPqcDigestWithCounter(addressOrPubkey, signingInput, signer)`. The `signer`
callback should perform exactly one `@qbit-oss/pqc` signature for the passed key and
input. It should not reserve counters itself.

The method currently pre-reserves before signing. That is deliberately
conservative for MV3 crash safety: an interruption can leave a counted-but-unsent
signature attempt, but not a released signature with an unpersisted counter.

## Remaining Work

- C5 must compute P2MR sighashes accepted by Qbit Core and report the exact P2MR
  pubkeys that signed through this guarded API.
- C7 must do the same for qbit message-signing digests.
- No local counter can detect every stale-backup or two-live-wallet hazard;
  the restore report warns, but F3 budget UX should keep surfacing
  restored-floor provenance after onboarding.
