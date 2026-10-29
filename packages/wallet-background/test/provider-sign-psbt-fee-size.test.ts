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
import { KeyringType, QBIT_P2MR_DUST, RiskType, psbtReviewOptions } from '@qbit/wallet-shared'
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
    // The approval window reviews the PSBT it was handed, with the options
    // the sign screen builds from the request, then the user signs.
    approvalServiceMock.requestApproval.mockImplementation(async approval => {
      const toSignData: ToSignData = structuredClone(approval.params.data.toSignDatas[0])
      reviews.push(
        await wallet.decodePsbt(toSignData.psbtHex, ORIGIN, psbtReviewOptions(toSignData))
      )
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

  // The fee as a share of what the PSBT pays others needs no size estimate.
  // The fastest tier recommends 9 bits/vB, so a fee of at least 68,706 bits,
  // twice what the smallest send (3,817 vB) costs at that rate, and at least
  // a quarter of the payout needs the confirmation.
  describe('the fee as a share of the payout, judged without the size estimate', () => {
    /** Below twice the recommended 9 bits/vB, so no rate condition holds. */
    const LOW_RATE = 15
    /** 15 bits/vB of the 11,384 vB three inputs and two outputs finalize to. */
    const THREE_INPUT_FEE = 170_760n

    /**
     * A website PSBT spending `inputValues` from the account's address and
     * paying `amount` to a stranger, with the rest, less `fee`, back to it.
     */
    function paymentPsbt(inputValues: bigint[], amount: bigint, fee: bigint): Psbt {
      const change = inputValues.reduce((sum, value) => sum + value, 0n) - amount - fee
      return createP2mrPsbt({
        inputs: inputValues.map((value, index) => ({
          prevout: { txid: hexToBytes((0xa0 + index).toString(16).repeat(32)), vout: 0 },
          witnessUtxo: { value, scriptPubKey: ACCOUNT_SCRIPT },
          leafScript: LEAF_SCRIPT,
          controlBlock: SINGLE_LEAF,
        })),
        outputs: [
          ...(amount > 0n ? [{ value: amount, scriptPubKey: RECIPIENT_SCRIPT }] : []),
          ...(change > 0n ? [{ value: change, scriptPubKey: ACCOUNT_SCRIPT }] : []),
        ],
      })
    }

    const THREE_INPUTS = [1_000_000n, 1_000_000n, 1_000_000n]
    /** How a website's approval of the share-heavy three-input payment is confirmed. */
    const WEBSITE_SHARE_FLAG = {
      feeRate: LOW_RATE,
      risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
      reasons: ['large_share_of_amount'],
      shouldWarnFeeRate: true,
    }

    it('confirms a fee that is a large share of the payout at a rate below every rate condition', async () => {
      const psbt = paymentPsbt(THREE_INPUTS, AMOUNT, THREE_INPUT_FEE)
      const approved = await approveWebsitePsbt(psbt)

      expect(approved.review.feeRate).toBe(
        Number(THREE_INPUT_FEE) / finalizedVsize(approved.signed)
      )
      expect(approved.review.feeRate).toBe(LOW_RATE)
      expect(confirmation(approved.review)).toEqual({
        feeRate: LOW_RATE,
        risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
        reasons: ['large_share_of_amount'],
        shouldWarnFeeRate: true,
      })

      // The wallet's own screens, which pass no website, judge the same
      // bytes by their rate alone, as before.
      const own = await wallet.decodePsbt(bytesToHex(serializePsbt(psbt)), '')
      expect(confirmation(own)).toEqual({
        feeRate: LOW_RATE,
        risks: [],
        reasons: [],
        shouldWarnFeeRate: false,
      })
    })

    it('flags a fee at twice what the smallest send costs, and not one bit less', async () => {
      const atFloor = await approveWebsitePsbt(paymentPsbt([1_000_000n], AMOUNT, 68_706n))
      // 17.8 bits/vB on the 3,860 vB it finalizes to: below twice 9.
      expect(atFloor.review.feeRate).toBeLessThan(18)
      expect(confirmation(atFloor.review)).toMatchObject({
        risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
        reasons: ['large_share_of_amount'],
      })

      const below = await approveWebsitePsbt(paymentPsbt([1_000_000n], AMOUNT, 68_705n))
      expect(confirmation(below.review)).toMatchObject({ risks: [], reasons: [] })
    })

    it('flags a fee at a quarter of the payout, and not when the payout is one bit more', async () => {
      const atShare = await approveWebsitePsbt(paymentPsbt(THREE_INPUTS, 683_040n, THREE_INPUT_FEE))
      expect(confirmation(atShare.review)).toMatchObject({
        feeRate: LOW_RATE,
        risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
        reasons: ['large_share_of_amount'],
      })

      const below = await approveWebsitePsbt(paymentPsbt(THREE_INPUTS, 683_041n, THREE_INPUT_FEE))
      expect(confirmation(below.review)).toMatchObject({ risks: [], reasons: [] })
    })

    it('has no payout to compare a transfer back to the wallet with', async () => {
      const selfTransfer = await approveWebsitePsbt(paymentPsbt(THREE_INPUTS, 0n, THREE_INPUT_FEE))

      expect(selfTransfer.review.spendSummary?.feeAssessment?.amount).toBe(0)
      expect(confirmation(selfTransfer.review)).toMatchObject({ risks: [], reasons: [] })
    })

    it('leaves a payment of the dust limit at the recommended rate unflagged', async () => {
      // One output: change too small to keep is folded into the fee.
      const fee = BigInt(9 * 3_817 + QBIT_P2MR_DUST - 1)
      const dust = BigInt(QBIT_P2MR_DUST)
      const small = await approveWebsitePsbt(paymentPsbt([dust + fee], dust, fee))

      expect(small.review.outputInfos).toHaveLength(1)
      expect(small.review.spendSummary?.feeAssessment).toMatchObject({
        fee: Number(fee),
        amount: QBIT_P2MR_DUST,
      })
      expect(confirmation(small.review)).toMatchObject({ risks: [], reasons: [] })
    })

    it("judges each PSBT of a website's batch, and not of the wallet's own, the same way", async () => {
      const psbtHex = bytesToHex(serializePsbt(paymentPsbt(THREE_INPUTS, AMOUNT, THREE_INPUT_FEE)))
      const providerContext = {
        origin: ORIGIN,
        account: account.address,
        chain: ChainType.QBIT_REGTEST,
        network: 'regtest',
      } as never
      const summary = await wallet.analyzeLocalPsbts([
        { psbtHex, toSignInputs: [], providerContext },
        { psbtHex, toSignInputs: [] },
        // A website's sendQbit carries the claim minted at its approval.
        {
          psbtHex,
          toSignInputs: [],
          providerContext,
          qbitSendBroadcastClaim: wallet.createQbitSendBroadcastClaim(psbtHex, providerContext),
        },
      ])

      expect(summary.items.map(item => item.risks.map(risk => risk.type))).toEqual([
        [RiskType.HIGH_FEE_RATE],
        [],
        [],
      ])
      expect(summary.items.map(item => item.spendSummary?.feeAssessment?.reasons)).toEqual([
        ['large_share_of_amount'],
        [],
        [],
      ])
    })

    describe("as a website's request carries it to the approval", () => {
      const psbt = () => paymentPsbt(THREE_INPUTS, AMOUNT, THREE_INPUT_FEE)
      let approvals: { toSignDatas: ToSignData[]; reviews: DecodedPsbt[]; batch?: unknown }[] = []

      beforeEach(() => {
        approvals = []
        // The approval window reviews each PSBT as the sign screen does, and a
        // batch as its summary does, then the user rejects the request.
        approvalServiceMock.requestApproval.mockImplementation(async approval => {
          const toSignDatas: ToSignData[] = structuredClone(approval.params.data.toSignDatas)
          approvals.push({
            toSignDatas,
            reviews: await Promise.all(
              toSignDatas.map(toSignData =>
                wallet.decodePsbt(toSignData.psbtHex, ORIGIN, psbtReviewOptions(toSignData))
              )
            ),
            ...(toSignDatas.length > 1
              ? { batch: await wallet.analyzeLocalPsbts(toSignDatas) }
              : {}),
          })
          throw new Error('User rejected the request')
        })
      })

      it("judges a website's sendQbit, which the wallet built, as the wallet's own", async () => {
        const built = bytesToHex(serializePsbt(psbt()))
        vi.spyOn(wallet, 'createSendQbitPsbt').mockResolvedValue({
          psbtHex: built,
          toSignInputs: [],
        } as ToSignData)

        await expect(
          rpcFlow({
            data: {
              method: 'sendQbit',
              params: { sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 100_000 } },
            },
            session: { origin: ORIGIN, name: 'Dapp', icon: '' },
          })
        ).rejects.toThrow()

        expect(approvals).toHaveLength(1)
        const [
          {
            toSignDatas,
            reviews: [review],
          },
        ] = approvals as [(typeof approvals)[number]]
        expect(toSignDatas[0]?.qbitSendBroadcastClaim?.origin).toBe(ORIGIN)
        expect(confirmation(review!)).toEqual({
          feeRate: LOW_RATE,
          risks: [],
          reasons: [],
          shouldWarnFeeRate: false,
        })
        expect(
          (await wallet.analyzeLocalPsbts(toSignDatas)).items[0]?.risks.map(risk => risk.type)
        ).toEqual([])
      })

      it('judges the same bytes supplied by a website signPsbt or signPsbts without the size', async () => {
        const supplied = bytesToHex(serializePsbt(psbt()))
        await expect(rpcFlow(signPsbtRequest(supplied))).rejects.toThrow()
        await expect(
          rpcFlow({
            data: {
              method: 'signPsbts',
              params: {
                psbtHexs: [supplied, supplied],
                options: [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_REGTEST }],
              },
            },
            session: { origin: ORIGIN, name: 'Dapp', icon: '' },
          })
        ).rejects.toThrow()

        expect(approvals.map(approval => approval.reviews.map(confirmation))).toEqual([
          [WEBSITE_SHARE_FLAG],
          [WEBSITE_SHARE_FLAG, WEBSITE_SHARE_FLAG],
        ])
        const batch = approvals[1]!.batch as Awaited<ReturnType<typeof wallet.analyzeLocalPsbts>>
        expect(batch.items.map(item => item.spendSummary?.feeAssessment?.reasons)).toEqual([
          ['large_share_of_amount'],
          ['large_share_of_amount'],
        ])
      })
    })

    describe('with an input the website funds', () => {
      const WEBSITE_SCRIPT = p2mrScriptPubKey(OTHER_LEAF_HASH)
      /** 15 bits/vB of the 7,622 vB one input of each and two outputs finalize to. */
      const FEE = 114_330n

      /**
       * A website PSBT spending one output of the account and one of the
       * website's, which the website signs after the wallet.
       */
      function withWebsiteInput(
        walletValue: bigint,
        websiteValue: bigint,
        outputs: { value: bigint; scriptPubKey: Uint8Array }[]
      ): Psbt {
        return createP2mrPsbt({
          inputs: [
            {
              prevout: { txid: hexToBytes('b0'.repeat(32)), vout: 0 },
              witnessUtxo: { value: walletValue, scriptPubKey: ACCOUNT_SCRIPT },
              leafScript: LEAF_SCRIPT,
              controlBlock: SINGLE_LEAF,
            },
            {
              prevout: { txid: hexToBytes('b1'.repeat(32)), vout: 0 },
              witnessUtxo: { value: websiteValue, scriptPubKey: WEBSITE_SCRIPT },
              leafScript: OTHER_LEAF_SCRIPT,
              controlBlock: SINGLE_LEAF,
            },
          ],
          outputs,
        })
      }

      it('confirms a fee that is a large share of what leaves the wallet', async () => {
        // 10,000 bits to a stranger and the fee; the rest comes back.
        const psbt = withWebsiteInput(1_000_000n, 1_000n, [
          { value: 10_000n, scriptPubKey: RECIPIENT_SCRIPT },
          { value: 1_001_000n - 10_000n - FEE, scriptPubKey: ACCOUNT_SCRIPT },
        ])
        const approved = await approveWebsitePsbt(psbt)

        const vsize = finalizedVsize(approved.signed, [{ inputIndex: 1, ...OTHER_PARTY_KEY }])
        expect(approved.review.feeRate).toBe(Number(FEE) / vsize)
        expect(approved.review.feeRate).toBeLessThan(18)
        expect(approved.review.spendSummary?.netSpend).toBe(123_330)
        expect(approved.review.spendSummary?.feeAssessment).toMatchObject({
          amount: 123_330,
          reasons: ['large_share_of_amount'],
          highFeeAtNormalRate: true,
        })
        expect(approved.review.risks).toEqual([
          {
            type: RiskType.HIGH_FEE_RATE,
            level: 'warning',
            title: 'High fee detected',
            desc: 'The fee is a large share of what this transaction sends.',
          },
        ])

        // The wallet's own screens judge only the rate of a shared fee, as before.
        const own = await wallet.decodePsbt(bytesToHex(serializePsbt(psbt)), '')
        expect(confirmation(own)).toMatchObject({ risks: [], reasons: [] })
      })

      it('asks to confirm an honest PSBT whose counterparty pays the fee', async () => {
        // The wallet pays 100,000 bits with no change; the website's input
        // pays the fee and takes its change back.
        const approved = await approveWebsitePsbt(
          withWebsiteInput(100_000n, 300_000n, [
            { value: 100_000n, scriptPubKey: RECIPIENT_SCRIPT },
            { value: 300_000n - FEE, scriptPubKey: WEBSITE_SCRIPT },
          ])
        )

        expect(approved.review.spendSummary?.netSpend).toBe(100_000)
        expect(confirmation(approved.review)).toMatchObject({
          risks: [[RiskType.HIGH_FEE_RATE, 'warning']],
          reasons: ['large_share_of_amount'],
        })
      })

      it('has nothing to compare with when the wallet gets back more than it puts in', async () => {
        const approved = await approveWebsitePsbt(
          withWebsiteInput(100_000n, 300_000n, [
            { value: 150_000n, scriptPubKey: ACCOUNT_SCRIPT },
            { value: 250_000n - FEE, scriptPubKey: WEBSITE_SCRIPT },
          ])
        )

        expect(approved.review.spendSummary?.netSpend).toBe(-50_000)
        expect(approved.review.spendSummary?.feeAssessment).toMatchObject({ amount: 0 })
        expect(confirmation(approved.review)).toMatchObject({ risks: [], reasons: [] })
      })
    })
  })
})
