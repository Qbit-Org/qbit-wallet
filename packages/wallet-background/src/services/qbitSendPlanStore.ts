import { psbtUnsignedTransaction } from '@qbit-oss/protocol'
import {
  isQbitFeeRateWithinPolicy,
  type QbitSendPlanPhase,
  type QbitSendPlanStepStatus,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import {
  QbitSendPlanTransactionMismatchError,
  checkQbitSendPlanTransactions,
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
} from '../utils/qbit-send-plan-psbt'
import { qbitSendPlanFeeProblem } from '../utils/qbit-send-plan-revision'
import type { QbitOutpoint, QbitSendPlanOutpoints } from './qbitSendGuards'

export type { QbitSendPlanPhase, QbitSendPlanStepStatus }

/**
 * The version of the document `QbitSendPlanStore` keeps; a document of any
 * other version is not read, nor written over.
 */
export const QBIT_SEND_PLAN_STORE_VERSION = 1

/** The storage key the document is kept under. */
export const QBIT_SEND_PLAN_STORE_KEY = 'qbitSendPlans'

/** A plan has at most this many steps: up to 106 merges, then its payment. */
export const QBIT_SEND_PLAN_MAX_STEPS = 107

/**
 * The longest PSBT a step may store, in hex characters: a signed payment of
 * 106 inputs is about 800,000, and one standard transaction is at most
 * 400,000 bytes.
 */
export const QBIT_SEND_PLAN_PSBT_HEX_MAX_LENGTH = 4_000_000

/**
 * A plan carries at most this many merges of its earlier versions (see
 * `QbitSendPlanRecord.carried`): two full plans' worth.
 */
export const QBIT_SEND_PLAN_MAX_CARRIED = 212

/**
 * A plan keeps at most this many earlier versions of its payment (see
 * `QbitSendPlanRecord.earlierPayments`); a raise of the payment's fee past
 * them is refused.
 */
export const QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS = 16

export interface QbitSendPlanStepRecord {
  kind: 'merge' | 'payment'
  /** Lower-case hex; fixed before signing (the id of `unsignedPsbtHex`'s transaction). */
  txid: string
  /** The exact PSBT to sign. */
  unsignedPsbtHex: string
  inputs: { txid: string; vout: number; satoshis: number }[]
  vsize: number
  fee: number
  /**
   * The rate, in bits/vB, the step was priced at: its size and fee are the
   * wallet's own pricing of its transaction at this rate. The plan's rate
   * when the step was built, which a fee raise moves on for the steps it
   * builds again; a merge it keeps keeps its own.
   */
  feeRate: number
  /** merge: what its single output (index 0) pays back to the account. */
  outputValue?: number
  /**
   * merge only: the earlier version of this merge it replaces (the plan
   * raised its fee), which spends the same inputs and may confirm instead,
   * until one of the two has confirmed; see `QbitSendPlanReplacedVersion`.
   */
  replaces?: QbitSendPlanReplacedVersion
  status: QbitSendPlanStepStatus
  /**
   * payment only: present while it is 'signed' or 'unknown', and while it is
   * 'broadcast' or 'confirmed' until the plan is 'completed', which drops it.
   */
  signedPsbtHex?: string
  /** payment only: whether its bytes ever left the wallet; see `QbitSendPlanDispatch`. */
  dispatch?: QbitSendPlanDispatch
}

/**
 * What became of a payment's bytes once they left the wallet: `refused`,
 * every broadcast of them ended with the network refusing them (the
 * broadcast path proved each not sent); `unknown`, one ended without a
 * verdict, or never ended (a restart cut it), so a node may hold them and
 * they may still confirm, whatever the explorer showed since. Absent, they
 * never left the wallet.
 */
export type QbitSendPlanDispatch = 'refused' | 'unknown'

/**
 * An earlier version of the plan's payment, whose bytes left the wallet
 * before a raise of the payment's fee built it again: the same recipient,
 * over exactly the payment's inputs in the same order, at its own rate,
 * amount and change.
 * Every version spends the same inputs, so at most one of them, the
 * payment included, ever confirms; one that does is the plan's payment.
 */
export interface QbitSendPlanPaymentVersion {
  txid: string
  unsignedPsbtHex: string
  vsize: number
  fee: number
  feeRate: number
  amount: number
  change: number
  dispatch: QbitSendPlanDispatch
}

/**
 * The transaction that paid the recipient when it is none of the plan's
 * versions of its payment: found spending the payment's inputs and paying
 * the recipient the plan's amount (`QbitSendPlanRecord.paidBy`). What it
 * paid the recipient, and its fee, as the explorer reported them.
 */
export interface QbitSendPlanPaidBy {
  txid: string
  amount: number
  fee: number
}

/**
 * The version of a merge that a replacement paying a higher fee replaced:
 * it was in the network when it was replaced, spends the same inputs and
 * pays the account in its output 0, and it may still confirm instead of the
 * replacement. The step keeps it until the replacement confirms or it is
 * proven absent; once it has confirmed instead (`confirmed`), the
 * replacement is void: never signed or sent, its status `planned`.
 */
export interface QbitSendPlanReplacedVersion {
  txid: string
  fee: number
  confirmed?: true
}

/**
 * A merge an earlier version of the plan sent, or may have sent, that has
 * not confirmed: a replan carries it so that its inputs stay held until it
 * is found confirmed or proven absent, never dropped while it may exist. It
 * pays the account's own address and is no part of the payment.
 */
export interface QbitSendPlanCarriedStep {
  txid: string
  inputs: { txid: string; vout: number; satoshis: number }[]
  fee: number
  status: 'unknown' | 'broadcast'
}

export interface QbitSendPlanRecord {
  id: string // 32 lower-case hex chars
  chain: ChainType
  account: { address: string; pubkey: string }
  recipient: string // address
  target: 'amount' | 'everything'
  amount: number // exactly what the recipient receives, in bits
  change: number
  feeRate: number
  totalFee: number
  /** Merges in order, then exactly one payment, last. */
  steps: QbitSendPlanStepRecord[]
  /** Merges of earlier versions of the plan still being settled; see `QbitSendPlanCarriedStep`. */
  carried?: QbitSendPlanCarriedStep[]
  /**
   * Fees of the merges earlier versions of the plan sent that are, or may
   * still be, in the network or confirmed: a carried merge proven absent
   * takes its fee off. None when absent.
   */
  paidFee?: number
  /**
   * The earlier versions of the payment whose bytes left the wallet, oldest
   * first; see `QbitSendPlanPaymentVersion`. A completed plan keeps them
   * until its payment has confirmed: one of them may confirm instead.
   */
  earlierPayments?: QbitSendPlanPaymentVersion[]
  /** completed only: what paid the recipient, when no version of the payment did. */
  paidBy?: QbitSendPlanPaidBy
  phase: QbitSendPlanPhase
  /**
   * Why the plan stopped. `unexplained`: the network refused the payment
   * without a reason the wallet can read (it answered with an RPC code
   * alone), so a refusal for its fee cannot be told apart from another.
   */
  pause?: { reason: string; at: number; detail?: string; unexplained?: true }
  createdAt: number
  updatedAt: number
  /** Increments on every stored write of this record. */
  revision: number
  extra?: Record<string, unknown>
}

/**
 * What `QbitSendPlanStore.put` takes: a record whose `revision`, `createdAt`
 * and `updatedAt` the store sets itself, so a record read back from the
 * store, changed and put again, needs nothing removed.
 */
export type QbitSendPlanRecordInput = Omit<
  QbitSendPlanRecord,
  'revision' | 'createdAt' | 'updatedAt'
> &
  Partial<Pick<QbitSendPlanRecord, 'revision' | 'createdAt' | 'updatedAt'>>

/**
 * A stored entry the store cannot read. It stays on disk as it was, and
 * names what could be read of it; `reason` names the field or rule it
 * fails, never a stored value.
 */
export interface QbitSendPlanUnreadable {
  /** Its position in the stored document now. */
  index: number
  /**
   * Names the entry to `discardUnreadable` while this store holds it, an
   * entry without a readable id included. It is not stored: a store that
   * loads again names its entries afresh.
   */
  key: string
  id?: string
  chain?: ChainType
  address?: string
  reason: string
}

/**
 * Every outpoint the stored plan `record` may hold, once each: every
 * step's inputs (the account's own outputs, and the merges' outputs the
 * payment spends), output 0 of every merge and of every version a merge
 * replaces, and the inputs of every carried merge. The send guard holds
 * these when a plan starts and again when a restart restores it; what the
 * plan needs held at a given time is a part of them.
 */
export function qbitSendPlanOutpoints(
  record: Pick<QbitSendPlanRecord, 'steps' | 'carried'>
): QbitOutpoint[] {
  const seen = new Set<string>()
  const outpoints: QbitOutpoint[] = []
  const add = (txid: string, vout: number): void => {
    const key = `${txid}:${vout}`
    if (seen.has(key)) return
    seen.add(key)
    outpoints.push({ txid, vout })
  }
  for (const step of record.steps) {
    for (const input of step.inputs) add(input.txid, input.vout)
  }
  for (const step of record.steps) {
    if (step.kind === 'merge') add(step.txid, 0)
    if (step.replaces !== undefined) add(step.replaces.txid, 0)
  }
  for (const item of record.carried ?? []) {
    for (const input of item.inputs) add(input.txid, input.vout)
  }
  return outpoints
}

/** What `QbitSendPlanStore.discardUnreadable` did. */
export interface QbitSendPlanDiscard {
  /** How many entries went: a whole document counts as one. */
  dropped: number
  /**
   * The plans the discard made readable, in stored order: entries that read
   * on their own and that only the entry dropped made unreadable, sharing
   * their id or their account. Each held nothing while it was unreadable:
   * the caller holds it again, as a restart does (see `QbitSendPlanEngine`).
   */
  madeReadable: QbitSendPlanRecord[]
}

/** What `QbitSendPlanStore.unreadable` reports. */
export interface QbitSendPlanStoreUnreadable {
  /**
   * Set when the document as a whole cannot be read (another version, or no
   * document of this store at all): no plan is read from it, it is kept on
   * disk untouched, and every write but `discardUnreadable({ document: true })`
   * and `resetAllData()` is refused.
   */
  document?: { reason: string }
  plans: readonly QbitSendPlanUnreadable[]
}

/** The outcome of `validateQbitSendPlanRecord`. */
export type QbitSendPlanValidation =
  | { valid: true; record: QbitSendPlanRecord }
  | { valid: false; reason: string; planId?: string }

export type QbitSendPlanStoreErrorCode =
  /** `init` has not completed. */
  | 'not_initialized'
  /** The stored document cannot be read as a whole; see `QbitSendPlanStoreUnreadable.document`. */
  | 'unreadable_document'
  /** The record fails `validateQbitSendPlanRecord`; see `reason`. */
  | 'invalid_record'
  /** Creating a plan whose id is stored already, readable or not. */
  | 'already_exists'
  /** Changing a plan that is not stored (any more). */
  | 'not_found'
  /** The stored record's revision is not the one the caller read. */
  | 'stale_revision'
  /** Another plan, readable or not, is stored for the same network and account. */
  | 'account_has_open_plan'
  /** An update changing the plan's network, account or recipient. */
  | 'identity_changed'

const QBIT_SEND_PLAN_STORE_ERROR_MESSAGES: Record<QbitSendPlanStoreErrorCode, string> = {
  not_initialized: 'Qbit send plan store is not initialized',
  unreadable_document: 'Stored Qbit send plans cannot be read by this version',
  invalid_record: 'invalid Qbit send plan record',
  already_exists: 'Qbit send plan already exists',
  not_found: 'Qbit send plan does not exist',
  stale_revision: 'Qbit send plan changed since it was read',
  account_has_open_plan: 'Another Qbit send plan is open for this account',
  identity_changed: "Qbit send plan's network, account or recipient cannot change",
}

/** A refused store operation. Messages and `reason` never carry record contents. */
export class QbitSendPlanStoreError extends Error {
  constructor(
    readonly code: QbitSendPlanStoreErrorCode,
    readonly reason?: string
  ) {
    super(QBIT_SEND_PLAN_STORE_ERROR_MESSAGES[code])
    this.name = 'QbitSendPlanStoreError'
  }
}

/** The storage adapter background services receive at `init`. */
export interface QbitSendPlanStoreStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface QbitSendPlanStoreConfig {
  storage: QbitSendPlanStoreStorage
  /** The clock `createdAt` and `updatedAt` are read from; `Date.now` by default. */
  now?: () => number
}

const QBIT_CHAINS = new Set<unknown>([
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
])
const PLAN_ID = /^[0-9a-f]{32}$/
const TXID = /^[0-9a-f]{64}$/
const PUBKEY = /^[0-9a-f]{64}$/
const ADDRESS = /^[0-9A-Za-z]{1,200}$/
const HEX = /^[0-9a-f]*$/
const PSBT_MAGIC = '70736274ff'
const MAX_VOUT = 0xffffffff
const PAUSE_REASON_MAX_LENGTH = 200
const PAUSE_DETAIL_MAX_LENGTH = 1000
const EXTRA_MAX_DEPTH = 16

const STEP_STATUSES = new Set<unknown>(['planned', 'signed', 'unknown', 'broadcast', 'confirmed'])
const PHASES = new Set<unknown>([
  'signing',
  'waiting',
  'sending',
  'completed',
  'paused',
  'cancelling',
])
const RECORD_KEYS = new Set([
  'id',
  'chain',
  'account',
  'recipient',
  'target',
  'amount',
  'change',
  'feeRate',
  'totalFee',
  'steps',
  'carried',
  'paidFee',
  'earlierPayments',
  'paidBy',
  'phase',
  'pause',
  'createdAt',
  'updatedAt',
  'revision',
  'extra',
])
const ACCOUNT_KEYS = new Set(['address', 'pubkey'])
const CARRIED_KEYS = new Set(['txid', 'inputs', 'fee', 'status'])
const CARRIED_STATUSES = new Set<unknown>(['unknown', 'broadcast'])
const STEP_KEYS = new Set([
  'kind',
  'txid',
  'unsignedPsbtHex',
  'inputs',
  'vsize',
  'fee',
  'feeRate',
  'outputValue',
  'replaces',
  'status',
  'signedPsbtHex',
  'dispatch',
])
const DISPATCHES = new Set<unknown>(['refused', 'unknown'])
const VERSION_KEYS = new Set([
  'txid',
  'unsignedPsbtHex',
  'vsize',
  'fee',
  'feeRate',
  'amount',
  'change',
  'dispatch',
])
const PAID_BY_KEYS = new Set(['txid', 'amount', 'fee'])
const REPLACED_KEYS = new Set(['txid', 'fee', 'confirmed'])
const INPUT_KEYS = new Set(['txid', 'vout', 'satoshis'])
const PAUSE_KEYS = new Set(['reason', 'at', 'detail', 'unexplained'])
const DOCUMENT_KEYS = new Set(['version', 'plans'])

/** Every field of `T`, unchecked. */
type Unchecked<T> = { [K in keyof T]?: unknown }

type QbitSendPlanStepInput = QbitSendPlanStepRecord['inputs'][number]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Whether `value` has a key outside `allowed`. A key whose value is
 * `undefined` is no key at all: storage drops it. A reason never names the
 * key: it is stored data.
 */
function hasUnknownKey(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).some(key => !allowed.has(key) && value[key] !== undefined)
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

function isPsbtHex(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= QBIT_SEND_PLAN_PSBT_HEX_MAX_LENGTH &&
    value.length % 2 === 0 &&
    value.startsWith(PSBT_MAGIC) &&
    HEX.test(value)
  )
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/**
 * Why `value` is no JSON value storage keeps as it is, or nothing when it is
 * one: plain objects (a key whose value is `undefined` is dropped, as storage
 * drops it), arrays, strings, finite numbers, booleans and null, at most
 * `EXTRA_MAX_DEPTH` deep. The reason names no key: keys are stored data.
 */
function jsonValueProblem(value: unknown, depth: number): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'not finite'
  if (depth >= EXTRA_MAX_DEPTH) return 'too deep'
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) {
      if (item === undefined) return 'undefined in a list'
      const problem = jsonValueProblem(item, depth + 1)
      if (problem) return problem
    }
    return
  }
  if (!isPlainObject(value)) return 'not a JSON value'
  for (const item of Object.values(value)) {
    if (item === undefined) continue
    const problem = jsonValueProblem(item, depth + 1)
    if (problem) return problem
  }
  return
}

