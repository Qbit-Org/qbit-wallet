import type {
  QbitExternalSigningLock,
  QbitExternalSigningLockEntry,
  QbitExternalSigningLockPurpose,
  QbitSendBroadcastClaim,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

export interface QbitOutpoint {
  txid: string
  vout: number
}

export type QbitExternalSigningLockIdentity = Omit<QbitExternalSigningLock, 'id'>

/**
 * Origin of a broadcast claim the wallet mints for a send it built for its
 * own confirm screen. A provider claim carries the dapp's session origin and
 * is filed under the provider request that approved it, which alone releases
 * it; no web page can present this value as a session origin, so no provider
 * request ever carries, or releases, a wallet-owned claim.
 */
export const QBIT_WALLET_SEND_CLAIM_ORIGIN = 'qbit-wallet'

/**
 * Thrown by `broadcastIfAllowed` when the caller presents a claim for the
 * exact transaction it is broadcasting but the guard no longer holds it. The
 * claim is consumed the moment a broadcast callback resolves, so this is what
 * a retry sees after a broadcast whose success was lost on the way back to
 * the UI; it is also what every claim looks like after the background
 * restarts. Neither proves the bytes never reached the network, so the
 * caller must not report this refusal as a proven non-submission.
 */
export class QbitSendBroadcastClaimInactiveError extends Error {
  constructor() {
    super('Qbit send broadcast claim is not active')
    this.name = 'QbitSendBroadcastClaimInactiveError'
  }
}

/**
 * Opaque identity of the UI port that holds a wallet-owned claim's signed
 * bytes. The bytes live only in that page's memory, so the port is the
 * claim's owner of last resort: once it disconnects nothing can retry or
 * abandon the bytes, and a claim nobody is still deciding is released
 * instead of reserving the inputs until the background restarts.
 */
export type QbitSendClaimOwner = string

/**
 * Opaque identity of one provider sendQbit request while it is being
 * decided; see `QbitSendGuardService.openProviderSendRequest`.
 */
export type QbitProviderSendRequest = string

/**
 * What a broadcast attempt concluded about a claim's transaction, as far as
 * the claim's fate is concerned. `accepted` means the guard already consumed
 * the claim. `proven_absent` is a dispatched broadcast the node rejected
 * with absence proven. `refused` never left the wallet, so it says nothing
 * about earlier attempts. `inconclusive` may hide an accepted transaction.
 */
export type QbitSendClaimVerdict = 'accepted' | 'proven_absent' | 'refused' | 'inconclusive'

interface QbitSendClaimOwnership {
  owner: QbitSendClaimOwner
  ownerGone: boolean
  /** Broadcast attempts still in flight; their verdicts decide the claim. */
  attempts: number
  /**
   * The last dispatched verdict may hide an accepted transaction. Such a
   * claim is never released on the owner's behalf: a second send over its
   * inputs could replace a payment the node already holds. Once its owner
   * is gone it is consumed into recent spends instead, which keep the inputs
   * reserved until a lifecycle probe settles the transaction.
   */
  inconclusive: boolean
}

/**
 * The longest an input a broadcast spent stays reserved without a lifecycle
 * probe finding its spender pending: a backstop for a spender the explorer
 * never answers for, not the normal way out. A spender found pending keeps
 * its inputs for this long again from that answer.
 */
export const QBIT_RECENT_SPEND_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A spender reported `gone` frees its inputs only once this long has passed
 * since it was recorded or last found pending. Right after a broadcast the
 * explorer's index can lag the node, and a single miss after a run of
 * pending answers can be a transient one, so such a miss says nothing about
 * the mempool.
 */
export const QBIT_RECENT_SPEND_GONE_GRACE_MS = 10 * 60 * 1000

/** The shortest pause between two lifecycle probes of the same spender. */
export const QBIT_RECENT_SPEND_PROBE_INTERVAL_MS = 30 * 1000

/** At most this many spenders are handed out for probing at a time, oldest first. */
export const QBIT_RECENT_SPEND_PROBES_PER_READ = 8

/**
 * At most this many spent inputs are remembered, each with up to
 * `QBIT_RECENT_SPEND_HISTORY` earlier spenders behind it. Beyond it the
 * oldest claim-less records go first, then the oldest of the rest.
 */
export const QBIT_RECENT_SPEND_LIMIT = 1024

/** How many earlier spenders of one input are kept behind the current one. */
const QBIT_RECENT_SPEND_HISTORY = 3

/**
 * At most this many transactions the user approved signing for a dapp are
 * remembered (see `QbitSendGuardService.recordProviderSigning`); beyond it
 * the oldest go first.
 */
export const QBIT_PROVIDER_SIGNING_LIMIT = 256

/**
 * At most this many transactions whose broadcast ended without a verdict
 * are remembered (see `QbitSendGuardService.hasUnknownBroadcastOutcome`);
 * beyond it the oldest go first.
 */
export const QBIT_UNKNOWN_BROADCAST_LIMIT = 256

/**
 * An input a broadcast from this wallet spent, or may have spent (the
 * broadcast was inconclusive), after its claim is gone. The explorer's
 * output list can keep listing the input for a while after the node took
 * the spend (its index lags; a refresh failed and the UI kept its cache), and
 * qbit Core is full-RBF, so a send built from that list could replace the
 * first payment. The entry keeps the input reserved until a lifecycle probe
 * of its spender shows it confirmed or gone, never because the explorer
 * stopped listing the output, which is exactly the signal that lags.
 */
interface QbitRecentSpend {
  chain: ChainType
  /** The account the spending claim was filed under; none for a claim-less broadcast. */
  address: string | undefined
  outpoint: string
  /** Txid of the transaction that spent the input. */
  spender: string
  recordedAt: number
  probedAt: number
  /**
   * When the record was made or a probe last found its spender pending:
   * both the gone grace and the expiry run from here.
   */
  liveAt: number
  /** Position in recording order; see `QbitRecentSpendProbe.sequence`. */
  sequence: number
  /**
   * The record a later transaction over the same input (a fee bump)
   * replaced. If that transaction is proven absent or found gone, the
   * input falls back to this record instead of becoming spendable while
   * the transaction it replaced may still be pending.
   */
  previous?: QbitRecentSpend
}

/** A spender `takeRecentSpendersToProbe` handed out, and when it was handed out. */
export interface QbitRecentSpendProbe {
  txid: string
  probedAt: number
  /**
   * The last recording (of a spent input or a claim) made before the probe
   * was handed out. A record or claim made after it, even within the same
   * millisecond, is newer than anything the probe can have seen.
   */
  sequence: number
}

const QBIT_CHAINS = new Set<ChainType>([
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
])

function isTxid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function outpointKey(outpoint: QbitOutpoint): string {
  return `${outpoint.txid}:${outpoint.vout}`
}

/** Claims are unique per network and txid; ownership is keyed the same way. */
function claimKey(claim: Pick<QbitSendBroadcastClaim, 'chain' | 'txid'>): string {
  return `${claim.chain}:${claim.txid}`
}

/**
 * `spend` and the records behind it, minus any of `spender` (which a new
 * record of that spender supersedes) and beyond the history limit. The
 * records are copied, so a chain still referenced elsewhere is untouched.
 */
function withoutSpender(
  spend: QbitRecentSpend | undefined,
  spender: string,
  depth = 0
): QbitRecentSpend | undefined {
  if (!spend || depth >= QBIT_RECENT_SPEND_HISTORY) return undefined
  if (spend.spender === spender) return withoutSpender(spend.previous, spender, depth)
  const kept: QbitRecentSpend = { ...spend }
  delete kept.previous
  const previous = withoutSpender(spend.previous, spender, depth + 1)
  if (previous) kept.previous = previous
  return kept
}

/**
 * An outpoint names one output on one network, whichever account it pays,
 * so a spent input is keyed by network and outpoint; the account it was
 * filed under only scopes the per-account reads.
 */
function recentSpendKey(chain: ChainType, outpoint: string): string {
  return `${chain}:${outpoint}`
}

function normalizeOutpoint(value: unknown): QbitOutpoint | undefined {
  if (!value || typeof value !== 'object') return
  const outpoint = value as Partial<QbitOutpoint>
  if (!isTxid(outpoint.txid) || !Number.isSafeInteger(outpoint.vout) || outpoint.vout! < 0) {
    return
  }
  return { txid: outpoint.txid, vout: outpoint.vout! }
}

function normalizeBroadcastClaim(value: unknown): QbitSendBroadcastClaim | undefined {
  if (!value || typeof value !== 'object') return
  const claim = value as Partial<QbitSendBroadcastClaim>
  if (
    !QBIT_CHAINS.has(claim.chain as ChainType) ||
    typeof claim.address !== 'string' ||
    claim.address.length === 0 ||
    typeof claim.origin !== 'string' ||
    claim.origin.length === 0 ||
    !isTxid(claim.txid) ||
    !Array.isArray(claim.outpoints)
  ) {
    return
  }

  const outpoints = claim.outpoints
    .map(normalizeOutpoint)
    .filter((outpoint): outpoint is QbitOutpoint => Boolean(outpoint))
  if (outpoints.length === 0 || outpoints.length !== claim.outpoints.length) return
  if (new Set(outpoints.map(outpointKey)).size !== outpoints.length) return

  const normalized: QbitSendBroadcastClaim = {
    chain: claim.chain!,
    address: claim.address,
    origin: claim.origin,
    txid: claim.txid,
    outpoints,
  }
  // Only the wallet's own claims name the transaction they replace; a
  // provider claim's is dropped, so it can never pass for a fee bump.
  if (claim.origin === QBIT_WALLET_SEND_CLAIM_ORIGIN && claim.replaces !== undefined) {
    if (claim.replaces !== null && !isTxid(claim.replaces)) return
    normalized.replaces = claim.replaces
    // A fee bump's broadcast checks what spends each output of the original,
    // as many as its assessment counted; a bump without that count could
    // only be checked by reading the original's bytes again, so it is no
    // claim at all, and neither signed, restored nor broadcast.
    if (claim.replaces !== null) {
      const count = claim.replacedOutputCount
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return
      normalized.replacedOutputCount = count
    }
  }
  return normalized
}

/** The transaction a normalized claim's fee bump replaces, if it is one. */
function replacedTxidOf(claim: QbitSendBroadcastClaim): string | undefined {
  return claim.replaces ?? undefined
}

/** `claim`, normalized, when it authorized exactly `txid` on `chain`; else nothing. */
function claimBoundTo(
  claim: QbitSendBroadcastClaim | undefined,
  chain: ChainType,
  txid: string
): QbitSendBroadcastClaim | undefined {
  const normalized = claim ? normalizeBroadcastClaim(claim) : undefined
  return normalized?.chain === chain && normalized.txid === txid ? normalized : undefined
}

function normalizeExternalSigningLockEntry(
  value: unknown
): QbitExternalSigningLockEntry | undefined {
  if (!value || typeof value !== 'object') return
  const entry = value as Partial<QbitExternalSigningLockEntry>
  if (!isTxid(entry.txid) || !Array.isArray(entry.outpoints)) return

  const outpoints = entry.outpoints
    .map(normalizeOutpoint)
    .filter((outpoint): outpoint is QbitOutpoint => Boolean(outpoint))
  if (outpoints.length === 0 || outpoints.length !== entry.outpoints.length) return
  if (new Set(outpoints.map(outpointKey)).size !== outpoints.length) return
  return { txid: entry.txid, outpoints }
}

function normalizeExternalSigningLock(value: unknown): QbitExternalSigningLock | undefined {
  if (!value || typeof value !== 'object') return
  const lock = value as Partial<QbitExternalSigningLock>
  if (
    typeof lock.id !== 'string' ||
    lock.id.length === 0 ||
    lock.id.length > 128 ||
    (lock.purpose !== 'send' && lock.purpose !== 'sign') ||
    !QBIT_CHAINS.has(lock.chain as ChainType) ||
    typeof lock.address !== 'string' ||
    lock.address.length === 0 ||
    typeof lock.origin !== 'string' ||
    lock.origin.length === 0 ||
    !Array.isArray(lock.entries)
  ) {
    return
  }

  const entries = lock.entries
    .map(normalizeExternalSigningLockEntry)
    .filter((entry): entry is QbitExternalSigningLockEntry => Boolean(entry))
  if (entries.length === 0 || entries.length !== lock.entries.length) return
  return {
    id: lock.id,
    purpose: lock.purpose,
    chain: lock.chain!,
    address: lock.address,
    origin: lock.origin,
    entries,
  }
}

function sameBroadcastClaim(left: QbitSendBroadcastClaim, right: QbitSendBroadcastClaim): boolean {
  return (
    left.chain === right.chain &&
    left.address === right.address &&
    left.origin === right.origin &&
    left.txid === right.txid &&
    left.outpoints.length === right.outpoints.length &&
    left.outpoints.every(
      (outpoint, index) => outpointKey(outpoint) === outpointKey(right.outpoints[index]!)
    )
  )
}

function sameExternalSigningLock(
  left: QbitExternalSigningLock,
  right: QbitExternalSigningLock
): boolean {
  return (
    left.id === right.id &&
    left.purpose === right.purpose &&
    left.chain === right.chain &&
    left.address === right.address &&
    left.origin === right.origin &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, entryIndex) => {
      const other = right.entries[entryIndex]
      if (!other) return false
      return (
        entry.txid === other.txid &&
        entry.outpoints.length === other.outpoints.length &&
        entry.outpoints.every(
          (outpoint, outpointIndex) =>
            outpointKey(outpoint) === outpointKey(other.outpoints[outpointIndex]!)
        )
      )
    })
  )
}

