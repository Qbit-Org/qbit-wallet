import { expect, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
  type P2mrSigningKey,
  type Psbt,
} from '@qbit-oss/protocol'
import { QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS } from '@qbit/keyring-service'
import { transactionCore } from '@qbit/wallet-core'
import {
  BUS_EVENTS,
  BUS_METHODS,
  CHAINS_MAP,
  KeyringType,
  type QbitSendPlanPrepareResult,
  type QbitSendPlanReview,
  type QbitSendPlanView,
  type QbitSignatureBudgetImpact,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { WalletController } from '../src/controllers/wallet'
import { keyringService, qbitSendGuardService } from '../src/services'
import {
  QBIT_SEND_PLAN_TICK_MS,
  type QbitSendPlanEngine,
  type QbitSendPlanTimers,
} from '../src/services/qbitSendPlanEngine'
import {
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
} from '../src/utils/qbit-send-plan-psbt'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  type QbitSendPlanStoreStorage,
} from '../src/services/qbitSendPlanStore'
import { QbitSendGuardService } from '../src/services/qbitSendGuards'
import { bgEventBus } from '../src/utils/eventBus'
import { FakeQbitExplorer, fakeTxid, type FakeFailure } from './qbit-fake-explorer'

// The harness of the send plan engine's tests. The send guard and the plan
// store are the real services, the explorer a fake served over fetch (so
// the real clients and the real broadcast path classify every answer), and
// the keyring a fake that keeps the counter, the signature batches and the
// restored-floor challenges as the keyring service does, signing with
// placeholder signatures.
//
// A test file using it mocks '../src/services' as the engine's tests do,
// with a send guard reached through a holder (`QbitSendPlanGuardHolder`) so
// that each world and each restart gets a guard of its own, and hands this
// module the lock state its keyring mock reads.

/** The lock state the mocked keyring service reports, shared with the fake keyring. */
export interface QbitSendPlanLockState {
  isUnlocked: boolean
}

/** Where the mocked services module finds the send guard of the running world. */
export interface QbitSendPlanGuardHolder {
  guard: object
}

export const CHAIN = ChainType.QBIT_REGTEST
export const T0 = 1_762_000_000_000

/** A P2MR account of public key `pubkeyHex`, as the wallet lists it on `network`. */
export function p2mrAccount(pubkeyHex: string, network: 'regtest' | 'mainnet' = 'regtest') {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const scriptPubKey = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))
  const address = p2mrAddressFromPubkey(pubkey, network)
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey: pubkeyHex,
    address,
    key: 'account-0',
    flag: 0,
    index: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: network === 'mainnet' ? `m/87'/0'/0'/0/0` : `m/87'/1'/0'/0/0`,
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: { [network]: address },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1_073_741_824,
        remaining: 1_073_741_824,
        state: 'normal',
        provenance: 'local',
      },
    },
  }
}

export function scriptOf(pubkeyHex: string): string {
  const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
  return bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)))
}

/** A P2MR account of the wallet, as `p2mrAccount` builds one. */
export type QbitSendPlanAccount = ReturnType<typeof p2mrAccount>

export const account = p2mrAccount('11'.repeat(32))
export const RECIPIENT = p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'regtest')
export const RECIPIENT_SCRIPT = scriptOf('44'.repeat(32))
export const PAYER = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')
export const PAYER_SCRIPT = scriptOf('33'.repeat(32))

/** `chrome.storage.local` as the background sees it: values kept serialized. */
export class MemoryStorage implements QbitSendPlanStoreStorage {
  readonly values = new Map<string, string>()
  failNextSet: Error | undefined

  async get(key: string): Promise<unknown> {
    const raw = this.values.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: unknown): Promise<void> {
    const failure = this.failNextSet
    this.failNextSet = undefined
    if (failure) throw failure
    this.values.set(key, JSON.stringify(value))
  }
}

/** The engine's timer, run by hand: each `runDue` runs what the clock says is due. */
export class ManualTimers implements QbitSendPlanTimers {
  private entries: { at: number; callback: () => void; handle: number }[] = []
  private next = 0

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = ++this.next
    this.entries.push({ at: Date.now() + ms, callback, handle })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.entries = this.entries.filter(entry => entry.handle !== handle)
  }

  runDue(): void {
    const now = Date.now()
    const due = this.entries.filter(entry => entry.at <= now)
    this.entries = this.entries.filter(entry => entry.at > now)
    for (const entry of due) entry.callback()
  }

  get scheduled(): number {
    return this.entries.length
  }
}

