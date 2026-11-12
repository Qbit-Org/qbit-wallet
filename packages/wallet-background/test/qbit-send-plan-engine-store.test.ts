import { beforeEach, describe, expect, it } from 'vitest'

import { createP2mrPsbt, hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import { estimateQbitP2mrTransaction } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_PROVIDER_SIGNING,
  QBIT_PROVIDER_SIGNING_LIMIT,
  QBIT_SEND_PLAN_HELD_CODE,
  QbitSendGuardService,
  QbitSendPlanHeldError,
  QbitSendPlanHoldConflictError,
  type QbitOutpoint,
} from '../src/services/qbitSendGuards'
import {
  QBIT_SEND_PLAN_MAX_CARRIED,
  QbitSendPlanStore,
  validateQbitSendPlanRecord,
  type QbitSendPlanCarriedStep,
  type QbitSendPlanRecord,
  type QbitSendPlanStepRecord,
  type QbitSendPlanStoreStorage,
} from '../src/services/qbitSendPlanStore'
import {
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
} from '../src/utils/qbit-send-plan-psbt'

// What the send plan engine added to the plan store and the send guard: a
// replan's carried merges and paid fees, a completed plan's payment without
// its signed bytes, and a dapp's signing recorded in the same step as its
// overlap check.

const chain = ChainType.QBIT_REGTEST
const PUBKEY = '5e'.repeat(32)
const address = p2mrAddressFromPubkey(hexToBytes(PUBKEY), 'regtest')
const recipient = p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'regtest')
const PLAN_ID = 'a1'.repeat(16)
const CARRIED_TXID = 'ee'.repeat(32)
const NOW = 1_762_000_000_000

const txid = (byte: string): string => byte.repeat(32)

type StepInput = QbitSendPlanStepRecord['inputs'][number]

const KEYS = qbitSendPlanAccountKeys(PUBKEY)
const RECIPIENT_SCRIPT = qbitSendPlanAccountKeys('44'.repeat(32)).scriptPubKey
const FEE_RATE = 1

/** The exact size and fee at `FEE_RATE` of a step spending `inputCount` outputs of the account to `scripts`. */
function priced(inputCount: number, scripts: readonly Uint8Array[]) {
  return estimateQbitP2mrTransaction({
    inputCount,
    outputScriptLengths: scripts.map(script => script.length),
    leafScriptLength: KEYS.leafScript.length,
    controlBlockLength: KEYS.controlBlock.length,
    feeRate: FEE_RATE,
  })
}

/** An unsigned PSBT spending `inputs`, each an output of the account, to `outputs`. */
function stepPsbtHex(
  inputs: readonly StepInput[],
  outputs: readonly { value: number; script: Uint8Array }[]
): string {
  return qbitSendPlanPsbtHex(
    createP2mrPsbt({
      inputs: inputs.map(input => ({
        prevout: { txid: hexToBytes(input.txid).reverse(), vout: input.vout },
        sequence: 0xfffffffd,
        witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: KEYS.scriptPubKey },
        leafScript: KEYS.leafScript,
        controlBlock: KEYS.controlBlock,
        merkleRoot: KEYS.leafHash,
      })),
      outputs: outputs.map(output => ({
        value: BigInt(output.value),
        scriptPubKey: output.script,
      })),
    })
  )
}

/** The id of the transaction a PSBT in hex holds, as the wallet names it. */
function txidOfHex(hex: string): string {
  const psbt = qbitSendPlanPsbtFromHex(hex)
  const unsigned = psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === 0)!.value
  return Buffer.from(transactionCore.crypto.hash256(Buffer.from(unsigned)))
    .reverse()
    .toString('hex')
}

