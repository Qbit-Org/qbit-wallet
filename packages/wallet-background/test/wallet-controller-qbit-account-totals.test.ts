import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { CHAINS_MAP, KeyringType } from '@qbit/wallet-shared'
import { transactionCore } from '@qbit/wallet-core'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import regtestAccessService from '../src/services/regtestAccess'
import {
  QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES,
  QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT,
  QBIT_ACCOUNT_TOTAL_FRESH_MS,
  QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS,
  QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS,
  QBIT_ACCOUNT_TOTAL_SETTLING_MS,
} from '../src/utils/qbit-account-totals'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

/**
 * The wallets the keyring service shows: `list`, the same object until a
 * test replaces it, as the service keeps its list until the keyrings
 * change; a read answers the list as it was when it began. With `hold`,
 * the next read waits for it. While `cold`, the service keeps no list: a
 * read builds every wallet (`builds`), and keeps its list once built.
 */
const shown = vi.hoisted(() => ({
  list: [] as unknown[],
  hold: undefined as Promise<void> | undefined,
  fail: undefined as Error | undefined,
  cold: false,
  builds: 0,
}))

// The send guard is the real service and the explorer a fake served over
// fetch, so the statistics come through the real client, as in
// wallet-controller-qbit-funding-tx-reads.test.ts.
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
      // Marks the wallet locked at once, as the keyring service does.
      setLocked: vi.fn(async () => {
        lock.isUnlocked = false
      }),
      unlockForTest: () => {
        lock.isUnlocked = true
      },
      removeKeyring: vi.fn(async () => undefined),
      // Marks the wallet locked once its writes are done, as the keyring service does.
      resetAllData: vi.fn(async () => {
        await Promise.resolve()
        lock.isUnlocked = false
      }),
      changeAddressType: vi.fn(),
      syncQbitHdPath: vi.fn(async () => false),
      rearmQbitRestoreFloors: vi.fn(async () => false),
      getAllDisplayedKeyrings: vi.fn(async () => {
        const list = shown.list
        const building = shown.cold
        if (building) shown.builds += 1
        const hold = shown.hold
        shown.hold = undefined
        if (hold) await hold
        if (shown.fail) throw shown.fail
        if (building && list === shown.list) shown.cold = false
        return list
      }),
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
      // The record a wallet removal keeps of the send plans it ends (#216).
      getQbitSendPlanRemovals: vi.fn(() => ({
        records: [],
        unreadable: { count: 0, accounts: [] },
      })),
      addQbitSendPlanRemoval: vi.fn(async (wallet: unknown, accounts: unknown) => ({
        version: 1,
        id: 'a1'.repeat(16),
        wallet,
        accounts,
      })),
      forgetQbitSendPlanRemoval: vi.fn(async () => undefined),
      updateAddressBalance: vi.fn(),
      getAccountAlianName: vi.fn((_key: string, fallback: string) => fallback),
      getKeyringAlianName: vi.fn((key: string) => `Wallet ${key}`),
      getKeyringColor: vi.fn(() => undefined),
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

function accountOf(seed: string) {
  const pubkeyHex = seed.repeat(32)
  const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
  const script = bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)))
  const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'testnet4')
  return {
    script,
    account: {
      type: KeyringType.QbitHdKeyring,
      pubkey: pubkeyHex,
      address,
      key: `account-${seed}`,
      flag: 0,
      index: 0,
      p2mr: {
        pubkey: pubkeyHex,
        path: `m/87'/1'/0'/0/0`,
        scriptPubKey: script,
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
    },
  }
}

const first = accountOf('11')
const second = accountOf('22')
const stranger = accountOf('33')
const address = first.account.address
const otherAddress = second.account.address
const strangerAddress = stranger.account.address

/** A shown P2MR wallet in slot `index`, as the keyring service lists it, of `accounts`. */
function shownWallet(index: number, accounts: ReturnType<typeof accountOf>[]) {
  return {
    type: KeyringType.QbitHdKeyring,
    index,
    addressType: AddressType.P2MR,
    keyring: { hdPath: `m/87'/1'/0'/0` },
    accounts: accounts.map(({ account }) => ({ pubkey: account.pubkey, keyring: account.p2mr })),
  }
}

const FIRST_TOTAL = 30_000
const SECOND_TOTAL = 12_000

/** An explorer where each own account was paid once, long ago; the stranger too. */
/** Whether `path`, as the fake explorer records it, query included, reads `of`'s statistics. */
const isStatisticsOf = (path: string, of: string) => path.split('?')[0] === `/address/${of}`

function accountsExplorer(): FakeQbitExplorer {
  const target = new FakeQbitExplorer('mempool-qbit')
  for (const [index, [{ account, script }, value]] of (
    [
      [first, FIRST_TOTAL],
      [second, SECOND_TOTAL],
      [stranger, 1],
    ] as const
  ).entries()) {
    target.registerAddress(account.address, script)
    target.addTx({
      txid: fakeTxid(index),
      inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
      outputs: [{ address: account.address, script, value }],
      height: 100,
    })
  }
  return target
}

/** A signed single-input P2MR transaction, as a dapp's push or a recovery plan hands it over. */
function signedRawTx(): { rawTxHex: string; txid: string } {
  const pubkey = hexToBytes('44'.repeat(32))
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: hexToBytes(fakeTxid(7, 9_000_000)), vout: 0 },
        witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      },
    ],
    outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
  })
  const signing = signP2mrPsbt({
    psbt,
    keys: [{ inputIndex: 0, pubkey, leafHash }],
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
  })
  const rawTx = extractP2mrTransaction(finalizeP2mrPsbt(signing.psbt))
  return {
    rawTxHex: bytesToHex(rawTx),
    txid: transactionCore.Transaction.fromBuffer(Buffer.from(rawTx)).getId(),
  }
}

const noTotal = (forAddress: string, chainType = ChainType.QBIT_TESTNET4) => ({
  address: forAddress,
  chainType,
  totalBalance: null,
  readAt: null,
  fresh: false,
  error: false,
})

