import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PQC_SIGNATURE_BYTES,
  createP2mrPsbt,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  signP2mrPsbt,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import { QBIT_P2MR_DUST, estimateQbitP2mrTransaction } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_SEND_PLAN_MAX_STEPS,
  QBIT_SEND_PLAN_PSBT_HEX_MAX_LENGTH,
  QBIT_SEND_PLAN_STORE_KEY,
  QBIT_SEND_PLAN_STORE_VERSION,
  QbitSendPlanStore,
  QbitSendPlanStoreError,
  validateQbitSendPlanRecord,
  type QbitSendPlanPaymentVersion,
  type QbitSendPlanRecord,
  type QbitSendPlanStepRecord,
  type QbitSendPlanStoreErrorCode,
  type QbitSendPlanStoreStorage,
} from '../src/services/qbitSendPlanStore'
import {
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
  qbitSendPlanSigningKeys,
  type QbitSendPlanAccountKeys,
} from '../src/utils/qbit-send-plan-psbt'

const chain = ChainType.QBIT_REGTEST
const PUBKEY = '5e'.repeat(32)
const OTHER_PUBKEY = '6f'.repeat(32)
const RECIPIENT_PUBKEY = '44'.repeat(32)
const PLAN_ID = 'a1'.repeat(16)
const OTHER_PLAN_ID = 'b2'.repeat(16)
const NOW = 1_762_000_000_000

const NETWORKS = {
  [ChainType.QBIT_MAINNET]: 'mainnet',
  [ChainType.QBIT_TESTNET4]: 'testnet4',
  [ChainType.QBIT_REGTEST]: 'regtest',
} as const

/** The P2MR address of the single-key account of `pubkey` on `on`'s network. */
function addressOf(pubkey: string, on: keyof typeof NETWORKS = chain): string {
  return p2mrAddressFromPubkey(hexToBytes(pubkey), NETWORKS[on])
}

const address = addressOf(PUBKEY)
const otherAddress = addressOf(OTHER_PUBKEY)
const recipient = addressOf(RECIPIENT_PUBKEY)

const psbtHex = (byte: string, bytes = 64): string => `70736274ff${byte.repeat(bytes)}`
const txid = (byte: string): string => byte.repeat(32)

type StepInput = QbitSendPlanStepRecord['inputs'][number]

/** The account's single-key spend: every step spends its outputs, and pays it a merge's output and change. */
const KEYS = qbitSendPlanAccountKeys(PUBKEY)
/** What pays the recipient: a P2MR script, as every recipient's is. */
const RECIPIENT_SCRIPT = qbitSendPlanAccountKeys(RECIPIENT_PUBKEY).scriptPubKey
const FEE_RATE = 1

/** The exact size and fee at `feeRate` of a step spending `inputCount` outputs of the account to `scripts`. */
function priced(inputCount: number, scripts: readonly Uint8Array[], feeRate: number) {
  return estimateQbitP2mrTransaction({
    inputCount,
    outputScriptLengths: scripts.map(script => script.length),
    leafScriptLength: KEYS.leafScript.length,
    controlBlockLength: KEYS.controlBlock.length,
    feeRate,
  })
}