const MERGE_INPUTS: readonly StepInput[] = [
  { txid: txid('01'), vout: 0, satoshis: 100_000_000 },
  { txid: txid('02'), vout: 1, satoshis: 200_000_000 },
  { txid: txid('03'), vout: 0, satoshis: 300_000_000 },
]
const MERGE_PRICE = priced(MERGE_INPUTS.length, [KEYS.scriptPubKey])
const MERGE_OUTPUT = MERGE_INPUTS.reduce((sum, input) => sum + input.satoshis, 0) - MERGE_PRICE.fee
const MERGE_PSBT_HEX = stepPsbtHex(MERGE_INPUTS, [
  { value: MERGE_OUTPUT, script: KEYS.scriptPubKey },
])
const MERGE_TXID = txidOfHex(MERGE_PSBT_HEX)
const DIRECT_INPUT: StepInput = { txid: txid('04'), vout: 0, satoshis: 1_000_000_000 }
const AMOUNT = 900_000_000
const PAYMENT_PRICE = priced(2, [RECIPIENT_SCRIPT, KEYS.scriptPubKey])
const CHANGE = MERGE_OUTPUT + DIRECT_INPUT.satoshis - AMOUNT - PAYMENT_PRICE.fee
const PAYMENT_PSBT_HEX = stepPsbtHex(
  [{ txid: MERGE_TXID, vout: 0, satoshis: MERGE_OUTPUT }, { ...DIRECT_INPUT }],
  [
    { value: AMOUNT, script: RECIPIENT_SCRIPT },
    { value: CHANGE, script: KEYS.scriptPubKey },
  ]
)
const PAYMENT_TXID = txidOfHex(PAYMENT_PSBT_HEX)

/** A merge of three outputs of the account to one, priced exactly at `FEE_RATE`. */
function mergeStep(overrides: Partial<QbitSendPlanStepRecord> = {}): QbitSendPlanStepRecord {
  return {
    kind: 'merge',
    txid: MERGE_TXID,
    unsignedPsbtHex: MERGE_PSBT_HEX,
    inputs: MERGE_INPUTS.map(input => ({ ...input })),
    vsize: MERGE_PRICE.vsize,
    fee: MERGE_PRICE.fee,
    feeRate: FEE_RATE,
    outputValue: MERGE_OUTPUT,
    status: 'planned',
    ...overrides,
  }
}

/** The payment: the merge's output and one more output pay `AMOUNT` and return `CHANGE`. */
function paymentStep(overrides: Partial<QbitSendPlanStepRecord> = {}): QbitSendPlanStepRecord {
  const inputs = [{ txid: MERGE_TXID, vout: 0, satoshis: MERGE_OUTPUT }, { ...DIRECT_INPUT }]
  return {
    kind: 'payment',
    txid: PAYMENT_TXID,
    unsignedPsbtHex: PAYMENT_PSBT_HEX,
    inputs,
    vsize: PAYMENT_PRICE.vsize,
    fee: PAYMENT_PRICE.fee,
    feeRate: FEE_RATE,
    status: 'planned',
    ...overrides,
  }
}

function carriedStep(overrides: Partial<QbitSendPlanCarriedStep> = {}): QbitSendPlanCarriedStep {
  return {
    txid: CARRIED_TXID,
    inputs: [{ txid: txid('05'), vout: 0, satoshis: 7000 }],
    fee: 150,
    status: 'unknown',
    ...overrides,
  }
}

function planRecord(overrides: Partial<QbitSendPlanRecord> = {}): QbitSendPlanRecord {
  return {
    id: PLAN_ID,
    chain,
    account: { address, pubkey: PUBKEY },
    recipient,
    target: 'amount',
    amount: AMOUNT,
    change: CHANGE,
    feeRate: FEE_RATE,
    totalFee: MERGE_PRICE.fee + PAYMENT_PRICE.fee,
    steps: [mergeStep(), paymentStep()],
    phase: 'signing',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    ...overrides,
  }
}

class MemoryStorage implements QbitSendPlanStoreStorage {
  readonly values = new Map<string, string>()

  async get(key: string): Promise<unknown> {
    const raw = this.values.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value))
  }
}

