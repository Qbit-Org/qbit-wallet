import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import {
  BUS_EVENTS,
  KeyringType,
  QBIT_BALANCE_READ_PROGRESS,
  type QbitBalanceReadProgress,
} from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The send guard is the real service and the explorer a fake served over
// fetch, so outputs, statistics and reservations come from production logic.
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  const lock = { isUnlocked: true }
  let chainType = 'QBIT_TESTNET4'
  return {
    keyringService: {
      keyrings: [],
      memStore: { getState: () => lock },
      setLocked: vi.fn(async () => {
        lock.isUnlocked = false
      }),
      unlockForTest: () => {
        lock.isUnlocked = true
      },
      lockForTest: () => {
        lock.isUnlocked = false
      },
      removeKeyring: vi.fn(async () => undefined),
      resetAllData: vi.fn(async () => {
        await Promise.resolve()
        lock.isUnlocked = false
      }),
      changeAddressType: vi.fn(),
      syncQbitHdPath: vi.fn(async () => false),
      rearmQbitRestoreFloors: vi.fn(async () => false),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => chainType),
      setChainType: vi.fn((next: string) => {
        chainType = next
      }),
      persist: vi.fn(async () => undefined),
      getCurrentKeyringIndex: vi.fn(() => 0),
      setCurrentKeyringIndex: vi.fn(),
      setCurrentAccount: vi.fn(),
      getAutoLockTimeId: vi.fn(),
      resetAllData: vi.fn(async () => undefined),
      removeKeyringAlianName: vi.fn(),
      removeKeyringColor: vi.fn(),
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn(), broadcastChainChange: vi.fn() },
    contactBookService: { resetAllData: vi.fn(async () => undefined) },
    permissionService: {
      resetAllData: vi.fn(async () => undefined),
      updateConnectSite: vi.fn(async () => undefined),
    },
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

const pubkeyHex = '11'.repeat(32)
const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
const accountScript = bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)))
const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'testnet4')
const account = {
  type: KeyringType.QbitHdKeyring,
  pubkey: pubkeyHex,
  address,
  key: 'account-0',
  flag: 0,
  index: 0,
  p2mr: {
    pubkey: pubkeyHex,
    path: `m/87'/1'/0'/0/0`,
    scriptPubKey: accountScript,
    leafScript: bytesToHex(leafScript),
    addresses: { testnet4: address },
    hkdf: { account: 0, change: 0, index: 0 },
    signatureCounter: {
      count: 0,
      limit: 1073741824,
      remaining: 1073741824,
      state: 'normal',
      provenance: 'local',
    },
  },
}

// Outputs a coinbase maturity deep, classified from the listing alone, and
// younger ones, each read by a lookup of its transaction.
const DEEP = 30
const YOUNG = 10
const OUTPUT_VALUE = 10_000
const TOTAL = (DEEP + YOUNG) * OUTPUT_VALUE
const PORT = 'popup:1'

