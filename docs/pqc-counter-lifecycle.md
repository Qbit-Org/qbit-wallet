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
  mempool listing returns (50; mempool-qbit pages them). The floor is
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
  stays closed and the scan can be retried.
- The durable warning, exact-request signing challenge, fresh-seed migration,
  and archived-source resume semantics are specified in
  [Seed-only restored Qbit wallet safety](seed-only-restored-wallet-safety.md).

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
