import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtLeafScriptField,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { ErrorCodes, KeyringType } from '@qbit/wallet-shared'
import type { ToSignData } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import rpcFlow from '../src/controllers/provider/rpcFlow'
import wallet from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'

// The real provider flow, provider controller, wallet controller and send
// guard: a website's signPsbt, the approval window signing it through
// signPsbtV2, and the provider's check of the signed PSBT. Only the approval
// window, the keyring signer (which counts the signatures it spends) and
// signature verification are stubbed.
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
/** Another leaf of the same output, and the root of `((leaf, other), leaf)`. */
const OTHER_LEAF_HASH = p2mrLeafHash(
  P2MR_LEAF_VERSION_V1,
  singleKeyLeafScript(hexToBytes('33'.repeat(32)))
)
const TREE_ROOT = p2mrBranchHash(p2mrBranchHash(LEAF_HASH, OTHER_LEAF_HASH), LEAF_HASH)

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
    scriptPubKey: bytesToHex(p2mrScriptPubKey(LEAF_HASH)),
    signatureCounter: { count: 0, limit: 30, remaining: 30, state: 'normal' },
  },
}

const SIGNATURE_BUDGET = {
  required: 1,
  cached: 0,
  remainingBefore: 30,
  remainingAfter: 29,
  limit: 30,
}

interface LeafRecord {
  controlBlock: Uint8Array
  script?: Uint8Array
}

/** The account's leaf in the single-leaf output, as the wallet builds it. */
const SINGLE_LEAF = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
/** A 33-byte control block that commits to nothing (#352). */
const NON_COMMITTING = buildControlBlock(P2MR_LEAF_VERSION_V1, [hexToBytes('5a'.repeat(32))])
/** Both positions of the account's leaf in `((leaf, other), leaf)`. */
const TREE_DEEP = buildControlBlock(P2MR_LEAF_VERSION_V1, [OTHER_LEAF_HASH, LEAF_HASH])
const TREE_SHALLOW = buildControlBlock(P2MR_LEAF_VERSION_V1, [
  p2mrBranchHash(LEAF_HASH, OTHER_LEAF_HASH),
])

/**
 * A website PSBT spending one output of `root` whose input lists exactly
 * `records`, in that order, as `0x1d` leaf records.
 */
function websitePsbtHex(
  root: Uint8Array,
  records: LeafRecord[],
  merkleRoot: Uint8Array | undefined = undefined
): string {
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: hexToBytes('98'.repeat(32)), vout: 0 },
        witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(root) },
        leafScript: LEAF_SCRIPT,
        controlBlock: SINGLE_LEAF,
        ...(merkleRoot ? { merkleRoot } : {}),
      },
    ],
    outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(LEAF_HASH) }],
  })
  const input = psbt.inputs[0]!.filter(entry => entry.key[0] !== PSBT_IN_P2MR_LEAF_SCRIPT)
  input.push(
    ...records.map(record =>
      encodeP2mrPsbtLeafScriptField(record.controlBlock, record.script ?? LEAF_SCRIPT)
    )
  )
  psbt.inputs[0] = input
  return bytesToHex(serializePsbt(psbt))
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

/** The final witness's control block, the last of its three items. */
function finalControlBlock(psbtHex: string): string {
  const witness = parsePsbt(hexToBytes(psbtHex)).inputs[0]!.find(
    entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS
  )!.value
  let offset = 1
  let item = new Uint8Array()
  for (let index = 0; index < 3; index += 1) {
    const length = witness[offset]!
    const start = offset + (length < 0xfd ? 1 : 3)
    const size = length < 0xfd ? length : witness[offset + 1]! | (witness[offset + 2]! << 8)
    item = witness.slice(start, start + size)
    offset = start + size
  }
  return bytesToHex(item)
}

describe('a website PSBT whose input lists the account leaf ambiguously (#352)', () => {
  let signatureCounter = 0

  beforeEach(async () => {
    vi.clearAllMocks()
    signatureCounter = 0
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(SIGNATURE_BUDGET as any)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address, { psbt, keys }) => {
        const signed = signP2mrPsbt({
          psbt,
          keys,
          sign: () => {
            signatureCounter += 1
            return new Uint8Array(PQC_SIGNATURE_BYTES).fill(7)
          },
        })
        return { ...signed, counterResults: [] } as any
      }
    )
    // The user presses Sign: the window signs the request it was shown.
    approvalServiceMock.requestApproval.mockImplementation(async approval => {
      const toSignData: ToSignData = structuredClone(approval.params.data.toSignDatas[0])
      return [await wallet.signPsbtV2(toSignData)]
    })
  })

  it.each([
    ['a non-committing record before the committing one', [NON_COMMITTING, SINGLE_LEAF]],
    ['the committing record before a non-committing one', [SINGLE_LEAF, NON_COMMITTING]],
  ])('refuses %s before approval, so no signature counter moves', async (_shape, controlBlocks) => {
    const psbtHex = websitePsbtHex(
      LEAF_HASH,
      controlBlocks.map(controlBlock => ({ controlBlock }))
    )

    await expect(rpcFlow(signPsbtRequest(psbtHex))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining(
        "input 0: PSBT lists the account's P2MR leaf more than once"
      ),
    })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(signatureCounter).toBe(0)
  })

  it.each([
    [
      'two records that both commit',
      TREE_ROOT,
      [{ controlBlock: TREE_DEEP }, { controlBlock: TREE_SHALLOW }],
      "PSBT lists the account's P2MR leaf more than once",
    ],
    [
      'one record that does not commit',
      LEAF_HASH,
      [{ controlBlock: NON_COMMITTING }],
      "the control block of the account's P2MR leaf does not commit",
    ],
    [
      'a merkle root other than the spent output program',
      LEAF_HASH,
      [{ controlBlock: SINGLE_LEAF }],
      'P2MR merkle root does not match the witness UTXO program',
      TREE_ROOT,
    ],
  ])('refuses %s before approval', async (_shape, root, records, message, merkleRoot?) => {
    await expect(
      rpcFlow(signPsbtRequest(websitePsbtHex(root, records, merkleRoot)))
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining(message),
    })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(signatureCounter).toBe(0)
  })

  it.each([
    ['one committing record', LEAF_HASH, [{ controlBlock: SINGLE_LEAF }], SINGLE_LEAF],
    ['one committing record deeper in a tree', TREE_ROOT, [{ controlBlock: TREE_DEEP }], TREE_DEEP],
    [
      "the account's record beside a non-committing record of another leaf",
      LEAF_HASH,
      [
        {
          controlBlock: NON_COMMITTING,
          script: singleKeyLeafScript(hexToBytes('44'.repeat(32))),
        },
        { controlBlock: SINGLE_LEAF },
      ],
      SINGLE_LEAF,
    ],
  ])(
    'signs %s once and returns it finalized with that record',
    async (_shape, root, records, controlBlock) => {
      const signedPsbtHex = await rpcFlow(signPsbtRequest(websitePsbtHex(root, records)))

      expect(signatureCounter).toBe(1)
      expect(decodePsbt(parsePsbt(hexToBytes(signedPsbtHex))).inputs[0]!.finalized).toBe(true)
      expect(finalControlBlock(signedPsbtHex)).toBe(bytesToHex(controlBlock))
    }
  )
})