describe("WalletController's kept balance answers and balance read progress", () => {
  let explorer: FakeQbitExplorer
  let lookupDelayMs = 0
  let statsDelayMs = 0
  let events: Array<{ port: string; method: string; params: QbitBalanceReadProgress }>
  const record = (message: any): void => {
    if (message?.method === QBIT_BALANCE_READ_PROGRESS) events.push(message)
  }

  function controller() {
    // Each lookup of a transaction, and the statistics, answer after a delay
    // the test sets, as over a slow link.
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (lookupDelayMs > 0 && /\/tx\/[0-9a-f]{64}$/.test(url)) {
        await new Promise(resolve => setTimeout(resolve, lookupDelayMs))
      }
      if (statsDelayMs > 0 && new URL(url).pathname.endsWith(`/address/${address}`)) {
        await new Promise(resolve => setTimeout(resolve, statsDelayMs))
      }
      return explorer.fetch(input, init)
    })
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    return wallet
  }

  const readForPage = (wallet: WalletController, options: object = { progressId: 'read-1' }) =>
    wallet.runForUiPort(
      PORT,
      () => wallet.getAddressBalanceV2(address, options as never),
      'getAddressBalanceV2'
    )

  beforeEach(async () => {
    vi.clearAllMocks()
    lookupDelayMs = 0
    statsDelayMs = 0
    events = []
    bgEventBus.addEventListener(BUS_EVENTS.toUIPort, record)
    explorer = new FakeQbitExplorer('mempool-qbit')
    explorer.registerAddress(address, accountScript)
    explorer.utxoLimit = 1_000_000
    for (let index = 0; index < DEEP + YOUNG; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
        // The deep ones far below the tip; the young ones a few blocks down.
        height: index < DEEP ? 100 : explorer.tipHeight - 5,
      })
    }
    ;(preferenceService as any).setChainType(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    await qbitSendGuardService.resetAllData()
    ;(keyringService as any).unlockForTest()
  })

  afterEach(async () => {
    bgEventBus.removeEventListener(BUS_EVENTS.toUIPort, record)
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await qbitSendGuardService.resetAllData()
  })

  describe('the answer kept for a page opened later (B3)', () => {
    it('serves the last complete answer, dated by when its read began, and none before', async () => {
      const wallet = controller()
      expect(await wallet.getKeptAddressBalance(address)).toBeNull()
      const before = Date.now()
      const answer = await wallet.getAddressBalanceV2(address)
      const kept = await wallet.getKeptAddressBalance(address)

      expect(answer).toMatchObject({ totalBalance: TOTAL, availableBalance: TOTAL })
      expect(kept?.balance).toEqual(answer)
      expect(kept?.readAt).toBeGreaterThanOrEqual(before)
      expect(kept?.readAt).toBeLessThanOrEqual(Date.now())
      // A copy: what a page does with it changes nothing kept.
      ;(kept!.balance as { totalBalance: number }).totalBalance = 1
      expect((await wallet.getKeptAddressBalance(address))?.balance.totalBalance).toBe(TOTAL)
    })

    it('keeps nothing of an answer that could not read every output, and keeps the complete one before it', async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      explorer.failures.push(({ path }) => (/\/tx\//.test(path) ? { status: 502 } : undefined))
      explorer.addTx({
        txid: fakeTxid(999),
        inputs: [{ txid: fakeTxid(999, 5_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
        height: explorer.tipHeight,
      })
      const incomplete = await wallet.getAddressBalanceV2(address)

      expect(incomplete).toMatchObject({ utxoReadIncomplete: true })
      expect((await wallet.getKeptAddressBalance(address))?.balance.totalBalance).toBe(TOTAL)
    })

    it('serves nothing while the wallet reads locked, and keeps nothing a read began before a lock', async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      ;(keyringService as any).lockForTest()
      expect(await wallet.getKeptAddressBalance(address)).toBeNull()
      ;(keyringService as any).unlockForTest()

      // A read asked for before a lock, that ends after the unlock.
      statsDelayMs = 50
      const reading = wallet.getAddressBalanceV2(address)
      await wallet.lockWallet()
      ;(keyringService as any).unlockForTest()
      await reading
      expect(await wallet.getKeptAddressBalance(address)).toBeNull()
    })

    /** Remove the account's keyring, another one remaining. */
    async function removeAccountKeyring(wallet: WalletController): Promise<void> {
      const keyring = { type: KeyringType.QbitHdKeyring, index: 0, key: 'k', accounts: [account] }
      const remaining = {
        type: KeyringType.QbitHdKeyring,
        index: 1,
        key: 'keyring_1',
        accounts: [{ ...account, key: 'keyring_1#0' }],
      }
      vi.spyOn(wallet as any, 'readKeyringsAfresh')
        .mockResolvedValueOnce([keyring, remaining])
        .mockResolvedValueOnce([remaining])
      vi.spyOn(wallet as any, 'resolveQueuedWalletKeyring').mockReturnValue(keyring)
      vi.spyOn(wallet as any, 'collectQbitRecoveryRemovalReasons').mockResolvedValue([])
      vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
      const slots = (keyringService as any).keyrings
      slots.push({ type: KeyringType.QbitHdKeyring }, { type: KeyringType.QbitHdKeyring })
      try {
        await wallet.removeKeyring(keyring as any)
      } finally {
        slots.length = 0
      }
    }

    const clears: Array<[string, (wallet: WalletController) => Promise<void> | void]> = [
      [
        'the wallet locks and unlocks',
        async wallet => {
          await wallet.lockWallet()
          ;(keyringService as any).unlockForTest()
        },
      ],
      [
        'the wallet data is reset',
        async wallet => {
          await wallet.resetAllData()
          clearTimeout(wallet.timer)
          ;(keyringService as any).unlockForTest()
        },
      ],
      [
        'the wallet caches are dropped by a Reset Wallet',
        wallet => (wallet as any).dropWalletCaches(),
      ],
      ['a keyring is removed', removeAccountKeyring],
      [
        'the keyring service locks the wallet on its own',
        async wallet => {
          const lockState = (keyringService as any).memStore.getState()
          vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
            type: KeyringType.HdKeyring,
            accounts: [],
          } as any)
          vi.mocked(keyringService.changeAddressType).mockImplementationOnce(async () => {
            lockState.isUnlocked = false
            throw new Error('address type not restored')
          })
          await expect(wallet.changeAddressType(AddressType.P2TR)).rejects.toThrow()
          ;(keyringService as any).unlockForTest()
        },
      ],
      [
        'the network changes away and back',
        async wallet => {
          const keyring = { index: 0, type: KeyringType.QbitHdKeyring, accounts: [account] }
          vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(keyring as any)
          vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
          vi.spyOn(wallet as any, 'kickPendingQbitRestoreFloorScan').mockImplementation(
            () => undefined
          )
          await wallet.setChainType(ChainType.QBIT_MAINNET)
          await wallet.setChainType(ChainType.QBIT_TESTNET4)
        },
      ],
      ['the regtest clients are dropped', wallet => (wallet as any).dropRegtestApiClients()],
      [
        'a transaction goes out',
        async wallet => {
          const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
          vi.spyOn(client, 'broadcastTx').mockResolvedValue('00'.repeat(32))
          await (wallet as any).submitQbitTx(client, 'deadbeef')
        },
      ],
    ]

    const holds = (wallet: WalletController): boolean =>
      (wallet as any).qbitKeptBalances.networks.get(ChainType.QBIT_TESTNET4)?.has(address) === true

    it('holds no answer while the wallet data is reset, and keeps nothing a read made during its writes', async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      const lockState = (keyringService as any).memStore.getState()
      let writing: () => void = () => undefined
      const writesBegan = new Promise<void>(resolve => (writing = resolve))
      let finishWrites: () => void = () => undefined
      const writes = new Promise<void>(resolve => (finishWrites = resolve))
      // The keyring service marks the wallet locked only once its writes are done.
      vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
        writing()
        await writes
        lockState.isUnlocked = false
      })
      const reset = wallet.resetAllData()
      await writesBegan
      // Gone before the writes, by the reset's first clear.
      expect(holds(wallet)).toBe(false)
      // The wallet still reads unlocked: a read keeps its answer, which goes
      // once the writes are done.
      await wallet.getAddressBalanceV2(address)
      expect(holds(wallet)).toBe(true)
      finishWrites()
      await reset
      clearTimeout(wallet.timer)
      expect(holds(wallet)).toBe(false)
    })

    it('holds no answer from a keyring removal on, and none a read kept before the removal settled the current wallet', async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      let arrive: () => void = () => undefined
      const arrived = new Promise<void>(resolve => (arrive = resolve))
      let release: () => void = () => undefined
      const ended = new Promise<void>(resolve => (release = resolve))
      vi.spyOn((wallet as any).qbitSendPlans, 'endPlansOf').mockImplementation(async () => {
        arrive()
        await ended
        return { mayHaveBeenSent: [] }
      })
      const removal = removeAccountKeyring(wallet)
      await arrived
      expect(holds(wallet)).toBe(false)
      // The removed wallet is still stored as current: a read of it keeps an answer.
      await wallet.getAddressBalanceV2(address)
      expect(holds(wallet)).toBe(true)
      release()
      await removal
      expect(holds(wallet)).toBe(false)
    })

    it('forgets again as a transaction settles, keeps nothing a read during it answered, and leaves the reads in flight telling their page (item 8)', async () => {
      lookupDelayMs = 400
      const wallet = controller()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      let settleBroadcast: (txid: string) => void = () => undefined
      vi.spyOn(client, 'broadcastTx').mockImplementation(
        () => new Promise<string>(resolve => (settleBroadcast = resolve))
      )
      // A page's read is in flight when the transaction goes out.
      const reading = readForPage(wallet)
      await new Promise(resolve => setTimeout(resolve, 50))
      const submitted = (wallet as any).submitQbitTx(client, 'deadbeef')
      const answer = await reading
      // Told how it went to the end, though a transaction went out meanwhile.
      expect(events.map(event => event.params.kind)).toEqual(['total', 'outputs'])
      expect(answer.totalBalance).toBe(TOTAL)
      // Its answer, and that of a read begun during the broadcast, are not kept once it settles.
      lookupDelayMs = 0
      await wallet.getAddressBalanceV2(address)
      expect(holds(wallet)).toBe(true)
      settleBroadcast('00'.repeat(32))
      await submitted
      expect(holds(wallet)).toBe(false)
      expect(await wallet.getKeptAddressBalance(address)).toBeNull()
    })

    it.each(clears)('holds no answer once %s', async (_clear, during) => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      expect(holds(wallet)).toBe(true)

      await during(wallet)

      // Gone from memory, not only no longer served.
      expect(holds(wallet)).toBe(false)
      expect(await wallet.getKeptAddressBalance(address)).toBeNull()
    })
  })

  describe('the progress told to the page that asked (B1, B2)', () => {
    it('tells that page the total as the statistics answer, then the output count a few times a second, and nothing after', async () => {
      lookupDelayMs = 400
      const wallet = controller()
      const answer = await readForPage(wallet)

      expect(events.every(event => event.port === PORT)).toBe(true)
      const [first, ...counts] = events.map(event => event.params)
      expect(first).toEqual({
        progressId: 'read-1',
        kind: 'total',
        address,
        chainType: ChainType.QBIT_TESTNET4,
        totalBalance: answer.totalBalance,
      })
      // At 250 ms the deep outputs are read from the listing, the young ones
      // still being looked up; the read ends before the next look.
      expect(counts).toEqual([
        {
          progressId: 'read-1',
          kind: 'outputs',
          address,
          chainType: ChainType.QBIT_TESTNET4,
          read: DEEP,
          total: DEEP + YOUNG,
        },
      ])
      const told = events.length
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(events).toHaveLength(told)
    })

    it('counts the outputs served from kept facts as read', async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      // One more young output, whose lookup waits; the facts the first read
      // kept serve the other young ones at once.
      explorer.addTx({
        txid: fakeTxid(999),
        inputs: [{ txid: fakeTxid(999, 5_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
        height: explorer.tipHeight - 5,
      })
      lookupDelayMs = 400
      const answer = await readForPage(wallet, { progressId: 'read-2' })

      expect(answer.totalBalance).toBe(TOTAL + OUTPUT_VALUE)
      expect(events.map(event => event.params)).toEqual([
        expect.objectContaining({ kind: 'total', totalBalance: TOTAL + OUTPUT_VALUE }),
        expect.objectContaining({ kind: 'outputs', read: DEEP + YOUNG, total: DEEP + YOUNG + 1 }),
      ])
    })

    it.each<[string, () => void]>([
      [
        'another account is selected',
        () => {
          vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
            ...account,
            address: 'tq1zanotheraccount',
          } as any)
        },
      ],
      ['the wallet reads locked', () => (keyringService as any).lockForTest()],
    ])('tells the page nothing once %s while the statistics are read', async (_case, change) => {
      statsDelayMs = 100
      const wallet = controller()
      const reading = readForPage(wallet).catch(() => undefined)
      change()
      await reading
      expect(events).toEqual([])
    })

    it.each<[string, object]>([
      ['no options', undefined as never],
      ['no progress id', {}],
      ['an id the page could not have chosen', { progressId: 'not an id!' }],
      ['an id too long', { progressId: 'x'.repeat(65) }],
      ['an id that is no string', { progressId: 7 }],
    ])('tells nothing for %s, and answers as ever', async (_case, options) => {
      const wallet = controller()
      const answer = await wallet.runForUiPort(
        PORT,
        () => wallet.getAddressBalanceV2(address, options as never),
        'getAddressBalanceV2'
      )
      expect(answer.totalBalance).toBe(TOTAL)
      expect(events).toEqual([])
    })

    it('tells nothing for a read that came through no page', async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address, { progressId: 'read-1' })
      expect(events).toEqual([])
    })

    it('stops its timer when the read fails', async () => {
      lookupDelayMs = 0
      const wallet = controller()
      explorer.failures.push(({ path }) =>
        path.endsWith(`/address/${address}`) ? { status: 500, body: 'statistics down' } : undefined
      )
      const timers = vi.spyOn(globalThis, 'setInterval')
      const cleared = vi.spyOn(globalThis, 'clearInterval')
      await expect(readForPage(wallet)).rejects.toThrow()
      expect(events).toEqual([])
      // No total, so no timer was started; one started by a read that fails
      // later is stopped as it ends (see the publisher's own tests).
      expect(timers.mock.calls.length).toBe(cleared.mock.calls.length)
      timers.mockRestore()
      cleared.mockRestore()
    })
  })
})
