import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_WITNESS_UTXO,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  type P2mrTransactionOutput,
  type Psbt,
} from '@qbit-oss/protocol'
import { KeyringType, psbtReviewOptions } from '@qbit/wallet-shared'
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
// approval shows which outputs pay the wallet, the transaction's nLockTime and
// version, and whether the PSBT comes back finalized.
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
const SINGLE_LEAF = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const INPUT_VALUE = 10_000_000n
const AMOUNT = 100_000n
const FEE = 7_720n

function p2mrAccount(pubkeyHex: string, index: number) {
  const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
  return {
    type: KeyringType.QbitHdKeyring,
    address: p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'regtest'),
    pubkey: pubkeyHex,
    key: `account-${index}`,
    flag: 0,
    index,
    p2mr: {
      pubkey: pubkeyHex,
      leafScript: bytesToHex(leafScript),
      scriptPubKey: bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))),
      signatureCounter: { count: 0, limit: 30, remaining: 30, state: 'normal' },
    },
  }
}

/** The account signing, and another of the wallet's accounts. */
const account = p2mrAccount('11'.repeat(32), 0)
const otherAccount = p2mrAccount('22'.repeat(32), 1)
const ACCOUNT_SCRIPT = hexToBytes(account.p2mr.scriptPubKey)
const OTHER_ACCOUNT_SCRIPT = hexToBytes(otherAccount.p2mr.scriptPubKey)
const STRANGER_SCRIPT = p2mrScriptPubKey(hexToBytes('77'.repeat(32)))
const SECOND_STRANGER_SCRIPT = p2mrScriptPubKey(hexToBytes('78'.repeat(32)))
/** Another party's single-key leaf, which the wallet does not sign. */
const OTHER_PARTY_LEAF_SCRIPT = singleKeyLeafScript(hexToBytes('33'.repeat(32)))
const OTHER_PARTY_ROOT = p2mrLeafHash(P2MR_LEAF_VERSION_V1, OTHER_PARTY_LEAF_SCRIPT)

/** Who owns a second input: another party, another of the wallet's accounts, or nobody known. */
type SecondInput = 'other_party' | 'other_account' | 'unknown'

/**
 * A website PSBT with one input of `INPUT_VALUE` from the account, and a
 * second one of the same value when `secondInput` says whose. An `unknown`
 * input is another party's without its witness UTXO, so its owner is unknown.
 * `sequences` sets the inputs' nSequence, in input order.
 */
function websitePsbt({
  outputs,
  version,
  locktime,
  secondInput,
  sequences = [],
}: {
  outputs: P2mrTransactionOutput[]
  version?: number
  locktime?: number
  secondInput?: SecondInput
  sequences?: number[]
}): Psbt {
  const second =
    secondInput === 'other_account'
      ? { scriptPubKey: OTHER_ACCOUNT_SCRIPT, leafScript: hexToBytes(otherAccount.p2mr.leafScript) }
      : { scriptPubKey: p2mrScriptPubKey(OTHER_PARTY_ROOT), leafScript: OTHER_PARTY_LEAF_SCRIPT }
  const psbt = createP2mrPsbt({
    ...(version === undefined ? {} : { version }),
    ...(locktime === undefined ? {} : { locktime }),
    inputs: [
      {
        prevout: { txid: hexToBytes('90'.repeat(32)), vout: 0 },
        ...(sequences[0] === undefined ? {} : { sequence: sequences[0] }),
        witnessUtxo: { value: INPUT_VALUE, scriptPubKey: ACCOUNT_SCRIPT },
        leafScript: hexToBytes(account.p2mr.leafScript),
        controlBlock: SINGLE_LEAF,
      },
      ...(secondInput
        ? [
            {
              prevout: { txid: hexToBytes('91'.repeat(32)), vout: 0 },
              ...(sequences[1] === undefined ? {} : { sequence: sequences[1] }),
              witnessUtxo: { value: INPUT_VALUE, scriptPubKey: second.scriptPubKey },
              leafScript: second.leafScript,
              controlBlock: SINGLE_LEAF,
            },
          ]
        : []),
    ],
    outputs,
  })
  if (secondInput === 'unknown') {
    psbt.inputs[1] = psbt.inputs[1]!.filter(entry => entry.key[0] !== PSBT_IN_WITNESS_UTXO)
  }
  return psbt
}