export type Figures = Omit<QbitSignatureBudgetImpact, 'restoredFloorRisk'>

/** A coded error, as the keyring service throws them. */
export function coded(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code })
}

/** How many signatures the keyring's signature cache keeps per key, newest first. */
export const FAKE_SIGNATURE_CACHE_SIZE = 16

/**
 * The keyring service as far as a send plan uses it, moving its counter
 * and its signature cache as `KeyringService` and `QbitHdKeyring` do:
 *
 * - The cache keeps a key's 16 most recent signatures, newest first; a
 *   hit does not move an entry. A budget counts as `required` the inputs
 *   the cache misses when they are signed in order, each miss evicting the
 *   oldest entry (`estimatePqcSignatureCacheMisses`), so signing a
 *   transaction again from its first input finds none of what a signing cut
 *   short after more than 16 inputs had made.
 * - Each input the cache misses takes its counter unit before its
 *   signature is made, and a lock between the two leaves the unit taken
 *   with no signature (the vault holds the reservation, not the signature).
 * - A batch opens only while every entry's approved figures still hold, and
 *   an entry then signs with exactly its approved figures, less what the
 *   batch's other entries took since (`assertExpectedPqcSignatureBudget`).
 * - A lock clears the batches and the restored-floor challenges; the
 *   counter and the cache (the vault) outlive it, and a restart.
 */
export class FakePlanKeyring {
  counter = 0
  readonly limit = 1_073_741_824
  restoredFloor = false
  /** The signature cache, newest first, at most `FAKE_SIGNATURE_CACHE_SIZE`. */
  cache: string[] = []
  readonly batches = new Map<
    string,
    {
      budget: Figures
      entries: {
        keys: string[]
        figures: Figures
        signed: boolean
        reserved: number
        produced: Set<string>
      }[]
    }
  >()
  readonly challenges = new Map<string, { keys: string[]; confirmed: boolean; expiresAt: number }>()
  /** Every transaction signed to the end, by txid, in order. */
  readonly signed: string[] = []
  /** Every challenge confirmation asked for. */
  readonly confirmations: string[] = []
  /** Runs before each input is signed, with the transaction and the input. */
  beforeInput: ((txid: string, index: number) => void | Promise<void>) | undefined
  /**
   * Runs once an input's counter unit is taken and before its signature is
   * made: a lock here leaves the unit taken and nothing signed.
   */
  afterReserve: ((txid: string, index: number) => void | Promise<void>) | undefined
  private nextId = 0

  constructor(private readonly lock: { isUnlocked: boolean }) {}

