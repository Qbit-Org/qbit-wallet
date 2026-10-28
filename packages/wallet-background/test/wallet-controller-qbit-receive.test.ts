import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import type { Account, WalletKeyring } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService } from '../src/services'

vi.mock('../src/services', () => ({
  keyringService: {
    getQbitReceiveState: vi.fn(),
    recordQbitReceiveActivity: vi.fn(),
    setQbitReceiveIntent: vi.fn(),
    rearmQbitRestoreFloorsForKeyring: vi.fn(),
    restorePqcSignatureCounterFloors: vi.fn(),
    keyrings: [{ type: KeyringType.QbitHdKeyring }],
  },
  preferenceService: {
    getChainType: vi.fn(() => ChainType.QBIT_TESTNET4),
    getCurrentAccount: vi.fn(),
    setCurrentAccount: vi.fn(),
    setCurrentKeyringIndex: vi.fn(),
  },
  walletApiService: {},
  sessionService: { broadcastEvent: vi.fn() },
  contactBookService: {},
  notificationService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

type Network = 'mainnet' | 'testnet4' | 'regtest'
type Ledger = { currentIndex: number | null; issuedIndexes: number[]; usedIndexes: number[] }

const LIMIT = 1 << 30

function account(
  index: number,
  state: 'normal' | 'warning' | 'critical' | 'exhausted' = 'normal',
  provenance: 'local' | 'restored-floor' = 'local',
  pubkeyPrefix = 'pub'
): Account {
  const remaining = state === 'exhausted' ? 0 : state === 'critical' ? 1 : LIMIT - index
  const count = LIMIT - remaining
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey: `${pubkeyPrefix}-${index}`,
    address: `tq-${index}`,
    index,
    key: `keyring_0#${index}`,
    flag: 0,
    p2mr: {
      pubkey: `${pubkeyPrefix}-${index}`,
      path: `m/87'/1'/0'/0/${index}`,
      scriptPubKey: `script-${index}`,
      leafScript: `leaf-${index}`,
      addresses: {
        mainnet: `qb-${index}`,
        testnet4: `tq-${index}`,
        signet: `tqs-${index}`,
        regtest: `qbrt-${index}`,
      },
      hkdf: { account: 0, change: 0, index },
      signatureCounter: { count, limit: LIMIT, remaining, state, provenance },
    },
  }
}

function walletKeyring(accounts: Account[]): WalletKeyring {
  return {
    key: 'keyring_0',
    index: 0,
    type: KeyringType.QbitHdKeyring,
    addressType: 9,
    accounts,
    alianName: 'Qbit Wallet #1',
    hdPath: "m/87'/1'/0'/0",
  }
}

function emptyLedger(): Ledger {
  return { currentIndex: null, issuedIndexes: [], usedIndexes: [] }
}

describe('WalletController qbit receive intents', () => {
  let controller: WalletController
  let keyring: WalletKeyring
  let ledgers: Record<Network, Ledger>
  let activeAddresses: string[]
  let selectedAccount: Account | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    controller = new WalletController()
    keyring = walletKeyring([account(0)])
    ledgers = {
      mainnet: emptyLedger(),
      testnet4: emptyLedger(),
      regtest: emptyLedger(),
    }
    activeAddresses = []
    selectedAccount = keyring.accounts[0]
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockImplementation(() => selectedAccount as any)
    vi.mocked(preferenceService.setCurrentAccount).mockImplementation(accountValue => {
      selectedAccount = accountValue as Account
    })
    ;(keyringService.keyrings as any[]).splice(0, Infinity, {
      type: KeyringType.QbitHdKeyring,
      pqcFloorsPending: false,
      pqcConcurrentInstanceHint: false,
    })
    vi.spyOn(controller, 'getCurrentKeyring').mockImplementation(async () => keyring)
    vi.spyOn(controller, 'findActiveAddressGroups').mockImplementation(async groups => [
      {
        type: groups[0]!.type,
        address_arr: [...activeAddresses],
        pubkey_arr: [],
        satoshis_arr: activeAddresses.map(() => 0),
      },
    ])
    vi.mocked(keyringService.getQbitReceiveState).mockImplementation(async (_anchor, network) => {
      const ledger = ledgers[network as Network]
      return {
        currentIndex: ledger.currentIndex,
        issuedIndexes: [...ledger.issuedIndexes],
        usedIndexes: [...ledger.usedIndexes],
      }
    })
    vi.mocked(keyringService.recordQbitReceiveActivity).mockImplementation(
      async (_anchor, network, indexes) => {
        const ledger = ledgers[network as Network]
        ledger.usedIndexes = [...new Set([...ledger.usedIndexes, ...indexes])].sort(
          (left, right) => left - right
        )
      }
    )
    vi.mocked(keyringService.setQbitReceiveIntent).mockImplementation(
      async (_anchor, network, index) => {
        const ledger = ledgers[network as Network]
        ledger.currentIndex = index
        if (!ledger.issuedIndexes.includes(index)) ledger.issuedIndexes.push(index)
        if (!keyring.accounts[index]) keyring.accounts.push(account(index))
        return keyring.accounts[index]!.p2mr
      }
    )
  })

  it('does not create another address across repeated renders or visits', async () => {
    await controller.ensureQbitReceiveIntent()
    await controller.getQbitReceiveState()
    await controller.getQbitReceiveState()
    await controller.ensureQbitReceiveIntent()
    await controller.ensureQbitReceiveIntent()

    expect(keyringService.setQbitReceiveIntent).toHaveBeenCalledTimes(1)
    expect(ledgers.testnet4).toEqual({
      currentIndex: 0,
      issuedIndexes: [0],
      usedIndexes: [],
    })
  })

  it('does not expose, adopt, or create persisted intents when live activity cannot be checked', async () => {
    keyring.accounts.push(account(1))
    ledgers.testnet4 = { currentIndex: 1, issuedIndexes: [0, 1], usedIndexes: [] }
    selectedAccount = keyring.accounts[0]
    const changeKeyring = vi.spyOn(controller, 'changeKeyring')
    vi.mocked(controller.findActiveAddressGroups).mockRejectedValue(new Error('offline'))

    const ensured = await controller.ensureQbitReceiveIntent()
    const loaded = await controller.getQbitReceiveState()

    for (const state of [ensured, loaded]) {
      expect(state).toMatchObject({
        current: null,
        previous: [],
        activityStatus: 'cached',
        gap: {
          highestUsedIndex: -1,
          trailingUnusedCount: 2,
          remainingIntentCapacity: 18,
          canCreate: false,
        },
      })
    }
    expect(changeKeyring).not.toHaveBeenCalled()
    expect(keyringService.setQbitReceiveIntent).not.toHaveBeenCalled()
    expect(ledgers.testnet4).toEqual({
      currentIndex: 1,
      issuedIndexes: [0, 1],
      usedIndexes: [],
    })
    await expect(controller.createQbitReceiveIntent()).rejects.toThrow('Live activity')
  })

  it('creates exactly one durable intent for each explicit New Address action', async () => {
    await controller.ensureQbitReceiveIntent()
    const before = vi.mocked(keyringService.setQbitReceiveIntent).mock.calls.length

    const state = await controller.createQbitReceiveIntent()

    expect(vi.mocked(keyringService.setQbitReceiveIntent).mock.calls.length - before).toBe(1)
    expect(state.current?.index).toBe(1)
    expect(state.previous.map(item => item.index)).toEqual([0])
    expect(ledgers.testnet4.issuedIndexes).toEqual([0, 1])
    expect(selectedAccount?.p2mr?.hkdf.index).toBe(1)
  })

  it('rotates once when live activity is observed and keeps the used address previous', async () => {
    keyring.accounts.push(account(1))
    ledgers.testnet4 = { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }
    activeAddresses = ['tq-0']

    const first = await controller.ensureQbitReceiveIntent()
    const second = await controller.ensureQbitReceiveIntent()

    expect(first.current?.index).toBe(1)
    expect(first.previous[0]).toMatchObject({ index: 0, used: true })
    expect(second.current?.index).toBe(1)
    expect(keyringService.recordQbitReceiveActivity).toHaveBeenCalledTimes(1)
    expect(keyringService.setQbitReceiveIntent).toHaveBeenCalledTimes(1)
  })

  it('records pre-existing activity on a newly activated index before exposing it', async () => {
    ledgers.testnet4 = { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }
    activeAddresses = ['tq-0', 'tq-1']

    const state = await controller.ensureQbitReceiveIntent()

    expect(keyringService.setQbitReceiveIntent).toHaveBeenCalledWith(
      expect.anything(),
      'testnet4',
      1
    )
    // The address activated for the new intent already carried history (for
    // example from another copy of the restored seed using the next index),
    // so it lands in usedIndexes instead of being offered as safe.
    expect(state.current).toBeNull()
    expect(state.activityStatus).toBe('live')
    expect(state.previous).toContainEqual(expect.objectContaining({ index: 1, used: true }))
    expect(ledgers.testnet4.usedIndexes).toEqual([0, 1])
    // The wallet must not switch onto the used index the state refuses to
    // expose as current.
    expect(selectedAccount?.p2mr?.hkdf.index).toBe(0)
  })

  it('does not present a newly activated index as live-verified when the recheck fails', async () => {
    ledgers.testnet4 = { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }
    activeAddresses = ['tq-0']
    vi.mocked(controller.findActiveAddressGroups)
      .mockImplementationOnce(async groups => [
        { type: groups[0]!.type, address_arr: ['tq-0'], pubkey_arr: [], satoshis_arr: [0] },
      ])
      .mockRejectedValueOnce(new Error('offline'))

    const state = await controller.ensureQbitReceiveIntent()

    expect(keyringService.setQbitReceiveIntent).toHaveBeenCalledWith(
      expect.anything(),
      'testnet4',
      1
    )
    expect(state).toMatchObject({ current: null, activityStatus: 'cached' })
    // Adoption is gated on a live-verified current address, so the failed
    // recheck must leave the wallet on its previous account.
    expect(selectedAccount?.p2mr?.hkdf.index).toBe(0)
  })

  it('never selects an exhausted address', async () => {
    keyring = walletKeyring([account(0, 'exhausted'), account(1, 'normal')])
    ledgers.testnet4 = { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }

    const state = await controller.ensureQbitReceiveIntent()

    expect(state.current).toMatchObject({ index: 1 })
    expect(state.previous).toContainEqual(
      expect.objectContaining({
        index: 0,
        signatureCounter: expect.objectContaining({ state: 'exhausted', remaining: 0 }),
      })
    )
  })

  it('offers no receive address while restored counter floors are pending', async () => {
    ;(keyringService.keyrings as any[])[0].pqcFloorsPending = true

    const state = await controller.ensureQbitReceiveIntent()

    expect(state).toMatchObject({ current: null, previous: [], floorsPending: true })
    expect(state.gap.canCreate).toBe(false)
    expect(keyringService.setQbitReceiveIntent).not.toHaveBeenCalled()
    await expect(controller.createQbitReceiveIntent()).rejects.toThrow('Counter reconstruction')
  })

  it('returns no suggestion and refuses explicit rotation at the gap-limit boundary', async () => {
    keyring = walletKeyring(Array.from({ length: 20 }, (_, index) => account(index)))
    ledgers.testnet4 = {
      currentIndex: 19,
      issuedIndexes: Array.from({ length: 20 }, (_, index) => index),
      usedIndexes: [],
    }

    const stable = await controller.ensureQbitReceiveIntent()
    expect(stable.current?.index).toBe(19)
    expect(stable.gap).toMatchObject({ canCreate: false, trailingUnusedCount: 20 })

    await expect(controller.createQbitReceiveIntent()).rejects.toThrow('gap limit (20)')
    expect(keyringService.setQbitReceiveIntent).not.toHaveBeenCalled()
  })

  it('rediscovers restored activity and adopts an unused in-range address', async () => {
    keyring = walletKeyring([account(0), account(1), account(2, 'warning', 'restored-floor')])
    activeAddresses = ['tq-2']

    const state = await controller.ensureQbitReceiveIntent()

    expect(state.current?.index).toBe(0)
    expect(state.previous).toContainEqual(expect.objectContaining({ index: 2, used: true }))
    expect(ledgers.testnet4).toEqual({
      currentIndex: 0,
      issuedIndexes: [0],
      usedIndexes: [2],
    })
    expect(keyring.accounts).toHaveLength(3)
  })

  it('keeps exact receive ledgers scoped while switching networks', async () => {
    await controller.ensureQbitReceiveIntent()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)

    const mainnet = await controller.ensureQbitReceiveIntent()

    expect(mainnet.network).toBe('mainnet')
    expect(mainnet.current?.address).toBe('qb-0')
    expect(ledgers.mainnet.issuedIndexes).toEqual([0])
    expect(ledgers.testnet4.issuedIndexes).toEqual([0])
    expect(vi.mocked(keyringService.setQbitReceiveIntent).mock.calls).toEqual([
      [expect.any(String), 'testnet4', 0],
      [expect.any(String), 'mainnet', 0],
    ])
  })

  it('re-adopts a durable intent after a crash left account selection stale', async () => {
    keyring.accounts.push(account(1))
    ledgers.testnet4 = { currentIndex: 1, issuedIndexes: [0, 1], usedIndexes: [] }
    selectedAccount = keyring.accounts[0]

    const state = await controller.ensureQbitReceiveIntent()

    expect(state.current?.index).toBe(1)
    expect(selectedAccount?.p2mr?.hkdf.index).toBe(1)
    expect(keyringService.setQbitReceiveIntent).not.toHaveBeenCalled()
  })

  it('re-arms and rescans restored floors when an intent activates a new index', async () => {
    const rawKeyring = (keyringService.keyrings as any[])[0]
    rawKeyring.pqcRestoredFromMnemonic = true
    rawKeyring.getAccounts = vi.fn(async () => ['pub-0'])
    ledgers.testnet4 = { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      rawKeyring.pqcFloorsPending = true
      return true
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      rawKeyring.pqcFloorsPending = false
      return { floors: [], gapIndexesWithActivity: [], possibleConcurrentInstance: false } as any
    })

    const state = await controller.createQbitReceiveIntent()

    expect(keyringService.rearmQbitRestoreFloorsForKeyring).toHaveBeenCalledWith('tq-0')
    expect(keyringService.restorePqcSignatureCounterFloors).toHaveBeenCalledWith(
      'pub-0',
      expect.any(Function),
      undefined
    )
    // The sign-lock lands with the activation and the covering scan lifts it
    // before the new address is exposed to the caller.
    const [intentOrder] = vi.mocked(keyringService.setQbitReceiveIntent).mock.invocationCallOrder
    const [rearmOrder] = vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mock
      .invocationCallOrder
    const [scanOrder] = vi.mocked(keyringService.restorePqcSignatureCounterFloors).mock
      .invocationCallOrder
    expect(intentOrder).toBeLessThan(rearmOrder!)
    expect(rearmOrder).toBeLessThan(scanOrder!)
    expect(state.floorsPending).toBe(false)
    expect(state.current?.index).toBe(1)
  })

  it('does not rescan floors when a restored keyring reuses an existing index', async () => {
    const rawKeyring = (keyringService.keyrings as any[])[0]
    rawKeyring.pqcRestoredFromMnemonic = true

    const state = await controller.createQbitReceiveIntent()

    expect(state.current?.index).toBe(0)
    expect(keyringService.setQbitReceiveIntent).toHaveBeenCalledTimes(1)
    expect(keyringService.rearmQbitRestoreFloorsForKeyring).not.toHaveBeenCalled()
    expect(keyringService.restorePqcSignatureCounterFloors).not.toHaveBeenCalled()
  })

  it('keeps an activated index sign-locked when the covering floor scan fails', async () => {
    const rawKeyring = (keyringService.keyrings as any[])[0]
    rawKeyring.pqcRestoredFromMnemonic = true
    rawKeyring.getAccounts = vi.fn(async () => ['pub-0'])
    ledgers.testnet4 = { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      rawKeyring.pqcFloorsPending = true
      return true
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockRejectedValue(
      new Error('history unavailable')
    )

    await expect(controller.createQbitReceiveIntent()).rejects.toThrow('history unavailable')

    expect(rawKeyring.pqcFloorsPending).toBe(true)
    const state = await controller.getQbitReceiveState()
    expect(state).toMatchObject({ current: null, previous: [], floorsPending: true })
    expect(state.gap.canCreate).toBe(false)
  })

  it('preserves all four budget states and both provenance values', async () => {
    keyring = walletKeyring([
      account(0, 'normal', 'local'),
      account(1, 'warning', 'restored-floor'),
      account(2, 'critical', 'local'),
      account(3, 'exhausted', 'restored-floor'),
    ])
    ledgers.testnet4 = {
      currentIndex: 0,
      issuedIndexes: [0, 1, 2, 3],
      usedIndexes: [],
    }

    const state = await controller.getQbitReceiveState()
    const counters = [state.current!, ...state.previous]
      .sort((left, right) => left.index - right.index)
      .map(item => item.signatureCounter)

    expect(counters.map(counter => counter.state)).toEqual([
      'normal',
      'warning',
      'critical',
      'exhausted',
    ])
    expect(counters.map(counter => counter.provenance)).toEqual([
      'local',
      'restored-floor',
      'local',
      'restored-floor',
    ])
  })
})
