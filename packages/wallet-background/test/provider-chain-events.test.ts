import 'reflect-metadata'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

// End-to-end event sequences through the real session service: what each
// connected page receives when the active chain, a site setting or the lock
// state changes. Only storage-backed services are faked.

const grants = vi.hoisted(() => new Map<string, { chain: ChainType; isConnected: boolean }>())
const permissionServiceFake = vi.hoisted(() => ({
  hasPermission: (origin: string, chain?: ChainType) => {
    const grant = grants.get(origin)
    return Boolean(grant?.isConnected && (chain === undefined || grant.chain === chain))
  },
  updateConnectSite: vi.fn(
    async (origin: string, value: Partial<{ chain: ChainType; isConnected: boolean }>) => {
      const grant = grants.get(origin)
      if (grant) grants.set(origin, { ...grant, ...value })
    }
  ),
}))
const chainState = vi.hoisted(() => ({ current: 'QBIT_TESTNET4' as ChainType }))

vi.mock('../src/services/permission', () => ({ default: permissionServiceFake }))

vi.mock('../src/services', async () => {
  const { sessionService } =
    await vi.importActual<typeof import('../src/services/session')>('../src/services/session')
  return {
    keyringService: {
      syncQbitHdPath: vi.fn(async () => false),
      rearmQbitRestoreFloors: vi.fn(async () => false),
      setLocked: vi.fn(async () => undefined),
      memStore: { getState: () => ({ isUnlocked: true }) },
      keyrings: [],
    },
    preferenceService: {
      getChainType: () => chainState.current,
      setChainType: (chain: ChainType) => {
        chainState.current = chain
      },
      getCurrentAccount: () => ({ index: 0 }),
      getCurrentKeyringIndex: () => 0,
      setCurrentKeyringIndex: vi.fn(),
      setCurrentAccount: vi.fn(),
      getAddressFlag: () => 0,
      getAutoLockTimeId: () => 0,
      persist: vi.fn(async () => undefined),
    },
    walletApiService: { setEndpoint: vi.fn(async () => undefined) },
    sessionService,
    permissionService: permissionServiceFake,
    contactBookService: { listAlias: () => [] },
    notificationService: {},
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

const REQUESTER = 'https://requester.example'
const BYSTANDER = 'https://bystander.example'
const MAINNET_SITE = 'https://mainnet.example'
const REGTEST_SITE = 'https://regtest.example'
const REVOKED_SITE = 'https://revoked.example'

async function openPages() {
  const { sessionService } = await import('../src/services/session')
  const events = new Map<string, Array<[string, unknown]>>()
  for (const origin of [REQUESTER, BYSTANDER, MAINNET_SITE, REGTEST_SITE, REVOKED_SITE]) {
    const session = sessionService.getOrCreateSession({}) as any
    session.setProp({ origin, name: origin, icon: '' })
    const received: Array<[string, unknown]> = []
    session.pushMessage = (event: string, data: unknown) => received.push([event, data])
    events.set(origin, received)
  }
  return (origin: string) => events.get(origin)!
}

describe('provider events through the session service', () => {
  beforeEach(async () => {
    chainState.current = ChainType.QBIT_TESTNET4
    grants.clear()
    grants.set(REQUESTER, { chain: ChainType.QBIT_TESTNET4, isConnected: true })
    grants.set(BYSTANDER, { chain: ChainType.QBIT_TESTNET4, isConnected: true })
    grants.set(MAINNET_SITE, { chain: ChainType.QBIT_MAINNET, isConnected: true })
    grants.set(REGTEST_SITE, { chain: ChainType.QBIT_REGTEST, isConnected: true })
    grants.set(REVOKED_SITE, { chain: ChainType.QBIT_TESTNET4, isConnected: false })
    const wallet = (await import('../src/controllers/wallet')).default
    vi.spyOn(wallet, 'getCurrentKeyring').mockImplementation(
      async () =>
        ({
          index: 0,
          accounts: [
            {
              index: 0,
              address:
                chainState.current === ChainType.QBIT_MAINNET ? 'qb1zmainnet' : 'tq1ztestnet',
            },
          ],
        }) as any
    )
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    const { sessionService } = await import('../src/services/session')
    await sessionService.cleanup()
    vi.restoreAllMocks()
  })

  it('moves the requester onto the chain it asked for without ever reporting it disconnected', async () => {
    const received = await openPages()
    const provider = (await import('../src/controllers/provider/controller')).default

    await provider.switchChain({
      data: { params: { chain: ChainType.QBIT_MAINNET } },
      session: { origin: REQUESTER },
    } as any)

    expect(grants.get(REQUESTER)?.chain).toBe(ChainType.QBIT_MAINNET)
    expect(received(REQUESTER)).toEqual([
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
      ['accountsChanged', ['qb1zmainnet']],
    ])
    // Its grant stays on testnet4, so it can no longer read an account.
    expect(received(BYSTANDER)).toEqual([
      ['accountsChanged', []],
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
    ])
    // Its grant now matches the active chain again.
    expect(received(MAINNET_SITE)).toEqual([
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
      ['accountsChanged', ['qb1zmainnet']],
    ])
    // It could read nothing before and nothing after.
    expect(received(REGTEST_SITE)).toEqual([
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
    ])
    expect(received(REVOKED_SITE)).toEqual([])
  })

  it('announces a wallet-side switch without moving any grant', async () => {
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default

    await wallet.setChainType(ChainType.QBIT_MAINNET)

    expect(grants.get(REQUESTER)?.chain).toBe(ChainType.QBIT_TESTNET4)
    expect(received(REQUESTER)).toEqual([
      ['accountsChanged', []],
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
    ])
    expect(received(MAINNET_SITE)).toEqual([
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
      ['accountsChanged', ['qb1zmainnet']],
    ])
    expect(received(REVOKED_SITE)).toEqual([])
  })

  it('announces the switch and rejects when the requester grant cannot be moved', async () => {
    const received = await openPages()
    const provider = (await import('../src/controllers/provider/controller')).default
    const failure = new Error('permission storage failed')
    permissionServiceFake.updateConnectSite.mockRejectedValueOnce(failure)

    await expect(
      provider.switchChain({
        data: { params: { chain: ChainType.QBIT_MAINNET } },
        session: { origin: REQUESTER },
      } as any)
    ).rejects.toBe(failure)

    expect(chainState.current).toBe(ChainType.QBIT_MAINNET)
    expect(grants.get(REQUESTER)?.chain).toBe(ChainType.QBIT_TESTNET4)
    expect(received(REQUESTER)).toEqual([
      ['accountsChanged', []],
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
    ])
  })

  it('gives the requester its account when its grant moves onto an already active chain', async () => {
    // A wallet-side switch to mainnet ran first, while this request waited in the queue.
    chainState.current = ChainType.QBIT_MAINNET
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default

    await wallet.switchProviderChain(REQUESTER, ChainType.QBIT_MAINNET)

    expect(grants.get(REQUESTER)?.chain).toBe(ChainType.QBIT_MAINNET)
    expect(received(REQUESTER)).toEqual([['accountsChanged', ['qb1zmainnet']]])
    for (const origin of [BYSTANDER, MAINNET_SITE, REGTEST_SITE, REVOKED_SITE]) {
      expect(received(origin), origin).toEqual([])
    }
    // The unchanged account is not re-announced to every origin on the chain.
    expect(wallet.changeKeyring).toHaveBeenCalledWith(expect.anything(), 0, {
      persistPreference: true,
      broadcastAccountChange: false,
    })
  })

  it('tells no page anything when a site setting changes', async () => {
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default

    await wallet.updateConnectSite(REQUESTER, { allowQuickMultiSign: true })

    for (const origin of [REQUESTER, BYSTANDER, MAINNET_SITE, REGTEST_SITE, REVOKED_SITE]) {
      expect(received(origin), origin).toEqual([])
    }
  })

  it('tells only the affected origin when a site update moves its grant', async () => {
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default

    await wallet.updateConnectSite(REQUESTER, { chain: ChainType.QBIT_MAINNET })
    await wallet.updateConnectSite(MAINNET_SITE, { chain: ChainType.QBIT_TESTNET4 })

    expect(received(REQUESTER)).toEqual([['accountsChanged', []]])
    expect(received(MAINNET_SITE)).toEqual([['accountsChanged', ['tq1ztestnet']]])
    for (const origin of [BYSTANDER, REGTEST_SITE, REVOKED_SITE]) {
      expect(received(origin), origin).toEqual([])
    }
  })

  it('tells an origin revoked by a site update that it was disconnected', async () => {
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default
    const revoked = [
      ['accountsChanged', []],
      ['disconnect', { code: 4900, message: 'The origin was disconnected from Qbit Wallet.' }],
    ]

    await wallet.updateConnectSite(REQUESTER, { isConnected: false })
    // Granted on a chain other than the active one: nothing readable changes,
    // but the revocation is still announced.
    await wallet.updateConnectSite(REGTEST_SITE, { isConnected: false })

    expect(received(REQUESTER)).toEqual(revoked)
    expect(received(REGTEST_SITE)).toEqual(revoked)
    for (const origin of [BYSTANDER, MAINNET_SITE, REVOKED_SITE]) {
      expect(received(origin), origin).toEqual([])
    }
  })

  it('announces a grant update only after a chain switch already in progress', async () => {
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default
    let switchReachedKeyring!: () => void
    let finishSwitch!: () => void
    const reachedKeyring = new Promise<void>(resolve => {
      switchReachedKeyring = resolve
    })
    vi.mocked(wallet.changeKeyring).mockImplementationOnce(async () => {
      switchReachedKeyring()
      await new Promise<void>(resolve => {
        finishSwitch = resolve
      })
    })

    const chainSwitch = wallet.setChainType(ChainType.QBIT_MAINNET)
    await reachedKeyring
    // The active chain already reads as mainnet, but nothing is announced yet.
    const grantUpdate = wallet.updateConnectSite(BYSTANDER, { chain: ChainType.QBIT_MAINNET })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received(BYSTANDER)).toEqual([])
    finishSwitch()
    await Promise.all([chainSwitch, grantUpdate])

    expect(received(BYSTANDER)).toEqual([
      ['accountsChanged', []],
      ['chainChanged', ChainType.QBIT_MAINNET],
      ['networkChanged', 'mainnet'],
      ['accountsChanged', ['qb1zmainnet']],
    ])
  })

  it('does not report locking as a revocation', async () => {
    const received = await openPages()
    const wallet = (await import('../src/controllers/wallet')).default

    await wallet.lockWallet()

    for (const origin of [REQUESTER, BYSTANDER, MAINNET_SITE, REGTEST_SITE]) {
      expect(received(origin).map(([event]) => event), origin).toEqual(['lock'])
    }
    expect(received(REVOKED_SITE)).toEqual([])
    expect(grants.get(REQUESTER)).toEqual({ chain: ChainType.QBIT_TESTNET4, isConnected: true })
  })
})