/** Why `value` is not a valid list of step inputs at `path`, or nothing when it is one. */
function inputsProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return path
  const inputs: readonly unknown[] = value
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
    const inputPath = `${path}[${inputIndex}]`
    const input: unknown = inputs[inputIndex]
    if (!isPlainObject(input)) return `${inputPath}: not an object`
    if (hasUnknownKey(input, INPUT_KEYS)) return `${inputPath}: unknown key`
    const fields = input as Unchecked<QbitSendPlanStepInput>
    if (typeof fields.txid !== 'string' || !TXID.test(fields.txid)) return `${inputPath}.txid`
    if (!isCount(fields.vout, 0) || fields.vout > MAX_VOUT) return `${inputPath}.vout`
    if (!isCount(fields.satoshis, 1)) return `${inputPath}.satoshis`
  }
  return
}

/**
 * Why `value` is not a valid step at `steps[index]`, or nothing when it is
 * one. `completed` says whether the plan is completed, which drops the
 * payment's signed PSBT.
 */
function stepProblem(value: unknown, index: number, completed: boolean): string | undefined {
  const path = `steps[${index}]`
  if (!isPlainObject(value)) return `${path}: not an object`
  if (hasUnknownKey(value, STEP_KEYS)) return `${path}: unknown key`
  const step = value as Unchecked<QbitSendPlanStepRecord>
  if (step.kind !== 'merge' && step.kind !== 'payment') return `${path}.kind`
  if (typeof step.txid !== 'string' || !TXID.test(step.txid)) return `${path}.txid`
  if (!isPsbtHex(step.unsignedPsbtHex)) return `${path}.unsignedPsbtHex`
  const inputs = inputsProblem(step.inputs, `${path}.inputs`)
  if (inputs) return inputs
  if (!isCount(step.vsize, 1)) return `${path}.vsize`
  if (!isCount(step.fee, 0)) return `${path}.fee`
  if (!isQbitFeeRateWithinPolicy(step.feeRate)) return `${path}.feeRate`
  if (!STEP_STATUSES.has(step.status)) return `${path}.status`
  if (step.kind === 'merge') {
    if (!isCount(step.outputValue, 1)) return `${path}.outputValue`
    if (step.signedPsbtHex !== undefined) return `${path}.signedPsbtHex: a merge stores none`
    if (step.dispatch !== undefined) return `${path}.dispatch: a merge records none`
    if (step.replaces !== undefined) {
      const replaced: unknown = step.replaces
      if (!isPlainObject(replaced)) return `${path}.replaces: not an object`
      if (hasUnknownKey(replaced, REPLACED_KEYS)) return `${path}.replaces: unknown key`
      const version = replaced as Unchecked<QbitSendPlanReplacedVersion>
      if (typeof version.txid !== 'string' || !TXID.test(version.txid)) {
        return `${path}.replaces.txid`
      }
      if (version.txid === step.txid) return `${path}.replaces.txid: the merge itself`
      if (!isCount(version.fee, 0)) return `${path}.replaces.fee`
      if (version.confirmed !== undefined && version.confirmed !== true) {
        return `${path}.replaces.confirmed`
      }
      if (version.confirmed && step.status !== 'planned') {
        return `${path}.status: a replacement whose earlier version confirmed is void`
      }
    }
  } else {
    if (step.outputValue !== undefined) return `${path}.outputValue: a payment has none`
    if (step.replaces !== undefined) return `${path}.replaces: a payment replaces none`
    if (step.dispatch !== undefined && !DISPATCHES.has(step.dispatch)) return `${path}.dispatch`
    if (step.status === 'planned') {
      if (step.signedPsbtHex !== undefined) return `${path}.signedPsbtHex: not signed yet`
    } else if (
      completed && (step.status === 'broadcast' || step.status === 'confirmed')
        ? step.signedPsbtHex !== undefined && !isPsbtHex(step.signedPsbtHex)
        : !isPsbtHex(step.signedPsbtHex)
    ) {
      return `${path}.signedPsbtHex`
    }
  }
  return
}

