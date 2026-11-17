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
import { getQbitSpendableBalanceV2 } from '../src/utils/qbit-api'
import { QBIT_BALANCE_REUSE_MAX_AGE_MS } from '../src/utils/qbit-balance-reuse'
import { QBIT_EXPLORER_FRESH_READ_PARAM } from '../src/utils/qbit-explorer-fetch'
import { FakeQbitExplorer, fakeTxid, type FakeTx } from './qbit-fake-explorer'

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

/** Past the 1,000 outputs from which an answer is kept, each a coinbase maturity deep. */
const OUTPUTS = 1_200
const OUTPUT_VALUE = 10_000
const LISTING = `/address/${address}/utxo`
const STATS = `/address/${address}`
const TIP = '/blocks/tip/height'
/** `path` asked for as a fresh read, the nonce left out. */
const fresh = (path: string): string => `${path}?${QBIT_EXPLORER_FRESH_READ_PARAM}`
/** A poll with nothing kept for the address. */
const LISTED = [STATS, TIP, LISTING]
/** A poll with a candidate kept, whose listing, asked for fresh, confirms it. */
const CONFIRMING = [STATS, TIP, fresh(LISTING)]
/** A poll that reuses the answer kept. */
const REUSED = [fresh(STATS), TIP]
/** The time between two polls of the balance card. */
const POLL_MS = 10_000

const fullSplit = {
  availableBalance: OUTPUTS * OUTPUT_VALUE,
  unavailableBalance: 0,
  totalBalance: OUTPUTS * OUTPUT_VALUE,
  immatureBalance: 0,
  pendingBalance: 0,
  chainType: ChainType.QBIT_TESTNET4,
}

