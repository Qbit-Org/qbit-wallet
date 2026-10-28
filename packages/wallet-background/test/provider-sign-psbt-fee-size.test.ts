import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_WITNESS_UTXO,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtLeafScriptField,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  type Psbt,
} from '@qbit-oss/protocol'
import { KeyringType, RiskType } from '@qbit/wallet-shared'
import type { DecodedPsbt, ToSignData } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import rpcFlow from '../src/controllers/provider/rpcFlow'
import wallet from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { qbitFeeSummaryFromTiers } from '../src/utils/qbit-api'

// The real provider flow, provider controller, wallet controller and send
// guard: a website's signPsbt, the approval window reviewing it with
// decodePsbt and signing it through signPsbtV2. Only the approval window, the
// keyring signer, signature verification and the fee quote are stubbed. The
// approval's fee rate is compared with the transaction the signed PSBT
// finalizes to (#59).
const approvalServiceMock = vi.hoisted(() => ({ requestApproval: vi.fn(), unLock: vi.fn() }))

vi.mock('@qbit-oss/pqc', async importOriginal => ({
  ...(await importOriginal<typeof import('@qbit-oss/pqc')>()),
  verify: vi.fn(() => true),
}))
vi.mock('src/services/approval', () => ({ default: approvalServiceMock }))
vi.mock('src/utils/eventBus', () => ({ bgEventBus: { emit: vi.fn() } }))
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      hasVault: vi.fn(() => true),
      memStore: { getState: vi.fn(() => ({ isUnlocked: true })) },
      getQbitRecoveryState: vi.fn(async () => undefined),
      preflightP2mrPsbtSigning: vi.fn(),
      signP2mrPsbtWithCounter: vi.fn(),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
    },
    permissionService: {
      hasPermission: vi.fn(() => true),
      touchConnectedSite: vi.fn(),
      updateConnectSite: vi.fn(),
    },
    qbitSendGuardService: guard,
    walletApiService: { transactionCore: { pushTx: vi.fn(), decodePsbt: vi.fn() } },
    sessionService: {},
    contactBookService: {},
    notificationService: {},
  }
})

const ORIGIN = 'https://dapp.example'
const PUBKEY_HEX = '11'.repeat(32)
const LEAF_SCRIPT = singleKeyLeafScript(hexToBytes(PUBKEY_HEX))
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
/** Another party's single-key leaf. */
const OTHER_PUBKEY = hexToBytes('33'.repeat(32))
const OTHER_LEAF_SCRIPT = singleKeyLeafScript(OTHER_PUBKEY)
const OTHER_LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, OTHER_LEAF_SCRIPT)
/** A leaf far larger than a single-key one, which nothing here signs. */
const LARGE_SCRIPT = new Uint8Array(30_000).fill(0x51)
const LARGE_LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LARGE_SCRIPT)

const SINGLE_LEAF = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
/** The deepest control block a P2MR leaf can have, committing to nothing. */
const DEEP_NON_COMMITTING = buildControlBlock(
  P2MR_LEAF_VERSION_V1,
  Array.from({ length: 128 }, () => hexToBytes('5a'.repeat(32)))
)
/** A control block of one level that commits to nothing. */
const NON_COMMITTING = buildControlBlock(P2MR_LEAF_VERSION_V1, [hexToBytes('5b'.repeat(32))])
/** `(leaf, large)`, an output both leaves commit to. */
const WITH_LARGE_ROOT = p2mrBranchHash(LEAF_HASH, LARGE_LEAF_HASH)
const OTHER_WITH_LARGE_ROOT = p2mrBranchHash(OTHER_LEAF_HASH, LARGE_LEAF_HASH)

/**
 * An output whose tree holds the account's leaf twice, one level down and
 * 121 levels down, and the control blocks of both positions.
 */
const DEEP_PATH = Array.from({ length: 120 }, (_, index) =>
  hexToBytes((index + 1).toString(16).padStart(2, '0').repeat(32))
)
const DEEP_NODE = DEEP_PATH.reduce((node, sibling) => p2mrBranchHash(node, sibling), LEAF_HASH)
const TWO_DEPTH_ROOT = p2mrBranchHash(DEEP_NODE, LEAF_HASH)
const TWO_DEPTH_DEEP = buildControlBlock(P2MR_LEAF_VERSION_V1, [...DEEP_PATH, LEAF_HASH])
const TWO_DEPTH_SHALLOW = buildControlBlock(P2MR_LEAF_VERSION_V1, [DEEP_NODE])