/** An unsigned PSBT spending `inputs`, each an output of the account of `keys`, to `outputs`. */
function stepPsbtHex(
  inputs: readonly StepInput[],
  outputs: readonly { value: number; script: Uint8Array }[],
  keys: QbitSendPlanAccountKeys = KEYS
): string {
  return qbitSendPlanPsbtHex(
    createP2mrPsbt({
      inputs: inputs.map(input => ({
        prevout: { txid: hexToBytes(input.txid).reverse(), vout: input.vout },
        sequence: 0xfffffffd,
        witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: keys.scriptPubKey },
        leafScript: keys.leafScript,
        controlBlock: keys.controlBlock,
        merkleRoot: keys.leafHash,
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

/**
 * `unsignedPsbtHex` signed through the leaf of `keys` with placeholder
 * signatures and finalized, as a stored signed payment is: the same
 * transaction, every input finalized.
 */
function signedHex(unsignedPsbtHex: string, keys: QbitSendPlanAccountKeys = KEYS): string {
  const psbt = qbitSendPlanPsbtFromHex(unsignedPsbtHex)
  const signed = signP2mrPsbt({
    psbt,
    keys: qbitSendPlanSigningKeys(psbt, keys),
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
  }).psbt
  return qbitSendPlanPsbtHex(finalizeP2mrPsbt(signed))
}

const total = (inputs: readonly StepInput[]): number =>
  inputs.reduce((sum, input) => sum + input.satoshis, 0)

/** The three outputs of the account the merge spends. */
const MERGE_INPUTS: readonly StepInput[] = [
  { txid: txid('01'), vout: 0, satoshis: 100_000_000 },
  { txid: txid('02'), vout: 1, satoshis: 200_000_000 },
  { txid: txid('03'), vout: 0, satoshis: 300_000_000 },
]
/** The output of the account the payment spends besides the merge's. */
const DIRECT_INPUT: StepInput = { txid: txid('04'), vout: 0, satoshis: 1_000_000_000 }
const AMOUNT = 900_000_000

interface PlanShape {
  /** The plan's rate, the payment's. */
  feeRate?: number
  /** The merge's rate: the plan's, unless a raise kept the merge from an earlier rate. */
  mergeFeeRate?: number
  target?: 'amount' | 'everything'
  /** For an amount: what the recipient receives, `AMOUNT` by default. */
  amount?: number
  /** The scripts of the payment's memo outputs, each of no value. */
  memos?: readonly Uint8Array[]
  /** The outputs the payment spends besides the merge's: `DIRECT_INPUT` by default. */
  direct?: readonly StepInput[]
  /** Whether the plan has its merge; a plan without one is one payment. */
  merge?: boolean
  /** The outputs the merge spends: `MERGE_INPUTS` by default. */
  mergeInputs?: readonly StepInput[]
  /** The public key of the account that pays: `PUBKEY` by default. */
  owner?: string
  /** The public key of the recipient: `RECIPIENT_PUBKEY` by default. */
  recipientKey?: string
  /** The plan's network: regtest by default. */
  chain?: keyof typeof NETWORKS
}

/**
 * A plan priced as the planner prices one: a merge of `MERGE_INPUTS`, then
 * a payment of its output and `direct`. For an amount, change of at least
 * dust is returned and a smaller remainder is paid as part of the fee; for
 * everything, the payment returns no change. Every step is the transaction
 * its PSBT holds, under that transaction's id, and the account and the
 * recipient are addresses of the plan's network.
 */
function pricedPlan(shape: PlanShape = {}): QbitSendPlanRecord {
  const feeRate = shape.feeRate ?? FEE_RATE
  const owner = shape.owner ?? PUBKEY
  const keys = qbitSendPlanAccountKeys(owner)
  const on = shape.chain ?? chain
  const recipientKey = shape.recipientKey ?? RECIPIENT_PUBKEY
  const recipientScript = qbitSendPlanAccountKeys(recipientKey).scriptPubKey
  const steps: QbitSendPlanStepRecord[] = []
  const inputs: StepInput[] = []
  if (shape.merge !== false) {
    const mergeFeeRate = shape.mergeFeeRate ?? feeRate
    const mergeInputs = shape.mergeInputs ?? MERGE_INPUTS
    const { vsize, fee } = priced(mergeInputs.length, [keys.scriptPubKey], mergeFeeRate)
    const outputValue = total(mergeInputs) - fee
    const unsignedPsbtHex = stepPsbtHex(
      mergeInputs,
      [{ value: outputValue, script: keys.scriptPubKey }],
      keys
    )
    const mergeTxid = txidOfHex(unsignedPsbtHex)
    steps.push({
      kind: 'merge',
      txid: mergeTxid,
      unsignedPsbtHex,
      inputs: mergeInputs.map(input => ({ ...input })),
      vsize,
      fee,
      feeRate: mergeFeeRate,
      outputValue,
      status: 'planned',
    })
    inputs.push({ txid: mergeTxid, vout: 0, satoshis: outputValue })
  }
  inputs.push(...(shape.direct ?? [DIRECT_INPUT]).map(input => ({ ...input })))
  const memos = (shape.memos ?? []).map(script => ({ value: 0, script }))
  const scripts = [recipientScript, ...memos.map(memo => memo.script)]
  const withoutChange = priced(inputs.length, scripts, feeRate)
  const withChange = priced(inputs.length, [...scripts, keys.scriptPubKey], feeRate)
  const funds = total(inputs)
  let amount = funds - withoutChange.fee
  let change = 0
  let { fee, vsize } = withoutChange
  if (shape.target !== 'everything') {
    amount = shape.amount ?? AMOUNT
    change = funds - amount - withChange.fee
    if (change >= QBIT_P2MR_DUST) {
      ;({ fee, vsize } = withChange)
    } else {
      change = 0
      fee = funds - amount
    }
  }
  const paymentPsbtHex = stepPsbtHex(
    inputs,
    [
      { value: amount, script: recipientScript },
      ...memos,
      ...(change > 0 ? [{ value: change, script: keys.scriptPubKey }] : []),
    ],
    keys
  )
  steps.push({
    kind: 'payment',
    txid: txidOfHex(paymentPsbtHex),
    unsignedPsbtHex: paymentPsbtHex,
    inputs,
    vsize,
    fee,
    feeRate,
    status: 'planned',
  })
  return {
    id: PLAN_ID,
    chain: on,
    account: { address: addressOf(owner, on), pubkey: owner },
    recipient: addressOf(recipientKey, on),
    target: shape.target ?? 'amount',
    amount,
    change,
    feeRate,
    totalFee: steps.reduce((sum, step) => sum + step.fee, 0),
    steps,
    phase: 'signing',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  }
}

/** The plan most tests start from: one merge and a payment of `AMOUNT` with change, at 1 bit/vB. */
const PLAN = pricedPlan()
const MERGE_TXID = PLAN.steps[0]!.txid
const PAYMENT_TXID = PLAN.steps[1]!.txid
const MERGE_OUTPUT = PLAN.steps[0]!.outputValue!
const CHANGE = PLAN.change
const PAYMENT_FEE = PLAN.steps[1]!.fee
/** The payment of `PLAN`, signed and finalized. */
const SIGNED_PAYMENT_HEX = signedHex(PLAN.steps[1]!.unsignedPsbtHex)

/** The merge: three outputs to one, priced exactly. */
function mergeStep(overrides: Partial<QbitSendPlanStepRecord> = {}): QbitSendPlanStepRecord {
  return { ...pricedPlan().steps[0]!, ...overrides }
}

/** The payment: the merge's output and one more pay `AMOUNT` and return `CHANGE`. */
function paymentStep(overrides: Partial<QbitSendPlanStepRecord> = {}): QbitSendPlanStepRecord {
  return { ...pricedPlan().steps[1]!, ...overrides }
}

function planRecord(overrides: Partial<QbitSendPlanRecord> = {}): QbitSendPlanRecord {
  return { ...pricedPlan(), ...overrides }
}

/** The same plan on network `on`: the same keys, the addresses of that network. */
function planOn(
  on: keyof typeof NETWORKS,
  overrides: Partial<QbitSendPlanRecord> = {}
): QbitSendPlanRecord {
  return { ...pricedPlan({ chain: on }), ...overrides }
}

/** The plan of another account, over the same outpoints, under its own id. */
function otherAccountPlan(overrides: Partial<QbitSendPlanRecord> = {}): QbitSendPlanRecord {
  return { ...pricedPlan({ owner: OTHER_PUBKEY }), id: OTHER_PLAN_ID, ...overrides }
}

/**
 * `chrome.storage.local` as the background sees it: values are kept
 * serialized, so a read never returns what was written, and a JSON value is
 * all it holds. A write can be made to fail, before or after it lands.
 */
class MemoryStorage implements QbitSendPlanStoreStorage {
  readonly values = new Map<string, string>()
  sets = 0
  writing = 0
  mostWritingAtOnce = 0
  failNextSet: { error: Error; afterWriting: boolean } | undefined
  failGet: Error | undefined

  async get(key: string): Promise<unknown> {
    if (this.failGet) throw this.failGet
    const raw = this.values.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.sets += 1
    this.writing += 1
    this.mostWritingAtOnce = Math.max(this.mostWritingAtOnce, this.writing)
    try {
      await new Promise(resolve => setTimeout(resolve, 1))
      const failure = this.failNextSet
      this.failNextSet = undefined
      if (failure && !failure.afterWriting) throw failure.error
      this.values.set(key, JSON.stringify(value))
      if (failure) throw failure.error
    } finally {
      this.writing -= 1
    }
  }

  /** The stored document's raw JSON. */
  raw(): string | undefined {
    return this.values.get(QBIT_SEND_PLAN_STORE_KEY)
  }

  document(): { version: number; plans: unknown[] } {
    return JSON.parse(this.raw() ?? 'null')
  }

  seed(document: unknown): void {
    this.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
  }
}

async function storeError(
  promise: Promise<unknown>,
  code: QbitSendPlanStoreErrorCode
): Promise<QbitSendPlanStoreError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(QbitSendPlanStoreError)
  expect((error as QbitSendPlanStoreError).code).toBe(code)
  return error as QbitSendPlanStoreError
}

/** `record` without the fields `put` stamps, as a caller hands it over. */
function input(
  record: QbitSendPlanRecord
): Omit<QbitSendPlanRecord, 'revision' | 'createdAt' | 'updatedAt'> {
  const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = record
  return rest
}

describe('QbitSendPlanStore (#188)', () => {
  let storage: MemoryStorage
  let store: QbitSendPlanStore
  let clock: number

  async function openStore(seeded?: unknown): Promise<QbitSendPlanStore> {
    if (seeded !== undefined) storage.seed(seeded)
    const opened = new QbitSendPlanStore()
    await opened.init({ storage, now: () => clock })
    return opened
  }

  beforeEach(async () => {
    storage = new MemoryStorage()
    clock = NOW
    store = await openStore()
  })

  describe('writing plans', () => {
    it('creates a plan in one write of a versioned document, outside the vault, and reads it back after a restart', async () => {
      clock = NOW + 5
      const written = await store.put(input(planRecord()), null)

      expect(written).toEqual(planRecord({ createdAt: NOW + 5, updatedAt: NOW + 5, revision: 1 }))
      expect(storage.sets).toBe(1)
      expect([...storage.values.keys()]).toEqual([QBIT_SEND_PLAN_STORE_KEY])
      expect(storage.document()).toEqual({
        version: QBIT_SEND_PLAN_STORE_VERSION,
        plans: [written],
      })
      expect(store.list()).toEqual([written])
      expect(store.get(PLAN_ID)).toEqual(written)
      expect(store.get(OTHER_PLAN_ID)).toBeUndefined()
      expect(store.findOpen(chain, address)).toEqual(written)
      expect(store.findOpen(chain, otherAddress)).toBeUndefined()
      expect(store.findOpen(ChainType.QBIT_TESTNET4, address)).toBeUndefined()

      // A new worker reads it, with no key or password: nothing else is needed.
      const restarted = await openStore()
      expect(restarted.list()).toEqual([written])
      expect(restarted.unreadable()).toEqual({ plans: [] })
    })

    it('stamps the revision and times itself, keeping createdAt', async () => {
      const created = await store.put({ ...planRecord(), revision: 40, createdAt: 3 }, null)
      expect(created.revision).toBe(1)
      expect(created.createdAt).toBe(NOW)

      clock = NOW + 1000
      const updated = await store.put({ ...created, phase: 'waiting', createdAt: 7 }, 1)

      expect(updated).toEqual({
        ...created,
        phase: 'waiting',
        revision: 2,
        createdAt: NOW,
        updatedAt: NOW + 1000,
      })
      expect(storage.document().plans).toEqual([updated])
    })

    it('keeps its own frozen copy: neither the caller nor a reader can change a stored plan', async () => {
      const record = planRecord()
      const written = await store.put(record, null)
      record.amount = 1
      record.steps[0]!.inputs[0]!.satoshis = 1
      ;(record.account as { address: string }).address = otherAddress

      expect(store.get(PLAN_ID)).toEqual(written)
      expect(written.amount).toBe(AMOUNT)
      expect(Object.isFrozen(written)).toBe(true)
      expect(Object.isFrozen(written.steps[0]!.inputs[0])).toBe(true)
      expect(() => {
        ;(written as { amount: number }).amount = 1
      }).toThrow(TypeError)
      expect(() => {
        written.steps.push(paymentStep())
      }).toThrow(TypeError)
    })

    it('refuses a stale writer: of two that read the same revision, the one that writes second loses', async () => {
      const created = await store.put(planRecord(), null)
      // Writer A reads first, then writer B.
      const readByA = store.get(PLAN_ID)!
      const readByB = store.get(PLAN_ID)!

      const byB = await store.put(
        { ...readByB, phase: 'paused', pause: { reason: 'b', at: NOW } },
        readByB.revision
      )
      await storeError(
        store.put({ ...readByA, phase: 'cancelling' }, readByA.revision),
        'stale_revision'
      )

      expect(store.get(PLAN_ID)).toEqual(byB)
      expect(storage.document().plans).toEqual([byB])
      expect(storage.sets).toBe(2)
      expect(byB.revision).toBe(created.revision + 1)
    })

    it('decides writers racing on the queue in call order, never letting the later one overwrite', async () => {
      const created = await store.put(planRecord(), null)

      const first = store.put({ ...created, phase: 'waiting' }, created.revision)
      const second = store.put({ ...created, phase: 'cancelling' }, created.revision)

      await expect(first).resolves.toMatchObject({ phase: 'waiting', revision: 2 })
      await storeError(second, 'stale_revision')
      expect(store.get(PLAN_ID)?.phase).toBe('waiting')
      expect(storage.mostWritingAtOnce).toBe(1)
    })

    it('has one effect for a repeated write or delete', async () => {
      const created = await store.put(planRecord(), null)
      await storeError(store.put(planRecord(), null), 'already_exists')

      const update = { ...created, phase: 'waiting' as const }
      await store.put(update, 1)
      await storeError(store.put(update, 1), 'stale_revision')

      await expect(store.delete(PLAN_ID, 2)).resolves.toBe(true)
      await expect(store.delete(PLAN_ID, 2)).resolves.toBe(false)
      await storeError(store.put(update, 2), 'not_found')
      expect(store.list()).toEqual([])
      expect(storage.document()).toEqual({ version: 1, plans: [] })
    })

    it('refuses a deletion decided on an older revision', async () => {
      const created = await store.put(planRecord(), null)
      const sent = await store.put({ ...created, phase: 'sending' }, created.revision)

      await storeError(store.delete(PLAN_ID, created.revision), 'stale_revision')
      expect(store.get(PLAN_ID)).toEqual(sent)
      await expect(store.delete(PLAN_ID, sent.revision)).resolves.toBe(true)
    })

    it('keeps one plan per network and account, in any phase, until it is deleted', async () => {
      const created = await store.put(planRecord({ phase: 'completed' }), null)

      const second = await storeError(
        store.put(planRecord({ id: OTHER_PLAN_ID }), null),
        'account_has_open_plan'
      )
      expect(second.message).not.toContain(address)
      // Another account, or the same key on another network, is another plan.
      await store.put(otherAccountPlan(), null)
      await store.put(planOn(ChainType.QBIT_TESTNET4, { id: 'c3'.repeat(16) }), null)

      await store.delete(PLAN_ID, created.revision)
      await expect(store.put(planRecord({ id: 'd4'.repeat(16) }), null)).resolves.toMatchObject({
        revision: 1,
      })
    })

    it("refuses an update that changes the plan's network, account or recipient", async () => {
      const created = await store.put(planRecord(), null)
      // Each a record valid in itself, its transactions those of the plan it states.
      for (const changed of [
        planOn(ChainType.QBIT_TESTNET4),
        { ...otherAccountPlan(), id: PLAN_ID },
        pricedPlan({ recipientKey: '55'.repeat(32) }),
      ]) {
        await storeError(store.put(changed, created.revision), 'identity_changed')
      }
      // A key that is not the address's is no record at all.
      await storeError(
        store.put(
          { ...created, account: { ...created.account, pubkey: OTHER_PUBKEY } },
          created.revision
        ),
        'invalid_record'
      )
      expect(store.get(PLAN_ID)).toEqual(created)
      expect(storage.sets).toBe(1)
    })

    it('refuses a revision that is no stored revision', async () => {
      const created = await store.put(planRecord(), null)
      for (const revision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await storeError(store.put(created, revision), 'invalid_record')
      }
      await storeError(store.put(created, 2), 'stale_revision')
    })
  })

  describe('a failing storage write', () => {
    it('leaves every read as it was and hands the caller the error', async () => {
      const created = await store.put(planRecord(), null)
      const failure = new Error('QUOTA_BYTES quota exceeded')
      storage.failNextSet = { error: failure, afterWriting: false }

      await expect(store.put({ ...created, phase: 'waiting' }, created.revision)).rejects.toBe(
        failure
      )

      expect(store.get(PLAN_ID)).toEqual(created)
      expect(storage.document().plans).toEqual([created])
      // Nothing claims the write happened: the revision the caller read still writes.
      await expect(
        store.put({ ...created, phase: 'waiting' }, created.revision)
      ).resolves.toMatchObject({ revision: 2, phase: 'waiting' })

      storage.failNextSet = { error: failure, afterWriting: false }
      await expect(store.put(otherAccountPlan(), null)).rejects.toBe(failure)
      expect(store.get(OTHER_PLAN_ID)).toBeUndefined()
      storage.failNextSet = { error: failure, afterWriting: false }
      await expect(store.delete(PLAN_ID, 2)).rejects.toBe(failure)
      expect(store.get(PLAN_ID)?.revision).toBe(2)
    })

    it('is overwritten by the next write when storage kept it despite the error', async () => {
      const created = await store.put(planRecord(), null)
      storage.failNextSet = { error: new Error('lost answer'), afterWriting: true }

      await expect(
        store.put({ ...created, phase: 'paused', pause: { reason: 'x', at: NOW } }, 1)
      ).rejects.toThrow('lost answer')
      // Storage kept it, the store does not claim it: the caller saw a failure.
      expect(store.get(PLAN_ID)).toEqual(created)
      expect(storage.document().plans).toMatchObject([{ revision: 2, phase: 'paused' }])

      // The next write puts down the whole document as the store knows it.
      const next = await store.put({ ...created, phase: 'waiting' }, 1)
      expect(storage.document().plans).toEqual([next])
      const restarted = await openStore()
      expect(restarted.list()).toEqual([next])
    })
  })

  describe('validation', () => {
    const withStep = (index: number, overrides: Record<string, unknown>): QbitSendPlanRecord => {
      const record = planRecord()
      record.steps[index] = { ...record.steps[index]!, ...overrides } as QbitSendPlanStepRecord
      return record
    }
    const withoutKey = (key: keyof QbitSendPlanRecord): QbitSendPlanRecord => {
      const record = planRecord() as unknown as Record<string, unknown>
      delete record[key]
      return record as unknown as QbitSendPlanRecord
    }
    const signedPayment = (
      overrides: Partial<QbitSendPlanStepRecord> = {}
    ): QbitSendPlanStepRecord =>
      paymentStep({ status: 'signed', signedPsbtHex: SIGNED_PAYMENT_HEX, ...overrides })
    /** The payment's inputs paying `outputs` instead, under that transaction's id. */
    const paymentPaying = (
      outputs: readonly { value: number; script: Uint8Array }[]
    ): { txid: string; unsignedPsbtHex: string } => {
      const unsignedPsbtHex = stepPsbtHex(PLAN.steps[1]!.inputs, outputs)
      return { txid: txidOfHex(unsignedPsbtHex), unsignedPsbtHex }
    }

    const refused: [string, unknown][] = [
      ['not an object', 'plan'],
      ['an array', [planRecord()]],
      ['null', null],
      ...(
        [
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
          'phase',
          'createdAt',
          'updatedAt',
          'revision',
        ] as const
      ).map((key): [string, unknown] => [`without ${key}`, withoutKey(key)]),
      ['an id in upper case', planRecord({ id: PLAN_ID.toUpperCase() })],
      ['a short id', planRecord({ id: PLAN_ID.slice(2) })],
      ['an unknown network', planRecord({ chain: 'QBIT_SIMNET' as ChainType })],
      [
        'an upper-case public key',
        planRecord({ account: { address, pubkey: PUBKEY.toUpperCase() } }),
      ],
      ['a short public key', planRecord({ account: { address, pubkey: '5e' } })],
      [
        'an unknown account key',
        planRecord({ account: { address, pubkey: PUBKEY, index: 0 } as never }),
      ],
      ['an empty address', planRecord({ account: { address: '', pubkey: PUBKEY } })],
      ['an address with a space', planRecord({ recipient: 'qbrt1z recipient' })],
      ['an unknown target', planRecord({ target: 'max' as never })],
      ['an amount as text', planRecord({ amount: '9000' as never })],
      // JSON holds no NaN: a NaN written through a port arrives as null.
      ['a null amount', planRecord({ amount: null as never })],
      ['a NaN amount', planRecord({ amount: Number.NaN })],
      ['an infinite amount', planRecord({ amount: Number.POSITIVE_INFINITY })],
      ['a fractional amount', planRecord({ amount: 9000.5 })],
      ['an unsafe amount', planRecord({ amount: 2 ** 53 })],
      ['a zero amount', planRecord({ amount: 0, change: CHANGE + AMOUNT })],
      ['a negative change', planRecord({ change: -1 })],
      ['a fee rate under the relay floor', planRecord({ feeRate: 0.24 })],
      ['a fee rate over the policy maximum', planRecord({ feeRate: 10_001 })],
      ['a null fee rate', planRecord({ feeRate: null as never })],
      ['a total fee that is not the sum of the step fees', planRecord({ totalFee: 299 })],
      ['a null revision', planRecord({ revision: null as never })],
      ['a zero revision', planRecord({ revision: 0 })],
      ['a negative time', planRecord({ createdAt: -1 })],
      ['an unknown phase', planRecord({ phase: 'done' as never })],
      ['an unknown top-level key', { ...planRecord(), memo: 'x' }],
      ['a pause without a reason', planRecord({ pause: { reason: '', at: NOW } })],
      ['a pause with a null time', planRecord({ pause: { reason: 'x', at: null as never } })],
      [
        'a pause with an unknown key',
        planRecord({ pause: { reason: 'x', at: NOW, code: 1 } as never }),
      ],
      [
        'a pause detail too long',
        planRecord({ pause: { reason: 'x', at: NOW, detail: 'd'.repeat(1001) } }),
      ],
      ['extra that is a list', planRecord({ extra: [] as never })],
      ['extra holding a NaN', planRecord({ extra: { estimate: Number.NaN } })],
      ['extra holding a date', planRecord({ extra: { at: new Date(NOW) } })],
      ['extra holding undefined in a list', planRecord({ extra: { list: [1, undefined] } })],
      ['no steps', planRecord({ steps: [] })],
      [
        'more steps than one level of merges',
        planRecord({
          steps: [
            ...Array.from({ length: QBIT_SEND_PLAN_MAX_STEPS }, () => mergeStep()),
            paymentStep(),
          ],
        }),
      ],
      ['no payment', planRecord({ steps: [mergeStep()] })],
      ['a payment before a merge', planRecord({ steps: [paymentStep(), mergeStep()] })],
      ['two payments', planRecord({ steps: [paymentStep(), paymentStep({ txid: txid('ee') })] })],
      ['an unknown step kind', withStep(0, { kind: 'sweep' })],
      ['an unknown step status', withStep(0, { status: 'sent' })],
      ['an unknown step key', withStep(0, { note: 'x' })],
      ['an upper-case txid', withStep(0, { txid: MERGE_TXID.toUpperCase() })],
      ['a short txid', withStep(1, { txid: 'dd' })],
      ['a PSBT of odd length', withStep(0, { unsignedPsbtHex: `${psbtHex('aa')}a` })],
      ['a PSBT in upper case', withStep(0, { unsignedPsbtHex: psbtHex('AA') })],
      ['a PSBT without its magic', withStep(0, { unsignedPsbtHex: 'ab'.repeat(40) })],
      ['a PSBT that is not hex', withStep(0, { unsignedPsbtHex: psbtHex('zz') })],
      [
        'a PSBT over the length limit',
        withStep(0, { unsignedPsbtHex: psbtHex('aa', QBIT_SEND_PLAN_PSBT_HEX_MAX_LENGTH / 2) }),
      ],
      ['a step without inputs', withStep(0, { inputs: [] })],
      [
        'an input with an unknown key',
        withStep(0, { inputs: [{ txid: txid('01'), vout: 0, satoshis: 6000, script: '51' }] }),
      ],
      [
        'an input with a null vout',
        withStep(0, { inputs: [{ txid: txid('01'), vout: null, satoshis: 6000 }] }),
      ],
      [
        'an input with a negative vout',
        withStep(0, { inputs: [{ txid: txid('01'), vout: -1, satoshis: 6000 }] }),
      ],
      [
        'an input with a vout past 32 bits',
        withStep(0, { inputs: [{ txid: txid('01'), vout: 2 ** 32, satoshis: 6000 }] }),
      ],
      [
        'an input worth nothing',
        withStep(0, {
          inputs: [{ txid: txid('01'), vout: 0, satoshis: 0 }, ...mergeStep().inputs.slice(1)],
          outputValue: 4900,
        }),
      ],
      ['a zero vsize', withStep(0, { vsize: 0 })],
      ['a negative fee', withStep(0, { fee: -1 })],
      ['a merge without its output value', withStep(0, { outputValue: undefined })],
      ['a payment with an output value', withStep(1, { outputValue: 9700 })],
      ['a merge whose inputs do not add up', withStep(0, { outputValue: MERGE_OUTPUT - 100 })],
      ['a signed PSBT on a merge', withStep(0, { status: 'signed', signedPsbtHex: psbtHex('cd') })],
      ['a signed PSBT on a payment not signed yet', withStep(1, { signedPsbtHex: psbtHex('cd') })],
      ['a signed payment without its PSBT', withStep(1, { status: 'signed' })],
      ['a payment sent without its PSBT', withStep(1, { status: 'broadcast' })],
      [
        'a signed payment with a malformed PSBT',
        planRecord({ steps: [mergeStep(), signedPayment({ signedPsbtHex: 'cd' })] }),
      ],
      [
        'an outpoint spent by two steps',
        planRecord({
          steps: [
            mergeStep(),
            paymentStep({
              inputs: [
                { txid: MERGE_TXID, vout: 0, satoshis: MERGE_OUTPUT },
                { txid: txid('01'), vout: 0, satoshis: DIRECT_INPUT.satoshis },
              ],
            }),
          ],
        }),
      ],
      [
        'an outpoint spent twice by one step',
        withStep(0, {
          inputs: [
            { txid: txid('01'), vout: 0, satoshis: 3000 },
            { txid: txid('01'), vout: 0, satoshis: 3000 },
          ],
        }),
      ],
      [
        "a payment spending a merge's output other than 0",
        withStep(1, {
          inputs: [
            { txid: MERGE_TXID, vout: 0, satoshis: MERGE_OUTPUT },
            { txid: MERGE_TXID, vout: 1, satoshis: DIRECT_INPUT.satoshis },
          ],
        }),
      ],
      [
        "a payment spending a merge's output for another amount",
        planRecord({
          change: CHANGE + 100,
          steps: [
            mergeStep(),
            paymentStep({
              inputs: [
                { txid: MERGE_TXID, vout: 0, satoshis: MERGE_OUTPUT + 100 },
                { ...DIRECT_INPUT },
              ],
            }),
          ],
        }),
      ],
      [
        'a merge the payment does not spend',
        planRecord({
          amount: DIRECT_INPUT.satoshis - CHANGE - PAYMENT_FEE,
          steps: [mergeStep(), paymentStep({ inputs: [{ ...DIRECT_INPUT }] })],
        }),
      ],
      [
        'a merge spending a step of the plan',
        withStep(0, {
          inputs: [{ txid: PAYMENT_TXID, vout: 1, satoshis: 6000 }],
        }),
      ],
      ['a payment whose inputs do not add up', planRecord({ amount: AMOUNT + 1 })],
      // What a record shows is what its transactions pay.
      [
        'a recipient the payment does not pay',
        planRecord({ recipient: addressOf('55'.repeat(32)) }),
      ],
      [
        'a recipient that is no address of the plan’s network',
        planRecord({ recipient: addressOf(RECIPIENT_PUBKEY, ChainType.QBIT_MAINNET) }),
      ],
      [
        'an amount the payment does not pay, the change moved to match',
        planRecord({ amount: AMOUNT - 1_000_000, change: CHANGE + 1_000_000 }),
      ],
      [
        'change the payment does not return, the amount moved to match',
        planRecord({ amount: AMOUNT + 1_000_000, change: CHANGE - 1_000_000 }),
      ],
      [
        'a payment returning its change to another script',
        withStep(
          1,
          paymentPaying([
            { value: AMOUNT, script: RECIPIENT_SCRIPT },
            { value: CHANGE, script: qbitSendPlanAccountKeys(OTHER_PUBKEY).scriptPubKey },
          ])
        ),
      ],
      [
        'a payment of the amount to another script',
        withStep(
          1,
          paymentPaying([
            { value: AMOUNT, script: qbitSendPlanAccountKeys(OTHER_PUBKEY).scriptPubKey },
            { value: CHANGE, script: KEYS.scriptPubKey },
          ])
        ),
      ],
      ['a payment under another id than its transaction’s', withStep(1, { txid: txid('dd') })],
      [
        'a merge under another id than its transaction’s',
        planRecord({
          steps: [
            mergeStep({ txid: txid('cc') }),
            paymentStep({
              inputs: [{ txid: txid('cc'), vout: 0, satoshis: MERGE_OUTPUT }, { ...DIRECT_INPUT }],
            }),
          ],
        }),
      ],
      [
        'signed bytes of another transaction, under that transaction’s id',
        (() => {
          const other = paymentPaying([
            { value: AMOUNT, script: RECIPIENT_SCRIPT },
            { value: CHANGE, script: qbitSendPlanAccountKeys(OTHER_PUBKEY).scriptPubKey },
          ])
          return planRecord({
            steps: [
              mergeStep(),
              signedPayment({ txid: other.txid, signedPsbtHex: signedHex(other.unsignedPsbtHex) }),
            ],
          })
        })(),
      ],
      [
        'signed bytes of another transaction, under the payment’s id',
        planRecord({
          steps: [
            mergeStep(),
            signedPayment({
              signedPsbtHex: signedHex(
                paymentPaying([
                  { value: AMOUNT - 1_000, script: RECIPIENT_SCRIPT },
                  { value: CHANGE + 1_000, script: KEYS.scriptPubKey },
                ]).unsignedPsbtHex
              ),
            }),
          ],
        }),
      ],
      [
        'signed bytes that are not finalized',
        planRecord({
          steps: [mergeStep(), signedPayment({ signedPsbtHex: PLAN.steps[1]!.unsignedPsbtHex })],
        }),
      ],
      [
        'an account address that is not its key’s',
        planRecord({ account: { address: otherAddress, pubkey: PUBKEY } }),
      ],
      [
        'an account address of another network',
        planRecord({
          account: { address: addressOf(PUBKEY, ChainType.QBIT_MAINNET), pubkey: PUBKEY },
        }),
      ],
    ]

    /** Refused for fields `put` stamps itself: only a stored entry can carry them wrong. */
    const stampedByPut = new Set([
      'without createdAt',
      'without updatedAt',
      'without revision',
      'a null revision',
      'a zero revision',
      'a negative time',
    ])

    it.each(refused)('refuses %s: in the validator, on put and on load', async (label, value) => {
      const verdict = validateQbitSendPlanRecord(value)
      expect(verdict.valid).toBe(false)
      if (!verdict.valid) {
        expect(verdict.reason).toBeTruthy()
        // A reason names a field or rule, never a stored value.
        expect(verdict.reason).not.toContain(address)
        expect(verdict.reason).not.toContain(recipient)
        expect(verdict.reason).not.toContain(String(AMOUNT))
      }

      if (stampedByPut.has(label)) {
        await expect(store.put(value as QbitSendPlanRecord, null)).resolves.toMatchObject({
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        })
      } else {
        const error = await storeError(
          store.put(value as QbitSendPlanRecord, null),
          'invalid_record'
        )
        expect(error.reason).toBeTruthy()
        expect(storage.sets).toBe(0)
        expect(store.list()).toEqual([])
      }

      // On load, as storage holds it: reported, never thrown, and kept.
      const stored = JSON.parse(JSON.stringify({ version: 1, plans: [value] }))
      const fromStorage = validateQbitSendPlanRecord(stored.plans[0])
      const opened = await openStore(stored)
      if (fromStorage.valid) {
        // JSON made it a valid record (a date became text): read as stored.
        expect(opened.list()).toEqual(stored.plans)
      } else {
        expect(opened.list()).toEqual([])
        expect(opened.unreadable().plans).toEqual([
          expect.objectContaining({ index: 0, reason: fromStorage.reason }),
        ])
        expect(storage.document()).toEqual(stored)
      }
    })

    it('names no key in a reason: keys are stored data too', () => {
      expect(validateQbitSendPlanRecord({ ...planRecord(), [recipient]: 1 })).toMatchObject({
        valid: false,
        reason: 'unknown key',
      })
      expect(
        validateQbitSendPlanRecord(planRecord({ extra: { [address]: [Number.NaN] } }))
      ).toMatchObject({ valid: false, reason: 'extra: not finite' })
      const cyclic: Record<string, unknown> = {}
      cyclic['self'] = cyclic
      expect(validateQbitSendPlanRecord(planRecord({ extra: cyclic }))).toMatchObject({
        valid: false,
        reason: 'extra: too deep',
      })
    })

    it('names the plan of a refused record when its id is readable', () => {
      expect(validateQbitSendPlanRecord(planRecord({ amount: Number.NaN }))).toEqual({
        valid: false,
        reason: 'amount',
        planId: PLAN_ID,
      })
      expect(validateQbitSendPlanRecord(planRecord({ id: 'x', amount: Number.NaN }))).toEqual({
        valid: false,
        reason: 'id',
      })
    })

    it('accepts the boundaries, and returns the very record it was handed', () => {
      const accepted = [
        planRecord(),
        pricedPlan({ feeRate: 0.25 }),
        pricedPlan({ feeRate: 10_000 }),
        pricedPlan({ target: 'everything' }),
        planRecord({ steps: [mergeStep(), signedPayment()] }),
        planRecord({
          steps: [mergeStep({ status: 'confirmed' }), signedPayment({ status: 'unknown' })],
        }),
        planRecord({
          phase: 'paused',
          pause: { reason: 'merge_refused', at: NOW, detail: 'd'.repeat(1000) },
        }),
        planRecord({
          extra: { attempts: 2, seen: [MERGE_TXID, null, true], nested: { a: { b: -0.5 } } },
        }),
        planRecord({ createdAt: 0, updatedAt: 0, revision: Number.MAX_SAFE_INTEGER }),
        pricedPlan({
          mergeInputs: [{ ...MERGE_INPUTS[0]!, vout: 0xffffffff }, ...MERGE_INPUTS.slice(1)],
        }),
        // A plan with no merge is one payment.
        pricedPlan({ merge: false }),
      ]
      for (const record of accepted) {
        const verdict = validateQbitSendPlanRecord(record)
        expect(verdict).toEqual({ valid: true, record })
        if (verdict.valid) expect(verdict.record).toBe(record)
      }
    })

    it('stores a signed 106-input payment of about 800,000 hex characters', async () => {
      const inputs = Array.from({ length: 106 }, (_, index) => ({
        txid: index.toString(16).padStart(2, '0').repeat(32),
        vout: 0,
        satoshis: 10_000_000,
      }))
      const unsigned = pricedPlan({ merge: false, direct: inputs })
      const record = {
        ...unsigned,
        steps: [
          {
            ...unsigned.steps[0]!,
            status: 'signed' as const,
            signedPsbtHex: signedHex(unsigned.steps[0]!.unsignedPsbtHex),
          },
        ],
      }

      const written = await store.put(record, null)

      const stored = written.steps[0]!.signedPsbtHex!
      expect(stored.length).toBeGreaterThan(780_000)
      expect(stored.length).toBeLessThan(820_000)
      const restarted = await openStore()
      expect(restarted.get(PLAN_ID)).toEqual(written)
      expect(restarted.planHolds()[0]?.outpoints).toHaveLength(106)
    })

    it("drops optional keys left undefined, as storage would, and never stores a caller's undefined", async () => {
      const written = await store.put(
        { ...planRecord(), pause: undefined, extra: undefined } as unknown as QbitSendPlanRecord,
        null
      )
      expect('pause' in written).toBe(false)
      expect('extra' in written).toBe(false)
      expect(storage.raw()).not.toContain('pause')
    })
  })

  describe('the fees a record carries', () => {
    const withStep = (index: number, overrides: Record<string, unknown>): QbitSendPlanRecord => {
      const record = planRecord()
      record.steps[index] = { ...record.steps[index]!, ...overrides } as QbitSendPlanStepRecord
      return record
    }

    /**
     * `record` with every step's PSBT built again from its figures, as a
     * record changed on disk to stay consistent would be.
     */
    function withPsbts(record: QbitSendPlanRecord): QbitSendPlanRecord {
      return {
        ...record,
        steps: record.steps.map(step => ({
          ...step,
          unsignedPsbtHex: stepPsbtHex(
            step.inputs,
            step.kind === 'merge'
              ? [{ value: step.outputValue!, script: KEYS.scriptPubKey }]
              : [
                  { value: record.amount, script: RECIPIENT_SCRIPT },
                  ...(record.change > 0
                    ? [{ value: record.change, script: KEYS.scriptPubKey }]
                    : []),
                ]
          ),
        })),
      }
    }

    /**
     * `record` is refused for `reason` by the validator, on put (nothing
     * written) and on load, where it is unreadable, holds nothing and stays
     * on disk as it was.
     */
    async function expectRefused(record: QbitSendPlanRecord, reason: string): Promise<void> {
      expect(validateQbitSendPlanRecord(record)).toEqual({ valid: false, reason, planId: PLAN_ID })
      const sets = storage.sets
      const error = await storeError(store.put(input(record), null), 'invalid_record')
      expect(error.reason).toBe(reason)
      expect(storage.sets).toBe(sets)
      const stored = JSON.parse(JSON.stringify({ version: 1, plans: [record] }))
      const opened = await openStore(stored)
      expect(opened.list()).toEqual([])
      expect(opened.planHolds()).toEqual([])
      expect(opened.unreadable().plans).toEqual([
        expect.objectContaining({ index: 0, id: PLAN_ID, reason }),
      ])
      expect(storage.document()).toEqual(stored)
    }

    const NOT_PRICED = "not the wallet's pricing"

    it('refuses a merge whose fee was raised, its output lowered to match, the record otherwise consistent', async () => {
      for (const burned of [1, 1_000, MERGE_OUTPUT - QBIT_P2MR_DUST]) {
        const record = planRecord({ totalFee: PLAN.totalFee + burned })
        const [merge, payment] = record.steps as [QbitSendPlanStepRecord, QbitSendPlanStepRecord]
        merge.fee += burned
        merge.outputValue = MERGE_OUTPUT - burned
        payment.inputs[0]!.satoshis = MERGE_OUTPUT - burned
        // The payment claims its other input holds as much more, and pays
        // the recipient and the change as before.
        payment.inputs[1]!.satoshis += burned
        await expectRefused(withPsbts(record), `steps[0].fee: ${NOT_PRICED}`)
      }
    })

    it('refuses a payment whose fee was raised, its change lowered to match, the record otherwise consistent', async () => {
      for (const burned of [1, 1_000, CHANGE - QBIT_P2MR_DUST]) {
        const record = planRecord({ change: CHANGE - burned, totalFee: PLAN.totalFee + burned })
        record.steps[1]!.fee += burned
        await expectRefused(withPsbts(record), `steps[1].fee: ${NOT_PRICED}`)
      }
      // All of the change, its output dropped and the size it no longer has with it.
      const record = planRecord({ change: 0, totalFee: PLAN.totalFee + CHANGE })
      record.steps[1]!.fee += CHANGE
      record.steps[1]!.vsize = priced(2, [RECIPIENT_SCRIPT], FEE_RATE).vsize
      await expectRefused(withPsbts(record), `steps[1].fee: ${NOT_PRICED}`)
      // Nor does a fee below the price pass.
      const under = planRecord({ change: CHANGE + 1, totalFee: PLAN.totalFee - 1 })
      under.steps[1]!.fee -= 1
      await expectRefused(withPsbts(under), `steps[1].fee: ${NOT_PRICED}`)
    })

    it('lets an amount paid without change fold into its fee only what a change output could not return', async () => {
      const funds = MERGE_OUTPUT + DIRECT_INPUT.satoshis
      const withChange = priced(2, [RECIPIENT_SCRIPT, KEYS.scriptPubKey], FEE_RATE)
      // The largest remainder the planner folds: a change output would
      // return one bit less than dust.
      const folded = pricedPlan({ amount: funds - withChange.fee - (QBIT_P2MR_DUST - 1) })
      expect(folded.change).toBe(0)
      expect(folded.steps[1]!.fee).toBe(withChange.fee + QBIT_P2MR_DUST - 1)
      expect(validateQbitSendPlanRecord(folded)).toEqual({ valid: true, record: folded })
      await expect(store.put(input(folded), null)).resolves.toMatchObject({ revision: 1 })
      await store.delete(PLAN_ID, 1)

      // One bit more, the amount one bit less: a change output would return
      // dust, so the planner returns change instead.
      const more = { ...folded, amount: folded.amount - 1, totalFee: folded.totalFee + 1 }
      more.steps = [folded.steps[0]!, { ...folded.steps[1]!, fee: folded.steps[1]!.fee + 1 }]
      await expectRefused(withPsbts(more), `steps[1].fee: ${NOT_PRICED}`)

      // Everything folds nothing: its payment pays exactly its price.
      const everything = pricedPlan({ target: 'everything' })
      const short = {
        ...everything,
        amount: everything.amount - 1,
        totalFee: everything.totalFee + 1,
      }
      short.steps = [
        everything.steps[0]!,
        { ...everything.steps[1]!, fee: everything.steps[1]!.fee + 1 },
      ]
      await expectRefused(withPsbts(short), `steps[1].fee: ${NOT_PRICED}`)
    })

    it('refuses a size that is not the size of the step’s transaction', async () => {
      await expectRefused(
        withStep(0, { vsize: PLAN.steps[0]!.vsize + 1 }),
        `steps[0].vsize: ${NOT_PRICED}`
      )
      await expectRefused(
        withStep(1, { vsize: PLAN.steps[1]!.vsize - 1 }),
        `steps[1].vsize: ${NOT_PRICED}`
      )
    })

    it('refuses a merge that pays back less than dust', async () => {
      const mergeFee = priced(3, [KEYS.scriptPubKey], FEE_RATE).fee
      const record = pricedPlan({
        mergeInputs: [
          { txid: txid('01'), vout: 0, satoshis: mergeFee },
          { txid: txid('02'), vout: 1, satoshis: QBIT_P2MR_DUST - 2 },
          { txid: txid('03'), vout: 0, satoshis: 1 },
        ],
      })
      expect(record.steps[0]!.outputValue).toBe(QBIT_P2MR_DUST - 1)
      await expectRefused(record, `steps[0].outputValue: ${NOT_PRICED}`)
    })

    it('refuses a step priced at a rate outside policy or above the plan’s, and a payment at another rate than the plan’s', async () => {
      for (const feeRate of [0.24, 10_001, null, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
        await expectRefused(withStep(0, { feeRate }), 'steps[0].feeRate')
        await expectRefused(withStep(1, { feeRate }), 'steps[1].feeRate')
      }
      await expectRefused(pricedPlan({ mergeFeeRate: 2 }), "steps[0].feeRate: above the plan's")
      await expectRefused(planRecord({ feeRate: 2 }), "steps[1].feeRate: not the plan's")
      // A merge a raise kept from an earlier rate, the rest priced at the raised one.
      const raised = pricedPlan({ feeRate: 2, mergeFeeRate: 1 })
      expect(validateQbitSendPlanRecord(raised)).toEqual({ valid: true, record: raised })
    })

    it('reads a record whose steps state no rate, as an earlier build wrote one, as unreadable', async () => {
      const record = planRecord()
      for (const step of record.steps) delete (step as Partial<QbitSendPlanStepRecord>).feeRate
      await expectRefused(record, 'steps[0].feeRate')
    })

    it('refuses a payment whose unsigned PSBT does not parse, or spends other inputs than it records', async () => {
      await expectRefused(
        withStep(1, { unsignedPsbtHex: psbtHex('bb') }),
        'steps[1].unsignedPsbtHex: not a PSBT'
      )
      await expectRefused(
        withStep(1, {
          unsignedPsbtHex: stepPsbtHex(
            [DIRECT_INPUT],
            [{ value: AMOUNT, script: RECIPIENT_SCRIPT }]
          ),
        }),
        "steps[1].unsignedPsbtHex: not the step's inputs"
      )
    })

    it('accepts every plan priced as the planner prices one: any rate in policy, memos, a plan of one payment, a merge kept from a lower rate', () => {
      const memo = (bytes: number): Uint8Array =>
        Uint8Array.from([0x6a, bytes, ...new Array<number>(bytes).fill(0x61)])
      const shapes: PlanShape[] = [
        {},
        { target: 'everything' },
        { merge: false },
        { memos: [memo(10)] },
        { memos: [memo(75)], target: 'everything' },
        { mergeFeeRate: 0.25 },
      ]
      for (const feeRate of [0.25, 0.3, 0.5, 1, 1.37, 2.5, 10, 123.45, 10_000]) {
        for (const shape of shapes) {
          const record = pricedPlan({ feeRate, ...shape })
          expect(validateQbitSendPlanRecord(record), JSON.stringify({ feeRate, shape })).toEqual({
            valid: true,
            record,
          })
        }
      }
    })
  })

  describe('earlier versions of the payment', () => {
    /** The plan after a raise of its payment's fee to 2 bits/vB: the merge kept at 1. */
    const raised = (): QbitSendPlanRecord => pricedPlan({ feeRate: 2, mergeFeeRate: 1 })
    /** The payment as the plan first built it, at 1 bit/vB, as an earlier version. */
    const firstVersion = (
      overrides: Partial<QbitSendPlanPaymentVersion> = {}
    ): QbitSendPlanPaymentVersion => {
      const first = pricedPlan()
      const payment = first.steps[1]!
      return {
        txid: payment.txid,
        unsignedPsbtHex: payment.unsignedPsbtHex,
        vsize: payment.vsize,
        fee: payment.fee,
        feeRate: payment.feeRate,
        amount: first.amount,
        change: first.change,
        dispatch: 'unknown',
        ...overrides,
      }
    }
    const withVersions = (
      versions: unknown[],
      overrides: Partial<QbitSendPlanRecord> = {}
    ): QbitSendPlanRecord =>
      ({ ...raised(), earlierPayments: versions, ...overrides }) as QbitSendPlanRecord

    it('keeps the earlier versions of a payment, and what became of its bytes, through storage', async () => {
      const record = withVersions([firstVersion()])
      record.steps[1] = { ...record.steps[1]!, dispatch: 'refused' }
      expect(validateQbitSendPlanRecord(record)).toEqual({ valid: true, record })
      const written = await store.put(input(record), null)
      const reopened = await openStore()
      expect(reopened.get(PLAN_ID)).toEqual(written)
      expect(written.earlierPayments).toEqual([firstVersion()])
      expect(written.steps[1]!.dispatch).toBe('refused')
    })

    it('refuses an earlier version that is not a version of this payment, and malformed marks', () => {
      const other = pricedPlan({ direct: [{ txid: txid('09'), vout: 0, satoshis: 1_000_000_000 }] })
      const refused: [string, QbitSendPlanRecord, string][] = [
        [
          'a version spending other inputs',
          withVersions([
            firstVersion({
              txid: other.steps[1]!.txid,
              unsignedPsbtHex: other.steps[1]!.unsignedPsbtHex,
            }),
          ]),
          'earlierPayments[0]: payment input 1 outpoint',
        ],
        [
          // Every version spends the payment's inputs in the same order: a
          // version found completes the plan with the payment's input list,
          // which must describe its transaction input by input.
          'a version spending the same inputs in another order',
          withVersions([
            (() => {
              const first = pricedPlan()
              const payment = first.steps[1]!
              const unsignedPsbtHex = stepPsbtHex(
                [...payment.inputs].reverse(),
                [
                  {
                    value: first.amount,
                    script: qbitSendPlanAccountKeys(RECIPIENT_PUBKEY).scriptPubKey,
                  },
                  { value: first.change, script: qbitSendPlanAccountKeys(PUBKEY).scriptPubKey },
                ],
                qbitSendPlanAccountKeys(PUBKEY)
              )
              return firstVersion({ txid: txidOfHex(unsignedPsbtHex), unsignedPsbtHex })
            })(),
          ]),
          'earlierPayments[0]: payment input 0 outpoint',
        ],
        [
          'a version paying another recipient',
          withVersions([
            (() => {
              const elsewhere = pricedPlan({ recipientKey: '55'.repeat(32) }).steps[1]!
              return firstVersion({
                txid: elsewhere.txid,
                unsignedPsbtHex: elsewhere.unsignedPsbtHex,
              })
            })(),
          ]),
          'earlierPayments[0]: payment recipient output',
        ],
        [
          'a version stating another amount than it pays',
          withVersions([firstVersion({ amount: AMOUNT - 1_000, change: CHANGE + 1_000 })]),
          'earlierPayments[0]: payment recipient output',
        ],
        [
          'a version under another id than its transaction’s',
          withVersions([firstVersion({ txid: txid('dd') })]),
          'earlierPayments[0]: payment txid',
        ],
        [
          'a version paying more fee than its price',
          withVersions([firstVersion({ fee: PAYMENT_FEE + 1 })]),
          "earlierPayments[0].fee: not the wallet's pricing",
        ],
        [
          'a version without a mark',
          withVersions([{ ...firstVersion(), dispatch: undefined }]),
          'earlierPayments[0].dispatch',
        ],
        [
          'a version with an unknown key',
          withVersions([{ ...firstVersion(), note: 1 }]),
          'earlierPayments[0]: unknown key',
        ],
        [
          'a version that is the payment',
          withVersions([
            firstVersion({
              txid: raised().steps[1]!.txid,
              unsignedPsbtHex: raised().steps[1]!.unsignedPsbtHex,
            }),
          ]),
          'earlierPayments[0].txid: listed twice',
        ],
        [
          'a version listed twice',
          withVersions([firstVersion(), firstVersion()]),
          'earlierPayments[1].txid: listed twice',
        ],
        [
          'more versions than a plan keeps',
          withVersions(Array.from({ length: 17 }, () => firstVersion())),
          'earlierPayments: too many',
        ],
        ['earlier versions that are no list', withVersions({} as never), 'earlierPayments'],
        [
          'a mark on a merge',
          (() => {
            const record = raised()
            record.steps[0] = { ...record.steps[0]!, dispatch: 'unknown' }
            return record
          })(),
          'steps[0].dispatch: a merge records none',
        ],
        [
          'a mark the store does not know',
          (() => {
            const record = raised()
            record.steps[1] = { ...record.steps[1]!, dispatch: 'sent' as never }
            return record
          })(),
          'steps[1].dispatch',
        ],
      ]
      for (const [label, record, reason] of refused) {
        expect(validateQbitSendPlanRecord(record), label).toMatchObject({ valid: false, reason })
      }
    })

    it('keeps what paid the recipient for a completed plan only', () => {
      const paidBy = { txid: txid('7a'), amount: AMOUNT, fee: 400 }
      const completed = planRecord({
        phase: 'completed',
        steps: [mergeStep({ status: 'confirmed' }), paymentStep({ status: 'broadcast' })],
        paidBy,
      })
      expect(validateQbitSendPlanRecord(completed)).toEqual({ valid: true, record: completed })
      expect(validateQbitSendPlanRecord({ ...completed, phase: 'waiting' })).toMatchObject({
        valid: false,
      })
      expect(
        validateQbitSendPlanRecord({ ...completed, paidBy: { ...paidBy, txid: PAYMENT_TXID } })
      ).toMatchObject({ valid: false, reason: 'paidBy.txid: a version of the payment' })
      expect(
        validateQbitSendPlanRecord({ ...completed, paidBy: { ...paidBy, amount: null as never } })
      ).toMatchObject({ valid: false, reason: 'paidBy.amount' })
      expect(
        validateQbitSendPlanRecord({ ...completed, paidBy: { ...paidBy, note: 1 } as never })
      ).toMatchObject({ valid: false, reason: 'paidBy: unknown key' })
    })
  })

  describe('what cannot be read', () => {
    const unreadablePlan = {
      ...planRecord({
        id: OTHER_PLAN_ID,
        account: { address: otherAddress, pubkey: '6f'.repeat(32) },
      }),
      // A NaN some version wrote: JSON stored it as null.
      amount: null,
    }

    it('loads the readable plans and reports, without dropping, the others', async () => {
      const readable = planRecord()
      const elsewhere = planOn(ChainType.QBIT_TESTNET4, { id: 'c3'.repeat(16) })
      const opened = await openStore({
        version: 1,
        plans: [
          readable,
          unreadablePlan,
          42,
          { id: 'e5'.repeat(16), chain: 'QBIT_SIMNET' },
          elsewhere,
        ],
      })

      expect(opened.list()).toEqual([readable, elsewhere])
      expect(opened.unreadable()).toEqual({
        plans: [
          {
            index: 1,
            key: expect.any(String),
            id: OTHER_PLAN_ID,
            chain,
            address: otherAddress,
            reason: 'amount',
          },
          { index: 2, key: expect.any(String), reason: 'not an object' },
          { index: 3, key: expect.any(String), id: 'e5'.repeat(16), reason: 'chain' },
        ],
      })
      expect(new Set(opened.unreadable().plans.map(entry => entry.key)).size).toBe(3)
      expect(opened.findOpen(chain, otherAddress)).toBeUndefined()
      expect(opened.planHolds().map(hold => hold.planId)).toEqual([PLAN_ID, 'c3'.repeat(16)])
    })

    it('keeps an unreadable entry byte for byte through writes of other plans', async () => {
      const opened = await openStore({ version: 1, plans: [unreadablePlan, 7] })
      const before = JSON.stringify(unreadablePlan)
      expect(storage.raw()).toContain(before)

      const created = await opened.put(planRecord(), null)
      const updated = await opened.put({ ...created, phase: 'waiting' }, created.revision)

      expect(storage.raw()).toContain(before)
      expect(storage.document().plans).toEqual([unreadablePlan, 7, updated])
      await opened.delete(PLAN_ID, updated.revision)
      expect(storage.raw()).toBe(JSON.stringify({ version: 1, plans: [unreadablePlan, 7] }))

      const restarted = await openStore()
      expect(restarted.unreadable().plans).toEqual([
        {
          index: 0,
          key: expect.any(String),
          id: OTHER_PLAN_ID,
          chain,
          address: otherAddress,
          reason: 'amount',
        },
        { index: 1, key: expect.any(String), reason: 'not an object' },
      ])
    })

    it('reports positions as they are now, after earlier entries went', async () => {
      const opened = await openStore({ version: 1, plans: [planRecord(), 7] })
      const [entry] = opened.unreadable().plans
      expect(entry).toEqual({ index: 1, key: expect.any(String), reason: 'not an object' })
      await opened.delete(PLAN_ID, 1)
      // The same entry, under the same key, at its new position.
      expect(opened.unreadable().plans).toEqual([{ ...entry, index: 0 }])
    })

    it("blocks a new plan for an unreadable plan's account or id until the user discards it", async () => {
      const opened = await openStore({ version: 1, plans: [unreadablePlan, 7] })

      await storeError(
        opened.put(otherAccountPlan({ id: 'd4'.repeat(16) }), null),
        'account_has_open_plan'
      )
      await storeError(opened.put(planRecord({ id: OTHER_PLAN_ID }), null), 'already_exists')
      // Nor can it be changed or deleted as if it were readable.
      await storeError(opened.put(otherAccountPlan(), 1), 'not_found')
      await expect(opened.delete(OTHER_PLAN_ID, 1)).resolves.toBe(false)

      const [named, seven] = opened.unreadable().plans
      await expect(opened.discardUnreadable({ key: named!.key })).resolves.toEqual({
        dropped: 1,
        madeReadable: [],
      })
      expect(storage.document().plans).toEqual([7])
      await expect(opened.put(otherAccountPlan(), null)).resolves.toMatchObject({ revision: 1 })
      // A whole-document discard drops nothing from a document this version reads.
      await expect(opened.discardUnreadable({ document: true })).resolves.toEqual({
        dropped: 0,
        madeReadable: [],
      })
      await expect(opened.discardUnreadable({ key: seven!.key })).resolves.toEqual({
        dropped: 1,
        madeReadable: [],
      })
      await expect(opened.discardUnreadable({ key: seven!.key })).resolves.toEqual({
        dropped: 0,
        madeReadable: [],
      })
      expect(storage.document().plans).toEqual([opened.get(OTHER_PLAN_ID)])
    })

    it('drops only the entry its key names, one without a readable id included, whatever account it is filed under', async () => {
      const noId = { ...unreadablePlan, id: 'not a plan id' }
      const elsewhere = { ...unreadablePlan, id: 'e5'.repeat(16), chain: ChainType.QBIT_TESTNET4 }
      const opened = await openStore({ version: 1, plans: [noId, elsewhere, 7] })
      const entries = opened.unreadable().plans
      expect(entries.map(entry => entry.id)).toEqual([undefined, 'e5'.repeat(16), undefined])
      expect(entries[0]).toMatchObject({ chain, address: otherAddress })

      await expect(opened.discardUnreadable({ key: entries[0]!.key })).resolves.toEqual({
        dropped: 1,
        madeReadable: [],
      })
      expect(storage.document().plans).toEqual([elsewhere, 7])
      expect(opened.unreadable().plans.map(entry => entry.key)).toEqual([
        entries[1]!.key,
        entries[2]!.key,
      ])
      // A store loaded again names its entries afresh: an old key names nothing.
      const restarted = await openStore()
      await expect(restarted.discardUnreadable({ key: entries[1]!.key })).resolves.toEqual({
        dropped: 0,
        madeReadable: [],
      })
      expect(storage.document().plans).toEqual([elsewhere, 7])
    })

    it('reads neither of two entries for the same id or the same account', async () => {
      const opened = await openStore({
        version: 1,
        plans: [
          planRecord(),
          planRecord({ phase: 'waiting' }),
          otherAccountPlan(),
          otherAccountPlan({ id: 'c3'.repeat(16) }),
          planOn(ChainType.QBIT_TESTNET4, { id: 'e5'.repeat(16) }),
        ],
      })

      expect(opened.list().map(record => record.id)).toEqual(['e5'.repeat(16)])
      expect(opened.unreadable().plans.map(entry => [entry.index, entry.reason])).toEqual([
        [0, 'another entry has the same id'],
        [1, 'another entry has the same id'],
        [2, 'another entry is for the same account'],
        [3, 'another entry is for the same account'],
      ])
      // Written back as they were, whatever is written next.
      const raw = storage.raw()!
      await opened.put(planOn(ChainType.QBIT_MAINNET, { id: 'f6'.repeat(16) }), null)
      expect(storage.raw()!.startsWith(raw.slice(0, -2))).toBe(true)
    })

    it.each([
      ['another version', { version: 2, plans: [planRecord()] }, 'unsupported version'],
      ['no version', { plans: [planRecord()] }, 'unsupported version'],
      ['a version as text', { version: '1', plans: [planRecord()] }, 'unsupported version'],
      [
        'plans that are no list',
        { version: 1, plans: { [PLAN_ID]: planRecord() } },
        'plans is not a list',
      ],
      ['an unknown document key', { version: 1, plans: [], index: {} }, 'unknown key'],
      ['no document at all', 'qbitSendPlans', 'not an object'],
    ])(
      'reads nothing from a document of %s, and never writes over it',
      async (_label, document, reason) => {
        const opened = await openStore(document)
        const raw = storage.raw()

        expect(opened.list()).toEqual([])
        expect(opened.planHolds()).toEqual([])
        expect(opened.unreadable()).toEqual({ document: { reason }, plans: [] })
        await storeError(opened.put(planRecord(), null), 'unreadable_document')
        await storeError(opened.put(planRecord(), 1), 'unreadable_document')
        await storeError(opened.delete(PLAN_ID, 1), 'unreadable_document')
        await expect(opened.discardUnreadable({ key: 'unreadable-1' })).resolves.toEqual({
          dropped: 0,
          madeReadable: [],
        })
        expect(storage.raw()).toBe(raw)
        expect(storage.sets).toBe(0)

        // Only the user's explicit discard replaces it.
        await expect(opened.discardUnreadable({ document: true })).resolves.toEqual({
          dropped: 1,
          madeReadable: [],
        })
        expect(storage.document()).toEqual({ version: 1, plans: [] })
        expect(opened.unreadable()).toEqual({ plans: [] })
        await expect(opened.put(planRecord(), null)).resolves.toMatchObject({ revision: 1 })
      }
    )
  })

  describe('what a discard leaves', () => {
    const COPY_ID = 'c3'.repeat(16)
    const THIRD_ID = 'd4'.repeat(16)

    /** Everything `opened` reads, but the keys it names unreadable entries by. */
    function reading(opened: QbitSendPlanStore) {
      const { document, plans } = opened.unreadable()
      return {
        list: opened.list(),
        holds: opened.planHolds(),
        document,
        unreadable: plans.map(({ key: _key, ...entry }) => entry),
      }
    }

    /** `opened` reads what a store reads that loads the stored document now. */
    async function expectReadsAsLoaded(opened: QbitSendPlanStore): Promise<void> {
      expect(reading(opened)).toEqual(reading(await openStore()))
    }

    it('reads the plan left once the other entry for its account is discarded, as a load of the document reads it', async () => {
      const left = planRecord({ phase: 'waiting' })
      const opened = await openStore({ version: 1, plans: [planRecord({ id: COPY_ID }), left] })
      const [shown, other] = opened.unreadable().plans
      expect([shown, other].map(entry => [entry!.id, entry!.reason])).toEqual([
        [COPY_ID, 'another entry is for the same account'],
        [PLAN_ID, 'another entry is for the same account'],
      ])
      expect(opened.list()).toEqual([])

      const outcome = await opened.discardUnreadable({ key: shown!.key })

      expect(storage.document().plans).toEqual([left])
      expect(opened.get(PLAN_ID)).toEqual(left)
      expect(opened.list()).toEqual([left])
      expect(opened.findOpen(chain, address)).toEqual(left)
      expect(opened.planHolds()).toEqual([
        { planId: PLAN_ID, chain, address, outpoints: expect.any(Array) },
      ])
      expect(opened.unreadable()).toEqual({ plans: [] })
      await expectReadsAsLoaded(opened)
      expect(outcome).toEqual({ dropped: 1, madeReadable: [left] })
      // A plan like any other: changed under the revision it was read at.
      await expect(opened.put({ ...left, phase: 'sending' }, left.revision)).resolves.toMatchObject(
        { phase: 'sending', revision: left.revision + 1 }
      )
    })

    it('reads the entry left of two of the same plan id once the other is discarded', async () => {
      const left = planRecord({ phase: 'waiting' })
      const opened = await openStore({ version: 1, plans: [planRecord(), left] })
      const [shown] = opened.unreadable().plans
      expect(shown).toMatchObject({ index: 0, reason: 'another entry has the same id' })

      const outcome = await opened.discardUnreadable({ key: shown!.key })

      expect(opened.get(PLAN_ID)).toEqual(left)
      expect(opened.unreadable()).toEqual({ plans: [] })
      await expectReadsAsLoaded(opened)
      expect(outcome).toEqual({ dropped: 1, madeReadable: [left] })
    })

    it('keeps two entries still in conflict unreadable, under the keys they had, until one of them goes too', async () => {
      const left = planRecord()
      const opened = await openStore({
        version: 1,
        plans: [planRecord({ id: COPY_ID }), planRecord({ id: THIRD_ID }), left],
      })
      const [first, second, third] = opened.unreadable().plans

      const firstOutcome = await opened.discardUnreadable({ key: first!.key })
      expect(opened.list()).toEqual([])
      expect(opened.planHolds()).toEqual([])
      expect(opened.unreadable().plans).toEqual([
        { ...second, index: 0 },
        { ...third, index: 1 },
      ])
      await expectReadsAsLoaded(opened)

      const secondOutcome = await opened.discardUnreadable({ key: second!.key })
      expect(opened.list()).toEqual([left])
      expect(opened.unreadable()).toEqual({ plans: [] })
      await expectReadsAsLoaded(opened)
      expect(firstOutcome).toEqual({ dropped: 1, madeReadable: [] })
      expect(secondOutcome).toEqual({ dropped: 1, madeReadable: [left] })
    })

    it('reads the other account’s entry of the same id once the first account’s is discarded, which alone goes', async () => {
      const theirs = otherAccountPlan({ id: PLAN_ID })
      const opened = await openStore({ version: 1, plans: [planRecord(), theirs] })
      const [mine, other] = opened.unreadable().plans
      expect([mine!.address, other!.address]).toEqual([address, otherAddress])

      const outcome = await opened.discardUnreadable({ key: mine!.key })

      expect(storage.document().plans).toEqual([theirs])
      expect(opened.findOpen(chain, otherAddress)).toEqual(theirs)
      expect(opened.findOpen(chain, address)).toBeUndefined()
      expect(opened.unreadable()).toEqual({ plans: [] })
      await expectReadsAsLoaded(opened)
      expect(outcome).toEqual({ dropped: 1, madeReadable: [theirs] })
    })

    it('keeps the entry left unreadable, for its own reason and under its key, when it fails its own checks', async () => {
      const damaged = { ...planRecord({ id: COPY_ID }), amount: null }
      const opened = await openStore({ version: 1, plans: [planRecord(), damaged] })
      const [shown, left] = opened.unreadable().plans
      expect(shown).toMatchObject({ id: PLAN_ID, reason: 'another entry is for the same account' })
      expect(left).toMatchObject({ id: COPY_ID, address, reason: 'amount' })

      const outcome = await opened.discardUnreadable({ key: shown!.key })

      expect(opened.list()).toEqual([])
      expect(opened.planHolds()).toEqual([])
      expect(opened.unreadable().plans).toEqual([{ ...left, index: 0 }])
      expect(storage.document().plans).toEqual([damaged])
      await expectReadsAsLoaded(opened)
      expect(outcome).toEqual({ dropped: 1, madeReadable: [] })
      // Its account can still discard it.
      await expect(opened.discardUnreadable({ key: left!.key })).resolves.toEqual({
        dropped: 1,
        madeReadable: [],
      })
      expect(storage.document().plans).toEqual([])
    })

    it('writes nothing and makes nothing readable when the key names no entry', async () => {
      const opened = await openStore({
        version: 1,
        plans: [planRecord({ id: COPY_ID }), planRecord()],
      })
      const before = opened.unreadable()
      const sets = storage.sets

      await expect(opened.discardUnreadable({ key: 'unreadable-0' })).resolves.toEqual({
        dropped: 0,
        madeReadable: [],
      })
      expect(storage.sets).toBe(sets)
      expect(opened.unreadable()).toEqual(before)
      expect(opened.list()).toEqual([])
    })

    it('reads as before, both entries unreadable under their keys, when the write fails', async () => {
      const opened = await openStore({
        version: 1,
        plans: [planRecord({ id: COPY_ID }), planRecord()],
      })
      const before = opened.unreadable()
      const raw = storage.raw()
      const failure = new Error('storage unavailable')
      storage.failNextSet = { error: failure, afterWriting: false }

      await expect(opened.discardUnreadable({ key: before.plans[0]!.key })).rejects.toBe(failure)

      expect(storage.raw()).toBe(raw)
      expect(opened.unreadable()).toEqual(before)
      expect(opened.list()).toEqual([])
      expect(opened.planHolds()).toEqual([])
    })

    it('reads, after every write, what a load of the document written reads', async () => {
      const opened = await openStore({
        version: 1,
        plans: [
          planRecord({ id: COPY_ID }),
          planRecord(),
          7,
          otherAccountPlan({ id: THIRD_ID }),
          { ...planOn(ChainType.QBIT_TESTNET4, { id: 'e5'.repeat(16) }), amount: null },
        ],
      })
      await expectReadsAsLoaded(opened)
      const keys = opened.unreadable().plans.map(entry => entry.key)

      const created = await opened.put(
        planOn(ChainType.QBIT_MAINNET, { id: 'f6'.repeat(16) }),
        null
      )
      await expectReadsAsLoaded(opened)
      await opened.put({ ...created, phase: 'waiting' }, created.revision)
      await expectReadsAsLoaded(opened)
      await opened.delete(THIRD_ID, 1)
      await expectReadsAsLoaded(opened)
      // Entries that stay unreadable keep their keys through every write.
      expect(opened.unreadable().plans.map(entry => entry.key)).toEqual(keys)

      await opened.discardUnreadable({ key: keys[0]! })
      await expectReadsAsLoaded(opened)
      expect(opened.unreadable().plans.map(entry => entry.key)).toEqual(keys.slice(2))
      await opened.discardUnreadable({ key: keys[2]! })
      await expectReadsAsLoaded(opened)
      await opened.resetAllData()
      await expectReadsAsLoaded(opened)
    })
  })

  describe('holds the stored plans imply', () => {
    it("lists every step's inputs and every merge's output 0, once each", async () => {
      await store.put(planRecord(), null)
      const other = otherAccountPlan()
      await store.put(other, null)

      expect(store.planHolds()).toEqual([
        {
          planId: PLAN_ID,
          chain,
          address,
          outpoints: [
            { txid: txid('01'), vout: 0 },
            { txid: txid('02'), vout: 1 },
            { txid: txid('03'), vout: 0 },
            { txid: MERGE_TXID, vout: 0 },
            { txid: txid('04'), vout: 0 },
          ],
        },
        {
          planId: OTHER_PLAN_ID,
          chain,
          address: otherAddress,
          outpoints: [
            { txid: txid('01'), vout: 0 },
            { txid: txid('02'), vout: 1 },
            { txid: txid('03'), vout: 0 },
            { txid: other.steps[0]!.txid, vout: 0 },
            { txid: txid('04'), vout: 0 },
          ],
        },
      ])
    })
  })

  describe('lifetime', () => {
    it('answers nothing before init, and nothing after a read that failed', async () => {
      const fresh = new QbitSendPlanStore()
      expect(() => fresh.list()).toThrow(QbitSendPlanStoreError)
      await storeError(fresh.put(planRecord(), null), 'not_initialized')
      await storeError(fresh.resetAllData(), 'not_initialized')

      const failure = new Error('storage unavailable')
      storage.failGet = failure
      await expect(fresh.init({ storage })).rejects.toBe(failure)
      expect(() => fresh.unreadable()).toThrow('not initialized')
      await storeError(fresh.delete(PLAN_ID, 1), 'not_initialized')
      await storeError(fresh.discardUnreadable({ document: true }), 'not_initialized')

      storage.failGet = undefined
      await fresh.init({ storage })
      expect(fresh.list()).toEqual([])
    })

    it('erases every plan, readable or not, when the wallet is reset', async () => {
      const opened = await openStore({ version: 1, plans: [planRecord(), 7] })
      await opened.resetAllData()
      expect(opened.list()).toEqual([])
      expect(opened.unreadable()).toEqual({ plans: [] })
      expect(storage.document()).toEqual({ version: 1, plans: [] })

      const otherVersion = await openStore({ version: 2, plans: [] })
      await otherVersion.resetAllData()
      expect(storage.document()).toEqual({ version: 1, plans: [] })
    })
  })

  describe('logging', () => {
    const spies: ReturnType<typeof vi.spyOn>[] = []

    beforeEach(() => {
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        spies.push(vi.spyOn(console, method).mockImplementation(() => undefined))
      }
    })

    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore()
    })

    it('logs nothing, whatever it reads or refuses', async () => {
      const opened = await openStore({ version: 1, plans: [planRecord(), { amount: null }, 'x'] })
      await opened.put({ ...opened.get(PLAN_ID)!, phase: 'waiting' }, 1).catch(() => undefined)
      await opened.put(planRecord({ amount: Number.NaN }), null).catch(() => undefined)
      storage.failNextSet = { error: new Error('write failed'), afterWriting: false }
      await opened.put(otherAccountPlan(), null).catch(() => undefined)
      await openStore({ version: 3, plans: [] })

      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
  })
})
