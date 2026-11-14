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
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
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
    getQbitAddressUtxos: recorded('getQbitAddressUtxos', actual.getQbitAddressUtxos),
    getQbitAddressUtxosClassifiedPastLimit: recorded(
      'getQbitAddressUtxosClassifiedPastLimit',
      actual.getQbitAddressUtxosClassifiedPastLimit
    ),
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
    explorer = new FakeQbitExplorer('mempool-qbit')
    explorer.registerAddress(address, accountScript)
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

  it('reads an unchanged account once, for the balance and the send screen alike', async () => {
    const wallet = controller()

    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(fullSplit())
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)
    // The send screen's read goes through the same reader.
    let snapshot: Awaited<ReturnType<typeof wallet.getQbitUtxoSnapshot>> | undefined
    expect(
      await txReadsOf(async () => {
        snapshot = await wallet.getQbitUtxoSnapshot()
      })
    ).toBe(0)
    expect(snapshot!.utxos).toHaveLength(OUTPUTS)
  })

  it('passes its one shared reader on the balance, send, output and recovery reads', async () => {
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

    // The balance reads every output once, then polls without a read.
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(OUTPUTS + 3)
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)
    // Every read of outputs a send may spend reads the young ones afresh,
    // and only them.
    for (const read of [
      () => wallet.getQbitUtxos(),
      () => wallet.getAddressUtxo(address),
      () =>
        (wallet as any).readQbitRecoverySourceUtxos(client, address, {
          deferIncompleteHistory: false,
        }),
    ]) {
      const before = youngReads()
      expect(await txReadsOf(read)).toBe(3)
      expect(youngReads() - before).toBe(3)
    }
    expect(await txReadsOf(() => wallet.getAddressBalanceV2(address))).toBe(0)

    const optionsOf = (name: string) =>
      apiOverrides.calls
        .filter(call => call.name === name)
        .map(call => call.args.at(-1) as { fundingTxReads?: unknown })
    expect(optionsOf('getQbitSpendableBalanceV2')).toEqual(
      Array(3).fill({ fundingTxReads: shared })
    )
    for (const name of [
      'readQbitAddressUtxos',
      'getQbitAddressUtxos',
      'getQbitAddressUtxosClassifiedPastLimit',
    ]) {
      expect(optionsOf(name).length).toBeGreaterThan(0)
      // The shared reader, and nothing that would loosen the rule.
      for (const options of optionsOf(name)) expect(options).toEqual({ fundingTxReads: shared })
    }
  })

  it('keeps its reads to one explorer within 16 in flight, a balance and a send read together', async () => {
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
    expect(peak).toBeLessThanOrEqual(16)
    expect(peak).toBeGreaterThan(1)
    // The two split the reads instead of making each one twice.
    expect(txReads()).toBeLessThanOrEqual(OUTPUTS + 32)
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

  it('forgets what it read when a keyring is removed', async () => {
    const wallet = controller()
    await wallet.getAddressBalanceV2(address)
    expect(fundingTxReadsOf(wallet).size).toBe(OUTPUTS)
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
