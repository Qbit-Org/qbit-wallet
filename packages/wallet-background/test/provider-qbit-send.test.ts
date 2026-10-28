import 'reflect-metadata'

import { createHash } from 'crypto'
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
  parsePsbt,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { ErrorCodes, KeyringType, WalletError } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

const verifyPqcMock = vi.hoisted(() => vi.fn())

vi.mock('@qbit-oss/pqc', () => ({
  verify: verifyPqcMock,
}))

const walletMock = vi.hoisted(() => ({
  acquireExternalQbitSigningLock: vi.fn(),
  broadcastQbitTx: vi.fn(),
  completeExternalQbitSigningLock: vi.fn(),
  createQbitSendBroadcastClaim: vi.fn(),
  createSendQbitPsbt: vi.fn(),
  getCurrentAccount: vi.fn(),
  getChainType: vi.fn(),
  prepareQbitProviderPsbt: vi.fn(),
  promoteExternalQbitSendBroadcastClaim: vi.fn(),
  pushTx: vi.fn(),
}))

const preferenceServiceMock = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
}))

vi.mock('../src/controllers/wallet', () => ({
  default: walletMock,
}))

vi.mock('../src/services', () => ({
  permissionService: { hasPermission: vi.fn(() => true) },
  preferenceService: preferenceServiceMock,
  sessionService: {},
}))

function externalSigningLock(purpose: 'send' | 'sign') {
  return {
    id: `external-${purpose}`,
    purpose,
    chain: ChainType.QBIT_REGTEST,
    address: 'qbrt1zfunding',
    origin: 'https://otc.example',
    entries: [
      {
        txid: '13'.repeat(32),
        outpoints: [{ txid: '35'.repeat(32), vout: 1 }],
      },
    ],
  } as const
}

