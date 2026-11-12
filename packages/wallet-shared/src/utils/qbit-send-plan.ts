import { QBIT_P2MR_DUST } from '../constants/common'
import {
  isQbitStandardTxSize,
  qbitP2mrInputFee,
  qbitP2mrMaxStandardInputCount,
  sortQbitCoinsByValue,
  type QbitSelectableCoin,
} from './qbit-coin-selection'
import {
  assertQbitFeeRateWithinPolicy,
  estimateQbitP2mrTransaction,
  qbitMaximumTotalFee,
  type QbitP2mrTransactionEstimate,
} from './qbit-p2mr-fees'

/**
 * What the transactions of a plan share apart from their inputs. Every input
 * spends one of the account's own single-key outputs. Each merge pays one
 * output to the account; the payment pays the recipient and any memo outputs,
 * then change to the account when it returns change.
 */
export interface QbitSendPlanShape {
  /** The payment's recipient and memo output script lengths, in output order. */
  paymentOutputScriptLengths: readonly number[]
  /** The account's own script length: every merge's single output, and the payment's change. */
  accountScriptLength: number
  /** Leaf script length of the account's outputs, which every input spends. */
  leafScriptLength: number
  /** Control block length of the account's outputs, which every input spends. */
  controlBlockLength: number
  /** Bits/vB. */
  feeRate: number
}

/** Exactly `amount` bits to the recipient, or all the account's confirmed outputs deliver after every fee. */
export type QbitSendPlanTarget = { kind: 'amount'; amount: number } | { kind: 'everything' }

/**
 * A transaction that spends some of the account's outputs and pays what they
 * hold, less its own fee, back to the account in one output.
 */
export interface QbitSendPlanMerge<T extends QbitSelectableCoin> {
  /** The account outputs it spends, highest value first. */
  inputs: T[]
  /** What `inputs` hold together. */
  totalInput: number
  /** Exact serialized size: qbit counts witness bytes in full. */
  vsize: number
  /** Exact fee at the plan's rate. */
  fee: number
  /** What the merge's single output (index 0) pays back to the account: totalInput - fee. */
  outputValue: number
}

/** The one transaction that pays the recipient. */
export interface QbitSendPlanPayment<T extends QbitSelectableCoin> {
  /** Account outputs the payment spends directly; it also spends output 0 of every merge. */
  coins: T[]
  /** coins.length + merges.length */
  inputCount: number
  /** Exactly what the recipient receives. */
  amount: number
  /** Exact serialized size, with the change output when `includeChange`. */
  vsize: number
  /** Exact fee, including any sub-dust remainder folded into it. */
  fee: number
  /** What the change output returns to the account: at least dust, or 0 without one. */
  change: number
  /** Whether a change output to the account follows the recipient and memo outputs. */
  includeChange: boolean
  /** The remainder too small to return as change, paid as part of `fee`; 0 with change. */
  changeDroppedSats: number
  /** `qbitMaximumTotalFee` for `vsize`; `fee` never exceeds it. */
  maximumTotalFee: number
}

/** A plan that pays its target, priced in full before anything is signed. */
export interface QbitSendPlan<T extends QbitSelectableCoin> {
  ok: true
  target: 'amount' | 'everything'
  /** Empty when the payment fits one transaction: callers then use the ordinary send. */
  merges: QbitSendPlanMerge<T>[]
  payment: QbitSendPlanPayment<T>
  /** Sum of every account output the plan spends. */
  totalInput: number
  /** Every merge's fee plus the payment's fee. totalInput === payment.amount + payment.change + totalFee. */
  totalFee: number
  /** One per input of every transaction: sum of merge inputs + payment.inputCount. */
  signatureCount: number
  /** Confirmed outputs the plan leaves in the account, highest value first. */
  leftBehind: T[]
  /** What `leftBehind` holds together. */
  leftBehindSatoshis: number
  /** Unconfirmed outputs; a plan never spends them. */
  unconfirmedSatoshis: number
}

