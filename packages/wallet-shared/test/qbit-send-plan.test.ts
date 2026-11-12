import { describe, expect, it } from 'vitest'

import { QBIT_P2MR_DUST } from '../src/constants/common'
import * as utils from '../src/utils'
import {
  isQbitStandardTxSize,
  qbitP2mrInputFee,
  selectQbitP2mrSendCoins,
  sortQbitCoinsByValue,
  type QbitSelectableCoin,
} from '../src/utils/qbit-coin-selection'
import {
  estimateQbitP2mrTransaction,
  qbitMaximumTotalFee,
  type QbitP2mrTransactionEstimate,
} from '../src/utils/qbit-p2mr-fees'
import {
  isQbitSendPlanAmount,
  planQbitSend,
  type QbitSendPlan,
  type QbitSendPlanRefusal,
  type QbitSendPlanShape,
  type QbitSendPlanTarget,
} from '../src/utils/qbit-send-plan'

type Coin = QbitSelectableCoin
type Shape = Omit<QbitSendPlanShape, 'feeRate'>
type Result = QbitSendPlan<Coin> | QbitSendPlanRefusal

const DUST = QBIT_P2MR_DUST
const P2MR_SCRIPT = 34
const SHAPE: Shape = {
  paymentOutputScriptLengths: [P2MR_SCRIPT],
  accountScriptLength: P2MR_SCRIPT,
  leafScriptLength: 34,
  controlBlockLength: 1,
}
/** A payment with a memo output after the recipient's. */
const withMemo = (memoScriptLength: number): Shape => ({
  ...SHAPE,
  paymentOutputScriptLengths: [P2MR_SCRIPT, memoScriptLength],
})
const EVERYTHING: QbitSendPlanTarget = { kind: 'everything' }
const pay = (amount: number): QbitSendPlanTarget => ({ kind: 'amount', amount })

function coin(index: number, satoshis: number): Coin {
  return { txid: index.toString(16).padStart(64, '0'), vout: index % 4, satoshis }
}

function coins(count: number, satoshis: number | ((index: number) => number), offset = 0): Coin[] {
  return Array.from({ length: count }, (_, index) =>
    coin(offset + index, typeof satoshis === 'number' ? satoshis : satoshis(index))
  )
}

function unconfirmed(output: Coin): Coin {
  return { ...output, unconfirmed: true }
}

const total = (outputs: readonly Coin[]): number =>
  outputs.reduce((sum, { satoshis }) => sum + satoshis, 0)

function planFor(
  utxos: readonly Coin[],
  target: QbitSendPlanTarget,
  feeRate: number,
  shape: Shape = SHAPE
): Result {
  return planQbitSend({ ...shape, feeRate, utxos, target })
}

function expectPlan(result: Result): QbitSendPlan<Coin> {
  if (!result.ok) throw new Error(`expected a plan, got the refusal ${result.reason}`)
  return result
}

function expectRangeError(run: () => unknown, message: string): void {
  expect(run).toThrow(RangeError)
  expect(run).toThrow(message)
}

function expectRefusal(result: Result): QbitSendPlanRefusal {
  if (result.ok) throw new Error('expected a refusal, got a plan')
  return result
}

/** Every account output a plan spends, merges' inputs first. */
const spentBy = (sent: QbitSendPlan<Coin>): Coin[] => [
  ...sent.merges.flatMap(merge => merge.inputs),
  ...sent.payment.coins,
]

// An independent model of the plan's rules: every size straight from the
// estimator, input limits found by adding inputs until the standard size is
// passed, and the fewest merges found by trying each count in turn.

function sized(
  shape: Shape,
  feeRate: number,
  inputCount: number,
  outputScriptLengths: readonly number[]
): QbitP2mrTransactionEstimate {
  return estimateQbitP2mrTransaction({
    inputCount,
    outputScriptLengths,
    leafScriptLength: shape.leafScriptLength,
    controlBlockLength: shape.controlBlockLength,
    feeRate,
  })
}

const mergeOutputs = (shape: Shape): number[] => [shape.accountScriptLength]
const paymentOutputs = (shape: Shape, includeChange: boolean): number[] =>
  includeChange
    ? [...shape.paymentOutputScriptLengths, shape.accountScriptLength]
    : [...shape.paymentOutputScriptLengths]

interface Limits {
  merge: number
  withoutChange: number
  withChange: number
}

const knownLimits = new Map<string, Limits>()

function limitsOf(shape: Shape): Limits {
  const key = JSON.stringify(shape)
  const known = knownLimits.get(key)
  if (known) return known
  const largest = (outputs: readonly number[]): number => {
    let count = 0
    while (isQbitStandardTxSize(sized(shape, 1, count + 1, outputs).vsize)) count++
    return count
  }
  const limits = {
    merge: largest(mergeOutputs(shape)),
    withoutChange: largest(paymentOutputs(shape, false)),
    withChange: largest(paymentOutputs(shape, true)),
  }
  knownLimits.set(key, limits)
  return limits
}

function inputFeeOf(shape: Shape, feeRate: number): number {
  return qbitP2mrInputFee({
    outputScriptLengths: shape.paymentOutputScriptLengths,
    leafScriptLength: shape.leafScriptLength,
    controlBlockLength: shape.controlBlockLength,
    feeRate,
  })
}

/** The outputs a plan may spend, in the order it takes them. */
function candidatesOf(shape: Shape, feeRate: number, utxos: readonly Coin[]): Coin[] {
  const inputFee = inputFeeOf(shape, feeRate)
  return sortQbitCoinsByValue(utxos.filter(utxo => !utxo.unconfirmed && utxo.satoshis > inputFee))
}

interface ReferenceLayout {
  merges: Coin[][]
  direct: Coin[]
  paymentInputs: number
  mergeOutputs: number[]
  mergeFees: number
  /** Every merge returns at least dust and every transaction is within the standard size. */
  valid: boolean
  /** What the payment's inputs hold. */
  funds: number
  payment: QbitP2mrTransactionEstimate
}

/**
 * The layout for exactly `outputs`, highest value first: the fewest merges,
 * each taking a full merge's worth in order, after which the payment carries
 * no more inputs than it can. Undefined when no number of merges brings it
 * there. `roomForChange` lays the merges out for the payment with a change
 * output even when the payment goes without one.
 */