function cloneExternalSigningLock(lock: QbitExternalSigningLock): QbitExternalSigningLock {
  return {
    ...lock,
    entries: lock.entries.map(entry => ({
      ...entry,
      outpoints: entry.outpoints.map(outpoint => ({ ...outpoint })),
    })),
  }
}

function assertValidOutpoints(outpoints: readonly QbitOutpoint[]): void {
  if (outpoints.length === 0 || outpoints.some(outpoint => !normalizeOutpoint(outpoint))) {
    throw new Error('invalid Qbit transaction inputs')
  }
}

export class QbitSendGuardService {
  private broadcastClaims: QbitSendBroadcastClaim[] = []
  private externalSigningLocks: QbitExternalSigningLock[] = []
  /**
   * Owner-of-last-resort bookkeeping for wallet-owned claims, keyed like the
   * claims. Only claims the wallet minted for its own send flow get an
   * entry: a provider claim belongs to the provider request that approved
   * it (see `providerSendRequests`), never to a UI port. Mutated
   * synchronously by `beginBroadcastAttempt` so an attempt is visible before
   * the caller's first await; every other change runs on the mutation queue
   * with the claim list it describes.
   */
  private ownership = new Map<string, QbitSendClaimOwnership>()
  /**
   * Keys of every claim this instance has held and no longer holds: consumed
   * by an accepted broadcast, released by the user or on its owner's behalf,
   * or dropped with a failed signing. `restoreBroadcastClaim` consults it so
   * a claim the guard has already decided is never registered again on the
   * strength of the UI's copy; only a claim this instance has never seen,
   * which is what a background restart leaves the UI holding, qualifies.
   */
  private decidedClaimKeys = new Set<string>()
  /**
   * Keys of the held claims `restoreBroadcastClaim` registered from the
   * page's copy, dropped with them. What such a claim says it `replaces`
   * is the page's word, and the records that could confirm it (what spends
   * its inputs) went with the restart, so its broadcast must check its
   * inputs on the explorer (see `broadcastIfAllowed`).
   */
  private restoredClaimKeys = new Set<string>()
  /**
   * Inputs spent by broadcasts this instance accepted or could not decide,
   * keyed by `recentSpendKey` in the order they were recorded (see
   * `QbitRecentSpend`). Memory only, like the claims: a background restart
   * forgets them.
   */
  private recentSpends = new Map<string, QbitRecentSpend>()
  /**
   * When each held claim was registered, in the recording order of recent
   * spends (see `QbitRecentSpendProbe.sequence`), keyed like the claims and
   * dropped with them. A probe settles only a claim registered before it
   * was handed out, which its answer can speak for.
   */
  private claimSequences = new Map<string, number>()
  /**
   * The provider sendQbit requests still being decided, each with the claim
   * its approval carries. A provider claim is registered only while the
   * request carrying exactly that claim is open, and is filed under it in
   * `providerClaimRequests`; that request's settlement releases or consumes
   * it. The approval's answer has no say: the user can reject, or the
   * approval window close, after signing registered the claim, and the
   * request then fails with no answer at all.
   */
  private providerSendRequests = new Map<QbitProviderSendRequest, QbitSendBroadcastClaim>()
  /** The provider request each held provider claim is filed under, keyed like the claims. */
  private providerClaimRequests = new Map<string, QbitProviderSendRequest>()
  /**
   * Transactions the user approved signing for a dapp (provider signPsbt and
   * signPsbts), keyed like the claims, oldest first. A dapp's own broadcast
   * of one through the wallet that ends without a verdict keeps its inputs
   * reserved (see `recordInconclusiveProviderPush`). Memory only, like the
   * claims, and bounded by `QBIT_PROVIDER_SIGNING_LIMIT`.
   */
  private providerSignings = new Set<string>()
  /**
   * Transactions whose dispatched broadcast ended without a verdict, or
   * whose claim was restored for a retry of an unknown outcome, keyed like
   * the claims, oldest first, each with its place in the recording order
   * of recent spends (see `hasUnknownBroadcastOutcome`). Memory only, like
   * the claims, and bounded by `QBIT_UNKNOWN_BROADCAST_LIMIT`.
   */
  private unknownBroadcasts = new Map<string, number>()
  private recentSpendSequence = 0
  private nextExternalSigningLockId = 0
  private nextProviderSendRequestId = 0
  private mutationTail: Promise<void> = Promise.resolve()