/**
 * Why no plan pays the target:
 * - `insufficient_balance`: no plan of these outputs pays the amount and every fee.
 * - `exceeds_plan_size`: the amount could be paid only with more merges than
 *   one payment can spend.
 * - `exceeds_maximum_total_fee`: a plan would pay the amount only by folding a
 *   remainder below dust into a payment fee above its `maximumTotalFee`.
 * - `nothing_to_send`: for everything, no plan delivers at least dust.
 */
export type QbitSendPlanRefusalReason =
  | 'insufficient_balance'
  | 'exceeds_plan_size'
  | 'exceeds_maximum_total_fee'
  | 'nothing_to_send'

export interface QbitSendPlanRefusal {
  ok: false
  reason: QbitSendPlanRefusalReason
  /** The largest amount a plan can deliver to this payment's outputs from these coins (what `everything` would send); 0 when none. */
  maxSendable: number
  unconfirmedSatoshis: number
}

/** Shared boundary validator for a plan's amount: a safe integer of at least QBIT_P2MR_DUST. */
export function isQbitSendPlanAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= QBIT_P2MR_DUST
}

/**
 * Plan a payment from an account's confirmed outputs: the merges that combine
 * them, then the one payment that pays the recipient. Sizes are exact, so
 * every fee and the amount the recipient receives are known before anything
 * is signed.
 *
 * Candidates are the confirmed outputs worth more than the fee their own input
 * adds, highest value first. Unconfirmed outputs are never spent: an
 * unconfirmed parent can be replaced or dropped, which would void a signed
 * plan. A plan spends a prefix of the candidates. When the payment can carry
 * them all it spends them directly and there are no merges. Otherwise the
 * fewest merges that bring the payment within its standard size take the
 * candidates in order, as many as one merge carries each and the last one the
 * remainder; the payment spends the candidates left over and every merge's
 * output. Every transaction is within the standard size, and every merge pays
 * at least dust back to the account.
 *
 * For an amount, the shortest prefix that pays it wins, and so the fewest
 * merges and the lowest fee. Change follows `selectQbitP2mrSendCoins`: change
 * of at least dust is returned; a smaller remainder is paid as fee unless that
 * fee would pass the payment's `maximumTotalFee`, and then more inputs are
 * taken. Where the change output costs the payment an input, the merges that
 * make room for it can leave less than dust to return: the payment then
 * keeps those merges and pays the rest as fee, with no change output. For
 * everything, the prefix that delivers the most wins, the shorter
 * on a tie, so an output stays behind only when spending it would not raise
 * what the recipient receives.
 *
 * Linear in the number of outputs after sorting them. Throws a `RangeError` for
 * a fee rate outside the policy, a malformed target or amount, a malformed
 * script length, and a malformed or repeated output; a plan it cannot make is a
 * refusal carrying the largest amount a plan of these outputs can send.
 */
export function planQbitSend<T extends QbitSelectableCoin>(
  params: QbitSendPlanShape & { utxos: readonly T[]; target: QbitSendPlanTarget }
): QbitSendPlan<T> | QbitSendPlanRefusal {
  const { utxos, target, ...shape } = params
  assertQbitFeeRateWithinPolicy(shape.feeRate)
  const amount = readTargetAmount(target)
  assertPlanShape(shape)
  const { confirmed, unconfirmedSatoshis } = readOutputs(utxos)
  const space = planSpace(shape, confirmed)

  if (amount === undefined) {
    const everything = bestEverything(space)
    if (!everything) {
      return { ok: false, reason: 'nothing_to_send', maxSendable: 0, unconfirmedSatoshis }
    }
    return buildPlan(space, 'everything', everything.layout, unconfirmedSatoshis, {
      amount: everything.amount,
      fee: everything.layout.payment.fee,
      change: 0,
      includeChange: false,
      changeDroppedSats: 0,
    })
  }

  let overMaximumFee = false
  let payableBeyondPlanSize = false
  for (let spent = 1; spent <= space.candidates.length; spent++) {
    const outcome = payAmount(space, spent, amount)
    if (outcome.kind === 'pays') {
      if (outcome.layout.fits) {
        return buildPlan(space, 'amount', outcome.layout, unconfirmedSatoshis, outcome.payment)
      }
      payableBeyondPlanSize = true
    } else if (outcome.kind === 'over_maximum_fee' && outcome.fits) {
      overMaximumFee = true
    }
  }
  return {
    ok: false,
    reason: overMaximumFee
      ? 'exceeds_maximum_total_fee'
      : payableBeyondPlanSize
        ? 'exceeds_plan_size'
        : 'insufficient_balance',
    maxSendable: bestEverything(space)?.amount ?? 0,
    unconfirmedSatoshis,
  }
}