/** Why `value` is not a valid carried merge at `carried[index]`, or nothing when it is one. */
function carriedProblem(value: unknown, index: number): string | undefined {
  const path = `carried[${index}]`
  if (!isPlainObject(value)) return `${path}: not an object`
  if (hasUnknownKey(value, CARRIED_KEYS)) return `${path}: unknown key`
  const carried = value as Unchecked<QbitSendPlanCarriedStep>
  if (typeof carried.txid !== 'string' || !TXID.test(carried.txid)) return `${path}.txid`
  const inputs = inputsProblem(carried.inputs, `${path}.inputs`)
  if (inputs) return inputs
  if (!isCount(carried.fee, 0)) return `${path}.fee`
  if (!CARRIED_STATUSES.has(carried.status)) return `${path}.status`
  return
}

/** Why `value` is not a valid earlier payment at `earlierPayments[index]`, or nothing when it is one. */
function versionProblem(value: unknown, index: number): string | undefined {
  const path = `earlierPayments[${index}]`
  if (!isPlainObject(value)) return `${path}: not an object`
  if (hasUnknownKey(value, VERSION_KEYS)) return `${path}: unknown key`
  const version = value as Unchecked<QbitSendPlanPaymentVersion>
  if (typeof version.txid !== 'string' || !TXID.test(version.txid)) return `${path}.txid`
  if (!isPsbtHex(version.unsignedPsbtHex)) return `${path}.unsignedPsbtHex`
  if (!isCount(version.vsize, 1)) return `${path}.vsize`
  if (!isCount(version.fee, 0)) return `${path}.fee`
  if (!isQbitFeeRateWithinPolicy(version.feeRate)) return `${path}.feeRate`
  if (!isCount(version.amount, 1)) return `${path}.amount`
  if (!isCount(version.change, 0)) return `${path}.change`
  if (!DISPATCHES.has(version.dispatch)) return `${path}.dispatch`
  return
}