const RECIPIENT_SCRIPT = p2mrScriptPubKey(hexToBytes('77'.repeat(32)))
const ACCOUNT_SCRIPT = p2mrScriptPubKey(LEAF_HASH)
const INPUT_VALUE = 10_000_000n
const AMOUNT = 100_000n
/** 150 bits/vB of the 3,860 vB a one-input, two-output single-key spend finalizes to. */
const FEE = 579_000n
/** 150 bits/vB of the 7,622 vB of the same spend with two inputs. */
const TWO_INPUT_FEE = 1_143_300n

const account = {
  type: KeyringType.QbitHdKeyring,
  address: p2mrAddressFromPubkey(hexToBytes(PUBKEY_HEX), 'regtest'),
  pubkey: PUBKEY_HEX,
  key: 'account-0',
  flag: 0,
  index: 0,
  p2mr: {
    pubkey: PUBKEY_HEX,
    leafScript: bytesToHex(LEAF_SCRIPT),
    scriptPubKey: bytesToHex(ACCOUNT_SCRIPT),
    signatureCounter: { count: 0, limit: 30, remaining: 30, state: 'normal' },
  },
}

interface LeafRecord {
  controlBlock: Uint8Array
  script?: Uint8Array
}

interface InputSpec {
  /** The program of the spent output. */
  root: Uint8Array
  /** The input's `0x1d` leaf records, in this order. */
  records?: LeafRecord[]
  /** A final scriptwitness, which replaces the records. */
  finalWitness?: Uint8Array
  /** Leaves out the witness UTXO. */
  noWitnessUtxo?: boolean
}

/** A record of the account's leaf, by default in its own single-leaf output. */
function accountRecord(controlBlock: Uint8Array = SINGLE_LEAF): LeafRecord {
  return { controlBlock, script: LEAF_SCRIPT }
}

function otherRecord(controlBlock: Uint8Array = SINGLE_LEAF): LeafRecord {
  return { controlBlock, script: OTHER_LEAF_SCRIPT }
}

/** A larger record, of another leaf, that the website lists first. */
const LARGE_NON_COMMITTING: LeafRecord = { controlBlock: DEEP_NON_COMMITTING, script: LARGE_SCRIPT }

function compactSize(value: number): number[] {
  return value < 0xfd ? [value] : [0xfd, value & 0xff, value >> 8]
}

/** A serialized witness stack. */
function witnessStack(items: Uint8Array[]): Uint8Array {
  return Uint8Array.from([
    ...compactSize(items.length),
    ...items.flatMap(item => [...compactSize(item.length), ...item]),
  ])
}

/** The witness a single-key spend through `script` finalizes to. */
function singleKeyWitness(script: Uint8Array, controlBlock: Uint8Array): Uint8Array {
  return witnessStack([new Uint8Array(PQC_SIGNATURE_BYTES).fill(9), script, controlBlock])
}

/**
 * A website PSBT spending one output of `INPUT_VALUE` per input, paying
 * `AMOUNT` to a stranger and the rest, less `FEE`, back to the account.
 */
function websitePsbt(inputs: InputSpec[], fee: bigint = FEE): Psbt {
  const psbt = createP2mrPsbt({
    inputs: inputs.map((input, index) => ({
      prevout: { txid: hexToBytes((0x90 + index).toString(16).repeat(32)), vout: 0 },
      witnessUtxo: { value: INPUT_VALUE, scriptPubKey: p2mrScriptPubKey(input.root) },
      leafScript: LEAF_SCRIPT,
      controlBlock: SINGLE_LEAF,
    })),
    outputs: [
      { value: AMOUNT, scriptPubKey: RECIPIENT_SCRIPT },
      {
        value: INPUT_VALUE * BigInt(inputs.length) - AMOUNT - fee,
        scriptPubKey: ACCOUNT_SCRIPT,
      },
    ],
  })
  inputs.forEach((spec, index) => {
    const map = psbt.inputs[index]!.filter(
      entry =>
        entry.key[0] !== PSBT_IN_P2MR_LEAF_SCRIPT &&
        !(spec.noWitnessUtxo && entry.key[0] === PSBT_IN_WITNESS_UTXO)
    )
    if (spec.finalWitness) {
      map.push({ key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value: spec.finalWitness })
    }
    for (const record of spec.records ?? []) {
      const field = encodeP2mrPsbtLeafScriptField(record.controlBlock, record.script ?? LEAF_SCRIPT)
      map.push({ key: field.key, value: field.value })
    }
    psbt.inputs[index] = map
  })
  return psbt
}