/** Review a website PSBT as the approval does, without signing it. */
function review(psbt: Psbt, statedRecipients?: string[]): Promise<DecodedPsbt> {
  return wallet.decodePsbt(bytesToHex(serializePsbt(psbt)), ORIGIN, {
    suppliedByWebsite: true,
    ...(statedRecipients ? { statedRecipients } : {}),
  })
}

/** Change paying the account what the other outputs and the fee leave of `inputValue`. */
function change(paid: bigint, inputValue: bigint = INPUT_VALUE): P2mrTransactionOutput {
  return { value: inputValue - paid - FEE, scriptPubKey: ACCOUNT_SCRIPT }
}

/**
 * BIP32 derivation records a website can put on an output, claiming it for
 * `pubkeyHex` at `path`: a `PSBT_OUT_BIP32_DERIVATION` (0x02) and a
 * `PSBT_OUT_TAP_BIP32_DERIVATION` (0x07) record.
 */
function derivationHints(pubkeyHex: string, path: number[]) {
  // A master key fingerprint, then each index as a little-endian uint32.
  const origin = Buffer.alloc(4 + 4 * path.length)
  origin.writeUInt32BE(0xdeadbeef, 0)
  path.forEach((index, position) => origin.writeUInt32LE(index, 4 + 4 * position))
  const pubkey = hexToBytes(pubkeyHex)
  return [
    { key: Uint8Array.of(0x02, 0x02, ...pubkey), value: Uint8Array.of(...origin) },
    { key: Uint8Array.of(0x07, ...pubkey), value: Uint8Array.of(0x00, ...origin) },
  ]
}

const HARDENED = 0x80000000
/** m/86'/1'/0'/1/0: the first change address of the first account. */
const CHANGE_PATH = [86 + HARDENED, 1 + HARDENED, HARDENED, 1, 0]
/** m/86'/1'/1'/0/0: the first receive address of the second account. */
const OTHER_ACCOUNT_PATH = [86 + HARDENED, 1 + HARDENED, 1 + HARDENED, 0, 0]

let approvals: { toSignData: ToSignData; review: DecodedPsbt }[] = []

/**
 * Run a website's signPsbt through approval, as the approval window reviews
 * and signs it, and return what the approval was handed and showed, and the
 * signed PSBT.
 */
