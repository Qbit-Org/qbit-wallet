import type {
  QbitExternalSigningLock,
  QbitExternalSigningLockEntry,
  QbitExternalSigningLockPurpose,
  QbitSendBroadcastClaim,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import {
  qbitExplorerSpendCheckFor,
  type QbitExplorerSpendCheck,
} from '../utils/qbit-explorer-spend-check'

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
 * Marks an operation handed to `QbitSendGuardService.runWithNoOverlap` as
 * the signing of transaction `txid` for a dapp (provider signPsbt and
 * signPsbts), whose signed bytes the dapp may broadcast at any time. The
 * guard records that signing with its inputs (see `recordProviderSigning`)
 * in the same step as the overlap check, before the operation makes a
 * signature, so a send plan can never hold the inputs in between: either
 * the plan holds them first and the signing is refused, or the record is
 * there first and the plan's hold is refused. An operation that fails
 * handed the dapp nothing, and the record goes back to what it was.
 */
export const QBIT_PROVIDER_SIGNING: unique symbol = Symbol('qbitProviderSigning')

/** An operation `runWithNoOverlap` may run, marked or not with `QBIT_PROVIDER_SIGNING`. */
export type QbitNoOverlapOperation<T> = (() => Promise<T>) & {
  [QBIT_PROVIDER_SIGNING]?: true
}

/**
 * What one send plan holds: outpoints of one account on one network, owned
 * by the plan's id. They are the plan's inputs and the outputs its merges
 * will create, which need not exist yet. See
 * `QbitSendGuardService.holdOutpointsForPlan`.
 */
export interface QbitSendPlanOutpoints {
  /** The plan's id: 32 lower-case hex characters. */
  planId: string
  chain: ChainType
  address: string
  outpoints: readonly QbitOutpoint[]
}

/**
 * The authority to spend what one send plan holds. The guard mints one when
 * it takes or restores a plan's hold, and admits a spend of held outpoints
 * only for that very object while the hold lasts. Nothing that crossed a UI
 * or provider port is that object, and neither is one built elsewhere for
 * the same plan id, so a hold is lifted neither by leaving it out nor by a
 * string a page supplies.
 */
export class QbitSendPlanHold {
  /** Never set: it only makes the type nominal, so a look-alike object is no hold. */
  declare private readonly nominal: never

  constructor(readonly planId: string) {
    Object.freeze(this)
  }
}

/**
 * A step of a send plan that replaces an earlier version of itself still in
 * the network (a merge whose fee the plan raised): the transaction it
 * replaces, and how many outputs that one has. The guard admits it only
 * under the plan's own hold, and only when that plan holds every output of
 * the transaction it replaces: a plan replaces nothing but its own merge,
 * and nothing replaces a plan's merge but its plan.
 */
export interface QbitSendPlanReplacement {
  /** The txid of the version being replaced. */
  replaces: string
  outputCount: number
}

/** `value` as a plan replacement, or nothing when it is not one. */
function normalizePlanReplacement(value: unknown): QbitSendPlanReplacement | undefined {
  if (!value || typeof value !== 'object') return
  const { replaces, outputCount } = value as Partial<QbitSendPlanReplacement>
  if (
    !isTxid(replaces) ||
    typeof outputCount !== 'number' ||
    !Number.isSafeInteger(outputCount) ||
    outputCount < 1
  ) {
    return
  }
  return { replaces, outputCount }
}

/** What a send plan's hold met on one of its outpoints; see `QbitSendPlanHoldConflictError`. */
export type QbitSendPlanHoldConflictKind =
  | 'broadcast_claim'
  | 'external_signing_lock'
  | 'recent_spend'
  | 'provider_send_request'
  | 'provider_signing'
  | 'plan_hold'

export interface QbitSendPlanHoldConflict {
  /** `txid:vout`. */
  outpoint: string
  kind: QbitSendPlanHoldConflictKind
  /** With `plan_hold`: the other plan holding the outpoint. */
  planId?: string
  /**
   * With `recent_spend`: the transaction a broadcast recorded as spending
   * the outpoint, which may be one of the plan's own (see
   * `restorePlanHolds`).
   */
  spender?: string
}

/**
 * Thrown when a plan's hold cannot be taken or replaced because something
 * else holds one of its outpoints. The call changed nothing: a plan that
 * held nothing still holds nothing, and one that held outpoints keeps
 * exactly those.
 */
export class QbitSendPlanHoldConflictError extends Error {
  constructor(
    readonly planId: string,
    readonly conflicts: readonly QbitSendPlanHoldConflict[]
  ) {
    super('Qbit send plan outputs are held by another send')
    this.name = 'QbitSendPlanHoldConflictError'
  }
}

/**
 * Why a guard entry point refused a spend over outpoints a send plan holds:
 * `held`, a plan the caller did not present holds one of them; `not_held`,
 * the plan the caller presented does not hold every one of them;
 * `inactive`, the presented hold is not one this guard holds now (it was
 * released, or never minted here).
 */
export type QbitSendPlanHeldReason = 'held' | 'not_held' | 'inactive'

const QBIT_SEND_PLAN_HELD_MESSAGES: Record<QbitSendPlanHeldReason, string> = {
  held: 'Qbit transaction spends an input held by an open send plan',
  not_held: 'Qbit transaction spends an input its send plan does not hold',
  inactive: 'Qbit send plan hold is not active',
}

/**
 * The code a `QbitSendPlanHeldError` carries: errors cross a UI port as
 * plain objects that keep a `code`, never their class.
 */
export const QBIT_SEND_PLAN_HELD_CODE = 'QBIT_SEND_PLAN_HELD'

/** A spend refused over outpoints a send plan holds; see `QbitSendPlanHeldReason`. */
export class QbitSendPlanHeldError extends Error {
  readonly code = QBIT_SEND_PLAN_HELD_CODE

  constructor(readonly reason: QbitSendPlanHeldReason) {
    super(QBIT_SEND_PLAN_HELD_MESSAGES[reason])
    this.name = 'QbitSendPlanHeldError'
  }
}

/** What `QbitSendGuardService.restorePlanHolds` did with the records it was handed. */
export interface QbitSendPlanHoldRestoration {
  /** The hold of every plan restored, conflicting ones included, by plan id. */
  holds: Map<string, QbitSendPlanHold>
  /**
   * The restored plans whose outpoints something else holds too, and what.
   * Such a plan is held in full all the same, so no outpoint of it becomes
   * spendable, and the shared outpoints stay unspendable, for it and for the
   * other holder alike, until one of them lets go. A conflict between two
   * plans is listed under each of them.
   */
  conflicts: { planId: string; conflicts: QbitSendPlanHoldConflict[] }[]
  /** The records not restored, being malformed, by position in the input. */
  invalid: { index: number; planId?: string }[]
}

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

/** A send plan's id, as its stored record names it. */
const QBIT_SEND_PLAN_ID = /^[0-9a-f]{32}$/

/** One plan's hold, keyed in `QbitSendGuardService.planHolds` by the plan's id. */
interface QbitPlanHoldRecord {
  /** The authority minted for it; only this object lifts the hold. */
  hold: QbitSendPlanHold
  chain: ChainType
  address: string
  /** Outpoint keys (`txid:vout`). */
  outpoints: Set<string>
}

/** A transaction the user approved signing for a dapp; see `QbitSendGuardService.providerSignings`. */
interface QbitProviderSigning {
  chain: ChainType
  /** Outpoint keys of its inputs, when the caller recorded them. */
  outpoints: readonly string[] | undefined
}

/**
 * `value` copied as a plan's hold, or nothing when it is not one: a plan id,
 * a Qbit network, an address and at least one outpoint, none twice.
 */
function normalizePlanOutpoints(value: unknown): QbitSendPlanOutpoints | undefined {
  if (!value || typeof value !== 'object') return
  const entry = value as Partial<QbitSendPlanOutpoints>
  if (
    typeof entry.planId !== 'string' ||
    !QBIT_SEND_PLAN_ID.test(entry.planId) ||
    !QBIT_CHAINS.has(entry.chain as ChainType) ||
    typeof entry.address !== 'string' ||
    entry.address.length === 0 ||
    !Array.isArray(entry.outpoints)
  ) {
    return
  }
  const listed: readonly unknown[] = entry.outpoints
  const outpoints = listed
    .map(normalizeOutpoint)
    .filter((outpoint): outpoint is QbitOutpoint => Boolean(outpoint))
  if (outpoints.length === 0 || outpoints.length !== listed.length) return
  if (new Set(outpoints.map(outpointKey)).size !== outpoints.length) return
  return {
    planId: entry.planId,
    chain: entry.chain as ChainType,
    address: entry.address,
    outpoints,
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
   * reserved (see `recordInconclusiveProviderPush`), and a send plan cannot
   * hold the inputs recorded for one (see `holdOutpointsForPlan`). Memory
   * only, like the claims, and bounded by `QBIT_PROVIDER_SIGNING_LIMIT`.
   */
  private providerSignings = new Map<string, QbitProviderSigning>()
  /**
   * The open send plans' holds, by plan id (see `holdOutpointsForPlan`).
   * Memory only, like the claims: the plan store keeps the plans, and the
   * holds are restored from it when the background starts
   * (`restorePlanHolds`).
   */
  private planHolds = new Map<string, QbitPlanHoldRecord>()
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
    this.planHolds.clear()
  }

  /**
   * Every input of `address` on `chain` that a send must not select: the
   * ones held by a claim, an external signing lock or a send plan, and the
   * ones a recent broadcast spent (including claim-less ones, whose account
   * is unknown). With `exceptPlanId`, what that plan holds is left out, and
   * only that: a replan reads which of its plan's own outputs it may spend
   * again, and everything else still reserves them. It is a read, so a plan
   * id grants nothing here.
   */
  getReservedOutpointKeys(
    chain: ChainType,
    address: string,
    exceptPlanId?: string
  ): Promise<Set<string>> {
    return this.enqueue(async () => this.reservedOutpointKeysNow(chain, address, exceptPlanId))
  }

  /**
   * Every outpoint a send plan of `address` on `chain` must not spend:
   * what `getReservedOutpointKeys` lists for the account, and every
   * outpoint a hold of that plan would be refused on (see
   * `holdOutpointsForPlan`), an input of a transaction the user signed for
   * a dapp and an open provider send request's included, on any account of
   * the network. A plan prepared from what is left is never refused its own
   * hold, as a plan prepared over a dapp's signed bytes, which the signing's
   * record keeps from it with no expiry, would be at every start. With
   * `exceptPlanId`, what that plan holds is left out, and only that, as for
   * `getReservedOutpointKeys`. It is a read, so a plan id grants nothing
   * here.
   */
  getPlanUnavailableOutpointKeys(
    chain: ChainType,
    address: string,
    exceptPlanId?: string
  ): Promise<Set<string>> {
    return this.enqueue(async () => {
      const keys = this.reservedOutpointKeysNow(chain, address, exceptPlanId)
      const blockers = this.planHoldBlockersNow(chain, exceptPlanId)
      for (const held of [
        blockers.claimed,
        blockers.locked,
        blockers.spent,
        blockers.requested,
        blockers.signed,
        ...blockers.plans.values(),
      ]) {
        for (const key of held) keys.add(key)
      }
      return keys
    })
  }

  /** `getReservedOutpointKeys` in the queue. */
  private reservedOutpointKeysNow(
    chain: ChainType,
    address: string,
    exceptPlanId: string | undefined
  ): Set<string> {
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
    const planHolds = [...this.planHolds]
      .filter(
        ([planId, hold]) =>
          planId !== exceptPlanId && hold.chain === chain && hold.address === address
      )
      .map(([, hold]) => hold)
    return new Set([
      ...claims.flatMap(item => item.outpoints.map(outpointKey)),
      ...externalLocks.flatMap(lock =>
        lock.entries.flatMap(entry => entry.outpoints.map(outpointKey))
      ),
      ...recentSpends.map(spend => spend.outpoint),
      ...planHolds.flatMap(hold => [...hold.outpoints]),
    ])
  }

  /**
   * Take a hold on `outpoints` of `address` on `chain` for send plan
   * `planId`: the plan's inputs and the outputs its merges will create. While
   * the hold lasts, every entry point that admits a spend refuses one over a
   * held outpoint unless the caller presents the returned hold (see
   * `QbitSendPlanHold`); `getReservedOutpointKeys` lists them, and
   * `hasDependentSpend` counts them.
   *
   * All or nothing: the hold is refused with a
   * `QbitSendPlanHoldConflictError`, and nothing is held, when any outpoint
   * is held by a broadcast claim, an external signing lock, an open provider
   * send request or another plan, was spent by a recent broadcast, or is an
   * input of a transaction the user signed for a dapp (as far as
   * `recordProviderSigning` was told its inputs). Taking the same hold again
   * (same plan, account and outpoints) changes nothing and returns the hold
   * already minted; a plan that holds anything else changes what it holds
   * with `replacePlanOutpoints`.
   */
  holdOutpointsForPlan(entry: QbitSendPlanOutpoints): Promise<QbitSendPlanHold> {
    const normalized = normalizePlanOutpoints(entry)
    if (!normalized) return Promise.reject(new Error('invalid Qbit send plan hold'))
    return this.enqueue(async () => {
      const { planId, chain, address } = normalized
      const keys = normalized.outpoints.map(outpointKey)
      const current = this.planHolds.get(planId)
      if (current) {
        if (
          current.chain === chain &&
          current.address === address &&
          current.outpoints.size === keys.length &&
          keys.every(key => current.outpoints.has(key))
        ) {
          return current.hold
        }
        throw new Error('Qbit send plan already holds other outputs')
      }
      const conflicts = this.planHoldConflictsNow(chain, keys, planId)
      if (conflicts.length > 0) throw new QbitSendPlanHoldConflictError(planId, conflicts)
      const hold = new QbitSendPlanHold(planId)
      this.planHolds.set(planId, { hold, chain, address, outpoints: new Set(keys) })
      return hold
    })
  }

  /**
   * Swap what plan `planId` holds for `outpoints`, in one step: a revised
   * plan (a replaced merge, a re-priced payment) holds its new outpoints from
   * the moment it lets go of the old ones. An outpoint the plan holds already
   * passes as it is; every other one is refused exactly as
   * `holdOutpointsForPlan` refuses it, and on refusal the plan keeps what it
   * held. The account is the one the hold was taken for, and the plan keeps
   * the same `QbitSendPlanHold`. A plan holding nothing has nothing to
   * replace (`QbitSendPlanHeldError`, `inactive`).
   */
  replacePlanOutpoints(entry: QbitSendPlanOutpoints): Promise<QbitSendPlanHold> {
    const normalized = normalizePlanOutpoints(entry)
    if (!normalized) return Promise.reject(new Error('invalid Qbit send plan hold'))
    return this.enqueue(async () => {
      const { planId, chain, address } = normalized
      const current = this.planHolds.get(planId)
      if (!current) throw new QbitSendPlanHeldError('inactive')
      if (current.chain !== chain || current.address !== address) {
        throw new Error('Qbit send plan holds outputs of another account')
      }
      const keys = normalized.outpoints.map(outpointKey)
      const conflicts = this.planHoldConflictsNow(
        chain,
        keys.filter(key => !current.outpoints.has(key)),
        planId
      )
      if (conflicts.length > 0) throw new QbitSendPlanHoldConflictError(planId, conflicts)
      current.outpoints = new Set(keys)
      return current.hold
    })
  }

  /**
   * Let go of what plan `planId` holds: everything, or only `outpoints` (a
   * cancelled plan lets go of what is safe at once and keeps the inputs of a
   * merge whose broadcast outcome is unknown until that resolves). A plan
   * left holding nothing has no hold any more, and its `QbitSendPlanHold`
   * lifts nothing. Outpoints the plan does not hold, and a plan id that
   * holds nothing, are ignored. Resolves to whether anything was let go of.
   * Inputs a broadcast spent stay reserved as recently spent all the same.
   */
  releasePlanOutpoints(planId: string, outpoints?: readonly QbitOutpoint[]): Promise<boolean> {
    let keys: string[] | undefined
    if (outpoints !== undefined) {
      if (!Array.isArray(outpoints)) return Promise.reject(new Error('invalid Qbit send plan hold'))
      keys = []
      for (const value of outpoints as readonly unknown[]) {
        const outpoint = normalizeOutpoint(value)
        if (!outpoint) return Promise.reject(new Error('invalid Qbit send plan hold'))
        keys.push(outpointKey(outpoint))
      }
    }
    return this.enqueue(async () => {
      const current = this.planHolds.get(planId)
      if (!current) return false
      if (!keys) {
        this.planHolds.delete(planId)
        return true
      }
      let released = false
      for (const key of keys) {
        if (current.outpoints.delete(key)) released = true
      }
      if (current.outpoints.size === 0) this.planHolds.delete(planId)
      return released
    })
  }

  /**
   * Hold again what the stored plans held before the background restarted
   * (see the plan store's holds). Each record is taken as it is: one never
   * fails because another overlaps it, and nothing is dropped to resolve an
   * overlap. A plan is held in full even over outpoints something else
   * holds; each such overlap is reported (see
   * `QbitSendPlanHoldRestoration.conflicts`), so the caller can pause the
   * plans concerned. A recent spend names the transaction recorded as its
   * spender, which may be one of the plan's own: a guard that outlived the
   * plans' sessions (a reset that failed) still has what their broadcasts
   * recorded, and the caller tells those apart. A malformed record is reported and left out. A plan
   * holding outpoints already keeps them and holds the record's as well,
   * under the hold already minted; one held for another account is
   * reported as malformed.
   */
  restorePlanHolds(
    entries: readonly QbitSendPlanOutpoints[]
  ): Promise<QbitSendPlanHoldRestoration> {
    const listed: readonly unknown[] = Array.isArray(entries) ? entries : []
    const normalized = listed.map(normalizePlanOutpoints)
    return this.enqueue(async () => {
      const holds = new Map<string, QbitSendPlanHold>()
      const conflicts = new Map<string, QbitSendPlanHoldConflict[]>()
      const invalid: QbitSendPlanHoldRestoration['invalid'] = []
      const report = (planId: string, conflict: QbitSendPlanHoldConflict): void => {
        const list = conflicts.get(planId)
        if (list) list.push(conflict)
        else conflicts.set(planId, [conflict])
      }
      normalized.forEach((entry, index) => {
        const current = entry ? this.planHolds.get(entry.planId) : undefined
        if (
          !entry ||
          (current && (current.chain !== entry.chain || current.address !== entry.address))
        ) {
          const planId = (listed[index] as Partial<QbitSendPlanOutpoints> | undefined)?.planId
          invalid.push(typeof planId === 'string' ? { index, planId } : { index })
          return
        }
        const keys = entry.outpoints.map(outpointKey)
        const added = current ? keys.filter(key => !current.outpoints.has(key)) : keys
        for (const conflict of this.planHoldConflictsNow(entry.chain, added, entry.planId)) {
          report(entry.planId, conflict)
          if (conflict.kind === 'plan_hold' && conflict.planId !== undefined) {
            report(conflict.planId, {
              outpoint: conflict.outpoint,
              kind: 'plan_hold',
              planId: entry.planId,
            })
          }
        }
        if (current) {
          for (const key of added) current.outpoints.add(key)
          holds.set(entry.planId, current.hold)
          return
        }
        const hold = new QbitSendPlanHold(entry.planId)
        this.planHolds.set(entry.planId, {
          hold,
          chain: entry.chain,
          address: entry.address,
          outpoints: new Set(keys),
        })
        holds.set(entry.planId, hold)
      })
      return {
        holds,
        conflicts: [...conflicts].map(([planId, list]) => ({ planId, conflicts: list })),
        invalid,
      }
    })
  }

  /**
   * Whether a claim, an external signing lock, a send plan's hold or a
   * recent broadcast on `chain`, under any account, spends (or will spend)
   * an output of `txid`. Replacing `txid` would evict that later
   * transaction; a plan holding an output of its merge spends it with its
   * payment.
   */
  hasDependentSpend(chain: ChainType, txid: string): Promise<boolean> {
    return this.enqueue(async () => this.hasDependentSpendNow(chain, txid.toLowerCase()))
  }

  /**
   * The outpoints send plans hold on `chain`, under any account, as
   * `txid:vout` keys: a spend of one is refused unless it presents that
   * plan's hold (`assertPlanHoldsAllowNow`), whatever it is. A fee bump
   * presents none: its claim over the inputs of the transaction it
   * replaces is refused while a plan holds one of them, as a completed
   * plan holds its payment's until the payment confirms or the plan is
   * dismissed. A fee bump's assessment reads them, so that it never
   * offers a bump whose claim would be refused for it.
   */
  getPlanHeldOutpointKeys(chain: ChainType): Promise<Set<string>> {
    return this.enqueue(async () => this.planHeldKeysNow(chain))
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
   * inputs no other transaction is recorded as spending and no claim,
   * external signing lock or send plan holds. A dispatched
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
        ...[...this.planHolds.values()]
          .filter(hold => hold.chain === chain)
          .flatMap(hold => [...hold.outpoints]),
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
   * without a verdict (`recordInconclusiveProviderPush`). With `outpoints`,
   * the transaction's inputs, no send plan can take a hold on them while
   * the signing is remembered: the dapp may broadcast the bytes at any time.
   * Recording the same transaction again makes it the newest, and keeps the
   * inputs recorded for it before when it names none.
   */
  recordProviderSigning(
    chain: ChainType,
    txid: string,
    outpoints?: readonly QbitOutpoint[]
  ): Promise<void> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction'))
    }
    if (outpoints !== undefined) {
      try {
        assertValidOutpoints(outpoints)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const inputs = outpoints?.map(outpointKey)
    return this.enqueue(async () => {
      this.recordProviderSigningNow(chain, txid, inputs)
    })
  }

  /**
   * `recordProviderSigning` in the queue: the newest record of `txid`, with
   * `inputs` or else the ones recorded for it before, within the limit.
   */
  private recordProviderSigningNow(
    chain: ChainType,
    txid: string,
    inputs: readonly string[] | undefined
  ): void {
    const key = claimKey({ chain, txid })
    const previous = this.providerSignings.get(key)
    this.providerSignings.delete(key)
    this.providerSignings.set(key, { chain, outpoints: inputs ?? previous?.outpoints })
    for (const oldest of this.providerSignings.keys()) {
      if (this.providerSignings.size <= QBIT_PROVIDER_SIGNING_LIMIT) return
      this.providerSignings.delete(oldest)
    }
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

  /**
   * `runWithNoOverlap` with nothing to run: whether the inputs could be
   * signed now. `planHold` and `planReplacement` as there.
   */
  assertNoOverlap(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    txid?: string,
    planHold?: QbitSendPlanHold,
    planReplacement?: QbitSendPlanReplacement
  ): Promise<void> {
    return this.runWithNoOverlap(
      chain,
      outpoints,
      async () => undefined,
      txid,
      planHold,
      planReplacement
    )
  }

  /**
   * Run `operation` (signing without a send claim) unless the inputs are
   * claimed, externally locked, held by a send plan, or spent by a recent
   * broadcast of another transaction. Signed bytes leave the wallet and can
   * be broadcast anywhere, so a signature over a recently spent input could
   * replace the payment that spent it; `txid` names the transaction being
   * signed, which may itself be the recorded spender. Without it, any
   * recorded spend refuses.
   *
   * `planHold` is the hold of the send plan the transaction is a step of:
   * with it, every input must be held by that plan (and by no other); see
   * `QbitSendPlanHold`. With it, `planReplacement` names the earlier version
   * of the step that `txid` replaces (see `QbitSendPlanReplacement`), whose
   * inputs a recent broadcast of that version spent. An operation marked
   * `QBIT_PROVIDER_SIGNING` signs `txid` for a dapp, and is recorded as such
   * in the same step; when it fails, the remembered signings are left
   * exactly as they were before it.
   */
  runWithNoOverlap<T>(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    operation: QbitNoOverlapOperation<T>,
    txid?: string,
    planHold?: QbitSendPlanHold,
    planReplacement?: QbitSendPlanReplacement
  ): Promise<T> {
    let replacement: QbitSendPlanReplacement | undefined
    try {
      replacement = this.readPlanReplacement(planReplacement, planHold, txid)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      this.assertNoOverlapNow(chain, outpoints, undefined, planHold)
      const replaces = this.planReplacementNow(chain, planHold, replacement)
      this.assertNoRecentSpendConflictNow(chain, txid, outpoints, replaces)
      if (operation[QBIT_PROVIDER_SIGNING] !== true) return operation()
      if (txid === undefined || !isTxid(txid) || !QBIT_CHAINS.has(chain)) {
        throw new Error('invalid Qbit transaction')
      }
      const key = claimKey({ chain, txid })
      // A signing that fails leaves the remembered signings as they were,
      // in their order: its own record goes, an earlier record of the same
      // transaction keeps its place, and the oldest one its record pushed
      // out at the limit is remembered again.
      const remembered = [...this.providerSignings]
      this.recordProviderSigningNow(chain, txid, outpoints.map(outpointKey))
      const recorded = this.providerSignings.get(key)
      try {
        return await operation()
      } catch (error) {
        // Unless the guard was reset meanwhile, which forgot them all.
        if (recorded !== undefined && this.providerSignings.get(key) === recorded) {
          this.providerSignings.clear()
          for (const [entryKey, signing] of remembered) {
            this.providerSignings.set(entryKey, signing)
          }
        }
        throw error
      }
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
   *
   * A claim may not spend an input a send plan holds, unless `planHold` is
   * that plan's hold and the plan holds every input (see `runWithNoOverlap`);
   * a fee bump presenting it may then replace a transaction whose outputs
   * only that plan holds.
   */
  runWithBroadcastClaim<T>(
    claim: QbitSendBroadcastClaim,
    operation: () => Promise<T>,
    owner?: QbitSendClaimOwner,
    planHold?: QbitSendPlanHold
  ): Promise<T> {
    return this.enqueue(async () => {
      const normalized = this.normalizeAvailableBroadcastClaim(claim, planHold)
      const replacedTxid = replacedTxidOf(normalized)
      if (replacedTxid) {
        this.assertNoDependentSpendNow(normalized.chain as ChainType, replacedTxid, planHold)
      }
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
   * refused. So is a request over an input a send plan holds: a website's
   * request never spends what a plan holds.
   */
  openProviderSendRequest(claim: QbitSendBroadcastClaim): Promise<QbitProviderSendRequest> {
    return this.enqueue(async () => {
      const normalized = normalizeBroadcastClaim(claim)
      if (!normalized || normalized.origin === QBIT_WALLET_SEND_CLAIM_ORIGIN) {
        throw new Error('invalid Qbit send broadcast claim')
      }
      this.assertPlanHoldsAllowNow(normalized.chain as ChainType, normalized.outpoints, undefined)
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
   * `broadcast` is handed what it must check on the explorer before it
   * dispatches, and must reject to keep the transaction from going out when
   * the check fails. A fee bump's claim hands it the txid it `replaces`, and
   * how many outputs that transaction has, after the guard's own records
   * showed no later payment spending it: those records cannot show a
   * payment made elsewhere (another wallet on the same seed, or a recipient
   * spending their output). A claim restored from the page's copy (see
   * `restoreBroadcastClaim`) hands it `restored` as well, whatever it
   * replaces: nothing but `txid`, or the transaction the claim replaces, may
   * spend any of `outpoints`. Any other broadcast is handed nothing to check.
   *
   * A transaction over an input a send plan holds goes out only with
   * `planHold`, that plan's hold, and only when the plan holds every input
   * (see `runWithNoOverlap`); a fee bump's claim presenting it may replace a
   * transaction whose outputs only that plan holds. A plan's own step that
   * replaces an earlier version of itself goes out with `planReplacement`,
   * under that hold and without a claim, checked as a fee bump's claim is:
   * nothing but the plan may spend an output of the version it replaces, by
   * the guard's records and on the explorer, and it takes over the inputs
   * that version's broadcast recorded. Once `broadcast` resolves, the inputs
   * are recorded as recently spent as for any other broadcast, so they stay
   * reserved after the plan lets go of them.
   */
  broadcastIfAllowed<T>(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    broadcast: (spendCheck: QbitExplorerSpendCheck) => Promise<T>,
    claim?: QbitSendBroadcastClaim,
    planHold?: QbitSendPlanHold,
    planReplacement?: QbitSendPlanReplacement
  ): Promise<T> {
    if (!QBIT_CHAINS.has(chain) || !isTxid(txid)) {
      return Promise.reject(new Error('invalid Qbit transaction broadcast'))
    }
    assertValidOutpoints(outpoints)
    let replacement: QbitSendPlanReplacement | undefined
    try {
      replacement = this.readPlanReplacement(planReplacement, planHold, txid)
    } catch (error) {
      return Promise.reject(error)
    }
    if (replacement && claim) {
      return Promise.reject(new Error('A send plan step goes out under its plan, not a claim'))
    }
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
      const presentedHold = this.presentedPlanHoldNow(planHold)
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
      this.assertPlanHoldsAllowNow(chain, outpoints, presentedHold)
      const planReplaces = this.planReplacementNow(chain, planHold, replacement)
      const replacedTxid = exactClaim ? replacedTxidOf(exactClaim) : planReplaces
      if (replacedTxid) this.assertNoDependentSpendNow(chain, replacedTxid, planHold)
      this.assertNoRecentSpendConflictNow(chain, txid, outpoints, replacedTxid)

      const restoredFromPage =
        exactClaim !== undefined && this.restoredClaimKeys.has(claimKey(exactClaim))
      const result = await broadcast(
        qbitExplorerSpendCheckFor({
          txid,
          outpoints,
          replaces: replacedTxid,
          replacedOutputCount: exactClaim
            ? exactClaim.replacedOutputCount
            : replacement?.outputCount,
          restoredFromPage,
        })
      )
      // The claim is consumed, but its inputs stay reserved as recently
      // spent: the explorer may keep listing them for a while yet. A plan's
      // step is the account's own send, filed under the plan's account.
      this.recordSpendNow(chain, txid, outpoints, exactClaim?.address ?? presentedHold?.address)
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
      this.planHolds.clear()
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

  /**
   * `hasDependentSpend`, in the queue. The holds of the plan `planHold`
   * belongs to do not count: that plan is the one replacing `txid`, and
   * re-signs whatever of its own spends `txid`'s outputs.
   */
  private hasDependentSpendNow(
    chain: ChainType,
    txid: string,
    planHold?: QbitSendPlanHold
  ): boolean {
    this.pruneRecentSpendsNow(Date.now())
    const spendsOutputOfTxid = (outpoint: QbitOutpoint): boolean => outpoint.txid === txid
    const outputPrefix = `${txid}:`
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
        spend => spend.chain === chain && spend.outpoint.startsWith(outputPrefix)
      ) ||
      [...this.planHolds.values()].some(
        hold =>
          hold.chain === chain &&
          hold.hold !== planHold &&
          [...hold.outpoints].some(key => key.startsWith(outputPrefix))
      )
    )
  }

  /**
   * A fee bump of `replaces` is assessed against the transactions spending
   * its original's outputs, but a send can take the original's change while
   * the bump waits to be signed or broadcast. Admitting its claim (before a
   * local key signs it, after an external signer has, or when a restart
   * left only the page's copy) and broadcasting it check again, in the same
   * step that admits the claim or the broadcast. `planHold` as in
   * `hasDependentSpendNow`, once the caller has checked it is active.
   */
  private assertNoDependentSpendNow(
    chain: ChainType,
    replaces: string,
    planHold?: QbitSendPlanHold
  ): void {
    if (this.hasDependentSpendNow(chain, replaces, planHold)) {
      throw new Error('A later payment depends on the transaction this fee bump replaces')
    }
  }

  /**
   * Every conflict a hold of plan `planId` on outpoint keys `keys` on
   * `chain` would meet (see `holdOutpointsForPlan`), in the order of `keys`.
   */
  private planHoldConflictsNow(
    chain: ChainType,
    keys: readonly string[],
    planId: string
  ): QbitSendPlanHoldConflict[] {
    if (keys.length === 0) return []
    const { claimed, locked, spent, spenders, requested, signed, plans } = this.planHoldBlockersNow(
      chain,
      planId
    )
    const conflicts: QbitSendPlanHoldConflict[] = []
    for (const outpoint of keys) {
      if (claimed.has(outpoint)) conflicts.push({ outpoint, kind: 'broadcast_claim' })
      if (locked.has(outpoint)) conflicts.push({ outpoint, kind: 'external_signing_lock' })
      if (spent.has(outpoint)) {
        const spender = spenders.get(outpoint)
        conflicts.push({ outpoint, kind: 'recent_spend', ...(spender ? { spender } : {}) })
      }
      if (requested.has(outpoint)) conflicts.push({ outpoint, kind: 'provider_send_request' })
      if (signed.has(outpoint)) conflicts.push({ outpoint, kind: 'provider_signing' })
      for (const [otherPlanId, held] of plans) {
        if (held.has(outpoint)) conflicts.push({ outpoint, kind: 'plan_hold', planId: otherPlanId })
      }
    }
    return conflicts
  }

  /**
   * Everything on `chain` a hold of plan `planId` would be refused on, by
   * kind, as outpoint keys: what claims, external signing locks, recent
   * broadcasts, open provider send requests, dapp signings recorded with
   * their inputs and the other plans' holds take, under any account. One
   * reading for the hold's check (`planHoldConflictsNow`) and for what a
   * plan may be prepared from (`getPlanUnavailableOutpointKeys`), so the two
   * never disagree.
   */
  private planHoldBlockersNow(
    chain: ChainType,
    planId: string | undefined
  ): {
    claimed: Set<string>
    locked: Set<string>
    spent: Set<string>
    /** For each outpoint in `spent`, the transaction recorded as spending it. */
    spenders: Map<string, string>
    requested: Set<string>
    signed: Set<string>
    plans: Map<string, Set<string>>
  } {
    this.pruneRecentSpendsNow(Date.now())
    const plans = new Map<string, Set<string>>()
    for (const [otherPlanId, hold] of this.planHolds) {
      if (otherPlanId !== planId && hold.chain === chain) plans.set(otherPlanId, hold.outpoints)
    }
    const spenders = new Map<string, string>()
    for (const spend of this.recentSpends.values()) {
      if (spend.chain === chain) spenders.set(spend.outpoint, spend.spender)
    }
    return {
      claimed: new Set(
        this.broadcastClaims
          .filter(claim => claim.chain === chain)
          .flatMap(claim => claim.outpoints.map(outpointKey))
      ),
      locked: new Set(
        this.externalSigningLocks
          .filter(lock => lock.chain === chain)
          .flatMap(lock => lock.entries.flatMap(entry => entry.outpoints.map(outpointKey)))
      ),
      spent: new Set(
        [...this.recentSpends.values()]
          .filter(spend => spend.chain === chain)
          .map(spend => spend.outpoint)
      ),
      spenders,
      requested: new Set(
        [...this.providerSendRequests.values()]
          .filter(claim => claim.chain === chain)
          .flatMap(claim => claim.outpoints.map(outpointKey))
      ),
      signed: new Set(
        [...this.providerSignings.values()]
          .filter(signing => signing.chain === chain)
          .flatMap(signing => signing.outpoints ?? [])
      ),
      plans,
    }
  }

  /**
   * `planReplacement` checked before it is queued: well-formed, presented
   * with a plan's hold, and replacing another transaction than `txid`.
   * Nothing when none is given.
   */
  private readPlanReplacement(
    planReplacement: QbitSendPlanReplacement | undefined,
    planHold: QbitSendPlanHold | undefined,
    txid: string | undefined
  ): QbitSendPlanReplacement | undefined {
    if (planReplacement === undefined) return undefined
    const replacement = normalizePlanReplacement(planReplacement)
    if (!replacement) throw new Error('invalid Qbit send plan replacement')
    if (planHold == null) {
      throw new Error('A send plan step replaces an earlier version only under its plan')
    }
    if (replacement.replaces === txid) {
      throw new Error('invalid Qbit send plan replacement')
    }
    return replacement
  }

  /**
   * The txid a plan's step replaces, once `planHold` is checked to be the
   * active hold of a plan that holds every output of that transaction:
   * that plan's own merge. Nothing without `replacement`.
   */
  private planReplacementNow(
    chain: ChainType,
    planHold: QbitSendPlanHold | undefined,
    replacement: QbitSendPlanReplacement | undefined
  ): string | undefined {
    if (!replacement) return undefined
    const presented = this.presentedPlanHoldNow(planHold)
    if (!presented) {
      throw new Error('A send plan step replaces an earlier version only under its plan')
    }
    for (let vout = 0; vout < replacement.outputCount; vout++) {
      const key = outpointKey({ txid: replacement.replaces, vout })
      if (presented.chain !== chain || !presented.outpoints.has(key)) {
        throw new QbitSendPlanHeldError('not_held')
      }
    }
    return replacement.replaces
  }

  /**
   * The hold record of `planHold` when a caller presents one, which must be
   * the very object this guard minted for a plan that still holds
   * outpoints; nothing when none is presented.
   */
  private presentedPlanHoldNow(
    planHold: QbitSendPlanHold | undefined
  ): QbitPlanHoldRecord | undefined {
    if (planHold == null) return
    const planId: unknown = (planHold as Partial<QbitSendPlanHold>).planId
    const record = typeof planId === 'string' ? this.planHolds.get(planId) : undefined
    if (!record || record.hold !== planHold) throw new QbitSendPlanHeldError('inactive')
    return record
  }

  /**
   * Refuse a spend of `outpoints` on `chain` over anything a send plan
   * holds, unless `presented` (see `presentedPlanHoldNow`) is the hold of
   * the one plan that holds it. A caller presenting a plan's hold spends
   * only what that plan holds: every outpoint must be held by it.
   */
  private assertPlanHoldsAllowNow(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    presented: QbitPlanHoldRecord | undefined
  ): void {
    const heldElsewhere = this.planHeldKeysNow(chain, presented)
    for (const outpoint of outpoints) {
      const key = outpointKey(outpoint)
      if (heldElsewhere.has(key)) throw new QbitSendPlanHeldError('held')
      if (presented && (presented.chain !== chain || !presented.outpoints.has(key))) {
        throw new QbitSendPlanHeldError('not_held')
      }
    }
  }

  /**
   * The outpoint keys that send plans other than `presented`'s hold on
   * `chain`: what `assertPlanHoldsAllowNow` refuses a spend of, and what
   * `getPlanHeldOutpointKeys` lists.
   */
  private planHeldKeysNow(chain: ChainType, presented?: QbitPlanHoldRecord): Set<string> {
    const keys = new Set<string>()
    for (const hold of this.planHolds.values()) {
      if (hold === presented || hold.chain !== chain) continue
      for (const key of hold.outpoints) keys.add(key)
    }
    return keys
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

  /**
   * Refuse `outpoints` on `chain` when a claim, an external signing lock
   * other than `ignoredExternalSigningLockId`, or a send plan holds one of
   * them; `planHold` lifts its own plan's hold (see `assertPlanHoldsAllowNow`).
   */
  private assertNoOverlapNow(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    ignoredExternalSigningLockId?: string,
    planHold?: QbitSendPlanHold
  ): void {
    assertValidOutpoints(outpoints)
    const presentedHold = this.presentedPlanHoldNow(planHold)
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
    this.assertPlanHoldsAllowNow(chain, outpoints, presentedHold)
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

  private sameOutpoints(left: readonly QbitOutpoint[], right: readonly QbitOutpoint[]): boolean {
    return (
      left.length === right.length &&
      left.every((outpoint, index) => outpointKey(outpoint) === outpointKey(right[index]!))
    )
  }

  private normalizeAvailableBroadcastClaim(
    claim: QbitSendBroadcastClaim,
    planHold?: QbitSendPlanHold
  ): QbitSendBroadcastClaim {
    const normalized = normalizeBroadcastClaim(claim)
    if (!normalized) throw new Error('invalid Qbit send broadcast claim')
    if (
      this.broadcastClaims.some(
        item => item.chain === normalized.chain && item.txid === normalized.txid
      )
    ) {
      throw new Error('Qbit send broadcast claim already exists')
    }
    this.assertNoOverlapNow(
      normalized.chain as ChainType,
      normalized.outpoints,
      undefined,
      planHold
    )
    return normalized
  }
}

export default new QbitSendGuardService()
