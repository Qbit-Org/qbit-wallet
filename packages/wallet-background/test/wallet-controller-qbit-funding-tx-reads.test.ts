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
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import {
  QBIT_CLASSIFY_MAX_READS_IN_FLIGHT,
  QbitFundingTxReads,
} from '../src/utils/qbit-funding-tx-reads'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The real classification reads every output through the real client; a
// test may stand in for the balance read itself to reach a branch of the
// controller no explorer answer leads to.
const apiOverrides = vi.hoisted(() => ({
  balance: undefined as undefined | ((...args: any[]) => Promise<unknown>),
  calls: [] as { name: string; args: unknown[] }[],
}))
vi.mock('../src/utils/qbit-api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/qbit-api')>()
  const recorded =
    <A extends unknown[], R>(name: string, call: (...args: A) => R) =>
    (...args: A): R => {
      apiOverrides.calls.push({ name, args })
      return call(...args)
    }
  return {
    ...actual,
    getQbitSpendableBalanceV2: recorded('getQbitSpendableBalanceV2', (...args: any[]) =>
      (apiOverrides.balance ?? (actual.getQbitSpendableBalanceV2 as any))(...args)
    ),
    readQbitAddressUtxos: recorded('readQbitAddressUtxos', actual.readQbitAddressUtxos),
    readQbitAddressUtxosRidingOut: recorded(
      'readQbitAddressUtxosRidingOut',
      actual.readQbitAddressUtxosRidingOut
    ),
    getQbitAddressUtxos: recorded('getQbitAddressUtxos', actual.getQbitAddressUtxos),
    getQbitAddressUtxosClassifiedPastLimit: recorded(
      'getQbitAddressUtxosClassifiedPastLimit',
      actual.getQbitAddressUtxosClassifiedPastLimit
    ),
    checkQbitSpendInputs: recorded('checkQbitSpendInputs', actual.checkQbitSpendInputs),
  }
})

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

/** Under the explorer's 500-output listing limit, so each is classified by a read of its own. */
const OUTPUTS = 300
const OUTPUT_VALUE = 10_000
const TOTAL = OUTPUTS * OUTPUT_VALUE

const fullSplit = (chainType = ChainType.QBIT_TESTNET4) => ({
  availableBalance: TOTAL,
  unavailableBalance: 0,
  totalBalance: TOTAL,
  immatureBalance: 0,
  pendingBalance: 0,
  chainType,
})

/**
 * An explorer of the account paid `OUTPUTS` times, each payment its own
 * transaction: 527 to 601 blocks deep, younger than a coinbase must be to
 * mature, so the balance reads each one's transaction and keeps its facts,
 * or, when `deep`, 1,826 to 1,901 blocks deep, so only a read of outputs a
 * send may spend reads them.
 */
function accountExplorer({ deep = false } = {}): FakeQbitExplorer {
  const target = new FakeQbitExplorer('mempool-qbit')
  target.registerAddress(address, accountScript)
  for (let index = 0; index < OUTPUTS; index += 1) {
    target.addTx({
      txid: fakeTxid(index),
      inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
      height: (deep ? 100 : target.tipHeight - 600) + Math.floor(index / 4),
    })
  }
  return target
}

/**
 * A payment to the account at the tip of `target`, its newest: by its block
 * the listing alone shows the `deep` ones deep. Being young, it is read by
 * the balance once, and afresh by every read of outputs a send may spend.
 */
function payNewest(target: FakeQbitExplorer): string {
  const txid = fakeTxid(1, 9_800_000)
  target.addTx({
    txid,
    inputs: [{ txid: fakeTxid(2, 9_800_000), vout: 0 }],
    outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
    height: target.tipHeight,
  })
  return txid
}