describe("WalletController's account totals", () => {
  let explorer: FakeQbitExplorer
  /** The host of every request, in order. */
  let hosts: string[]
  /** Every request's URL, in order. */
  let urls: string[]

  function controller() {
    stubFetch()
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(first.account as any)
    return wallet
  }

  /** Serve `explorer`, first waiting on `before` for each request it returns a wait for. */
  function stubFetch(before?: (url: string) => Promise<void> | undefined) {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      hosts.push(new URL(url).host)
      urls.push(url)
      const wait = before?.(url)
      if (wait) await wait
      return explorer.fetch(input, init)
    })
  }

  /** Hold the next statistics read of `of`, once asked for (`arrived`), until `release`. */
  const holdNextStatistics = (of = address) => holdNext(`/address/${of}`)

  /** Hold the next request for a path ending in `suffix`, once asked for (`arrived`), until `release`. */
  function holdNext(suffix: string) {
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const arrived = new Promise<void>(resolve => (arrive = resolve))
    let held = false
    stubFetch(url => {
      if (held || !new URL(url).pathname.endsWith(suffix)) return undefined
      held = true
      arrive()
      return released
    })
    return { arrived, release }
  }

  /**
   * Answer the next request for a path ending in `suffix` as the explorer
   * stands when it is asked (`arrived`), but deliver it only on `release`.
   */
  function holdNextReply(suffix: string) {
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const arrived = new Promise<void>(resolve => (arrive = resolve))
    let held = false
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      hosts.push(new URL(url).host)
      urls.push(url)
      const response = await explorer.fetch(input, init)
      if (!held && new URL(url).pathname.endsWith(suffix)) {
        held = true
        arrive()
        await released
      }
      return response
    })
    return { arrived, release }
  }

  /** A dapp's push of a transaction paying the first account `value`, which the explorer shows at once. */
  async function sendPaying(wallet: WalletController, value: number): Promise<void> {
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
    const { rawTxHex, txid } = signedRawTx()
    vi.spyOn(client, 'broadcastTx').mockImplementation(async () => {
      explorer.addTx({
        txid: fakeTxid(9, 9_000_000),
        inputs: [{ txid: fakeTxid(9, 9_100_000), vout: 0 }],
        outputs: [{ address, script: first.script, value }],
      })
      return txid
    })
    await expect(wallet.broadcastQbitProviderTx(rawTxHex)).resolves.toMatchObject({
      success: true,
    })
  }

  /** Statistics requests asked for `of` so far, those still held included. */
  const statisticsAsked = (of = address) =>
    urls.filter(url => new URL(url).pathname.endsWith(`/address/${of}`)).length

  /** Statistics reads of `of` so far. */
  const statisticsReads = (of = address) =>
    explorer.requests.filter(request => isStatisticsOf(request.path, of)).length

  /** Every request to the explorer `run` makes. */
  async function requestsOf(run: () => Promise<unknown>): Promise<number> {
    const before = explorer.requests.length
    await run()
    return explorer.requests.length - before
  }

  const lockState = () => (keyringService as any).memStore.getState() as { isUnlocked: boolean }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
    explorer = accountsExplorer()
    hosts = []
    urls = []
    shown.list = [shownWallet(0, [first]), shownWallet(1, [second])]
    shown.hold = undefined
    shown.fail = undefined
    shown.cold = false
    shown.builds = 0
    ;(preferenceService as any).setChainType(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(first.account as any)
    await qbitSendGuardService.resetAllData()
    ;(keyringService as any).unlockForTest()
  })

  afterEach(async () => {
    // Every vi.spyOn goes back to the original, the send guard's and the
    // log's included, which outlive the test: no test runs with another's.
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await qbitSendGuardService.resetAllData()
  })

  describe('arguments', () => {
    it('refuses anything but a non-empty string for readQbitAccountTotal', async () => {
      const wallet = controller()
      for (const bad of [42, null, undefined, {}, [], [address], '', true]) {
        await expect(wallet.readQbitAccountTotal(bad as any), String(bad)).rejects.toThrow(Error)
      }
      expect(explorer.requests).toHaveLength(0)
      await expect(wallet.readQbitAccountTotal(address)).resolves.toMatchObject({
        address,
        totalBalance: FIRST_TOTAL,
      })
    })

    it('refuses anything but an array of at most 1,024 non-empty strings for getQbitAccountTotals', async () => {
      const wallet = controller()
      const sparse: string[] = []
      sparse[1] = address
      for (const bad of [
        address,
        null,
        undefined,
        42,
        { 0: address, length: 1 },
        Array(QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES + 1).fill(address),
        [address, null],
        [address, ''],
        [address, 5],
        [address, [address]],
        sparse,
      ]) {
        await expect(wallet.getQbitAccountTotals(bad as any)).rejects.toThrow(Error)
      }

      await expect(wallet.getQbitAccountTotals([])).resolves.toEqual([])
      const most = Array(QBIT_ACCOUNT_TOTALS_MAX_ADDRESSES).fill(address)
      await expect(wallet.getQbitAccountTotals(most)).resolves.toHaveLength(most.length)
      expect(explorer.requests).toHaveLength(0)
    })
  })

  describe('getQbitAccountTotals', () => {
    it('answers what is kept, one answer per entry in order, and reads nothing', async () => {
      const wallet = controller()
      const read = await wallet.readQbitAccountTotal(address)
      expect(read).toEqual({
        address,
        chainType: ChainType.QBIT_TESTNET4,
        totalBalance: FIRST_TOTAL,
        readAt: Date.now(),
        fresh: true,
        error: false,
      })

      let answers: unknown
      expect(
        await requestsOf(async () => {
          answers = await wallet.getQbitAccountTotals([
            otherAddress,
            address,
            strangerAddress,
            address,
          ])
        })
      ).toBe(0)
      expect(answers).toEqual([noTotal(otherAddress), read, noTotal(strangerAddress), read])

      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_FRESH_MS)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toEqual([
        { ...read, fresh: false },
      ])
    })
  })

  describe('readQbitAccountTotal', () => {
    it('reads the statistics once, under the deadline, and answers from them for 60 s', async () => {
      const wallet = controller()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      const balance = vi.spyOn(client, 'getAddressBalance')

      const [one, two] = await Promise.all([
        wallet.readQbitAccountTotal(address),
        wallet.readQbitAccountTotal(address),
      ])
      expect(one).toEqual(two)
      expect(one).toMatchObject({ totalBalance: FIRST_TOTAL, fresh: true, error: false })
      expect(balance).toHaveBeenCalledTimes(1)
      expect(balance).toHaveBeenCalledWith(address, {
        deadlineMs: QBIT_ACCOUNT_TOTAL_READ_DEADLINE_MS,
        signal: expect.any(AbortSignal),
        fresh: true,
      })
      // The statistics alone: no listing, no history.
      // A fresh read: under a URL of its own, past every cache.
      expect(explorer.requests).toEqual([
        {
          method: 'GET',
          path: expect.stringMatching(
            new RegExp(`^/address/${address}\\?qbit_fresh=[0-9a-f]{24}$`)
          ),
        },
      ])

      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_FRESH_MS - 1)
      expect(await requestsOf(() => wallet.readQbitAccountTotal(address))).toBe(0)
      vi.setSystemTime(Date.now() + 1)
      expect(await requestsOf(() => wallet.readQbitAccountTotal(address))).toBe(1)
    })

    it('reads nothing for an address that is no account of a listed wallet', async () => {
      const wallet = controller()
      await expect(wallet.readQbitAccountTotal(strangerAddress)).resolves.toEqual(
        noTotal(strangerAddress)
      )
      expect(explorer.requests).toHaveLength(0)
    })

    it('reads nothing and answers no total while the wallet reads locked', async () => {
      const wallet = controller()
      await wallet.readQbitAccountTotal(address)
      lockState().isUnlocked = false

      expect(await requestsOf(() => wallet.readQbitAccountTotal(otherAddress))).toBe(0)
      await expect(wallet.readQbitAccountTotal(address)).resolves.toEqual(noTotal(address))
      await expect(wallet.getQbitAccountTotals([address])).resolves.toEqual([noTotal(address)])
      // Not even the wallets are read while locked.
      expect(keyringService.getAllDisplayedKeyrings).toHaveBeenCalledTimes(1)
    })

    it('keeps nothing from a read the wallet locks during', async () => {
      const wallet = controller()
      const statistics = holdNextStatistics()
      const running = wallet.readQbitAccountTotal(address)
      await statistics.arrived

      await wallet.lockWallet()
      ;(keyringService as any).unlockForTest()
      statistics.release()

      await expect(running).resolves.toEqual(noTotal(address))
      await expect(wallet.getQbitAccountTotals([address])).resolves.toEqual([noTotal(address)])
    })

    it('resolves with error and the last total when the read fails, never 0', async () => {
      const wallet = controller()
      let failing = true
      explorer.failures.push(({ path }) =>
        failing && isStatisticsOf(path, otherAddress) ? { status: 404 } : undefined
      )
      await expect(wallet.readQbitAccountTotal(otherAddress)).resolves.toEqual({
        ...noTotal(otherAddress),
        error: true,
      })

      failing = false
      const { readAt } = await wallet.readQbitAccountTotal(address)
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_FRESH_MS)
      explorer.failures.push(({ path }) =>
        isStatisticsOf(path, address) ? { status: 404 } : undefined
      )
      await expect(wallet.readQbitAccountTotal(address)).resolves.toEqual({
        address,
        chainType: ChainType.QBIT_TESTNET4,
        totalBalance: FIRST_TOTAL,
        readAt,
        fresh: false,
        error: true,
      })
    })

    it('answers with the network active when it began, its client read, even when the network changes during the read', async () => {
      const wallet = controller()
      vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
        index: 0,
        type: KeyringType.QbitHdKeyring,
        accounts: [first.account],
      } as any)
      vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
      vi.spyOn(wallet as any, 'kickPendingQbitRestoreFloorScan').mockImplementation(() => undefined)
      const testnetHost = new URL(CHAINS_MAP[ChainType.QBIT_TESTNET4]!.endpoints[0]!).host

      const statistics = holdNextStatistics()
      const running = wallet.readQbitAccountTotal(address)
      await statistics.arrived
      await wallet.setChainType(ChainType.QBIT_MAINNET)
      statistics.release()

      await expect(running).resolves.toEqual(noTotal(address, ChainType.QBIT_TESTNET4))
      expect(hosts).toEqual([testnetHost])
      // Nothing of it is kept for either network.
      await wallet.setChainType(ChainType.QBIT_TESTNET4)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toEqual([noTotal(address)])
    })
  })

  describe('the balance read', () => {
    it("feeds its total, and only a successful read's", async () => {
      const wallet = controller()
      await wallet.getAddressBalanceV2(address)
      const statisticsBefore = statisticsReads()

      const [kept] = await wallet.getQbitAccountTotals([address])
      expect(kept).toEqual({
        address,
        chainType: ChainType.QBIT_TESTNET4,
        totalBalance: FIRST_TOTAL,
        readAt: Date.now(),
        fresh: true,
        error: false,
      })
      // So the switcher reads nothing for the account the home screen polls.
      await expect(wallet.readQbitAccountTotal(address)).resolves.toEqual(kept)
      expect(statisticsReads()).toBe(statisticsBefore)

      explorer.failures.push(({ path }) =>
        isStatisticsOf(path, otherAddress) ? { status: 404 } : undefined
      )
      await expect(wallet.getAddressBalanceV2(otherAddress)).rejects.toThrow()
      await expect(wallet.getQbitAccountTotals([otherAddress])).resolves.toEqual([
        noTotal(otherAddress),
      ])
    })

    it("does not replace a later read's total when it settles after it", async () => {
      const wallet = controller()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      // The balance read asks for the address's statistics as they are
      // (`getAddressStats`), where the switcher's read asks for its totals.
      const statisticsCalls = vi.spyOn(client, 'getAddressStats')
      // The balance read has its statistics and waits on the listing. (The
      // client shares an identical read still in flight, so it is the
      // listing that is held.)
      const listing = holdNext(`/address/${address}/utxo`)
      const balance = wallet.getAddressBalanceV2(address)
      await listing.arrived
      await statisticsCalls.mock.results[0]!.value
      expect(statisticsReads()).toBe(1)
      // The account is paid while the balance read waits; the switcher's
      // read, begun later, sees it first.
      explorer.addTx({
        txid: fakeTxid(9, 9_000_000),
        inputs: [{ txid: fakeTxid(9, 9_100_000), vout: 0 }],
        outputs: [{ address, script: first.script, value: 5_000 }],
        height: 101,
      })
      await expect(wallet.readQbitAccountTotal(address)).resolves.toMatchObject({
        totalBalance: FIRST_TOTAL + 5_000,
      })

      listing.release()
      await expect(balance).resolves.toMatchObject({ totalBalance: FIRST_TOTAL })
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL + 5_000, fresh: true },
      ])
    })
  })

  describe('a broadcast', () => {
    async function keptBoth(wallet: WalletController) {
      await wallet.readQbitAccountTotal(address)
      await wallet.readQbitAccountTotal(otherAddress)
      await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toMatchObject([
        { fresh: true },
        { fresh: true },
      ])
    }

    const stale = [
      { totalBalance: FIRST_TOTAL, fresh: false, error: false },
      { totalBalance: SECOND_TOTAL, fresh: false, error: false },
    ]

    it("leaves its client's totals in place but not fresh, a dapp's push through the send path", async () => {
      const wallet = controller()
      await keptBoth(wallet)
      const { rawTxHex, txid } = signedRawTx()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      vi.spyOn(client, 'broadcastTx').mockResolvedValue(txid)

      await expect(wallet.broadcastQbitProviderTx(rawTxHex)).resolves.toMatchObject({
        success: true,
      })

      expect(client.broadcastTx).toHaveBeenCalledTimes(1)
      await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toMatchObject(
        stale
      )
      // Read again on the next ask.
      expect(await requestsOf(() => wallet.readQbitAccountTotal(address))).toBe(1)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([{ fresh: true }])
    })

    it('leaves them not fresh after a failed submission too (pushTx)', async () => {
      const wallet = controller()
      await keptBoth(wallet)
      const { rawTxHex } = signedRawTx()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      vi.spyOn(client, 'broadcastTx').mockRejectedValue(new Error('connection lost'))

      await expect(wallet.pushTx(rawTxHex)).rejects.toThrow('connection lost')

      await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toMatchObject(
        stale
      )
    })

    it('keeps nothing fresh while a submission is under way, and what is read just after fresh for 10 s', async () => {
      const wallet = controller()
      await keptBoth(wallet)
      const { rawTxHex, txid } = signedRawTx()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      let accept: () => void = () => undefined
      vi.spyOn(client, 'broadcastTx').mockImplementation(
        () => new Promise(resolve => (accept = () => resolve(txid)))
      )
      const pushing = wallet.pushTx(rawTxHex)
      try {
        await vi.waitFor(() => expect(client.broadcastTx).toHaveBeenCalled())
        // From the moment the bytes go out, nothing kept is fresh.
        await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toMatchObject(
          stale
        )
        // A read begun and settled while the explorer has not answered is kept, not fresh.
        await expect(wallet.readQbitAccountTotal(address)).resolves.toMatchObject({
          totalBalance: FIRST_TOTAL,
          fresh: false,
        })
      } finally {
        accept()
        await pushing
      }
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL, fresh: false },
      ])
      // Read just after it: fresh, for 10 s only, while the explorer may lag.
      await expect(wallet.readQbitAccountTotal(address)).resolves.toMatchObject({ fresh: true })
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_SETTLING_FRESH_MS)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { fresh: false },
      ])
      // Read 30 s or more after it: fresh for the full minute.
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_SETTLING_MS)
      await wallet.readQbitAccountTotal(address)
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_FRESH_MS - 1)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([{ fresh: true }])
    })

    it('leaves them not fresh after a submission under a send claim (pushTx)', async () => {
      const wallet = controller()
      await keptBoth(wallet)
      const { rawTxHex, txid } = signedRawTx()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      vi.spyOn(client, 'broadcastTx').mockResolvedValue(txid)
      // The guard's own claim checks are not what this covers: it runs the
      // submission with nothing to check on the explorer.
      vi.spyOn(qbitSendGuardService, 'broadcastIfAllowed').mockImplementation(
        async (_chain, _txid, _outpoints, operation) => operation({} as any)
      )

      await expect(wallet.pushTx(rawTxHex, { txid } as any)).resolves.toBe(txid)

      expect(client.broadcastTx).toHaveBeenCalledTimes(1)
      await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toMatchObject(
        stale
      )
    })

    it('answers the total after it to a read begun after it, never a reply to an earlier request', async () => {
      const wallet = controller()
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      // The switcher's read asks for its totals (`getAddressBalance`); the
      // poll asks for the statistics as they are (`getAddressStats`).
      const totalsCalls = vi.spyOn(client, 'getAddressBalance')
      // The home screen's poll of the account asks for its statistics before
      // the send; the reply, computed then, arrives on release.
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      let arrive: () => void = () => undefined
      const arrived = new Promise<void>(resolve => (arrive = resolve))
      let held = false
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        const response = await explorer.fetch(input, init)
        if (!held && new URL(url).pathname.endsWith(`/address/${address}`)) {
          held = true
          arrive()
          await released
        }
        return response
      })
      const poll = wallet.getAddressBalanceV2(address).catch(() => undefined)
      await arrived

      const { rawTxHex, txid } = signedRawTx()
      vi.spyOn(client, 'broadcastTx').mockImplementation(async () => {
        // The transaction pays the account, and the explorer shows it at once.
        explorer.addTx({
          txid: fakeTxid(9, 9_000_000),
          inputs: [{ txid: fakeTxid(9, 9_100_000), vout: 0 }],
          outputs: [{ address, script: first.script, value: 5_000 }],
        })
        return txid
      })
      await expect(wallet.broadcastQbitProviderTx(rawTxHex)).resolves.toMatchObject({
        success: true,
      })

      const reading = wallet.readQbitAccountTotal(address)
      await vi.waitFor(() => expect(totalsCalls).toHaveBeenCalledTimes(1))
      try {
        await expect(reading).resolves.toMatchObject({
          totalBalance: FIRST_TOTAL + 5_000,
          fresh: true,
        })
      } finally {
        release()
        await poll
      }
      // Two requests: the read did not join the poll's. The poll began
      // before the send: its total replaces nothing.
      expect(statisticsReads()).toBe(2)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL + 5_000 },
      ])
    })

    it('leaves them fresh when refused before anything was sent', async () => {
      const wallet = controller()
      await keptBoth(wallet)

      await expect(wallet.broadcastQbitProviderTx('not a transaction')).resolves.toMatchObject({
        success: false,
        outcome: 'not_sent',
      })

      await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toMatchObject([
        { fresh: true },
        { fresh: true },
      ])
    })
  })

  describe('reads waiting or in flight at a clear', () => {
    it('sends nothing more once the wallet locks, and holds up no read made after it', async () => {
      const many = ['55', '66', '77', '88', '99', 'aa', 'bb', 'cc'].map(accountOf)
      for (const { account, script } of many) explorer.registerAddress(account.address, script)
      shown.list = [shownWallet(0, many)]
      const wallet = controller()
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      const asked: string[] = []
      stubFetch(url => {
        if (!/\/address\/[^/]+$/.test(new URL(url).pathname)) return undefined
        asked.push(new URL(url).pathname)
        return released
      })
      const reads = many.map(({ account }) => wallet.readQbitAccountTotal(account.address))
      await vi.waitFor(() => expect(asked).toHaveLength(QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT))

      try {
        await wallet.lockWallet()
        ;(keyringService as any).unlockForTest()
        // Every caller hears no total, with no explorer answer yet.
        for (const [index, answer] of (await Promise.all(reads)).entries()) {
          expect(answer).toEqual(noTotal(many[index]!.account.address))
        }
        expect(asked).toHaveLength(QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT)

        // A read made after it goes out at once, though no request from
        // before the lock has answered.
        const after = wallet.readQbitAccountTotal(many[7]!.account.address)
        await vi.waitFor(() =>
          expect(asked).toHaveLength(QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT + 1)
        )
        expect(asked.at(-1)).toMatch(new RegExp(`${many[7]!.account.address}$`))
        release()
        await expect(after).resolves.toMatchObject({ totalBalance: 0, fresh: true })
      } finally {
        release()
      }
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(asked).toHaveLength(QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT + 1)
    })
  })

  describe('own accounts', () => {
    it('serves no kept total of an address that is no account of a listed wallet', async () => {
      const wallet = controller()
      // The balance read takes any address, and feeds what it read.
      await wallet.getAddressBalanceV2(strangerAddress)
      await expect(wallet.getQbitAccountTotals([strangerAddress, address])).resolves.toEqual([
        noTotal(strangerAddress),
        noTotal(address),
      ])
      await expect(wallet.readQbitAccountTotal(strangerAddress)).resolves.toEqual(
        noTotal(strangerAddress)
      )
    })

    it('reads nothing when the network changes while the wallets are read', async () => {
      // The account shows the same address on both networks, so only the
      // network check stops the read, not the list read after the change.
      shown.list = [
        {
          ...shownWallet(0, [first]),
          accounts: [
            {
              pubkey: first.account.pubkey,
              keyring: {
                ...first.account.p2mr,
                addresses: { testnet4: address, mainnet: address },
              },
            },
          ],
        },
      ]
      const wallet = controller()
      let release: () => void = () => undefined
      shown.hold = new Promise<void>(resolve => (release = resolve))
      const running = wallet.readQbitAccountTotal(address)
      await vi.waitFor(() => expect(keyringService.getAllDisplayedKeyrings).toHaveBeenCalled())
      // The network changes before any clear reaches the totals.
      ;(preferenceService as any).setChainType(ChainType.QBIT_MAINNET)
      release()

      await expect(running).resolves.toEqual(noTotal(address, ChainType.QBIT_TESTNET4))
      expect(explorer.requests).toHaveLength(0)
    })

    it('derives them once while the wallets and the network stay the same, and anew on the next call after either changes', async () => {
      const wallet = controller()
      const derive = vi.spyOn(wallet as any, 'walletKeyringsOf')
      await wallet.readQbitAccountTotal(address)
      await wallet.readQbitAccountTotal(otherAddress)
      await wallet.getQbitAccountTotals([address, otherAddress])
      expect(derive).toHaveBeenCalledTimes(1)

      // An account added: the very next call reads its total.
      shown.list = [shownWallet(0, [first, stranger]), shownWallet(1, [second])]
      await expect(wallet.readQbitAccountTotal(strangerAddress)).resolves.toMatchObject({
        totalBalance: 1,
        fresh: true,
      })
      expect(derive).toHaveBeenCalledTimes(2)

      // A wallet gone from the list: its account's total is no longer served.
      shown.list = [shownWallet(0, [first, stranger])]
      await expect(wallet.getQbitAccountTotals([otherAddress, strangerAddress])).resolves.toEqual([
        noTotal(otherAddress),
        expect.objectContaining({ totalBalance: 1 }),
      ])
      expect(derive).toHaveBeenCalledTimes(3)

      // Another network, the same list: these accounts have no address on
      // it, so none is read there.
      ;(preferenceService as any).setChainType(ChainType.QBIT_MAINNET)
      expect(await requestsOf(() => wallet.readQbitAccountTotal(address))).toBe(0)
      expect(derive).toHaveBeenCalledTimes(4)
      ;(preferenceService as any).setChainType(ChainType.QBIT_TESTNET4)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL },
      ])
      expect(derive).toHaveBeenCalledTimes(5)
    })
  })

  describe('an internal failure', () => {
    it('answers every entry with no total, logging no address, and rejects for nothing but the argument', async () => {
      const wallet = controller()
      await wallet.readQbitAccountTotal(address)
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
      shown.fail = new Error(`could not show ${address}`)

      await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toEqual([
        noTotal(address),
        noTotal(otherAddress),
      ])
      await expect(wallet.readQbitAccountTotal(address)).resolves.toEqual({
        ...noTotal(address),
        error: true,
      })
      expect(warn).toHaveBeenCalledTimes(2)
      // Nothing logged carries the address, an error's message and stack included.
      const logged = warn.mock.calls
        .flat()
        .map(arg => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)))
        .join(' ')
      expect(logged).not.toContain(address)

      shown.fail = undefined
      vi.spyOn(wallet as any, 'getQbitApiClient').mockImplementation(() => {
        throw new Error('No qbit API endpoint configured')
      })
      await expect(wallet.getQbitAccountTotals([address])).resolves.toEqual([noTotal(address)])
      await expect(wallet.getQbitAccountTotals(null as any)).rejects.toThrow(Error)
      warn.mockRestore()
    })
  })

  describe('a total fed by the balance read', () => {
    it('is dated when that read began, and fresh for 60 s from then', async () => {
      const wallet = controller()
      const began = Date.now()
      const listing = holdNext(`/address/${address}/utxo`)
      const balance = wallet.getAddressBalanceV2(address)
      await listing.arrived
      vi.setSystemTime(began + 15_000)
      listing.release()
      await balance

      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL, readAt: began, fresh: true },
      ])
      vi.setSystemTime(began + QBIT_ACCOUNT_TOTAL_FRESH_MS)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { fresh: false },
      ])
    })
  })

  /**
   * Remove the first account's keyring, the one in slot 1, of `accounts`,
   * remaining: the keyring service lists only that one from then on.
   */
  async function removeFirstKeyring(
    wallet: WalletController,
    accounts: ReturnType<typeof accountOf>[] = [second]
  ): Promise<void> {
    const keyring = {
      type: KeyringType.QbitHdKeyring,
      index: 0,
      key: 'k',
      accounts: [first.account],
    }
    const remaining = {
      type: KeyringType.QbitHdKeyring,
      index: 1,
      key: 'keyring_1',
      accounts: accounts.map(({ account }) => account),
    }
    vi.mocked(keyringService.removeKeyring).mockImplementationOnce(async () => {
      shown.list = [shownWallet(1, accounts)]
    })
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
    expect(keyringService.removeKeyring).toHaveBeenCalled()
  }

  /** Change the network to mainnet and back. */
  async function changeNetworkAndBack(wallet: WalletController): Promise<void> {
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 0,
      type: KeyringType.QbitHdKeyring,
      accounts: [first.account],
    } as any)
    vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
    vi.spyOn(wallet as any, 'kickPendingQbitRestoreFloorScan').mockImplementation(() => undefined)
    await wallet.setChainType(ChainType.QBIT_MAINNET)
    await wallet.setChainType(ChainType.QBIT_TESTNET4)
  }

  describe('forgets every total', () => {
    for (const [event, run] of [
      [
        'the wallet locks',
        async (wallet: WalletController) => {
          await wallet.lockWallet()
        },
      ],
      ['the network changes', changeNetworkAndBack],
      ['a keyring is removed', removeFirstKeyring],
      [
        'the regtest clients are dropped',
        async (wallet: WalletController) => {
          ;(wallet as any).dropRegtestApiClients()
        },
      ],
      [
        'the keyring service locks the wallet on its own, an address type change failing',
        async (wallet: WalletController) => {
          vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
            type: KeyringType.HdKeyring,
            accounts: [],
          } as any)
          vi.mocked(keyringService.changeAddressType).mockImplementationOnce(async () => {
            lockState().isUnlocked = false
            throw new Error('address type not restored')
          })
          await expect(wallet.changeAddressType(AddressType.P2TR)).rejects.toThrow(
            'address type not restored'
          )
        },
      ],
      [
        'the wallet data is reset',
        async (wallet: WalletController) => {
          await wallet.resetAllData()
          clearTimeout(wallet.timer)
        },
      ],
    ] as const) {
      it(`when ${event}, and keeps nothing from a read under way then, nor reads it again`, async () => {
        const wallet = controller()
        await wallet.readQbitAccountTotal(otherAddress)
        const statistics = holdNextStatistics()
        const running = wallet.readQbitAccountTotal(address)
        await statistics.arrived

        await run(wallet)
        ;(keyringService as any).unlockForTest()
        statistics.release()

        await expect(running).resolves.toEqual(noTotal(address))
        expect(statisticsAsked(address)).toBe(1)
        await expect(wallet.getQbitAccountTotals([address, otherAddress])).resolves.toEqual([
          noTotal(address),
          noTotal(otherAddress),
        ])
        expect(await requestsOf(() => wallet.readQbitAccountTotal(otherAddress))).toBe(1)
      })
    }
  })

  describe('a read begun before a broadcast', () => {
    it('answers no call made after the broadcast: that call is answered by a request of its own', async () => {
      const wallet = controller()
      await wallet.readQbitAccountTotal(address)
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_FRESH_MS)
      // The switcher reads the account; the reply, the total as it stands
      // now, is still on its way when the switcher closes.
      const held = holdNextReply(`/address/${address}`)
      const before = wallet.readQbitAccountTotal(address)
      await held.arrived
      expect(statisticsReads()).toBe(2)

      // The user sends a payment to the account, and opens the switcher again.
      await sendPaying(wallet, 5_000)
      const after = wallet.readQbitAccountTotal(address)
      try {
        await vi.waitFor(() => expect(statisticsReads()).toBe(3))
        await expect(after).resolves.toMatchObject({
          totalBalance: FIRST_TOTAL + 5_000,
          fresh: true,
          error: false,
        })
      } finally {
        held.release()
      }
      // The earlier read settles for its own caller; its total, from before
      // the send, replaces nothing.
      await expect(before).resolves.toMatchObject({ totalBalance: FIRST_TOTAL + 5_000 })
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL + 5_000 },
      ])
    })
  })

  describe('a total the balance read feeds just after a broadcast', () => {
    it('is not kept, and the switcher reads it afresh', async () => {
      const wallet = controller()
      await sendPaying(wallet, 5_000)
      // The home screen's refresh, whose statistics request is no fresh read.
      await wallet.getAddressBalanceV2(address)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toEqual([noTotal(address)])
      const before = urls.length
      await expect(wallet.readQbitAccountTotal(address)).resolves.toMatchObject({
        totalBalance: FIRST_TOTAL + 5_000,
        fresh: true,
      })
      const asked = urls.slice(before)
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatch(/\?qbit_fresh=[0-9a-f]{24}$/)

      // Fed 30 s or more after it: fresh.
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_SETTLING_MS)
      await wallet.getAddressBalanceV2(otherAddress)
      await expect(wallet.getQbitAccountTotals([otherAddress])).resolves.toMatchObject([
        { totalBalance: SECOND_TOTAL, fresh: true },
      ])
    })
  })

  describe("the switcher's read and the home poll after a broadcast", () => {
    it("answers the switcher's read with its own total, though a poll begun after it settles first with a cached one", async () => {
      const wallet = controller()
      // What an HTTP cache still holds from before the send.
      const cached = accountsExplorer()
      await sendPaying(wallet, 5_000)

      // The switcher's read is a fresh read: computed when asked, the
      // reply delivered on release.
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      let arrive: () => void = () => undefined
      const arrived = new Promise<void>(resolve => (arrive = resolve))
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        urls.push(url.href)
        if (!url.searchParams.has('qbit_fresh')) return cached.fetch(input, init)
        const response = await explorer.fetch(input, init)
        if (url.pathname.endsWith(`/address/${address}`)) {
          arrive()
          await released
        }
        return response
      })
      const reading = wallet.readQbitAccountTotal(address)
      await arrived
      try {
        // The home poll begins after it and settles first, every request
        // answered from before the send.
        await expect(wallet.getAddressBalanceV2(address)).resolves.toMatchObject({
          totalBalance: FIRST_TOTAL,
        })
      } finally {
        release()
      }
      await expect(reading).resolves.toMatchObject({
        totalBalance: FIRST_TOTAL + 5_000,
        fresh: true,
        error: false,
      })
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL + 5_000, fresh: true },
      ])
    })
  })

  describe('a read begun before a broadcast that fails after it', () => {
    it('makes no call after the broadcast wait 10 s on its failure', async () => {
      const wallet = controller()
      await wallet.readQbitAccountTotal(address)
      vi.setSystemTime(Date.now() + QBIT_ACCOUNT_TOTAL_FRESH_MS)
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      let fail: () => void = () => undefined
      const failed = new Promise<never>((_resolve, reject) => {
        fail = () => reject(new Error('explorer down'))
      })
      failed.catch(() => undefined)
      const asked = vi.spyOn(client, 'getAddressBalance').mockReturnValueOnce(failed)
      // The switcher's read goes out, then the user sends.
      const before = wallet.readQbitAccountTotal(address)
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1))
      await sendPaying(wallet, 5_000)
      fail()
      await expect(before).resolves.toMatchObject({ totalBalance: FIRST_TOTAL, error: true })

      // Reopened at once: read again, and answered with the total after the send.
      expect(await requestsOf(() => wallet.readQbitAccountTotal(address))).toBe(1)
      await expect(wallet.getQbitAccountTotals([address])).resolves.toMatchObject([
        { totalBalance: FIRST_TOTAL + 5_000, fresh: true, error: false },
      ])
    })
  })

  describe('after a removal', () => {
    it('reads the remaining wallets again, those in flight at the removal and those waiting', async () => {
      const remaining = ['55', '66', '77', '88', '99', 'aa'].map(accountOf)
      for (const [index, { account, script }] of remaining.entries()) {
        explorer.registerAddress(account.address, script)
        explorer.addTx({
          txid: fakeTxid(20 + index),
          inputs: [{ txid: fakeTxid(20 + index, 5_000_000), vout: 0 }],
          outputs: [{ address: account.address, script, value: 1_000 * (index + 1) }],
          height: 100,
        })
      }
      shown.list = [shownWallet(0, [first]), shownWallet(1, remaining)]
      const wallet = controller()
      // Every request asked before the removal is held until the end.
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      let holding = true
      stubFetch(url =>
        holding && /\/address\/[^/]+$/.test(new URL(url).pathname) ? released : undefined
      )
      const accounts = [first, ...remaining]
      const reads = accounts.map(({ account }) => wallet.readQbitAccountTotal(account.address))
      try {
        await vi.waitFor(() =>
          expect(urls.filter(url => /\/address\/[^/?]+\?/.test(url))).toHaveLength(
            QBIT_ACCOUNT_TOTALS_MAX_READS_IN_FLIGHT
          )
        )
        holding = false

        // The sheet stays open after Remove Wallet.
        await removeFirstKeyring(wallet, remaining)

        const answers = await Promise.all(reads)
        expect(answers[0]).toEqual(noTotal(address))
        for (const [index, { account }] of remaining.entries()) {
          expect(answers[index + 1]).toMatchObject({
            address: account.address,
            totalBalance: 1_000 * (index + 1),
            fresh: true,
            error: false,
          })
          // Read once more, at most: the request from before the removal and one after.
          expect(statisticsAsked(account.address)).toBeLessThanOrEqual(2)
        }
        // The removed wallet's account is read no more.
        expect(statisticsAsked(address)).toBe(1)
      } finally {
        release()
      }
    })

    it('reads again too after the regtest access is turned off on another network', async () => {
      const wallet = controller()
      vi.spyOn(regtestAccessService, 'clearAcknowledgement').mockResolvedValue(undefined)
      vi.spyOn(regtestAccessService, 'refresh').mockResolvedValue({} as any)
      const statistics = holdNextStatistics(otherAddress)
      const running = wallet.readQbitAccountTotal(otherAddress)
      await statistics.arrived

      await wallet.disableRegtestAccess()
      expect(regtestAccessService.clearAcknowledgement).toHaveBeenCalled()
      try {
        await expect(running).resolves.toMatchObject({ totalBalance: SECOND_TOTAL, fresh: true })
        expect(statisticsAsked(otherAddress)).toBe(2)
      } finally {
        statistics.release()
      }
    })

    it('reads once more at most, even when another removal overtakes that read too', async () => {
      const wallet = controller()
      const statistics = holdNextStatistics(otherAddress)
      const running = wallet.readQbitAccountTotal(otherAddress)
      await statistics.arrived
      const again = holdNextStatistics(otherAddress)
      ;(wallet as any).forgetQbitAccountTotals('may-read-again')
      await again.arrived
      ;(wallet as any).forgetQbitAccountTotals('may-read-again')
      statistics.release()
      again.release()
      await expect(running).resolves.toEqual(noTotal(otherAddress))
      expect(statisticsAsked(otherAddress)).toBe(2)
    })

    it('answers no total and reads nothing more after any other clear, though the wallet reads unlocked on the same network', async () => {
      const wallet = controller()
      const statistics = holdNextStatistics()
      const running = wallet.readQbitAccountTotal(address)
      await statistics.arrived
      ;(wallet as any).forgetQbitAccountTotals()
      statistics.release()
      await expect(running).resolves.toEqual(noTotal(address))
      expect(statisticsAsked()).toBe(1)
    })

    it('answers no total and reads nothing more after a network change, even once the network is back', async () => {
      const wallet = controller()
      const statistics = holdNextStatistics()
      const running = wallet.readQbitAccountTotal(address)
      await statistics.arrived
      // Were the call to read again, its list read would wait until the
      // network is back to the one it began on.
      let release: () => void = () => undefined
      shown.hold = new Promise<void>(resolve => (release = resolve))
      try {
        await changeNetworkAndBack(wallet)
      } finally {
        release()
        statistics.release()
      }
      await expect(running).resolves.toEqual(noTotal(address))
      expect(statisticsAsked()).toBe(1)
    })

    it('answers no total and reads nothing more during a reset, while the keys are still there', async () => {
      const wallet = controller()
      let erase: () => void = () => undefined
      const erasing = new Promise<void>(resolve => (erase = resolve))
      vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
        await erasing
        lockState().isUnlocked = false
      })
      const statistics = holdNextStatistics()
      const running = wallet.readQbitAccountTotal(address)
      await statistics.arrived
      const resetting = wallet.resetAllData()
      try {
        await vi.waitFor(() => expect(keyringService.resetAllData).toHaveBeenCalled())
        expect(lockState().isUnlocked).toBe(true)
        await expect(running).resolves.toEqual(noTotal(address))
        expect(statisticsAsked()).toBe(1)
      } finally {
        erase()
        statistics.release()
        await resetting
        clearTimeout(wallet.timer)
      }
    })
  })

  describe('what the own-address check keeps', () => {
    it('is forgotten when the wallet locks and when its data is reset', async () => {
      const wallet = controller()
      await wallet.readQbitAccountTotal(address)
      expect((wallet as any).qbitOwnAddressesDerived?.displayed).toBe(shown.list)

      await wallet.lockWallet()
      expect((wallet as any).qbitOwnAddressesDerived).toBeUndefined()
      ;(keyringService as any).unlockForTest()
      await wallet.readQbitAccountTotal(address)
      expect((wallet as any).qbitOwnAddressesDerived).toBeDefined()
      await wallet.resetAllData()
      clearTimeout(wallet.timer)
      expect((wallet as any).qbitOwnAddressesDerived).toBeUndefined()
    })

    it('keeps nothing derived from a list read before it was forgotten', async () => {
      const wallet = controller()
      let release: () => void = () => undefined
      shown.hold = new Promise<void>(resolve => (release = resolve))
      const running = wallet.readQbitAccountTotal(address)
      await vi.waitFor(() => expect(keyringService.getAllDisplayedKeyrings).toHaveBeenCalled())
      ;(wallet as any).dropRegtestApiClients()
      release()
      await expect(running).resolves.toEqual(noTotal(address))
      expect((wallet as any).qbitOwnAddressesDerived).toBeUndefined()
      expect(explorer.requests).toHaveLength(0)
    })
  })

  describe('the wallets read for the own-address check', () => {
    it('are built once for every call that comes while a list the service must build again is built', async () => {
      const wallet = controller()
      const derive = vi.spyOn(wallet as any, 'walletKeyringsOf')
      shown.cold = true
      let release: () => void = () => undefined
      shown.hold = new Promise<void>(resolve => (release = resolve))
      const reads = [address, otherAddress, address, otherAddress].map(of =>
        wallet.readQbitAccountTotal(of)
      )
      const kept = [1, 2, 3, 4].map(() => wallet.getQbitAccountTotals([address, otherAddress]))
      await vi.waitFor(() => expect(keyringService.getAllDisplayedKeyrings).toHaveBeenCalled())
      release()

      for (const [index, answer] of (await Promise.all(reads)).entries()) {
        expect(answer).toMatchObject({ totalBalance: index % 2 ? SECOND_TOTAL : FIRST_TOTAL })
      }
      await Promise.all(kept)
      expect(shown.builds).toBe(1)
      expect(derive).toHaveBeenCalledTimes(1)
    })

    it('are never a list read before the call began, though one is under way', async () => {
      const wallet = controller()
      let release: () => void = () => undefined
      shown.hold = new Promise<void>(resolve => (release = resolve))
      const earlier = wallet.readQbitAccountTotal(address)
      await vi.waitFor(() =>
        expect(keyringService.getAllDisplayedKeyrings).toHaveBeenCalledTimes(1)
      )
      // An account is added while that read is under way, then a call made.
      shown.list = [shownWallet(0, [first, stranger]), shownWallet(1, [second])]
      const later = wallet.readQbitAccountTotal(strangerAddress)
      release()

      await expect(later).resolves.toMatchObject({ totalBalance: 1, fresh: true })
      await expect(earlier).resolves.toMatchObject({ totalBalance: FIRST_TOTAL })
      expect(keyringService.getAllDisplayedKeyrings).toHaveBeenCalledTimes(2)
    })
  })

  describe('an address of no Qbit network', () => {
    it("is never read nor served, as a developer-mode read-only wallet's Bitcoin-style address", async () => {
      // The generator point: a valid compressed public key.
      const pubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
      shown.list = [
        shownWallet(0, [first]),
        {
          type: KeyringType.ReadonlyKeyring,
          index: 1,
          addressType: AddressType.P2WPKH,
          keyring: {},
          accounts: [{ pubkey }],
        },
      ]
      const wallet = controller()
      const totals = (wallet as any).qbitAccountTotals
      for (const [chainType, prefix] of [
        [ChainType.QBIT_TESTNET4, /^tb1q/],
        [ChainType.QBIT_MAINNET, /^bc1q/],
      ] as const) {
        ;(preferenceService as any).setChainType(chainType)
        const keyrings = await wallet.getKeyrings()
        const readonlyAddress = (keyrings.find(keyring => keyring.index === 1) as any).accounts[0]
          .address as string
        expect(readonlyAddress).toMatch(prefix)

        expect(await requestsOf(() => wallet.readQbitAccountTotal(readonlyAddress))).toBe(0)
        await expect(wallet.readQbitAccountTotal(readonlyAddress)).resolves.toEqual(
          noTotal(readonlyAddress, chainType)
        )
        // Not served either, whatever is kept for it.
        totals.measured(
          (wallet as any).getQbitApiClient(chainType),
          readonlyAddress,
          7,
          totals.begin()
        )
        await expect(wallet.getQbitAccountTotals([readonlyAddress])).resolves.toEqual([
          noTotal(readonlyAddress, chainType),
        ])
      }
      expect(explorer.requests).toHaveLength(0)
    })
  })
})
