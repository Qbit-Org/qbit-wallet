import 'reflect-metadata'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { init, keygen, sign as pqcSign, verify as verifyPqc } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_SIGHASH_TYPE,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  type Psbt,
} from '@qbit-oss/protocol'
import { p2mrSigningOptionsFor } from '@qbit/keyring-service'
import {
  ErrorCodes,
  KeyringType,
  PsbtActionDetailType,
  psbtReviewOptions,
  type DecodedPsbt,
  type LocalPsbtSummary,
  type SignedData,
  type ToSignData,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import rpcFlow from '../src/controllers/provider/rpcFlow'
import wallet from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'

// The real provider flow, provider controller, wallet controller and send
// guard, for a website PSBT whose outputs exceed its inputs: a draft the
// account signs one input of, under 0x81 or 0x83, for others to fund later.
// The approval window reviews it with decodePsbt (and analyzeLocalPsbts for a
// batch) and signs it through signPsbtV2. Only the approval window and the
// keyring are stubbed: the stub signs with the real PQC scheme under the
// keyring service's own opt-ins (`p2mrSigningOptionsFor`), and the provider
// verifies the signatures it returns with the real scheme.
const approvalServiceMock = vi.hoisted(() => ({
  assertNoPendingApproval: vi.fn(async () => undefined),
  requestApproval: vi.fn(),
  unLock: vi.fn(),
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
      openP2mrPsbtSigningBatch: vi.fn(),
      hasOpenP2mrPsbtSigningBatches: vi.fn(() => true),
      releaseP2mrPsbtSigningBatches: vi.fn(),
      on: vi.fn(),
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
    sessionService: {},
    contactBookService: {},
  }
})

const ORIGIN = 'https://dapp.example'
const SINGLE_ANYONECANPAY = 0x83
const ALL_ANYONECANPAY = 0x81
const SINGLE_LEAF = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const SIGNATURE_BUDGET = {
  required: 1,
  cached: 0,
  remainingBefore: 30,
  remainingAfter: 29,
  limit: 30,
}

type Key = ReturnType<typeof partyKey>

function partyKey(fill: number) {
  const { publicKey, secretKey } = keygen(new Uint8Array(128).fill(fill))
  const leafScript = singleKeyLeafScript(publicKey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  return { publicKey, secretKey, leafScript, leafHash, scriptPubKey: p2mrScriptPubKey(leafHash) }
}

let accountKey: Key
let funderKey: Key
let account: ReturnType<typeof accountOf>

function accountOf(key: Key, type: KeyringType = KeyringType.QbitHdKeyring) {
  const pubkey = bytesToHex(key.publicKey)
  return {
    type,
    address: p2mrAddressFromPubkey(key.publicKey, 'regtest'),
    pubkey,
    key: 'account-0',
    flag: 0,
    index: 0,
    p2mr: {
      pubkey,
      leafScript: bytesToHex(key.leafScript),
      scriptPubKey: bytesToHex(key.scriptPubKey),
      signatureCounter: { count: 0, limit: 30, remaining: 30, state: 'normal' },
    },
  }
}

interface DraftInput {
  value: bigint
  hashType?: number
  /** The output it spends is under the account's leaf beside another's, not the account's own. */
  shared?: boolean
}

/**
 * A website PSBT spending the account's `inputs` (each an outpoint of its own
 * funding transaction) into `outputs`, each input naming its `hashType` in
 * `PSBT_IN_SIGHASH_TYPE`.
 */
function websitePsbt(
  inputs: DraftInput[],
  outputs: { value: bigint; scriptPubKey: Uint8Array }[],
  fundingTxSeed = 0xa1
) {
  const otherLeafHash = funderKey.leafHash
  const psbt = createP2mrPsbt({
    inputs: inputs.map((input, index) => {
      const root = input.shared
        ? p2mrBranchHash(accountKey.leafHash, otherLeafHash)
        : accountKey.leafHash
      return {
        prevout: { txid: new Uint8Array(32).fill(fundingTxSeed + index), vout: index },
        witnessUtxo: { value: input.value, scriptPubKey: p2mrScriptPubKey(root) },
        leafScript: accountKey.leafScript,
        controlBlock: input.shared
          ? buildControlBlock(P2MR_LEAF_VERSION_V1, [otherLeafHash])
          : SINGLE_LEAF,
        merkleRoot: root,
      }
    }),
    outputs,
  })
  inputs.forEach((input, index) => {
    if (input.hashType === undefined) return
    const value = new Uint8Array(4)
    new DataView(value.buffer).setUint32(0, input.hashType, true)
    psbt.inputs[index]!.push({ key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value })
  })
  return psbt
}

const hexOf = (psbt: Psbt): string => bytesToHex(serializePsbt(psbt))
const psbtOf = (hex: string): Psbt => parsePsbt(hexToBytes(hex))

/** The account's one coin, 50,000, under 0x83 against a payout of 80,000 to it: 30,000 short. */
function draft(hashType = SINGLE_ANYONECANPAY): Psbt {
  return websitePsbt(
    [{ value: 50_000n, hashType }],
    [{ value: 80_000n, scriptPubKey: accountKey.scriptPubKey }]
  )
}

function signPsbtRequest(psbtHex: string, options: Record<string, unknown> = {}) {
  return {
    data: {
      method: 'signPsbt',
      params: { psbtHex, options: { chain: ChainType.QBIT_REGTEST, ...options } },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  }
}

function signPsbtsRequest(psbtHexs: string[], options: Record<string, unknown>[]) {
  return {
    data: {
      method: 'signPsbts',
      params: {
        psbtHexs,
        options: options.map(option => ({ chain: ChainType.QBIT_REGTEST, ...option })),
      },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  }
}

let signatureCounter = 0
let approvals: ToSignData[][] = []
let reviews: DecodedPsbt[] = []
let batchSummaries: LocalPsbtSummary[] = []
/** What the approval window hands back, from what it signed; the signed result by default. */
let approvalResult: (signed: SignedData, toSignData: ToSignData) => SignedData = signed => signed

function expectNothingSigned() {
  expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
  expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  expect(keyringService.openP2mrPsbtSigningBatch).not.toHaveBeenCalled()
  expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  expect(signatureCounter).toBe(0)
}

describe('a website PSBT whose outputs exceed its inputs', () => {
  beforeAll(async () => {
    await init()
    accountKey = partyKey(0x11)
    funderKey = partyKey(0x55)
    account = accountOf(accountKey)
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    signatureCounter = 0
    approvals = []
    reviews = []
    batchSummaries = []
    approvalResult = signed => signed
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.spyOn(wallet, 'getAccounts').mockResolvedValue([account] as any)
    vi.spyOn(wallet, 'getFeeSummary').mockRejectedValue(new Error('no quote'))
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(SIGNATURE_BUDGET as any)
    vi.mocked(keyringService.openP2mrPsbtSigningBatch).mockResolvedValue({
      id: 'batch-1',
      budget: { required: 2, cached: 0, remainingBefore: 30, remainingAfter: 28, limit: 30 },
    })
    // The keyring's signing: under the opt-ins the keyring service derives
    // from the plan, with the account's real key.
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address, { psbt, keys }) => {
        const signed = signP2mrPsbt({
          psbt,
          keys,
          ...p2mrSigningOptionsFor(keys),
          sign: sighash => {
            signatureCounter += 1
            return pqcSign(accountKey.secretKey, sighash)
          },
        })
        return { ...signed, counterResults: [] } as any
      }
    )
    // The approval window reviews each PSBT it was handed, as the sign
    // screen asks for it, and the user signs each.
    approvalServiceMock.requestApproval.mockImplementation(async (approval, _window, onPending) => {
      onPending?.('approval-1')
      const toSignDatas: ToSignData[] = structuredClone(approval.params.data.toSignDatas)
      approvals.push(toSignDatas)
      if (toSignDatas.length > 1) batchSummaries.push(await wallet.analyzeLocalPsbts(toSignDatas))
      const results: SignedData[] = []
      for (const toSignData of toSignDatas) {
        reviews.push(
          await wallet.decodePsbt(toSignData.psbtHex, ORIGIN, psbtReviewOptions(toSignData))
        )
        results.push(approvalResult(await wallet.signPsbtV2(toSignData), toSignData))
      }
      return results
    })
  })

  it('signs the one coin of an account with no other coins, partial, and the signature holds once others fund it', async () => {
    const source = draft()
    const signedHex: string = await rpcFlow(signPsbtRequest(hexOf(source)))

    // Prepared to come back partial, with the shortfall leading its details.
    const [[toSign]] = approvals as [[ToSignData]]
    expect(toSign.autoFinalized).toBe(false)
    expect(toSign.qbitP2mrSigningKeys).toEqual([
      expect.objectContaining({ inputIndex: 0, hashType: SINGLE_ANYONECANPAY }),
    ])
    expect(toSign.action?.details?.[0]).toEqual(
      expect.objectContaining({ type: PsbtActionDetailType.SATOSHIS, value: 30_000, warning: true })
    )
    // The payout the signature commits to: output 0, to the account.
    expect(toSign.action?.details).toContainEqual(
      expect.objectContaining({ type: PsbtActionDetailType.ADDRESS, value: account.address })
    )
    expect(toSign.action?.details).toContainEqual(
      expect.objectContaining({ type: PsbtActionDetailType.SATOSHIS, value: 80_000 })
    )
    // Reviewed with its exact shortfall, never as a fee of zero.
    const [review] = reviews
    expect(review).toMatchObject({ fundingShortfall: 30_000, isCompleted: false, feeRate: 0 })
    expect(review!.spendSummary.feeAssessment).toBeUndefined()
    // Credited only up to the input that locks the payout in.
    expect(review!.spendSummary.netSpend).toBe(0)

    expect(signatureCounter).toBe(1)
    const signed = psbtOf(signedHex)
    const [input] = decodePsbt(signed, { allowOutputsAboveInputs: true }).inputs
    expect(input!.finalized).toBe(false)
    expect(input!.scriptSigs).toHaveLength(1)
    expect(input!.scriptSigs[0]!.signature.hashType).toBe(SINGLE_ANYONECANPAY)
    expect(() => finalizeP2mrPsbt(signed)).toThrow('exceeds total input value')

    // A buyer funds it later: an input of 60,000 and 25,000 back to itself,
    // a 5,000 fee. The account's signature, as returned, still verifies.
    const draftTx = psbtUnsignedTransaction(source)
    const funderUtxo = { value: 60_000n, scriptPubKey: funderKey.scriptPubKey }
    const funded = createP2mrPsbt({
      inputs: [
        {
          prevout: draftTx.inputs[0]!.prevout,
          witnessUtxo: decodePsbt(signed, { allowOutputsAboveInputs: true }).inputs[0]!
            .witnessUtxo!,
          leafScript: accountKey.leafScript,
          controlBlock: SINGLE_LEAF,
          merkleRoot: accountKey.leafHash,
        },
        {
          prevout: { txid: new Uint8Array(32).fill(0xf0), vout: 3 },
          witnessUtxo: funderUtxo,
          leafScript: funderKey.leafScript,
          controlBlock: SINGLE_LEAF,
          merkleRoot: funderKey.leafHash,
        },
      ],
      outputs: [draftTx.outputs[0]!, { value: 25_000n, scriptPubKey: funderKey.scriptPubKey }],
    })
    expect(decodePsbt(funded).fee).toBe(5_000n)
    funded.inputs[0]!.push(
      ...signed.inputs[0]!.filter(
        entry => entry.key[0] === PSBT_IN_P2MR_SCRIPT_SIG || entry.key[0] === PSBT_IN_SIGHASH_TYPE
      )
    )
    expect(
      verifyPqc(
        accountKey.publicKey,
        p2mrSighash({
          tx: psbtUnsignedTransaction(funded),
          inputIndex: 0,
          spentOutputs: [{ value: 50_000n, scriptPubKey: accountKey.scriptPubKey }, funderUtxo],
          leafHash: accountKey.leafHash,
          hashType: SINGLE_ANYONECANPAY,
        }),
        input!.scriptSigs[0]!.signature.signature
      )
    ).toBe(true)
    const complete = signP2mrPsbt({
      psbt: funded,
      keys: [{ inputIndex: 1, pubkey: funderKey.publicKey, leafHash: funderKey.leafHash }],
      sign: sighash => pqcSign(funderKey.secretKey, sighash),
    }).psbt
    expect(extractP2mrTransaction(finalizeP2mrPsbt(complete)).length).toBeGreaterThan(0)
  })

  it('signs a draft under 0x81 too, which commits to every output', async () => {
    const source = websitePsbt(
      [{ value: 50_000n, hashType: ALL_ANYONECANPAY }],
      [{ value: 80_000n, scriptPubKey: funderKey.scriptPubKey }]
    )
    const signedHex: string = await rpcFlow(
      signPsbtRequest(hexOf(source), { autoFinalized: false })
    )

    expect(signatureCounter).toBe(1)
    expect(
      decodePsbt(psbtOf(signedHex), { allowOutputsAboveInputs: true }).inputs[0]!.scriptSigs[0]!
        .signature.hashType
    ).toBe(ALL_ANYONECANPAY)
    expect(reviews[0]).toMatchObject({ fundingShortfall: 30_000, isCompleted: false })
    // Under 0x81 nothing is credited back: the whole input can leave.
    expect(reviews[0]!.spendSummary.netSpend).toBe(50_000)
  })

  it.each([
    ['outputs equal to its inputs, a fee of 0, finalized as before', 50_000n, true, undefined],
    ['outputs 1 above its inputs, returned partial', 50_001n, false, 1],
  ])('signs a PSBT with %s', async (_shape, payout, finalized, shortfall) => {
    const psbt = websitePsbt(
      [{ value: 50_000n, hashType: SINGLE_ANYONECANPAY }],
      [{ value: payout, scriptPubKey: accountKey.scriptPubKey }]
    )
    const signedHex: string = await rpcFlow(signPsbtRequest(hexOf(psbt)))

    expect(approvals[0]![0]!.autoFinalized).toBe(finalized)
    expect(reviews[0]!.fundingShortfall).toBe(shortfall)
    expect(reviews[0]!.isCompleted).toBe(finalized)
    expect(
      decodePsbt(psbtOf(signedHex), { allowOutputsAboveInputs: true }).inputs[0]!.finalized
    ).toBe(finalized)
  })

  it('refuses autoFinalized: true before approval and before any counter moves', async () => {
    await expect(
      rpcFlow(signPsbtRequest(hexOf(draft()), { autoFinalized: true }))
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message:
        'autoFinalized needs a PSBT this wallet can finalize after signing: ' +
        'its outputs exceed its inputs by 30000 sats',
    })
    expectNothingSigned()
  })

  it.each([
    [
      'an input under the default type',
      [{ value: 50_000n }],
      'input 0 is signed under the default sighash type',
    ],
    [
      'one input under 0x83 beside one under the default type',
      [{ value: 50_000n, hashType: SINGLE_ANYONECANPAY }, { value: 50_000n }],
      'input 1 is signed under the default sighash type',
    ],
    [
      'SIGHASH_NONE|ANYONECANPAY',
      [{ value: 50_000n, hashType: 0x82 }],
      'input 0 asks for sighash type 0x82',
    ],
    [
      'SIGHASH_SINGLE without ANYONECANPAY',
      [{ value: 50_000n, hashType: 0x03 }],
      'input 0 asks for sighash type 0x3',
    ],
    [
      "0x83 on an input that does not spend the account's own output",
      [{ value: 50_000n, hashType: SINGLE_ANYONECANPAY, shared: true }],
      "does not spend this account's own output",
    ],
  ])('refuses %s before approval and before any counter moves', async (_shape, inputs, message) => {
    const psbt = websitePsbt(inputs, [{ value: 150_000n, scriptPubKey: accountKey.scriptPubKey }])

    await expect(rpcFlow(signPsbtRequest(hexOf(psbt)))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining(message),
    })
    expectNothingSigned()
  })

  it('refuses a draft for an account whose signer is not in this wallet', async () => {
    const readonly = accountOf(accountKey, KeyringType.ReadonlyKeyring)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(readonly as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(readonly as any)

    await expect(rpcFlow(signPsbtRequest(hexOf(draft())))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining("this account's signer is not in this wallet"),
    })
    expectNothingSigned()
  })

  it('refuses a draft while a recovery migration signs, before any counter moves', async () => {
    vi.spyOn(
      wallet as unknown as { getQbitMigrationProtectedAssetCount: () => Promise<number> },
      'getQbitMigrationProtectedAssetCount'
    ).mockResolvedValue(1)

    await expect(rpcFlow(signPsbtRequest(hexOf(draft())))).rejects.toThrow(
      'only under the default sighash type'
    )
    expectNothingSigned()
  })

  it.each([
    [
      'a changed spent amount',
      (psbt: Psbt) => {
        const map = psbt.inputs[0]!
        const index = map.findIndex(entry => entry.key.length === 1 && entry.key[0] === 0x01)
        const tampered = websitePsbt(
          [{ value: 60_000n, hashType: SINGLE_ANYONECANPAY }],
          [{ value: 80_000n, scriptPubKey: accountKey.scriptPubKey }]
        ).inputs[0]!.find(entry => entry.key.length === 1 && entry.key[0] === 0x01)!
        map[index] = tampered
      },
      'signed PSBT changed an approved witness UTXO',
    ],
    [
      'signature bytes that do not verify',
      (psbt: Psbt) => {
        const entry = psbt.inputs[0]!.find(item => item.key[0] === PSBT_IN_P2MR_SCRIPT_SIG)!
        entry.value[0] = entry.value[0]! ^ 0xff
      },
      'invalid P2MR signature',
    ],
  ])('refuses a signed draft handed back with %s', async (_shape, tamper, message) => {
    approvalResult = signed => {
      const psbt = psbtOf(signed.psbtHex!)
      tamper(psbt)
      return { ...signed, psbtHex: hexOf(psbt) }
    }

    await expect(rpcFlow(signPsbtRequest(hexOf(draft())))).rejects.toThrow(message)
  })

  it('refuses to sign a draft outside its open approval, or prepared to be finalized', async () => {
    await rpcFlow(signPsbtRequest(hexOf(draft())))
    const [[toSign]] = approvals as [[ToSignData]]
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockClear()

    // Its approval has settled: no website admits these bytes any more.
    await expect(wallet.signPsbtV2(structuredClone(toSign))).rejects.toThrow(
      'This transaction spends more than its inputs and cannot be signed here'
    )
    // Inside an approval, but handed back to be finalized.
    approvalServiceMock.requestApproval.mockImplementationOnce(async (approval, _w, onPending) => {
      onPending?.('approval-2')
      const toSignData: ToSignData = structuredClone(approval.params.data.toSignDatas[0])
      return [await wallet.signPsbtV2({ ...toSignData, autoFinalized: true })]
    })
    await expect(rpcFlow(signPsbtRequest(hexOf(draft())))).rejects.toThrow(
      'This transaction spends more than its inputs and cannot be signed here'
    )
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('refuses to broadcast a signed draft before anything leaves the wallet', async () => {
    const signedHex: string = await rpcFlow(signPsbtRequest(hexOf(draft())))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      rpcFlow({
        data: { method: 'pushPsbt', params: { psbtHex: signedHex } },
        session: { origin: ORIGIN, name: 'Dapp', icon: '' },
      })
    ).rejects.toThrow('exceeds total input value')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signs a batch of a draft and a funded PSBT, each as its own options decide', async () => {
    // Another coin of the account under 0x83, funded: a 5,000 fee.
    const funded = websitePsbt(
      [{ value: 100_000n, hashType: SINGLE_ANYONECANPAY }],
      [{ value: 95_000n, scriptPubKey: funderKey.scriptPubKey }],
      0xb7
    )

    const signed: string[] = await rpcFlow(
      signPsbtsRequest([hexOf(draft()), hexOf(funded)], [{}, {}])
    )

    expect(signatureCounter).toBe(2)
    expect(keyringService.openP2mrPsbtSigningBatch).toHaveBeenCalledTimes(1)
    const [batch] = approvals
    expect(batch!.map(toSignData => toSignData.autoFinalized)).toEqual([false, true])
    const [summary] = batchSummaries
    expect(summary!.items[0]).toMatchObject({
      fundingShortfall: 30_000,
      isCompleted: false,
      fee: 0,
    })
    expect(summary!.items[1]).toMatchObject({ fee: 5_000, isCompleted: true })
    expect(summary!.items[1]).not.toHaveProperty('fundingShortfall')
    // Only the funded PSBT's fee counts as one.
    expect(summary!.totalFee).toBe(5_000)
    // The draft comes back partial; the funded PSBT, as before, finalized.
    expect(
      decodePsbt(psbtOf(signed[0]!), { allowOutputsAboveInputs: true }).inputs[0]!.finalized
    ).toBe(false)
    expect(extractP2mrTransaction(psbtOf(signed[1]!)).length).toBeGreaterThan(0)
  })

  it('refuses a batch whose draft asks to be finalized before its batch opens', async () => {
    const second = websitePsbt(
      [{ value: 50_000n, hashType: ALL_ANYONECANPAY }],
      [{ value: 80_000n, scriptPubKey: funderKey.scriptPubKey }],
      0xc3
    )

    await expect(
      rpcFlow(signPsbtsRequest([hexOf(draft()), hexOf(second)], [{}, { autoFinalized: true }]))
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining('autoFinalized needs a PSBT this wallet can finalize'),
    })
    // Entries are prepared in order: the first was preflighted, which reserves
    // nothing, and the refused one never was. No batch opened, nothing signed.
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(1)
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(keyringService.openP2mrPsbtSigningBatch).not.toHaveBeenCalled()
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(signatureCounter).toBe(0)
  })
})
