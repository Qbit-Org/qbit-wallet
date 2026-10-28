import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorCodes } from '@qbit/wallet-shared'

const rpcFlowMock = vi.hoisted(() => vi.fn())
const tabCheckinMock = vi.hoisted(() => vi.fn())
const keyringServiceMock = vi.hoisted(() => ({ hasVault: vi.fn(() => true) }))

vi.mock('../src/controllers/provider/rpcFlow', () => ({ default: rpcFlowMock }))
vi.mock('../src/controllers/provider/internalMethod', () => ({
  default: { tabCheckin: tabCheckinMock },
}))
vi.mock('../src/services', () => ({ keyringService: keyringServiceMock }))

const EXPECTED_METHODS = [
  'requestAccounts',
  'getAccounts',
  'getPublicKey',
  'getBalance',
  'getNetwork',
  'switchNetwork',
  'getChain',
  'switchChain',
  'signMessage',
  'verifyMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'sendQbit',
  'disconnect',
] as const

function request(source: 'page' | 'content', method: string, origin = 'https://dapp.example') {
  return {
    source,
    data: { method },
    session: { origin, name: 'Dapp', icon: '' },
    port: {},
  }
}

describe('Qbit provider background routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    keyringServiceMock.hasVault.mockReturnValue(true)
    rpcFlowMock.mockResolvedValue('routed')
    tabCheckinMock.mockReturnValue('checked-in')
  })

  it('publishes exactly the approved V1 method allowlist', async () => {
    const { PUBLIC_PROVIDER_METHODS, INTERNAL_PROVIDER_METHODS } = await import(
      '../src/controllers/provider/methodList'
    )

    expect(PUBLIC_PROVIDER_METHODS).toEqual(EXPECTED_METHODS)
    expect(INTERNAL_PROVIDER_METHODS).toEqual(['tabCheckin'])
  })

  it.each(EXPECTED_METHODS)(
    'routes the public %s method only from a trusted page session',
    async method => {
      const provider = (await import('../src/controllers/provider')).default
      const req = request('page', method)

      await expect(provider.handleRequest(req as any)).resolves.toBe('routed')
      expect(rpcFlowMock).toHaveBeenCalledWith(req)
    }
  )

  it.each(['getProviderState', 'keepAlive', 'signP2mrMessage', 'verifyP2mrMessage', '_request'])(
    'rejects removed or private page method %s',
    async method => {
      const provider = (await import('../src/controllers/provider')).default

      await expect(provider.handleRequest(request('page', method) as any)).rejects.toMatchObject({
        code: ErrorCodes.METHOD_NOT_FOUND,
      })
      expect(rpcFlowMock).not.toHaveBeenCalled()
      expect(tabCheckinMock).not.toHaveBeenCalled()
    }
  )

  it('keeps internal and public method namespaces disjoint', async () => {
    const provider = (await import('../src/controllers/provider')).default

    await expect(
      provider.handleRequest(request('page', 'tabCheckin') as any)
    ).rejects.toMatchObject({
      code: ErrorCodes.METHOD_NOT_FOUND,
    })
    await expect(
      provider.handleRequest(request('content', 'getAccounts') as any)
    ).rejects.toMatchObject({
      code: ErrorCodes.METHOD_NOT_FOUND,
    })
    await expect(provider.handleRequest(request('content', 'tabCheckin') as any)).resolves.toBe(
      'checked-in'
    )
  })

  it('rejects public requests until the trusted origin check-in has populated the session', async () => {
    const provider = (await import('../src/controllers/provider')).default

    await expect(
      provider.handleRequest(request('page', 'getNetwork', '') as any)
    ).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
    })
    expect(rpcFlowMock).not.toHaveBeenCalled()
  })

  it('allows only non-sensitive reads and revocation when no vault exists', async () => {
    const provider = (await import('../src/controllers/provider')).default
    keyringServiceMock.hasVault.mockReturnValue(false)

    await expect(provider.handleRequest(request('page', 'getNetwork') as any)).resolves.toBe(
      'routed'
    )
    await expect(provider.handleRequest(request('page', 'disconnect') as any)).resolves.toBe(
      'routed'
    )
    await expect(
      provider.handleRequest(request('page', 'requestAccounts') as any)
    ).rejects.toMatchObject({
      code: ErrorCodes.NO_ACCOUNT,
    })
  })
})
