import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { ErrorCodes, KeyringType, WalletError } from '@qbit/wallet-shared'
import type { QbitSendBroadcastClaim, ToSignData } from '@qbit/wallet-shared'
import { transactionCore } from '@qbit/wallet-core'
import { ChainType } from '@qbit/wallet-types'
import rpcFlow from '../src/controllers/provider/rpcFlow'
import wallet from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'

// The real provider flow, wallet controller and send guard: a dapp's
// sendQbit approval, the approval window signing it through signPsbtV2, and
// the request's cleanup, with only the approval window, the keyring signer
// and the provider method's own body stubbed.
const providerControllerMock = vi.hoisted(() => ({ sendQbit: vi.fn() }))
const approvalServiceMock = vi.hoisted(() => ({
  pending: false,
  requestApproval: vi.fn(),
  unLock: vi.fn(),
}))

vi.mock('../src/controllers/provider/controller', () => ({ default: providerControllerMock }))
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
      signP2mrPsbtWithCounter: vi.fn(),
      preflightP2mrPsbtSigning: vi.fn(),
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
const SOURCE_TXID = `01${'00'.repeat(31)}`
const SOURCE_OUTPOINT = { txid: SOURCE_TXID, vout: 0 }

function reverseTxid(txid: string) {
  return bytesToHex(new Uint8Array(hexToBytes(txid)).reverse())
}

/** A single-input P2MR send and the bytes the keyring hands back for it. */
function sendFixture() {
  const pubkeyHex = '11'.repeat(32)
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: hexToBytes(reverseTxid(SOURCE_TXID)), vout: 0 },
        witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      },
    ],
    outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
  })
  const unsignedPsbtHex = bytesToHex(serializePsbt(psbt))
  const signing = signP2mrPsbt({
    psbt,
    keys: [{ inputIndex: 0, pubkey, leafHash }],
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
  })
  const rawTx = extractP2mrTransaction(finalizeP2mrPsbt(signing.psbt))
  return {
    address: p2mrAddressFromPubkey(pubkey, 'regtest'),
    pubkeyHex,
    leafHashHex: bytesToHex(leafHash),
    unsignedPsbtHex,
    signing,
    txid: transactionCore.Transaction.fromBuffer(Buffer.from(rawTx)).getId(),
  }
}

const fixture = sendFixture()
const account = {
  type: KeyringType.QbitHdKeyring,
  address: fixture.address,
  pubkey: fixture.pubkeyHex,
  key: 'account-0',
  flag: 0,
  index: 0,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function keyringSignature() {
  return { psbt: fixture.signing.psbt, signed: fixture.signing.signed, counterResults: [] } as any
}

function sendRequest() {
  return {
    data: {
      method: 'sendQbit',
      params: { sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 } },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  }
}

/** The request the approval window received: a copy, as it crosses the UI port. */
function approvalToSignData(approval: any): ToSignData {
  return structuredClone(approval.params.data.toSignDatas[0])
}

/** The claim the approval carries, as the background minted it. */
function approvalClaim(approval: any): QbitSendBroadcastClaim {
  return structuredClone(approval.params.data.toSignDatas[0].qbitSendBroadcastClaim)
}

/** The user pressed Sign in the approval window: the wallet signs the request locally. */
function signInApprovalWindow(toSignData: ToSignData) {
  return wallet.signPsbtV2(toSignData)
}

function userCancel() {
  return new WalletError(ErrorCodes.UserCancel, 'User Cancel')
}

function outcomeUnknownError(claim: QbitSendBroadcastClaim) {
  return Object.assign(
    new WalletError(
      ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
      'Qbit transaction broadcast outcome is unknown; check the transaction before retrying'
    ),
    { data: { outcome: 'unknown', chain: claim.chain, txid: claim.txid } }
  )
}

function reservedOutpoints() {
  return qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
}

async function expectInputFree() {
  await expect(reservedOutpoints()).resolves.toEqual(new Set())
  await expect(
    qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [SOURCE_OUTPOINT])
  ).resolves.toBeUndefined()
}

async function expectInputClaimed() {
  await expect(reservedOutpoints()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
  await expect(
    qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [SOURCE_OUTPOINT])
  ).rejects.toThrow('claimed by an approved send')
}

