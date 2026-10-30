import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUS_EVENTS,
  BUS_METHODS,
  ErrorCodes,
  QBIT_REGTEST_GENESIS_HASH,
  QBIT_REGTEST_ORIGIN,
  REGTEST_ACCESS_ACK_VERSION,
} from '@qbit/wallet-shared'
import { KeyringType } from '@qbit/keyring-service/types'
import { ChainType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import {
  keyringService,
  preferenceService,
  sessionService,
  walletApiService,
} from '../src/services'
import regtestAccessService, {
  type RegtestAccessAckStore,
  type RegtestAccessAdapter,
} from '../src/services/regtestAccess'
import { bgEventBus } from '../src/utils/eventBus'
import { observeQbitPqcSignatureActivity } from '../src/utils/qbit-api'

vi.mock('../src/services', () => ({
  keyringService: {
    getAllDisplayedKeyrings: vi.fn(),
    submitPassword: vi.fn(),
    syncQbitHdPath: vi.fn(),
    rearmQbitRestoreFloors: vi.fn(),
    restorePqcSignatureCounterFloors: vi.fn(),
    memStore: { getState: vi.fn(() => ({ isUnlocked: true })) },
    setLocked: vi.fn(async () => undefined),
    keyrings: [],
  },
  preferenceService: {
    getCurrentKeyringIndex: vi.fn(() => 0),
    getChainType: vi.fn(() => ChainType.QBIT_MAINNET),
    setCurrentKeyringIndex: vi.fn(),
    setCurrentAccount: vi.fn(),
    getCurrentAccount: vi.fn(() => ({ index: 0 })),
    getKeyringAlianName: vi.fn((_: string, defaultName: string) => defaultName),
    getAccountAlianName: vi.fn((_: string, defaultName: string) => defaultName),
    getAddressFlag: vi.fn(() => 0),
    getAutoLockTimeId: vi.fn(() => 0),
    getInitAlianNameStatus: vi.fn(() => true),
    setChainType: vi.fn(),
    persist: vi.fn(async () => undefined),
    getRegtestAccessAck: vi.fn(),
    setRegtestAccessAck: vi.fn(),
  },
  walletApiService: {
    setEndpoint: vi.fn(async () => undefined),
  },
  sessionService: {
    broadcastEvent: vi.fn(),
    broadcastChainChange: vi.fn(),
  },
  contactBookService: {
    listAlias: vi.fn(() => []),
  },
  notificationService: {},
  permissionService: {
    removeConnectedSite: vi.fn(),
  },
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

vi.mock('../src/utils/qbit-api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/qbit-api')>()
  return {
    ...actual,
    observeQbitPqcSignatureActivity: vi.fn(),
  }
})

const MAINNET_ENDPOINT = 'https://mempool.qbit.org/api'
const REGTEST_HD_PATH = "m/87'/1'/0'/0"
const MAINNET_HD_PATH = "m/87'/0'/0'/0"

function textResponse(
  body: string,
  init: { status?: number; contentType?: string } = {}
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/plain' },
  })
}

function healthyFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/block-height/0')) return textResponse(QBIT_REGTEST_GENESIS_HASH)
    if (url.endsWith('/blocks/tip/height')) return textResponse('5')
    throw new TypeError(`unexpected ${url}`)
  })
}

function createAdapter(overrides: Partial<RegtestAccessAdapter> & { optional?: boolean } = {}) {
  const listeners: Array<() => void> = []
  const adapter: RegtestAccessAdapter = {
    isOptionalPermission: vi.fn(() => overrides.optional ?? true),
    containsPermission: vi.fn(async () => false),
    onPermissionRemoved: vi.fn((listener: () => void) => {
      listeners.push(listener)
    }),
    ...overrides,
  }
  return { adapter, fireRemoved: () => listeners.forEach(listener => listener()) }
}

function createAckStore(initial?: string): RegtestAccessAckStore & { value: string | undefined } {
  const store = {
    value: initial,
    get: () => store.value,
    set: vi.fn(async (ack: string | undefined) => {
      store.value = ack
    }),
  }
  return store
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

function trackChain(initial: ChainType) {
  let current = initial
  vi.mocked(preferenceService.getChainType).mockImplementation(() => current)
  vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
    current = chainType
  })
  return () => current
}

function prepareWallet() {
  const wallet = new WalletController()
  const currentKeyring = { index: 0, accounts: [{}] }
  vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
  const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
  return { wallet, changeKeyring }
}

