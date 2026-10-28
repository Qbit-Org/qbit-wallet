import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { AddressType, ChainType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService } from '../src/services'
import { discoverQbitActiveIndexes } from '../src/utils/qbit-api'

vi.mock('../src/services', () => ({
  keyringService: {
    createTmpKeyring: vi.fn(),
    createKeyringWithMnemonics: vi.fn(),
    addDiscoveredQbitKeyring: vi.fn(),
    addNewAccount: vi.fn(),
    rearmQbitRestoreFloorsForKeyring: vi.fn(),
    removePreMnemonics: vi.fn(),
    displayForKeyring: vi.fn(),
    restorePqcSignatureCounterFloors: vi.fn(),
    recordQbitReceiveActivity: vi.fn(),
    keyrings: [] as any[],
  },
  preferenceService: {
    getChainType: vi.fn(() => ChainType.QBIT_MAINNET),
    setShowSafeNotice: vi.fn(),
  },
  walletApiService: {
    setEndpoint: vi.fn(),
  },
  sessionService: {
    broadcastEvent: vi.fn(),
  },
  contactBookService: {
    listAlias: vi.fn(() => []),
  },
  notificationService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

vi.mock('../src/utils/qbit-api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/qbit-api')>()
  return {
    ...actual,
    discoverQbitActiveIndexes: vi.fn(),
    observeQbitPqcSignatureActivity: vi.fn(),
  }
})

const mnemonic = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

function pendingQbitKeyring(pubkey: string, pending = true) {
  return {
    type: KeyringType.QbitHdKeyring,
    pqcFloorsPending: pending,
    getAccounts: vi.fn(async () => [pubkey]),
  }
}

function fakeTmpKeyring() {
  return {
    type: KeyringType.QbitHdKeyring,
    activeAccounts: vi.fn(),
    getQbitAccounts: vi.fn(async () => []),
  }
}

describe('WalletController qbit restore with floors', () => {
  let controller: WalletController
  let tmpKeyring: ReturnType<typeof fakeTmpKeyring>
  let adoptedKeyring: ReturnType<typeof pendingQbitKeyring>

  beforeEach(() => {
    vi.clearAllMocks()
    controller = new WalletController()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    ;(keyringService.keyrings as any[]).length = 0
    tmpKeyring = fakeTmpKeyring()
    adoptedKeyring = pendingQbitKeyring('pubkey-a')
    vi.mocked(keyringService.createTmpKeyring).mockReturnValue(tmpKeyring as any)
    vi.mocked(keyringService.addDiscoveredQbitKeyring).mockImplementation(async () => {
      ;(keyringService.keyrings as any[]).push(adoptedKeyring)
      return adoptedKeyring as any
    })
    vi.mocked(keyringService.displayForKeyring).mockResolvedValue({} as any)
    vi.spyOn(controller, 'displayedKeyringToWalletKeyring').mockReturnValue({
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [],
    } as any)
    vi.spyOn(controller, 'changeKeyring').mockResolvedValue(undefined as any)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
  })

  it('restores every discovered index and completes the floor scan', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockResolvedValue({
      activeIndexes: [0, 2],
      highestActiveIndex: 2,
      scannedCount: 23,
      truncated: false,
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      adoptedKeyring.pqcFloorsPending = false
      return {
        floors: [
          { pubkey: 'pubkey-a', observedCounter: 3, newCounter: 3, counterProvenance: 'restored-floor' },
          { pubkey: 'pubkey-b', observedCounter: 0, newCounter: 0, counterProvenance: 'local' },
          { pubkey: 'pubkey-c', observedCounter: 2, newCounter: 2, counterProvenance: 'restored-floor' },
        ],
        gapIndexesWithActivity: [],
        possibleConcurrentInstance: false,
      } as any
    })

    const report = await controller.restoreQbitKeyringWithFloors(
      mnemonic,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR
    )

    expect(keyringService.addDiscoveredQbitKeyring).toHaveBeenCalledWith(tmpKeyring, 3, true, 'mainnet')
    expect(keyringService.recordQbitReceiveActivity).toHaveBeenCalledWith(
      'pubkey-a',
      'mainnet',
      [0, 2]
    )
    expect(report).toMatchObject({
      network: 'mainnet',
      accountsRestored: 3,
      floorsCompleted: true,
      discovery: { highestActiveIndex: 2, truncated: false },
      floorScan: {
        network: 'mainnet',
        keyringsScanned: 1,
        accountsScanned: 3,
        totalObservedSignatures: 5,
        restoredFloorCount: 2,
        possibleConcurrentInstance: false,
      },
    })
  })

  it('persists a truncated discovery as incomplete without rejecting the partial restore', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockResolvedValue({
      activeIndexes: [0, 2],
      highestActiveIndex: 2,
      scannedCount: 40,
      truncated: true,
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      adoptedKeyring.pqcFloorsPending = false
      return {
        floors: [],
        gapIndexesWithActivity: [],
        possibleConcurrentInstance: false,
      } as any
    })

    const report = await controller.restoreQbitKeyringWithFloors(
      mnemonic,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR
    )

    expect(keyringService.addDiscoveredQbitKeyring).toHaveBeenCalledWith(tmpKeyring, 3, false, 'mainnet')
    expect(keyringService.keyrings).toEqual([adoptedKeyring])
    expect(report).toMatchObject({
      accountsRestored: 3,
      floorsCompleted: true,
      discovery: { highestActiveIndex: 2, truncated: true },
    })
  })

  it('restores a single account when the seed shows no activity', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockResolvedValue({
      activeIndexes: [],
      highestActiveIndex: -1,
      scannedCount: 20,
      truncated: false,
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      adoptedKeyring.pqcFloorsPending = false
      return {
        floors: [],
        gapIndexesWithActivity: [],
        possibleConcurrentInstance: false,
      } as any
    })

    const report = await controller.restoreQbitKeyringWithFloors(
      mnemonic,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR
    )

    expect(keyringService.addDiscoveredQbitKeyring).toHaveBeenCalledWith(tmpKeyring, 1, true, 'mainnet')
    expect(report.accountsRestored).toBe(1)
    expect(report.floorsCompleted).toBe(true)
    expect(keyringService.recordQbitReceiveActivity).not.toHaveBeenCalled()
  })

  it('keeps the wallet sign-locked when the floor scan fails', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockResolvedValue({
      activeIndexes: [0],
      highestActiveIndex: 0,
      scannedCount: 21,
      truncated: false,
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockRejectedValue(
      new Error('qbit address history changed while scanning qb1x')
    )

    const report = await controller.restoreQbitKeyringWithFloors(
      mnemonic,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR
    )

    expect(report.floorsCompleted).toBe(false)
    expect(report).toMatchObject({
      floorError: expect.stringContaining('history changed'),
    })
    // The keyring stays in place with its gate closed; only a completed scan lifts it.
    expect(adoptedKeyring.pqcFloorsPending).toBe(true)
    expect(await controller.getQbitRestoreFloorsPending()).toBe(true)
  })

  it('reports an incomplete restore when the scan resolves without lifting the gate', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockResolvedValue({
      activeIndexes: [0],
      highestActiveIndex: 0,
      scannedCount: 21,
      truncated: false,
    })
    // Scan resolves but never flips the keyring's pending flag.
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockResolvedValue({
      floors: [],
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false,
    } as any)

    const report = await controller.restoreQbitKeyringWithFloors(
      mnemonic,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR
    )

    expect(report.floorsCompleted).toBe(false)
    expect(report).toMatchObject({
      floorError: expect.stringContaining('signing gate'),
    })
    expect(await controller.getQbitRestoreFloorsPending()).toBe(true)
  })

  it('does not persist the temporary keyring when discovery fails', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockRejectedValue(
      new Error('qbit discovery history request failed')
    )

    await expect(
      controller.restoreQbitKeyringWithFloors(
        mnemonic,
        "m/87'/0'/0'/0",
        '',
        AddressType.P2MR
      )
    ).rejects.toThrow('discovery history request failed')

    expect(keyringService.addDiscoveredQbitKeyring).not.toHaveBeenCalled()
    expect(keyringService.removePreMnemonics).not.toHaveBeenCalled()
    expect(keyringService.keyrings).toHaveLength(0)
  })

  it('normalizes omitted options serialized as null before discovery', async () => {
    vi.mocked(discoverQbitActiveIndexes).mockImplementation(
      async (_client, _deriveAddresses, options) => {
        expect(options).toBeUndefined()
        throw new Error('stop after transport normalization')
      }
    )

    await expect(
      controller.restoreQbitKeyringWithFloors(
        mnemonic,
        "m/87'/0'/0'/0",
        '',
        AddressType.P2MR,
        null
      )
    ).rejects.toThrow('stop after transport normalization')

    expect(keyringService.addDiscoveredQbitKeyring).not.toHaveBeenCalled()
  })

  it('refuses restore orchestration off qbit chains and for non-P2MR types', async () => {
    vi.mocked(preferenceService.getChainType).mockReturnValue('NOT_A_CHAIN' as ChainType)
    await expect(
      controller.restoreQbitKeyringWithFloors(mnemonic, "m/44'/0'/0'/0", '', AddressType.P2MR)
    ).rejects.toThrow()

    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    await expect(
      controller.restoreQbitKeyringWithFloors(mnemonic, "m/44'/0'/0'/0", '', AddressType.P2WPKH)
    ).rejects.toThrow()
  })

  it('scans only keyrings whose floors are pending', async () => {
    const pending = pendingQbitKeyring('pubkey-pending')
    const settled = pendingQbitKeyring('pubkey-settled', false)
    const foreign = { type: KeyringType.HdKeyring, getAccounts: vi.fn(async () => ['x']) }
    ;(keyringService.keyrings as any[]).push(settled, pending, foreign)
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockResolvedValue({
      floors: [
        { pubkey: 'pubkey-pending', observedCounter: 1, newCounter: 1, counterProvenance: 'restored-floor' },
      ],
      gapIndexesWithActivity: [7],
      possibleConcurrentInstance: true,
    } as any)

    const summary = await controller.runQbitRestoreFloorScan({ lookahead: 5 })

    expect(keyringService.restorePqcSignatureCounterFloors).toHaveBeenCalledTimes(1)
    expect(keyringService.restorePqcSignatureCounterFloors).toHaveBeenCalledWith(
      'pubkey-pending',
      expect.any(Function),
      { lookahead: 5 }
    )
    expect(summary).toMatchObject({
      keyringsScanned: 1,
      possibleConcurrentInstance: true,
      gapIndexesWithActivity: [7],
    })
  })

  it('builds an observer bound to the active network address and script', async () => {
    const { observeQbitPqcSignatureActivity } = await import('../src/utils/qbit-api')
    vi.mocked(observeQbitPqcSignatureActivity).mockResolvedValue({
      observedSignatures: 4,
      hasActivity: true,
    })
    const pending = pendingQbitKeyring('pubkey-a')
    ;(keyringService.keyrings as any[]).push(pending)
    let capturedObserve: ((account: any) => Promise<any>) | undefined
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(
      async (_address, observe) => {
        capturedObserve = observe as any
        return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
      }
    )

    await controller.runQbitRestoreFloorScan()
    expect(capturedObserve).toBeDefined()

    await expect(
      capturedObserve!({
        addresses: { mainnet: 'qb1qmainnetaddr' },
        scriptPubKey: `5220${'22'.repeat(32)}`,
      })
    ).resolves.toEqual({ observedSignatures: 4, hasActivity: true, floorSource: 'history' })
    expect(observeQbitPqcSignatureActivity).toHaveBeenCalledWith(
      expect.anything(),
      'qb1qmainnetaddr',
      `5220${'22'.repeat(32)}`,
      // Per-address bounded retries so a moving snapshot does not fail the scan.
      { stabilityRetries: 4, retryBaseDelayMs: 1_000, tipAdvanceSettleMs: 10_000 }
    )

    await expect(
      capturedObserve!({ addresses: { testnet4: 'qb1qtestnetonly' }, scriptPubKey: '5220ab' })
    ).rejects.toThrow('missing a mainnet address')
  })

  it('aggregates every network that shares the active restored HD path', async () => {
    const { observeQbitPqcSignatureActivity } = await import('../src/utils/qbit-api')
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(observeQbitPqcSignatureActivity)
      .mockResolvedValueOnce({ observedSignatures: 4, hasActivity: true })
      .mockResolvedValueOnce({ observedSignatures: 2, hasActivity: false })
    ;(keyringService.keyrings as any[]).push(pendingQbitKeyring('pubkey-a'))
    let capturedObserve: ((account: any) => Promise<any>) | undefined
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(
      async (_address, observe) => {
        capturedObserve = observe as any
        return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
      }
    )

    await controller.runQbitRestoreFloorScan()
    await expect(
      capturedObserve!({
        addresses: {
          testnet4: 'tb1qtestnetaddr',
          regtest: 'bcrt1qregtestaddr',
        },
        scriptPubKey: `5220${'33'.repeat(32)}`,
      })
    ).resolves.toEqual({ observedSignatures: 6, hasActivity: true, floorSource: 'history' })

    expect(observeQbitPqcSignatureActivity).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'tb1qtestnetaddr',
      `5220${'33'.repeat(32)}`,
      { stabilityRetries: 4, retryBaseDelayMs: 1_000, tipAdvanceSettleMs: 10_000 }
    )
    expect(observeQbitPqcSignatureActivity).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'bcrt1qregtestaddr',
      `5220${'33'.repeat(32)}`,
      { stabilityRetries: 4, retryBaseDelayMs: 1_000, tipAdvanceSettleMs: 10_000 }
    )
  })

  it('reports which read set each scanned account floor', async () => {
    const { observeQbitPqcSignatureActivity } = await import('../src/utils/qbit-api')
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(observeQbitPqcSignatureActivity).mockImplementation(async (_client, address) =>
      address === 'bcrt1qregtestaddr'
        ? { observedSignatures: 2, hasActivity: true, floorSource: 'address-stats' }
        : { observedSignatures: 4, hasActivity: true, floorSource: 'history' }
    )
    ;(keyringService.keyrings as any[]).push(pendingQbitKeyring('pubkey-a'))
    let capturedObserve: ((account: any) => Promise<any>) | undefined
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(
      async (_address, observe) => {
        capturedObserve = observe as any
        return {
          floors: [
            {
              pubkey: 'pubkey-a',
              observedCounter: 4,
              newCounter: 4,
              counterProvenance: 'restored-floor',
            },
            {
              pubkey: 'pubkey-d',
              observedCounter: 6,
              newCounter: 6,
              counterProvenance: 'restored-floor',
            },
          ],
          floorSources: [
            { index: 0, pubkey: 'pubkey-a', source: 'history' },
            { index: 3, pubkey: 'pubkey-d', source: 'address-stats' },
          ],
          gapIndexesWithActivity: [],
          possibleConcurrentInstance: false,
        } as any
      }
    )

    const summary = await controller.runQbitRestoreFloorScan()
    expect(summary.floorSources).toEqual([
      { index: 0, pubkey: 'pubkey-a', source: 'history' },
      { index: 3, pubkey: 'pubkey-d', source: 'address-stats' },
    ])

    // One network read from statistics marks the account's whole floor.
    await expect(
      capturedObserve!({
        index: 3,
        addresses: { testnet4: 'tb1qtestnetaddr', regtest: 'bcrt1qregtestaddr' },
        scriptPubKey: `5220${'33'.repeat(32)}`,
      })
    ).resolves.toEqual({ observedSignatures: 6, hasActivity: true, floorSource: 'address-stats' })
    expect(log.warn).toHaveBeenCalledWith(
      'qbit restore floor for account 3 on regtest read from address statistics: its history is too long to enumerate'
    )
  })

  it('does not require local regtest history to complete a Testnet4 floor scan', async () => {
    const { observeQbitPqcSignatureActivity } = await import('../src/utils/qbit-api')
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(observeQbitPqcSignatureActivity).mockImplementation(async (_client, address) => {
      if (address === 'bcrt1qregtestaddr') {
        throw new Error('local regtest history is unavailable')
      }
      return { observedSignatures: 4, hasActivity: true }
    })
    ;(keyringService.keyrings as any[]).push(pendingQbitKeyring('pubkey-a'))
    let capturedObserve: ((account: any) => Promise<any>) | undefined
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(
      async (_address, observe) => {
        capturedObserve = observe as any
        return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
      }
    )

    await controller.runQbitRestoreFloorScan()
    const account = {
      addresses: {
        testnet4: 'tb1qtestnetaddr',
        regtest: 'bcrt1qregtestaddr',
      },
      scriptPubKey: `5220${'44'.repeat(32)}`,
    }
    await expect(capturedObserve!(account)).resolves.toEqual({
      observedSignatures: 4,
      hasActivity: true,
      floorSource: 'history',
    })
    await expect(capturedObserve!(account)).resolves.toEqual({
      observedSignatures: 4,
      hasActivity: true,
      floorSource: 'history',
    })

    expect(observeQbitPqcSignatureActivity).toHaveBeenCalledTimes(3)
    expect(
      vi
        .mocked(observeQbitPqcSignatureActivity)
        .mock.calls.filter(([, address]) => address === 'bcrt1qregtestaddr')
    ).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('optional regtest qbit restore history is unavailable'),
      expect.objectContaining({ message: 'local regtest history is unavailable' })
    )
  })

  it('still fails a Testnet4 floor scan when active Testnet4 history is unavailable', async () => {
    const { observeQbitPqcSignatureActivity } = await import('../src/utils/qbit-api')
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(observeQbitPqcSignatureActivity).mockImplementation(async (_client, address) => {
      if (address === 'tb1qtestnetaddr') {
        throw new Error('Testnet4 history is unavailable')
      }
      return { observedSignatures: 2, hasActivity: false }
    })
    ;(keyringService.keyrings as any[]).push(pendingQbitKeyring('pubkey-a'))
    let capturedObserve: ((account: any) => Promise<any>) | undefined
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(
      async (_address, observe) => {
        capturedObserve = observe as any
        return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
      }
    )

    await controller.runQbitRestoreFloorScan()
    await expect(
      capturedObserve!({
        addresses: {
          testnet4: 'tb1qtestnetaddr',
          regtest: 'bcrt1qregtestaddr',
        },
        scriptPubKey: `5220${'55'.repeat(32)}`,
      })
    ).rejects.toThrow('Testnet4 history is unavailable')
  })

  it('serializes discovery, insertion, and floor reconstruction with chain changes', async () => {
    let releaseDiscovery!: () => void
    const discoveryGate = new Promise<void>(resolve => {
      releaseDiscovery = resolve
    })
    let reportDiscoveryStarted!: () => void
    const discoveryStarted = new Promise<void>(resolve => {
      reportDiscoveryStarted = resolve
    })
    vi.mocked(discoverQbitActiveIndexes).mockImplementation(async () => {
      reportDiscoveryStarted()
      await discoveryGate
      return {
        activeIndexes: [],
        highestActiveIndex: -1,
        scannedCount: 20,
        truncated: false,
      }
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      adoptedKeyring.pqcFloorsPending = false
      return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
    })
    const performSetChainType = vi
      .spyOn(controller as any, 'performSetChainType')
      .mockResolvedValue(undefined)

    const restore = controller.restoreQbitKeyringWithFloors(
      mnemonic,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR
    )
    await discoveryStarted
    const networkChange = controller.setChainType(ChainType.QBIT_TESTNET4)
    await Promise.resolve()
    expect(performSetChainType).not.toHaveBeenCalled()

    releaseDiscovery()
    await expect(restore).resolves.toMatchObject({ floorsCompleted: true })
    await networkChange
    expect(performSetChainType).toHaveBeenCalledTimes(1)
  })

  it('reports the persisted concurrent-instance hint across keyrings', async () => {
    expect(await controller.getQbitConcurrentInstanceHint()).toBe(false)
    ;(keyringService.keyrings as any[]).push(
      { type: KeyringType.HdKeyring, pqcConcurrentInstanceHint: true },
      { type: KeyringType.QbitHdKeyring, pqcConcurrentInstanceHint: false }
    )
    expect(await controller.getQbitConcurrentInstanceHint()).toBe(false)
    ;(keyringService.keyrings as any[]).push({
      type: KeyringType.QbitHdKeyring,
      pqcConcurrentInstanceHint: true,
    })
    expect(await controller.getQbitConcurrentInstanceHint()).toBe(true)
  })

  it('kicks a deferred floor scan only when a restore is still pending', async () => {
    const scanSpy = vi
      .spyOn(controller as any, 'performQbitRestoreFloorScan')
      .mockResolvedValue(undefined as any)

    ;(controller as any).kickPendingQbitRestoreFloorScan()
    await (controller as any).chainStateChangeTail
    expect(scanSpy).not.toHaveBeenCalled()
    ;(keyringService.keyrings as any[]).push(pendingQbitKeyring('pubkey-a'))
    ;(controller as any).kickPendingQbitRestoreFloorScan()
    await (controller as any).chainStateChangeTail
    expect(scanSpy).toHaveBeenCalledTimes(1)

    // A failing deferred scan must not throw out of the unlock path.
    scanSpy.mockRejectedValueOnce(new Error('offline'))
    ;(controller as any).kickPendingQbitRestoreFloorScan()
    await (controller as any).chainStateChangeTail
  })

  it('runs a deferred floor scan only after an in-flight chain change settles', async () => {
    ;(keyringService.keyrings as any[]).push(pendingQbitKeyring('pubkey-a'))
    let releaseChainChange!: () => void
    const chainChangeGate = new Promise<void>(resolve => {
      releaseChainChange = resolve
    })
    let reportChainChangeStarted!: () => void
    const chainChangeStarted = new Promise<void>(resolve => {
      reportChainChangeStarted = resolve
    })
    vi.spyOn(controller as any, 'performSetChainType').mockImplementation(async () => {
      reportChainChangeStarted()
      await chainChangeGate
    })
    const scanSpy = vi
      .spyOn(controller as any, 'performQbitRestoreFloorScan')
      .mockResolvedValue(undefined)

    const networkChange = controller.setChainType(ChainType.QBIT_TESTNET4)
    await chainChangeStarted
    ;(controller as any).kickPendingQbitRestoreFloorScan()
    expect(scanSpy).not.toHaveBeenCalled()

    releaseChainChange()
    await networkChange
    await (controller as any).chainStateChangeTail
    expect(scanSpy).toHaveBeenCalledTimes(1)
  })

  it('re-arms and rescans a restored keyring when an account is derived manually', async () => {
    const restored = pendingQbitKeyring('pubkey-a', false) as any
    restored.pqcRestoredFromMnemonic = true
    ;(keyringService.keyrings as any[]).push(restored)
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      restored.pqcFloorsPending = true
      return true
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      restored.pqcFloorsPending = false
      return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
    })
    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-restored-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])

    await expect(controller.deriveNewAccountFromMnemonic(walletKeyring as any)).resolves.toEqual({
      floorScanPending: false,
    })

    expect(keyringService.rearmQbitRestoreFloorsForKeyring).toHaveBeenCalledWith(
      'qb1-restored-anchor'
    )
    expect(keyringService.addNewAccount).toHaveBeenCalledWith(restored)
    expect(keyringService.restorePqcSignatureCounterFloors).toHaveBeenCalledWith(
      'pubkey-a',
      expect.any(Function),
      undefined
    )
    // The sign-lock must land before the account exists with a zero floor,
    // and the scan that lifts it runs only after activation.
    const [rearmOrder] = vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mock
      .invocationCallOrder
    const [addOrder] = vi.mocked(keyringService.addNewAccount).mock.invocationCallOrder
    const [scanOrder] = vi.mocked(keyringService.restorePqcSignatureCounterFloors).mock
      .invocationCallOrder
    expect(rearmOrder).toBeLessThan(addOrder!)
    expect(addOrder).toBeLessThan(scanOrder!)
  })

  it('queues a manual derive behind an in-flight floor scan so the scan cannot consume its re-arm', async () => {
    const restored = pendingQbitKeyring('pubkey-a') as any
    restored.pqcRestoredFromMnemonic = true
    ;(keyringService.keyrings as any[]).push(restored)
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      restored.pqcFloorsPending = true
      return true
    })
    let releaseScan!: () => void
    const scanGate = new Promise<void>(resolve => {
      releaseScan = resolve
    })
    let reportScanStarted!: () => void
    const scanStarted = new Promise<void>(resolve => {
      reportScanStarted = resolve
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      reportScanStarted()
      await scanGate
      restored.pqcFloorsPending = false
      return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
    })

    // A deferred crash-recovery scan is already draining this keyring's gate.
    ;(controller as any).kickPendingQbitRestoreFloorScan()
    await scanStarted

    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-restored-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])
    const derive = controller.deriveNewAccountFromMnemonic(walletKeyring as any)
    await Promise.resolve()
    // The re-arm must not land while the in-flight scan could still clear it
    // and report completion without having covered the new account.
    expect(keyringService.rearmQbitRestoreFloorsForKeyring).not.toHaveBeenCalled()
    expect(keyringService.addNewAccount).not.toHaveBeenCalled()

    releaseScan()
    await derive

    // The derive re-armed the gate after the first scan settled, and its own
    // scan (the second) lifted it again with the new account in range.
    expect(keyringService.restorePqcSignatureCounterFloors).toHaveBeenCalledTimes(2)
    expect(restored.pqcFloorsPending).toBe(false)
    const [rearmOrder] = vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mock
      .invocationCallOrder
    const [addOrder] = vi.mocked(keyringService.addNewAccount).mock.invocationCallOrder
    const [, secondScanOrder] = vi.mocked(keyringService.restorePqcSignatureCounterFloors).mock
      .invocationCallOrder
    expect(rearmOrder).toBeLessThan(addOrder!)
    expect(addOrder).toBeLessThan(secondScanOrder!)
  })

  it('derives without a floor rescan when the qbit keyring was created locally', async () => {
    const local = pendingQbitKeyring('pubkey-a', false)
    ;(keyringService.keyrings as any[]).push(local)
    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-local-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])

    await expect(controller.deriveNewAccountFromMnemonic(walletKeyring as any)).resolves.toEqual({
      floorScanPending: false,
    })

    expect(keyringService.addNewAccount).toHaveBeenCalledWith(local)
    expect(keyringService.rearmQbitRestoreFloorsForKeyring).not.toHaveBeenCalled()
    expect(keyringService.restorePqcSignatureCounterFloors).not.toHaveBeenCalled()
  })

  it('resolves a derive with floorScanPending when the in-band scan fails after the account is committed', async () => {
    const restored = pendingQbitKeyring('pubkey-a', false) as any
    restored.pqcRestoredFromMnemonic = true
    ;(keyringService.keyrings as any[]).push(restored)
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      restored.pqcFloorsPending = true
      return true
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockRejectedValueOnce(
      new Error('qbit address history changed while scanning qb1x')
    )
    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-restored-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])

    // The account was committed and selected before the scan ran; rejecting
    // here would report a failure for an account that exists (issue #228).
    await expect(controller.deriveNewAccountFromMnemonic(walletKeyring as any)).resolves.toEqual({
      floorScanPending: true,
      floorScanError: 'qbit address history changed while scanning qb1x',
    })
    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(1)
    expect(controller.changeKeyring).toHaveBeenCalledTimes(1)
    // Only a completed scan clears the gate.
    expect(restored.pqcFloorsPending).toBe(true)
    expect(await controller.getQbitRestoreFloorsPending()).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('signing stays locked'),
      expect.objectContaining({ message: expect.stringContaining('history changed') })
    )
  })

  it('resolves a derive with floorScanPending when the in-band scan resolves without lifting the gate', async () => {
    const restored = pendingQbitKeyring('pubkey-a', false) as any
    restored.pqcRestoredFromMnemonic = true
    ;(keyringService.keyrings as any[]).push(restored)
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      restored.pqcFloorsPending = true
      return true
    })
    // Scan resolves but never flips the keyring's pending flag.
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockResolvedValueOnce({
      floors: [],
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false,
    } as any)
    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-restored-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])

    await expect(controller.deriveNewAccountFromMnemonic(walletKeyring as any)).resolves.toEqual({
      floorScanPending: true,
      floorScanError: expect.stringContaining('signing gate'),
    })
    expect(restored.pqcFloorsPending).toBe(true)
  })

  it('derives on the identity-matched keyring when compaction staled the captured index', async () => {
    const local = pendingQbitKeyring('pubkey-a', false)
    ;(keyringService.keyrings as any[]).push(local)
    const capturedKeyring = {
      index: 4,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-local-anchor', pubkey: 'pubkey-a' }],
    }
    // A removal queued ahead of this derive compacted the wallet down to
    // index 0 before the queued derivation ran.
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([
      { ...capturedKeyring, index: 0 } as any,
    ])

    await controller.deriveNewAccountFromMnemonic(capturedKeyring as any)

    expect(keyringService.addNewAccount).toHaveBeenCalledWith(local)
  })

  it('rejects a second derive for the same keyring while one is still in flight', async () => {
    const restored = pendingQbitKeyring('pubkey-a', false) as any
    restored.pqcRestoredFromMnemonic = true
    ;(keyringService.keyrings as any[]).push(restored)
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      restored.pqcFloorsPending = true
      return true
    })
    let releaseScan!: () => void
    const scanGate = new Promise<void>(resolve => {
      releaseScan = resolve
    })
    let reportScanStarted!: () => void
    const scanStarted = new Promise<void>(resolve => {
      reportScanStarted = resolve
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      reportScanStarted()
      await scanGate
      restored.pqcFloorsPending = false
      return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
    })
    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-restored-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])

    const first = controller.deriveNewAccountFromMnemonic(walletKeyring as any)
    await scanStarted
    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(1)

    // The UI's in-flight lock only spans one screen mount, so a remounted
    // screen or a second window can re-submit the same keyring (here with a
    // stale captured index) while the floor scan is still running. The queue
    // would serialize a second derivation, not deduplicate it.
    await expect(
      controller.deriveNewAccountFromMnemonic({ ...walletKeyring, index: 3 } as any, 'Dup')
    ).rejects.toThrow('account_creation_already_in_progress')

    releaseScan()
    await first
    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(1)

    // The lock lifts once the derivation settles.
    await controller.deriveNewAccountFromMnemonic(walletKeyring as any)
    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(2)
  })

  it('releases the derive lock when the derivation fails', async () => {
    const local = pendingQbitKeyring('pubkey-a', false)
    ;(keyringService.keyrings as any[]).push(local)
    vi.mocked(keyringService.addNewAccount).mockRejectedValueOnce(new Error('persist failed'))
    const walletKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [{ address: 'qb1-local-anchor', pubkey: 'pubkey-a' }],
    }
    vi.spyOn(controller, 'getKeyrings').mockResolvedValue([walletKeyring as any])

    await expect(controller.deriveNewAccountFromMnemonic(walletKeyring as any)).rejects.toThrow(
      'persist failed'
    )

    await controller.deriveNewAccountFromMnemonic(walletKeyring as any)
    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(2)
  })
})