  static txidOf(psbt: Psbt): string {
    const unsigned = psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === 0)!.value
    return Buffer.from(transactionCore.crypto.hash256(Buffer.from(unsigned)))
      .reverse()
      .toString('hex')
  }

  private keysOf(psbt: Psbt): string[] {
    const txid = FakePlanKeyring.txidOf(psbt)
    return decodePsbt(psbt).inputs.map((_, index) => `${txid}:${index}`)
  }

  /** The inputs of `keys` the cache misses when they are signed in order. */
  private misses(keys: readonly string[]): number {
    const simulated = this.cache.slice(0, FAKE_SIGNATURE_CACHE_SIZE)
    let misses = 0
    for (const key of keys) {
      if (simulated.includes(key)) continue
      misses += 1
      simulated.unshift(key)
      if (simulated.length > FAKE_SIGNATURE_CACHE_SIZE) simulated.pop()
    }
    return misses
  }

  private figures(keys: readonly string[]): Figures {
    const required = this.misses(keys)
    const remainingBefore = this.limit - this.counter
    return {
      required,
      cached: keys.length - required,
      remainingBefore,
      remainingAfter: remainingBefore - required,
      limit: this.limit,
    }
  }

  private cacheSignature(key: string): void {
    this.cache = [key, ...this.cache.filter(other => other !== key)].slice(
      0,
      FAKE_SIGNATURE_CACHE_SIZE
    )
  }

  private assertUnlocked(): void {
    if (!this.lock.isUnlocked) throw coded('The wallet is locked', -18)
  }

  /** What listens to the keyring service's `lock` event (`keyringService.on('lock', ...)`). */
  readonly lockListeners: (() => void)[] = []

  /** Lock, as the keyring service's `setLocked` does: every lock emits `lock` once it is done. */
  setLocked = async (): Promise<void> => {
    this.lock.isUnlocked = false
    this.batches.clear()
    this.challenges.clear()
    for (const listener of [...this.lockListeners]) listener()
  }

  unlock(): void {
    this.lock.isUnlocked = true
  }

  /** A service-worker restart: locked, with nothing in memory but the vault's counter and cache. */
  restart(): void {
    this.lock.isUnlocked = false
    this.batches.clear()
    this.challenges.clear()
    // The worker that listened is gone.
    this.lockListeners.length = 0
  }

  /** Another request signs `count` new signatures with the key, as a website's would. */
  signElsewhere(count: number): void {
    for (let index = 0; index < count; index++) {
      this.counter += 1
      this.cacheSignature(`elsewhere-${++this.nextId}`)
    }
  }

  preflightP2mrPsbtSigning = async (
    _address: string,
    { psbt }: { psbt: Psbt }
  ): Promise<QbitSignatureBudgetImpact> => {
    this.assertUnlocked()
    const keys = this.keysOf(psbt)
    const figures = this.figures(keys)
    if (!this.restoredFloor) return figures
    const challengeId = `challenge-${++this.nextId}`
    this.challenges.set(challengeId, {
      keys,
      confirmed: false,
      expiresAt: Date.now() + QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS,
    })
    return {
      ...figures,
      restoredFloorRisk: {
        recoveryStatus: 'seed-only-restored',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: 0,
        challengeId,
      },
    }
  }

  openP2mrPsbtSigningBatch = async (
    _address: string,
    inputs: readonly { psbt: Psbt; approvedBudget: QbitSignatureBudgetImpact }[]
  ): Promise<{ id: string; budget: QbitSignatureBudgetImpact }> => {
    this.assertUnlocked()
    const entries = inputs.map(({ psbt, approvedBudget }) => {
      const keys = this.keysOf(psbt)
      const fresh = this.figures(keys)
      if (JSON.stringify(fresh) !== JSON.stringify(figuresOnly(approvedBudget))) {
        throw new Error('P2MR signature budget changed after approval')
      }
      return { keys, figures: fresh, signed: false, reserved: 0, produced: new Set<string>() }
    })
    const id = `batch-${++this.nextId}`
    const budget = this.figures([...new Set(entries.flatMap(entry => entry.keys))])
    this.batches.set(id, { budget, entries })
    return { id, budget }
  }

  releaseP2mrPsbtSigningBatches = (ids: readonly string[]): void => {
    for (const id of ids) this.batches.delete(id)
  }

  confirmQbitRestoredFloorSigning = async (challengeId: string): Promise<void> => {
    this.confirmations.push(challengeId)
    const challenge = this.challenges.get(challengeId)
    if (!challenge || challenge.expiresAt < Date.now()) {
      this.challenges.delete(challengeId)
      throw coded('Confirmation expired', 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED')
    }
    challenge.confirmed = true
  }

  releaseQbitRestoredFloorSigningChallenges = (ids: readonly string[]): void => {
    for (const id of ids) this.challenges.delete(id)
  }

  signP2mrPsbtWithCounter = async (
    _address: string,
    { psbt, keys }: { psbt: Psbt; keys: readonly P2mrSigningKey[] },
    expected: QbitSignatureBudgetImpact,
    ref: { id: string; index: number } | undefined,
    {
      onProgress,
      signal,
    }: {
      onProgress?: (signed: number, total: number, cached: number) => void
      signal?: AbortSignal
    }
  ) => {
    this.assertUnlocked()
    const cacheKeys = this.keysOf(psbt)
    // An ordinary send signs on its own, outside any batch.
    const batch = ref ? this.batches.get(ref.id) : undefined
    if (ref && !batch) {
      throw coded('The batch was interrupted', 'QBIT_SIGNATURE_BATCH_INTERRUPTED')
    }
    const entry = batch ? batch.entries[ref!.index] : undefined
    if (batch && (!entry || entry.keys.join() !== cacheKeys.join())) {
      throw new Error('Not this batch entry')
    }
    if (entry?.signed) throw new Error('P2MR signature batch entry was already signed')
    if (entry && JSON.stringify(figuresOnly(expected)) !== JSON.stringify(entry.figures)) {
      throw new Error('P2MR signature batch entry was approved with another budget')
    }
    // The batch's other entries may have signed since: exactly what they
    // took, and this entry's signatures they made, is accepted.
    const others = batch ? batch.entries.filter(other => other !== entry) : []
    const reserved = others.reduce((total, other) => total + other.reserved, 0)
    const produced = cacheKeys.filter(key => others.some(other => other.produced.has(key))).length
    const actual = this.figures(cacheKeys)
    const approved = figuresOnly(expected)
    if (
      actual.limit !== approved.limit ||
      actual.required + actual.cached !== approved.required + approved.cached ||
      actual.required !== approved.required - produced ||
      actual.remainingBefore !== approved.remainingBefore - reserved ||
      actual.remainingAfter !== approved.remainingAfter - reserved + produced ||
      (batch !== undefined && reserved + actual.required > batch.budget.required)
    ) {
      throw new Error('P2MR signature budget changed after approval')
    }
    let challengeId: string | undefined
    if (this.restoredFloor) {
      challengeId = expected.restoredFloorRisk?.challengeId
      const challenge = challengeId ? this.challenges.get(challengeId) : undefined
      if (
        !challenge?.confirmed ||
        challenge.expiresAt < Date.now() ||
        challenge.keys.join() !== cacheKeys.join()
      ) {
        throw coded('Confirm the restored-floor risk', 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED')
      }
    }
    const before = this.counter
    const uncachedBefore = cacheKeys.filter(key => !this.cache.includes(key))
    const counterResults: { cached: boolean }[] = []
    const txid = FakePlanKeyring.txidOf(psbt)
    try {
      onProgress?.(0, cacheKeys.length, 0)
      for (const [index, key] of cacheKeys.entries()) {
        await this.beforeInput?.(txid, index)
        if (signal?.aborted) throw coded('The P2MR signing was stopped', 'QBIT_SIGNING_ABORTED')
        this.assertUnlocked()
        const cached = this.cache.includes(key)
        if (!cached) {
          // The unit is taken, and kept, before the signature is made.
          this.counter += 1
          await this.afterReserve?.(txid, index)
          this.assertUnlocked()
          this.cacheSignature(key)
        }
        counterResults.push({ cached })
        onProgress?.(
          index + 1,
          cacheKeys.length,
          counterResults.filter(result => result.cached).length
        )
        await Promise.resolve()
      }
    } finally {
      if (entry) {
        entry.reserved += this.counter - before
        for (const key of uncachedBefore) if (this.cache.includes(key)) entry.produced.add(key)
      }
    }
    if (entry) entry.signed = true
    if (challengeId) this.challenges.delete(challengeId)
    const signed = signP2mrPsbt({
      psbt,
      keys: [...keys],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
    })
    this.signed.push(txid)
    return { psbt: signed.psbt, signed: signed.signed, counterResults }
  }
}

export function figuresOnly(budget: QbitSignatureBudgetImpact): Figures {
  return {
    required: budget.required,
    cached: budget.cached,
    remainingBefore: budget.remainingBefore,
    remainingAfter: budget.remainingAfter,
    limit: budget.limit,
  }
}

/**
 * One world: an explorer holding the account's outputs, storage, a keyring
 * and a wallet over them. `newGuard` gives the mocked services a send guard
 * of its own, as a new service worker has (see `restart`).
 */
export class World {
  readonly explorer: FakeQbitExplorer
  readonly storage = new MemoryStorage()
  readonly timers = new ManualTimers()
  readonly keyring: FakePlanKeyring
  readonly events: { planId: string; revision: number }[] = []
  wallet!: WalletController
  funded = 0
  /**
   * While set, a broadcast never answers: `drop` before it reaches the
   * explorer, `accept` after the explorer took it.
   */
  hang: 'drop' | 'accept' | undefined
  /** Broadcasts of these transactions are refused with this answer. */
  readonly refuse = new Map<string, { status: number; body: string }>()
  /** While set, a broadcast reaches the explorer and its answer waits for this. */
  gate: Promise<void> | undefined
  /** Broadcasts spending any of these outpoints are refused with `refusal`. */
  readonly refuseSpending = new Set<string>()
  refusal = nodeRejection('mempool min fee not met')
  /** The txid of every broadcast that left the wallet, refused or not, in order. */
  readonly pushed: string[] = []

  constructor(
    lock: QbitSendPlanLockState,
    private readonly newGuard: () => void,
    /** The account that pays: the harness's own, or one a real keyring holds. */
    readonly owner: QbitSendPlanAccount = account,
    /** The network the account's plans are on; its explorer answers as that network's does. */
    readonly chain: ChainType = CHAIN
  ) {
    this.explorer = new FakeQbitExplorer(CHAINS_MAP[chain]?.qbitApiSurface ?? 'esplora')
    this.keyring = new FakePlanKeyring(lock)
    this.explorer.registerAddress(owner.address, owner.p2mr.scriptPubKey)
    this.explorer.registerAddress(RECIPIENT, RECIPIENT_SCRIPT)
    this.explorer.registerAddress(PAYER, PAYER_SCRIPT)
  }

  /** `count` confirmed outputs paying the account, `value` bits each (or `values`). */
  fund(count: number, value: number | ((index: number) => number), confirmed = true): string[] {
    const outpoints: string[] = []
    for (let index = 0; index < count; index++) {
      const seed = this.funded++
      const tx = this.explorer.addTx({
        txid: fakeTxid(seed, 7),
        inputs: [{ txid: fakeTxid(seed, 9_000_000), vout: 0 }],
        outputs: [
          {
            address: this.owner.address,
            script: this.owner.p2mr.scriptPubKey,
            value: typeof value === 'number' ? value : value(index),
          },
        ],
        ...(confirmed ? { height: 100 + seed } : {}),
      })
      outpoints.push(`${tx.txid}:0`)
    }
    return outpoints
  }

  private fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const isBroadcast = (init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/tx')
    if (isBroadcast) {
      try {
        this.pushed.push(transactionCore.Transaction.fromHex(String(init?.body ?? '')).getId())
      } catch {
        // Not a transaction: nothing to name.
      }
    }
    if (isBroadcast && this.refuseSpending.size > 0) {
      const tx = transactionCore.Transaction.fromHex(String(init?.body ?? ''))
      const spends = tx.ins.some(input =>
        this.refuseSpending.has(
          `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`
        )
      )
      if (spends) {
        const response = new Response(this.refusal.body, { status: this.refusal.status })
        Object.defineProperty(response, 'url', { value: url.toString() })
        return response
      }
    }
    if (isBroadcast && this.refuse.size > 0) {
      const txid = transactionCore.Transaction.fromHex(String(init?.body ?? '')).getId()
      const answer = this.refuse.get(txid)
      if (answer) {
        const response = new Response(answer.body, { status: answer.status })
        Object.defineProperty(response, 'url', { value: url.toString() })
        return response
      }
    }
    if (isBroadcast && this.gate) {
      const gate = this.gate
      const response = await this.explorer.fetch(input, init)
      await gate
      return response
    }
    if (isBroadcast && this.hang) {
      if (this.hang === 'accept') await this.explorer.fetch(input, init)
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }
    return this.explorer.fetch(input, init)
  }

  async open(): Promise<void> {
    vi.stubGlobal('fetch', this.fetch)
    await qbitSendPlanStore.init({ storage: this.storage })
    this.wallet = this.controller()
    await this.wallet.restoreQbitSendPlans()
    this.wallet.startQbitSendPlanEngine()
    await this.settle()
  }

  controller(): WalletController {
    const wallet = new WalletController({ qbitSendPlanTimers: this.timers })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(this.owner as never)
    wallet.qbitBroadcastProbeDelayMs = 0
    wallet.qbitBroadcastResendDelaysMs = [0, 0]
    wallet.qbitRecentSpendProbeWaitMs = 0
    // A replacement's explorer check reads twice; no pause between.
    wallet.qbitFeeBumpRecheckIntervalMs = 0
    return wallet
  }

  get engine(): QbitSendPlanEngine {
    return (this.wallet as unknown as { qbitSendPlans: QbitSendPlanEngine }).qbitSendPlans
  }

  /** The service worker restarts: memory goes, storage and the explorer stay. */
  async restart(): Promise<void> {
    this.engine.reset()
    this.newGuard()
    this.keyring.restart()
    await qbitSendPlanStore.init({ storage: this.storage })
    this.wallet = this.controller()
    await this.wallet.restoreQbitSendPlans()
    this.wallet.startQbitSendPlanEngine()
    await this.settle()
  }

  async settle(): Promise<void> {
    await this.engine.idle()
  }

  /** Time passes; the engine's timer runs what is due, and the engine settles unless told not to. */
  async tick(ms = QBIT_SEND_PLAN_TICK_MS, { settle = true } = {}): Promise<void> {
    vi.setSystemTime(Date.now() + ms)
    this.timers.runDue()
    if (settle) await this.settle()
  }

  /** The stored status of every step of the stored plan. */
  storedStatuses(): string[] {
    return this.storedPlans()[0]?.steps.map(step => step.status) ?? []
  }

  /** Unlock in this session, as the wallet's unlock does: the engine hears of it. */
  async unlock(): Promise<void> {
    this.keyring.unlock()
    this.engine.onUnlock()
    await this.settle()
  }

  /** A block confirms `txids`, or the whole mempool. */
  mine(txids?: readonly string[]): void {
    const height = ++this.explorer.tipHeight
    for (const tx of this.explorer.txs.values()) {
      if (tx.height !== undefined) continue
      if (txids && !txids.includes(tx.txid)) continue
      tx.height = height
    }
  }

  /** The amount each reviewed payment pays the recipient, by the payment's txid. */
  readonly reviewed = new Map<string, number>()

  async prepare(params: Record<string, unknown>): Promise<QbitSendPlanPrepareResult> {
    const result = await this.wallet.prepareQbitSendPlan({
      to: RECIPIENT,
      feeRate: 1,
      ...params,
    } as never)
    if (result.ok) this.reviewed.set(result.review.payment.txid, result.review.amount)
    return result
  }

  async review(params: Record<string, unknown>): Promise<QbitSendPlanReview> {
    const result = await this.prepare(params)
    if (!result.ok) throw new Error(`prepare refused: ${result.reason}`)
    return result.review
  }

  /** Prepare and start; resolves to the started plan's view once the engine settled. */
  async startPlan(params: Record<string, unknown>): Promise<QbitSendPlanView> {
    const review = await this.review(params)
    const started = await this.wallet.startQbitSendPlan(review.draftId)
    if (!started.ok) throw new Error(`start refused: ${started.reason}`)
    await this.settle()
    return started.plan
  }

  async plan(): Promise<QbitSendPlanView | null> {
    const view = await this.wallet.getQbitSendPlan()
    await this.settle()
    return view
  }

  /** The transaction the explorer holds as `txid`, or throws. */
  tx(txid: string) {
    const tx = this.explorer.txs.get(txid)
    if (!tx) throw new Error(`no transaction ${txid}`)
    return tx
  }

  /** What `txid` pays in fees, by the explorer's own records. */
  feeOf(txid: string): number {
    const tx = this.tx(txid)
    const inputs = tx.inputs.reduce(
      (total, input) => total + this.explorer.txs.get(input.txid)!.outputs[input.vout]!.value,
      0
    )
    return inputs - tx.outputs.reduce((total, output) => total + output.value, 0)
  }

  async reserved(): Promise<Set<string>> {
    return qbitSendGuardService.getReservedOutpointKeys(this.chain, this.owner.address)
  }

  /** The outpoints the plans hold now, as the guard keeps them. */
  async planHeld(): Promise<Set<string>> {
    // Reads after every queued change of the guard.
    await qbitSendGuardService.getReservedOutpointKeys(this.chain, this.owner.address)
    const holds = (
      qbitSendGuardService as unknown as { planHolds: Map<string, { outpoints: Set<string> }> }
    ).planHolds
    return new Set([...holds.values()].flatMap(hold => [...hold.outpoints]))
  }

  /** Unconfirmed change of the account's own: a pending transaction paying it back `value`. */
  ownChange(value: number): string {
    const [funding] = this.fund(1, value + 10_000)
    const [txid, vout] = funding!.split(':')
    const tx = this.explorer.addTx({
      txid: fakeTxid(this.funded++, 3),
      inputs: [{ txid: txid!, vout: Number(vout) }],
      outputs: [{ address: this.owner.address, script: this.owner.p2mr.scriptPubKey, value }],
    })
    return `${tx.txid}:0`
  }

  storedPlanId(): string | undefined {
    const raw = this.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    if (!raw) return undefined
    const document = JSON.parse(raw) as { plans: { id: string }[] }
    return document.plans[0]?.id
  }

  storedPlans(): {
    id: string
    phase: string
    steps: { status: string; unsignedPsbtHex: string; signedPsbtHex?: string }[]
  }[] {
    const raw = this.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    return raw ? (JSON.parse(raw) as { plans: never[] }).plans : []
  }

  /** Every output the explorer ever accepted that pays the recipient. */
  recipientOutputs(): { txid: string; value: number; parentHeights: (number | undefined)[] }[] {
    return this.explorer.accepted.flatMap(accepted =>
      accepted.outputs
        .filter(output => output.script === RECIPIENT_SCRIPT)
        .map(output => ({
          txid: accepted.txid,
          value: output.value,
          parentHeights: accepted.parentHeights,
        }))
    )
  }

  /**
   * Guarantees 1 and 2 as every scenario ends, over everything the explorer
   * ever accepted: the recipient is paid by no output, or by exactly one, in
   * exactly one transaction, the payment of a reviewed plan, of exactly the
   * amount that review confirmed; and when the explorer accepted it, every
   * transaction it spends had confirmed.
   */
  assertGuarantees(): void {
    const paid = this.recipientOutputs()
    expect(paid.length).toBeLessThanOrEqual(1)
    for (const output of paid) {
      expect(this.reviewed.get(output.txid)).toBe(output.value)
      expect(output.parentHeights.every(height => height !== undefined)).toBe(true)
    }
  }

  /** `assertGuarantees`, and that the recipient got exactly `amount`, or nothing. */
  assertRecipientGuarantees(amount: number | undefined): void {
    this.assertGuarantees()
    const paid = this.recipientOutputs()
    if (amount === undefined) {
      expect(paid).toEqual([])
      return
    }
    expect(paid).toHaveLength(1)
    expect(paid[0]!.value).toBe(amount)
    expect(paid[0]!.parentHeights.every(height => height !== undefined)).toBe(true)
  }
}

/** A send guard of its own for the mocked services, as a new service worker has. */
export function newPlanGuard(holder: QbitSendPlanGuardHolder): void {
  const guard = new QbitSendGuardService()
  guard.init()
  holder.guard = guard
}

/** The mocked keyring service answers for `world`'s keyring. */
export function wirePlanKeyring(world: World): void {
  const keyring = world.keyring
  Object.assign(keyringService, {
    on: (event: string, listener: () => void) => {
      if (event === 'lock') keyring.lockListeners.push(listener)
      return keyringService
    },
  })
  vi.mocked(keyringService.setLocked).mockImplementation(keyring.setLocked as never)
  vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementation(
    keyring.preflightP2mrPsbtSigning as never
  )
  vi.mocked(keyringService.openP2mrPsbtSigningBatch).mockImplementation(
    keyring.openP2mrPsbtSigningBatch as never
  )
  vi.mocked(keyringService.releaseP2mrPsbtSigningBatches).mockImplementation(
    keyring.releaseP2mrPsbtSigningBatches
  )
  vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
    keyring.signP2mrPsbtWithCounter as never
  )
  vi.mocked(keyringService.confirmQbitRestoredFloorSigning).mockImplementation(
    keyring.confirmQbitRestoredFloorSigning
  )
  vi.mocked(keyringService.releaseQbitRestoredFloorSigningChallenges).mockImplementation(
    keyring.releaseQbitRestoredFloorSigningChallenges
  )
}