function expectNoChainMutation() {
  expect(keyringService.syncQbitHdPath).not.toHaveBeenCalled()
  expect(keyringService.rearmQbitRestoreFloors).not.toHaveBeenCalled()
  expect(preferenceService.setChainType).not.toHaveBeenCalled()
  expect(walletApiService.setEndpoint).not.toHaveBeenCalled()
  expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
  expect(sessionService.broadcastChainChange).not.toHaveBeenCalled()
}

describe('WalletController local regtest capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    regtestAccessService.removeAllListeners()
    vi.mocked(keyringService.syncQbitHdPath).mockResolvedValue(false)
    vi.mocked(keyringService.rearmQbitRestoreFloors).mockResolvedValue(false)
    vi.mocked(keyringService.memStore.getState).mockReturnValue({ isUnlocked: true })
    vi.mocked(preferenceService.persist).mockResolvedValue(undefined)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    vi.spyOn(log, 'error').mockImplementation(() => {})
  })

  it('rejects a direct regtest switch while locked without mutating any chain state', async () => {
    trackChain(ChainType.QBIT_MAINNET)
    const { wallet, changeKeyring } = prepareWallet()
    const { adapter } = createAdapter()
    const fetch = healthyFetch()
    wallet.initRegtestAccess({ adapter, fetch, ackStore: createAckStore() })

    await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
    await expect(wallet.setNetworkType(2 as any)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
    expectNoChainMutation()
    expect(changeKeyring).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(adapter.containsPermission).toHaveBeenCalled()
  })

  it('does not let a spoofed UI acknowledgement bypass permissions.contains()', async () => {
    trackChain(ChainType.QBIT_MAINNET)
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter()
    const ackStore = createAckStore()
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch(), ackStore })

    // The UI claims the prompt succeeded; the browser says otherwise.
    await expect(wallet.acknowledgeRegtestAccess()).resolves.toMatchObject({
      state: 'locked',
      permission: false,
    })
    expect(ackStore.set).not.toHaveBeenCalled()
    await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
    expectNoChainMutation()
  })

  it('enters regtest once permission, acknowledgement and identity verification all succeed', async () => {
    const current = trackChain(ChainType.QBIT_MAINNET)
    const { wallet, changeKeyring } = prepareWallet()
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    const ackStore = createAckStore()
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch(), ackStore })
    const emitted: unknown[] = []
    bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, params => emitted.push(params))

    await expect(wallet.acknowledgeRegtestAccess()).resolves.toMatchObject({ state: 'available' })
    expect(ackStore.value).toBe(REGTEST_ACCESS_ACK_VERSION)

    await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).resolves.toBeUndefined()

    expect(current()).toBe(ChainType.QBIT_REGTEST)
    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith(REGTEST_HD_PATH)
    expect(walletApiService.setEndpoint).toHaveBeenCalledWith(QBIT_REGTEST_ORIGIN)
    expect(changeKeyring).toHaveBeenCalled()
    expect(sessionService.broadcastChainChange).toHaveBeenCalledWith({
      previousChain: ChainType.QBIT_MAINNET,
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest',
      accounts: [],
    })
    expect(emitted).toContainEqual(
      expect.objectContaining({ method: BUS_METHODS.REGTEST_ACCESS_CHANGED })
    )
    expect(emitted).toContainEqual({
      method: BUS_METHODS.CHAIN_CHANGED,
      params: { type: ChainType.QBIT_REGTEST },
    })
  })

  it('keeps the acknowledgement in extension-wide storage so it survives UI teardown', async () => {
    trackChain(ChainType.QBIT_MAINNET)
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    // No explicit ack store: the controller wires the preference service.
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch() })

    await wallet.acknowledgeRegtestAccess()
    expect(preferenceService.setRegtestAccessAck).toHaveBeenCalledWith(REGTEST_ACCESS_ACK_VERSION)
    expect(preferenceService.persist).toHaveBeenCalled()
  })

  it.each([
    [
      'wrong identity',
      async (url: string) => textResponse(url.endsWith('/block-height/0') ? '0'.repeat(64) : '5'),
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ],
    [
      'redirect',
      async () => textResponse('', { status: 302 }),
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ],
    [
      'timeout',
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
      ErrorCodes.REGTEST_SERVICE_UNREACHABLE,
    ],
    [
      'connection refused',
      async () => {
        throw new TypeError('ECONNREFUSED')
      },
      ErrorCodes.REGTEST_SERVICE_UNREACHABLE,
    ],
    ['malformed', async () => textResponse('genesis?'), ErrorCodes.REGTEST_SERVICE_UNEXPECTED],
    [
      'oversized',
      async () => textResponse(QBIT_REGTEST_GENESIS_HASH + 'f'.repeat(400)),
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ],
    [
      'JSON body',
      async () =>
        textResponse(`"${QBIT_REGTEST_GENESIS_HASH}"`, { contentType: 'application/json' }),
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ],
    [
      'HTML body',
      async () => textResponse('<html></html>', { contentType: 'text/html' }),
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ],
    [
      'identity-only stub',
      async (url: string) =>
        textResponse(url.endsWith('/block-height/0') ? QBIT_REGTEST_GENESIS_HASH : 'nope'),
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ],
  ])(
    'fails closed on a %s response without mutating chain state',
    async (_label, fetchImpl, code) => {
      trackChain(ChainType.QBIT_MAINNET)
      const { wallet, changeKeyring } = prepareWallet()
      const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
      wallet.initRegtestAccess({
        adapter,
        fetch: vi.fn(fetchImpl as any),
        ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
        verification: { timeoutMs: 20 },
      })

      await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).rejects.toMatchObject({ code })
      expectNoChainMutation()
      expect(changeKeyring).not.toHaveBeenCalled()
    }
  )

  it('returns to mainnet through the serialized transition when the permission is revoked while active', async () => {
    const current = trackChain(ChainType.QBIT_REGTEST)
    const { wallet, changeKeyring } = prepareWallet()
    const contains = vi.fn(async () => true)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: contains })
    wallet.initRegtestAccess({
      adapter,
      fetch: healthyFetch(),
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })
    const emitted: unknown[] = []
    bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, params => emitted.push(params))

    contains.mockResolvedValue(false)
    fireRemoved()

    await waitFor(() => expect(current()).toBe(ChainType.QBIT_MAINNET))
    await waitFor(() => expect(walletApiService.setEndpoint).toHaveBeenCalledWith(MAINNET_ENDPOINT))
    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(changeKeyring).toHaveBeenCalled()
    expect(walletApiService.setEndpoint).not.toHaveBeenCalledWith(QBIT_REGTEST_ORIGIN)
    await waitFor(() =>
      expect(sessionService.broadcastChainChange).toHaveBeenCalledWith(
        expect.objectContaining({
          previousChain: ChainType.QBIT_REGTEST,
          chain: ChainType.QBIT_MAINNET,
          network: 'mainnet',
        })
      )
    )
    await waitFor(() =>
      expect(emitted).toContainEqual({
        method: BUS_METHODS.CHAIN_CHANGED,
        params: { type: ChainType.QBIT_MAINNET },
      })
    )
    expect(emitted).toContainEqual(
      expect.objectContaining({
        method: BUS_METHODS.REGTEST_ACCESS_CHANGED,
        params: expect.objectContaining({ state: 'locked', permission: false }),
      })
    )
    // Re-entering regtest is refused until the permission is granted again.
    await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
  })

  it('pins mainnet directly when revoked while the wallet is locked (no keyring loaded)', async () => {
    const current = trackChain(ChainType.QBIT_REGTEST)
    vi.mocked(keyringService.memStore.getState).mockReturnValue({ isUnlocked: false })
    const { wallet, changeKeyring } = prepareWallet()
    const contains = vi.fn(async () => false)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: contains })
    wallet.initRegtestAccess({
      adapter,
      fetch: healthyFetch(),
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })

    fireRemoved()

    await waitFor(() => expect(current()).toBe(ChainType.QBIT_MAINNET))
    await waitFor(() => expect(walletApiService.setEndpoint).toHaveBeenCalledWith(MAINNET_ENDPOINT))
    expect(preferenceService.persist).toHaveBeenCalled()
    expect(changeKeyring).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(sessionService.broadcastChainChange).toHaveBeenCalledWith(
        expect.objectContaining({
          previousChain: ChainType.QBIT_REGTEST,
          chain: ChainType.QBIT_MAINNET,
          network: 'mainnet',
        })
      )
    )
  })

  // performSetChainType rolls a failed transition back onto the regtest HD
  // path. Announcing mainnet on top of that would show regtest-derived keys
  // as mainnet addresses, so the direct-pin fallback has to move the keyring
  // itself before it broadcasts.
  it('re-syncs the keyring onto the mainnet path when the serialized transition fails', async () => {
    const current = trackChain(ChainType.QBIT_REGTEST)
    const { wallet, changeKeyring } = prepareWallet()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 0,
      accounts: [{ address: 'mainnet-path-address' }],
    } as any)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: vi.fn(async () => false) })
    wallet.initRegtestAccess({
      adapter,
      fetch: healthyFetch(),
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })
    // Fail the full transition, then let the fallback's own re-sync succeed.
    vi.mocked(keyringService.syncQbitHdPath)
      .mockRejectedValueOnce(new Error('hd path sync failed'))
      .mockResolvedValue(false)

    fireRemoved()

    await waitFor(() => expect(current()).toBe(ChainType.QBIT_MAINNET))
    await waitFor(() =>
      expect(keyringService.syncQbitHdPath).toHaveBeenLastCalledWith(MAINNET_HD_PATH)
    )
    // Twice: the transition's own attempt (which threw) and the fallback's.
    expect(keyringService.syncQbitHdPath).toHaveBeenCalledTimes(2)
    // The transition threw before it ever reached changeKeyring, so this call
    // can only come from the fallback re-syncing the keyring itself.
    expect(changeKeyring).toHaveBeenCalledTimes(1)
    expect(keyringService.setLocked).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(sessionService.broadcastChainChange).toHaveBeenCalledWith({
        previousChain: ChainType.QBIT_REGTEST,
        chain: ChainType.QBIT_MAINNET,
        network: 'mainnet',
        accounts: ['mainnet-path-address'],
      })
    )
  })

  it('locks the wallet rather than announcing mainnet over an unmoved keyring', async () => {
    const current = trackChain(ChainType.QBIT_REGTEST)
    const { wallet } = prepareWallet()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 0,
      accounts: [{ address: 'regtest-path-address' }],
    } as any)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: vi.fn(async () => false) })
    wallet.initRegtestAccess({
      adapter,
      fetch: healthyFetch(),
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })
    // Both the transition and the fallback's re-sync fail: the keyring may
    // still be on m/87'/1', so the wallet must lock instead.
    vi.mocked(keyringService.syncQbitHdPath).mockRejectedValue(new Error('hd path sync failed'))

    fireRemoved()

    await waitFor(() => expect(current()).toBe(ChainType.QBIT_MAINNET))
    await waitFor(() => expect(keyringService.setLocked).toHaveBeenCalled())
    // Whatever the keyring still holds was derived on the regtest path and is
    // never announced as a mainnet account.
    await waitFor(() =>
      expect(sessionService.broadcastChainChange).toHaveBeenCalledWith({
        previousChain: ChainType.QBIT_REGTEST,
        chain: ChainType.QBIT_MAINNET,
        network: 'mainnet',
        accounts: [],
      })
    )
  })

  it('normalizes a persisted regtest selection to mainnet at startup when any condition is missing', async () => {
    const scenarios: Array<{
      label: string
      permission: boolean
      ack?: string
      fetch: ReturnType<typeof vi.fn>
      expected: ChainType
    }> = [
      {
        label: 'permission missing',
        permission: false,
        ack: REGTEST_ACCESS_ACK_VERSION,
        fetch: healthyFetch(),
        expected: ChainType.QBIT_MAINNET,
      },
      {
        label: 'ack missing',
        permission: true,
        fetch: healthyFetch(),
        expected: ChainType.QBIT_MAINNET,
      },
      {
        label: 'service down',
        permission: true,
        ack: REGTEST_ACCESS_ACK_VERSION,
        fetch: vi.fn(async () => {
          throw new TypeError('down')
        }),
        expected: ChainType.QBIT_MAINNET,
      },
      {
        label: 'all good',
        permission: true,
        ack: REGTEST_ACCESS_ACK_VERSION,
        fetch: healthyFetch(),
        expected: ChainType.QBIT_REGTEST,
      },
    ]
    for (const scenario of scenarios) {
      vi.clearAllMocks()
      const current = trackChain(ChainType.QBIT_REGTEST)
      const { wallet } = prepareWallet()
      const { adapter } = createAdapter({
        containsPermission: vi.fn(async () => scenario.permission),
      })
      wallet.initRegtestAccess({
        adapter,
        fetch: scenario.fetch as any,
        ackStore: createAckStore(scenario.ack),
      })

      await expect(wallet.prepareStartupChainType()).resolves.toBe(scenario.expected)
      expect(current()).toBe(scenario.expected)
      if (scenario.expected === ChainType.QBIT_MAINNET) {
        expect(preferenceService.setChainType).toHaveBeenCalledWith(ChainType.QBIT_MAINNET)
        expect(preferenceService.persist).toHaveBeenCalled()
      } else {
        expect(preferenceService.setChainType).not.toHaveBeenCalled()
      }
      // Startup never touches the API endpoint itself; the caller binds it afterwards.
      expect(walletApiService.setEndpoint).not.toHaveBeenCalled()
    }
  })

  it('leaves non-regtest startup selections untouched', async () => {
    trackChain(ChainType.QBIT_TESTNET4)
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter()
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch(), ackStore: createAckStore() })
    await expect(wallet.prepareStartupChainType()).resolves.toBe(ChainType.QBIT_TESTNET4)
    expect(adapter.containsPermission).not.toHaveBeenCalled()
    expect(preferenceService.setChainType).not.toHaveBeenCalled()
  })

  it('disables local regtest by switching to mainnet first and clearing consent, leaving the browser grant alone', async () => {
    trackChain(ChainType.QBIT_REGTEST)
    const { wallet } = prepareWallet()
    const order: string[] = []
    const contains = vi.fn(async () => true)
    const { adapter } = createAdapter({ containsPermission: contains })
    const ackStore = createAckStore(REGTEST_ACCESS_ACK_VERSION)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      order.push(`chain:${chainType}`)
    })
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch(), ackStore })
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      order.push(`chain:${chainType}`)
      vi.mocked(preferenceService.getChainType).mockReturnValue(chainType)
    })

    const status = await wallet.disableRegtestAccess()

    // Chrome will not remove the origin through the API for this manifest,
    // so disable is an in-extension state change: the grant is still there,
    // the acknowledgement is gone, and that alone keeps regtest locked.
    expect(status).toMatchObject({
      state: 'locked',
      permission: true,
      acknowledged: false,
      reason: 'acknowledgement_missing',
    })
    expect(order[0]).toBe(`chain:${ChainType.QBIT_MAINNET}`)
    expect(ackStore.value).toBeUndefined()
    expect(Object.keys(adapter)).not.toContain('removePermission')
    expect(walletApiService.setEndpoint).toHaveBeenCalledWith(MAINNET_ENDPOINT)
    expect(preferenceService.getChainType()).toBe(ChainType.QBIT_MAINNET)
    await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
  })

  it('does not require the acknowledgement when the loopback permission is required by the manifest (E2E/local dev)', async () => {
    const current = trackChain(ChainType.QBIT_MAINNET)
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter({
      optional: false,
      containsPermission: vi.fn(async () => true),
    })
    const ackStore = createAckStore()
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch(), ackStore })

    await expect(wallet.getRegtestAccessStatus()).resolves.toMatchObject({
      gated: false,
      acknowledged: true,
    })
    await expect(wallet.setChainType(ChainType.QBIT_REGTEST)).resolves.toBeUndefined()
    expect(current()).toBe(ChainType.QBIT_REGTEST)
    expect(ackStore.set).not.toHaveBeenCalled()
  })

  it('reading the status never prompts or probes the service', async () => {
    trackChain(ChainType.QBIT_MAINNET)
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    const fetch = healthyFetch()
    wallet.initRegtestAccess({
      adapter,
      fetch,
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })

    await expect(wallet.getRegtestAccessStatus()).resolves.toMatchObject({ state: 'checking' })
    expect(fetch).not.toHaveBeenCalled()
    expect(Object.keys(adapter)).not.toContain('requestPermission')
  })
})