/**
 * Why `value`, the record's `paidBy`, is not valid for a plan in `phase`
 * whose payment and earlier payments have the ids `versions`, or nothing
 * when it is.
 */
function paidByProblem(value: unknown, phase: unknown, versions: Set<string>): string | undefined {
  if (!isPlainObject(value)) return 'paidBy'
  if (hasUnknownKey(value, PAID_BY_KEYS)) return 'paidBy: unknown key'
  const paidBy = value as Unchecked<QbitSendPlanPaidBy>
  if (typeof paidBy.txid !== 'string' || !TXID.test(paidBy.txid)) return 'paidBy.txid'
  if (versions.has(paidBy.txid)) return 'paidBy.txid: a version of the payment'
  if (!isCount(paidBy.amount, 1)) return 'paidBy.amount'
  if (!isCount(paidBy.fee, 0)) return 'paidBy.fee'
  if (phase !== 'completed') return 'paidBy: the plan is not completed'
  return
}

/**
 * The rules between carried merges and the plan's steps, once each is
 * well-formed: no transaction or spent outpoint is listed twice, and
 * neither spends an output of the other, since a carried merge spends the
 * account's own outputs and the plan never builds on one that has not
 * confirmed.
 */
function carriedStepsProblem(
  carried: readonly QbitSendPlanCarriedStep[],
  steps: readonly QbitSendPlanStepRecord[]
): string | undefined {
  const stepTxids = new Set(steps.map(step => step.txid))
  for (const step of steps) {
    if (step.replaces !== undefined) stepTxids.add(step.replaces.txid)
  }
  const carriedTxids = new Set<string>()
  for (let index = 0; index < carried.length; index++) {
    const item = carried[index] as QbitSendPlanCarriedStep
    if (stepTxids.has(item.txid) || carriedTxids.has(item.txid)) {
      return `carried[${index}].txid: listed twice`
    }
    carriedTxids.add(item.txid)
  }
  for (const step of steps) {
    if (step.inputs.some(input => carriedTxids.has(input.txid))) {
      return 'steps: a step spends a carried merge'
    }
  }
  const spent = new Set(
    steps.flatMap(step => step.inputs.map(input => `${input.txid}:${input.vout}`))
  )
  for (let index = 0; index < carried.length; index++) {
    const item = carried[index] as QbitSendPlanCarriedStep
    for (let inputIndex = 0; inputIndex < item.inputs.length; inputIndex++) {
      const input = item.inputs[inputIndex] as QbitSendPlanStepInput
      const key = `${input.txid}:${input.vout}`
      if (spent.has(key)) return `carried[${index}].inputs[${inputIndex}]: spent twice`
      spent.add(key)
      if (stepTxids.has(input.txid)) {
        return `carried[${index}].inputs[${inputIndex}]: spends a step of the plan`
      }
    }
  }
  return
}

/** The rules between steps, once each step is well-formed. */
function stepsProblem(steps: readonly QbitSendPlanStepRecord[]): string | undefined {
  const payment = steps[steps.length - 1]
  if (!payment || payment.kind !== 'payment') return 'steps: the payment is not last'
  const merges = steps.slice(0, -1)
  if (merges.some(step => step.kind !== 'merge')) return 'steps: more than one payment'
  const txids = new Set(steps.map(step => step.txid))
  if (txids.size !== steps.length) return 'steps: two steps have the same txid'
  const replaced = new Set<string>()
  for (let index = 0; index < steps.length; index++) {
    const version = (steps[index] as QbitSendPlanStepRecord).replaces
    if (version === undefined) continue
    if (txids.has(version.txid) || replaced.has(version.txid)) {
      return `steps[${index}].replaces.txid: listed twice`
    }
    replaced.add(version.txid)
  }
  const mergeOutputValues = new Map(merges.map(step => [step.txid, step.outputValue]))
  const spent = new Set<string>()
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as QbitSendPlanStepRecord
    let inputTotal = 0
    for (let inputIndex = 0; inputIndex < step.inputs.length; inputIndex++) {
      const inputPath = `steps[${index}].inputs[${inputIndex}]`
      const input = step.inputs[inputIndex] as QbitSendPlanStepInput
      const key = `${input.txid}:${input.vout}`
      if (spent.has(key)) return `${inputPath}: spent twice`
      spent.add(key)
      inputTotal += input.satoshis
      if (step.kind === 'merge' && txids.has(input.txid)) {
        return `${inputPath}: a merge spends a step of the plan`
      }
      if (step.kind === 'payment') {
        if (input.txid === step.txid) return `${inputPath}: the payment spends itself`
        const mergeOutputValue = mergeOutputValues.get(input.txid)
        if (mergeOutputValue !== undefined) {
          if (input.vout !== 0) return `${inputPath}: a merge has only output 0`
          if (input.satoshis !== mergeOutputValue) return `${inputPath}.satoshis: not the merge's`
        }
      }
    }
    if (!Number.isSafeInteger(inputTotal)) return `steps[${index}].inputs: total out of range`
    if (step.kind === 'merge' && inputTotal !== (step.outputValue as number) + step.fee) {
      return `steps[${index}]: inputs do not add up to outputValue and fee`
    }
  }
  for (const merge of merges) {
    if (!spent.has(`${merge.txid}:0`)) return 'steps: the payment does not spend every merge'
  }
  return
}

/**
 * The sizes of the outputs of the transaction `psbtHex` holds, once it
 * parses, and how many inputs it spends; nothing when it does not parse.
 */
function transactionShapeOf(
  psbtHex: string
): { inputCount: number; outputScriptLengths: number[] } | undefined {
  try {
    const transaction = psbtUnsignedTransaction(qbitSendPlanPsbtFromHex(psbtHex))
    return {
      inputCount: transaction.inputs.length,
      outputScriptLengths: transaction.outputs.map(output => output.scriptPubKey.length),
    }
  } catch {
    return undefined
  }
}

/**
 * Why a step of `record`, a record valid in every other respect, is not
 * priced as the wallet prices a plan's transactions, or nothing when every
 * step is: its rate is within policy and never above the plan's, and the
 * payment's is the plan's (every revision prices the payment again at the
 * rate it sets; a merge a raise keeps keeps the rate it was built at); and
 * its size and fee are what `qbitSendPlanFeeProblem` allows at its rate. A
 * merge's transaction spends its inputs to one output of the account, and
 * the payment's is read from its unsigned PSBT, the one PSBT this reads,
 * for the sizes of its outputs (the recipient's, the memos' and the
 * change's). Every step is checked, whatever its status: the wallet built
 * each at the rate it records, and a merge sent or confirmed may be signed
 * again once proven absent.
 */