function referenceLayout(
  shape: Shape,
  feeRate: number,
  outputs: readonly Coin[],
  includeChange: boolean,
  roomForChange = includeChange
): ReferenceLayout | undefined {
  const limits = limitsOf(shape)
  const paymentLimit = roomForChange ? limits.withChange : limits.withoutChange
  for (let mergeCount = 0; mergeCount <= paymentLimit; mergeCount++) {
    const merged = Math.min(outputs.length, mergeCount * limits.merge)
    const direct = outputs.slice(merged)
    if (direct.length + mergeCount > paymentLimit) continue
    const merges: Coin[][] = []
    for (let start = 0; start < merged; start += limits.merge) {
      merges.push(outputs.slice(start, Math.min(start + limits.merge, merged)))
    }
    if (merges.length !== mergeCount) return undefined
    let valid = true
    let mergeFees = 0
    const values: number[] = []
    for (const inputs of merges) {
      const merge = sized(shape, feeRate, inputs.length, mergeOutputs(shape))
      const value = total(inputs) - merge.fee
      valid = valid && isQbitStandardTxSize(merge.vsize) && value >= DUST
      mergeFees += merge.fee
      values.push(value)
    }
    const paymentInputs = direct.length + mergeCount
    const payment = sized(shape, feeRate, paymentInputs, paymentOutputs(shape, includeChange))
    return {
      merges,
      direct,
      paymentInputs,
      mergeOutputs: values,
      mergeFees,
      valid: valid && isQbitStandardTxSize(payment.vsize),
      funds: total(direct) + values.reduce((sum, value) => sum + value, 0),
      payment,
    }
  }
  return undefined
}

interface ReferenceTerms {
  includeChange: boolean
  change: number
  fee: number
  changeDroppedSats: number
}

/**
 * Whether a plan of exactly `outputs` pays `amount`: with change of at least
 * dust, or with a smaller remainder as fee within the payment's maximum total
 * fee. A remainder that would be at least dust with a change output added is
 * change, and is never paid as fee. When the merges that make room for the
 * change output leave less than dust to return, the payment keeps those
 * merges and pays what is left as fee.
 */
function referencePays(
  shape: Shape,
  feeRate: number,
  outputs: readonly Coin[],
  amount: number
): ReferenceTerms | 'over_maximum_fee' | undefined {
  const withChange = referenceLayout(shape, feeRate, outputs, true)
  if (withChange?.valid) {
    const change = withChange.funds - amount - withChange.payment.fee
    if (change >= DUST) {
      return { includeChange: true, change, fee: withChange.payment.fee, changeDroppedSats: 0 }
    }
  }
  const plain = referenceLayout(shape, feeRate, outputs, false)
  const folded = referenceFolds(shape, feeRate, plain, amount)
  if (folded !== undefined) return folded
  const roomy = referenceLayout(shape, feeRate, outputs, false, true)
  if (!plain || !roomy || roomy.merges.length === plain.merges.length) return undefined
  return referenceFolds(shape, feeRate, roomy, amount)
}

/** Whether `layout`, a payment without a change output, pays `amount` with its remainder as fee. */
function referenceFolds(
  shape: Shape,
  feeRate: number,
  layout: ReferenceLayout | undefined,
  amount: number
): ReferenceTerms | 'over_maximum_fee' | undefined {
  if (!layout?.valid) return undefined
  const remainder = layout.funds - amount - layout.payment.fee
  if (remainder < 0) return undefined
  const changeOutputFee = sized(
    shape,
    feeRate,
    layout.paymentInputs,
    paymentOutputs(shape, true)
  ).fee
  if (layout.funds - amount - changeOutputFee >= DUST) return undefined
  const fee = layout.payment.fee + remainder
  if (fee > qbitMaximumTotalFee(layout.payment.vsize)) return 'over_maximum_fee'
  return { includeChange: false, change: 0, fee, changeDroppedSats: remainder }
}

const paysOn = (outcome: ReturnType<typeof referencePays>): outcome is ReferenceTerms =>
  typeof outcome === 'object'

/** What a payment without change delivers from exactly `outputs`, when they can be planned. */
function referenceAmount(
  shape: Shape,
  feeRate: number,
  outputs: readonly Coin[]
): number | undefined {
  const layout = referenceLayout(shape, feeRate, outputs, false)
  return layout?.valid ? layout.funds - layout.payment.fee : undefined
}

/** Every prefix of the candidates, tried in turn: the one that delivers the most, the shorter on a tie. */
function referenceEverything(
  shape: Shape,
  feeRate: number,
  utxos: readonly Coin[]
): { spent: number; amount: number } | undefined {
  const candidates = candidatesOf(shape, feeRate, utxos)
  let best: { spent: number; amount: number } | undefined
  for (let spent = 1; spent <= candidates.length; spent++) {
    const amount = referenceAmount(shape, feeRate, candidates.slice(0, spent))
    if (amount !== undefined && (!best || amount > best.amount)) best = { spent, amount }
  }
  return best && best.amount >= DUST ? best : undefined
}

interface PlanCase {
  utxos: readonly Coin[]
  feeRate: number
  shape: Shape
}

/** Every guarantee a plan makes, checked against the estimator and the outputs it was given. */
function expectSoundPlan(
  result: Result,
  { utxos, feeRate, shape }: PlanCase,
  target: QbitSendPlanTarget
): QbitSendPlan<Coin> {
  const sent = expectPlan(result)
  const limits = limitsOf(shape)
  expect(sent.target).toBe(target.kind)

  for (const merge of sent.merges) {
    const expected = sized(shape, feeRate, merge.inputs.length, mergeOutputs(shape))
    expect(merge.inputs.length).toBeGreaterThanOrEqual(2)
    expect(merge.inputs.length).toBeLessThanOrEqual(limits.merge)
    expect(merge.vsize).toBe(expected.vsize)
    expect(merge.fee).toBe(expected.fee)
    expect(isQbitStandardTxSize(merge.vsize)).toBe(true)
    expect(merge.totalInput).toBe(total(merge.inputs))
    expect(merge.outputValue).toBe(merge.totalInput - merge.fee)
    expect(merge.outputValue).toBeGreaterThanOrEqual(DUST)
  }

  const { payment } = sent
  const expected = sized(
    shape,
    feeRate,
    payment.inputCount,
    paymentOutputs(shape, payment.includeChange)
  )
  expect(payment.inputCount).toBe(payment.coins.length + sent.merges.length)
  expect(payment.vsize).toBe(expected.vsize)
  expect(isQbitStandardTxSize(payment.vsize)).toBe(true)
  expect(payment.maximumTotalFee).toBe(qbitMaximumTotalFee(payment.vsize))
  expect(payment.fee).toBeLessThanOrEqual(payment.maximumTotalFee)
  expect(payment.fee).toBe(expected.fee + payment.changeDroppedSats)
  if (payment.includeChange) {
    expect(payment.change).toBeGreaterThanOrEqual(DUST)
    expect(payment.changeDroppedSats).toBe(0)
  } else {
    expect(payment.change).toBe(0)
    expect(payment.changeDroppedSats).toBeGreaterThanOrEqual(0)
  }
  const merged = sent.merges.reduce((sum, merge) => sum + merge.outputValue, 0)
  expect(total(payment.coins) + merged).toBe(payment.amount + payment.change + payment.fee)
  if (target.kind === 'amount') {
    expect(payment.amount).toBe(target.amount)
  } else {
    expect(payment.includeChange).toBe(false)
    expect(payment.changeDroppedSats).toBe(0)
  }
  expect(payment.amount).toBeGreaterThanOrEqual(DUST)

  // Each output is spent once, and only confirmed outputs worth their input fee.
  const spent = spentBy(sent)
  const given = new Set(utxos)
  const inputFee = inputFeeOf(shape, feeRate)
  expect(new Set(spent.map(({ txid, vout }) => `${txid}:${vout}`)).size).toBe(spent.length)
  for (const output of spent) {
    expect(given.has(output)).toBe(true)
    expect(output.unconfirmed).toBeFalsy()
    expect(output.satoshis).toBeGreaterThan(inputFee)
  }

  const mergeFees = sent.merges.reduce((sum, merge) => sum + merge.fee, 0)
  const mergeInputs = sent.merges.reduce((sum, merge) => sum + merge.inputs.length, 0)
  expect(sent.totalInput).toBe(total(spent))
  expect(sent.totalFee).toBe(mergeFees + payment.fee)
  expect(sent.totalInput).toBe(payment.amount + payment.change + sent.totalFee)
  expect(sent.signatureCount).toBe(mergeInputs + payment.inputCount)

  const spentSet = new Set(spent)
  const kept = utxos.filter(utxo => !utxo.unconfirmed && !spentSet.has(utxo))
  const waiting = utxos.filter(utxo => utxo.unconfirmed)
  expect(sent.leftBehind).toEqual(sortQbitCoinsByValue(kept))
  expect(sent.leftBehindSatoshis).toBe(total(kept))
  expect(sent.unconfirmedSatoshis).toBe(total(waiting))
  expect(sent.totalInput + sent.leftBehindSatoshis + sent.unconfirmedSatoshis).toBe(total(utxos))

  // The largest candidates, laid out with the fewest merges the payment needs.
  const prefix = candidatesOf(shape, feeRate, utxos).slice(0, spent.length)
  const fewestFor = (paymentLimit: number): number =>
    spent.length <= paymentLimit ? 0 : Math.ceil((spent.length - paymentLimit) / (limits.merge - 1))
  const fewest = fewestFor(payment.includeChange ? limits.withChange : limits.withoutChange)
  // An amount paid without change may carry the merges that made room for
  // change, when their fees left less than dust of it to return.
  const allowed =
    target.kind === 'amount' && !payment.includeChange
      ? [fewest, fewestFor(limits.withChange)]
      : [fewest]
  expect(allowed).toContain(sent.merges.length)
  sent.merges.forEach((merge, index) => {
    expect(merge.inputs).toEqual(prefix.slice(index * limits.merge, (index + 1) * limits.merge))
  })
  expect(payment.coins).toEqual(prefix.slice(sent.merges.length * limits.merge))
  return sent
}