describe('WalletController restore floor scan and the regtest sibling', () => {
  const account = {
    addresses: { testnet4: 'tb1qtestnetaddr', regtest: 'bcrt1qregtestaddr' },
    scriptPubKey: `5220${'66'.repeat(32)}`,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    regtestAccessService.removeAllListeners()
    ;(keyringService.keyrings as any[]).length = 0
    ;(keyringService.keyrings as any[]).push({
      type: KeyringType.QbitHdKeyring,
      pqcFloorsPending: true,
      getAccounts: vi.fn(async () => ['pubkey-a']),
    })
    vi.mocked(observeQbitPqcSignatureActivity).mockResolvedValue({
      observedSignatures: 1,
      hasActivity: true,
    })
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    vi.spyOn(log, 'error').mockImplementation(() => {})
  })

  /** Runs a Testnet4 floor scan and returns the observer handed to the keyring service. */
  async function scanTestnet4(wallet: WalletController) {
    trackChain(ChainType.QBIT_TESTNET4)
    let capturedObserve: ((account: unknown) => Promise<unknown>) | undefined
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(
      async (_address, observe) => {
        capturedObserve = observe as any
        return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
      }
    )
    await wallet.runQbitRestoreFloorScan()
    expect(capturedObserve).toBeDefined()
    return capturedObserve!
  }

  function observedAddresses(): string[] {
    return vi.mocked(observeQbitPqcSignatureActivity).mock.calls.map(([, address]) => address)
  }

  it('omits the regtest sibling when the loopback permission was never granted', async () => {
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter()
    const fetch = healthyFetch()
    wallet.initRegtestAccess({ adapter, fetch, ackStore: createAckStore() })

    const observe = await scanTestnet4(wallet)
    await expect(observe(account)).resolves.toEqual({
      observedSignatures: 1,
      hasActivity: true,
      floorSource: 'history',
    })

    expect(observedAddresses()).toEqual(['tb1qtestnetaddr'])
    // No permission means no identity probe either: nothing touches the loopback port.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('omits the regtest sibling when the permission exists but the service identity is unexpected', async () => {
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    const fetch = vi.fn(async (url: string) =>
      textResponse(url.endsWith('/block-height/0') ? '0'.repeat(64) : '5')
    )
    wallet.initRegtestAccess({
      adapter,
      fetch,
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })

    const observe = await scanTestnet4(wallet)
    await expect(observe(account)).resolves.toEqual({
      observedSignatures: 1,
      hasActivity: true,
      floorSource: 'history',
    })

    expect(observedAddresses()).toEqual(['tb1qtestnetaddr'])
    await expect(wallet.getRegtestAccessStatus()).resolves.toMatchObject({
      state: 'unexpected_service',
    })
    // The identity probe carries no wallet identifiers; the scan sent none afterwards.
    const probed = fetch.mock.calls.map(([url]) => url)
    expect(probed.every(url => url.startsWith(QBIT_REGTEST_ORIGIN))).toBe(true)
    expect(probed.some(url => url.includes('bcrt1qregtestaddr'))).toBe(false)
  })

  it('omits the regtest sibling and keeps the scan alive when the capability check itself fails', async () => {
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter({
      containsPermission: vi.fn(async () => {
        throw new Error('permissions API unavailable')
      }),
    })
    wallet.initRegtestAccess({ adapter, fetch: healthyFetch(), ackStore: createAckStore() })

    const observe = await scanTestnet4(wallet)
    await expect(observe(account)).resolves.toEqual({
      observedSignatures: 1,
      hasActivity: true,
      floorSource: 'history',
    })

    expect(observedAddresses()).toEqual(['tb1qtestnetaddr'])
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('omitting regtest history from the floor scan'),
      expect.objectContaining({ name: 'Error' })
    )
  })

  it('includes the regtest sibling once permission, acknowledgement and identity all verify', async () => {
    const { wallet } = prepareWallet()
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    wallet.initRegtestAccess({
      adapter,
      fetch: healthyFetch(),
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })

    const observe = await scanTestnet4(wallet)
    await expect(observe(account)).resolves.toEqual({
      observedSignatures: 2,
      hasActivity: true,
      floorSource: 'history',
    })

    expect(observedAddresses()).toEqual(['tb1qtestnetaddr', 'bcrt1qregtestaddr'])
  })

  it('re-checks the capability on every scan so a revoked permission stops the sibling', async () => {
    const { wallet } = prepareWallet()
    let granted = true
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => granted) })
    wallet.initRegtestAccess({
      adapter,
      fetch: healthyFetch(),
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
    })

    const first = await scanTestnet4(wallet)
    await first(account)
    expect(observedAddresses()).toEqual(['tb1qtestnetaddr', 'bcrt1qregtestaddr'])

    granted = false
    vi.mocked(observeQbitPqcSignatureActivity).mockClear()
    const second = await scanTestnet4(wallet)
    await second(account)
    expect(observedAddresses()).toEqual(['tb1qtestnetaddr'])
  })
})