function pricingProblem(record: QbitSendPlanRecord): string | undefined {
  let keys: ReturnType<typeof qbitSendPlanAccountKeys>
  try {
    keys = qbitSendPlanAccountKeys(record.account.pubkey)
  } catch {
    return 'account.pubkey'
  }
  const shape = {
    accountScriptLength: keys.scriptPubKey.length,
    leafScriptLength: keys.leafScript.length,
    controlBlockLength: keys.controlBlock.length,
  }
  for (let index = 0; index < record.steps.length; index++) {
    const path = `steps[${index}]`
    const step = record.steps[index] as QbitSendPlanStepRecord
    if (step.feeRate > record.feeRate) return `${path}.feeRate: above the plan's`
    let outputScriptLengths: readonly number[] = [shape.accountScriptLength]
    if (step.kind === 'payment') {
      if (step.feeRate !== record.feeRate) return `${path}.feeRate: not the plan's`
      const transaction = transactionShapeOf(step.unsignedPsbtHex)
      if (!transaction) return `${path}.unsignedPsbtHex: not a PSBT`
      if (transaction.inputCount !== step.inputs.length) {
        return `${path}.unsignedPsbtHex: not the step's inputs`
      }
      outputScriptLengths = transaction.outputScriptLengths
    }
    const problem = qbitSendPlanFeeProblem(
      {
        kind: step.kind,
        inputCount: step.inputs.length,
        outputScriptLengths,
        feeRate: step.feeRate,
        fee: step.fee,
        vsize: step.vsize,
        ...(step.kind === 'merge'
          ? { outputValue: step.outputValue ?? 0 }
          : { foldsRemainder: record.target === 'amount' && record.change === 0 }),
      },
      shape
    )
    if (problem) return `${path}.${problem}: not the wallet's pricing`
  }
  // An earlier version of the payment was priced as the payment is, over the
  // same inputs, at the rate it records.
  const payment = record.steps[record.steps.length - 1] as QbitSendPlanStepRecord
  const versions = record.earlierPayments ?? []
  for (let index = 0; index < versions.length; index++) {
    const path = `earlierPayments[${index}]`
    const version = versions[index] as QbitSendPlanPaymentVersion
    const transaction = transactionShapeOf(version.unsignedPsbtHex)
    if (!transaction) return `${path}.unsignedPsbtHex: not a PSBT`
    if (transaction.inputCount !== payment.inputs.length) {
      return `${path}.unsignedPsbtHex: not the payment's inputs`
    }
    const problem = qbitSendPlanFeeProblem(
      {
        kind: 'payment',
        inputCount: payment.inputs.length,
        outputScriptLengths: transaction.outputScriptLengths,
        feeRate: version.feeRate,
        fee: version.fee,
        vsize: version.vsize,
        foldsRemainder: record.target === 'amount' && version.change === 0,
      },
      shape
    )
    if (problem) return `${path}.${problem}: not the wallet's pricing`
  }
  return
}

/**
 * Why the transactions `record`, a record valid in every other respect,
 * stores are not what it states, or nothing when they are
 * (`checkQbitSendPlanTransactions`): the account address is its key's,
 * every step's unsigned PSBT is that step's transaction as the check before
 * each signature reads it, the payment paying exactly the recipient's script
 * on the plan's network the amount, and the change to the account, and
 * nothing else of value; and the payment's signed bytes, when stored, are
 * that same transaction.
 */
function transactionsProblem(record: QbitSendPlanRecord): string | undefined {
  try {
    checkQbitSendPlanTransactions(record)
    return
  } catch (error) {
    return error instanceof QbitSendPlanTransactionMismatchError
      ? error.what
      : 'steps: not the transactions the record states'
  }
}

/** Why `value` is not a valid record, or nothing when it is one. */
function recordProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return 'not an object'
  if (hasUnknownKey(value, RECORD_KEYS)) return 'unknown key'
  const record = value as Unchecked<QbitSendPlanRecord>
  if (typeof record.id !== 'string' || !PLAN_ID.test(record.id)) return 'id'
  if (!QBIT_CHAINS.has(record.chain)) return 'chain'
  if (!isPlainObject(record.account)) return 'account'
  if (hasUnknownKey(record.account, ACCOUNT_KEYS)) return 'account: unknown key'
  const account = record.account as Unchecked<QbitSendPlanRecord['account']>
  if (typeof account.address !== 'string' || !ADDRESS.test(account.address)) {
    return 'account.address'
  }
  if (typeof account.pubkey !== 'string' || !PUBKEY.test(account.pubkey)) return 'account.pubkey'
  if (typeof record.recipient !== 'string' || !ADDRESS.test(record.recipient)) return 'recipient'
  if (record.target !== 'amount' && record.target !== 'everything') return 'target'
  if (!isCount(record.amount, 1)) return 'amount'
  if (!isCount(record.change, 0)) return 'change'
  if (!isQbitFeeRateWithinPolicy(record.feeRate)) return 'feeRate'
  if (!isCount(record.totalFee, 0)) return 'totalFee'
  if (!Array.isArray(record.steps) || record.steps.length === 0) return 'steps'
  if (record.steps.length > QBIT_SEND_PLAN_MAX_STEPS) return 'steps: too many'
  const steps: readonly unknown[] = record.steps
  for (let index = 0; index < steps.length; index++) {
    const problem = stepProblem(steps[index], index, record.phase === 'completed')
    if (problem) return problem
  }
  const wellFormedSteps = steps as readonly QbitSendPlanStepRecord[]
  const stepsRule = stepsProblem(wellFormedSteps)
  if (stepsRule) return stepsRule
  if (record.carried !== undefined) {
    if (!Array.isArray(record.carried)) return 'carried'
    if (record.carried.length > QBIT_SEND_PLAN_MAX_CARRIED) return 'carried: too many'
    const carried: readonly unknown[] = record.carried
    for (let index = 0; index < carried.length; index++) {
      const problem = carriedProblem(carried[index], index)
      if (problem) return problem
    }
    const carriedRule = carriedStepsProblem(
      carried as readonly QbitSendPlanCarriedStep[],
      wellFormedSteps
    )
    if (carriedRule) return carriedRule
  }
  if (record.paidFee !== undefined && !isCount(record.paidFee, 0)) return 'paidFee'
  const payment = wellFormedSteps[wellFormedSteps.length - 1] as QbitSendPlanStepRecord
  const versionTxids = new Set([payment.txid])
  if (record.earlierPayments !== undefined) {
    if (!Array.isArray(record.earlierPayments)) return 'earlierPayments'
    if (record.earlierPayments.length > QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS) {
      return 'earlierPayments: too many'
    }
    const versions: readonly unknown[] = record.earlierPayments
    const listed = new Set([
      ...wellFormedSteps.map(step => step.txid),
      ...wellFormedSteps.flatMap(step => (step.replaces ? [step.replaces.txid] : [])),
      ...((record.carried ?? []) as readonly QbitSendPlanCarriedStep[]).map(item => item.txid),
    ])
    for (let index = 0; index < versions.length; index++) {
      const problem = versionProblem(versions[index], index)
      if (problem) return problem
      const { txid } = versions[index] as QbitSendPlanPaymentVersion
      if (listed.has(txid)) return `earlierPayments[${index}].txid: listed twice`
      listed.add(txid)
      versionTxids.add(txid)
    }
  }
  if (record.paidBy !== undefined) {
    const problem = paidByProblem(record.paidBy, record.phase, versionTxids)
    if (problem) return problem
  }
  const paymentInputs = payment.inputs.reduce((total, input) => total + input.satoshis, 0)
  if (paymentInputs !== record.amount + record.change + payment.fee) {
    return 'steps: the payment inputs do not add up to amount, change and fee'
  }
  if (wellFormedSteps.reduce((total, step) => total + step.fee, 0) !== record.totalFee) {
    return 'totalFee: not the sum of the step fees'
  }
  if (!PHASES.has(record.phase)) return 'phase'
  if (record.pause !== undefined) {
    if (!isPlainObject(record.pause)) return 'pause'
    if (hasUnknownKey(record.pause, PAUSE_KEYS)) return 'pause: unknown key'
    const pause = record.pause as Unchecked<NonNullable<QbitSendPlanRecord['pause']>>
    if (!isBoundedText(pause.reason, PAUSE_REASON_MAX_LENGTH)) return 'pause.reason'
    if (!isCount(pause.at, 0)) return 'pause.at'
    if (pause.detail !== undefined && !isBoundedText(pause.detail, PAUSE_DETAIL_MAX_LENGTH)) {
      return 'pause.detail'
    }
    if (pause.unexplained !== undefined && pause.unexplained !== true) return 'pause.unexplained'
  }
  if (!isCount(record.createdAt, 0)) return 'createdAt'
  if (!isCount(record.updatedAt, 0)) return 'updatedAt'
  if (!isCount(record.revision, 1)) return 'revision'
  if (record.extra !== undefined) {
    if (!isPlainObject(record.extra)) return 'extra'
    const problem = jsonValueProblem(record.extra, 0)
    if (problem) return `extra: ${problem}`
  }
  return (
    pricingProblem(record as QbitSendPlanRecord) ??
    transactionsProblem(record as QbitSendPlanRecord)
  )
}