/** Every announcement that a plan changed is recorded in the events of the world `current` names. */
export function watchPlanAnnouncements(current: () => World): void {
  vi.spyOn(bgEventBus, 'emit').mockImplementation(((event: string, data: unknown) => {
    const message = data as { method?: string; params?: { planId: string; revision: number } }
    if (
      event === BUS_EVENTS.broadcastToUI &&
      message.method === BUS_METHODS.QBIT_SEND_PLAN_CHANGED
    ) {
      current().events.push(message.params!)
    }
    return true
  }) as never)
}

/** A failure injected into the first request it matches, and no other. */
export function once(failure: FakeFailure): FakeFailure {
  let used = false
  return request => {
    if (used) return undefined
    const injected = failure(request)
    if (injected !== undefined) used = true
    return injected
  }
}

export const isBroadcast = ({ method, path }: { method: string; path: string }): boolean =>
  method === 'POST' && path === '/tx'
export const isLookup = ({ path }: { path: string }): boolean =>
  /^\/tx\/[0-9a-f]{64}(\/status)?$/.test(path)
export function nodeRejection(reason: string): { status: number; body: string } {
  return {
    status: 400,
    body: `sendrawtransaction RPC error: {"code":-26,"message":"${reason}"}`,
  }
}

/** The `txid:vout` of every input of a PSBT in hex. */
export function inputsOfPsbt(psbtHex: string): string[] {
  return decodePsbt(qbitSendPlanPsbtFromHex(psbtHex)).inputs.map(
    input => `${bytesToHex(new Uint8Array(input.prevout.txid).reverse())}:${input.prevout.vout}`
  )
}