  init(): void {
    this.broadcastClaims = []
    this.externalSigningLocks = []
    this.ownership.clear()
    this.decidedClaimKeys.clear()
    this.restoredClaimKeys.clear()
    this.recentSpends.clear()
    this.claimSequences.clear()
    this.providerSendRequests.clear()
    this.providerClaimRequests.clear()
    this.providerSignings.clear()
    this.unknownBroadcasts.clear()
  }

  /**
   * Every input of `address` on `chain` that a send must not select: the
   * ones held by a claim or an external signing lock, and the ones a recent
   * broadcast spent (including claim-less ones, whose account is unknown).
   */
  getReservedOutpointKeys(chain: ChainType, address: string): Promise<Set<string>> {
    return this.enqueue(async () => {
      this.pruneRecentSpendsNow(Date.now())
      const claims = this.broadcastClaims.filter(
        claim => claim.chain === chain && claim.address === address
      )
      const externalLocks = this.externalSigningLocks.filter(
        lock => lock.chain === chain && lock.address === address
      )
      const recentSpends = [...this.recentSpends.values()].filter(
        spend => spend.chain === chain && (spend.address === undefined || spend.address === address)
      )
      return new Set([
        ...claims.flatMap(item => item.outpoints.map(outpointKey)),
        ...externalLocks.flatMap(lock =>
          lock.entries.flatMap(entry => entry.outpoints.map(outpointKey))
        ),
        ...recentSpends.map(spend => spend.outpoint),
      ])
    })
  }

  /**
   * Whether a claim, an external signing lock or a recent broadcast on
   * `chain`, under any account, spends an output of `txid`. Replacing `txid`
   * would evict that later transaction.
   */
  hasDependentSpend(chain: ChainType, txid: string): Promise<boolean> {
    return this.enqueue(async () => this.hasDependentSpendNow(chain, txid.toLowerCase()))
  }

  /**
   * The spenders behind `address`'s recent spends on `chain` (and claim-less
   * ones) that are due a lifecycle probe, oldest first and at most
   * `QBIT_RECENT_SPEND_PROBES_PER_READ`, marked probed now so concurrent
   * readers do not probe them again within the interval. The caller reports
   * each probe's answer through `settleRecentSpendProbe`, with the probe
   * it was handed.
   */
  takeRecentSpendersToProbe(chain: ChainType, address: string): Promise<QbitRecentSpendProbe[]> {
    return this.enqueue(async () => {
      const now = Date.now()
      this.pruneRecentSpendsNow(now)
      const due = new Set<string>()
      for (const spend of this.recentSpends.values()) {
        if (due.size >= QBIT_RECENT_SPEND_PROBES_PER_READ) break
        if (
          spend.chain === chain &&
          (spend.address === undefined || spend.address === address) &&
          now - spend.probedAt >= QBIT_RECENT_SPEND_PROBE_INTERVAL_MS
        ) {
          due.add(spend.spender)
        }
      }
      for (const spend of this.recentSpends.values()) {
        if (spend.chain === chain && due.has(spend.spender)) spend.probedAt = now
      }
      return [...due].map(txid => ({ txid, probedAt: now, sequence: this.recentSpendSequence }))
    })
  }

  /**
   * Apply what lifecycle probe `probe` found for its spender on `chain`. A confirmed spender frees its inputs, since the
   * explorer has indexed the block that spends them; a `gone` one frees them
   * only once the grace period has passed since it was recorded or last
   * found pending; a pending one keeps
   * them and restarts their expiry. A spender that is gone hands each input
   * back to the transaction
   * it replaced, if any (see `QbitRecentSpend.previous`); a confirmed one
   * spent it for good. Only spends recorded before the probe was handed out
   * are touched,
   * so a probe that started before the same transaction was recorded again
   * cannot free the newer record.
   *
   * The same answer settles an unknown outcome recorded for the spender
   * before the probe was handed out (see `hasUnknownBroadcastOutcome`): a
   * pending or confirmed spender is in the network's hands, and a gone one
   * whose inputs were freed is given up on.
   *
   * A spender found pending or confirmed is in the network's hands, so a
   * claim still held for exactly that transaction is decided too (see
   * `settleClaimFoundNow`), and a fee bump may then replace it. A gone
   * answer never releases a held claim, nor drops its transaction's records,
   * so later probes keep watching for it: its owner may still retry the
   * bytes, and once the owner is gone the claim is consumed into recent
   * spends, which such answers settle.
   */
  settleRecentSpendProbe(
    chain: ChainType,
    probe: QbitRecentSpendProbe,
    state: 'confirmed' | 'pending' | 'gone'
  ): Promise<void> {
    return this.enqueue(async () => {
      if (state !== 'gone') this.settleClaimFoundNow(chain, probe, state)
      const claimHeld = this.broadcastClaims.some(
        item => item.chain === chain && item.txid === probe.txid
      )
      for (const [key, spend] of this.recentSpends) {
        if (spend.chain !== chain || spend.spender !== probe.txid) continue
        if (state === 'pending') {
          spend.liveAt = Math.max(spend.liveAt, probe.probedAt)
          continue
        }
        if (spend.sequence > probe.sequence) continue
        if (state === 'confirmed') {
          this.recentSpends.delete(key)
        } else if (!claimHeld && probe.probedAt - spend.liveAt >= QBIT_RECENT_SPEND_GONE_GRACE_MS) {
          this.fallBackRecentSpendNow(key, spend)
        }
      }
      const stillSpending = [...this.recentSpends.values()].some(
        spend => spend.chain === chain && spend.spender === probe.txid
      )
      if (state !== 'gone' || (!claimHeld && !stillSpending)) {
        this.forgetUnknownBroadcastNow(chain, probe.txid, probe.sequence)
      }
    })
  }

  /**
   * A lookup outside the probe cycle (a status check) found `txid` pending:
   * its records last as long again from now, as a probe finding it pending
   * would make them. Their place in the probe order is unchanged.
   */
  observePendingSpender(chain: ChainType, txid: string): Promise<void> {
    return this.enqueue(async () => {
      const now = Date.now()
      for (const spend of this.recentSpends.values()) {
        if (spend.chain === chain && spend.spender === txid) {
          spend.liveAt = Math.max(spend.liveAt, now)
        }
      }
      this.forgetUnknownBroadcastNow(chain, txid)
    })
  }