/**
 * Whether `value` is a send plan record this version reads, and why not.
 * The one check of the store's boundary: every stored entry passes it on
 * load, and every record passes it before it is written. It never throws,
 * changes nothing and copies nothing; a valid record is `value` itself.
 *
 * Beyond the types of the fields it refuses: a field or nested key it does
 * not know (only `extra`, a JSON object, is free); a number that is not a
 * safe integer (`null` included: JSON holds no NaN), or a fee rate, the
 * plan's or a step's, outside policy; a txid, public key or PSBT that is not
 * lower-case hex of its form; steps that are not merges followed by exactly
 * one payment; a merge that stores a signed PSBT, or a payment that stores
 * one before it is signed or none once it is, until a completed plan drops
 * it; an outpoint spent twice, by steps and carried merges alike; a merge
 * spending a step of the plan, a payment spending a merge's output other
 * than 0 or for another amount, or a merge whose output the payment does not
 * spend; a version a merge replaces that is a step itself, is replaced twice
 * or is carried, a payment replacing one, and a replacement whose replaced
 * version confirmed that is not `planned`; a carried merge listed twice,
 * spending a step or spent by one; and amounts that do not add up (a merge's
 * inputs to its output and fee, the payment's to the amount, change and fee,
 * the step fees to `totalFee`, which leaves out `paidFee`).
 *
 * And it refuses a step whose size or fee is not what the wallet's own
 * pricing gives its transaction at the rate the step records
 * (`pricingProblem`), so no record carries a fee the planner would never
 * have made: one changed on disk to pay more fee is read as unreadable, and
 * holds nothing.
 *
 * And it refuses a record whose transactions are not what it states
 * (`transactionsProblem`): an account address that is not its key's on the
 * plan's network; a step whose unsigned PSBT is not that step's transaction,
 * by the check the engine makes before each signature
 * (`checkQbitSendPlanStepPsbt`: its id, its inputs, a merge's one output to
 * the account, and its fee at its rate), the payment's paying exactly the
 * recipient's script on the plan's network the amount and the change to the
 * account, and nothing else of value; and a signed payment that is not that
 * same transaction byte for byte, with every input finalized. So what a
 * record shows (the recipient, the amount, the change, the fees) is what its
 * transactions pay, the signed payment it would broadcast included: one
 * changed on disk to show anything else is unreadable, offers only its
 * cancel, and is never signed or broadcast.
 *
 * What a record changed on disk can still do to fees: price its steps again
 * at another rate within policy, the plan's up to `QBIT_MAX_FEE_RATE` and
 * each step's no higher than the plan's, every fee then exactly the wallet's
 * pricing at that rate (for an amount paid without change, with a remainder
 * too small to return as change folded into the payment's fee, as the
 * planner folds one), so that no step pays more than its price at the plan's
 * rate; and state any `paidFee`, the fees merges of earlier versions of the
 * plan paid, which nothing checks further, since the record no longer lists
 * all of those merges, and which is never signed. The plan's rate and its
 * total fee are what the screens show before the user continues a plan.
 */
export function validateQbitSendPlanRecord(value: unknown): QbitSendPlanValidation {
  const reason = recordProblem(value)
  if (reason === undefined) return { valid: true, record: value as QbitSendPlanRecord }
  const id = isPlainObject(value) ? value['id'] : undefined
  return typeof id === 'string' && PLAN_ID.test(id)
    ? { valid: false, reason, planId: id }
    : { valid: false, reason }
}

/** `value` and everything in it, frozen; returns `value`. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/** A copy of JSON value `value` (see `jsonValueProblem`), without its `undefined` keys. */
function copyJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJsonValue)
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) copy[key] = copyJsonValue(item)
    }
    return copy
  }
  return value
}

/**
 * The record a valid `record` stores, in its own objects so the caller's
 * cannot change it. Strings are shared, never copied: a signed payment's
 * PSBT is several hundred kilobytes.
 */
