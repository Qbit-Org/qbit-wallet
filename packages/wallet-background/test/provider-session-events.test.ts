import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

const grants = vi.hoisted(
  () =>
    new Map<string, { chain: ChainType; connected: boolean }>([
      ['https://mainnet.example', { chain: 'QBIT_MAINNET' as ChainType, connected: true }],
      ['https://testnet.example', { chain: 'QBIT_TESTNET4' as ChainType, connected: true }],
    ])
)
const permissionServiceMock = vi.hoisted(() => ({
  hasPermission: vi.fn((origin: string, chain?: ChainType) => {
    const grant = grants.get(origin)
    return Boolean(grant?.connected && (chain === undefined || grant.chain === chain))
  }),
}))

vi.mock('../src/services/permission', () => ({ default: permissionServiceMock }))

describe('Qbit provider session events', () => {
  afterEach(async () => {
    const { sessionService } = await import('../src/services/session')
    await sessionService.cleanup()
    grants.get('https://mainnet.example')!.connected = true
    grants.get('https://testnet.example')!.connected = true
    vi.clearAllMocks()
  })

  it('delivers account data only to matching-chain grants while chain events reach all grants', async () => {
    const { sessionService } = await import('../src/services/session')
    const mainnet = sessionService.getOrCreateSession(1) as any
    const testnet = sessionService.getOrCreateSession(2) as any
    mainnet.setProp({ origin: 'https://mainnet.example', name: 'Mainnet', icon: '' })
    testnet.setProp({ origin: 'https://testnet.example', name: 'Testnet', icon: '' })
    mainnet.pushMessage = vi.fn()
    testnet.pushMessage = vi.fn()

    sessionService.broadcastEvent(
      'accountsChanged',
      ['qb1zmainnet'],
      undefined,
      ChainType.QBIT_MAINNET
    )
    sessionService.broadcastEvent('chainChanged', ChainType.QBIT_MAINNET)

    expect(mainnet.pushMessage).toHaveBeenNthCalledWith(1, 'accountsChanged', ['qb1zmainnet'])
    expect(mainnet.pushMessage).toHaveBeenNthCalledWith(2, 'chainChanged', ChainType.QBIT_MAINNET)
    expect(testnet.pushMessage).toHaveBeenCalledOnce()
    expect(testnet.pushMessage).toHaveBeenCalledWith('chainChanged', ChainType.QBIT_MAINNET)
  })

  it('delivers targeted revocation events after revocation and blocks later events', async () => {
    const { sessionService } = await import('../src/services/session')
    const session = sessionService.getOrCreateSession(1) as any
    session.setProp({ origin: 'https://mainnet.example', name: 'Mainnet', icon: '' })
    session.pushMessage = vi.fn()

    grants.get('https://mainnet.example')!.connected = false
    sessionService.broadcastEvent('accountsChanged', [], 'https://mainnet.example', undefined, true)
    sessionService.broadcastEvent(
      'disconnect',
      { code: 4900, message: 'revoked' },
      'https://mainnet.example',
      undefined,
      true
    )
    sessionService.broadcastEvent('chainChanged', ChainType.QBIT_TESTNET4)

    expect(session.pushMessage.mock.calls).toEqual([
      ['accountsChanged', []],
      ['disconnect', { code: 4900, message: 'revoked' }],
    ])
  })

  it('resolves a tab to its newest provider session after an older port disconnects', async () => {
    const { sessionService } = await import('../src/services/session')
    const firstPort = {}
    const secondPort = {}
    const firstSession = sessionService.getOrCreateSession(firstPort, 17)
    const secondSession = sessionService.getOrCreateSession(secondPort, 17)

    expect(firstSession).not.toBe(secondSession)
    expect(sessionService.getSession(17)).toBe(secondSession)

    sessionService.deleteSession(firstPort)

    expect(sessionService.getSession(firstPort)).toBeUndefined()
    expect(sessionService.getSession(17)).toBe(secondSession)

    sessionService.deleteSession(secondPort)

    expect(sessionService.getSession(17)).toBeUndefined()
  })

  it('falls back to an older provider session after the newest port disconnects', async () => {
    const { sessionService } = await import('../src/services/session')
    const firstPort = {}
    const secondPort = {}
    const firstSession = sessionService.getOrCreateSession(firstPort, 17)
    const secondSession = sessionService.getOrCreateSession(secondPort, 17)

    expect(sessionService.getSession(17)).toBe(secondSession)

    sessionService.deleteSession(secondPort)

    expect(sessionService.getSession(secondPort)).toBeUndefined()
    expect(sessionService.getSession(17)).toBe(firstSession)

    sessionService.deleteSession(firstPort)

    expect(sessionService.getSession(17)).toBeUndefined()
  })

  it('clears tab aliases during cleanup', async () => {
    const { sessionService } = await import('../src/services/session')
    sessionService.getOrCreateSession({}, 17)

    await sessionService.cleanup()
    const numericSession = sessionService.getOrCreateSession(17)

    expect(sessionService.getSession(17)).toBe(numericSession)
  })
})