describe('the plan store: carried merges, paid fees and completed payments', () => {
  it('accepts a replan’s carried merges and paid fees, and keeps them through storage', async () => {
    const record = planRecord({ carried: [carriedStep()], paidFee: 150 })
    expect(validateQbitSendPlanRecord(record)).toEqual({ valid: true, record })

    const storage = new MemoryStorage()
    const store = new QbitSendPlanStore()
    await store.init({ storage, now: () => NOW })
    const written = await store.put(record, null)
    expect(written).toMatchObject({ carried: [carriedStep()], paidFee: 150 })

    const reopened = new QbitSendPlanStore()
    await reopened.init({ storage, now: () => NOW })
    expect(reopened.get(PLAN_ID)).toEqual(written)
    // A carried merge's inputs are held again after a restart.
    expect(reopened.planHolds()[0]!.outpoints).toContainEqual({ txid: txid('05'), vout: 0 })
  })

  it('refuses malformed carried merges and paid fees', () => {
    const refused: [string, QbitSendPlanRecord, string][] = [
      ['carried that is not a list', planRecord({ carried: {} as never }), 'carried'],
      [
        'too many carried merges',
        planRecord({
          carried: Array.from({ length: QBIT_SEND_PLAN_MAX_CARRIED + 1 }, (_, index) =>
            carriedStep({
              txid: (index + 1).toString(16).padStart(64, '0'),
              inputs: [{ txid: (index + 1).toString(16).padStart(64, '7'), vout: 0, satoshis: 1 }],
            })
          ),
        }),
        'carried: too many',
      ],
      [
        'a carried merge with an unknown key',
        planRecord({ carried: [{ ...carriedStep(), x: 1 } as never] }),
        'carried[0]: unknown key',
      ],
      [
        'a carried merge with no inputs',
        planRecord({ carried: [carriedStep({ inputs: [] })] }),
        'carried[0].inputs',
      ],
      [
        'a carried merge of another status',
        planRecord({ carried: [carriedStep({ status: 'planned' as never })] }),
        'carried[0].status',
      ],
      [
        'a carried merge with a NaN fee',
        planRecord({ carried: [carriedStep({ fee: null as never })] }),
        'carried[0].fee',
      ],
      [
        'a carried merge that is a step',
        planRecord({ carried: [carriedStep({ txid: MERGE_TXID })] }),
        'carried[0].txid: listed twice',
      ],
      [
        'a carried merge spending what a step spends',
        planRecord({
          carried: [carriedStep({ inputs: [{ txid: txid('01'), vout: 0, satoshis: 1000 }] })],
        }),
        'carried[0].inputs[0]: spent twice',
      ],
      [
        'a carried merge spending a step',
        planRecord({
          carried: [carriedStep({ inputs: [{ txid: PAYMENT_TXID, vout: 0, satoshis: 1 }] })],
        }),
        'carried[0].inputs[0]: spends a step of the plan',
      ],
      [
        'a step spending a carried merge',
        planRecord({
          carried: [carriedStep()],
          steps: [
            mergeStep(),
            paymentStep({
              inputs: [
                { txid: MERGE_TXID, vout: 0, satoshis: MERGE_OUTPUT },
                { txid: CARRIED_TXID, vout: 0, satoshis: DIRECT_INPUT.satoshis },
              ],
            }),
          ],
        }),
        'steps: a step spends a carried merge',
      ],
      ['a negative paid fee', planRecord({ paidFee: -1 }), 'paidFee'],
      ['a paid fee that crossed as NaN', planRecord({ paidFee: null as never }), 'paidFee'],
      ['a fractional paid fee', planRecord({ paidFee: 1.5 }), 'paidFee'],
    ]
    for (const [label, record, reason] of refused) {
      expect(validateQbitSendPlanRecord(record), label).toMatchObject({ valid: false, reason })
    }
  })

  it('lets a completed plan drop its payment’s signed bytes, and no other', () => {
    const sent = paymentStep({ status: 'broadcast' })
    expect(
      validateQbitSendPlanRecord(
        planRecord({ phase: 'completed', steps: [mergeStep({ status: 'confirmed' }), sent] })
      )
    ).toMatchObject({ valid: true })
    expect(
      validateQbitSendPlanRecord(
        planRecord({
          phase: 'completed',
          steps: [mergeStep({ status: 'confirmed' }), { ...sent, status: 'confirmed' }],
        })
      )
    ).toMatchObject({ valid: true })
    // Kept, it must still be a PSBT.
    expect(
      validateQbitSendPlanRecord(
        planRecord({ phase: 'completed', steps: [mergeStep(), { ...sent, signedPsbtHex: 'cd' }] })
      )
    ).toMatchObject({ valid: false, reason: 'steps[1].signedPsbtHex' })
    for (const phase of ['signing', 'waiting', 'sending', 'paused', 'cancelling'] as const) {
      expect(
        validateQbitSendPlanRecord(planRecord({ phase, steps: [mergeStep(), sent] }))
      ).toMatchObject({
        valid: false,
        reason: 'steps[1].signedPsbtHex',
      })
    }
    // A signed or unknown payment keeps its bytes whatever the phase.
    expect(
      validateQbitSendPlanRecord(
        planRecord({ phase: 'completed', steps: [mergeStep(), paymentStep({ status: 'unknown' })] })
      )
    ).toMatchObject({ valid: false, reason: 'steps[1].signedPsbtHex' })
  })
})