function copyRecord(record: QbitSendPlanRecord): QbitSendPlanRecord {
  return {
    id: record.id,
    chain: record.chain,
    account: { address: record.account.address, pubkey: record.account.pubkey },
    recipient: record.recipient,
    target: record.target,
    amount: record.amount,
    change: record.change,
    feeRate: record.feeRate,
    totalFee: record.totalFee,
    steps: record.steps.map(step => ({
      kind: step.kind,
      txid: step.txid,
      unsignedPsbtHex: step.unsignedPsbtHex,
      inputs: step.inputs.map(input => ({
        txid: input.txid,
        vout: input.vout,
        satoshis: input.satoshis,
      })),
      vsize: step.vsize,
      fee: step.fee,
      feeRate: step.feeRate,
      ...(step.outputValue !== undefined ? { outputValue: step.outputValue } : {}),
      ...(step.replaces !== undefined
        ? {
            replaces: {
              txid: step.replaces.txid,
              fee: step.replaces.fee,
              ...(step.replaces.confirmed ? { confirmed: true as const } : {}),
            },
          }
        : {}),
      status: step.status,
      ...(step.signedPsbtHex !== undefined ? { signedPsbtHex: step.signedPsbtHex } : {}),
      ...(step.dispatch !== undefined ? { dispatch: step.dispatch } : {}),
    })),
    ...(record.carried !== undefined
      ? {
          carried: record.carried.map(item => ({
            txid: item.txid,
            inputs: item.inputs.map(input => ({
              txid: input.txid,
              vout: input.vout,
              satoshis: input.satoshis,
            })),
            fee: item.fee,
            status: item.status,
          })),
        }
      : {}),
    ...(record.paidFee !== undefined ? { paidFee: record.paidFee } : {}),
    ...(record.earlierPayments !== undefined
      ? {
          earlierPayments: record.earlierPayments.map(version => ({
            txid: version.txid,
            unsignedPsbtHex: version.unsignedPsbtHex,
            vsize: version.vsize,
            fee: version.fee,
            feeRate: version.feeRate,
            amount: version.amount,
            change: version.change,
            dispatch: version.dispatch,
          })),
        }
      : {}),
    ...(record.paidBy !== undefined
      ? {
          paidBy: {
            txid: record.paidBy.txid,
            amount: record.paidBy.amount,
            fee: record.paidBy.fee,
          },
        }
      : {}),
    phase: record.phase,
    ...(record.pause !== undefined
      ? {
          pause: {
            reason: record.pause.reason,
            at: record.pause.at,
            ...(record.pause.detail !== undefined ? { detail: record.pause.detail } : {}),
            ...(record.pause.unexplained ? { unexplained: true as const } : {}),
          },
        }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(record.extra !== undefined
      ? { extra: copyJsonValue(record.extra) as Record<string, unknown> }
      : {}),
  }
}

/**
 * One entry of the stored document, in document order: a record this
 * version reads, or the value storage returned for one it cannot read,
 * which is written back as it is. `alone` is the record an unreadable entry
 * reads as on its own, when it reads as one: then only another entry, of
 * the same id or for the same account, makes it unreadable (see
 * `settledSlots`).
 */
type QbitSendPlanSlot =
  | { readable: true; record: QbitSendPlanRecord }
  | {
      readable: false
      stored: unknown
      alone: QbitSendPlanRecord | undefined
      report: Omit<QbitSendPlanUnreadable, 'index'>
    }

/** The keys `unreadableReport` names entries by: unique for as long as the background runs. */
let unreadableKeys = 0

/**
 * What can be read of an unreadable entry, for its report, under `key`, the
 * name it is reported under already, or a new one.
 */
function unreadableReport(
  value: unknown,
  reason: string,
  key?: string
): Omit<QbitSendPlanUnreadable, 'index'> {
  if (key === undefined) unreadableKeys += 1
  const report: Omit<QbitSendPlanUnreadable, 'index'> = {
    key: key ?? `unreadable-${unreadableKeys}`,
    reason,
  }
  if (!isPlainObject(value)) return report
  const { id, chain, account } = value as Unchecked<QbitSendPlanRecord>
  if (typeof id === 'string' && PLAN_ID.test(id)) report.id = id
  if (QBIT_CHAINS.has(chain)) report.chain = chain as ChainType
  const address = isPlainObject(account) ? account['address'] : undefined
  if (typeof address === 'string' && ADDRESS.test(address)) report.address = address
  return report
}

/** The slot's plan id, readable or not. */
function slotId(slot: QbitSendPlanSlot): string | undefined {
  return slot.readable ? slot.record.id : slot.report.id
}

/** Whether the slot's plan, readable or not, is filed under `chain` and `address`. */
function slotIsFor(slot: QbitSendPlanSlot, chain: unknown, address: unknown): boolean {
  return slot.readable
    ? slot.record.chain === chain && slot.record.account.address === address
    : slot.report.chain === chain && slot.report.address === address
}

/** `stored`, an entry of the stored document, as it reads on its own (`validateQbitSendPlanRecord`). */
function slotOf(stored: unknown): QbitSendPlanSlot {
  const verdict = validateQbitSendPlanRecord(stored)
  return verdict.valid
    ? { readable: true, record: deepFreeze(verdict.record) }
    : {
        readable: false,
        stored,
        alone: undefined,
        report: unreadableReport(stored, verdict.reason),
      }
}

/**
 * What the store reads of a document whose entries are `slots`, in document
 * order, each read on its own already (`slotOf`, or a slot the store holds,
 * which keeps that reading: the value an entry is read from never changes):
 * the rules between entries, applied on load and again to what every write
 * stores, so what the store reads after a write is what a load of the
 * document written reads. Two entries for the same plan id, or for the same
 * network and account, are each unreadable: which of them is the plan
 * cannot be told. An entry that reads on its own is readable once no other
 * entry has its id or is for its account, whatever made it unreadable
 * before; one that stays unreadable keeps the key it is reported under.
 */
function settledSlots(slots: readonly QbitSendPlanSlot[]): QbitSendPlanSlot[] {
  return slots.map((slot, index) => {
    const record = slot.readable ? slot.record : slot.alone
    if (record === undefined) return slot
    const { id, chain, account } = record
    const reason = slots.some((other, otherIndex) => otherIndex !== index && slotId(other) === id)
      ? 'another entry has the same id'
      : slots.some(
            (other, otherIndex) => otherIndex !== index && slotIsFor(other, chain, account.address)
          )
        ? 'another entry is for the same account'
        : undefined
    if (reason === undefined) return slot.readable ? slot : { readable: true, record }
    return {
      readable: false,
      stored: record,
      alone: record,
      report: unreadableReport(record, reason, slot.readable ? undefined : slot.report.key),
    }
  })
}

/** Why a stored `value` is no document of this version, or nothing when it is one. */
function documentProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return 'not an object'
  if (value['version'] !== QBIT_SEND_PLAN_STORE_VERSION) return 'unsupported version'
  if (!Array.isArray(value['plans'])) return 'plans is not a list'
  return hasUnknownKey(value, DOCUMENT_KEYS) ? 'unknown key' : undefined
}

/**
 * The persisted record of open send plans (issue #188), in
 * `chrome.storage.local` through the storage adapter background services
 * receive, under `QBIT_SEND_PLAN_STORE_KEY`: `{ version, plans }`. It holds
 * no key material and is read while the wallet is locked, so it is not in
 * the vault. Nothing in it is logged.
 *
 * Reads are answered from memory, as of the last write storage accepted.
 * Writes run one at a time, each a single storage `set` of the whole
 * document; memory changes only once storage has accepted it, so a write
 * that fails leaves every read as it was. A write is refused unless the
 * caller presents the revision it read (`put`, `delete`), so a writer that
 * read an older revision never overwrites a newer one; one plan per network
 * and account is stored at a time.
 *
 * An entry this version cannot read (see `validateQbitSendPlanRecord`) is
 * reported (`unreadable`), never held as a plan, and kept: every write puts
 * the value storage returned for it back in its place, unparsed and
 * unchanged, so storage writes it again exactly as it read it. It goes only
 * when `discardUnreadable` is asked to drop it (the user's cancel) or the
 * wallet is reset. A document of another version is not read at all, and
 * is not written over: every write but those two is refused.
 *
 * What the store reads after a write is what a load of the document written
 * reads (`settledSlots`). An entry that reads on its own, made unreadable by
 * other entries of its id or for its account, reads as its plan once none
 * of them is left. Only `discardUnreadable` can leave none: a write of a
 * plan is refused when it would share an id or an account with another
 * entry, and a plan that reads shares neither, so deleting one leaves every
 * other entry as it read.
 */
export class QbitSendPlanStore {
  private storage: QbitSendPlanStoreStorage | undefined
  private now: () => number = Date.now
  private slots: QbitSendPlanSlot[] = []
  private loaded = false
  /** Why the stored document cannot be read as a whole, when it cannot. */
  private unreadableDocument: { reason: string } | undefined
  private writeTail: Promise<void> = Promise.resolve()

  /**
   * Read and validate the stored document. A read that fails rejects and
   * leaves the store unable to answer until `init` succeeds.
   */
  init(config: QbitSendPlanStoreConfig): Promise<void> {
    return this.enqueue(async () => {
      this.storage = config.storage
      this.now = config.now ?? Date.now
      this.loaded = false
      this.slots = []
      this.unreadableDocument = undefined
      const stored: unknown = await config.storage.get(QBIT_SEND_PLAN_STORE_KEY)
      if (stored !== undefined && stored !== null) {
        const problem = documentProblem(stored)
        if (problem === undefined) {
          this.slots = settledSlots((stored as { plans: unknown[] }).plans.map(slotOf))
        } else {
          this.unreadableDocument = { reason: problem }
        }
      }
      this.loaded = true
    })
  }

  /** Every stored plan this version reads, in stored order. Records are frozen. */
  list(): QbitSendPlanRecord[] {
    return this.readSlots().flatMap(slot => (slot.readable ? [slot.record] : []))
  }

  get(id: string): QbitSendPlanRecord | undefined {
    return this.list().find(record => record.id === id)
  }

  /**
   * The plan stored for `address` on `chain`, in whatever phase: a
   * completed plan counts until it is deleted. An unreadable entry for the
   * account is no plan, but blocks a new one (see `unreadable`).
   */
  findOpen(chain: ChainType, address: string): QbitSendPlanRecord | undefined {
    return this.list().find(record => record.chain === chain && record.account.address === address)
  }

