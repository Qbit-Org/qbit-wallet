import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  hexToBytes,
  outputScriptToAddress,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { ErrorCodes, KeyringType, RiskType, psbtReviewOptions } from '@qbit/wallet-shared'
import type { DecodedPsbt, ToSignData } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import rpcFlow from '../src/controllers/provider/rpcFlow'
import wallet from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'

// The real provider flow, provider controller, wallet controller and send
// guard: a website's signPsbt, the approval window reviewing it with
// decodePsbt and signing it through signPsbtV2. Only the approval window, the
// keyring signer, signature verification and the fee quote are stubbed.
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
const ACCOUNT_SCRIPT = p2mrScriptPubKey(LEAF_HASH)
const RECIPIENT_SCRIPT = p2mrScriptPubKey(hexToBytes('77'.repeat(32)))
/** The pay-to-anchor script `OP_1 <0x4e73>`. */
const P2A_SCRIPT = hexToBytes('51024e73')
/** qbit Core relays a P2A output of 121 and refuses one of 120 as dust. */
const P2A_DUST = 121n
const INPUT_VALUE = 1_000_000n
const FEE = 20_000n

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

/**
 * A website PSBT spending one account output of `INPUT_VALUE` into
 * `outputs`, with the rest, less `FEE`, back to the account.
 */
function websitePsbtHex(outputs: { value: bigint; scriptPubKey: Uint8Array }[]): string {
  const paid = outputs.reduce((total, output) => total + output.value, 0n)
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: hexToBytes('98'.repeat(32)), vout: 0 },
        witnessUtxo: { value: INPUT_VALUE, scriptPubKey: ACCOUNT_SCRIPT },
        leafScript: LEAF_SCRIPT,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
      },
    ],
    outputs: [...outputs, { value: INPUT_VALUE - paid - FEE, scriptPubKey: ACCOUNT_SCRIPT }],
  })
  return bytesToHex(serializePsbt(psbt))
}

function anchor(value: bigint) {
  return { value, scriptPubKey: P2A_SCRIPT }
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

function signPsbtsRequest(psbtHexs: string[]) {
  return {
    data: {
      method: 'signPsbts',
      params: { psbtHexs, options: psbtHexs.map(() => ({ chain: ChainType.QBIT_REGTEST })) },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  }
}

let reviews: DecodedPsbt[] = []

/** Run a website's signPsbt through approval and return what the approval showed. */
async function approveWebsitePsbt(psbtHex: string): Promise<DecodedPsbt> {
  await rpcFlow(signPsbtRequest(psbtHex))
  expect(reviews).toHaveLength(1)
  return reviews[0]!
}

describe('pay-to-anchor outputs in a website PSBT', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    reviews = []
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.spyOn(wallet, 'getAccounts').mockResolvedValue([account] as any)
    vi.spyOn(wallet, 'getFeeSummary').mockRejectedValue(new Error('no quote'))
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
    approvalServiceMock.requestApproval.mockImplementation(async approval => {
      const toSignData: ToSignData = structuredClone(approval.params.data.toSignDatas[0])
      reviews.push(
        await wallet.decodePsbt(toSignData.psbtHex, ORIGIN, psbtReviewOptions(toSignData))
      )
      return [await wallet.signPsbtV2(toSignData)]
    })
  })

  it.each([
    ['most of the input', [anchor(INPUT_VALUE - FEE - 1n)]],
    ['one sat more than the relay minimum', [anchor(P2A_DUST + 1n)]],
    ['more than the relay minimum across two anchors', [anchor(P2A_DUST), anchor(1n)]],
  ])('refuses anchor outputs carrying %s before approval', async (_shape, outputs) => {
    await expect(rpcFlow(signPsbtRequest(websitePsbtHex(outputs)))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining('pay-to-anchor outputs, which anyone can spend'),
    })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('refuses a batch in which one PSBT carries a valued anchor', async () => {
    const psbtHexs = [
      websitePsbtHex([{ value: 10_000n, scriptPubKey: RECIPIENT_SCRIPT }]),
      websitePsbtHex([anchor(50_000n)]),
    ]

    await expect(rpcFlow(signPsbtsRequest(psbtHexs))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    })
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
  })

  it.each([
    ['the relay minimum', P2A_DUST],
    ['no value', 0n],
  ])(
    'shows an anchor of %s as one anyone can spend, with a risk to confirm',
    async (_shape, value) => {
      const review = await approveWebsitePsbt(websitePsbtHex([anchor(value)]))

      expect(review.outputInfos[0]).toEqual({
        type: 'p2a',
        address: '',
        value: Number(value),
        scriptPubKeyHex: '51024e73',
      })
      expect(review.spendSummary.outputRoles[0]).toBe('unrecognised')
      expect(review.risks).toContainEqual(
        expect.objectContaining({ type: RiskType.UNRECOGNISED_OUTPUT, level: 'danger' })
      )
    }
  )

  it('leaves outputs with an address as they were, with no unrecognised-output risk', async () => {
    const review = await approveWebsitePsbt(
      websitePsbtHex([{ value: 10_000n, scriptPubKey: RECIPIENT_SCRIPT }])
    )

    expect(review.outputInfos).toEqual([
      {
        address: outputScriptToAddress(RECIPIENT_SCRIPT, 'regtest'),
        value: 10_000,
        scriptPubKeyHex: bytesToHex(RECIPIENT_SCRIPT),
      },
      {
        address: account.address,
        value: Number(INPUT_VALUE - 10_000n - FEE),
        scriptPubKeyHex: bytesToHex(ACCOUNT_SCRIPT),
      },
    ])
    expect(review.risks.map(risk => risk.type)).not.toContain(RiskType.UNRECOGNISED_OUTPUT)
  })
})