/** No confirmed output the plan leaves behind would raise the amount if it were spent too. */
function expectNothingWorthAdding(sent: QbitSendPlan<Coin>, { feeRate, shape }: PlanCase): void {
  const spent = spentBy(sent)
  for (const output of sent.leftBehind) {
    const amount = referenceAmount(shape, feeRate, sortQbitCoinsByValue([...spent, output]))
    if (amount !== undefined) expect(amount).toBeLessThanOrEqual(sent.payment.amount)
  }
}

function singleTransaction(
  { utxos, feeRate, shape }: PlanCase,
  amount: number
): ReturnType<typeof selectQbitP2mrSendCoins> {
  return selectQbitP2mrSendCoins({
    outputScriptLengths: shape.paymentOutputScriptLengths,
    leafScriptLength: shape.leafScriptLength,
    controlBlockLength: shape.controlBlockLength,
    feeRate,
    utxos: utxos.filter(utxo => !utxo.unconfirmed),
    amount,
    changeScriptLength: shape.accountScriptLength,
  })
}

/**
 * Plan `amount` and check it: a plan is sound and spends the fewest outputs
 * that pay it; a refusal names the everything amount, which can be planned.
 * `exhaustive` tries every shorter prefix rather than only the one before.
 */
function expectAmountGuarantees(
  planCase: PlanCase,
  amount: number,
  maxSendable: number,
  exhaustive: boolean
): Result {
  const { utxos, feeRate, shape } = planCase
  const result = planFor(utxos, pay(amount), feeRate, shape)
  const candidates = candidatesOf(shape, feeRate, utxos)
  const single = singleTransaction(planCase, amount)
  if (result.ok) {
    const sent = expectSoundPlan(result, planCase, pay(amount))
    const spent = spentBy(sent).length
    const terms = referencePays(shape, feeRate, candidates.slice(0, spent), amount)
    expect(paysOn(terms)).toBe(true)
    expect(terms).toEqual({
      includeChange: sent.payment.includeChange,
      change: sent.payment.change,
      fee: sent.payment.fee,
      changeDroppedSats: sent.payment.changeDroppedSats,
    })
    const shorter = exhaustive ? spent - 1 : Math.min(1, spent - 1)
    for (let fewer = spent - shorter; fewer < spent; fewer++) {
      expect(paysOn(referencePays(shape, feeRate, candidates.slice(0, fewer), amount))).toBe(false)
    }
    if (single.ok) {
      // One transaction pays it: the plan is that transaction, with no merges.
      expect(sent.merges).toEqual([])
      expect(sent.payment).toEqual({
        coins: single.selected,
        inputCount: single.inputCount,
        amount,
        vsize: single.estimate.vsize,
        fee: single.fee,
        change: single.change,
        includeChange: single.includeChange,
        changeDroppedSats: single.changeDroppedSats,
        maximumTotalFee: single.maximumTotalFee,
      })
    }
    return result
  }
  expect(single.ok).toBe(false)
  expect(result.maxSendable).toBe(maxSendable)
  expect(result.unconfirmedSatoshis).toBe(total(utxos.filter(utxo => utxo.unconfirmed)))
  if (exhaustive) {
    const outcomes = candidates.map((_, index) =>
      referencePays(shape, feeRate, candidates.slice(0, index + 1), amount)
    )
    expect(outcomes.some(paysOn)).toBe(false)
    expect(outcomes.includes('over_maximum_fee')).toBe(
      result.reason === 'exceeds_maximum_total_fee'
    )
  }
  if (result.reason === 'exceeds_plan_size') {
    const limits = limitsOf(shape)
    expect(candidates.length).toBeGreaterThan(limits.withoutChange * limits.merge)
  }
  if (maxSendable >= DUST) {
    expectSoundPlan(planFor(utxos, pay(maxSendable), feeRate, shape), planCase, pay(maxSendable))
  }
  return result
}