async function approveWebsitePsbt(psbt: Psbt, options: { autoFinalized?: boolean } = {}) {
  await qbitSendGuardService.resetAllData()
  approvals = []
  const signedPsbtHex = await rpcFlow({
    data: {
      method: 'signPsbt',
      params: {
        psbtHex: bytesToHex(serializePsbt(psbt)),
        options: { chain: ChainType.QBIT_REGTEST, ...options },
      },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  })
  expect(approvals).toHaveLength(1)
  return { ...approvals[0]!, signed: parsePsbt(hexToBytes(signedPsbtHex)) }
}

describe('what a website PSBT approval shows besides the fee (#13)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    approvals = []
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.spyOn(wallet, 'getAccounts').mockResolvedValue([account, otherAccount] as any)
    vi.spyOn(wallet, 'getFeeSummary').mockImplementation(async () =>
      qbitFeeSummaryFromTiers([{ target: 2, feeRate: 9 }], 'esplora', {
        freshness: 'live',
        fetchedAt: Date.now(),
      })
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
      const review = await wallet.decodePsbt(
        toSignData.psbtHex,
        ORIGIN,
        psbtReviewOptions(toSignData)
      )
      approvals.push({ toSignData, review })
      return [await wallet.signPsbtV2(toSignData)]
    })
  })

  it("labels change and the wallet's other accounts, and shows nLockTime and version", async () => {
    const { review } = await approveWebsitePsbt(
      websitePsbt({
        version: 3,
        locktime: 900_000,
        outputs: [
          { value: AMOUNT, scriptPubKey: STRANGER_SCRIPT },
          { value: AMOUNT, scriptPubKey: OTHER_ACCOUNT_SCRIPT },
          change(2n * AMOUNT),
        ],
      })
    )

    expect(review.outputOwners).toEqual(['none', 'other_account', 'change'])
    expect(review.spendSummary.outputRoles).toEqual(['unrecognised', 'wallet', 'wallet'])
    expect(review.version).toBe(3)
    expect(review.locktime).toBe(900_000)
  })

  it('reads nLockTime and version from the bytes, whatever they are', async () => {
    const outputs = [{ value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }, change(AMOUNT)]
    const unlocked = await approveWebsitePsbt(websitePsbt({ outputs }))
    expect(unlocked.review).toMatchObject({ version: 2, locktime: 0 })

    const timeLocked = await approveWebsitePsbt(
      websitePsbt({ outputs, version: 1, locktime: 1_767_225_600 })
    )
    expect(timeLocked.review).toMatchObject({ version: 1, locktime: 1_767_225_600 })
  })

  describe('relative locks', () => {
    const outputs = [{ value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }, change(AMOUNT)]

    it('hands the approval a 144-block relative lock on a version 2 PSBT with no nLockTime', async () => {
      const { review, toSignData, signed } = await approveWebsitePsbt(
        websitePsbt({ outputs, version: 2, locktime: 0, sequences: [0x00000090] })
      )

      expect(review).toMatchObject({ version: 2, locktime: 0 })
      expect(review.relativeLocks).toEqual([
        { input: 0, sequence: 0x00000090, type: 'blocks', value: 144 },
      ])
      // What is signed and finalized is unchanged.
      expect(toSignData.autoFinalized).toBe(true)
      expect(decodePsbt(signed).inputs.map(input => input.sequence)).toEqual([0x00000090])
    })

    it('reads a time lock in 512-second units, for each input that has one', async () => {
      const locked = await review(
        websitePsbt({
          outputs: [{ value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }, change(AMOUNT, 2n * INPUT_VALUE)],
          secondInput: 'other_account',
          sequences: [0xfffffffd, 0x00400090],
        })
      )
      expect(locked.relativeLocks).toEqual([
        { input: 1, sequence: 0x00400090, type: 'time', value: 144 * 512 },
      ])
    })

    it('reads only the type bit and the low 16 bits, whatever the bits a lock leaves unused', async () => {
      const locked = await review(
        websitePsbt({
          outputs: [{ value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }, change(AMOUNT, 2n * INPUT_VALUE)],
          secondInput: 'other_account',
          sequences: [0x7fbf0001, 0x7fff0002],
        })
      )
      expect(locked.relativeLocks).toEqual([
        { input: 0, sequence: 0x7fbf0001, type: 'blocks', value: 1 },
        { input: 1, sequence: 0x7fff0002, type: 'time', value: 1024 },
      ])
    })

    it('finds none when the disable bit is set, the lock is 0 or the version is below 2', async () => {
      for (const psbt of [
        websitePsbt({ outputs }),
        websitePsbt({ outputs, sequences: [0xfffffffe] }),
        websitePsbt({ outputs, sequences: [0x80000090] }),
        websitePsbt({ outputs, sequences: [0x00000000] }),
        websitePsbt({ outputs, sequences: [0x00400000] }),
        websitePsbt({ outputs, version: 1, sequences: [0x00000090] }),
        websitePsbt({ outputs, version: 0, sequences: [0x00000090] }),
      ]) {
        expect((await review(psbt)).relativeLocks).toEqual([])
      }
    })

    it('enforces them for any version from 2, read as an unsigned number', async () => {
      const locked = await review(websitePsbt({ outputs, version: 0xffffffff, sequences: [0x00000090] }))
      expect(locked.version).toBe(0xffffffff)
      expect(locked.relativeLocks).toEqual([
        { input: 0, sequence: 0x00000090, type: 'blocks', value: 144 },
      ])
    })
  })

  describe('change, as against a payment to the signing account', () => {
    const toAccount = { value: AMOUNT, scriptPubKey: ACCOUNT_SCRIPT }

    it('is change only when the wallet funds every input, its other accounts included', async () => {
      const own = await review(
        websitePsbt({
          secondInput: 'other_account',
          outputs: [{ value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }, change(AMOUNT, 2n * INPUT_VALUE)],
        })
      )
      expect(own.outputOwners).toEqual(['none', 'change'])
    })

    it("is a payment to this account when another party's input pays it", async () => {
      const paid = await review(
        websitePsbt({
          secondInput: 'other_party',
          outputs: [toAccount, { value: 2n * INPUT_VALUE - AMOUNT - FEE, scriptPubKey: STRANGER_SCRIPT }],
        })
      )
      expect(paid.spendSummary.outputRoles).toEqual(['wallet', 'unrecognised'])
      expect(paid.outputOwners).toEqual(['this_account', 'none'])
    })

    it('is a payment to this account when an input has no owner the wallet can tell', async () => {
      const unknown = await review(
        websitePsbt({
          secondInput: 'unknown',
          outputs: [toAccount, { value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }],
        })
      )
      expect(unknown.outputOwners).toEqual(['this_account', 'none'])
    })

    it("is a payment to this account when the request names the account's address as its recipient", async () => {
      const psbt = websitePsbt({ outputs: [toAccount, change(AMOUNT)] })

      // The same bytes without a named recipient: the wallet sends to itself.
      expect((await review(psbt)).outputOwners).toEqual(['change', 'change'])
      const named = await review(psbt, [account.address.toUpperCase()])
      expect(named.outputOwners).toEqual(['this_account', 'this_account'])
    })

    it("labels another of the wallet's accounts the same whoever funds the inputs", async () => {
      const paid = await review(
        websitePsbt({
          secondInput: 'other_party',
          outputs: [
            { value: AMOUNT, scriptPubKey: OTHER_ACCOUNT_SCRIPT },
            { value: 2n * INPUT_VALUE - AMOUNT - FEE, scriptPubKey: STRANGER_SCRIPT },
          ],
        }),
        [otherAccount.address]
      )
      expect(paid.outputOwners).toEqual(['other_account', 'none'])
    })
  })

  it('never labels an output from the derivation records the website puts on it', async () => {
    const psbt = websitePsbt({
      outputs: [
        { value: AMOUNT, scriptPubKey: STRANGER_SCRIPT },
        { value: AMOUNT, scriptPubKey: SECOND_STRANGER_SCRIPT },
        change(2n * AMOUNT),
      ],
    })
    // The website claims the first stranger's output as the account's change
    // and the second as the wallet's other account.
    psbt.outputs[0]!.push(...derivationHints(account.pubkey, CHANGE_PATH))
    psbt.outputs[1]!.push(...derivationHints(otherAccount.pubkey, OTHER_ACCOUNT_PATH))

    const { review } = await approveWebsitePsbt(psbt)

    expect(review.outputOwners).toEqual(['none', 'none', 'change'])
    expect(review.spendSummary.outputRoles).toEqual(['unrecognised', 'unrecognised', 'wallet'])
  })

  it('hands the approval the finalize decision signing carries out', async () => {
    const outputs = [{ value: AMOUNT, scriptPubKey: STRANGER_SCRIPT }, change(AMOUNT)]

    // The account's signature completes every input: finalized for the site.
    const complete = await approveWebsitePsbt(websitePsbt({ outputs }))
    expect(complete.toSignData.autoFinalized).toBe(true)
    expect(decodePsbt(complete.signed).inputs.map(input => input.finalized)).toEqual([true])

    // The site asked for it unfinalized.
    const asked = await approveWebsitePsbt(websitePsbt({ outputs }), { autoFinalized: false })
    expect(asked.toSignData.autoFinalized).toBe(false)
    expect(decodePsbt(asked.signed).inputs.map(input => input.finalized)).toEqual([false])

    // Another party's input is left for its signer.
    const shared = await approveWebsitePsbt(
      websitePsbt({
        secondInput: 'other_party',
        outputs: [
          { value: AMOUNT, scriptPubKey: STRANGER_SCRIPT },
          change(AMOUNT, 2n * INPUT_VALUE),
        ],
      })
    )
    expect(shared.toSignData.autoFinalized).toBe(false)
    expect(decodePsbt(shared.signed).inputs.map(input => input.finalized)).toEqual([false, false])
  })
})