  /** What the store cannot read; see `QbitSendPlanStoreUnreadable`. */
  unreadable(): QbitSendPlanStoreUnreadable {
    const plans = this.readSlots().flatMap((slot, index) =>
      slot.readable ? [] : [{ index, ...slot.report }]
    )
    return this.unreadableDocument ? { document: { ...this.unreadableDocument }, plans } : { plans }
  }

  /**
   * What each stored plan holds, for the send guard's `restorePlanHolds`:
   * `qbitSendPlanOutpoints` of each, as its start held them. An unreadable
   * entry holds nothing: what it would hold cannot be read.
   */
  planHolds(): QbitSendPlanOutpoints[] {
    return this.list().map(record => ({
      planId: record.id,
      chain: record.chain,
      address: record.account.address,
      outpoints: qbitSendPlanOutpoints(record),
    }))
  }

  /**
   * Store `record`. `readRevision` is the revision of the stored record the
   * caller read and changed, or `null` to create the plan. The store sets
   * `revision` (1 on creation, then one more on every write), `createdAt`
   * (kept from the stored record) and `updatedAt`, whatever `record` says.
   *
   * Refused, with nothing stored (`QbitSendPlanStoreError`): a record that
   * fails `validateQbitSendPlanRecord` (`invalid_record`); creating an id
   * that is stored, readable or not (`already_exists`), or a second plan
   * for a network and account (`account_has_open_plan`); changing a plan
   * that is not stored (`not_found`), whose stored revision is not
   * `readRevision` (`stale_revision`), or its network, account or recipient
   * (`identity_changed`). A storage write that fails rejects with its
   * error, and the store reads as before it.
   */
  put(record: QbitSendPlanRecordInput, readRevision: number | null): Promise<QbitSendPlanRecord> {
    return this.enqueue(async () => {
      const slots = this.writableSlots()
      if (!isPlainObject(record)) {
        throw new QbitSendPlanStoreError('invalid_record', 'not an object')
      }
      const id = record['id']
      const index = typeof id === 'string' ? slots.findIndex(slot => slotId(slot) === id) : -1
      const existingSlot = slots[index]
      const now = this.now()
      let createdAt = now
      let revision = 1
      if (readRevision === null) {
        if (existingSlot) throw new QbitSendPlanStoreError('already_exists')
      } else {
        if (!isCount(readRevision, 1)) {
          throw new QbitSendPlanStoreError('invalid_record', 'readRevision')
        }
        if (!existingSlot?.readable) throw new QbitSendPlanStoreError('not_found')
        if (existingSlot.record.revision !== readRevision) {
          throw new QbitSendPlanStoreError('stale_revision')
        }
        createdAt = existingSlot.record.createdAt
        revision = readRevision + 1
      }
      const verdict = validateQbitSendPlanRecord({ ...record, createdAt, updatedAt: now, revision })
      if (!verdict.valid) throw new QbitSendPlanStoreError('invalid_record', verdict.reason)
      const candidate = verdict.record
      if (existingSlot?.readable) {
        const stored = existingSlot.record
        if (
          candidate.chain !== stored.chain ||
          candidate.account.address !== stored.account.address ||
          candidate.account.pubkey !== stored.account.pubkey ||
          candidate.recipient !== stored.recipient
        ) {
          throw new QbitSendPlanStoreError('identity_changed')
        }
      } else if (slots.some(slot => slotIsFor(slot, candidate.chain, candidate.account.address))) {
        throw new QbitSendPlanStoreError('account_has_open_plan')
      }
      const written = deepFreeze(copyRecord(candidate))
      const slot: QbitSendPlanSlot = { readable: true, record: written }
      await this.write(
        existingSlot ? slots.map((item, at) => (at === index ? slot : item)) : [...slots, slot]
      )
      return written
    })
  }

  /**
   * Delete plan `id` when its stored revision is `readRevision`: a deletion
   * decided on an older revision is refused (`stale_revision`), so it never
   * drops what a newer write recorded. Resolves to whether the plan was
   * there; deleting it again changes nothing. An unreadable entry goes only
   * through `discardUnreadable`.
   */
  delete(id: string, readRevision: number): Promise<boolean> {
    return this.enqueue(async () => {
      const slots = this.writableSlots()
      const index = slots.findIndex(slot => slot.readable && slot.record.id === id)
      const slot = slots[index]
      if (!slot?.readable) return false
      if (slot.record.revision !== readRevision) throw new QbitSendPlanStoreError('stale_revision')
      await this.write(slots.filter((_, at) => at !== index))
      return true
    })
  }

  /**
   * Drop what this version cannot read: the user's explicit choice only, and
   * the one write that drops an unreadable entry. `{ key }` drops the one
   * entry `unreadable()` reported under that key, and nothing else: one
   * account's cancel never takes another account's or network's entry, and
   * an entry without a readable id is named by its key all the same.
   * `{ document: true }` drops a whole document this version cannot read
   * (another version), which takes every plan of every account in it, and
   * nothing from a document it reads. Resolves to how many entries went and
   * to the plans that dropping them made readable (`QbitSendPlanDiscard`),
   * which the caller holds again. A storage write that fails rejects with
   * its error, and the store reads as before it.
   */
  discardUnreadable(target: { key: string } | { document: true }): Promise<QbitSendPlanDiscard> {
    return this.enqueue(async () => {
      if (!this.loaded || !this.storage) throw new QbitSendPlanStoreError('not_initialized')
      if ('document' in target) {
        if (!this.unreadableDocument) return { dropped: 0, madeReadable: [] }
        await this.write([])
        return { dropped: 1, madeReadable: [] }
      }
      if (this.unreadableDocument) return { dropped: 0, madeReadable: [] }
      const kept = this.slots.filter(slot => slot.readable || slot.report.key !== target.key)
      const dropped = this.slots.length - kept.length
      if (dropped === 0) return { dropped, madeReadable: [] }
      return { dropped, madeReadable: await this.write(kept) }
    })
  }

  /** Erase every stored plan, readable or not: the wallet is being reset. */
  resetAllData(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.storage) throw new QbitSendPlanStoreError('not_initialized')
      await this.write([])
      this.loaded = true
    })
  }

  private readSlots(): readonly QbitSendPlanSlot[] {
    if (!this.loaded) throw new QbitSendPlanStoreError('not_initialized')
    return this.slots
  }

  private writableSlots(): QbitSendPlanSlot[] {
    if (!this.loaded || !this.storage) throw new QbitSendPlanStoreError('not_initialized')
    if (this.unreadableDocument) throw new QbitSendPlanStoreError('unreadable_document')
    return this.slots
  }

  /**
   * Persist `slots` as the whole document, in one storage write, and only
   * then make what the store reads of them (`settledSlots`) what it answers
   * with. Resolves to the plans the write made readable, in stored order.
   */
  private async write(slots: QbitSendPlanSlot[]): Promise<QbitSendPlanRecord[]> {
    const storage = this.storage
    if (!storage) throw new QbitSendPlanStoreError('not_initialized')
    const settled = settledSlots(slots)
    await storage.set(QBIT_SEND_PLAN_STORE_KEY, {
      version: QBIT_SEND_PLAN_STORE_VERSION,
      plans: slots.map(slot => (slot.readable ? slot.record : slot.stored)),
    })
    this.slots = settled
    this.unreadableDocument = undefined
    return settled.flatMap((slot, index) =>
      slot.readable && slots[index]?.readable === false ? [slot.record] : []
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation)
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

const qbitSendPlanStore = new QbitSendPlanStore()

export default qbitSendPlanStore