/** A seeded generator, so a failing case reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const between = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1))

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = between(random, 0, index)
    const moved = copy[index]!
    copy[index] = copy[other]!
    copy[other] = moved
  }
  return copy
}

describe('planQbitSend layout', () => {
  const FULL_MERGE_VSIZE = 398_827
  const FULL_MERGE_FEE: Record<string, number> = { '0.25': 99_707, '1': 398_827, '1.37': 546_393 }
  const PAYMENT_VSIZE: Record<number, number> = { 2: 7_579, 3: 11_341, 4: 15_103, 80: 301_015 }
  const EXAMPLES = [
    { count: 107, merges: [106], paymentInputs: 2 },
    { count: 214, merges: [106, 106], paymentInputs: 4 },
    { count: 317, merges: [106, 106, 105], paymentInputs: 3 },
    { count: 500, merges: [106, 106, 106, 106], paymentInputs: 80 },
  ]

  for (const feeRate of [0.25, 1, 1.37]) {
    it(`lays out 107, 214, 317 and 500 outputs with exact sizes and fees at ${feeRate} bits/vB`, () => {
      for (const { count, merges, paymentInputs } of EXAMPLES) {
        const planCase = { utxos: coins(count, index => 60_000 + index), feeRate, shape: SHAPE }
        const sent = expectSoundPlan(
          planFor(planCase.utxos, EVERYTHING, feeRate),
          planCase,
          EVERYTHING
        )
        expect(sent.merges.map(merge => merge.inputs.length)).toEqual(merges)
        for (const merge of sent.merges) {
          if (merge.inputs.length === 106) {
            expect(merge.vsize).toBe(FULL_MERGE_VSIZE)
            expect(merge.fee).toBe(FULL_MERGE_FEE[String(feeRate)])
          } else {
            expect(merge.vsize).toBe(395_065)
          }
          expect(merge.fee).toBe(Math.ceil(merge.vsize * feeRate))
        }
        expect(sent.payment.inputCount).toBe(paymentInputs)
        expect(sent.payment.coins).toHaveLength(paymentInputs - merges.length)
        expect(sent.payment.vsize).toBe(PAYMENT_VSIZE[paymentInputs])
        expect(sent.payment.fee).toBe(Math.ceil(sent.payment.vsize * feeRate))
        expect(sent.leftBehind).toEqual([])
        expect(sent.totalInput).toBe(total(planCase.utxos))
        expect(sent.payment.amount).toBe(sent.totalInput - sent.totalFee)
        expect(sent.signatureCount).toBe(count + merges.length)
        expect(referenceEverything(SHAPE, feeRate, planCase.utxos)).toEqual({
          spent: count,
          amount: sent.payment.amount,
        })

        // An amount that needs every output, with change, has the same layout.
        const amount = sent.payment.amount - DUST - 100
        const withChange = expectSoundPlan(
          planFor(planCase.utxos, pay(amount), feeRate),
          planCase,
          pay(amount)
        )
        expect(withChange.merges.map(merge => merge.inputs.length)).toEqual(merges)
        expect(withChange.payment).toMatchObject({ includeChange: true, inputCount: paymentInputs })
        // The change output adds 43 bytes to the payment's size.
        expect(withChange.payment.vsize).toBe(sent.payment.vsize + 43)
      }
    })
  }

  it('spends 106 outputs in one payment and merges from the 107th', () => {
    const planCase = { utxos: coins(107, index => 60_000 + index), feeRate: 1, shape: SHAPE }
    const direct = expectSoundPlan(
      planFor(planCase.utxos.slice(1), EVERYTHING, 1),
      { ...planCase, utxos: planCase.utxos.slice(1) },
      EVERYTHING
    )
    expect(direct.merges).toEqual([])
    expect(direct.payment).toMatchObject({ inputCount: 106, vsize: 398_827, fee: 398_827 })

    const merged = expectSoundPlan(planFor(planCase.utxos, EVERYTHING, 1), planCase, EVERYTHING)
    expect(merged.merges).toHaveLength(1)
    expect(merged.merges[0]!.inputs).toHaveLength(106)
    // The smallest output goes into the payment beside the merge's output.
    expect(merged.payment.coins).toEqual([planCase.utxos[0]])
    expect(merged.payment).toMatchObject({ inputCount: 2, vsize: 7_579, fee: 7_579 })
    expect(merged.totalFee).toBe(398_827 + 7_579)
  })

  it('leaves an output behind when merging it would not raise the amount', () => {
    // A 107th output adds a merge and a second payment input: 7,579 bits at
    // 1 bit/vB, more than the 5,000 it holds.
    const utxos = coins(107, 5_000)
    const sent = expectSoundPlan(
      planFor(utxos, EVERYTHING, 1),
      { utxos, feeRate: 1, shape: SHAPE },
      EVERYTHING
    )
    expect(sent.merges).toEqual([])
    expect(sent.payment.inputCount).toBe(106)
    expect(sent.leftBehind).toEqual([utxos[106]])
    expect(sent.leftBehindSatoshis).toBe(5_000)
    expect(referenceAmount(SHAPE, 1, candidatesOf(SHAPE, 1, utxos))).toBe(
      sent.payment.amount + 5_000 - 7_579
    )
    expectNothingWorthAdding(sent, { utxos, feeRate: 1, shape: SHAPE })
  })

  it('plans at most 106 merges, 11,236 outputs, and refuses an amount only more merges could pay', () => {
    const utxos = coins(12_000, 10_000)
    const largest = utxos.slice(0, 11_236)
    const planCase = { utxos: largest, feeRate: 1, shape: SHAPE }
    const sent = expectSoundPlan(planFor(largest, EVERYTHING, 1), planCase, EVERYTHING)
    expect(sent.merges).toHaveLength(106)
    expect(sent.merges.every(merge => merge.inputs.length === 106)).toBe(true)
    expect(sent.payment.coins).toEqual([])
    expect(sent.payment.inputCount).toBe(106)
    expect(sent.signatureCount).toBe(11_236 + 106)
    // 107 transactions of 398,827 bytes each.
    expect(sent.totalFee).toBe(107 * 398_827)
    const maxSendable = 11_236 * 10_000 - 107 * 398_827
    expect(sent.payment.amount).toBe(maxSendable)

    expectSoundPlan(planFor(largest, pay(maxSendable), 1), planCase, pay(maxSendable))
    expect(planFor(largest, pay(maxSendable + 1), 1)).toEqual({
      ok: false,
      reason: 'insufficient_balance',
      maxSendable,
      unconfirmedSatoshis: 0,
    })

    for (const count of [11_237, 12_000]) {
      const more = utxos.slice(0, count)
      const most = expectSoundPlan(
        planFor(more, EVERYTHING, 1),
        { ...planCase, utxos: more },
        EVERYTHING
      )
      expect(most.payment.amount).toBe(maxSendable)
      expect(most.leftBehind).toEqual(more.slice(11_236))
      // A 107th merge would let the 11,237th output pay the extra bit.
      expect(planFor(more, pay(maxSendable + 1), 1)).toEqual({
        ok: false,
        reason: 'exceeds_plan_size',
        maxSendable,
        unconfirmedSatoshis: 0,
      })
    }
  })

  it('never plans a merge that would return less than dust', () => {
    // 212 large outputs fill two merges; a third merge of 105 or 106 outputs
    // of 3,763 bits returns 50 or 51 bits at 1 bit/vB.
    const utxos = [...coins(212, 1_000_000), ...coins(120, 3_763, 212)]
    const planCase = { utxos, feeRate: 1, shape: SHAPE }
    expect(105 * 3_763 - sized(SHAPE, 1, 105, [P2MR_SCRIPT]).fee).toBe(50)
    expect(106 * 3_763 - sized(SHAPE, 1, 106, [P2MR_SCRIPT]).fee).toBe(51)

    const sent = expectSoundPlan(planFor(utxos, EVERYTHING, 1), planCase, EVERYTHING)
    // The payment takes 104 small outputs directly, up to its 106 inputs.
    expect(sent.merges.map(merge => merge.inputs.length)).toEqual([106, 106])
    expect(sent.payment.coins).toHaveLength(104)
    expect(referenceEverything(SHAPE, 1, utxos)).toEqual({
      spent: 316,
      amount: sent.payment.amount,
    })
    for (let spent = 317; spent <= 332; spent++) {
      const layout = referenceLayout(SHAPE, 1, candidatesOf(SHAPE, 1, utxos).slice(0, spent), false)
      expect(layout?.valid).toBe(false)
      expect(Math.min(...(layout?.mergeOutputs ?? []))).toBeLessThan(DUST)
    }

    const short = expectAmountGuarantees(
      planCase,
      sent.payment.amount + 1,
      sent.payment.amount,
      true
    )
    expect(short).toMatchObject({ ok: false, reason: 'insufficient_balance' })
  })

  it('passes over prefixes whose last merge would return less than dust', () => {
    // With a memo that leaves the payment 40 inputs, a 146th output starts a
    // second merge of 40 outputs of 3,800 bits, which returns 1,465 bits. It
    // returns dust from 77 outputs on.
    const shape = withMemo(249_000)
    expect(limitsOf(shape)).toEqual({ merge: 106, withoutChange: 40, withChange: 40 })
    const utxos = [...coins(106, 1_000_000), ...coins(200, 3_800, 106)]
    const planCase = { utxos, feeRate: 1, shape }
    const candidates = candidatesOf(shape, 1, utxos)
    const short = referenceLayout(shape, 1, candidates.slice(0, 146), false)
    expect(short?.mergeOutputs).toEqual([106 * 1_000_000 - 398_827, 1_465])
    for (let spent = 146; spent < 183; spent++) {
      expect(referenceLayout(shape, 1, candidates.slice(0, spent), false)?.valid).toBe(false)
    }
    expect(referenceLayout(shape, 1, candidates.slice(0, 183), false)?.valid).toBe(true)

    // One bit more than 145 outputs deliver needs the second merge.
    const before = referenceAmount(shape, 1, candidates.slice(0, 145))!
    const sent = expectPlan(
      expectAmountGuarantees(
        planCase,
        before + 1,
        referenceEverything(shape, 1, utxos)!.amount,
        true
      )
    )
    expect(spentBy(sent).length).toBeGreaterThan(182)
    expect(sent.merges).toHaveLength(2)
  })

  it('leaves out a merge below dust even where it would raise the amount', () => {
    // At 0.25 bits/vB an input adds 940.5 bits, less than dust. A second merge
    // of 960-bit outputs nets about 19.5 bits for each, but even full it
    // returns 2,053 bits, below dust, so it is never planned.
    const shape = withMemo(249_000)
    const utxos = [...coins(106, 1_000_000), ...coins(200, 960, 106)]
    const planCase = { utxos, feeRate: 0.25, shape }
    expect(106 * 960 - sized(shape, 0.25, 106, [P2MR_SCRIPT]).fee).toBe(2_053)
    const candidates = candidatesOf(shape, 0.25, utxos)
    expect(candidates).toHaveLength(306)

    const sent = expectSoundPlan(planFor(utxos, EVERYTHING, 0.25, shape), planCase, EVERYTHING)
    expect(referenceEverything(shape, 0.25, utxos)).toEqual({
      spent: 145,
      amount: sent.payment.amount,
    })
    expect(sent.merges.map(merge => merge.inputs.length)).toEqual([106])
    for (const spent of [212, 230, 250]) {
      const layout = referenceLayout(shape, 0.25, candidates.slice(0, spent), false)!
      expect(layout.valid).toBe(false)
      // Dust aside, these would deliver more.
      expect(layout.funds - layout.payment.fee).toBeGreaterThan(sent.payment.amount)
    }
    expect(
      expectAmountGuarantees(planCase, sent.payment.amount + 1, sent.payment.amount, true)
    ).toMatchObject({ ok: false, reason: 'insufficient_balance' })
  })
})

describe('planQbitSend change', () => {
  it('folds a remainder below dust into the fee, as one transaction does', () => {
    const utxos = [coin(1, 100_000)]
    const planCase = { utxos, feeRate: 1, shape: SHAPE }
    // 3,817 bits pay a one-input send; 1,000 bits are left.
    const folded = expectPlan(
      expectAmountGuarantees(planCase, 100_000 - 3_817 - 1_000, 96_183, true)
    )
    expect(folded.payment).toMatchObject({
      includeChange: false,
      change: 0,
      fee: 4_817,
      changeDroppedSats: 1_000,
    })

    // The same with a merge: the payment's remainder is folded and the merge is unchanged.
    const many = { utxos: coins(107, index => 60_000 + index), feeRate: 1, shape: SHAPE }
    const max = referenceEverything(SHAPE, 1, many.utxos)!.amount
    const withMerge = expectPlan(expectAmountGuarantees(many, max - 1_000, max, false))
    expect(withMerge.merges).toHaveLength(1)
    expect(withMerge.payment).toMatchObject({
      includeChange: false,
      fee: 7_579 + 1_000,
      changeDroppedSats: 1_000,
    })
    expect(withMerge.totalFee).toBe(398_827 + 7_579 + 1_000)

    // From dust plus the change output's 43 bits on, the remainder is change.
    const change = expectPlan(expectAmountGuarantees(many, max - DUST - 43, max, false))
    expect(change.payment).toMatchObject({
      includeChange: true,
      change: DUST,
      changeDroppedSats: 0,
    })
    const below = expectPlan(expectAmountGuarantees(many, max - DUST - 42, max, false))
    expect(below.payment).toMatchObject({ includeChange: false, changeDroppedSats: DUST + 42 })
  })

  it('takes more outputs when a folded fee would pass the maximum total fee', () => {
    // At 10,000 bits/vB a one-input send's fee is already its maximum.
    const one = [coin(1, 100_000_000)]
    const oneCase = { utxos: one, feeRate: 10_000, shape: SHAPE }
    expect(qbitMaximumTotalFee(3_817)).toBe(38_170_000)
    const maxSendable = 100_000_000 - 38_170_000
    const refused = expectAmountGuarantees(oneCase, maxSendable - 1, maxSendable, true)
    expect(refused).toEqual({
      ok: false,
      reason: 'exceeds_maximum_total_fee',
      maxSendable,
      unconfirmedSatoshis: 0,
    })
    expect(expectPlan(planFor(one, pay(maxSendable), 10_000)).payment.fee).toBe(38_170_000)

    const two = [...one, coin(2, 100_000_000)]
    const sent = expectPlan(
      expectAmountGuarantees(
        { ...oneCase, utxos: two },
        maxSendable - 1,
        200_000_000 - 75_790_000,
        true
      )
    )
    expect(sent.payment).toMatchObject({
      inputCount: 2,
      includeChange: true,
      fee: 76_220_000,
      change: 200_000_000 - (maxSendable - 1) - 76_220_000,
    })
  })

  it('names the maximum total fee before the plan size when both stand in the way', () => {
    // At 10,000 bits/vB every fee is a multiple of 10,000 bits and so is
    // every amount these outputs deliver: one bit less than the largest is
    // a remainder of one bit, past the payment's maximum total fee. Outputs
    // beyond 11,236 could return it as change only with a 107th merge.
    const utxos = coins(11_300, 50_000_000)
    const all = expectPlan(planFor(utxos, EVERYTHING, 10_000))
    const maxSendable = all.payment.amount
    expect(maxSendable % 10_000).toBe(0)
    expect(planFor(utxos, pay(maxSendable - 1), 10_000)).toEqual({
      ok: false,
      reason: 'exceeds_maximum_total_fee',
      maxSendable,
      unconfirmedSatoshis: 0,
    })
    expect(planFor(utxos, pay(maxSendable + 1), 10_000)).toMatchObject({
      ok: false,
      reason: 'exceeds_plan_size',
    })
  })

  it('merges 106 outputs when a memo leaves the payment room for 105', () => {
    // A 1,163-byte memo leaves room for 105 inputs with or without change.
    const shape = withMemo(1_163)
    expect(limitsOf(shape)).toEqual({ merge: 106, withoutChange: 105, withChange: 105 })
    const utxos = coins(106, index => 60_000 + index)
    const sent = expectSoundPlan(
      planFor(utxos, EVERYTHING, 1, shape),
      { utxos, feeRate: 1, shape },
      EVERYTHING
    )
    expect(sent.merges.map(merge => merge.inputs.length)).toEqual([106])
    expect(sent.payment.coins).toEqual([])
    expect(sent.payment.inputCount).toBe(1)
  })

  it('merges to return change that does not fit beside 106 inputs', () => {
    // A 1,120-byte memo leaves room for 106 inputs without change but 105 with it.
    const shape = withMemo(1_120)
    expect(limitsOf(shape)).toEqual({ merge: 106, withoutChange: 106, withChange: 105 })
    const utxos = coins(106, 50_000)
    const planCase = { utxos, feeRate: 1, shape }
    const max = referenceEverything(shape, 1, utxos)!.amount

    // One bit more than 105 outputs deliver: 106 owe 46,194 bits of change,
    // too much to pay as fee, and one transaction cannot return it.
    const amount = 105 * 50_000 - sized(shape, 1, 105, [P2MR_SCRIPT, 1_120]).fee + 1
    expect(singleTransaction(planCase, amount)).toMatchObject({
      ok: false,
      reason: 'exceeds_standard_size',
    })
    const sent = expectPlan(expectAmountGuarantees(planCase, amount, max, true))
    expect(sent.merges.map(merge => merge.inputs.length)).toEqual([106])
    expect(sent.payment).toMatchObject({ inputCount: 1, includeChange: true })
    expect(sent.payment.vsize).toBe(sized(shape, 1, 1, [P2MR_SCRIPT, 1_120, P2MR_SCRIPT]).vsize)

    // A remainder below dust needs no change output, and so no merge.
    const folded = expectPlan(expectAmountGuarantees(planCase, max - 1_000, max, true))
    expect(folded.merges).toEqual([])
    expect(folded.payment).toMatchObject({
      inputCount: 106,
      vsize: 399_958,
      changeDroppedSats: 1_000,
    })

    // 3,000 bits left over are change, too much to pay as fee. Returning
    // them takes the merge, and the merge with its one-input payment costs
    // 3,860 bits more than the payment without change: these outputs cannot
    // pay this amount, though they can pay more.
    const stranded = expectAmountGuarantees(planCase, max - 3_000, max, true)
    expect(stranded).toEqual({
      ok: false,
      reason: 'insufficient_balance',
      maxSendable: max,
      unconfirmedSatoshis: 0,
    })
    const viaMerge = referenceLayout(shape, 1, utxos, true)!
    expect(viaMerge.merges).toHaveLength(1)
    expect(viaMerge.mergeFees + viaMerge.payment.fee).toBe(
      sized(shape, 1, 106, [P2MR_SCRIPT, 1_120]).fee + 3_860
    )

    // From the merge's own cost on, the merge pays the amount: what is left
    // of the change is below dust and goes to the fee, with no change output.
    const mergeCost =
      sized(shape, 1, 106, [P2MR_SCRIPT]).fee +
      sized(shape, 1, 1, [P2MR_SCRIPT, 1_120]).fee -
      sized(shape, 1, 106, [P2MR_SCRIPT, 1_120]).fee
    expect(mergeCost).toBe(3_817)
    expect(expectAmountGuarantees(planCase, max - (mergeCost - 1), max, true).ok).toBe(false)
    for (const below of [mergeCost, 5_000, mergeCost + 43 + QBIT_P2MR_DUST - 1]) {
      const viaFold = expectPlan(expectAmountGuarantees(planCase, max - below, max, true))
      expect(viaFold.merges.map(merge => merge.inputs.length)).toEqual([106])
      expect(viaFold.payment).toMatchObject({
        inputCount: 1,
        includeChange: false,
        change: 0,
        changeDroppedSats: below - mergeCost,
        vsize: sized(shape, 1, 1, [P2MR_SCRIPT, 1_120]).vsize,
      })
    }
    // One bit more is change of exactly dust, returned.
    const returned = expectPlan(
      expectAmountGuarantees(planCase, max - (mergeCost + 43 + QBIT_P2MR_DUST), max, true)
    )
    expect(returned.payment).toMatchObject({ includeChange: true, change: QBIT_P2MR_DUST })
  })
})

describe('planQbitSend outputs', () => {
  it('never spends unconfirmed outputs and reports what they hold', () => {
    const utxos = [coin(1, 50_000), unconfirmed(coin(2, 1_000_000)), coin(3, 30_000)]
    const planCase = { utxos, feeRate: 1, shape: SHAPE }
    const sent = expectSoundPlan(planFor(utxos, EVERYTHING, 1), planCase, EVERYTHING)
    expect(spentBy(sent)).toEqual([utxos[0], utxos[2]])
    expect(sent.unconfirmedSatoshis).toBe(1_000_000)
    expect(sent.leftBehind).toEqual([])
    expect(expectAmountGuarantees(planCase, 500_000, sent.payment.amount, true)).toEqual({
      ok: false,
      reason: 'insufficient_balance',
      maxSendable: sent.payment.amount,
      unconfirmedSatoshis: 1_000_000,
    })
  })

  it('spends only outputs worth more than the fee their input adds', () => {
    // At 1 bit/vB an input adds 3,762 bits: an output of 3,763 adds one bit.
    const utxos = [...coins(3, 3_762), ...coins(3, 3_763, 3), coin(6, 200_000)]
    const planCase = { utxos, feeRate: 1, shape: SHAPE }
    const sent = expectSoundPlan(planFor(utxos, EVERYTHING, 1), planCase, EVERYTHING)
    expect(spentBy(sent)).toEqual([utxos[6], utxos[3], utxos[4], utxos[5]])
    expect(sent.payment.amount).toBe(200_000 + 3 * 3_763 - 15_103)
    expect(sent.leftBehind).toEqual(utxos.slice(0, 3))
    expectNothingWorthAdding(sent, planCase)

    // At the 0.25 floor an input adds 940.5 bits, and every one is worth spending.
    const atFloor = expectSoundPlan(
      planFor(utxos, EVERYTHING, 0.25),
      { ...planCase, feeRate: 0.25 },
      EVERYTHING
    )
    expect(atFloor.leftBehind).toEqual([])
  })

  it('leaves behind an output that adds exactly nothing', () => {
    // At 1.37 bits/vB a second input raises the fee from 5,230 to 10,384
    // bits: an output of 5,154 bits adds nothing, and the shorter plan wins.
    const utxos = [coin(1, 1_000_000), coin(2, 5_154)]
    const planCase = { utxos, feeRate: 1.37, shape: SHAPE }
    expect(sized(SHAPE, 1.37, 1, [P2MR_SCRIPT]).fee).toBe(5_230)
    expect(sized(SHAPE, 1.37, 2, [P2MR_SCRIPT]).fee).toBe(10_384)
    const sent = expectSoundPlan(planFor(utxos, EVERYTHING, 1.37), planCase, EVERYTHING)
    expect(spentBy(sent)).toEqual([utxos[0]])
    expect(sent.leftBehind).toEqual([utxos[1]])
    expect(referenceAmount(SHAPE, 1.37, candidatesOf(SHAPE, 1.37, utxos))).toBe(sent.payment.amount)
  })

  it('refuses when there is nothing to spend', () => {
    for (const { utxos, unconfirmedSatoshis } of [
      { utxos: [], unconfirmedSatoshis: 0 },
      { utxos: [unconfirmed(coin(1, 1_000_000))], unconfirmedSatoshis: 1_000_000 },
      { utxos: [coin(1, 3_762), coin(2, 1_000)], unconfirmedSatoshis: 0 },
    ]) {
      expect(planFor(utxos, EVERYTHING, 1)).toEqual({
        ok: false,
        reason: 'nothing_to_send',
        maxSendable: 0,
        unconfirmedSatoshis,
      })
      expect(planFor(utxos, pay(DUST), 1)).toEqual({
        ok: false,
        reason: 'insufficient_balance',
        maxSendable: 0,
        unconfirmedSatoshis,
      })
    }
    // Everything must deliver at least dust: 3,817 bits pay a one-input send.
    expect(planFor([coin(1, 3_817 + DUST - 1)], EVERYTHING, 1)).toMatchObject({
      ok: false,
      reason: 'nothing_to_send',
    })
    expect(expectPlan(planFor([coin(1, 3_817 + DUST)], EVERYTHING, 1)).payment.amount).toBe(DUST)
  })

  it('gives the same plan whatever order the outputs are listed in', () => {
    const random = seeded(7)
    const utxos = [
      ...coins(400, () => between(random, 4_000, 90_000)),
      ...coins(20, 55_555, 400),
      unconfirmed(coin(420, 70_000)),
    ]
    const targets = [EVERYTHING, pay(5_000_000), pay(25_000_000), pay(DUST)]
    for (const feeRate of [0.25, 1.37]) {
      const plans = targets.map(target => planFor(utxos, target, feeRate))
      for (let round = 0; round < 3; round++) {
        const reordered = shuffled(utxos, random)
        targets.forEach((target, index) => {
          expect(planFor(reordered, target, feeRate)).toStrictEqual(plans[index])
        })
      }
      expect(plans.map(result => result.ok)).toEqual([true, true, false, true])
    }
  })

  it('plans 12,000 outputs well within a second', () => {
    const random = seeded(12_000)
    const utxos = coins(12_000, () => between(random, 3_763, 200_000))
    const balance = total(utxos)
    const started = performance.now()
    const all = expectPlan(planFor(utxos, EVERYTHING, 1))
    const sent = expectPlan(planFor(utxos, pay(all.payment.amount - 10_000), 1))
    const beyond = expectRefusal(planFor(utxos, pay(all.payment.amount + 1), 1))
    const short = expectRefusal(planFor(utxos, pay(balance), 1))
    const elapsed = performance.now() - started
    expect(all.merges).toHaveLength(106)
    expect(sent.payment.amount).toBe(all.payment.amount - 10_000)
    expect(beyond).toMatchObject({ reason: 'exceeds_plan_size', maxSendable: all.payment.amount })
    expect(short).toMatchObject({ reason: 'insufficient_balance', maxSendable: all.payment.amount })
    // Four plans of 12,000 outputs, each well within a second.
    expect(elapsed).toBeLessThan(1_000)
  })
})

describe('planQbitSend validation', () => {
  const utxos = [coin(1, 100_000)]

  it('accepts an amount that is a safe integer of at least dust', () => {
    for (const value of [DUST, DUST + 1, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(isQbitSendPlanAmount(value)).toBe(true)
    }
    for (const value of [
      DUST - 1,
      0,
      -0,
      -DUST,
      DUST + 0.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
      undefined,
      String(DUST),
      {},
    ]) {
      expect(isQbitSendPlanAmount(value)).toBe(false)
      expectRangeError(
        () => planFor(utxos, { kind: 'amount', amount: value as number }, 1),
        `amount must be a safe integer >= ${DUST}`
      )
    }
  })

  it('refuses a malformed target', () => {
    for (const target of [null, undefined, {}, { kind: 'all' }, 'everything', { amount: 10_000 }]) {
      expectRangeError(
        () => planFor(utxos, target as unknown as QbitSendPlanTarget, 1),
        "target must be { kind: 'amount', amount } or { kind: 'everything' }"
      )
    }
  })

  it('refuses a fee rate outside the policy instead of pricing it at the floor', () => {
    // At 10,000 bits/vB an input adds 37,620,000 bits.
    for (const feeRate of [0.25, 1, 10_000]) {
      expect(planFor([coin(1, 100_000_000)], EVERYTHING, feeRate).ok).toBe(true)
    }
    for (const feeRate of [
      0.24,
      0.2499,
      0,
      -1,
      10_000.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      '1',
    ]) {
      for (const target of [EVERYTHING, pay(DUST)]) {
        expectRangeError(
          () => planFor(utxos, target, feeRate as number),
          'feeRate must be between 0.25 and 10000 bits/vB'
        )
      }
    }
  })

  it('refuses malformed output values, whether the output is confirmed or not', () => {
    for (const satoshis of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      '1000',
    ]) {
      const malformed = { ...coin(2, 0), satoshis: satoshis as number }
      for (const listed of [malformed, unconfirmed(malformed)]) {
        expectRangeError(
          () => planFor([...utxos, listed], EVERYTHING, 1),
          'utxos[1].satoshis must be a safe integer >= 0'
        )
      }
    }
    // Outputs whose total is not exact.
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1
    expectRangeError(
      () => planFor([coin(1, half), coin(2, half)], EVERYTHING, 1),
      'utxos must total a safe integer'
    )
    expectRangeError(
      () => planFor(null as unknown as Coin[], EVERYTHING, 1),
      'utxos must be an array'
    )
    expectRangeError(
      () => planFor([null as unknown as Coin], EVERYTHING, 1),
      'utxos[0].txid must be a string'
    )
    expectRangeError(
      () => planFor([{ ...coin(1, 10_000), vout: -1 }], EVERYTHING, 1),
      'utxos[0].vout must be a safe integer >= 0'
    )
  })

  it('refuses an output listed twice', () => {
    const output = coin(0xabcdef, 100_000)
    for (const again of [{ ...output }, { ...output, txid: output.txid.toUpperCase() }]) {
      expectRangeError(
        () => planFor([output, coin(2, 50_000), again], EVERYTHING, 1),
        `utxos[2] lists ${output.txid}:${output.vout} again`
      )
    }
    // Another output of the same transaction is not a repeat.
    expect(planFor([output, { ...output, vout: 2 }], EVERYTHING, 1).ok).toBe(true)
  })

  it('refuses malformed script lengths', () => {
    const cases: [Partial<Shape>, string][] = [
      [
        { paymentOutputScriptLengths: [] },
        'paymentOutputScriptLengths must list the recipient output',
      ],
      [
        { paymentOutputScriptLengths: [34, -1] },
        'paymentOutputScriptLengths[1] must be a safe integer >= 0',
      ],
      [
        { paymentOutputScriptLengths: [34.5] },
        'paymentOutputScriptLengths[0] must be a safe integer >= 0',
      ],
      [{ accountScriptLength: -1 }, 'accountScriptLength must be a safe integer >= 0'],
      [{ accountScriptLength: Number.NaN }, 'accountScriptLength must be a safe integer >= 0'],
      [{ leafScriptLength: 1.5 }, 'leafScriptLength must be a safe integer >= 0'],
      [{ controlBlockLength: 0 }, 'controlBlockLength must be a safe integer >= 1'],
    ]
    for (const [override, message] of cases) {
      expectRangeError(() => planFor(utxos, EVERYTHING, 1, { ...SHAPE, ...override }), message)
    }
    for (const paymentOutputScriptLengths of [null, undefined, 34]) {
      expectRangeError(
        () =>
          planFor(utxos, EVERYTHING, 1, {
            ...SHAPE,
            paymentOutputScriptLengths: paymentOutputScriptLengths as unknown as number[],
          }),
        'paymentOutputScriptLengths must list the recipient output'
      )
    }
  })

  it('is exported from the utilities index', () => {
    expect(utils.planQbitSend).toBe(planQbitSend)
    expect(utils.isQbitSendPlanAmount).toBe(isQbitSendPlanAmount)
  })
})

describe('planQbitSend guarantees over generated outputs', () => {
  type CoinSet = (random: () => number, inputFee: number) => Coin[]
  const COIN_SETS: [string, CoinSet][] = [
    [
      'equal values',
      (random, inputFee) =>
        coins(between(random, 1, 330), between(random, Math.floor(inputFee) + 1, 90_000)),
    ],
    [
      'a few large and many small',
      (random, inputFee) => [
        ...coins(between(random, 1, 4), () => between(random, 2_000_000, 40_000_000)),
        ...coins(
          between(random, 100, 330),
          () => between(random, Math.floor(inputFee) + 1, 30_000),
          4
        ),
      ],
    ],
    [
      'values just above and below the input fee',
      (random, inputFee) =>
        coins(between(random, 100, 330), () => Math.floor(inputFee) + between(random, -2, 40)),
    ],
    [
      'values near dust',
      random => coins(between(random, 100, 330), () => DUST + between(random, -400, 400)),
    ],
    [
      'mixed values with unconfirmed outputs',
      (random, inputFee) =>
        coins(between(random, 1, 330), () =>
          between(random, Math.max(0, Math.floor(inputFee) - 500), 400_000)
        ).map(output => (random() < 0.2 ? unconfirmed(output) : output)),
    ],
  ]
  const SHAPES: [string, Shape][] = [
    ['one recipient output', SHAPE],
    ['an 80-byte memo', withMemo(80)],
    ['a memo that leaves no room for change beside 106 inputs', withMemo(1_120)],
    ['a memo that leaves the payment 40 inputs', withMemo(249_000)],
  ]

  function amountsFor(random: () => number, maxSendable: number): number[] {
    const amounts = new Set([DUST, DUST + between(random, 0, 100_000)])
    if (maxSendable >= DUST) {
      for (const below of [0, 1, 500, DUST - 1, DUST + 43, DUST + 400, 10_000]) {
        amounts.add(maxSendable - below)
      }
      amounts.add(between(random, DUST, maxSendable))
      amounts.add(between(random, DUST, maxSendable))
    }
    amounts.add(maxSendable + 1)
    amounts.add(maxSendable + between(random, 2, 1_000_000))
    return [...amounts].filter(amount => amount >= DUST)
  }

  SHAPES.forEach(([shapeName, shape], shapeIndex) => {
    it(`holds for ${shapeName}`, () => {
      const limits = limitsOf(shape)
      let plans = 0
      let merged = 0
      let refusals = 0
      COIN_SETS.forEach(([, coinSet], setIndex) => {
        for (let seed = 0; seed < 2; seed++) {
          const random = seeded(1_000 * shapeIndex + 100 * setIndex + seed)
          const fractional = Math.round(between(random, 25, 3_000)) / 100
          for (const feeRate of [0.25, 1, 1.37, fractional]) {
            const utxos = coinSet(random, inputFeeOf(shape, feeRate))
            const planCase = { utxos, feeRate, shape }
            const exhaustive = candidatesOf(shape, feeRate, utxos).length <= 120
            const everything = referenceEverything(shape, feeRate, utxos)
            const all = planFor(utxos, EVERYTHING, feeRate, shape)
            expect(planFor(shuffled(utxos, random), EVERYTHING, feeRate, shape)).toStrictEqual(all)
            if (everything) {
              const sent = expectSoundPlan(all, planCase, EVERYTHING)
              expect(sent.payment.amount).toBe(everything.amount)
              expect(spentBy(sent)).toHaveLength(everything.spent)
              expectNothingWorthAdding(sent, planCase)
              merged += sent.merges.length > 0 ? 1 : 0
            } else {
              expect(all).toEqual({
                ok: false,
                reason: 'nothing_to_send',
                maxSendable: 0,
                unconfirmedSatoshis: total(utxos.filter(utxo => utxo.unconfirmed)),
              })
            }
            const maxSendable = everything?.amount ?? 0
            for (const amount of amountsFor(random, maxSendable)) {
              const result = expectAmountGuarantees(planCase, amount, maxSendable, exhaustive)
              if (result.ok) {
                plans += 1
                merged += result.merges.length > 0 ? 1 : 0
              } else {
                refusals += 1
                // With room for change wherever there is room for the payment,
                // every amount up to the largest sendable can be paid.
                if (limits.withChange === limits.withoutChange) {
                  expect(amount).toBeGreaterThan(maxSendable)
                }
              }
            }
          }
        }
      })
      // The cases reach plans with merges, plans without, and refusals.
      expect(plans).toBeGreaterThan(100)
      expect(merged).toBeGreaterThan(20)
      expect(refusals).toBeGreaterThan(20)
    })
  })
})
