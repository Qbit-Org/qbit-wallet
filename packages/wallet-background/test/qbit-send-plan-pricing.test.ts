import { describe, expect, it } from 'vitest'

import {
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  type Psbt,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import {
  QBIT_P2MR_DUST,
  estimateQbitP2mrTransaction,
  planQbitSend,
  type QbitSendPlan,
  type QbitSendPlanTarget,
  type QbitSelectableCoin,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import {
  validateQbitSendPlanRecord,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
import {
  QBIT_SEND_PLAN_RBF_SEQUENCE,
  QbitSendPlanTransactionMismatchError,
  buildQbitSendPlanSteps,
  checkQbitSendPlanStepPsbt,
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
  type QbitSendPlanBuiltStep,
  type QbitSendPlanStepExpectation,
} from '../src/utils/qbit-send-plan-psbt'
import {
  priceQbitSendPlanMerge,
  priceQbitSendPlanPayment,
  qbitSendPlanFeeProblem,
  type QbitSendPlanPricedTransaction,
} from '../src/utils/qbit-send-plan-revision'

// The rule every transaction of a send plan is held to before it is signed,
// and every stored record when it is read or written (#188): its size and
// fee are the wallet's own pricing of it at the rate it was priced at, so a
// record changed on disk cannot get a transaction signed that pays more fee
// than the planner would have made it pay.

const PUBKEY = '5e'.repeat(32)
const KEYS = qbitSendPlanAccountKeys(PUBKEY)
const RECIPIENT_SCRIPT = qbitSendPlanAccountKeys('44'.repeat(32)).scriptPubKey
const SHAPE = {
  accountScriptLength: KEYS.scriptPubKey.length,
  leafScriptLength: KEYS.leafScript.length,
  controlBlockLength: KEYS.controlBlock.length,
}
const RATES = [0.25, 0.3, 0.5, 1, 1.37, 2.5, 7.77, 10, 123.45, 10_000]

/** The id of `psbt`'s transaction, as the wallet names it. */
function txidOf(psbt: Psbt): string {
  const unsigned = psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === 0)!.value
  return Buffer.from(transactionCore.crypto.hash256(Buffer.from(unsigned)))
    .reverse()
    .toString('hex')
}

/** An OP_RETURN script carrying `bytes` bytes of data, as a memo output's. */
function memoScript(bytes: number): Uint8Array {
  const data = new Array<number>(bytes).fill(0x61)
  return Uint8Array.from([0x6a, ...(bytes <= 75 ? [bytes] : [0x4c, bytes]), ...data])
}

/** A deterministic source of numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** `count` confirmed outputs, each worth between 1.5 and 31.5 times its own input's fee at `feeRate`. */
function coinsFor(count: number, feeRate: number, seed: number): QbitSelectableCoin[] {
  const next = random(seed)
  return Array.from({ length: count }, (_, index) => ({
    txid: (index + 1).toString(16).padStart(8, '0').repeat(8),
    vout: index % 3,
    satoshis: Math.ceil(feeRate * 3762 * (1.5 + 30 * next())),
  }))
}

/** What the engine checks a step's PSBT against, from the plan it built. */
function expectationOf(
  plan: QbitSendPlan<QbitSelectableCoin>,
  step: QbitSendPlanBuiltStep
): QbitSendPlanStepExpectation {
  return step.kind === 'merge'
    ? {
        kind: 'merge',
        txid: step.txid,
        inputs: step.inputs,
        fee: step.fee,
        feeRate: step.feeRate,
        outputValue: step.outputValue!,
      }
    : {
        kind: 'payment',
        txid: step.txid,
        inputs: step.inputs,
        fee: step.fee,
        feeRate: step.feeRate,
        recipientScript: RECIPIENT_SCRIPT,
        amount: plan.payment.amount,
        change: plan.payment.change,
        target: plan.target,
      }
}

/** The record the engine stores for `plan`, built as `built`, at `feeRate`. */
function recordOf(
  plan: QbitSendPlan<QbitSelectableCoin>,
  built: readonly QbitSendPlanBuiltStep[],
  feeRate: number
): QbitSendPlanRecord {
  return {
    id: 'a1'.repeat(16),
    chain: ChainType.QBIT_REGTEST,
    account: { address: p2mrAddressFromPubkey(hexToBytes(PUBKEY), 'regtest'), pubkey: PUBKEY },
    recipient: p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'regtest'),
    target: plan.target,
    amount: plan.payment.amount,
    change: plan.payment.change,
    feeRate,
    totalFee: plan.totalFee,
    steps: built.map(step => ({
      kind: step.kind,
      txid: step.txid,
      unsignedPsbtHex: step.psbtHex,
      inputs: step.inputs,
      vsize: step.vsize,
      fee: step.fee,
      feeRate: step.feeRate,
      ...(step.outputValue !== undefined ? { outputValue: step.outputValue } : {}),
      status: 'planned' as const,
    })),
    phase: 'signing',
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
  }
}

function build(
  plan: QbitSendPlan<QbitSelectableCoin>,
  feeRate: number,
  memos: readonly Uint8Array[] = []
): QbitSendPlanBuiltStep[] {
  return buildQbitSendPlanSteps({
    plan,
    keys: KEYS,
    recipientScript: RECIPIENT_SCRIPT,
    memoOutputs: memos.map(scriptPubKey => ({ value: 0n, scriptPubKey })),
    paymentSequence: QBIT_SEND_PLAN_RBF_SEQUENCE,
    feeRate,
    txidOf,
  })
}

/** The planner's plan of `count` outputs at `feeRate` for `target`, or its refusal. */
function planOf(
  count: number,
  feeRate: number,
  target: QbitSendPlanTarget,
  memos: readonly Uint8Array[] = [],
  seed = 1
) {
  return planQbitSend({
    utxos: coinsFor(count, feeRate, seed),
    target,
    paymentOutputScriptLengths: [RECIPIENT_SCRIPT.length, ...memos.map(memo => memo.length)],
    ...SHAPE,
    feeRate,
  })
}

/**
 * A plan with merges whose payment returns change: an amount of 150 outputs
 * at `feeRate` that needs nearly all of them, the first of a few such
 * amounts that leaves change of at least dust.
 */
function planWithMerges(feeRate: number): QbitSendPlan<QbitSelectableCoin> {
  const everything = planOf(150, feeRate, { kind: 'everything' })
  if (!everything.ok) throw new Error(`the planner refused: ${everything.reason}`)
  for (let outputs = 1; outputs <= 20; outputs++) {
    const amount = everything.payment.amount - outputs * Math.ceil(3762 * feeRate)
    const plan = planOf(150, feeRate, { kind: 'amount', amount })
    if (plan.ok && plan.merges.length > 0 && plan.payment.includeChange) return plan
  }
  throw new Error('no plan with merges and change')
}

/** `psbtHex` built again over the same inputs and sequence, its outputs paying `values`. */
function repaid(psbtHex: string, values: readonly bigint[]): string {
  const summary = decodePsbt(qbitSendPlanPsbtFromHex(psbtHex))
  return qbitSendPlanPsbtHex(
    createP2mrPsbt({
      inputs: summary.inputs.map(input => ({
        prevout: input.prevout,
        sequence: input.sequence,
        witnessUtxo: input.witnessUtxo!,
        leafScript: KEYS.leafScript,
        controlBlock: KEYS.controlBlock,
        merkleRoot: KEYS.leafHash,
      })),
      outputs: summary.outputs.map((output, index) => ({
        value: values[index] ?? output.value,
        scriptPubKey: output.scriptPubKey,
      })),
    })
  )
}

describe('every transaction the wallet prices', () => {
  it('passes the check before signing and the store, at every rate, for amounts and everything, with and without memos', () => {
    const seen = { plans: 0, withChange: 0, folded: 0, everything: 0, merges: 0 }
    for (const feeRate of RATES) {
      for (const memos of [[], [memoScript(10)], [memoScript(80)]]) {
        for (const seed of [1, 2]) {
          const count = 110 + ((seed * 97) % 220)
          const everything = planOf(count, feeRate, { kind: 'everything' }, memos, seed)
          if (!everything.ok) throw new Error(`the planner refused: ${everything.reason}`)
          const largest = everything.payment.amount
          // Everything; amounts that need nearly every output, so merges,
          // returning change; and amounts whose remainder is folded.
          const output = Math.ceil(3762 * feeRate)
          const targets: QbitSendPlanTarget[] = [
            { kind: 'everything' },
            { kind: 'amount', amount: largest - 20 * output },
            { kind: 'amount', amount: largest - 3 * output },
            { kind: 'amount', amount: largest - 1 },
            { kind: 'amount', amount: largest - QBIT_P2MR_DUST },
          ]
          for (const target of targets) {
            const plan = planOf(count, feeRate, target, memos, seed)
            // At the highest rate no remainder can be folded within the
            // maximum total fee, and the planner refuses such an amount.
            if (!plan.ok || plan.merges.length === 0) continue
            const built = build(plan, feeRate, memos)
            for (const step of built) {
              expect(step.feeRate).toBe(feeRate)
              expect(() =>
                checkQbitSendPlanStepPsbt(
                  qbitSendPlanPsbtFromHex(step.psbtHex),
                  expectationOf(plan, step),
                  KEYS,
                  txidOf
                )
              ).not.toThrow()
            }
            const record = recordOf(plan, built, feeRate)
            expect(validateQbitSendPlanRecord(record)).toEqual({ valid: true, record })
            seen.plans += 1
            seen.merges += plan.merges.length
            if (plan.target === 'everything') seen.everything += 1
            else if (plan.payment.includeChange) seen.withChange += 1
            else if (plan.payment.changeDroppedSats > 0) seen.folded += 1
          }
        }
      }
    }
    // Every kind of payment the planner makes was checked.
    expect(seen.everything).toBeGreaterThanOrEqual(RATES.length * 6)
    expect(seen.withChange).toBeGreaterThan(RATES.length)
    expect(seen.folded).toBeGreaterThan(RATES.length)
    expect(seen.merges).toBeGreaterThan(seen.plans)
  })

  it('passes a revision’s merges and payments, priced again over fixed inputs', () => {
    let folded = 0
    const shape = { paymentOutputScriptLengths: [RECIPIENT_SCRIPT.length], ...SHAPE }
    for (const feeRate of RATES) {
      const next = random(Math.round(feeRate * 100))
      for (let round = 0; round < 40; round++) {
        const inputs = Array.from({ length: 1 + Math.floor(next() * 106) }, () => ({
          satoshis: Math.ceil(feeRate * 3762 * (1.5 + 30 * next())),
        }))
        const merge = priceQbitSendPlanMerge(shape, inputs, feeRate)
        expect(
          qbitSendPlanFeeProblem(
            {
              kind: 'merge',
              inputCount: inputs.length,
              outputScriptLengths: [SHAPE.accountScriptLength],
              feeRate,
              fee: merge.fee,
              vsize: merge.vsize,
              outputValue: merge.outputValue,
            },
            SHAPE
          )
        ).toBeUndefined()

        const inputTotal = inputs.reduce((sum, input) => sum + input.satoshis, 0)
        const everything = priceQbitSendPlanPayment(
          shape,
          inputTotal,
          inputs.length,
          { kind: 'everything' },
          feeRate
        )
        if (!everything.ok) continue
        // Amounts from half of everything to everything less a few bits:
        // with change, and with a remainder folded into the fee.
        const amounts = [
          Math.floor(everything.amount / 2),
          everything.amount - Math.floor(next() * 3 * QBIT_P2MR_DUST),
          everything.amount,
        ]
        for (const target of [
          { kind: 'everything' as const },
          ...amounts.map(amount => ({ kind: 'amount' as const, amount })),
        ]) {
          const priced = priceQbitSendPlanPayment(shape, inputTotal, inputs.length, target, feeRate)
          if (!priced.ok) continue
          if (priced.changeDroppedSats > 0) folded += 1
          const transaction: QbitSendPlanPricedTransaction = {
            kind: 'payment',
            inputCount: inputs.length,
            outputScriptLengths: [
              RECIPIENT_SCRIPT.length,
              ...(priced.includeChange ? [SHAPE.accountScriptLength] : []),
            ],
            feeRate,
            fee: priced.fee,
            vsize: priced.vsize,
            foldsRemainder: target.kind === 'amount' && !priced.includeChange,
          }
          expect(qbitSendPlanFeeProblem(transaction, SHAPE), JSON.stringify(target)).toBeUndefined()
        }
      }
    }
    expect(folded).toBeGreaterThan(RATES.length)
  })
})

describe('the pricing rule, at its bounds', () => {
  const merge = (overrides: Partial<QbitSendPlanPricedTransaction> = {}) => {
    const { vsize, fee } = estimateQbitP2mrTransaction({
      inputCount: 3,
      outputScriptLengths: [SHAPE.accountScriptLength],
      leafScriptLength: SHAPE.leafScriptLength,
      controlBlockLength: SHAPE.controlBlockLength,
      feeRate: 1.37,
    })
    return qbitSendPlanFeeProblem(
      {
        kind: 'merge',
        inputCount: 3,
        outputScriptLengths: [SHAPE.accountScriptLength],
        feeRate: 1.37,
        fee,
        vsize,
        outputValue: QBIT_P2MR_DUST,
        ...overrides,
      },
      SHAPE
    )
  }
  const scripts = [RECIPIENT_SCRIPT.length, memoScript(20).length]
  const estimate = (outputScriptLengths: number[], feeRate: number) =>
    estimateQbitP2mrTransaction({
      inputCount: 7,
      outputScriptLengths,
      leafScriptLength: SHAPE.leafScriptLength,
      controlBlockLength: SHAPE.controlBlockLength,
      feeRate,
    })
  const payment = (
    fee: number,
    foldsRemainder: boolean,
    feeRate = 1.37,
    outputScriptLengths = scripts
  ) =>
    qbitSendPlanFeeProblem(
      { kind: 'payment', inputCount: 7, outputScriptLengths, feeRate, fee, foldsRemainder },
      SHAPE
    )

  it('holds a merge to exactly its price, and its output to at least dust', () => {
    const exact = estimateQbitP2mrTransaction({
      inputCount: 3,
      outputScriptLengths: [SHAPE.accountScriptLength],
      leafScriptLength: SHAPE.leafScriptLength,
      controlBlockLength: SHAPE.controlBlockLength,
      feeRate: 1.37,
    })
    expect(merge()).toBeUndefined()
    expect(merge({ fee: exact.fee + 1 })).toBe('fee')
    expect(merge({ fee: exact.fee - 1 })).toBe('fee')
    expect(merge({ vsize: exact.vsize + 1 })).toBe('vsize')
    expect(merge({ outputValue: QBIT_P2MR_DUST - 1 })).toBe('outputValue')
    // Priced at the plan's raised rate, a merge built at the earlier one is refused.
    expect(merge({ feeRate: 1.38 })).toBe('fee')
  })

  it('holds a payment with change, and everything, to exactly its price', () => {
    const withChange = estimate([...scripts, SHAPE.accountScriptLength], 1.37)
    const change = [...scripts, SHAPE.accountScriptLength]
    expect(payment(withChange.fee, false, 1.37, change)).toBeUndefined()
    expect(payment(withChange.fee + 1, false, 1.37, change)).toBe('fee')
    expect(payment(withChange.fee - 1, false, 1.37, change)).toBe('fee')
    const without = estimate(scripts, 1.37)
    expect(payment(without.fee, false)).toBeUndefined()
    expect(payment(without.fee + 1, false)).toBe('fee')
  })

  it('folds into an amount’s fee without change at most what a change output could not return', () => {
    const without = estimate(scripts, 1.37)
    const withChange = estimate([...scripts, SHAPE.accountScriptLength], 1.37)
    const highest = withChange.fee + QBIT_P2MR_DUST - 1
    expect(payment(without.fee, true)).toBeUndefined()
    expect(payment(highest, true)).toBeUndefined()
    expect(payment(highest + 1, true)).toBe('fee')
    expect(payment(without.fee - 1, true)).toBe('fee')
    // At the policy's highest rate the maximum total fee leaves no room to fold.
    const top = estimate(scripts, 10_000)
    expect(payment(top.fee, true, 10_000)).toBeUndefined()
    expect(payment(top.fee + 1, true, 10_000)).toBe('fee')
  })

  it('refuses a rate outside policy, a size that cannot be priced and a fee that is no whole number', () => {
    for (const feeRate of [
      0.24,
      10_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      '1',
      undefined,
    ]) {
      expect(merge({ feeRate }), String(feeRate)).toBe('feeRate')
    }
    expect(merge({ inputCount: 0 })).toBe('vsize')
    expect(payment(estimate(scripts, 1.37).fee + 0.5, true)).toBe('fee')
  })
})

describe('the check before signing', () => {
  it('refuses a merge whose PSBT pays more fee, its output lowered to match, the record agreeing', () => {
    const plan = planWithMerges(1)
    const [merge] = build(plan, 1)
    expect(merge!.kind).toBe('merge')
    const burned = merge!.outputValue! - QBIT_P2MR_DUST
    const psbtHex = repaid(merge!.psbtHex, [BigInt(QBIT_P2MR_DUST)])
    const psbt = qbitSendPlanPsbtFromHex(psbtHex)
    const expectation: QbitSendPlanStepExpectation = {
      ...expectationOf(plan, merge!),
      txid: txidOf(psbt),
      fee: merge!.fee + burned,
      outputValue: QBIT_P2MR_DUST,
    }
    expect(() => checkQbitSendPlanStepPsbt(psbt, expectation, KEYS, txidOf)).toThrow(
      QbitSendPlanTransactionMismatchError
    )
    expect(() => checkQbitSendPlanStepPsbt(psbt, expectation, KEYS, txidOf)).toThrow(
      'merge fee at its rate'
    )
  })

  it('refuses a payment whose PSBT pays more fee, its change lowered to match, the record agreeing', () => {
    const plan = planWithMerges(1.37)
    const built = build(plan, 1.37)
    const payment = built[built.length - 1]!
    for (const burned of [1, plan.payment.change - QBIT_P2MR_DUST]) {
      const psbtHex = repaid(payment.psbtHex, [
        BigInt(plan.payment.amount),
        BigInt(plan.payment.change - burned),
      ])
      const psbt = qbitSendPlanPsbtFromHex(psbtHex)
      const expectation: QbitSendPlanStepExpectation = {
        ...expectationOf(plan, payment),
        txid: txidOf(psbt),
        fee: payment.fee + burned,
        change: plan.payment.change - burned,
      }
      expect(() => checkQbitSendPlanStepPsbt(psbt, expectation, KEYS, txidOf)).toThrow(
        'payment fee at its rate'
      )
    }
  })

  it('checks each step at the rate it records: a merge kept from an earlier rate passes at that rate alone', () => {
    const plan = planWithMerges(1)
    const [merge] = build(plan, 1)
    const psbt = qbitSendPlanPsbtFromHex(merge!.psbtHex)
    expect(() =>
      checkQbitSendPlanStepPsbt(psbt, expectationOf(plan, merge!), KEYS, txidOf)
    ).not.toThrow()
    for (const feeRate of [2, 0.5, 0.24, 10_001]) {
      expect(() =>
        checkQbitSendPlanStepPsbt(psbt, { ...expectationOf(plan, merge!), feeRate }, KEYS, txidOf)
      ).toThrow(QbitSendPlanTransactionMismatchError)
    }
  })

  it('is what building a plan checks too: a plan priced above the wallet’s pricing is never built', () => {
    const plan = planWithMerges(1)
    const raised: QbitSendPlan<QbitSelectableCoin> = {
      ...plan,
      merges: plan.merges.map((merge, index) =>
        index === 0
          ? { ...merge, fee: merge.fee + 1_000, outputValue: merge.outputValue - 1_000 }
          : merge
      ),
      payment: { ...plan.payment, change: plan.payment.change - 1_000 },
      totalFee: plan.totalFee + 1_000,
    }
    expect(() => build(raised, 1)).toThrow('merge 0 pricing')
    expect(() => build(plan, 1)).not.toThrow()
  })
})
