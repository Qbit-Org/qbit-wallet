import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PQC_SIGNATURE_BYTES,
  createP2mrMessageProof,
  hexToBytes,
  p2mrAddressFromPubkey,
} from '@qbit-oss/protocol'
import { SignMessageType } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

const walletMock = vi.hoisted(() => ({
  preflightP2mrMessageSigning: vi.fn(),
}))
const verifyPqcMock = vi.hoisted(() => vi.fn())

vi.mock('@qbit-oss/pqc', () => ({
  verify: verifyPqcMock,
}))

vi.mock('../src/controllers/wallet', () => ({
  default: walletMock,
}))

vi.mock('../src/services', () => ({
  permissionService: { hasPermission: vi.fn(() => true) },
  sessionService: { broadcastEvent: vi.fn() },
}))

const PUBKEY = hexToBytes('19'.repeat(32))
const ADDRESS = p2mrAddressFromPubkey(PUBKEY, 'regtest')
const MESSAGE = 'provider P2MR message'
const CONTEXT = {
  origin: 'https://dapp.example',
  account: ADDRESS,
  chain: ChainType.QBIT_REGTEST,
  network: 'regtest' as const,
}
const SIGNATURE_BUDGET = {
  required: 1,
  cached: 0,
  remainingBefore: 30,
  remainingAfter: 29,
  limit: 30,
}

function proof(message = MESSAGE) {
  return createP2mrMessageProof({
    message,
    address: ADDRESS,
    pubkey: PUBKEY,
    signature: new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x37),
  })
}

describe('ProviderController P2MR messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    walletMock.preflightP2mrMessageSigning.mockResolvedValue({
      accountAddress: ADDRESS,
      signatureBudget: SIGNATURE_BUDGET,
    })
    verifyPqcMock.mockReturnValue(true)
  })

  it('exposes only the canonical message methods', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default

    expect(provider.signMessage).toBeTypeOf('function')
    expect(provider.verifyMessage).toBeTypeOf('function')
    expect((provider as any).signP2mrMessage).toBeUndefined()
    expect((provider as any).verifyP2mrMessage).toBeUndefined()
    expect((provider as any).multiSignMessage).toBeUndefined()
  })

  it('binds approval to the exact text, account, context, and signature budget', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const metadata = Reflect.getMetadata('APPROVAL', provider, 'signMessage')
    const request = {
      data: { params: { text: MESSAGE } },
      providerContext: CONTEXT,
    }

    expect(metadata[0]).toBe('SignMessage')
    await metadata[1](request)
    expect(request.data.params).toEqual({
      text: MESSAGE,
      toSignMessages: [
        {
          text: MESSAGE,
          type: SignMessageType.P2MR,
          p2mrAccountAddress: ADDRESS,
          providerContext: CONTEXT,
          signatureBudget: SIGNATURE_BUDGET,
        },
      ],
    })
    expect(walletMock.preflightP2mrMessageSigning).toHaveBeenCalledWith([MESSAGE])

    const approvedProof = proof()
    await expect(
      provider.signMessage({
        data: { params: request.data.params },
        approvalRes: [{ proof: approvedProof }],
      } as any)
    ).resolves.toEqual(approvedProof)
  })

  it('preserves meaningful whitespace in the signed message', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const metadata = Reflect.getMetadata('APPROVAL', provider, 'signMessage')
    const text = ` \n${MESSAGE}\t `
    const request = {
      data: { params: { text } },
      providerContext: CONTEXT,
    }

    await metadata[1](request)

    expect(walletMock.preflightP2mrMessageSigning).toHaveBeenCalledWith([text])
    expect(request.data.params.toSignMessages[0].text).toBe(text)
  })

  it.each([
    ['missing', undefined, 'text is required'],
    ['null', null, 'text is required'],
    ['whitespace', ' \n\t ', 'text is required'],
    ['oversized', 'x'.repeat(10001), 'message is too long'],
  ])('rejects %s message text before preflight', async (_label, text, error) => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const metadata = Reflect.getMetadata('APPROVAL', provider, 'signMessage')
    const request = { data: { params: { text } }, providerContext: CONTEXT }

    await expect(metadata[1](request)).rejects.toThrow(error)
    expect(walletMock.preflightP2mrMessageSigning).not.toHaveBeenCalled()
  })

  it('rejects before approval when the P2MR signature budget is exhausted', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const metadata = Reflect.getMetadata('APPROVAL', provider, 'signMessage')
    const capacityError = new RangeError('PQC signature counter exhausted')
    walletMock.preflightP2mrMessageSigning.mockRejectedValueOnce(capacityError)

    await expect(
      metadata[1]({ data: { params: { text: MESSAGE } }, providerContext: CONTEXT })
    ).rejects.toBe(capacityError)
  })

  it('rejects absent or mismatched approved proofs', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const params = {
      text: MESSAGE,
      toSignMessages: [
        {
          text: MESSAGE,
          type: SignMessageType.P2MR,
          p2mrAccountAddress: ADDRESS,
        },
      ],
    }

    await expect(
      provider.signMessage({ data: { params }, approvalRes: [] } as any)
    ).rejects.toThrow('invalid P2MR message proof')
    await expect(
      provider.signMessage({
        data: {
          params: {
            ...params,
            toSignMessages: [{ ...params.toSignMessages[0], text: `${MESSAGE}!` }],
          },
        },
        approvalRes: [{ proof: proof() }],
      } as any)
    ).rejects.toThrow('does not match the approved request')
  })

  it('verifies only the exact address and text locally', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const validProof = proof()

    await expect(
      provider.verifyMessage({
        data: { params: { address: ADDRESS, text: MESSAGE, proof: validProof } },
      } as any)
    ).resolves.toBe(true)
    await expect(
      provider.verifyMessage({
        data: { params: { address: `${ADDRESS}x`, text: MESSAGE, proof: validProof } },
      } as any)
    ).resolves.toBe(false)
    await expect(
      provider.verifyMessage({
        data: { params: { address: ADDRESS, text: `${MESSAGE}!`, proof: validProof } },
      } as any)
    ).resolves.toBe(false)
  })

  it('returns false when verification is malformed or unavailable', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default

    await expect(
      provider.verifyMessage({
        data: { params: { address: ADDRESS, text: 'x'.repeat(10001), proof: proof() } },
      } as any)
    ).resolves.toBe(false)
    verifyPqcMock.mockImplementation(() => {
      throw new Error('PQC runtime is unavailable')
    })
    await expect(
      provider.verifyMessage({
        data: { params: { address: ADDRESS, text: MESSAGE, proof: proof() } },
      } as any)
    ).resolves.toBe(false)
  })
})