describe('ProviderController qbit send', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyPqcMock.mockReturnValue(true)
    walletMock.getCurrentAccount.mockResolvedValue({
      type: KeyringType.ReadonlyKeyring,
      address: 'qbrt1zreadonly',
      pubkey: '11'.repeat(32),
      key: 'readonly',
      flag: 0,
    })
    walletMock.getChainType.mockReturnValue(ChainType.QBIT_REGTEST)
    walletMock.pushTx.mockResolvedValue('qbit-txid')
    walletMock.broadcastQbitTx.mockImplementation(async (_psbtHex, claim) => ({
      success: true,
      chain: claim.chain,
      txid: claim.txid,
      via: 'broadcast',
    }))
    walletMock.acquireExternalQbitSigningLock.mockResolvedValue(undefined)
    walletMock.completeExternalQbitSigningLock.mockResolvedValue(undefined)
    walletMock.promoteExternalQbitSendBroadcastClaim.mockResolvedValue(undefined)
    preferenceServiceMock.getCurrentAccount.mockReturnValue({ address: 'qbrt1zfunding' })
    walletMock.createQbitSendBroadcastClaim.mockImplementation((_psbtHex, context) => ({
      chain: context.chain,
      address: 'qbrt1zfunding',
      origin: context.origin,
      txid: '13'.repeat(32),
      outpoints: [{ txid: '35'.repeat(32), vout: 1 }],
    }))
  })

  it('routes sendQbit through the guarded SignPsbt approval surface', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const [approvalComponent] = Reflect.getMetadata('APPROVAL', provider, 'sendQbit')

    expect(approvalComponent).toBe('SignPsbt')
  })

  it('adds a wallet-owned broadcast claim to normal sendQbit approval data', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const [, sendApproval] = Reflect.getMetadata('APPROVAL', provider, 'sendQbit')
    const toSignData = {
      psbtHex: '70736274ff',
      toSignInputs: [],
      action: { name: 'Send QBT', description: '', details: [] },
    }
    walletMock.createSendQbitPsbt.mockResolvedValue(toSignData)
    const params = {
      sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
    }
    const providerContext = {
      origin: 'https://otc.example',
      account: 'qbrt1zprovidercontext',
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest',
    }
    const lock = externalSigningLock('send')
    walletMock.acquireExternalQbitSigningLock.mockResolvedValueOnce(lock)

    await sendApproval({ data: { params }, providerContext })

    expect(walletMock.createQbitSendBroadcastClaim).toHaveBeenCalledWith(
      toSignData.psbtHex,
      providerContext
    )
    expect(params).toHaveProperty('toSignDatas', [toSignData])
    expect(toSignData).toMatchObject({
      providerContext,
      qbitSendBroadcastClaim: {
        address: 'qbrt1zfunding',
        origin: 'https://otc.example',
      },
      qbitExternalSigningLock: lock,
    })
    expect(walletMock.acquireExternalQbitSigningLock).toHaveBeenCalledWith([toSignData], 'send')
  })

  it.each(['signPsbt', 'signPsbts'] as const)(
    'atomically acquires an external lock before %s approval',
    async method => {
      const provider = (await import('../src/controllers/provider/controller')).default
      const [, approval] = Reflect.getMetadata('APPROVAL', provider, method)
      const count = method === 'signPsbt' ? 1 : 2
      const pubkey = hexToBytes('77'.repeat(32))
      const leafScript = singleKeyLeafScript(pubkey)
      const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
      const sourcePsbtHex = bytesToHex(
        serializePsbt(
          createP2mrPsbt({
            inputs: [
              {
                prevout: { txid: hexToBytes('cd'.repeat(32)), vout: 0 },
                witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
                leafScript,
                controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
                merkleRoot: leafHash,
              },
            ],
            outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
          })
        )
      )
      const toSignDatas = Array.from({ length: count }, () => ({
        psbtHex: sourcePsbtHex,
        toSignInputs: [],
        qbitP2mrSigningKeys: [
          { inputIndex: 0, publicKey: bytesToHex(pubkey), leafHash: bytesToHex(leafHash) },
        ],
      }))
      toSignDatas.forEach(toSignData =>
        walletMock.prepareQbitProviderPsbt.mockResolvedValueOnce(toSignData)
      )
      const lock = {
        ...externalSigningLock('sign'),
        entries: toSignDatas.map((_, index) => ({
          txid: `${index + 1}`.padStart(64, '0'),
          outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }],
        })),
      }
      walletMock.acquireExternalQbitSigningLock.mockResolvedValueOnce(lock)
      const providerContext = {
        origin: 'https://otc.example',
        account: 'qbrt1zprovidercontext',
        chain: ChainType.QBIT_REGTEST,
        network: 'regtest',
      }
      const params =
        method === 'signPsbt'
          ? { psbtHex: sourcePsbtHex, options: { chain: ChainType.QBIT_REGTEST } }
          : {
              psbtHexs: [sourcePsbtHex, sourcePsbtHex],
              options: [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_REGTEST }],
            }

      await approval({
        data: { params },
        providerContext,
        session: { origin: providerContext.origin },
      })

      expect(walletMock.acquireExternalQbitSigningLock).toHaveBeenCalledWith(toSignDatas, 'sign')
      expect((params as any).toSignDatas).toEqual(
        toSignDatas.map(toSignData => ({
          ...toSignData,
          providerContext,
          qbitExternalSigningLock: lock,
        }))
      )
    }
  )

  it('marks every entry of a duplicated signPsbts PSBT for the cache-shift tolerance', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const [, approval] = Reflect.getMetadata('APPROVAL', provider, 'signPsbts')
    const pubkey = hexToBytes('77'.repeat(32))
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const psbtHexWithOutputValue = (value: bigint) =>
      bytesToHex(
        serializePsbt(
          createP2mrPsbt({
            inputs: [
              {
                prevout: { txid: hexToBytes('cd'.repeat(32)), vout: 0 },
                witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
                leafScript,
                controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
                merkleRoot: leafHash,
              },
            ],
            outputs: [{ value, scriptPubKey: p2mrScriptPubKey(leafHash) }],
          })
        )
      )
    const duplicatedPsbtHex = psbtHexWithOutputValue(40_000n)
    const uniquePsbtHex = psbtHexWithOutputValue(39_000n)
    const psbtHexs = [duplicatedPsbtHex, uniquePsbtHex, duplicatedPsbtHex]
    walletMock.prepareQbitProviderPsbt.mockImplementation(async psbtHex => ({
      psbtHex,
      toSignInputs: [],
    }))
    const params = {
      psbtHexs,
      options: psbtHexs.map(() => ({ chain: ChainType.QBIT_REGTEST })),
    }

    await approval({ data: { params }, session: { origin: 'https://otc.example' } })

    // Entries may be signed in any order, so the first prepared duplicate
    // needs the tolerance as much as later ones; unique entries stay strict.
    expect(
      (params as any).toSignDatas.map(
        (toSignData: any) => toSignData.qbitApprovedBatchDuplicate === true
      )
    ).toEqual([true, false, true])
  })

  it('keeps the prepared signPsbts entries for the request cleanup when a later entry is refused', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const [, approval] = Reflect.getMetadata('APPROVAL', provider, 'signPsbts')
    const pubkey = hexToBytes('77'.repeat(32))
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const psbtHex = bytesToHex(
      serializePsbt(
        createP2mrPsbt({
          inputs: [
            {
              prevout: { txid: hexToBytes('cd'.repeat(32)), vout: 0 },
              witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
              leafScript,
              controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
              merkleRoot: leafHash,
            },
          ],
          outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
        })
      )
    )
    const prepared = {
      psbtHex,
      toSignInputs: [],
      signatureBudget: { restoredFloorRisk: { challengeId: 'challenge-a' } },
    }
    const refusal = new WalletError(ErrorCodes.INVALID_PARAMS, 'autoFinalized cannot be met')
    walletMock.prepareQbitProviderPsbt
      .mockResolvedValueOnce(prepared)
      .mockRejectedValueOnce(refusal)
    const params = {
      psbtHexs: [psbtHex, psbtHex],
      options: [
        { chain: ChainType.QBIT_REGTEST, autoFinalized: true },
        { chain: ChainType.QBIT_REGTEST, autoFinalized: true },
      ],
    }

    await expect(
      approval({ data: { params }, session: { origin: 'https://otc.example' } })
    ).rejects.toBe(refusal)

    // rpcFlow's failure cleanup releases the challenges it finds here.
    expect((params as any).toSignDatas).toEqual([prepared])
    expect(walletMock.acquireExternalQbitSigningLock).not.toHaveBeenCalled()
  })

  it.each(['signPsbt', 'signPsbts'] as const)(
    'completes the external signing lock after guarded %s signing',
    async method => {
      const provider = (await import('../src/controllers/provider/controller')).default
      const pubkey = hexToBytes('66'.repeat(32))
      const leafScript = singleKeyLeafScript(pubkey)
      const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
      const scriptPubKey = p2mrScriptPubKey(leafHash)
      const psbt = createP2mrPsbt({
        inputs: [
          {
            prevout: { txid: hexToBytes('ab'.repeat(32)), vout: 0 },
            witnessUtxo: { value: 50_000n, scriptPubKey },
            leafScript,
            controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
            merkleRoot: leafHash,
          },
        ],
        outputs: [{ value: 40_000n, scriptPubKey }],
      })
      const signed = signP2mrPsbt({
        psbt,
        keys: [{ inputIndex: 0, pubkey, leafHash }],
        sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(6),
      }).psbt
      const sourcePsbtHex = bytesToHex(serializePsbt(psbt))
      const toSignData = {
        psbtHex: sourcePsbtHex,
        toSignInputs: [],
        autoFinalized: true,
        qbitP2mrSigningKeys: [
          {
            inputIndex: 0,
            publicKey: bytesToHex(pubkey),
            leafHash: bytesToHex(leafHash),
          },
        ],
      }
      const request =
        method === 'signPsbt'
          ? {
              data: { params: { toSignDatas: [toSignData] } },
              approvalRes: [{ psbtHex: bytesToHex(serializePsbt(signed)) }],
            }
          : {
              data: { params: { psbtHexs: [sourcePsbtHex], toSignDatas: [toSignData] } },
              approvalRes: [{ psbtHex: bytesToHex(serializePsbt(signed)) }],
            }

      await expect(provider[method](request as any)).resolves.toBeTruthy()

      const lock = {
        ...externalSigningLock('sign'),
        entries: [
          {
            txid: '14'.repeat(32),
            outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }],
          },
        ],
      }
      Object.assign(toSignData, { qbitExternalSigningLock: lock })
      await expect(provider[method](request as any)).resolves.toBeTruthy()
      expect(walletMock.completeExternalQbitSigningLock).toHaveBeenCalledWith(lock)
    }
  )

  it('returns a partially signed PSBT with an input another signer already finalized', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const p2mrInput = (pubkey: Uint8Array, txidByte: string) => {
      const leafScript = singleKeyLeafScript(pubkey)
      const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
      return {
        key: { inputIndex: 0, pubkey, leafHash },
        input: {
          prevout: { txid: hexToBytes(txidByte.repeat(32)), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      }
    }
    const own = p2mrInput(hexToBytes('66'.repeat(32)), 'ab')
    const other = p2mrInput(hexToBytes('88'.repeat(32)), 'ac')
    const psbt = createP2mrPsbt({
      inputs: [own.input, other.input],
      outputs: [{ value: 90_000n, scriptPubKey: own.input.witnessUtxo.scriptPubKey }],
    })
    const otherKey = { ...other.key, inputIndex: 1 }
    const otherFinalized = finalizeP2mrPsbt(
      signP2mrPsbt({
        psbt,
        keys: [own.key, otherKey],
        sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(5),
      }).psbt
    )
    // The request arrives with the other signer's input already finalized.
    const sourcePsbt = { ...psbt, inputs: [psbt.inputs[0]!, otherFinalized.inputs[1]!] }
    const signed = signP2mrPsbt({
      psbt: sourcePsbt,
      keys: [own.key],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(6),
    }).psbt
    const toSignData = {
      psbtHex: bytesToHex(serializePsbt(sourcePsbt)),
      toSignInputs: [],
      autoFinalized: false,
      qbitP2mrSigningKeys: [
        {
          inputIndex: 0,
          publicKey: bytesToHex(own.key.pubkey),
          leafHash: bytesToHex(own.key.leafHash),
        },
      ],
    }
    const signPsbt = (approvedPsbt: typeof signed, autoFinalized = false) =>
      provider.signPsbt({
        data: { params: { toSignDatas: [{ ...toSignData, autoFinalized }] } },
        approvalRes: [{ psbtHex: bytesToHex(serializePsbt(approvedPsbt)) }],
      } as any)

    await expect(signPsbt(signed)).resolves.toBe(bytesToHex(serializePsbt(signed)))
    await expect(signPsbt(signed, true)).resolves.toBe(
      bytesToHex(serializePsbt(finalizeP2mrPsbt(signed)))
    )
    // The approval itself finalizing the account's input is still refused.
    await expect(signPsbt(finalizeP2mrPsbt(signed))).rejects.toThrow(
      'approval returned a finalized PSBT when partial signing was requested'
    )
    // So is a result that swaps the other signer's final witness.
    const otherRefinalized = finalizeP2mrPsbt(
      signP2mrPsbt({
        psbt,
        keys: [own.key, otherKey],
        sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
      }).psbt
    )
    const swapped = { ...signed, inputs: [signed.inputs[0]!, otherRefinalized.inputs[1]!] }
    // Or keeps the witness but rewrites the other input's witness UTXO.
    const otherRevalued = finalizeP2mrPsbt(
      signP2mrPsbt({
        psbt: createP2mrPsbt({
          inputs: [
            own.input,
            { ...other.input, witnessUtxo: { ...other.input.witnessUtxo, value: 60_000n } },
          ],
          outputs: [{ value: 90_000n, scriptPubKey: own.input.witnessUtxo.scriptPubKey }],
        }),
        keys: [own.key, otherKey],
        sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(5),
      }).psbt
    )
    const revalued = { ...signed, inputs: [signed.inputs[0]!, otherRevalued.inputs[1]!] }
    for (const changed of [swapped, revalued]) {
      for (const autoFinalized of [false, true]) {
        await expect(signPsbt(changed, autoFinalized)).rejects.toThrow(
          'signed PSBT changed an input finalized before approval'
        )
      }
    }
  })

  it('validates readonly qbit P2MR PSBTs and preserves local claim validation', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const pubkey = hexToBytes('11'.repeat(32))
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const scriptPubKey = p2mrScriptPubKey(leafHash)
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes('aa'.repeat(32)), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 40_000n, scriptPubKey }],
    })
    const signed = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(3),
    }).psbt
    const signedPsbtHex = bytesToHex(serializePsbt(signed))
    const finalizedPsbtHex = bytesToHex(serializePsbt(finalizeP2mrPsbt(signed)))
    const claim = {
      chain: ChainType.QBIT_REGTEST,
      address: 'qbrt1zfunding',
      origin: 'https://otc.example',
      txid: '13'.repeat(32),
      outpoints: [{ txid: '35'.repeat(32), vout: 1 }],
    }
    const externalLock = externalSigningLock('send')
    const toSignData = {
      psbtHex: bytesToHex(serializePsbt(psbt)),
      toSignInputs: [],
      autoFinalized: true,
      qbitP2mrSigningKeys: [
        {
          inputIndex: 0,
          publicKey: bytesToHex(pubkey),
          leafHash: bytesToHex(leafHash),
        },
      ],
      qbitSendBroadcastClaim: claim,
      qbitExternalSigningLock: externalLock,
    }

    await expect(
      provider.sendQbit({
        data: {
          params: {
            sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
            toSignDatas: [toSignData],
          },
        },
        approvalRes: [{ psbtHex: signedPsbtHex }],
      } as any)
    ).resolves.toBe(claim.txid)

    expect(walletMock.promoteExternalQbitSendBroadcastClaim).toHaveBeenCalledWith({
      psbtHex: toSignData.psbtHex,
      claim,
      lock: externalLock,
      providerContext: undefined,
    })
    // The send goes out through the wallet's verdict-reporting broadcast,
    // bound to the claim's network and txid, never through the bare pushTx.
    expect(walletMock.broadcastQbitTx).toHaveBeenCalledWith(
      finalizedPsbtHex,
      toSignData.qbitSendBroadcastClaim,
      claim.chain,
      claim.txid
    )
    expect(walletMock.pushTx).not.toHaveBeenCalled()

    const localToSignData = { ...toSignData, qbitExternalSigningLock: undefined }
    await expect(
      provider.sendQbit({
        data: {
          params: {
            sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
            toSignDatas: [localToSignData],
          },
        },
        approvalRes: [{ psbtHex: signedPsbtHex, qbitSendBroadcastClaim: claim }],
      } as any)
    ).resolves.toBe(claim.txid)

    expect(walletMock.broadcastQbitTx).toHaveBeenLastCalledWith(
      finalizedPsbtHex,
      claim,
      claim.chain,
      claim.txid
    )

    verifyPqcMock.mockReturnValueOnce(false)
    await expect(
      provider.sendQbit({
        data: {
          params: {
            sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
            toSignDatas: [toSignData],
          },
        },
        approvalRes: [{ psbtHex: signedPsbtHex }],
      } as any)
    ).rejects.toThrow('invalid P2MR signature')
    expect(walletMock.broadcastQbitTx).toHaveBeenCalledTimes(2)
  })

  it('reports a sendQbit broadcast verdict to the dapp, naming the transaction when the outcome is unknown', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const pubkey = hexToBytes('11'.repeat(32))
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const scriptPubKey = p2mrScriptPubKey(leafHash)
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes('aa'.repeat(32)), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 40_000n, scriptPubKey }],
    })
    const signed = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(3),
    }).psbt
    const claim = {
      chain: ChainType.QBIT_REGTEST,
      address: 'qbrt1zfunding',
      origin: 'https://otc.example',
      txid: '13'.repeat(32),
      outpoints: [{ txid: '35'.repeat(32), vout: 1 }],
    }
    const request = {
      data: {
        params: {
          sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
          toSignDatas: [
            {
              psbtHex: bytesToHex(serializePsbt(psbt)),
              toSignInputs: [],
              autoFinalized: true,
              qbitP2mrSigningKeys: [
                { inputIndex: 0, publicKey: bytesToHex(pubkey), leafHash: bytesToHex(leafHash) },
              ],
              qbitSendBroadcastClaim: claim,
            },
          ],
        },
      },
      approvalRes: [{ psbtHex: bytesToHex(serializePsbt(signed)), qbitSendBroadcastClaim: claim }],
    } as any

    // The answer was lost, and the follow-up lookup found the transaction.
    walletMock.broadcastQbitTx.mockResolvedValueOnce({
      success: true,
      chain: claim.chain,
      txid: claim.txid,
      via: 'lookup',
    })
    await expect(provider.sendQbit(request)).resolves.toBe(claim.txid)

    // Proven not sent: a plain failure, which lets the request's cleanup
    // release the claim.
    walletMock.broadcastQbitTx.mockResolvedValueOnce({
      success: false,
      chain: claim.chain,
      txid: claim.txid,
      outcome: 'not_sent',
      reason: 'rejected',
      lookup: 'gone',
      detail: 'bad-txns-inputs-missingorspent',
    })
    const notSent = await provider.sendQbit(request).catch(error => error)
    expect(notSent).toBeInstanceOf(Error)
    expect(notSent.message).toBe('bad-txns-inputs-missingorspent')
    expect(notSent.code).toBeUndefined()

    // Inconclusive: the node may hold the transaction. The dapp gets a
    // distinct code and the txid to check instead of a plain failure it
    // would retry into a second payment.
    walletMock.broadcastQbitTx.mockResolvedValueOnce({
      success: false,
      chain: claim.chain,
      txid: claim.txid,
      outcome: 'unknown',
      reason: 'timeout',
      lookup: 'unavailable',
    })
    const unknown = await provider.sendQbit(request).catch(error => error)
    expect(unknown.code).toBe(ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN)

    // A claim the guard no longer holds may be what a lost success left
    // behind: still an unknown outcome, never a plain failure.
    walletMock.broadcastQbitTx.mockResolvedValueOnce({
      success: false,
      chain: claim.chain,
      txid: claim.txid,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
      detail: 'Qbit send broadcast claim is not active',
    })
    const inactive = await provider.sendQbit(request).catch(error => error)
    expect(inactive.code).toBe(ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN)
    expect(unknown.code).toBe(ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN)
    // In the JSON-RPC server-error range, so the page provider keeps it.
    expect(unknown.code).toBe(-32010)
    expect(unknown.data).toEqual({ outcome: 'unknown', chain: claim.chain, txid: claim.txid })
    expect(unknown.message).toMatch(/outcome is unknown/)
    // An unexpected throw may come after dispatch: unknown, never a plain failure.
    walletMock.broadcastQbitTx.mockRejectedValueOnce(new Error('port closed'))
    const thrown = await provider.sendQbit(request).catch(error => error)
    expect(thrown.code).toBe(ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN)
    expect(thrown.data).toEqual({ outcome: 'unknown', chain: claim.chain, txid: claim.txid })
    expect(walletMock.broadcastQbitTx).toHaveBeenCalledTimes(5)
    expect(walletMock.pushTx).not.toHaveBeenCalled()
  })

  it('rejects a signed normal-send claim that does not match the approved claim', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const claim = {
      chain: ChainType.QBIT_REGTEST,
      address: 'qbrt1zfunding',
      origin: 'https://otc.example',
      txid: '13'.repeat(32),
      outpoints: [{ txid: '35'.repeat(32), vout: 1 }],
    }

    await expect(
      provider.sendQbit({
        data: {
          params: {
            sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
            toSignDatas: [
              {
                psbtHex: '70736274ff',
                toSignInputs: [],
                qbitSendBroadcastClaim: claim,
              },
            ],
          },
        },
        approvalRes: [
          {
            psbtHex: '70736274ff',
            qbitSendBroadcastClaim: { ...claim, origin: 'https://other.example' },
          },
        ],
      } as any)
    ).rejects.toThrow('invalid Qbit send broadcast claim')

    expect(walletMock.broadcastQbitTx).not.toHaveBeenCalled()
  })

  it('pushes Qbit PSBTs without generic transaction formatting', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const pubkey = hexToBytes('22'.repeat(32))
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const scriptPubKey = p2mrScriptPubKey(leafHash)
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes('cc'.repeat(32)), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 40_000n, scriptPubKey }],
    })
    const psbtHex = bytesToHex(serializePsbt(psbt))

    await expect(
      provider.pushPsbt({
        data: {
          params: {
            psbtHex,
          },
        },
      } as any)
    ).resolves.toBe('qbit-txid')

    expect(walletMock.pushTx).toHaveBeenCalledWith(psbtHex)
  })

  it('rejects non-hex PSBT encodings instead of invoking a fallback parser', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const pubkey = hexToBytes('33'.repeat(32))
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const scriptPubKey = p2mrScriptPubKey(leafHash)
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes('dd'.repeat(32)), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 40_000n, scriptPubKey }],
    })
    const psbtBytes = serializePsbt(psbt)
    const psbtBase64 = Buffer.from(psbtBytes).toString('base64')

    await expect(
      provider.pushPsbt({
        data: {
          params: {
            psbtHex: psbtBase64,
          },
        },
      } as any)
    ).rejects.toThrow('invalid psbt')

    expect(walletMock.pushTx).not.toHaveBeenCalled()
  })
})