/**
 * The plan `record` stated by another account, of public key `pubkeyHex`,
 * under plan id `id`: the same outpoints and values, every transaction
 * built again to spend them through that account's leaf and to pay that
 * account where `record` pays its own (each under its new id), nothing
 * signed or sent yet. A record the store reads as valid, for a test of two
 * stored plans holding the same outputs.
 */
export function anotherAccountsPlan(
  record: {
    account: { pubkey: string }
    steps: readonly {
      txid: string
      unsignedPsbtHex: string
      inputs: readonly { txid: string; vout: number; satoshis: number }[]
    }[]
  },
  pubkeyHex: string,
  id: string
): Record<string, unknown> {
  const keys = qbitSendPlanAccountKeys(pubkeyHex)
  const own = bytesToHex(qbitSendPlanAccountKeys(record.account.pubkey).scriptPubKey)
  const renamed = new Map<string, string>()
  const steps = record.steps.map(step => {
    const summary = decodePsbt(qbitSendPlanPsbtFromHex(step.unsignedPsbtHex))
    const inputs = step.inputs.map(input => ({
      ...input,
      txid: renamed.get(input.txid) ?? input.txid,
    }))
    const psbt = createP2mrPsbt({
      inputs: inputs.map((input, index) => ({
        prevout: { txid: hexToBytes(input.txid).reverse(), vout: input.vout },
        sequence: summary.inputs[index]!.sequence,
        witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: keys.scriptPubKey },
        leafScript: keys.leafScript,
        controlBlock: keys.controlBlock,
        merkleRoot: keys.leafHash,
      })),
      outputs: summary.outputs.map(output => ({
        value: output.value,
        scriptPubKey:
          bytesToHex(output.scriptPubKey) === own ? keys.scriptPubKey : output.scriptPubKey,
      })),
    })
    const txid = FakePlanKeyring.txidOf(psbt)
    renamed.set(step.txid, txid)
    const {
      signedPsbtHex: _signed,
      replaces: _replaces,
      ...rest
    } = step as typeof step & { signedPsbtHex?: string; replaces?: unknown }
    return {
      ...rest,
      txid,
      unsignedPsbtHex: qbitSendPlanPsbtHex(psbt),
      inputs,
      status: 'planned',
    }
  })
  const {
    pause: _pause,
    extra: _extra,
    carried: _carried,
    paidFee: _paidFee,
    ...rest
  } = record as typeof record & Record<string, unknown>
  return {
    ...rest,
    id,
    account: {
      address: p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'regtest'),
      pubkey: pubkeyHex,
    },
    steps,
    phase: 'signing',
  }
}

/** An unsigned PSBT a website asks the account to sign, spending `outpoints` to the payer. */
export function dappPsbtHex(outpoints: readonly string[], value: number): string {
  const keys = qbitSendPlanAccountKeys(account.p2mr.pubkey)
  const psbt = createP2mrPsbt({
    inputs: outpoints.map(key => {
      const [txid, vout] = key.split(':')
      return {
        prevout: { txid: hexToBytes(txid!).reverse(), vout: Number(vout) },
        witnessUtxo: { value: BigInt(value), scriptPubKey: keys.scriptPubKey },
        leafScript: keys.leafScript,
        controlBlock: keys.controlBlock,
        merkleRoot: keys.leafHash,
      }
    }),
    outputs: [
      { value: BigInt(value * outpoints.length - 20_000), scriptPubKey: hexToBytes(PAYER_SCRIPT) },
    ],
  })
  return qbitSendPlanPsbtHex(psbt)
}