  /**
   * A lookup proved the network holds `txid` although its broadcast's
   * answer was lost. Record its inputs as recently spent, as an accepted
   * broadcast would, and consume `claim` when it is the held claim for
   * exactly that transaction; both happen in one step, so the inputs are
   * never unreserved in between.
   */
  recordAcceptedBroadcast(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    claim?: QbitSendBroadcastClaim
  ): Promise<void> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction broadcast'))
    }
    assertValidOutpoints(outpoints)
    const boundClaim = claimBoundTo(claim, chain, txid)
    return this.enqueue(async () => {
      const heldClaim = boundClaim
        ? this.broadcastClaims.find(item => sameBroadcastClaim(item, boundClaim))
        : undefined
      this.recordSpendNow(chain, txid, outpoints, boundClaim?.address)
      this.forgetUnknownBroadcastNow(chain, txid)
      if (heldClaim) {
        this.replaceBroadcastClaims(
          this.broadcastClaims.filter(item => !sameBroadcastClaim(item, heldClaim))
        )
      }
    })
  }

  /**
   * Retire `claim` when it is still held, recording its inputs as recently
   * spent by its transaction: a lookup proved the network holds that
   * transaction, and nothing but the claim tells which inputs it spends, or
   * its broadcast's outcome is unknown. With `found`, only a claim for
   * exactly that transaction is consumed. A claim the guard does not hold is
   * ignored, except a wallet-owned one this instance never saw when the
   * lookup found its transaction: its inputs are recorded, as restoring it
   * would have reserved them.
   */
  consumeBroadcastClaim(
    claim: QbitSendBroadcastClaim,
    found?: { chain: ChainType; txid: string }
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const normalized = normalizeBroadcastClaim(claim)
      if (!normalized) throw new Error('invalid Qbit send broadcast claim')
      if (found && !claimBoundTo(normalized, found.chain, found.txid)) return false
      if (found) this.forgetUnknownBroadcastNow(found.chain, found.txid)
      const held = this.broadcastClaims.find(item => sameBroadcastClaim(item, normalized))
      if (!held) {
        // A wallet-owned claim this instance never saw is what a background
        // restart leaves the page holding (see `restoreBroadcastClaim`); the
        // network holds its transaction, so its inputs are spent.
        if (
          found &&
          normalized.origin === QBIT_WALLET_SEND_CLAIM_ORIGIN &&
          !this.decidedClaimKeys.has(claimKey(normalized))
        ) {
          this.recordSpendNow(
            normalized.chain as ChainType,
            normalized.txid,
            normalized.outpoints,
            normalized.address
          )
        }
        return false
      }
      this.consumeHeldClaimNow(held)
      return true
    })
  }

  /**
   * A broadcast of `txid` ended without a verdict: the node may hold it.
   * Its inputs are recorded as recently spent whether or not a claim still
   * holds them, so they stay reserved once the claim is gone; `claim`, when
   * it names exactly this transaction, files them under its account.
   *
   * `dispatched` is false for a retry the guard refused because it no longer
   * holds the claim, which sent nothing itself. Such a retry records nothing
   * for a claim this instance already decided: a consumed claim's inputs are
   * already recorded, and a released one was abandoned. It does record a
   * claim the instance never saw, which is what a background restart leaves
   * behind, since the earlier broadcast may have gone out; but only for
   * inputs no other transaction is recorded as spending and no claim or
   * external signing lock holds. A dispatched
   * broadcast passed the guard's conflict check, so it may take an input
   * over (a fee bump); an undispatched one proves nothing and must not hide
   * the spender that is on record.
   *
   * A dispatched broadcast's outcome is remembered for
   * `hasUnknownBroadcastOutcome` as well.
   */
  recordInconclusiveBroadcast(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    claim?: QbitSendBroadcastClaim,
    dispatched = true
  ): Promise<void> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction broadcast'))
    }
    assertValidOutpoints(outpoints)
    const boundClaim = claimBoundTo(claim, chain, txid)
    return this.enqueue(async () => {
      if (dispatched) {
        this.recordSpendNow(chain, txid, outpoints, boundClaim?.address)
        this.rememberUnknownBroadcastNow(chain, txid)
        return
      }
      if (
        boundClaim &&
        this.decidedClaimKeys.has(claimKey(boundClaim)) &&
        !this.broadcastClaims.some(item => sameBroadcastClaim(item, boundClaim))
      ) {
        return
      }
      const held = new Set([
        ...this.broadcastClaims
          .filter(item => item.chain === chain)
          .flatMap(item => item.outpoints.map(outpointKey)),
        ...this.externalSigningLocks
          .filter(lock => lock.chain === chain)
          .flatMap(lock => lock.entries.flatMap(entry => entry.outpoints.map(outpointKey))),
      ])
      this.recordSpendNow(
        chain,
        txid,
        outpoints.filter(outpoint => {
          const spend = this.recentSpends.get(recentSpendKey(chain, outpointKey(outpoint)))
          return !held.has(outpointKey(outpoint)) && (spend === undefined || spend.spender === txid)
        }),
        boundClaim?.address
      )
    })
  }

  /**
   * Whether a dispatched broadcast of `txid` on `chain` ended without a
   * verdict (see `recordInconclusiveBroadcast`, and
   * `recordInconclusiveProviderPush` for a push it recorded), the claim
   * still held for it last had an inconclusive one, or its claim was
   * restored for a retry of an unknown outcome (see `restoreBroadcastClaim`).
   * That broadcast may have handed the bytes to another node behind the
   * same endpoint than the one a later call reaches, so a later call's node
   * rejection proves nothing about it: a Retry from the recovery screen is
   * such a call. Once the guard settles
   * the transaction (the network is seen holding it, or a probe finds it
   * gone and frees its inputs), that outcome no longer counts.
   */
  hasUnknownBroadcastOutcome(chain: ChainType, txid: string): Promise<boolean> {
    return this.enqueue(async () => this.hasUnknownBroadcastOutcomeNow(chain, txid))
  }

  /**
   * A broadcast call for `txid` proved it absent (a node rejection, then
   * lookups that all missed it): forget the inputs an earlier attempt
   * recorded for it (see `forgetAbsentBroadcastNow`), unless a call for it
   * has ended without a verdict (`hasUnknownBroadcastOutcome`), one that
   * ended while this call was still looking included. That outcome stands,
   * and the inputs it recorded stay reserved. The check and the forgetting
   * are one step on the queue, so nothing recorded in between is forgotten.
   * Resolves to whether the absence stands.
   */
  forgetProvenAbsentBroadcast(chain: ChainType, txid: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.hasUnknownBroadcastOutcomeNow(chain, txid)) return false
      this.forgetAbsentBroadcastNow(chain, txid)
      return true
    })
  }

  /**
   * The user approved signing `txid` on `chain` for a dapp, which now holds
   * bytes it can broadcast. Remembered so that the dapp's broadcast of that
   * transaction through the wallet keeps its inputs reserved when it ends
   * without a verdict (`recordInconclusiveProviderPush`). Recording the same
   * transaction again makes it the newest.
   */
  recordProviderSigning(chain: ChainType, txid: string): Promise<void> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction'))
    }
    return this.enqueue(async () => {
      const key = claimKey({ chain, txid })
      this.providerSignings.delete(key)
      this.providerSignings.add(key)
      for (const oldest of this.providerSignings) {
        if (this.providerSignings.size <= QBIT_PROVIDER_SIGNING_LIMIT) return
        this.providerSignings.delete(oldest)
      }
    })
  }

  /**
   * A dapp's claim-less broadcast of `txid` (provider pushTx or pushPsbt)
   * was dispatched and ended without a verdict: the node may hold it. Its
   * inputs are recorded as possibly spent, as `recordInconclusiveBroadcast`
   * records a dispatched broadcast's, only when the user approved signing
   * that transaction for a dapp (`recordProviderSigning`). A push needs no
   * approval, and a dapp can push any bytes over the account's public
   * outputs, so reserving the inputs of any other push would let it keep
   * the user's funds frozen. Resolves to whether the inputs were recorded;
   * a recorded push is remembered for `hasUnknownBroadcastOutcome` too.
   */
  recordInconclusiveProviderPush(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[]
  ): Promise<boolean> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction broadcast'))
    }
    assertValidOutpoints(outpoints)
    return this.enqueue(async () => {
      if (!this.providerSignings.has(claimKey({ chain, txid }))) return false
      this.recordSpendNow(chain, txid, outpoints, undefined)
      this.rememberUnknownBroadcastNow(chain, txid)
      return true
    })
  }

  acquireExternalSigningLock(
    identity: QbitExternalSigningLockIdentity
  ): Promise<QbitExternalSigningLock> {
    return this.enqueue(async () => {
      const normalized = normalizeExternalSigningLock({
        ...identity,
        id: `${Date.now().toString(36)}-${(++this.nextExternalSigningLockId).toString(36)}`,
      })
      if (!normalized) throw new Error('invalid external Qbit signing lock')

      this.assertNoOverlapNow(
        normalized.chain as ChainType,
        normalized.entries.flatMap(entry => entry.outpoints)
      )
      // The signature is made outside the wallet, and the signed bytes can be
      // broadcast anywhere: refuse it over inputs a recent broadcast spent.
      for (const entry of normalized.entries) {
        this.assertNoRecentSpendConflictNow(
          normalized.chain as ChainType,
          entry.txid,
          entry.outpoints
        )
      }
      this.externalSigningLocks = [...this.externalSigningLocks, normalized]
      return cloneExternalSigningLock(normalized)
    })
  }

  releaseExternalSigningLock(lock: QbitExternalSigningLock): Promise<boolean> {
    return this.enqueue(async () => {
      const normalized = normalizeExternalSigningLock(lock)
      if (!normalized) throw new Error('invalid external Qbit signing lock')

      const next = this.externalSigningLocks.filter(
        item => !sameExternalSigningLock(item, normalized)
      )
      if (next.length === this.externalSigningLocks.length) return false
      this.externalSigningLocks = next
      return true
    })
  }

  promoteExternalSigningLockToBroadcastClaim(
    lock: QbitExternalSigningLock,
    claim: QbitSendBroadcastClaim
  ): Promise<void> {
    return this.enqueue(async () => {
      const normalizedLock = this.activeExternalSigningLock(lock, 'send')
      const normalizedClaim = normalizeBroadcastClaim(claim)
      const entry = normalizedLock.entries[0]
      if (
        !normalizedClaim ||
        normalizedLock.entries.length !== 1 ||
        normalizedClaim.chain !== normalizedLock.chain ||
        normalizedClaim.address !== normalizedLock.address ||
        normalizedClaim.origin !== normalizedLock.origin ||
        normalizedClaim.txid !== entry?.txid ||
        !entry ||
        !this.sameOutpoints(normalizedClaim.outpoints, entry.outpoints)
      ) {
        throw new Error('external Qbit send lock identity mismatch')
      }
      if (
        this.broadcastClaims.some(
          item => item.chain === normalizedClaim.chain && item.txid === normalizedClaim.txid
        )
      ) {
        throw new Error('Qbit send broadcast claim already exists')
      }
      this.assertNoOverlapNow(
        normalizedClaim.chain as ChainType,
        normalizedClaim.outpoints,
        normalizedLock.id
      )
      const request = this.providerSendRequestCarrying(normalizedClaim)

      this.replaceBroadcastClaims([...this.broadcastClaims, normalizedClaim])
      this.providerClaimRequests.set(claimKey(normalizedClaim), request)
      this.externalSigningLocks = this.externalSigningLocks.filter(
        item => !sameExternalSigningLock(item, normalizedLock)
      )
    })
  }

  assertNoOverlap(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    txid?: string
  ): Promise<void> {
    return this.runWithNoOverlap(chain, outpoints, async () => undefined, txid)
  }

  /**
   * Run `operation` (signing without a send claim) unless the inputs are
   * claimed, externally locked, or spent by a recent broadcast of another
   * transaction. Signed bytes leave the wallet and can be broadcast anywhere,
   * so a signature over a recently spent input could replace the payment
   * that spent it; `txid` names the transaction being signed, which may
   * itself be the recorded spender. Without it, any recorded spend refuses.
   */
  runWithNoOverlap<T>(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    operation: () => Promise<T>,
    txid?: string
  ): Promise<T> {
    return this.enqueue(async () => {
      this.assertNoOverlapNow(chain, outpoints)
      this.assertNoRecentSpendConflictNow(chain, txid, outpoints)
      return operation()
    })
  }

  /**
   * Register `claim` for the duration of `operation` and keep it once the
   * operation resolves; a failed operation leaves nothing behind. `owner` is
   * the UI port the resolved result is handed to, and is recorded only for
   * a wallet-owned claim (see `ownership`): when that port disconnects
   * before a broadcast consumed the claim, `releaseClaimsOwnedBy` releases
   * it, because the signed bytes were lost with the page.
   *
   * A claim may not spend an input a recent broadcast of another
   * transaction spent, unless it is a wallet-owned claim that `replaces`
   * exactly that transaction: a fee bump, built from the live original.
   */
  runWithBroadcastClaim<T>(
    claim: QbitSendBroadcastClaim,
    operation: () => Promise<T>,
    owner?: QbitSendClaimOwner
  ): Promise<T> {
    return this.enqueue(async () => {
      const normalized = this.normalizeAvailableBroadcastClaim(claim)
      const replacedTxid = replacedTxidOf(normalized)
      if (replacedTxid) this.assertNoDependentSpendNow(normalized.chain as ChainType, replacedTxid)
      this.assertNoRecentSpendConflictNow(
        normalized.chain as ChainType,
        normalized.txid,
        normalized.outpoints,
        replacedTxid
      )
      this.replaceBroadcastClaims([...this.broadcastClaims, normalized])
      this.adoptClaim(normalized, owner)
      return this.keepClaimIfResolved(normalized, operation)
    })
  }

  /**
   * Open a provider sendQbit request whose approval carries `claim`, before
   * the approval is shown. Until `settleProviderSendRequest` closes it,
   * `runWithProviderBroadcastClaim` and the promotion of an external
   * signer's lock may register exactly that claim, filed under this
   * request. Only one open request may carry a given transaction, so the
   * settlement that decides a claim is never in doubt; a second one is
   * refused.
   */
  openProviderSendRequest(claim: QbitSendBroadcastClaim): Promise<QbitProviderSendRequest> {
    return this.enqueue(async () => {
      const normalized = normalizeBroadcastClaim(claim)
      if (!normalized || normalized.origin === QBIT_WALLET_SEND_CLAIM_ORIGIN) {
        throw new Error('invalid Qbit send broadcast claim')
      }
      const key = claimKey(normalized)
      if ([...this.providerSendRequests.values()].some(carried => claimKey(carried) === key)) {
        throw new Error('Another Qbit provider request is already sending this transaction')
      }
      const request = `${Date.now().toString(36)}-${(++this.nextProviderSendRequestId).toString(36)}`
      this.providerSendRequests.set(request, normalized)
      return request
    })
  }

  /**
   * `runWithBroadcastClaim` for the claim of a provider sendQbit approval
   * the wallet signs locally. The claim is filed under the open request
   * carrying exactly it, and that request's settlement decides it. A claim
   * no open request carries is refused before `operation` runs: its request
   * has settled (the approval was rejected, or its window closed, before the
   * signature reached the wallet) and nothing would be left to release it.
   */
  runWithProviderBroadcastClaim<T>(
    claim: QbitSendBroadcastClaim,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.enqueue(async () => {
      const normalized = this.normalizeAvailableBroadcastClaim(claim)
      const request = this.providerSendRequestCarrying(normalized)
      this.assertNoRecentSpendConflictNow(
        normalized.chain as ChainType,
        normalized.txid,
        normalized.outpoints
      )
      this.replaceBroadcastClaims([...this.broadcastClaims, normalized])
      this.providerClaimRequests.set(claimKey(normalized), request)
      return this.keepClaimIfResolved(normalized, operation)
    })
  }

  /**
   * Close provider request `request` and decide the claim filed under it,
   * if one is still held. With `spent` (the request succeeded, or its
   * broadcast's outcome is unknown) the node may hold the transaction, so
   * the claim is consumed and its inputs stay reserved as recently spent,
   * as `consumeBroadcastClaim` does; otherwise nothing spent them and the
   * claim is released. Claims filed under other requests are untouched, and
   * a closed request can file no claim, so a signature that lands after
   * this is refused rather than left holding the inputs.
   */
  settleProviderSendRequest(request: QbitProviderSendRequest, spent: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!this.providerSendRequests.delete(request)) return
      const filed = [...this.providerClaimRequests]
        .filter(([, owner]) => owner === request)
        .map(([key]) => key)
      for (const key of filed) {
        const held = this.broadcastClaims.find(item => claimKey(item) === key)
        if (!held) continue
        if (spent) {
          this.consumeHeldClaimNow(held)
        } else {
          this.replaceBroadcastClaims(this.broadcastClaims.filter(item => item !== held))
        }
      }
    })
  }

  releaseBroadcastClaim(claim: QbitSendBroadcastClaim): Promise<boolean> {
    return this.enqueue(async () => {
      const normalized = normalizeBroadcastClaim(claim)
      if (!normalized) throw new Error('invalid Qbit send broadcast claim')

      const next = this.broadcastClaims.filter(item => !sameBroadcastClaim(item, normalized))
      if (next.length === this.broadcastClaims.length) return false
      this.replaceBroadcastClaims(next)
      return true
    })
  }

  /**
   * Mark a broadcast attempt for `claim` as in flight, synchronously, so a
   * port disconnect that lands during the attempt defers to its verdict
   * instead of releasing a claim the node may be consuming at that moment.
   * `owner` is the port the verdict will be handed to; a wallet-owned claim
   * without an owner, or owned by another port, is adopted by it, since it
   * evidently holds the bytes. Every call must be paired with
   * `settleBroadcastAttempt`.
   */
  beginBroadcastAttempt(claim: QbitSendBroadcastClaim, owner?: QbitSendClaimOwner): void {
    const normalized = normalizeBroadcastClaim(claim)
    if (!normalized) return
    const record = this.adoptClaim(normalized, owner)
    if (record) record.attempts += 1
  }

  /**
   * Record what a broadcast attempt concluded and, once no attempt is in
   * flight and the owner is gone, decide the claim: it is released, or
   * consumed into recent spends when the transaction may already be in the
   * node's hands (see `releaseIfOrphaned`). An `accepted` attempt has
   * already consumed the claim, so there is nothing left to decide.
   */
  settleBroadcastAttempt(
    claim: QbitSendBroadcastClaim,
    verdict: QbitSendClaimVerdict
  ): Promise<void> {
    const normalized = normalizeBroadcastClaim(claim)
    if (!normalized) return Promise.resolve()
    const key = claimKey(normalized)
    const record = this.ownership.get(key)
    if (record && record.attempts > 0) record.attempts -= 1
    if (verdict === 'accepted' || !record) return Promise.resolve()
    if (verdict === 'inconclusive') record.inconclusive = true
    if (verdict === 'proven_absent') record.inconclusive = false
    return this.enqueue(async () => {
      this.releaseIfOrphaned(key)
    })
  }

  /**
   * The UI port `owner` disconnected. Every wallet-owned claim it holds
   * whose bytes no broadcast is still deciding is decided now; one with an
   * attempt in flight is decided by that attempt's settle. A claim whose
   * last dispatched verdict was inconclusive keeps its inputs reserved (they
   * may be spent by a transaction the node holds), but as recent spends
   * rather than as a claim, so lifecycle probes settle it and a fee bump may
   * replace its transaction; any other is released (see
   * `releaseIfOrphaned`).
   */
  releaseClaimsOwnedBy(owner: QbitSendClaimOwner): Promise<void> {
    return this.enqueue(async () => {
      for (const [key, record] of this.ownership) {
        if (record.owner !== owner) continue
        record.ownerGone = true
        this.releaseIfOrphaned(key)
      }
    })
  }

  /**
   * The page behind UI port `owner` dropped `claim`'s signed bytes without
   * a proven verdict (the recovery screen was left on an unknown outcome)
   * while the port itself stays open. The claim is decided as if that port
   * had disconnected (see `releaseClaimsOwnedBy`), and only when `owner`
   * still owns it: a page that has since broadcast the claim itself holds
   * the bytes now. A claim no UI port owns (a provider claim, which its
   * request decides, or one minted outside a UI port) is left alone.
   */
  abandonBroadcastClaim(claim: QbitSendBroadcastClaim, owner?: QbitSendClaimOwner): Promise<void> {
    return this.enqueue(async () => {
      const normalized = normalizeBroadcastClaim(claim)
      if (!normalized || normalized.origin !== QBIT_WALLET_SEND_CLAIM_ORIGIN) return
      const held = this.broadcastClaims.find(item => sameBroadcastClaim(item, normalized))
      if (!held) return
      const key = claimKey(held)
      const record = this.ownership.get(key)
      if (!record || record.owner !== owner) return
      record.ownerGone = true
      this.releaseIfOrphaned(key)
    })
  }

  /**
   * Register again a wallet-owned claim the UI presents for a broadcast
   * when this instance has no record of it: neither held now nor already
   * decided since it started. That is what a background restart leaves
   * behind (the guard's memory is gone while the page keeps the signed
   * bytes and the claim minted for them), and the only state a claim may
   * be restored from. A claim this instance consumed was accepted by the
   * node, so its bytes must never be dispatched again on the strength of a
   * lookup miss, and one it released was abandoned together with its
   * bytes; both stay refused, as does a claim still held (nothing to
   * restore) and one whose inputs another claim or an external signing
   * lock reserves meanwhile. A provider claim is never restored: it belongs
   * to the dapp session that approved it, and the restart ended that
   * session with the claim. The caller has bound the claim to the bytes it
   * is about to dispatch (same network, txid and inputs); `address` is the
   * account those bytes are being dispatched for, and a claim filed under
   * another address is reported as `address_mismatch` rather than restored,
   * so the caller can say so. That check comes after this instance's own
   * record: a claim it consumed or released is `refused` whatever the
   * address.
   *
   * The restored claim is adopted by `owner` with one broadcast attempt
   * already in flight, as `beginBroadcastAttempt` would mark it, since the
   * caller dispatches next and a port disconnect landing in between must
   * defer to that verdict; the caller settles the attempt with
   * `settleBroadcastAttempt`. Nothing is registered unless `restored`, and
   * a claim over inputs a recent broadcast of another transaction spent is
   * `refused`.
   *
   * With `retryOfUnknownOutcome` (the page's own verdict for these bytes
   * is unknown), the restored claim's transaction counts as one whose
   * broadcast ended without a verdict (see `hasUnknownBroadcastOutcome`):
   * the bytes may have gone out before the restart, and this instance
   * cannot tell. Without it (a first broadcast, or a retry of bytes proven
   * not sent) it does not.
   *
   * A fee bump's claim names the transaction it `replaces`, and is restored
   * under the checks its minting applied: it is `refused` while a later
   * payment spends that transaction, and its broadcast checks again (see
   * `broadcastIfAllowed`). A claim that names nothing either way was minted
   * before claims carried the field and may be a bump that would evict
   * such a payment, so it is `refused`. What a claim names is still only
   * the page's word, and after a restart this instance has no record of
   * what spends its inputs to hold it against: a claim saying it replaces
   * nothing may replace a payment all the same. Every restored claim is
   * therefore marked unconfirmed, and its broadcast checks on the explorer
   * that nothing but its own transaction, or the one it names, spends its
   * inputs (see `broadcastIfAllowed`).
   */
  restoreBroadcastClaim(
    claim: QbitSendBroadcastClaim,
    address: string,
    owner?: QbitSendClaimOwner,
    retryOfUnknownOutcome = false
  ): Promise<'restored' | 'refused' | 'address_mismatch'> {
    return this.enqueue(async () => {
      const normalized = normalizeBroadcastClaim(claim)
      if (!normalized || normalized.origin !== QBIT_WALLET_SEND_CLAIM_ORIGIN) return 'refused'
      if (normalized.replaces === undefined) return 'refused'
      const key = claimKey(normalized)
      if (this.decidedClaimKeys.has(key)) return 'refused'
      if (this.broadcastClaims.some(item => claimKey(item) === key)) return 'refused'
      if (normalized.address !== address) return 'address_mismatch'
      const replacedTxid = replacedTxidOf(normalized)
      try {
        this.assertNoOverlapNow(normalized.chain as ChainType, normalized.outpoints)
        if (replacedTxid) {
          this.assertNoDependentSpendNow(normalized.chain as ChainType, replacedTxid)
        }
        this.assertNoRecentSpendConflictNow(
          normalized.chain as ChainType,
          normalized.txid,
          normalized.outpoints,
          replacedTxid
        )
      } catch {
        return 'refused'
      }
      this.replaceBroadcastClaims([...this.broadcastClaims, normalized])
      this.restoredClaimKeys.add(key)
      if (retryOfUnknownOutcome) {
        this.rememberUnknownBroadcastNow(normalized.chain as ChainType, normalized.txid)
      }
      const record = this.adoptClaim(normalized, owner)
      if (record) record.attempts += 1
      return 'restored'
    })
  }

  /**
   * Run `broadcast` for `txid` unless its inputs are claimed by another
   * send, externally locked, or spent by a recent broadcast of another
   * transaction; `claim`, when given, must be the held claim for exactly
   * this transaction, and is consumed once `broadcast` resolves.
   *
   * A fee bump's claim hands `broadcast` the txid it replaces, and how many
   * outputs that transaction has, after the guard's own records showed no
   * later payment spending it.
   * Those records cannot show a payment made elsewhere (another wallet on
   * the same seed, or a recipient spending their output), so `broadcast`
   * must check the explorer for one before it dispatches, and reject to
   * keep the bump from going out.
   *
   * A claim restored from the page's copy (see `restoreBroadcastClaim`)
   * hands `broadcast` `restoredFromPage` as well, whatever it replaces:
   * `broadcast` must then check on the explorer that nothing but `txid`, or
   * the transaction the claim replaces, spends any of `outpoints`, and
   * reject otherwise. Any other broadcast is handed false.
   */
  broadcastIfAllowed<T>(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    broadcast: (
      replaces: string | undefined,
      replacedOutputCount: number | undefined,
      restoredFromPage: boolean
    ) => Promise<T>,
    claim?: QbitSendBroadcastClaim
  ): Promise<T> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction broadcast'))
    }
    assertValidOutpoints(outpoints)
    const normalizedClaim = claim ? normalizeBroadcastClaim(claim) : undefined
    if (
      claim &&
      (!normalizedClaim ||
        normalizedClaim.chain !== chain ||
        normalizedClaim.txid !== txid ||
        normalizedClaim.outpoints.length !== outpoints.length ||
        !normalizedClaim.outpoints.every(
          (outpoint, index) => outpointKey(outpoint) === outpointKey(outpoints[index]!)
        ))
    ) {
      return Promise.reject(new Error('invalid Qbit send broadcast claim'))
    }

    return this.enqueue(async () => {
      const transactionOutpoints = new Set(outpoints.map(outpointKey))
      const overlappingClaims = this.broadcastClaims.filter(
        item =>
          item.chain === chain &&
          item.outpoints.some(outpoint => transactionOutpoints.has(outpointKey(outpoint)))
      )
      const exactClaim = normalizedClaim
        ? this.broadcastClaims.find(item => sameBroadcastClaim(item, normalizedClaim))
        : undefined
      if (overlappingClaims.length > 0 && !exactClaim) {
        throw new Error('Qbit transaction spends an input claimed by an approved send')
      }
      if (normalizedClaim && !exactClaim) {
        throw new QbitSendBroadcastClaimInactiveError()
      }
      const overlappingExternalLocks = this.externalSigningLocks.filter(
        lock =>
          lock.chain === chain &&
          lock.entries.some(entry =>
            entry.outpoints.some(outpoint => transactionOutpoints.has(outpointKey(outpoint)))
          )
      )
      if (overlappingExternalLocks.length > 0) {
        throw new Error('Qbit transaction spends an input locked by an external signing approval')
      }
      const replacedTxid = exactClaim ? replacedTxidOf(exactClaim) : undefined
      if (replacedTxid) this.assertNoDependentSpendNow(chain, replacedTxid)
      this.assertNoRecentSpendConflictNow(chain, txid, outpoints, replacedTxid)

      const restoredFromPage =
        exactClaim !== undefined && this.restoredClaimKeys.has(claimKey(exactClaim))
      const result = await broadcast(
        replacedTxid,
        exactClaim?.replacedOutputCount,
        restoredFromPage
      )
      // The claim is consumed, but its inputs stay reserved as recently
      // spent: the explorer may keep listing them for a while yet.
      this.recordSpendNow(chain, txid, outpoints, exactClaim?.address)
      this.forgetUnknownBroadcastNow(chain, txid)
      if (exactClaim) {
        this.replaceBroadcastClaims(
          this.broadcastClaims.filter(item => !sameBroadcastClaim(item, exactClaim))
        )
      }
      return result
    })
  }

  resetAllData(): Promise<void> {
    return this.enqueue(async () => {
      this.replaceBroadcastClaims([])
      this.externalSigningLocks = []
      this.recentSpends.clear()
      this.providerSendRequests.clear()
      this.providerSignings.clear()
      this.unknownBroadcasts.clear()
    })
  }

  /**
   * Every change to the claim list goes through here so ownership never
   * outlives its claim: a consumed, released, or reset claim drops its
   * record, and a later settle for it finds nothing to decide. The same
   * claim's key is recorded as decided, so it is never restored from a
   * UI's copy. A newly registered claim takes its place in the recording
   * order (see `claimSequences`).
   */
  private replaceBroadcastClaims(next: QbitSendBroadcastClaim[]): void {
    const live = new Set(next.map(claimKey))
    for (const claim of this.broadcastClaims) {
      const key = claimKey(claim)
      if (!live.has(key)) this.decidedClaimKeys.add(key)
    }
    this.broadcastClaims = next
    for (const key of live) {
      if (!this.claimSequences.has(key)) this.claimSequences.set(key, ++this.recentSpendSequence)
    }
    for (const key of this.claimSequences.keys()) {
      if (!live.has(key)) this.claimSequences.delete(key)
    }
    for (const key of this.ownership.keys()) {
      if (!live.has(key)) this.ownership.delete(key)
    }
    for (const key of this.providerClaimRequests.keys()) {
      if (!live.has(key)) this.providerClaimRequests.delete(key)
    }
    for (const key of this.restoredClaimKeys) {
      if (!live.has(key)) this.restoredClaimKeys.delete(key)
    }
  }

  /**
   * Run `operation` with `claim` just registered, and drop the claim again
   * if the operation fails: a failed signing leaves nothing behind.
   */
  private async keepClaimIfResolved<T>(
    claim: QbitSendBroadcastClaim,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      this.replaceBroadcastClaims(
        this.broadcastClaims.filter(item => !sameBroadcastClaim(item, claim))
      )
      throw error
    }
  }

  /** Consume the held claim `held`, recording its inputs as recently spent by its transaction. */
  private consumeHeldClaimNow(held: QbitSendBroadcastClaim): void {
    // Inputs already on record for this transaction (an inconclusive
    // attempt) keep their record, so a probe already under way still counts.
    this.recordSpendNow(
      held.chain as ChainType,
      held.txid,
      held.outpoints.filter(
        outpoint =>
          this.recentSpends.get(recentSpendKey(held.chain as ChainType, outpointKey(outpoint)))
            ?.spender !== held.txid
      ),
      held.address
    )
    this.replaceBroadcastClaims(this.broadcastClaims.filter(item => item !== held))
  }

  /** The open provider request whose approval carries exactly `claim`. */
  private providerSendRequestCarrying(claim: QbitSendBroadcastClaim): QbitProviderSendRequest {
    for (const [request, carried] of this.providerSendRequests) {
      if (sameBroadcastClaim(carried, claim)) return request
    }
    throw new Error('Qbit provider send request is no longer pending')
  }

  /**
   * Record `outpoints` as spent by `spender`. A record of another spender
   * (the original a fee bump takes over) is kept behind the new one, so the
   * input falls back to it if the new spender turns out absent; a record of
   * the same spender is refreshed. The oldest records beyond the limit go.
   */
  private recordSpendNow(
    chain: ChainType,
    spender: string,
    outpoints: readonly QbitOutpoint[],
    address: string | undefined
  ): void {
    const now = Date.now()
    for (const outpoint of outpoints) {
      const key = recentSpendKey(chain, outpointKey(outpoint))
      // Re-inserted so the map stays in recording order for the limit below.
      const previous = withoutSpender(this.recentSpends.get(key), spender)
      this.recentSpends.delete(key)
      const spend: QbitRecentSpend = {
        chain,
        address,
        outpoint: outpointKey(outpoint),
        spender,
        recordedAt: now,
        probedAt: now,
        liveAt: now,
        sequence: ++this.recentSpendSequence,
      }
      if (previous) spend.previous = previous
      this.recentSpends.set(key, spend)
    }
    // Claim-less records (a dapp's pushTx or pushPsbt) go first, so pushes
    // a dapp gets approved cannot crowd out the wallet's own sends.
    for (const claimless of [true, false]) {
      for (const [key, spend] of this.recentSpends) {
        if (this.recentSpends.size <= QBIT_RECENT_SPEND_LIMIT) return
        if ((spend.address === undefined) === claimless) this.recentSpends.delete(key)
      }
    }
  }

  /**
   * Drop `spend`'s spender from the input at `key`: the input falls back to
   * the record that spender replaced, which keeps its place in the
   * recording order, or is forgotten when there is none. The record that
   * comes back may be pending still and was not probed while hidden, so its
   * expiry restarts now.
   */
  private fallBackRecentSpendNow(key: string, spend: QbitRecentSpend): void {
    const previous = spend.previous
    if (!previous) {
      this.recentSpends.delete(key)
      return
    }
    previous.liveAt = Math.max(previous.liveAt, Date.now())
    this.recentSpends.set(key, previous)
  }

  private pruneRecentSpendsNow(now: number): void {
    for (const [key, spend] of this.recentSpends) {
      if (now - spend.liveAt >= QBIT_RECENT_SPEND_TTL_MS) this.recentSpends.delete(key)
    }
  }

  /**
   * Forget the inputs recorded as spent by `txid`, which is proven absent,
   * handing each back to the transaction it replaced, if any. A claim that
   * still holds them is left to its own release. Only in the same step as
   * the check that no call for `txid` ended without a verdict (see
   * `forgetProvenAbsentBroadcast`).
   */
  private forgetAbsentBroadcastNow(chain: ChainType, txid: string): void {
    for (const [key, spend] of this.recentSpends) {
      if (spend.chain !== chain) continue
      if (spend.spender === txid) {
        this.fallBackRecentSpendNow(key, spend)
      } else if (spend.previous) {
        // Nor may it come back later from behind a newer spender.
        const previous = withoutSpender(spend.previous, txid)
        if (previous) spend.previous = previous
        else delete spend.previous
      }
    }
  }

  /** Remember `txid` for `hasUnknownBroadcastOutcome`, as the newest. */
  private rememberUnknownBroadcastNow(chain: ChainType, txid: string): void {
    const key = claimKey({ chain, txid })
    this.unknownBroadcasts.delete(key)
    this.unknownBroadcasts.set(key, this.recentSpendSequence)
    for (const oldest of this.unknownBroadcasts.keys()) {
      if (this.unknownBroadcasts.size <= QBIT_UNKNOWN_BROADCAST_LIMIT) return
      this.unknownBroadcasts.delete(oldest)
    }
  }

  /**
   * The guard settled `txid`: the network was seen holding it, or a probe
   * found it gone and its inputs were freed. An unknown outcome remembered
   * for it no longer stands against a later call's rejection; with
   * `recordedBy`, only one remembered no later than that point in the
   * recording order, which the answer can speak for.
   */
  private forgetUnknownBroadcastNow(chain: ChainType, txid: string, recordedBy?: number): void {
    const key = claimKey({ chain, txid })
    const recordedAt = this.unknownBroadcasts.get(key)
    if (recordedAt === undefined) return
    if (recordedBy === undefined || recordedAt <= recordedBy) this.unknownBroadcasts.delete(key)
  }

  private hasUnknownBroadcastOutcomeNow(chain: ChainType, txid: string): boolean {
    const key = claimKey({ chain, txid })
    return this.unknownBroadcasts.has(key) || this.ownership.get(key)?.inconclusive === true
  }

  /**
   * Refuse a transaction `txid` that spends an input a recent broadcast of
   * another transaction spent. The same transaction may go out again (a
   * byte-identical retry or rebroadcast), and `replaces` names the one
   * transaction whose inputs a fee bump may take over. A fee bump is built
   * from its original's inputs, so `replaces` counts only for a transaction
   * that spends every input recorded for it; any other is refused like a
   * plain conflicting send.
   */
  private assertNoRecentSpendConflictNow(
    chain: ChainType,
    txid: string | undefined,
    outpoints: readonly QbitOutpoint[],
    replaces?: string
  ): void {
    this.pruneRecentSpendsNow(Date.now())
    if (replaces !== undefined) {
      const spent = new Set(outpoints.map(outpointKey))
      for (const spend of this.recentSpends.values()) {
        if (spend.chain === chain && spend.spender === replaces && !spent.has(spend.outpoint)) {
          replaces = undefined
          break
        }
      }
    }
    const conflict = outpoints.some(outpoint => {
      const spend = this.recentSpends.get(recentSpendKey(chain, outpointKey(outpoint)))
      return spend !== undefined && spend.spender !== txid && spend.spender !== replaces
    })
    if (conflict) {
      throw new Error('Qbit transaction spends an input a recent broadcast already spent')
    }
  }

  private hasDependentSpendNow(chain: ChainType, txid: string): boolean {
    this.pruneRecentSpendsNow(Date.now())
    const spendsOutputOfTxid = (outpoint: QbitOutpoint) => outpoint.txid === txid
    return (
      this.broadcastClaims.some(
        claim => claim.chain === chain && claim.outpoints.some(spendsOutputOfTxid)
      ) ||
      this.externalSigningLocks.some(
        lock =>
          lock.chain === chain &&
          lock.entries.some(entry => entry.outpoints.some(spendsOutputOfTxid))
      ) ||
      [...this.recentSpends.values()].some(
        spend => spend.chain === chain && spend.outpoint.startsWith(`${txid}:`)
      )
    )
  }

  /**
   * A fee bump of `replaces` is assessed against the transactions spending
   * its original's outputs, but a send can take the original's change while
   * the bump waits to be signed or broadcast. Admitting its claim (before a
   * local key signs it, after an external signer has, or when a restart
   * left only the page's copy) and broadcasting it check again, in the same
   * step that admits the claim or the broadcast.
   */
  private assertNoDependentSpendNow(chain: ChainType, replaces: string): void {
    if (this.hasDependentSpendNow(chain, replaces)) {
      throw new Error('A later payment depends on the transaction this fee bump replaces')
    }
  }

  /**
   * Give a wallet-owned, currently held claim to `owner`, creating or
   * re-pointing its record. Provider claims and unowned calls get none.
   */
  private adoptClaim(
    claim: QbitSendBroadcastClaim,
    owner: QbitSendClaimOwner | undefined
  ): QbitSendClaimOwnership | undefined {
    const key = claimKey(claim)
    const record = this.ownership.get(key)
    if (
      owner === undefined ||
      claim.origin !== QBIT_WALLET_SEND_CLAIM_ORIGIN ||
      !this.broadcastClaims.some(item => claimKey(item) === key)
    ) {
      return record
    }
    if (record) {
      record.owner = owner
      record.ownerGone = false
      return record
    }
    const created: QbitSendClaimOwnership = {
      owner,
      ownerGone: false,
      attempts: 0,
      inconclusive: false,
    }
    this.ownership.set(key, created)
    return created
  }

  /**
   * Decide the claim at `key` once its owner is gone and no broadcast
   * attempt is in flight. Its bytes went with the page, so nothing can
   * retry them: a claim whose last dispatched verdict was inconclusive is
   * consumed into recent spends, which keep its inputs reserved until a
   * lifecycle probe finds its transaction confirmed or gone (or the
   * backstop expires them), and any other is released.
   */
  private releaseIfOrphaned(key: string): void {
    const record = this.ownership.get(key)
    if (!record || !record.ownerGone || record.attempts > 0) return
    const held = this.broadcastClaims.find(item => claimKey(item) === key)
    if (!held) return
    if (record.inconclusive) {
      this.consumeHeldClaimNow(held)
    } else {
      this.replaceBroadcastClaims(this.broadcastClaims.filter(item => item !== held))
    }
  }

  /**
   * Probe `probe` found its spender `state` on `chain`: the network holds
   * that transaction, so a wallet-owned claim still held for exactly it is
   * decided. A pending one is consumed into recent spends, as a status
   * check finding it would consume it, and a confirmed one is dropped,
   * since a block spends its inputs for good. Only a claim registered
   * before the probe was handed out: a later one may be for the same bytes
   * signed again after the transaction left the mempool, which the answer
   * cannot speak for. A provider claim is left to its request's settlement.
   */
  private settleClaimFoundNow(
    chain: ChainType,
    probe: QbitRecentSpendProbe,
    state: 'confirmed' | 'pending'
  ): void {
    const held = this.broadcastClaims.find(item => item.chain === chain && item.txid === probe.txid)
    const registered = held ? this.claimSequences.get(claimKey(held)) : undefined
    if (
      !held ||
      held.origin !== QBIT_WALLET_SEND_CLAIM_ORIGIN ||
      registered === undefined ||
      registered > probe.sequence
    ) {
      return
    }
    if (state === 'pending') {
      this.consumeHeldClaimNow(held)
    } else {
      this.replaceBroadcastClaims(this.broadcastClaims.filter(item => item !== held))
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private assertNoOverlapNow(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    ignoredExternalSigningLockId?: string
  ): void {
    assertValidOutpoints(outpoints)
    const claimed = new Set(
      this.broadcastClaims
        .filter(claim => claim.chain === chain)
        .flatMap(claim => claim.outpoints.map(outpointKey))
    )
    if (outpoints.some(outpoint => claimed.has(outpointKey(outpoint)))) {
      throw new Error('Qbit transaction spends an input claimed by an approved send')
    }
    const externallyLocked = new Set(
      this.externalSigningLocks
        .filter(lock => lock.chain === chain && lock.id !== ignoredExternalSigningLockId)
        .flatMap(lock => lock.entries.flatMap(entry => entry.outpoints.map(outpointKey)))
    )
    if (outpoints.some(outpoint => externallyLocked.has(outpointKey(outpoint)))) {
      throw new Error('Qbit transaction spends an input locked by an external signing approval')
    }
  }

  private activeExternalSigningLock(
    lock: QbitExternalSigningLock,
    purpose: QbitExternalSigningLockPurpose
  ): QbitExternalSigningLock {
    const normalized = normalizeExternalSigningLock(lock)
    if (!normalized || normalized.purpose !== purpose) {
      throw new Error('invalid external Qbit signing lock')
    }
    const active = this.externalSigningLocks.find(item => sameExternalSigningLock(item, normalized))
    if (!active) throw new Error('external Qbit signing lock is not active')
    return active
  }

  private sameOutpoints(
    left: readonly QbitOutpoint[],
    right: readonly QbitOutpoint[]
  ): boolean {
    return (
      left.length === right.length &&
      left.every((outpoint, index) => outpointKey(outpoint) === outpointKey(right[index]!))
    )
  }

  private normalizeAvailableBroadcastClaim(claim: QbitSendBroadcastClaim): QbitSendBroadcastClaim {
    const normalized = normalizeBroadcastClaim(claim)
    if (!normalized) throw new Error('invalid Qbit send broadcast claim')
    if (
      this.broadcastClaims.some(
        item => item.chain === normalized.chain && item.txid === normalized.txid
      )
    ) {
      throw new Error('Qbit send broadcast claim already exists')
    }
    this.assertNoOverlapNow(normalized.chain as ChainType, normalized.outpoints)
    return normalized
  }
}

export default new QbitSendGuardService()