describe('the plan store: a payment refused without a reason', () => {
  it('keeps a pause that the network did not explain, and refuses any other mark', async () => {
    const paused = planRecord({
      phase: 'paused',
      pause: {
        reason: 'payment_refused',
        at: NOW,
        detail: 'HTTP 400: RPC error -26',
        unexplained: true,
      },
    })
    expect(validateQbitSendPlanRecord(paused)).toEqual({ valid: true, record: paused })
    const storage = new MemoryStorage()
    const store = new QbitSendPlanStore()
    await store.init({ storage, now: () => NOW })
    expect((await store.put(paused, null)).pause).toMatchObject({ unexplained: true })
    for (const mark of [false, 'yes', 1, null]) {
      expect(
        validateQbitSendPlanRecord(
          planRecord({
            phase: 'paused',
            pause: { reason: 'payment_refused', at: NOW, unexplained: mark as never },
          })
        ),
        String(mark)
      ).toMatchObject({ valid: false, reason: 'pause.unexplained' })
    }
  })
})

describe('the plan store: a merge that replaces an earlier version of itself', () => {
  const REPLACED_TXID = 'ab'.repeat(32)
  const replacing = (overrides: Partial<QbitSendPlanStepRecord> = {}): QbitSendPlanStepRecord =>
    mergeStep({ replaces: { txid: REPLACED_TXID, fee: 50 }, status: 'broadcast', ...overrides })

  it('keeps the version a merge replaces through storage, and holds its output again after a restart', async () => {
    const record = planRecord({ steps: [replacing(), paymentStep()], phase: 'waiting' })
    expect(validateQbitSendPlanRecord(record)).toEqual({ valid: true, record })
    const storage = new MemoryStorage()
    const store = new QbitSendPlanStore()
    await store.init({ storage, now: () => NOW })
    const written = await store.put(record, null)
    expect(written.steps[0]!.replaces).toEqual({ txid: REPLACED_TXID, fee: 50 })

    const reopened = new QbitSendPlanStore()
    await reopened.init({ storage, now: () => NOW })
    expect(reopened.get(PLAN_ID)).toEqual(written)
    const held = reopened.planHolds()[0]!.outpoints
    expect(held).toContainEqual({ txid: REPLACED_TXID, vout: 0 })
    expect(held).toContainEqual({ txid: MERGE_TXID, vout: 0 })

    // The version that confirmed instead leaves the replacement void.
    const superseded = planRecord({
      steps: [
        replacing({
          status: 'planned',
          replaces: { txid: REPLACED_TXID, fee: 50, confirmed: true },
        }),
        paymentStep(),
      ],
      phase: 'paused',
      pause: { reason: 'merge_refused', at: NOW },
    })
    expect(validateQbitSendPlanRecord(superseded)).toMatchObject({ valid: true })
    await store.put(superseded, written.revision)
    expect(store.get(PLAN_ID)!.steps[0]!.replaces).toEqual({
      txid: REPLACED_TXID,
      fee: 50,
      confirmed: true,
    })
  })

  it('refuses a malformed or impossible replaced version', () => {
    const refused: [string, QbitSendPlanRecord, string][] = [
      [
        'a replaced version that is not an object',
        planRecord({ steps: [replacing({ replaces: 'ab' as never }), paymentStep()] }),
        'steps[0].replaces: not an object',
      ],
      [
        'a replaced version with an unknown key',
        planRecord({
          steps: [
            replacing({ replaces: { txid: REPLACED_TXID, fee: 50, x: 1 } as never }),
            paymentStep(),
          ],
        }),
        'steps[0].replaces: unknown key',
      ],
      [
        'a replaced version without a txid',
        planRecord({
          steps: [replacing({ replaces: { txid: 'AB'.repeat(32), fee: 50 } }), paymentStep()],
        }),
        'steps[0].replaces.txid',
      ],
      [
        'a merge replacing itself',
        planRecord({
          steps: [replacing({ replaces: { txid: MERGE_TXID, fee: 50 } }), paymentStep()],
        }),
        'steps[0].replaces.txid: the merge itself',
      ],
      [
        'a replaced version whose fee crossed as NaN',
        planRecord({
          steps: [
            replacing({ replaces: { txid: REPLACED_TXID, fee: null as never } }),
            paymentStep(),
          ],
        }),
        'steps[0].replaces.fee',
      ],
      [
        'a replaced version confirmed as something else than true',
        planRecord({
          steps: [
            replacing({ replaces: { txid: REPLACED_TXID, fee: 50, confirmed: false as never } }),
            paymentStep(),
          ],
        }),
        'steps[0].replaces.confirmed',
      ],
      [
        'a void replacement that is not planned',
        planRecord({
          steps: [
            replacing({ replaces: { txid: REPLACED_TXID, fee: 50, confirmed: true } }),
            paymentStep(),
          ],
        }),
        'steps[0].status: a replacement whose earlier version confirmed is void',
      ],
      [
        'a payment replacing something',
        planRecord({
          steps: [mergeStep(), paymentStep({ replaces: { txid: REPLACED_TXID, fee: 50 } })],
        }),
        'steps[1].replaces: a payment replaces none',
      ],
      [
        'a replaced version that is the payment',
        planRecord({
          steps: [replacing({ replaces: { txid: PAYMENT_TXID, fee: 50 } }), paymentStep()],
        }),
        'steps[0].replaces.txid: listed twice',
      ],
      [
        'a replaced version that is carried',
        planRecord({
          steps: [replacing(), paymentStep()],
          carried: [carriedStep({ txid: REPLACED_TXID })],
        }),
        'carried[0].txid: listed twice',
      ],
    ]
    for (const [label, record, reason] of refused) {
      expect(validateQbitSendPlanRecord(record), label).toMatchObject({ valid: false, reason })
    }
  })
})

