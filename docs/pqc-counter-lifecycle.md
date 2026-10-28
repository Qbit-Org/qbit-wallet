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
  index holds the block. Retrying per address keeps one churning address from
  restarting the whole scan, and the cap keeps an endlessly churning mempool
  from hanging it.
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
- Floors are minimums: message signatures and never-broadcast transactions are
  invisible on-chain. The restore report warns about stale backups
  accordingly.
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