function signPsbtRequest(psbtHex: string) {
  return {
    data: {
      method: 'signPsbt',
      params: { psbtHex, options: { chain: ChainType.QBIT_REGTEST } },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  }
}

let reviews: DecodedPsbt[] = []

/**
 * Run a website's signPsbt through approval, as the approval window reviews
 * and signs it, and return what the approval showed and the signed PSBT.
 */
async function approveWebsitePsbt(psbt: Psbt): Promise<{ review: DecodedPsbt; signed: Psbt }> {
  await qbitSendGuardService.resetAllData()
  reviews = []
  const signedPsbtHex = await rpcFlow(signPsbtRequest(bytesToHex(serializePsbt(psbt))))
  expect(reviews).toHaveLength(1)
  return { review: reviews[0]!, signed: parsePsbt(hexToBytes(signedPsbtHex)) }
}

/** Finalized size of a signed PSBT, once each other party has signed with `keys`. */
function finalizedVsize(
  signed: Psbt,
  keys: { inputIndex: number; pubkey: Uint8Array; leafHash: Uint8Array }[] = []
): number {
  const complete =
    keys.length > 0
      ? signP2mrPsbt({ psbt: signed, keys, sign: () => new Uint8Array(PQC_SIGNATURE_BYTES) }).psbt
      : signed
  return extractP2mrTransaction(finalizeP2mrPsbt(complete)).length
}

/** Finalized size of a finalized PSBT once input 0 reveals the account leaf with `controlBlock`. */
function vsizeWithControlBlock(finalized: Psbt, controlBlock: Uint8Array): number {
  const rebuilt = parsePsbt(serializePsbt(finalized))
  rebuilt.inputs[0] = rebuilt.inputs[0]!.map(entry =>
    entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS
      ? { key: entry.key, value: singleKeyWitness(LEAF_SCRIPT, controlBlock) }
      : entry
  )
  return extractP2mrTransaction(rebuilt).length
}

/** What the approval window decides from a review: whether it must confirm a risk. */
function confirmation(review: DecodedPsbt) {
  return {
    feeRate: review.feeRate,
    risks: review.risks.map(risk => [risk.type, risk.level]),
    reasons: review.spendSummary?.feeAssessment?.reasons,
    shouldWarnFeeRate: review.shouldWarnFeeRate,
  }
}

const OTHER_PARTY_KEY = { pubkey: OTHER_PUBKEY, leafHash: OTHER_LEAF_HASH }

describe('the fee rate a website PSBT approval shows (#59)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    reviews = []
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.spyOn(wallet, 'getAccounts').mockResolvedValue([account] as any)
    // The fastest tier recommends 9 bits/vB.
    vi.spyOn(wallet, 'getFeeSummary').mockImplementation(async () =>
      qbitFeeSummaryFromTiers(
        [
          { target: 20, feeRate: 1 },
          { target: 6, feeRate: 3 },
          { target: 2, feeRate: 9 },
        ],
        'esplora',
        { freshness: 'live', fetchedAt: Date.now() }
      )
    )
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue({
      required: 1,
      cached: 0,
      remainingBefore: 30,
      remainingAfter: 29,
      limit: 30,
    } as any)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address, { psbt, keys }) => {
        const signed = signP2mrPsbt({
          psbt,
          keys,
          sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
        })
        return { ...signed, counterResults: [] } as any
      }
    )
    // The approval window reviews the PSBT it was handed, then the user signs.
    approvalServiceMock.requestApproval.mockImplementation(async approval => {
      const toSignData: ToSignData = structuredClone(approval.params.data.toSignDatas[0])
      reviews.push(await wallet.decodePsbt(toSignData.psbtHex, ORIGIN))
      return [await wallet.signPsbtV2(toSignData)]
    })
  })

  it('sizes the fee rate from the signed leaf when a larger record of another leaf is listed first', async () => {
    const honest = await approveWebsitePsbt(
      websitePsbt([{ root: LEAF_HASH, records: [accountRecord()] }])
    )
    const listed = await approveWebsitePsbt(
      websitePsbt([{ root: LEAF_HASH, records: [LARGE_NON_COMMITTING, accountRecord()] }])
    )

    // The approval's rate is the one the finalized transaction pays.
    expect(decodePsbt(listed.signed).inputs[0]!.finalized).toBe(true)
    const vsize = finalizedVsize(listed.signed)
    expect(finalizedVsize(honest.signed)).toBe(vsize)
    expect(listed.review.fee).toBe(Number(FEE))
    expect(listed.review.feeRate).toBe(Number(FEE) / vsize)
    // The same risk, and so the same confirmation, as without the record.
    expect(confirmation(listed.review)).toEqual(confirmation(honest.review))
    expect(confirmation(listed.review)).toMatchObject({
      risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
      reasons: ['above_recommended_rate', 'above_relay_floor', 'large_share_of_amount'],
      shouldWarnFeeRate: true,
    })
  })

  it('sizes every input of the account as signed when the first lists a larger record', async () => {
    const honest = await approveWebsitePsbt(
      websitePsbt([
        { root: LEAF_HASH, records: [accountRecord()] },
        { root: LEAF_HASH, records: [accountRecord()] },
      ])
    )
    const listed = await approveWebsitePsbt(
      websitePsbt([
        { root: LEAF_HASH, records: [LARGE_NON_COMMITTING, accountRecord()] },
        { root: LEAF_HASH, records: [accountRecord()] },
      ])
    )

    expect(listed.review.feeRate).toBe(Number(FEE) / finalizedVsize(listed.signed))
    expect(confirmation(listed.review)).toEqual(confirmation(honest.review))
    expect(listed.review.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
  })

  // An output whose tree holds the account's leaf is not the account's
  // address, so only its rate is judged.
  describe('spending an output the website built around the account leaf', () => {
    it('sizes the account leaf listed at the deeper of two positions as at the shallower', async () => {
      const deep = await approveWebsitePsbt(
        websitePsbt([{ root: TWO_DEPTH_ROOT, records: [accountRecord(TWO_DEPTH_DEEP)] }])
      )
      const shallow = await approveWebsitePsbt(
        websitePsbt([{ root: TWO_DEPTH_ROOT, records: [accountRecord(TWO_DEPTH_SHALLOW)] }])
      )

      expect(confirmation(deep.review)).toEqual(confirmation(shallow.review))
      expect(confirmation(deep.review)).toMatchObject({
        risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
        reasons: ['above_recommended_rate', 'above_relay_floor'],
      })
      // The signature also spends the output through the shallower position,
      // which the approval's rate does not understate.
      const asSigned = finalizedVsize(deep.signed)
      const throughShallower = vsizeWithControlBlock(deep.signed, TWO_DEPTH_SHALLOW)
      expect(throughShallower).toBeLessThan(asSigned)
      expect(deep.review.feeRate).toBeGreaterThanOrEqual(Number(FEE) / throughShallower)
    })

    it('shows the rate of an account leaf deeper in the tree no lower than it pays', async () => {
      const inTree = accountRecord(buildControlBlock(P2MR_LEAF_VERSION_V1, [LARGE_LEAF_HASH]))
      const largeLeaf: LeafRecord = {
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [LEAF_HASH]),
        script: LARGE_SCRIPT,
      }
      const honest = await approveWebsitePsbt(
        websitePsbt([{ root: WITH_LARGE_ROOT, records: [inTree] }])
      )
      const listed = await approveWebsitePsbt(
        websitePsbt([{ root: WITH_LARGE_ROOT, records: [largeLeaf, inTree] }])
      )

      // Sized as a zero-depth leaf: one tree level, 32 bytes, smaller.
      const paid = Number(FEE) / finalizedVsize(honest.signed)
      expect(finalizedVsize(listed.signed)).toBe(finalizedVsize(honest.signed))
      expect(honest.review.feeRate).toBe(Number(FEE) / 3_860)
      expect(honest.review.feeRate).toBeGreaterThan(paid)
      expect(Number.isFinite(honest.review.feeRate)).toBe(true)
      expect(confirmation(listed.review)).toEqual(confirmation(honest.review))
      expect(honest.review.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
    })
  })

  describe('with another party input the website signs after the wallet', () => {
    it.each([
      ["the account's input", 0],
      ["the other party's input", 1],
    ])(
      'sizes the fee rate from what finalizes when %s lists a larger record first',
      async (_where, listedOn) => {
        const inputs = (extra: boolean): InputSpec[] =>
          [accountRecord(), otherRecord()].map((record, index) => ({
            root: index === 0 ? LEAF_HASH : OTHER_LEAF_HASH,
            records: extra && index === listedOn ? [LARGE_NON_COMMITTING, record] : [record],
          }))
        const honest = await approveWebsitePsbt(websitePsbt(inputs(false), TWO_INPUT_FEE))
        const listed = await approveWebsitePsbt(websitePsbt(inputs(true), TWO_INPUT_FEE))

        // The wallet signs its own input and leaves the PSBT for the other signer.
        expect(decodePsbt(listed.signed).inputs.map(input => input.finalized)).toEqual([
          false,
          false,
        ])
        const vsize = finalizedVsize(listed.signed, [{ inputIndex: 1, ...OTHER_PARTY_KEY }])
        expect(listed.review.feeRate).toBe(Number(TWO_INPUT_FEE) / vsize)
        expect(confirmation(listed.review)).toEqual(confirmation(honest.review))
        // With another party's inputs only the rate is judged.
        expect(confirmation(listed.review)).toMatchObject({
          risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
          reasons: ['above_recommended_rate', 'above_relay_floor'],
        })
      }
    )

    it('never sizes it larger than a single-key spend when it lists only a large leaf', async () => {
      // The other party's output also has its single-key leaf, which the
      // website does not list and can still spend it through.
      const otherLeafInTree = otherRecord(
        buildControlBlock(P2MR_LEAF_VERSION_V1, [LARGE_LEAF_HASH])
      )
      const largeOnly: LeafRecord = {
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [OTHER_LEAF_HASH]),
        script: LARGE_SCRIPT,
      }
      const listed = await approveWebsitePsbt(
        websitePsbt(
          [
            { root: OTHER_WITH_LARGE_ROOT, records: [largeOnly] },
            { root: LEAF_HASH, records: [accountRecord()] },
          ],
          TWO_INPUT_FEE
        )
      )
      const singleKey = await approveWebsitePsbt(
        websitePsbt(
          [
            { root: OTHER_LEAF_HASH, records: [otherRecord()] },
            { root: LEAF_HASH, records: [accountRecord()] },
          ],
          TWO_INPUT_FEE
        )
      )

      expect(listed.review.feeRate).toBe(singleKey.review.feeRate)
      expect(confirmation(listed.review)).toEqual(confirmation(singleKey.review))
      expect(listed.review.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
      // At least the rate of the spend through the unlisted leaf.
      const viaUnlisted = parsePsbt(serializePsbt(listed.signed))
      const field = encodeP2mrPsbtLeafScriptField(otherLeafInTree.controlBlock, OTHER_LEAF_SCRIPT)
      viaUnlisted.inputs[0] = [...viaUnlisted.inputs[0]!, { key: field.key, value: field.value }]
      const vsize = finalizedVsize(viaUnlisted, [{ inputIndex: 0, ...OTHER_PARTY_KEY }])
      expect(listed.review.feeRate).toBeGreaterThanOrEqual(Number(TWO_INPUT_FEE) / vsize)
    })
  })

  describe('with another party input the website already finalized', () => {
    it('sizes it from its final witness', async () => {
      const listed = await approveWebsitePsbt(
        websitePsbt(
          [
            { root: LEAF_HASH, records: [LARGE_NON_COMMITTING, accountRecord()] },
            {
              root: OTHER_LEAF_HASH,
              finalWitness: singleKeyWitness(OTHER_LEAF_SCRIPT, SINGLE_LEAF),
            },
          ],
          TWO_INPUT_FEE
        )
      )

      expect(decodePsbt(listed.signed).inputs.every(input => input.finalized)).toBe(true)
      expect(listed.review.feeRate).toBe(Number(TWO_INPUT_FEE) / finalizedVsize(listed.signed))
      expect(listed.review.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
    })

    it('sizes it from a final witness smaller than a single-key spend', async () => {
      // A leaf that needs no signature, revealed with a zero-depth control block.
      const script = Uint8Array.of(0x51)
      const listed = await approveWebsitePsbt(
        websitePsbt([
          { root: LEAF_HASH, records: [LARGE_NON_COMMITTING, accountRecord()] },
          {
            root: p2mrLeafHash(P2MR_LEAF_VERSION_V1, script),
            finalWitness: witnessStack([script, SINGLE_LEAF]),
          },
        ])
      )

      expect(decodePsbt(listed.signed).inputs.every(input => input.finalized)).toBe(true)
      expect(listed.review.feeRate).toBe(Number(FEE) / finalizedVsize(listed.signed))
    })

    it('never sizes it larger than a single-key spend, which can replace its witness', async () => {
      const large = await approveWebsitePsbt(
        websitePsbt(
          [
            { root: LEAF_HASH, records: [accountRecord()] },
            {
              root: OTHER_WITH_LARGE_ROOT,
              finalWitness: singleKeyWitness(
                LARGE_SCRIPT,
                buildControlBlock(P2MR_LEAF_VERSION_V1, [OTHER_LEAF_HASH])
              ),
            },
          ],
          TWO_INPUT_FEE
        )
      )
      const singleKey = await approveWebsitePsbt(
        websitePsbt(
          [
            { root: LEAF_HASH, records: [accountRecord()] },
            {
              root: OTHER_LEAF_HASH,
              finalWitness: singleKeyWitness(OTHER_LEAF_SCRIPT, SINGLE_LEAF),
            },
          ],
          TWO_INPUT_FEE
        )
      )

      expect(large.review.feeRate).toBe(singleKey.review.feeRate)
      expect(confirmation(large.review)).toEqual(confirmation(singleKey.review))
      expect(large.review.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
    })

    it('sizes it from its final witness while a third input is still unsigned', async () => {
      const listed = await approveWebsitePsbt(
        websitePsbt([
          { root: LEAF_HASH, records: [LARGE_NON_COMMITTING, accountRecord()] },
          { root: OTHER_LEAF_HASH, finalWitness: singleKeyWitness(OTHER_LEAF_SCRIPT, SINGLE_LEAF) },
          { root: OTHER_LEAF_HASH, records: [otherRecord()] },
        ])
      )

      const vsize = finalizedVsize(listed.signed, [{ inputIndex: 2, ...OTHER_PARTY_KEY }])
      expect(listed.review.feeRate).toBe(Number(FEE) / vsize)
    })
  })

  describe('decoded directly, without the provider checks', () => {
    async function review(inputs: InputSpec[]): Promise<DecodedPsbt> {
      return wallet.decodePsbt(bytesToHex(serializePsbt(websitePsbt(inputs))), ORIGIN)
    }

    it('sizes a PSBT with no leaf records as a single-key spend', async () => {
      const none = await review([{ root: LEAF_HASH }])
      const signedFor = await review([{ root: LEAF_HASH, records: [accountRecord()] }])

      expect(none.feeRate).toBe(Number(FEE) / 3_860)
      expect(confirmation(none)).toEqual(confirmation(signedFor))
    })

    it.each([
      ['a record of the account leaf that does not commit', [accountRecord(DEEP_NON_COMMITTING)]],
      ['only records of other leaves', [LARGE_NON_COMMITTING, otherRecord(NON_COMMITTING)]],
      ['the account leaf listed twice', [accountRecord(DEEP_NON_COMMITTING), accountRecord()]],
    ])('never sizes an input with %s larger than a single-key spend', async (_shape, records) => {
      const decoded = await review([{ root: LEAF_HASH, records }])

      expect(decoded.feeRate).toBe(Number(FEE) / 3_860)
      expect(decoded.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
    })

    it('keeps the rate finite and positive for a malformed final witness', async () => {
      const wellFormed = await review([
        { root: LEAF_HASH, records: [accountRecord()] },
        { root: OTHER_LEAF_HASH, finalWitness: singleKeyWitness(OTHER_LEAF_SCRIPT, SINGLE_LEAF) },
      ])
      expect(wellFormed.feeRate).toBe(Number(FEE) / 7_622)
      for (const finalWitness of [new Uint8Array(), Uint8Array.of(0x05, 0x01)]) {
        const decoded = await review([
          { root: LEAF_HASH, records: [accountRecord()] },
          { root: OTHER_LEAF_HASH, finalWitness },
        ])

        expect(Number.isFinite(decoded.feeRate)).toBe(true)
        expect(decoded.feeRate).toBeGreaterThanOrEqual(wellFormed.feeRate)
      }
    })

    it('shows no rate for a PSBT whose fee is unknown', async () => {
      const decoded = await review([
        { root: LEAF_HASH, records: [accountRecord()], noWitnessUtxo: true },
      ])

      expect(decoded.isCompleted).toBe(false)
      expect(decoded.feeRate).toBe(0)
      expect(decoded.risks).toEqual([])
    })
  })
})