describe("WalletController's shared reads of funding transactions (#169)", () => {
  let explorer: FakeQbitExplorer

  function controller() {
    vi.stubGlobal('fetch', explorer.fetch)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    return wallet
  }

  const txReads = () =>
    explorer.requests.filter(request => /^\/tx\/[0-9a-f]{64}$/.test(request.path)).length

  /** The inputs every check of a transaction's inputs has checked (`checkQbitSpendInputs`). */
  const checkedInputs = () =>
    apiOverrides.calls
      .filter(call => call.name === 'checkQbitSpendInputs')
      .reduce((total, call) => total + (call.args[2] as unknown[]).length, 0)

  /** The /tx reads `run` makes. */
  async function txReadsOf(run: () => Promise<unknown>): Promise<number> {
    const before = txReads()
    await run()
    return txReads() - before
  }

  const fundingTxReadsOf = (wallet: WalletController): QbitFundingTxReads =>
    (wallet as any).qbitFundingTxReads

  beforeEach(async () => {
    vi.clearAllMocks()
    apiOverrides.balance = undefined
    apiOverrides.calls.length = 0
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
    explorer = accountExplorer()
    ;(preferenceService as any).setChainType(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    await qbitSendGuardService.resetAllData()
    ;(keyringService as any).unlockForTest()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await qbitSendGuardService.resetAllData()
  })

  it('reads an unchanged account once, for the balance and the send screen alike', async () => {
    // Each output a coinbase maturity deep but the newest payment: the
    // balance needs no read of any of them.
    explorer = accountExplorer({ deep: true })
    payNewest(explorer)
    const wallet = controller()

    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(1)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual({
      ...fullSplit(),
      availableBalance: TOTAL + OUTPUT_VALUE,
      totalBalance: TOTAL + OUTPUT_VALUE,
    })
    // The send screen's read goes through the same reader: it lists the deep
    // ones from the listing alone, as candidates a signing checks (#210);
    // the newest, young, every read of outputs reads afresh.
    let snapshot: Awaited<ReturnType<typeof wallet.getQbitUtxoSnapshot>> | undefined
    expect(
      await txReadsOf(async () => {
        snapshot = await wallet.getQbitUtxoSnapshot()
      })
    ).toBe(1)
    expect(snapshot!.utxos).toHaveLength(OUTPUTS + 1)
    expect(await txReadsOf(() => wallet.getQbitUtxos())).toBe(1)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)
  })

  it('lists the deep outputs on a cold reader for the send without a lookup, and reads every one for getAddressUtxo and recovery', async () => {
    // The send path lists the deep ones as candidates (#210): each input a
    // transaction spends is read and checked before its first signature
    // (wallet-controller-qbit-spend-check.test.ts). getAddressUtxo, which
    // nothing calls, and the recovery sources read every one, as before.
    for (const [read, reads] of [
      [(wallet: WalletController) => wallet.getQbitUtxos(), 1],
      [(wallet: WalletController) => wallet.getAddressUtxo(address), OUTPUTS + 1],
      [
        (wallet: WalletController) =>
          (wallet as any).readQbitRecoverySourceUtxos(
            (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4),
            address,
            { deferIncompleteHistory: false }
          ),
        OUTPUTS + 1,
      ],
    ] as const) {
      explorer = accountExplorer({ deep: true })
      payNewest(explorer)
      const wallet = controller()
      // The balance before it read none of them, only the newest payment.
      expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(1)
      expect(await txReadsOf(() => read(wallet))).toBe(reads)
    }
  })

  it("passes its one shared reader on the balance, send, output and recovery reads, and rides out server errors on the send screen's alone", async () => {
    explorer = accountExplorer({ deep: true })
    const wallet = controller()
    const shared = fundingTxReadsOf(wallet)
    expect(shared).toBeInstanceOf(QbitFundingTxReads)
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
    // Three payments of ten blocks ago, besides the 300 old ones.
    const young = [0, 1, 2].map(index => fakeTxid(index, 9_000_000))
    for (const txid of young) {
      explorer.addTx({
        txid,
        inputs: [{ txid: fakeTxid(1, 9_500_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
        height: explorer.tipHeight - 9,
      })
    }
    const youngReads = () =>
      explorer.requests.filter(({ path }) => young.some(txid => path === `/tx/${txid}`)).length

    // The balance reads the young ones once, then polls without a read: the
    // 300 old ones are a coinbase maturity deep, which it needs no read for.
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(3)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)
    // Every read of outputs a send may spend reads the young ones afresh,
    // and only them, once the first has read the old ones. Only a snapshot
    // read that asks, with the boolean true and an id it can be abandoned
    // by, rides out the explorer's server errors: the send screen's own read.
    const ridesOut = () =>
      apiOverrides.calls.filter(call => call.name === 'readQbitAddressUtxosRidingOut').length
    // The calls a snapshot read made: they alone go through a shared walk.
    const snapshotCalls = new Set<unknown>()
    for (const [index, [read, ridden, snapshot]] of (
      [
        [() => wallet.getQbitUtxos(), false, false],
        [() => wallet.getAddressUtxo(address), false, false],
        [
          () =>
            (wallet as any).readQbitRecoverySourceUtxos(client, address, {
              deferIncompleteHistory: false,
            }),
          false,
          false,
        ],
        // The send screen's prepare and its send in one transaction: an id, no ask.
        [() => wallet.getQbitUtxoSnapshot('1'), false, true],
        // The send screen's own read as it opens.
        [() => wallet.getQbitUtxoSnapshot('2', true), true, true],
        // An ask with no read to abandon it by, and asks that are not true.
        [() => wallet.getQbitUtxoSnapshot(undefined, true), false, true],
        [() => wallet.getQbitUtxoSnapshot('3', 'true' as any), false, true],
        [() => wallet.getQbitUtxoSnapshot('4', 1 as any), false, true],
      ] as const
    ).entries()) {
      const before = youngReads()
      const riddenBefore = ridesOut()
      const firstCall = apiOverrides.calls.length
      // The send path lists the old ones as candidates (#210): the first read
      // that reads them is getAddressUtxo's.
      expect(await txReadsOf(read)).toBe(index === 1 ? OUTPUTS + 3 : 3)
      expect(youngReads() - before).toBe(3)
      expect(ridesOut() - riddenBefore).toBe(ridden ? 1 : 0)
      if (snapshot) apiOverrides.calls.slice(firstCall).forEach(call => snapshotCalls.add(call))
    }
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)

    const callsNamed = (name: string) => apiOverrides.calls.filter(call => call.name === name)
    const optionsOf = (name: string) =>
      callsNamed(name).map(call => call.args.at(-1) as { fundingTxReads?: unknown })
    expect(optionsOf('getQbitSpendableBalanceV2')).toEqual(
      Array(3).fill({
        fundingTxReads: shared,
        reuse: expect.objectContaining({
          reusable: expect.any(Function),
          stillReusable: expect.any(Function),
          keep: expect.any(Function),
        }),
      })
    )
    for (const name of [
      'readQbitAddressUtxos',
      'readQbitAddressUtxosRidingOut',
      'getQbitAddressUtxos',
      'getQbitAddressUtxosClassifiedPastLimit',
    ]) {
      expect(callsNamed(name).length).toBeGreaterThan(0)
      // The shared reader, and nothing that would loosen the rule: at most
      // the place its caller took among the reader's clears, a view of that
      // same reader, which sets nothing else, and for a snapshot read alone,
      // which goes through a shared walk, the signal that walk is stopped by.
      for (const call of callsNamed(name)) {
        const { facts, signal, ...options } = call.args.at(-1) as {
          facts?: unknown
          signal?: unknown
        }
        expect(options).toEqual({ fundingTxReads: shared })
        if (facts !== undefined) expect(() => shared.begin({}, facts as any)).not.toThrow()
        if (signal !== undefined) {
          expect(snapshotCalls.has(call), `${name} with a signal`).toBe(true)
          expect(signal).toBeInstanceOf(AbortSignal)
        }
      }
    }
  })

  describe("the send screen's read and one that does not ask to ride out, sharing one walk", () => {
    const listing = `/address/${address}/utxo`
    const victim = `/tx/${fakeTxid(150)}`
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const callsOf = (name: string) => apiOverrides.calls.filter(call => call.name === name).length

    /** The first `times` reads of one lookup are answered 502, which the client tries three times. */
    function failVictim(times: number): void {
      let failed = 0
      explorer.failures.push(({ path }) =>
        path === victim && failed++ < times ? { status: 502 } : undefined
      )
    }

    /** Start `first`, and `second` once the first is listing the outputs: it joins that read. */
    async function joined<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
      const one = first()
      one.catch(() => undefined)
      while (!explorer.requests.some(({ path }) => path === listing)) await sleep(1)
      return [one, second()] as const
    }

    it('gives up on a 502 as fast as the client alone for a read with an id that does not ask', async () => {
      const wallet = controller()
      failVictim(Number.POSITIVE_INFINITY)
      const started = performance.now()

      await expect(wallet.getQbitUtxoSnapshot('prepare')).rejects.toMatchObject({ status: 502 })

      // The client's three attempts, 300 ms and 600 ms apart, and no more.
      expect(explorer.requests.filter(({ path }) => path === victim)).toHaveLength(3)
      expect(performance.now() - started).toBeLessThan(5_000)
      expect(callsOf('readQbitAddressUtxos')).toBe(1)
      expect(callsOf('readQbitAddressUtxosRidingOut')).toBe(0)
    })

    it("gives a read that does not ask, joining the send screen's, the outputs it rode out", async () => {
      const wallet = controller()
      failVictim(3)

      const [screen, prepare] = await joined(
        () => wallet.getQbitUtxoSnapshot('send-screen', true),
        () => wallet.getQbitUtxoSnapshot('prepare')
      )

      await expect(screen).resolves.toMatchObject({ utxos: expect.any(Array) })
      expect((await screen).utxos).toHaveLength(OUTPUTS)
      expect((await prepare).utxos).toHaveLength(OUTPUTS)
      // One read, the send screen's: the client's three attempts, then the
      // ride-out's fourth.
      expect(callsOf('readQbitAddressUtxosRidingOut')).toBe(1)
      expect(callsOf('readQbitAddressUtxos')).toBe(0)
      expect(explorer.requests.filter(({ path }) => path === victim)).toHaveLength(4)
    })

    it("reads the send screen's outputs once when its own ride-out gives up, and not again", async () => {
      // Every timer on the fake clock, not only the date.
      vi.useRealTimers()
      vi.useFakeTimers()
      const wallet = controller()
      failVictim(Number.POSITIVE_INFINITY)

      let failure: unknown
      wallet.getQbitUtxoSnapshot('send-screen', true).catch((error: unknown) => {
        failure = error
      })
      for (let spent = 0; failure === undefined && spent < 120_000; spent += 100) {
        await vi.advanceTimersByTimeAsync(100)
      }

      expect(failure).toMatchObject({ status: 502 })
      // Five attempts within its 20 s, each the client's three: one read.
      expect(explorer.requests.filter(({ path }) => path === victim)).toHaveLength(15)
      expect(callsOf('readQbitAddressUtxosRidingOut')).toBe(1)
      expect(callsOf('readQbitAddressUtxos')).toBe(0)
    })

    it("rides out the send screen's read when the address statistics cannot be read, and so nothing is shared", async () => {
      const wallet = controller()
      // The statistics fail: the read is the screen's own, as before any sharing.
      let statsFailed = 0
      explorer.failures.push(({ path }) =>
        path === `/address/${address}` && statsFailed++ < 3 ? { status: 500 } : undefined
      )
      failVictim(3)

      const snapshot = await wallet.getQbitUtxoSnapshot('send-screen', true)

      expect(snapshot.utxos).toHaveLength(OUTPUTS)
      expect(statsFailed).toBeGreaterThanOrEqual(3)
      expect(callsOf('readQbitAddressUtxosRidingOut')).toBe(1)
      expect(callsOf('readQbitAddressUtxos')).toBe(0)
      expect(explorer.requests.filter(({ path }) => path === victim)).toHaveLength(4)
    })

    it('reads again on its own, riding it out, for the send screen when the read that did not ask it joined fails on a 502', async () => {
      const wallet = controller()
      failVictim(3)

      const [prepare, screen] = await joined(
        () => wallet.getQbitUtxoSnapshot('prepare'),
        () => wallet.getQbitUtxoSnapshot('send-screen', true)
      )

      // The read that did not ask fails as 1.0.9 did, after the client's attempts.
      await expect(prepare).rejects.toMatchObject({ status: 502 })
      expect((await screen).utxos).toHaveLength(OUTPUTS)
      expect(callsOf('readQbitAddressUtxos')).toBe(1)
      expect(callsOf('readQbitAddressUtxosRidingOut')).toBe(1)
      expect(explorer.requests.filter(({ path }) => path === victim)).toHaveLength(4)
    })

    it('takes as its answer a failure a ride-out meets the same way, a bare 500 on the listing, without reading again', async () => {
      const wallet = controller()
      // Fewer outputs than a refusal of the listing would mean: an ordinary failure.
      explorer.failures.push(({ path }) => (path === listing ? { status: 500 } : undefined))

      const [prepare, screen] = await joined(
        () => wallet.getQbitUtxoSnapshot('prepare'),
        () => wallet.getQbitUtxoSnapshot('send-screen', true)
      )

      await expect(prepare).rejects.toMatchObject({ status: 500 })
      await expect(screen).rejects.toMatchObject({ status: 500 })
      // One read, the one it joined: the client's three attempts at the listing.
      expect(explorer.requests.filter(({ path }) => path === listing)).toHaveLength(3)
      expect(callsOf('readQbitAddressUtxos')).toBe(1)
      expect(callsOf('readQbitAddressUtxosRidingOut')).toBe(0)
    })
  })

  it('keeps its reads to one explorer within the bound in flight, a balance and a send read together', async () => {
    const wallet = controller()
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const tx = /\/tx\/[0-9a-f]{64}$/.test(String(input))
      if (tx) peak = Math.max(peak, ++inFlight)
      try {
        await new Promise(resolve => setTimeout(resolve, 1))
        return await explorer.fetch(input, init)
      } finally {
        if (tx) inFlight -= 1
      }
    })

    const [balance, snapshot] = await Promise.all([
      wallet.getAddressBalanceV2(address),
      wallet.getQbitUtxoSnapshot(),
    ])

    expect(balance).toEqual(fullSplit())
    expect(snapshot.utxos).toHaveLength(OUTPUTS)
    expect(peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(peak).toBeGreaterThan(1)
    // Each reads each transaction once: a send reads afresh a payment younger
    // than a coinbase must be to mature, so the two cannot share these.
    expect(txReads()).toBeLessThanOrEqual(2 * OUTPUTS)
  })

  it('forgets what it read when the wallet locks, and keeps nothing read while locked', async () => {
    const wallet = controller()
    await wallet.getAddressBalanceV2(address)

    await wallet.lockWallet()

    expect(fundingTxReadsOf(wallet).size).toBe(0)
    // Read while locked: nothing is served, nothing kept.
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
    expect(fundingTxReadsOf(wallet).size).toBe(0)
    ;(keyringService as any).unlockForTest()
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)
  })

  it('keeps nothing from a read still running when the wallet locks', async () => {
    const wallet = controller()
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let held = false
    let txHeld: () => void = () => undefined
    const txArrived = new Promise<void>(resolve => (txHeld = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && /\/tx\/[0-9a-f]{64}$/.test(String(input))) {
        held = true
        txHeld()
        await released
      }
      return explorer.fetch(input, init)
    })
    const running = wallet.getAddressBalanceV2(address)
    await txArrived

    await wallet.lockWallet()
    ;(keyringService as any).unlockForTest()
    release()
    await running

    expect(fundingTxReadsOf(wallet).size).toBe(0)
  })

  it('forgets what it read when the wallet data is reset', async () => {
    const wallet = controller()
    await wallet.getAddressBalanceV2(address)

    await wallet.resetAllData()
    clearTimeout(wallet.timer)

    expect(fundingTxReadsOf(wallet).size).toBe(0)
    ;(keyringService as any).unlockForTest()
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
  })

  it('forgets what it read when the keyring service locks the wallet on its own', async () => {
    const wallet = controller()
    await wallet.getAddressBalanceV2(address)
    const lockState = (keyringService as any).memStore.getState()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      type: KeyringType.HdKeyring,
      accounts: [],
    } as any)
    vi.mocked(keyringService.changeAddressType).mockImplementationOnce(async () => {
      lockState.isUnlocked = false
      throw new Error('address type not restored')
    })

    await expect(wallet.changeAddressType(AddressType.P2TR)).rejects.toThrow(
      'address type not restored'
    )

    expect(keyringService.setLocked).not.toHaveBeenCalled()
    expect(fundingTxReadsOf(wallet).size).toBe(0)
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
    expect(keyringService.removeKeyring).toHaveBeenCalled()
  }

  /** Hold the account's next listing, once asked for (`arrived`), until `release`. */
  function holdNextListing() {
    return holdNext(url => url.endsWith(`/address/${address}/utxo`))
  }

  /** Hold the next request `holds` matches, once asked for (`arrived`), until `release`. */
  function holdNext(holds: (url: string) => boolean) {
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const arrived = new Promise<void>(resolve => (arrive = resolve))
    let held = false
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && holds(String(input))) {
        held = true
        arrive()
        await released
      }
      return explorer.fetch(input, init)
    })
    return { arrived, release }
  }

  /** Lock the wallet and unlock it again. */
  async function lockAndUnlock(wallet: WalletController): Promise<void> {
    await wallet.lockWallet()
    ;(keyringService as any).unlockForTest()
  }

  for (const [clear, during] of [
    ['a keyring is removed', removeAccountKeyring],
    ['the wallet locks and unlocks', lockAndUnlock],
  ] as const) {
    it(`keeps nothing from the send screen's read when ${clear} during its statistics read`, async () => {
      const wallet = controller()
      const statistics = holdNext(url => url.endsWith(`/address/${address}`))
      const running = wallet.getQbitUtxoSnapshot()
      await statistics.arrived

      await during(wallet)
      statistics.release()

      await expect(running).resolves.toMatchObject({ utxos: expect.any(Array) })
      expect((await running).utxos).toHaveLength(OUTPUTS)
      expect(fundingTxReadsOf(wallet).size).toBe(0)
    })
  }

  for (const [send, build] of [
    [
      'a send',
      (wallet: WalletController) => wallet.createSendQbitPsbt({ to: address, amount: 20_000 }),
    ],
    [
      'a send of everything',
      // Over the UI port an omitted rate arrives as no key at all.
      (wallet: WalletController) => wallet.createSendAllQbitPsbt({ to: address } as any),
    ],
  ] as const) {
    it(`keeps nothing from ${send} built while a keyring is removed during its fee quote`, async () => {
      const wallet = controller()
      const quote = holdNext(url => url.includes('/fees'))
      const running = build(wallet)
      running.catch(() => undefined)
      await quote.arrived

      await removeAccountKeyring(wallet)
      quote.release()

      // Whether the send is then built or refused, its read of the outputs,
      // and the check of the inputs it spends, which reads each one again
      // (#210), came after the removal and kept nothing.
      await running.catch(() => undefined)
      expect(txReads()).toBe(OUTPUTS + checkedInputs())
      expect(fundingTxReadsOf(wallet).size).toBe(0)
    })
  }

  it('forgets what it read when a keyring is removed', async () => {
    const wallet = controller()
    await wallet.getAddressBalanceV2(address)
    expect(fundingTxReadsOf(wallet).size).toBe(OUTPUTS)

    await removeAccountKeyring(wallet)

    expect(fundingTxReadsOf(wallet).size).toBe(0)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
  })

  it('keeps nothing from a balance read whose listing was in flight when a keyring was removed', async () => {
    const wallet = controller()
    const listing = holdNextListing()
    const running = wallet.getAddressBalanceV2(address)
    await listing.arrived

    await removeAccountKeyring(wallet)
    listing.release()

    await expect(running).resolves.toEqual(fullSplit())
    expect(fundingTxReadsOf(wallet).size).toBe(0)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
  })

  it('keeps nothing from a balance read whose listing spans a lock and an unlock', async () => {
    const wallet = controller()
    const listing = holdNextListing()
    const running = wallet.getAddressBalanceV2(address)
    await listing.arrived

    await wallet.lockWallet()
    ;(keyringService as any).unlockForTest()
    listing.release()

    await expect(running).resolves.toEqual(fullSplit())
    expect(fundingTxReadsOf(wallet).size).toBe(0)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
  })

  it('forgets what it read when the network changes, and not on a switch to the same one', async () => {
    const wallet = controller()
    const keyring = { index: 0, type: KeyringType.QbitHdKeyring, accounts: [account] }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(keyring as any)
    vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
    vi.spyOn(wallet as any, 'kickPendingQbitRestoreFloorScan').mockImplementation(() => undefined)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)

    await wallet.setChainType(ChainType.QBIT_TESTNET4)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)

    // Away and back: the testnet client is the same, but what it read is gone.
    await wallet.setChainType(ChainType.QBIT_MAINNET)
    expect(fundingTxReadsOf(wallet).size).toBe(0)
    await wallet.setChainType(ChainType.QBIT_TESTNET4)
    expect(preferenceService.getChainType()).toBe(ChainType.QBIT_TESTNET4)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
  })

  for (const failed of [false, true]) {
    it(`reports an incomplete read whose send guard did not answer as incomplete still${failed ? ', and failed' : ''}`, async () => {
      const wallet = controller()
      wallet.qbitBalanceGuardWaitMs = 1
      vi.spyOn(qbitSendGuardService, 'getReservedOutpointKeys').mockReturnValue(
        new Promise(() => undefined)
      )
      const marks = {
        utxoReadIncomplete: true,
        ...(failed ? { utxoReadFailed: true } : {}),
      }
      apiOverrides.balance = async (
        _client: unknown,
        _address: string,
        _script: string | undefined,
        readReserved: () => Promise<ReadonlySet<string>>
      ) => {
        await readReserved()
        return {
          availableBalance: null,
          unavailableBalance: TOTAL,
          totalBalance: TOTAL,
          immatureBalance: null,
          pendingBalance: null,
          ...marks,
        }
      }

      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual({
        availableBalance: null,
        unavailableBalance: TOTAL,
        totalBalance: TOTAL,
        immatureBalance: null,
        pendingBalance: null,
        ...marks,
        chainType: ChainType.QBIT_TESTNET4,
      })
    })
  }

  it('reports the total with the split unknown when a funding read fails', async () => {
    const wallet = controller()
    explorer.failures.push(({ path }) =>
      path === `/tx/${fakeTxid(42)}` ? { status: 404, body: 'not found' } : undefined
    )

    // A failed read, which the balance card backs off from.
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual({
      availableBalance: null,
      unavailableBalance: TOTAL,
      totalBalance: TOTAL,
      immatureBalance: null,
      pendingBalance: null,
      utxoReadIncomplete: true,
      utxoReadFailed: true,
      chainType: ChainType.QBIT_TESTNET4,
    })
    // What it read is kept: the next read asks only for the rest.
    explorer.failures.length = 0
    const kept = fundingTxReadsOf(wallet).size
    expect(kept).toBeGreaterThan(0)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS - kept)
  })
})