describe('the send guard: a dapp’s signing and a plan’s own reservations', () => {
  const PLAN = 'b2'.repeat(16)
  const input = (byte: string): QbitOutpoint => ({ txid: txid(byte), vout: 0 })
  let guard: QbitSendGuardService

  beforeEach(() => {
    guard = new QbitSendGuardService()
    guard.init()
  })

  const marked = <T>(operation: () => Promise<T>) =>
    Object.assign(operation, { [QBIT_PROVIDER_SIGNING]: true as const })

  it('records a dapp’s signing with its inputs before the signature, so a plan cannot hold them', async () => {
    let holdOutcome: Promise<unknown> | undefined
    await guard.runWithNoOverlap(
      chain,
      [input('11')],
      marked(async () => {
        // A hold asked for while the signature is being made is decided
        // after it, and finds the signing recorded.
        holdOutcome = guard
          .holdOutpointsForPlan({ planId: PLAN, chain, address, outpoints: [input('11')] })
          .catch(error => error)
        return 'signed'
      }),
      txid('99')
    )
    const error = await holdOutcome
    expect(error).toBeInstanceOf(QbitSendPlanHoldConflictError)
    expect((error as QbitSendPlanHoldConflictError).conflicts).toEqual([
      { outpoint: `${txid('11')}:0`, kind: 'provider_signing' },
    ])
  })

  it('takes the record back when the signing fails, keeping one recorded before', async () => {
    await expect(
      guard.runWithNoOverlap(
        chain,
        [input('12')],
        marked(async () => {
          throw new Error('cancelled')
        }),
        txid('98')
      )
    ).rejects.toThrow('cancelled')
    await expect(
      guard.holdOutpointsForPlan({ planId: PLAN, chain, address, outpoints: [input('12')] })
    ).resolves.toBeDefined()

    await guard.recordProviderSigning(chain, txid('97'), [input('13')])
    await expect(
      guard.runWithNoOverlap(
        chain,
        [input('13')],
        marked(async () => {
          throw new Error('cancelled')
        }),
        txid('97')
      )
    ).rejects.toThrow('cancelled')
    await expect(
      guard.holdOutpointsForPlan({
        planId: 'c3'.repeat(16),
        chain,
        address,
        outpoints: [input('13')],
      })
    ).rejects.toBeInstanceOf(QbitSendPlanHoldConflictError)
  })

  it('leaves the remembered signings exactly as they were when a signing at the limit fails', async () => {
    const signedAt = (index: number): string => index.toString(16).padStart(64, '0')
    const inputAt = (index: number): QbitOutpoint => ({ txid: txid('5e'), vout: index })
    for (let index = 0; index < QBIT_PROVIDER_SIGNING_LIMIT; index++) {
      await guard.recordProviderSigning(chain, signedAt(index), [inputAt(index)])
    }
    const remembered = () => [
      ...(guard as unknown as { providerSignings: Map<string, unknown> }).providerSignings,
    ]
    const before = remembered()
    const failing = (signed: string, inputs: QbitOutpoint[]) =>
      guard.runWithNoOverlap(
        chain,
        inputs,
        marked(async () => {
          throw new Error('The wallet is locked')
        }),
        signed
      )
    // A new transaction, whose record pushes the oldest out while it signs,
    // and one remembered already, whose record makes it the newest.
    await expect(failing(txid('9a'), [input('9b')])).rejects.toThrow('locked')
    expect(remembered()).toEqual(before)
    await expect(failing(signedAt(5), [inputAt(5)])).rejects.toThrow('locked')
    expect(remembered()).toEqual(before)

    // The oldest is still remembered: no plan holds its inputs, and its
    // push without a verdict keeps them reserved.
    const refused = await guard
      .holdOutpointsForPlan({ planId: PLAN, chain, address, outpoints: [inputAt(0)] })
      .catch(error => error)
    expect(refused).toBeInstanceOf(QbitSendPlanHoldConflictError)
    expect((refused as QbitSendPlanHoldConflictError).conflicts).toEqual([
      { outpoint: `${txid('5e')}:0`, kind: 'provider_signing' },
    ])
    await expect(
      guard.recordInconclusiveProviderPush(chain, signedAt(0), [inputAt(0)])
    ).resolves.toBe(true)
    // And the order held: six more signings push out the six oldest, the
    // one whose failed signing would have made it the newest among them.
    for (let index = 0; index < 6; index++) {
      await guard.recordProviderSigning(chain, signedAt(QBIT_PROVIDER_SIGNING_LIMIT + index))
    }
    await expect(
      guard.recordInconclusiveProviderPush(chain, signedAt(5), [inputAt(5)])
    ).resolves.toBe(false)
    await expect(
      guard.recordInconclusiveProviderPush(chain, signedAt(6), [inputAt(6)])
    ).resolves.toBe(true)
  })

  it('refuses a dapp’s signing that names no transaction, and records nothing for an unmarked one', async () => {
    await expect(
      guard.runWithNoOverlap(
        chain,
        [input('14')],
        marked(async () => 'signed')
      )
    ).rejects.toThrow('invalid Qbit transaction')
    await guard.runWithNoOverlap(chain, [input('15')], async () => 'signed', txid('96'))
    await expect(
      guard.holdOutpointsForPlan({
        planId: PLAN,
        chain,
        address,
        outpoints: [input('14'), input('15')],
      })
    ).resolves.toBeDefined()
  })

  it('leaves out of the reserved outputs only what the named plan holds', async () => {
    await guard.holdOutpointsForPlan({
      planId: PLAN,
      chain,
      address,
      outpoints: [input('21'), input('22')],
    })
    await guard.holdOutpointsForPlan({
      planId: 'c3'.repeat(16),
      chain,
      address,
      outpoints: [input('23')],
    })
    await guard.recordAcceptedBroadcast(chain, txid('88'), [input('22')])
    const keys = (outpoints: Set<string>) => [...outpoints].sort()
    expect(keys(await guard.getReservedOutpointKeys(chain, address, PLAN))).toEqual(
      [`${txid('22')}:0`, `${txid('23')}:0`].sort()
    )
    expect((await guard.getReservedOutpointKeys(chain, address)).size).toBe(3)
  })

  it('names a refusal over held outputs with a code that crosses the UI port', async () => {
    await guard.holdOutpointsForPlan({ planId: PLAN, chain, address, outpoints: [input('31')] })
    const error = await guard
      .runWithNoOverlap(chain, [input('31')], async () => 'signed')
      .catch(caught => caught)
    expect(error).toBeInstanceOf(QbitSendPlanHeldError)
    expect(error).toMatchObject({ code: QBIT_SEND_PLAN_HELD_CODE, reason: 'held' })
  })
})