describe('a provider sendQbit claim belongs to its request', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    approvalServiceMock.requestApproval.mockReset()
    providerControllerMock.sendQbit.mockReset()
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockReset()
    approvalServiceMock.pending = false
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue(keyringSignature())
    providerControllerMock.sendQbit.mockResolvedValue(fixture.txid)
    // The provider's sendQbit approval data, as its approval condition
    // builds it: the PSBT and the claim the background mints for it.
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          const toSignData: ToSignData = {
            psbtHex: fixture.unsignedPsbtHex,
            toSignInputs: [],
            qbitP2mrSigningKeys: [
              { inputIndex: 0, publicKey: fixture.pubkeyHex, leafHash: fixture.leafHashHex },
            ],
            qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: fixture.txid },
            providerContext: req.providerContext,
          }
          toSignData.qbitSendBroadcastClaim = wallet.createQbitSendBroadcastClaim(
            toSignData.psbtHex,
            req.providerContext
          )
          req.data.params.toSignDatas = [toSignData]
        },
      ],
      providerControllerMock,
      'sendQbit'
    )
  })

  /** Open one approval at a time, as the approval service does. */
  function approvalWindow(window: (approval: any) => Promise<unknown>) {
    approvalServiceMock.requestApproval.mockImplementationOnce(async approval => {
      if (approvalServiceMock.pending) {
        throw new WalletError(ErrorCodes.UNKNOWN, 'Another approval request is already pending')
      }
      approvalServiceMock.pending = true
      try {
        return await window(approval)
      } finally {
        approvalServiceMock.pending = false
      }
    })
  }

  it('releases the claim when the user signs and then rejects the approval', async () => {
    approvalWindow(async approval => {
      await signInApprovalWindow(approvalToSignData(approval))
      // Signed and held while the approval is open.
      await expectInputClaimed()
      throw userCancel()
    })

    await expect(rpcFlow(sendRequest())).rejects.toMatchObject({ code: ErrorCodes.UserCancel })

    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
    await expectInputFree()
  })

  it('releases the claim when the website guard refuses the signed bytes and the user rejects', async () => {
    approvalWindow(async approval => {
      const toSignData = approvalToSignData(approval)
      const signed = await signInApprovalWindow(toSignData)
      // The website guard refuses the handoff: the window discards the
      // bytes and leaves the provider claim to the request, which still
      // holds it, so signing again is refused before any signature is spent.
      expect(signed.qbitSendBroadcastClaim).toEqual(approvalClaim(approval))
      await expect(signInApprovalWindow(toSignData)).rejects.toThrow('claim already exists')
      expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
      // The user presses Reject.
      throw userCancel()
    })

    await expect(rpcFlow(sendRequest())).rejects.toMatchObject({ code: ErrorCodes.UserCancel })

    await expectInputFree()
  })

  it('releases the claim when the approval window closes while it is still signing', async () => {
    const keyringSigning = deferred<any>()
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementationOnce(
      () => keyringSigning.promise
    )
    let signing: Promise<unknown> | undefined
    approvalWindow(async approval => {
      signing = signInApprovalWindow(approvalToSignData(approval))
      // The window is removed mid-signature: handleWindowRemoved rejects the
      // approval while the signature is still being made.
      throw userCancel()
    })

    const outcome = rpcFlow(sendRequest()).catch(error => error)
    await vi.waitFor(() => expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalled())
    keyringSigning.resolve(keyringSignature())

    expect(await outcome).toMatchObject({ code: ErrorCodes.UserCancel })
    // The signature completes for a window that is gone.
    await expect(signing).resolves.toMatchObject({ psbtHex: expect.any(String) })
    await expectInputFree()
  })

  it('refuses to sign for a request that settled before the signature reached the wallet', async () => {
    let lateToSignData: ToSignData | undefined
    approvalWindow(async approval => {
      lateToSignData = approvalToSignData(approval)
      throw userCancel()
    })

    await expect(rpcFlow(sendRequest())).rejects.toMatchObject({ code: ErrorCodes.UserCancel })
    // The window's Sign arrives after the request was rejected and cleaned
    // up: nothing would be left to release the claim, so none is registered
    // and no one-time signature is spent.
    await expect(signInApprovalWindow(lateToSignData!)).rejects.toThrow(
      'provider send request is no longer pending'
    )

    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    await expectInputFree()
  })

  it('keeps the inputs reserved when the broadcast outcome is unknown', async () => {
    let claim: QbitSendBroadcastClaim | undefined
    approvalWindow(async approval => {
      claim = approvalClaim(approval)
      return [await signInApprovalWindow(approvalToSignData(approval))]
    })
    providerControllerMock.sendQbit.mockImplementationOnce(async () => {
      throw outcomeUnknownError(claim!)
    })

    await expect(rpcFlow(sendRequest())).rejects.toMatchObject({
      code: ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
    })

    // The node may hold the transaction: the claim goes, but its input
    // stays reserved as recently spent until a probe settles it.
    await expect(reservedOutpoints()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [SOURCE_OUTPOINT])
    ).rejects.toThrow('recent broadcast already spent')
  })

  it('never releases the claim of another request for the same transaction', async () => {
    const firstWindowCloses = deferred<void>()
    let firstSigned: (() => void) | undefined
    const firstSigning = new Promise<void>(resolve => {
      firstSigned = resolve
    })
    approvalWindow(async approval => {
      await signInApprovalWindow(approvalToSignData(approval))
      firstSigned!()
      await firstWindowCloses.promise
      throw userCancel()
    })
    const first = rpcFlow(sendRequest()).catch(error => error)
    await firstSigning
    await expectInputClaimed()

    // The dapp sends the same payment again while the first approval is
    // open: the second request fails, and its cleanup must leave the
    // first request's claim alone.
    approvalWindow(async () => {
      throw new Error('the second request must not reach an approval window')
    })
    await expect(rpcFlow(sendRequest())).rejects.toThrow()
    await expectInputClaimed()

    firstWindowCloses.resolve()
    expect(await first).toMatchObject({ code: ErrorCodes.UserCancel })
    await expectInputFree()
  })
})