describe("WalletController's balance answers kept for reuse (W-F3)", () => {
  let explorer: FakeQbitExplorer

  function controller() {
    vi.stubGlobal('fetch', explorer.fetch)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    return wallet
  }

  /** The paths of the requests sent from `from` on, a fresh read's nonce left out. */
  function requestsFrom(from: number): string[] {
    return explorer.requests.slice(from).map(({ path }) => {
      const url = new URL(path, 'https://explorer.test')
      return url.searchParams.has(QBIT_EXPLORER_FRESH_READ_PARAM) ? fresh(url.pathname) : path
    })
  }

  /** A balance read a poll interval after the last: its answer and its requests. */
  async function read(wallet: WalletController) {
    vi.advanceTimersByTime(POLL_MS)
    const from = explorer.requests.length
    const value = await wallet.getAddressBalanceV2(address)
    return { value, requests: requestsFrom(from) }
  }

  /** The requests a balance read makes, a poll interval after the last, which answers in full. */
  async function poll(wallet: WalletController): Promise<string[]> {
    const { value, requests } = await read(wallet)
    expect(value).toEqual(fullSplit)
    return requests
  }

  /** The answer kept and confirmed: the third poll reuses it. */
  async function confirmed(wallet: WalletController): Promise<void> {
    expect(await poll(wallet)).toEqual(LISTED)
    expect(await poll(wallet)).toEqual(CONFIRMING)
    expect(await poll(wallet)).toEqual(REUSED)
  }

  /**
   * Whether the kept answers hold one for the address through the client,
   * whatever it is: a locked or reset wallet holds none in memory.
   */
  function holdsAnswer(wallet: WalletController): boolean {
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
    return (wallet as any).qbitBalanceReuse.holds(client, address)
  }

  /** Read afresh, as from nothing kept: a candidate, then the listing that confirms it. */
  async function readAfresh(wallet: WalletController): Promise<void> {
    expect(await poll(wallet)).toEqual(LISTED)
    expect(await poll(wallet)).toEqual(CONFIRMING)
    expect(await poll(wallet)).toEqual(REUSED)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // The kept answers' clock moves with these, and nothing else is faked.
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
    explorer = new FakeQbitExplorer('mempool-qbit')
    explorer.registerAddress(address, accountScript)
    explorer.utxoLimit = 1_000_000
    for (let index = 0; index < OUTPUTS; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
        height: 100 + Math.floor(index / 4),
      })
    }
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

  /** Switch the network away and back: the client is the same one again. */
  async function switchNetworkAndBack(wallet: WalletController): Promise<void> {
    const keyring = { index: 0, type: KeyringType.QbitHdKeyring, accounts: [account] }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(keyring as any)
    vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
    vi.spyOn(wallet as any, 'kickPendingQbitRestoreFloorScan').mockImplementation(() => undefined)
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
    await wallet.setChainType(ChainType.QBIT_MAINNET)
    await wallet.setChainType(ChainType.QBIT_TESTNET4)
    expect(preferenceService.getChainType()).toBe(ChainType.QBIT_TESTNET4)
    expect((wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)).toBe(client)
  }

  /** The keyring service locks the wallet on its own, after an address-type change it cannot roll back. */
  async function keyringLocksOnItsOwn(wallet: WalletController): Promise<void> {
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
    ;(keyringService as any).unlockForTest()
  }

  const clears = [
    [
      'the wallet locks and unlocks',
      async (wallet: WalletController) => {
        await wallet.lockWallet()
        ;(keyringService as any).unlockForTest()
      },
    ],
    [
      'the wallet data is reset',
      async (wallet: WalletController) => {
        await wallet.resetAllData()
        clearTimeout(wallet.timer)
        ;(keyringService as any).unlockForTest()
      },
    ],
    [
      'the wallet caches are dropped by a Reset Wallet',
      async (wallet: WalletController) => {
        ;(wallet as any).dropWalletCaches()
      },
    ],
    ['a keyring is removed', removeAccountKeyring],
    ['the keyring service locks the wallet on its own', keyringLocksOnItsOwn],
    ['the network changes away and back', switchNetworkAndBack],
    [
      'the regtest clients are dropped',
      async (wallet: WalletController) => {
        ;(wallet as any).dropRegtestApiClients()
      },
    ],
  ] as const

  for (const [clear, during] of clears) {
    it(`holds no answer once ${clear}, and reuses nothing kept before`, async () => {
      const wallet = controller()
      await confirmed(wallet)
      expect(holdsAnswer(wallet)).toBe(true)

      await during(wallet)

      // Gone from memory, not only no longer reusable.
      expect(holdsAnswer(wallet)).toBe(false)
      await readAfresh(wallet)
    })
  }

  it('reuses nothing while the wallet data is reset, and keeps nothing a read made during its writes', async () => {
    const wallet = controller()
    await confirmed(wallet)
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
    // Gone from memory before the writes, by the reset's first clear.
    expect(holdsAnswer(wallet)).toBe(false)

    // The wallet still reads unlocked: nothing kept before the reset is
    // reused, and what these reads keep goes once the writes are done.
    expect(await poll(wallet)).toEqual(LISTED)
    expect(await poll(wallet)).toEqual(CONFIRMING)
    expect(holdsAnswer(wallet)).toBe(true)
    finishWrites()
    await reset
    expect(holdsAnswer(wallet)).toBe(false)
    clearTimeout(wallet.timer)
    ;(keyringService as any).unlockForTest()

    await readAfresh(wallet)
  })

  it('reuses and keeps nothing while the wallet reads locked', async () => {
    const wallet = controller()
    await confirmed(wallet)

    await wallet.lockWallet()
    for (let read = 0; read < 3; read += 1) expect(await poll(wallet)).toEqual(LISTED)
    ;(keyringService as any).unlockForTest()

    // Nothing read while locked counts: a candidate first, as from nothing.
    await readAfresh(wallet)
  })

  it('keeps nothing from a read asked for before a lock, though it completes after the unlock', async () => {
    const wallet = controller()
    expect(await poll(wallet)).toEqual(LISTED)
    // The read that would confirm the candidate, its listing held.
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const arrived = new Promise<void>(resolve => (arrive = resolve))
    let held = false
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && new URL(String(input)).pathname.endsWith(LISTING)) {
        held = true
        arrive()
        await released
      }
      return explorer.fetch(input, init)
    })
    vi.advanceTimersByTime(POLL_MS)
    const running = wallet.getAddressBalanceV2(address)
    await arrived

    await wallet.lockWallet()
    ;(keyringService as any).unlockForTest()
    release()
    await expect(running).resolves.toEqual(fullSplit)

    await readAfresh(wallet)
  })

  it('reads the send guard on a reused poll, and counts what it holds', async () => {
    const wallet = controller()
    await confirmed(wallet)
    const guard = vi.spyOn(qbitSendGuardService, 'getReservedOutpointKeys')
    guard.mockResolvedValueOnce(new Set([`${fakeTxid(7)}:0`]))

    vi.advanceTimersByTime(POLL_MS)
    const from = explorer.requests.length
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual({
      ...fullSplit,
      availableBalance: (OUTPUTS - 1) * OUTPUT_VALUE,
      unavailableBalance: OUTPUT_VALUE,
    })
    expect(requestsFrom(from)).toEqual(REUSED)
    expect(guard).toHaveBeenCalledTimes(1)
  })

  it('answers the split when a first wait for the send guard lapses and the poll reads the reservations again after the listing', async () => {
    const wallet = controller()
    ;(wallet as any).qbitBalanceGuardWaitMs = 30
    await confirmed(wallet)
    const guard = vi.spyOn(qbitSendGuardService, 'getReservedOutpointKeys')
    // The first wait lapses, and the answer's age runs out meanwhile; the
    // read after the listing answers.
    guard.mockImplementationOnce(() => {
      vi.advanceTimersByTime(QBIT_BALANCE_REUSE_MAX_AGE_MS)
      return new Promise<Set<string>>(() => undefined)
    })

    const { value, requests } = await read(wallet)

    expect(requests).toEqual([fresh(STATS), TIP, fresh(LISTING)])
    expect(guard).toHaveBeenCalledTimes(2)
    expect(value).toEqual(fullSplit)
  })

  it('answers the split unknown when a first read of the send guard answered, the reuse was given up, and the read after the listing lapses', async () => {
    const wallet = controller()
    ;(wallet as any).qbitBalanceGuardWaitMs = 30
    await confirmed(wallet)
    const guard = vi.spyOn(qbitSendGuardService, 'getReservedOutpointKeys')
    guard
      // The answer's age runs out as the guard answers.
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(QBIT_BALANCE_REUSE_MAX_AGE_MS)
        return new Set<string>()
      })
      .mockImplementationOnce(() => new Promise<Set<string>>(() => undefined))

    const { value, requests } = await read(wallet)

    expect(requests).toEqual([fresh(STATS), TIP, fresh(LISTING)])
    expect(guard).toHaveBeenCalledTimes(2)
    expect(value).toEqual({
      ...fullSplit,
      availableBalance: null,
      unavailableBalance: fullSplit.totalBalance,
      immatureBalance: null,
      pendingBalance: null,
    })
  })

  it('holds no answer from a keyring removal on, and reuses nothing a poll kept while it had not yet settled the current wallet', async () => {
    const wallet = controller()
    await confirmed(wallet)
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
    // Gone from memory once the keyring went, by the removal's first clear.
    expect(holdsAnswer(wallet)).toBe(false)

    // The removal has cleared the answers, and the removed wallet is still
    // stored as current: polls of it keep and confirm an answer.
    expect(await poll(wallet)).toEqual(LISTED)
    expect(await poll(wallet)).toEqual(CONFIRMING)
    expect(holdsAnswer(wallet)).toBe(true)
    release()
    await removal
    expect(holdsAnswer(wallet)).toBe(false)

    expect(await poll(wallet)).toEqual(LISTED)
  })

  describe('once a read of outputs for a send replaces a kept fact', () => {
    const readers = [
      [
        'the send screen',
        async (wallet: WalletController) => {
          await wallet.getQbitUtxoSnapshot()
        },
      ],
      [
        'the wallet method that reads an address',
        async (wallet: WalletController) => {
          await wallet.getAddressUtxo(address)
        },
      ],
      [
        "a recovery pass's source read",
        async (wallet: WalletController) => {
          const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
          await (wallet as any).readQbitRecoverySourceUtxos(client, address, {
            deferIncompleteHistory: false,
          })
        },
      ],
    ] as const

    for (const [reader, readOutputs] of readers) {
      it(`goes on reusing the answer after ${reader} read the outputs and replaced no fact with a differing one`, async () => {
        const wallet = controller()
        // A payment 10 blocks deep, whose transaction every such read reads again.
        explorer.addTx({
          txid: fakeTxid(9_100, 7_000_000),
          inputs: [{ txid: fakeTxid(9_101, 7_000_000), vout: 0 }],
          outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
          height: explorer.tipHeight - 9,
        })
        const split = {
          ...fullSplit,
          availableBalance: fullSplit.availableBalance + OUTPUT_VALUE,
          totalBalance: fullSplit.totalBalance + OUTPUT_VALUE,
        }
        const seen: string[][] = []
        for (let poll = 0; poll < 3; poll += 1) {
          const { value, requests } = await read(wallet)
          expect(value).toEqual(split)
          seen.push(requests.slice(0, 3))
        }
        expect(seen).toEqual([LISTED, CONFIRMING, REUSED])

        await readOutputs(wallet)

        const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
        expect((wallet as any).qbitFundingTxReads.factChanges(client)).toBe(0)
        const after = await read(wallet)
        expect(after.requests).toEqual(REUSED)
        expect(after.value).toEqual(split)
      })
    }

    /**
     * A reward 10 blocks deep, which the explorer answers as a payment until
     * `answerRight`, and a payment as deep, whose read a test can hold.
     */
    function wrongReward() {
      const reward: FakeTx = explorer.addTx({
        txid: fakeTxid(9_001, 7_000_000),
        inputs: [],
        outputs: [{ address, script: accountScript, value: 5_000_000 }],
        coinbase: true,
        height: explorer.tipHeight - 9,
      })
      const other: FakeTx = explorer.addTx({
        txid: fakeTxid(9_002, 7_000_000),
        inputs: [{ txid: fakeTxid(9_003, 7_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: 3_000 }],
        height: explorer.tipHeight - 9,
      })
      let wrong = true
      explorer.failures.push(({ path }) => {
        if (!wrong || path !== `/tx/${reward.txid}`) return undefined
        const body = explorer.esploraTx(reward) as { vin: unknown[] }
        body.vin = [
          {
            txid: '77'.repeat(32),
            vout: 0,
            prevout: {
              scriptpubkey: accountScript,
              scriptpubkey_asm: '',
              scriptpubkey_type: 'v2_p2mr',
              value: 5_000_100,
            },
            scriptsig: '',
            scriptsig_asm: '',
            is_coinbase: false,
            sequence: 0xfffffffd,
          },
        ]
        return { status: 200, body: JSON.stringify(body) }
      })
      const total = fullSplit.totalBalance + 5_000_000 + 3_000
      return {
        other,
        answerRight: (): void => {
          wrong = false
        },
        wrongSplit: { ...fullSplit, availableBalance: total, totalBalance: total },
        corrected: {
          ...fullSplit,
          availableBalance: total - 5_000_000,
          unavailableBalance: 5_000_000,
          totalBalance: total,
          immatureBalance: 5_000_000,
        },
      }
    }

    /** Hold the reads of `tx`'s transaction while `holding()`, until `release`. */
    function holdTxReads(tx: FakeTx, holding: () => boolean) {
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input : input.url
        )
        if (holding() && url.pathname.endsWith(`/tx/${tx.txid}`)) await released
        return explorer.fetch(input, init)
      })
      return { release }
    }

    /** The answer reused, the reward wrongly counted Available. */
    async function wronglyReused(wallet: WalletController, wrongSplit: unknown): Promise<void> {
      const seen: string[][] = []
      for (let poll = 0; poll < 3; poll += 1) {
        const { value, requests } = await read(wallet)
        expect(value).toEqual(wrongSplit)
        seen.push(requests.slice(0, 3))
      }
      expect(seen).toEqual([LISTED, CONFIRMING, REUSED])
    }

    it('lists, and shows the reward immature as a read with its facts does, on a poll while the send screen read that corrected its fact still runs', async () => {
      const wallet = controller()
      const { other, answerRight, wrongSplit, corrected } = wrongReward()
      let holding = false
      const held = holdTxReads(other, () => holding)
      await wronglyReused(wallet, wrongSplit)
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)
      const facts = (wallet as any).qbitFundingTxReads

      // The explorer answers right again; the send screen's read replaces the
      // fact, and is held on another transaction.
      answerRight()
      holding = true
      const snapshot = wallet.getQbitUtxoSnapshot()
      await vi.waitFor(() => expect(facts.factChanges(client)).toBe(1))

      const withItsFacts = await getQbitSpendableBalanceV2(
        client,
        address,
        accountScript,
        async () => new Set<string>(),
        undefined,
        { fundingTxReads: facts }
      )
      const during = await read(wallet)
      held.release()
      await snapshot

      expect(during.requests.slice(0, 3)).toEqual(LISTED)
      expect(during.value).toEqual(corrected)
      expect(during.value).toEqual({ ...withItsFacts, chainType: ChainType.QBIT_TESTNET4 })
    })

    it('ends the reuse once a read of outputs replaced the fact, though that read then failed', async () => {
      const wallet = controller()
      const { other, answerRight, wrongSplit, corrected } = wrongReward()
      let holding = false
      const held = holdTxReads(other, () => holding)
      await wronglyReused(wallet, wrongSplit)
      const client = (wallet as any).getQbitApiClient(ChainType.QBIT_TESTNET4)

      answerRight()
      holding = true
      const snapshot = wallet.getQbitUtxoSnapshot()
      await vi.waitFor(() => expect((wallet as any).qbitFundingTxReads.factChanges(client)).toBe(1))
      // The held read fails: so does the send screen's read.
      explorer.failures.push(({ path }) =>
        path === `/tx/${other.txid}` ? { status: 404, body: 'not found' } : undefined
      )
      held.release()
      await expect(snapshot).rejects.toThrow()
      holding = false

      const after = await read(wallet)
      expect(after.requests.slice(0, 3)).toEqual(LISTED)
      expect(after.value).toEqual(corrected)
    })

    it('shows a reward as immature on the next poll once the send screen read its transaction again and corrected a wrong "not a coinbase" fact', async () => {
      const wallet = controller()
      const { answerRight, wrongSplit, corrected } = wrongReward()
      await wronglyReused(wallet, wrongSplit)

      // The explorer answers right again, and the send screen reads the outputs.
      answerRight()
      await wallet.getQbitUtxoSnapshot()

      const after = await read(wallet)
      expect(after.requests.slice(0, 3)).toEqual(LISTED)
      expect(after.value).toEqual(corrected)
    })
  })
})