/** The amount an amount target names, or undefined for everything. */
function readTargetAmount(target: unknown): number | undefined {
  const { kind, amount } = (target ?? {}) as { kind?: unknown; amount?: unknown }
  if (kind === 'everything') return undefined
  if (kind !== 'amount') {
    throw new RangeError("target must be { kind: 'amount', amount } or { kind: 'everything' }")
  }
  if (!isQbitSendPlanAmount(amount)) {
    throw new RangeError(`amount must be a safe integer >= ${QBIT_P2MR_DUST}`)
  }
  return amount
}

function assertSafeIntegerAtLeast(
  name: string,
  value: unknown,
  minimum: number
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`)
  }
}

/** Script lengths as `estimateQbitP2mrTransaction` accepts them, with at least the recipient's output. */
function assertPlanShape(shape: QbitSendPlanShape): void {
  const outputs: unknown = shape.paymentOutputScriptLengths
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new RangeError('paymentOutputScriptLengths must list the recipient output')
  }
  outputs.forEach((length: unknown, index) => {
    assertSafeIntegerAtLeast(`paymentOutputScriptLengths[${index}]`, length, 0)
  })
  assertSafeIntegerAtLeast('accountScriptLength', shape.accountScriptLength, 0)
  assertSafeIntegerAtLeast('leafScriptLength', shape.leafScriptLength, 0)
  assertSafeIntegerAtLeast('controlBlockLength', shape.controlBlockLength, 1)
}

/**
 * The confirmed outputs, highest value first, and what the unconfirmed ones
 * hold. Refuses an output listed twice, which a plan would spend twice, and a
 * set whose total is not exact.
 */
function readOutputs<T extends QbitSelectableCoin>(
  utxos: readonly T[]
): { confirmed: T[]; unconfirmedSatoshis: number } {
  if (!Array.isArray(utxos)) throw new RangeError('utxos must be an array')
  const outpoints = new Set<string>()
  const confirmed: T[] = []
  let total = 0
  let unconfirmedSatoshis = 0
  utxos.forEach((utxo: T, index) => {
    const { txid, vout, satoshis, unconfirmed } = (utxo ?? {}) as Partial<QbitSelectableCoin>
    if (typeof txid !== 'string') throw new RangeError(`utxos[${index}].txid must be a string`)
    assertSafeIntegerAtLeast(`utxos[${index}].vout`, vout, 0)
    assertSafeIntegerAtLeast(`utxos[${index}].satoshis`, satoshis, 0)
    const outpoint = `${txid.toLowerCase()}:${vout}`
    if (outpoints.has(outpoint)) {
      throw new RangeError(`utxos[${index}] lists ${outpoint} again`)
    }
    outpoints.add(outpoint)
    total += satoshis
    if (!Number.isSafeInteger(total)) throw new RangeError('utxos must total a safe integer')
    if (unconfirmed) unconfirmedSatoshis += satoshis
    else confirmed.push(utxo)
  })
  return { confirmed: sortQbitCoinsByValue(confirmed), unconfirmedSatoshis }
}

/** One form of the payment: without a change output, or with one. */
interface PaymentForm {
  /** The most inputs this form carries within the standard size. */
  inputLimit: number
  estimate: (inputCount: number) => QbitP2mrTransactionEstimate
}

/** What every candidate plan of one call shares. */
interface PlanSpace<T extends QbitSelectableCoin> {
  /** Every confirmed output, highest value first. */
  confirmed: readonly T[]
  /** The confirmed outputs worth spending: a prefix of `confirmed`. */
  candidates: readonly T[]
  /** What the first `count` candidates hold together. */
  totalOf: (count: number) => number
  /** The most inputs one merge carries within the standard size. */
  mergeLimit: number
  merge: (inputCount: number) => QbitP2mrTransactionEstimate
  withoutChange: PaymentForm
  withChange: PaymentForm
}

function memoizedEstimate(
  shape: QbitSendPlanShape,
  outputScriptLengths: readonly number[]
): (inputCount: number) => QbitP2mrTransactionEstimate {
  const known = new Map<number, QbitP2mrTransactionEstimate>()
  return (inputCount: number): QbitP2mrTransactionEstimate => {
    let estimate = known.get(inputCount)
    if (!estimate) {
      estimate = estimateQbitP2mrTransaction({
        inputCount,
        outputScriptLengths,
        leafScriptLength: shape.leafScriptLength,
        controlBlockLength: shape.controlBlockLength,
        feeRate: shape.feeRate,
      })
      known.set(inputCount, estimate)
    }
    return estimate
  }
}

function planSpace<T extends QbitSelectableCoin>(
  shape: QbitSendPlanShape,
  confirmed: readonly T[]
): PlanSpace<T> {
  const { leafScriptLength, controlBlockLength } = shape
  const paymentOutputs = [...shape.paymentOutputScriptLengths]
  const changeOutputs = [...paymentOutputs, shape.accountScriptLength]
  const mergeOutputs = [shape.accountScriptLength]
  const inputFee = qbitP2mrInputFee({
    outputScriptLengths: paymentOutputs,
    leafScriptLength,
    controlBlockLength,
    feeRate: shape.feeRate,
  })
  // Sorted highest value first, the outputs worth spending come before the rest.
  const candidates = confirmed.filter(coin => coin.satoshis > inputFee)
  const totals = [0]
  let running = 0
  for (const coin of candidates) {
    running += coin.satoshis
    totals.push(running)
  }
  const inputLimit = (outputScriptLengths: readonly number[]): number =>
    qbitP2mrMaxStandardInputCount({ outputScriptLengths, leafScriptLength, controlBlockLength })
  return {
    confirmed,
    candidates,
    totalOf: (count: number): number => {
      const total = totals[count]
      if (total === undefined) throw new RangeError(`there is no prefix of ${count} outputs`)
      return total
    },
    mergeLimit: inputLimit(mergeOutputs),
    merge: memoizedEstimate(shape, mergeOutputs),
    withoutChange: {
      inputLimit: inputLimit(paymentOutputs),
      estimate: memoizedEstimate(shape, paymentOutputs),
    },
    withChange: {
      inputLimit: inputLimit(changeOutputs),
      estimate: memoizedEstimate(shape, changeOutputs),
    },
  }
}

/** How a plan spends the first `spent` candidates, and what that costs. */
interface PlanLayout {
  spent: number
  mergeCount: number
  /** Inputs of the last merge when it takes fewer than a full merge; 0 when every merge is full. */
  shortMergeInputs: number
  /** Candidates the payment spends directly: the ones after every merge's. */
  directCount: number
  /** directCount + mergeCount */
  paymentInputs: number
  /** Every merge's fee. */
  mergeFees: number
  /** Whether every merge pays at least dust back to the account. */
  mergesPayDust: boolean
  /** What the payment's inputs hold: the spent candidates' total less every merge's fee. */
  funds: number
  payment: QbitP2mrTransactionEstimate
  /**
   * Whether the payment is within its standard size. A layout that does not
   * fit only tells what a plan allowed more merges would cost.
   */
  fits: boolean
}

/**
 * Lay out the first `spent` candidates for a payment of `form`: the fewest
 * merges that bring the payment within `form.inputLimit` inputs, each taking
 * `mergeLimit` candidates in order and the last one the remainder. When no
 * number of merges does, the merges take every candidate and the layout does
 * not fit.
 */
function layOut<T extends QbitSelectableCoin>(
  space: PlanSpace<T>,
  spent: number,
  form: PaymentForm
): PlanLayout {
  const { mergeLimit } = space
  let mergeCount = 0
  let shortMergeInputs = 0
  let directCount = spent
  // A merge of one input would leave the payment's input count as it is.
  if (spent > form.inputLimit && mergeLimit > 1) {
    // Each merge turns up to `mergeLimit` of the payment's inputs into one,
    // and every merge spends at least one candidate. The first bound is no
    // larger than the second whenever the layout fits.
    mergeCount = Math.min(
      Math.ceil((spent - form.inputLimit) / (mergeLimit - 1)),
      Math.ceil(spent / mergeLimit)
    )
    const merged = mergeCount * mergeLimit
    if (merged <= spent) {
      directCount = spent - merged
    } else {
      shortMergeInputs = spent - merged + mergeLimit
      directCount = 0
    }
  }
  const fullMerges = shortMergeInputs > 0 ? mergeCount - 1 : mergeCount
  let mergeFees = 0
  let mergesPayDust = true
  if (fullMerges > 0) {
    const full = space.merge(mergeLimit)
    mergeFees += fullMerges * full.fee
    // Candidates come highest value first, so the last full merge returns the least.
    const start = (fullMerges - 1) * mergeLimit
    const output = space.totalOf(start + mergeLimit) - space.totalOf(start) - full.fee
    mergesPayDust = output >= QBIT_P2MR_DUST
  }
  if (shortMergeInputs > 0) {
    const short = space.merge(shortMergeInputs)
    mergeFees += short.fee
    const output = space.totalOf(spent) - space.totalOf(spent - shortMergeInputs) - short.fee
    mergesPayDust = mergesPayDust && output >= QBIT_P2MR_DUST
  }
  const paymentInputs = directCount + mergeCount
  const payment = form.estimate(paymentInputs)
  return {
    spent,
    mergeCount,
    shortMergeInputs,
    directCount,
    paymentInputs,
    mergeFees,
    mergesPayDust,
    funds: space.totalOf(spent) - mergeFees,
    payment,
    fits: paymentInputs <= form.inputLimit && isQbitStandardTxSize(payment.vsize),
  }
}

interface PaymentTerms {
  amount: number
  fee: number
  change: number
  includeChange: boolean
  changeDroppedSats: number
}

type AmountOutcome =
  | { kind: 'pays'; layout: PlanLayout; payment: PaymentTerms }
  | { kind: 'over_maximum_fee'; fits: boolean }
  | { kind: 'short' }

/**
 * Whether the first `spent` candidates pay `amount`. As for one transaction,
 * change of at least dust is returned, and a smaller remainder is paid as fee
 * within the payment's maximum total fee. The payment with change may need
 * more merges than the payment without it, since the change output takes
 * room. When those merges' fees bring the change below dust, the payment
 * keeps them and goes without the change output.
 */
function payAmount<T extends QbitSelectableCoin>(
  space: PlanSpace<T>,
  spent: number,
  amount: number
): AmountOutcome {
  const withChange = layOut(space, spent, space.withChange)
  if (withChange.mergesPayDust) {
    const change = withChange.funds - amount - withChange.payment.fee
    if (change >= QBIT_P2MR_DUST) {
      const fee = withChange.payment.fee
      return {
        kind: 'pays',
        layout: withChange,
        payment: { amount, fee, change, includeChange: true, changeDroppedSats: 0 },
      }
    }
  }
  const withoutChange = layOut(space, spent, space.withoutChange)
  const folded = payWithoutChange(space, withoutChange, amount)
  if (folded.kind !== 'short' || withChange.mergeCount === withoutChange.mergeCount) return folded
  // The fewest merges leave change that is owed but has no room. The merges
  // that make room for it cost more than they leave to return, so the same
  // merges pay the amount with what is left of the change, below dust, as fee.
  return payWithoutChange(
    space,
    layOut(space, spent, {
      inputLimit: space.withChange.inputLimit,
      estimate: space.withoutChange.estimate,
    }),
    amount
  )
}

/**
 * Whether `layout`, a payment without a change output, pays `amount`: its
 * remainder is paid as fee when a change output would return less than dust.
 */
function payWithoutChange<T extends QbitSelectableCoin>(
  space: PlanSpace<T>,
  layout: PlanLayout,
  amount: number
): AmountOutcome {
  const remainder = layout.funds - amount - layout.payment.fee
  if (!layout.mergesPayDust || remainder < 0) return { kind: 'short' }
  // Change this payment would return with a change output added, whether or
  // not that output fits: at least dust is real change, never paid as fee.
  const addedOutputFee = space.withChange.estimate(layout.paymentInputs).fee - layout.payment.fee
  if (remainder - addedOutputFee >= QBIT_P2MR_DUST) return { kind: 'short' }
  const fee = layout.payment.fee + remainder
  if (fee > qbitMaximumTotalFee(layout.payment.vsize)) {
    return { kind: 'over_maximum_fee', fits: layout.fits }
  }
  return {
    kind: 'pays',
    layout,
    payment: { amount, fee, change: 0, includeChange: false, changeDroppedSats: remainder },
  }
}

/** The prefix that delivers the most to a payment without change, the shorter on a tie. */
function bestEverything<T extends QbitSelectableCoin>(
  space: PlanSpace<T>
): { layout: PlanLayout; amount: number } | undefined {
  let best: { layout: PlanLayout; amount: number } | undefined
  for (let spent = 1; spent <= space.candidates.length; spent++) {
    const layout = layOut(space, spent, space.withoutChange)
    // A longer prefix needs at least as many merges, so it does not fit either.
    if (!layout.fits) break
    if (!layout.mergesPayDust) continue
    const amount = layout.funds - layout.payment.fee
    if (!best || amount > best.amount) best = { layout, amount }
  }
  return best && best.amount >= QBIT_P2MR_DUST ? best : undefined
}

function buildPlan<T extends QbitSelectableCoin>(
  space: PlanSpace<T>,
  target: QbitSendPlan<T>['target'],
  layout: PlanLayout,
  unconfirmedSatoshis: number,
  terms: PaymentTerms
): QbitSendPlan<T> {
  const merges: QbitSendPlanMerge<T>[] = []
  for (let index = 0; index < layout.mergeCount; index++) {
    const start = index * space.mergeLimit
    const end = Math.min(start + space.mergeLimit, layout.spent)
    const { vsize, fee } = space.merge(end - start)
    const totalInput = space.totalOf(end) - space.totalOf(start)
    merges.push({
      inputs: space.candidates.slice(start, end),
      totalInput,
      vsize,
      fee,
      outputValue: totalInput - fee,
    })
  }
  const leftBehind = space.confirmed.slice(layout.spent)
  return {
    ok: true,
    target,
    merges,
    payment: {
      coins: space.candidates.slice(layout.spent - layout.directCount, layout.spent),
      inputCount: layout.paymentInputs,
      amount: terms.amount,
      vsize: layout.payment.vsize,
      fee: terms.fee,
      change: terms.change,
      includeChange: terms.includeChange,
      changeDroppedSats: terms.changeDroppedSats,
      maximumTotalFee: qbitMaximumTotalFee(layout.payment.vsize),
    },
    totalInput: space.totalOf(layout.spent),
    totalFee: layout.mergeFees + terms.fee,
    signatureCount: layout.spent + layout.mergeCount,
    leftBehind,
    leftBehindSatoshis: leftBehind.reduce((sum, coin) => sum + coin.satoshis, 0),
    unconfirmedSatoshis,
  }
}
