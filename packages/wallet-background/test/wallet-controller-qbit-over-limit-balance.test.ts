import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  QBIT_COINBASE_MATURITY,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import {
  DEFAULT_LOCKTIME_ID,
  KeyringType,
  getLockTimeInfo,
  type QbitSendBroadcastClaim,
} from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import {
  keyringService,
  preferenceService,
  qbitSendGuardService,
  sessionService,
} from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'
import { QBIT_BROADCAST_RESEND_DELAYS_MS } from '../src/utils/qbit-broadcast'
import { qbitStatsSnapshot } from '../src/utils/qbit-api'
import { FakeQbitExplorer, fakeTxid, type FakeFailure } from './qbit-fake-explorer'

// The send guard is the real service and the explorer a fake served over
// fetch, so outputs, statistics and reservations come from production logic.
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  const lock = { isUnlocked: true }
  return {
    keyringService: {
      keyrings: [],
      signP2mrPsbtWithCounter: vi.fn(),
      preflightP2mrPsbtSigning: vi.fn(),
      memStore: { getState: () => lock },
      // Marks the wallet locked at once, before any wait, as the keyring
      // service does.
      setLocked: vi.fn(async () => {
        lock.isUnlocked = false
      }),
      unlockForTest: () => {
        lock.isUnlocked = true
      },
      removeKeyring: vi.fn(async () => undefined),
      // Both mark the wallet locked on their own, as the keyring service
      // does: a reset, once its writes are done, and an address-type change
      // it cannot roll back.
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
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      setChainType: vi.fn(),
      getCurrentKeyringIndex: vi.fn(() => 0),
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
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn(), broadcastChainChange: vi.fn() },
    contactBookService: { resetAllData: vi.fn(async () => undefined) },
    permissionService: { resetAllData: vi.fn(async () => undefined) },
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

const pubkeyHex = '11'.repeat(32)
const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const accountScript = bytesToHex(p2mrScriptPubKey(leafHash))
const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'regtest')
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
    addresses: { regtest: address },
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
const payer = p2mrAddressFromPubkey(hexToBytes('22'.repeat(32)), 'regtest')
const payerScript = bytesToHex(
  p2mrScriptPubKey(
    p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(hexToBytes('22'.repeat(32))))
  )
)
const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')
const SIGNATURE_BUDGET = {
  required: 1,
  cached: 0,
  remainingBefore: 1_000_000,
  remainingAfter: 999_999,
  limit: 1_073_741_824,
}

/** Past the explorer's 500-output listing limit, each output 10,000 sats. */
const OUTPUTS = 510
const OUTPUT_VALUE = 10_000
const SPENDABLE = OUTPUTS * OUTPUT_VALUE
/** A payment from someone else still in the mempool: in the total, not spendable. */
const PENDING_PAYMENT = 9_000
const TOTAL = SPENDABLE + PENDING_PAYMENT

const dummySignature = () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7)

describe("WalletController balance of an account over the explorer's UTXO limit", () => {
  let explorer: FakeQbitExplorer

  function controller() {
    vi.stubGlobal('fetch', explorer.fetch)
    const wallet = new WalletController()
    wallet.qbitBroadcastProbeDelayMs = 0
    wallet.qbitBroadcastResendDelaysMs = QBIT_BROADCAST_RESEND_DELAYS_MS.map(() => 0)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    return wallet
  }

  const BROADCAST_ATTEMPTS = 1 + QBIT_BROADCAST_RESEND_DELAYS_MS.length

  function failNext(
    matches: (request: { method: string; path: string }) => boolean,
    injected: ReturnType<FakeFailure>,
    times = 1
  ) {
    let left = times
    explorer.failures.push(request => {
      if (left === 0 || !matches(request)) return undefined
      left -= 1
      return injected
    })
  }

  const isBroadcast = ({ method, path }: { method: string; path: string }) =>
    method === 'POST' && path === '/tx'
  const isStatusLookup = ({ path }: { path: string }) => /^\/tx\/[0-9a-f]{64}\/status$/.test(path)

  /** The page `uiPort` builds and signs a 25,000-sat payment; its inputs are then held. */
  async function sign(wallet: WalletController, uiPort = 'popup:1') {
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 25_000,
      feeRate: 1,
    })
    const signed = await wallet.runForUiPort(
      uiPort,
      () => wallet.signPsbtV2(toSignData),
      'signPsbtV2'
    )
    const claim = signed.qbitSendBroadcastClaim as QbitSendBroadcastClaim
    return { claim, psbtHex: signed.psbtHex!, held: claim.outpoints.length * OUTPUT_VALUE }
  }

  async function send(wallet: WalletController, uiPort = 'popup:1') {
    const { claim, psbtHex, held } = await sign(wallet, uiPort)
    const result = await wallet.runForUiPort(
      uiPort,
      () => wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid),
      'broadcastQbitTx'
    )
    return { claim, result, held }
  }

  const unknownSplit = (total = TOTAL) => ({
    availableBalance: null,
    unavailableBalance: total,
    totalBalance: total,
    immatureBalance: null,
    pendingBalance: null,
    utxoLimitExceeded: true,
    chainType: ChainType.QBIT_REGTEST,
  })
  const split = (available: number, total = TOTAL) => ({
    availableBalance: available,
    unavailableBalance: total - available,
    totalBalance: total,
    immatureBalance: null,
    pendingBalance: null,
    utxoLimitExceeded: true,
    chainType: ChainType.QBIT_REGTEST,
  })

  /** `owner` paid as `address` is: the same outputs, so the same statistics. */
  function fundLikeAccount(owner: string, ownerScript: string, salt: number) {
    explorer.registerAddress(owner, ownerScript)
    for (let index = 0; index < OUTPUTS; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index, salt),
        inputs: [{ txid: fakeTxid(index, salt + 1_000_000), vout: 0 }],
        outputs: [{ address: owner, script: ownerScript, value: OUTPUT_VALUE }],
        height: 100 + Math.floor(index / 4),
      })
    }
    explorer.addTx({
      txid: fakeTxid(1, salt + 2_000_000),
      inputs: [{ txid: fakeTxid(2, salt + 3_000_000), vout: 0 }],
      outputs: [{ address: owner, script: ownerScript, value: PENDING_PAYMENT }],
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    explorer = new FakeQbitExplorer('esplora')
    explorer.registerAddress(address, accountScript)
    explorer.registerAddress(payer, payerScript)
    for (let index = 0; index < OUTPUTS; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
        height: 100 + Math.floor(index / 4),
      })
    }
    explorer.addTx({
      txid: fakeTxid(1, 7_000_000),
      inputs: [{ txid: fakeTxid(2, 8_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: PENDING_PAYMENT }],
    })
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    // A switch a test made follows the chain it asks for in that test alone,
    // and a removal a test made fail fails in that test alone.
    vi.mocked(preferenceService.setChainType).mockReset()
    vi.mocked(keyringService.removeKeyring).mockReset()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(SIGNATURE_BUDGET)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address: string, { psbt, keys }: any) => {
        const signed = signP2mrPsbt({ psbt, keys, sign: dummySignature })
        return { psbt: signed.psbt, signed: signed.signed, counterResults: [] } as any
      }
    )
    await qbitSendGuardService.resetAllData()
    ;(keyringService as any).unlockForTest()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await qbitSendGuardService.resetAllData()
  })

  it("takes the split from the send screen's read while the statistics read the same", async () => {
    const wallet = controller()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())

    const snapshot = await wallet.getQbitUtxoSnapshot()

    expect(snapshot.utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)).toBe(SPENDABLE)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
  })

  it("does not give another account's read to an account whose statistics read the same", async () => {
    const wallet = controller()
    fundLikeAccount(payer, payerScript, 20_000_000)
    await wallet.getQbitUtxoSnapshot()

    await expect(wallet.getAddressBalanceV2(payer)).resolves.toEqual(unknownSplit())
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
  })

  it('does not give a read to the same account on another network', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual({
      ...unknownSplit(),
      chainType: ChainType.QBIT_TESTNET4,
    })
  })

  it('keeps the split unknown once a transaction moves the statistics, until the next read', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    explorer.addTx({
      txid: fakeTxid(3, 7_000_000),
      inputs: [{ txid: fakeTxid(4, 8_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: 4_000 }],
    })

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit(TOTAL + 4_000))

    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE, TOTAL + 4_000)
    )
  })

  it('takes a fresh read after an eviction, though it finds less history than the kept one', async () => {
    const wallet = controller()
    // A payment from someone else is pending: the history counts N + 1.
    const payment = {
      txid: fakeTxid(3, 7_000_000),
      inputs: [{ txid: fakeTxid(4, 8_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: 4_000 }],
    }
    explorer.addTx(payment)
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE, TOTAL + 4_000)
    )

    // It is evicted: the statistics fall back to N, and the kept read no
    // longer matches them.
    explorer.removeTx(payment.txid)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())

    // A read started since then finds N, and replaces the kept one.
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
  })

  it('keeps the read that started later when an earlier one finishes after it', async () => {
    const wallet = controller()
    // The account's own pending send: classifying its change reads the
    // whole transaction, whose answer this test holds back.
    const ownSend = {
      txid: fakeTxid(6, 7_000_000),
      inputs: [{ txid: fakeTxid(0), vout: 0 }],
      outputs: [
        { address: payer, script: payerScript, value: 5_000 },
        { address, script: accountScript, value: 4_000 },
      ],
    }
    explorer.addTx(ownSend)
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let held = false
    let txHeld: () => void = () => undefined
    const txArrived = new Promise<void>(resolve => (txHeld = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && String(input).endsWith(`/tx/${ownSend.txid}`)) {
        held = true
        // Answered as the explorer stood when asked, delivered later.
        const answer = await explorer.fetch(input, init)
        txHeld()
        await released
        return answer
      }
      return explorer.fetch(input, init)
    })
    // An earlier read has verified the statistics and is classifying.
    const earlier = wallet.getQbitUtxos()
    await txArrived
    // A block confirms the mempool, and a read started since then completes
    // first: it reads every funding transaction from the confirmed history.
    explorer.confirmMempool()
    await wallet.getQbitUtxoSnapshot()
    release()
    await earlier

    // The earlier read, of the statistics before the block, does not
    // replace the later one.
    const total = TOTAL - OUTPUT_VALUE + 4_000
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(total, total))
  })

  it('takes a read that completes while the balance read is running', async () => {
    const wallet = controller()
    const reads = (wallet as any).qbitLatestUtxoReads
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_REGTEST)
    // The outputs a read of the history finds, kept aside for now.
    await wallet.getQbitUtxoSnapshot()
    const completed = reads.latest(client, address)
    expect(completed.stats).toBe(qbitStatsSnapshot(explorer.stats(address) as any))
    reads.clear()
    // The balance read waits for its first answer from the explorer.
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let held = false
    let requestHeld: () => void = () => undefined
    const requestArrived = new Promise<void>(resolve => (requestHeld = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && String(input).endsWith(`/address/${address}`)) {
        held = true
        const answer = await explorer.fetch(input, init)
        requestHeld()
        await released
        return answer
      }
      return explorer.fetch(input, init)
    })
    const balance = wallet.getAddressBalanceV2(address)
    await requestArrived

    // Meanwhile a read completes.
    reads.keep(client, address, reads.start(), completed)
    release()

    await expect(balance).resolves.toEqual(split(SPENDABLE))
  })

  it('keeps no read once the wallet locks, not even one still running', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))

    // A read still walks the history when the wallet locks.
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let held = false
    let pageHeld: () => void = () => undefined
    const pageArrived = new Promise<void>(resolve => (pageHeld = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && String(input).includes('/txs/chain')) {
        held = true
        pageHeld()
        await released
      }
      return explorer.fetch(input, init)
    })
    const running = wallet.getQbitUtxos()
    await pageArrived
    await wallet.lockWallet()
    release()
    await running

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('keeps no read that ends while the wallet locks', async () => {
    const wallet = controller()
    const lockState = (keyringService as any).memStore.getState()
    let finishLock: () => void = () => undefined
    const lockFinishes = new Promise<void>(resolve => (finishLock = resolve))
    vi.mocked(keyringService.setLocked).mockImplementationOnce(async () => {
      lockState.isUnlocked = false
      await lockFinishes
    })

    const locking = wallet.lockWallet()
    // A read starts and completes while the lock is still under way.
    await wallet.getQbitUtxoSnapshot()
    finishLock()
    await locking

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('serves no split while a slow lock waits', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    const lockState = (keyringService as any).memStore.getState()
    let finishLock: () => void = () => undefined
    const lockFinishes = new Promise<void>(resolve => (finishLock = resolve))
    vi.mocked(keyringService.setLocked).mockImplementationOnce(async () => {
      lockState.isUnlocked = false
      await lockFinishes
    })

    const locking = wallet.lockWallet()

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    finishLock()
    await locking
  })

  it('keeps nothing when the lock fails', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    const lockState = (keyringService as any).memStore.getState()
    vi.mocked(keyringService.setLocked).mockImplementationOnce(async () => {
      lockState.isUnlocked = false
      throw new Error('lock failed')
    })

    await expect(wallet.lockWallet()).rejects.toThrow('lock failed')

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  /** Whether `wallet` still remembers a read of the account's outputs. */
  const remembersRead = (wallet: WalletController) => {
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_REGTEST)
    return (wallet as any).qbitLatestUtxoReads.latest(client, address) !== undefined
  }

  it('keeps no read once the auto-lock timer locks the wallet', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    vi.mocked(preferenceService.getAutoLockTimeId).mockReturnValue(DEFAULT_LOCKTIME_ID)
    const now = Date.now()
    // Timers too, from here on: fake timers in use are not set up again.
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now })

    // The page reports activity, then none for the auto-lock time.
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(getLockTimeInfo(DEFAULT_LOCKTIME_ID).time)
    expect(keyringService.setLocked).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date'], now })

    expect(remembersRead(wallet)).toBe(false)
    // Unlocked again, the wallet has no read to take the split from.
    ;(keyringService as any).unlockForTest()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('keeps no read once the wallet data is reset', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))

    await wallet.resetAllData()
    clearTimeout(wallet.timer)

    expect(remembersRead(wallet)).toBe(false)
    // A wallet set up and unlocked since has no read to take the split from.
    ;(keyringService as any).unlockForTest()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('keeps nothing when the reset fails', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    // A write fails, before the wallet is marked locked.
    vi.mocked(keyringService.resetAllData).mockRejectedValueOnce(new Error('reset failed'))

    await expect(wallet.resetAllData()).rejects.toThrow('reset failed')

    expect(remembersRead(wallet)).toBe(false)
  })

  it('serves no split while a reset writes', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    const lockState = (keyringService as any).memStore.getState()
    let finishWrites: () => void = () => undefined
    const writesFinish = new Promise<void>(resolve => (finishWrites = resolve))
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      // The keyring service writes first, and only then marks the wallet
      // locked.
      await writesFinish
      lockState.isUnlocked = false
    })

    const resetting = wallet.resetAllData()

    expect(wallet.isUnlocked()).toBe(true)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    finishWrites()
    await resetting
    clearTimeout(wallet.timer)
  })

  it('keeps no read once the keyring service locks the wallet on its own', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    const lockState = (keyringService as any).memStore.getState()
    // Another keyring's address-type change fails, and the keyring service
    // locks the wallet because it cannot roll the change back.
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
    expect(remembersRead(wallet)).toBe(false)
    ;(keyringService as any).unlockForTest()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('announces a lock the keyring service makes on its own as lockWallet does', async () => {
    const wallet = controller()
    const uiBroadcasts = vi.spyOn(bgEventBus, 'emit')
    await wallet.lockWallet()
    const lockWalletAnnounces = {
      pages: vi.mocked(sessionService.broadcastEvent).mock.calls.slice(),
      ui: uiBroadcasts.mock.calls.slice(),
    }
    expect(lockWalletAnnounces.pages).toHaveLength(1)
    expect(lockWalletAnnounces.ui).toHaveLength(1)
    vi.mocked(sessionService.broadcastEvent).mockClear()
    uiBroadcasts.mockClear()
    ;(keyringService as any).unlockForTest()
    const lockState = (keyringService as any).memStore.getState()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      type: KeyringType.HdKeyring,
      accounts: [],
    } as any)

    // A change the keyring service rolls back leaves the wallet unlocked:
    // nothing to announce.
    vi.mocked(keyringService.changeAddressType).mockRejectedValueOnce(
      new Error('address type change failed')
    )
    await expect(wallet.changeAddressType(AddressType.P2TR)).rejects.toThrow(
      'address type change failed'
    )
    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
    expect(uiBroadcasts).not.toHaveBeenCalled()

    // One it cannot roll back locks the wallet, and is announced as a lock.
    vi.mocked(keyringService.changeAddressType).mockImplementationOnce(async () => {
      lockState.isUnlocked = false
      throw new Error('address type not restored')
    })
    await expect(wallet.changeAddressType(AddressType.P2TR)).rejects.toThrow(
      'address type not restored'
    )
    expect(vi.mocked(sessionService.broadcastEvent).mock.calls).toEqual(lockWalletAnnounces.pages)
    expect(uiBroadcasts.mock.calls).toEqual(lockWalletAnnounces.ui)
  })

  it('keeps no read made while the wallet is locked', async () => {
    const wallet = controller()
    await wallet.lockWallet()

    await wallet.getQbitUtxoSnapshot()

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('remembers the reads of the four addresses most recently used', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    const reads = (wallet as any).qbitLatestUtxoReads
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_REGTEST)
    const kept = reads.latest(client, address)
    // Four other over-limit accounts' reads complete since.
    for (const other of ['qbrt1zother1', 'qbrt1zother2', 'qbrt1zother3', 'qbrt1zother4']) {
      reads.keep(client, other, reads.start(), kept)
    }

    expect(reads.latest(client, address)).toBeUndefined()
    expect(reads.latest(client, 'qbrt1zother1')).toBe(kept)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('remembers only what the split needs of each output', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()

    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_REGTEST)
    const kept = (wallet as any).qbitLatestUtxoReads.latest(client, address)
    expect(kept.utxos).toHaveLength(OUTPUTS)
    for (const output of kept.utxos) {
      expect(Object.keys(output).sort()).toEqual(['satoshis', 'scriptPk', 'txid', 'vout'])
    }
  })

  it('keeps no read once a keyring is removed', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE))
    const keyring = { type: KeyringType.QbitHdKeyring, index: 0, key: 'k', accounts: [account] }
    // Another wallet stays, as a removal requires, and becomes current.
    const remaining = {
      type: KeyringType.QbitHdKeyring,
      index: 1,
      key: 'keyring_1',
      accounts: [{ ...account, key: 'keyring_1#0' }],
    }
    // The wallets the removal reads, before and after it.
    vi.spyOn(wallet as any, 'readKeyringsAfresh')
      .mockResolvedValueOnce([keyring, remaining])
      .mockResolvedValueOnce([remaining])
    vi.spyOn(wallet as any, 'resolveQueuedWalletKeyring').mockReturnValue(keyring)
    vi.spyOn(wallet as any, 'collectQbitRecoveryRemovalReasons').mockResolvedValue([])
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
    // The keyring service holds both wallets, each in its slot.
    const slots = (keyringService as any).keyrings
    slots.push({ type: KeyringType.QbitHdKeyring }, { type: KeyringType.QbitHdKeyring })

    try {
      await wallet.removeKeyring(keyring as any)
    } finally {
      slots.length = 0
    }

    expect(keyringService.removeKeyring).toHaveBeenCalledWith(0, {
      beforeRemove: expect.any(Function),
    })
    expect(selectKeyring).toHaveBeenCalledWith(remaining)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('keeps the split unknown once a coinbase output the read left out matures', async () => {
    const wallet = controller()
    const reward = 5_000_000
    const rewardHeight = explorer.tipHeight - 10
    explorer.addTx({
      txid: fakeTxid(7, 7_000_000),
      inputs: [],
      outputs: [{ address, script: accountScript, value: reward }],
      coinbase: true,
      height: rewardHeight,
    })
    await wallet.getQbitUtxoSnapshot()
    // Immature at the read: in the total, not in Available.
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE, TOTAL + reward)
    )

    // The chain grows to its maturity; the address's statistics do not move.
    const stats = explorer.stats(address)
    explorer.tipHeight = rewardHeight + QBIT_COINBASE_MATURITY - 2
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE, TOTAL + reward)
    )
    explorer.tipHeight += 1
    expect(explorer.stats(address)).toEqual(stats)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit(TOTAL + reward))

    // A new read counts it.
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE + reward, TOTAL + reward)
    )
  })

  it('keeps the split unknown once a rollback makes a coinbase output the read took in immature again', async () => {
    const wallet = controller()
    const reward = 5_000_000
    // Mature at the read, exactly: one block fewer and it is not.
    explorer.addTx({
      txid: fakeTxid(8, 7_000_000),
      inputs: [],
      outputs: [{ address, script: accountScript, value: reward }],
      coinbase: true,
      height: explorer.tipHeight - QBIT_COINBASE_MATURITY + 1,
    })
    await wallet.getQbitUtxoSnapshot()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE + reward, TOTAL + reward)
    )

    // The chain rolls back one block; the address's statistics do not move.
    const stats = explorer.stats(address)
    explorer.tipHeight -= 1
    expect(explorer.stats(address)).toEqual(stats)

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit(TOTAL + reward))
  })

  it('counts the outputs a signed send holds as unavailable', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()

    const { held } = await sign(wallet)

    expect(held).toBeGreaterThan(0)
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE - held))
  })

  it('keeps the split unknown while a broadcast holds the send guard', async () => {
    const wallet = controller()
    wallet.qbitBalanceGuardWaitMs = 50
    await wallet.getQbitUtxoSnapshot()
    let posted: () => void = () => undefined
    const postArrived = new Promise<void>(resolve => (posted = resolve))
    let answerPost: () => void = () => undefined
    const postAnswered = new Promise<void>(resolve => (answerPost = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted()
        await postAnswered
      }
      return explorer.fetch(input, init)
    })
    const sending = send(wallet)
    await postArrived

    let read: Awaited<ReturnType<typeof wallet.getAddressBalanceV2>>
    try {
      read = await wallet.getAddressBalanceV2(address)
    } finally {
      answerPost()
    }
    await sending

    expect(read).toEqual(unknownSplit())
  })

  it('leaves no stale split after a broadcast that never reached the node: its inputs stay held', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    failNext(isBroadcast, { status: 504 }, BROADCAST_ATTEMPTS)

    const { result, held } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'unknown' })
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(SPENDABLE - held))
  })

  it('leaves no stale split after a broadcast whose answer was lost: the statistics moved', async () => {
    const wallet = controller()
    await wallet.getQbitUtxoSnapshot()
    failNext(isBroadcast, 'accept-then-fail', BROADCAST_ATTEMPTS)
    failNext(isStatusLookup, { status: 404 }, BROADCAST_ATTEMPTS)

    const { claim, result } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'unknown' })
    expect(explorer.spenderOf(claim.outpoints[0]!.txid, claim.outpoints[0]!.vout)?.txid).toBe(
      claim.txid
    )
    const balance = await wallet.getAddressBalanceV2(address)
    expect(balance.availableBalance).toBeNull()
    expect(balance.utxoLimitExceeded).toBe(true)
  })

  it('keeps a read, joined or not, under the statistics its walk verified when they moved during it', async () => {
    const wallet = controller()
    const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let held = false
    let pageHeld: () => void = () => undefined
    const pageArrived = new Promise<void>(resolve => (pageHeld = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && String(input).includes('/txs/chain')) {
        held = true
        pageHeld()
        await released
      }
      return explorer.fetch(input, init)
    })
    const statsReads = () =>
      explorer.requests.filter(request => request.path === `/address/${address}`).length
    const first = wallet.getQbitUtxoSnapshot()
    // The walk has read the statistics and waits for its first history page.
    await pageArrived
    // The second read finds the statistics unchanged and joins the first.
    const statsReadsBefore = statsReads()
    const joined = wallet.getQbitUtxoSnapshot()
    await vi.waitFor(() => expect(statsReads()).toBe(statsReadsBefore + 1))
    // A payment arrives mid-walk: the walk reads the history again and
    // verifies the statistics as they read now.
    explorer.addTx({
      txid: fakeTxid(3, 7_000_000),
      inputs: [{ txid: fakeTxid(4, 8_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: 4_000 }],
    })
    release()
    await Promise.all([first, joined])
    // One read of the outputs ran for both.
    expect(walks).toHaveBeenCalledTimes(1)

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
      split(SPENDABLE, TOTAL + 4_000)
    )
  })

  it('does not match a read whose statistics moved before its walk and then came back', async () => {
    const wallet = controller()
    // The account's own send of one output, seen once the read has taken
    // its statistics and before its walk starts.
    const send = {
      txid: fakeTxid(5, 7_000_000),
      inputs: [{ txid: fakeTxid(0), vout: 0 }],
      outputs: [{ address: payer, script: payerScript, value: OUTPUT_VALUE - 1_000 }],
    }
    let sent = false
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await explorer.fetch(input, init)
      if (!sent && String(input).endsWith(`/address/${address}`)) {
        sent = true
        explorer.addTx(send)
      }
      return response
    })
    const snapshot = await wallet.getQbitUtxoSnapshot()
    expect(snapshot.utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)).toBe(
      SPENDABLE - OUTPUT_VALUE
    )

    // The send is evicted: the statistics read as they did before the walk,
    // but the walk saw the send, so its read does not count for them.
    explorer.removeTx(send.txid)

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  it('keeps nothing from a read that failed or was abandoned', async () => {
    const wallet = controller()
    // A history page fails for good.
    explorer.failures.push(({ path }) =>
      path.includes('/txs/chain') ? { status: 400, body: 'bad cursor' } : undefined
    )
    await expect(wallet.getQbitUtxoSnapshot()).rejects.toThrow()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    explorer.failures.length = 0

    // A page leaves the send screen while the walk waits for a page.
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    let pageHeld: () => void = () => undefined
    const pageArrived = new Promise<void>(resolve => (pageHeld = resolve))
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/txs/chain')) {
        pageHeld()
        await released
      }
      return explorer.fetch(input, init)
    })
    const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')
    const abandoned = wallet.runForUiPort(
      'popup:1',
      () => wallet.getQbitUtxoSnapshot('read-1'),
      'getQbitUtxoSnapshot'
    )
    await pageArrived
    await wallet.runForUiPort(
      'popup:1',
      () => wallet.abandonQbitUtxoSnapshot('read-1'),
      'abandonQbitUtxoSnapshot'
    )
    // The caller stops waiting at once, whatever the walk does.
    await expect(abandoned).rejects.toThrow('abandoned')
    release()
    vi.stubGlobal('fetch', explorer.fetch)

    // The walk itself stops too, and keeps nothing: wait for it to settle,
    // as a walk that went on would keep its outputs only when it ends.
    expect(walks).toHaveBeenCalledTimes(1)
    const [walk] = await Promise.allSettled([walks.mock.results[0]!.value])
    expect(walk.status).toBe('rejected')
    const client = (wallet as any).getQbitApiClient(ChainType.QBIT_REGTEST)
    expect((wallet as any).qbitLatestUtxoReads.latest(client, address)).toBeUndefined()
    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })

  describe('a read of outputs asked for before a clear', () => {
    /** The release of everything a test holds, which ends it if the test did not. */
    const held: (() => void)[] = []

    afterEach(() => {
      for (const release of held.splice(0)) release()
    })

    /**
     * Hold the first request each of `holds` matches, once asked for
     * (`arrived`), until `release`; with `answerWhenAsked`, answered as the
     * explorer stood when it was asked. The client sends one request for
     * the same URL at a time, which every reader of it waits for, so a read
     * that asks for one held here waits too.
     */
    function holdFirst(
      ...holds: { matches: (url: string) => boolean; answerWhenAsked?: boolean }[]
    ): { arrived: Promise<void>; release: () => void }[] {
      const requests = holds.map(hold => {
        let release: () => void = () => undefined
        const released = new Promise<void>(resolve => (release = resolve))
        let arrive: () => void = () => undefined
        const arrived = new Promise<void>(resolve => (arrive = resolve))
        held.push(release)
        return { ...hold, taken: false, arrive, arrived, released, release }
      })
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const hold = requests.find(
          candidate => !candidate.taken && candidate.matches(String(input))
        )
        if (!hold) return explorer.fetch(input, init)
        hold.taken = true
        const answer = hold.answerWhenAsked ? await explorer.fetch(input, init) : undefined
        hold.arrive()
        await hold.released
        return answer ?? explorer.fetch(input, init)
      })
      return requests.map(({ arrived, release }) => ({ arrived, release }))
    }

    /**
     * Hold a removal where it ends the removed wallet's send plans, after it
     * has removed the keyring and forgotten the kept reads once, and while
     * that wallet is still the one stored as current: once asked for
     * (`arrived`), until `release`, or `fail` with an error.
     */
    function holdEndingPlans(wallet: WalletController) {
      let release: () => void = () => undefined
      let fail: (error: Error) => void = () => undefined
      const ended = new Promise<void>((resolve, reject) => {
        release = resolve
        fail = reject
      })
      let arrive: () => void = () => undefined
      const arrived = new Promise<void>(resolve => (arrive = resolve))
      held.push(release)
      const ending = vi
        .spyOn((wallet as any).qbitSendPlans, 'endPlansOf')
        .mockImplementation(async () => {
          arrive()
          await ended
          return { mayHaveBeenSent: [] }
        })
      return { arrived, release, fail, ending }
    }

    async function lockAndUnlock(wallet: WalletController): Promise<void> {
      await wallet.lockWallet()
      ;(keyringService as any).unlockForTest()
    }

    /** The accounts whose send plans removing the account's wallet ends, as a removal derives them. */
    const removedPlanAccounts = [{ chain: ChainType.QBIT_REGTEST, address }]

    /**
     * Remove the account's wallet, another one staying, as a removal requires.
     * The accounts of its send plans are derived as a removal derives them,
     * unless `plansUnderived`: then the mocked keyring service cannot derive
     * them, and the removal goes on only while no plan is under way.
     */
    async function removeAccountKeyring(
      wallet: WalletController,
      { plansUnderived = false }: { plansUnderived?: boolean } = {}
    ): Promise<void> {
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
      if (!plansUnderived) {
        vi.spyOn(wallet as any, 'qbitSendPlanAccountsOf').mockResolvedValue({
          accounts: removedPlanAccounts,
          underived: [],
        })
      }
      const slots = (keyringService as any).keyrings
      slots.push({ type: KeyringType.QbitHdKeyring }, { type: KeyringType.QbitHdKeyring })
      try {
        await wallet.removeKeyring(keyring as any)
      } finally {
        slots.length = 0
      }
      expect(keyringService.removeKeyring).toHaveBeenCalled()
    }

    /** Ask for the account's outputs as `caller` does, `clear`, and let it read them. */
    type AskedThenRead = (wallet: WalletController, clear: () => Promise<void>) => Promise<void>

    const sendScreen: AskedThenRead = async (wallet, clear) => {
      const [statistics] = holdFirst({ matches: url => url.endsWith(`/address/${address}`) })
      const running = wallet.getQbitUtxoSnapshot()
      await statistics.arrived
      await clear()
      statistics.release()
      expect((await running).utxos).toHaveLength(OUTPUTS)
    }

    /** A send builder, `build`, cleared during its fee quote: built or refused, it reads after. */
    const duringFeeQuote =
      (build: (wallet: WalletController) => Promise<unknown>): AskedThenRead =>
      async (wallet, clear) => {
        const [quote] = holdFirst({ matches: url => url.includes('/fee-estimates') })
        const running = build(wallet)
        running.catch(() => undefined)
        await quote.arrived
        await clear()
        quote.release()
        await running.catch(() => undefined)
      }

    const callers: [string, AskedThenRead][] = [
      ["the send screen's read, cleared during its statistics read", sendScreen],
      [
        'a send, cleared during its fee quote',
        duringFeeQuote(wallet => wallet.createSendQbitPsbt({ to: recipient, amount: 25_000 })),
      ],
      [
        'a send of everything, cleared during its fee quote',
        // Over the UI port an omitted rate arrives as no key at all.
        duringFeeQuote(wallet => wallet.createSendAllQbitPsbt({ to: recipient } as any)),
      ],
      [
        "a send plan's read, cleared once the plan has asked for the outputs",
        async (wallet, clear) => {
          const host = (wallet as any).qbitSendPlanHost()
          const since = host.beginOutputsRead()
          await clear()
          await host.spendableOutputs(ChainType.QBIT_REGTEST, account, undefined, since)
        },
      ],
      [
        "the send screen's read, cleared during its statistics read, another joining it after",
        async (wallet, clear) => {
          const joins = vi.spyOn(wallet as any, 'sharedQbitAccountUtxos')
          const [statistics, page] = holdFirst(
            { matches: url => url.endsWith(`/address/${address}`) },
            { matches: url => url.includes('/txs/chain') }
          )
          const first = wallet.getQbitUtxoSnapshot()
          await statistics.arrived
          await clear()
          statistics.release()
          await page.arrived
          // Asked for after the clear, at the same state: it joins the walk
          // the first read started, which goes on at the first read's place.
          const joined = wallet.getQbitUtxoSnapshot()
          await vi.waitFor(() => expect(joins).toHaveBeenCalledTimes(2))
          page.release()
          for (const snapshot of await Promise.all([first, joined])) {
            expect(snapshot.utxos).toHaveLength(OUTPUTS)
          }
        },
      ],
    ]

    /** One walk of the history, which read every output and kept none of them. */
    async function expectWalkedAndKeptNothing(
      wallet: WalletController,
      walks: ReturnType<typeof vi.spyOn>
    ): Promise<void> {
      expect(walks).toHaveBeenCalledTimes(1)
      const outputs = (await walks.mock.results[0]!.value) as { satoshis: number }[]
      expect(outputs.reduce((sum, utxo) => sum + utxo.satoshis, 0)).toBe(SPENDABLE)
      expect(wallet.isUnlocked()).toBe(true)
      expect(remembersRead(wallet)).toBe(false)
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    }

    for (const [caller, askedThenRead] of callers) {
      it(`keeps no read of the history from ${caller}, a lock and an unlock between`, async () => {
        const wallet = controller()
        const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')

        await askedThenRead(wallet, () => lockAndUnlock(wallet))

        await expectWalkedAndKeptNothing(wallet, walks)
      })
    }

    // Each of the other clears, the removed account's outputs included: none
    // stays kept under its old address once a wallet is unlocked again.
    for (const [clear, during] of [
      [
        'the wallet data is reset',
        async (wallet: WalletController) => {
          await wallet.resetAllData()
          clearTimeout(wallet.timer)
          ;(keyringService as any).unlockForTest()
        },
      ],
      ['a keyring is removed', removeAccountKeyring],
      [
        'a Reset Wallet drops the wallet caches',
        async (wallet: WalletController) => {
          ;(wallet as any).dropWalletCaches()
          ;(keyringService as any).unlockForTest()
        },
      ],
      [
        'the keyring service locks the wallet on its own',
        async (wallet: WalletController) => {
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
          ;(keyringService as any).unlockForTest()
        },
      ],
    ] as const) {
      it(`keeps no read of the history from the send screen's read when ${clear} during its statistics read`, async () => {
        const wallet = controller()
        const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')

        await sendScreen(wallet, () => during(wallet))

        await expectWalkedAndKeptNothing(wallet, walks)
      })
    }

    // A pin, which passes without the place taken when asked as well: a
    // network switch forgets only what was read of funding transactions. The
    // kept reads are kept per API client, so one asked for before a switch
    // is kept as one that completed before it is.
    it('pins that a read asked for before a network switch is kept under the network it was asked on alone, not served on the new one', async () => {
      const wallet = controller()
      vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
        index: 0,
        type: KeyringType.QbitHdKeyring,
        accounts: [account],
      } as any)
      vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
      vi.spyOn(wallet as any, 'kickPendingQbitRestoreFloorScan').mockImplementation(() => undefined)
      vi.mocked(preferenceService.setChainType).mockImplementation((next: ChainType) => {
        vi.mocked(preferenceService.getChainType).mockReturnValue(next)
      })
      const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')

      await sendScreen(wallet, () => wallet.setChainType(ChainType.QBIT_TESTNET4))

      expect(preferenceService.getChainType()).toBe(ChainType.QBIT_TESTNET4)
      expect(walks).toHaveBeenCalledTimes(1)
      const reads = (wallet as any).qbitLatestUtxoReads
      const clientOf = (chain: ChainType) => (wallet as any).getQbitApiClient(chain)
      expect(reads.latest(clientOf(ChainType.QBIT_REGTEST), address)).toBeDefined()
      expect(reads.latest(clientOf(ChainType.QBIT_TESTNET4), address)).toBeUndefined()
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual({
        ...unknownSplit(),
        chainType: ChainType.QBIT_TESTNET4,
      })
    })

    for (const plansUnderived of [false, true]) {
      it(`keeps nothing, once a keyring is removed, of a read of its outputs asked for and completed while the removal ran${plansUnderived ? ', the accounts of its plans not derived' : ''}`, async () => {
        const wallet = controller()
        // The holds the removal takes on the networks it cannot derive, and
        // each release of one.
        const plans = (wallet as any).qbitSendPlans
        const hold = plans.holdNetworksIfIdle.bind(plans)
        const released = vi.fn()
        const networksHeld = vi
          .spyOn(plans, 'holdNetworksIfIdle')
          .mockImplementation((chains: unknown) => {
            const release = hold(chains)
            if (!release) return release
            return () => {
              released()
              release()
            }
          })
        const ending = holdEndingPlans(wallet)
        const removing = removeAccountKeyring(wallet, { plansUnderived })
        // A removal refused, a hold refused among them, fails the test at once.
        await Promise.race([ending.arrived, removing])
        if (plansUnderived) {
          // The removal could not tell which plans are the wallet's alone on
          // the network whose path differs from the active one's, and goes on
          // only while it holds that network.
          expect(networksHeld).toHaveBeenCalledTimes(1)
          expect(networksHeld).toHaveBeenCalledWith([ChainType.QBIT_MAINNET])
        } else {
          expect(networksHeld).not.toHaveBeenCalled()
          // With the id of the record the removal keeps of them (#216).
          expect(ending.ending).toHaveBeenCalledWith(removedPlanAccounts, 'a1'.repeat(16))
        }
        expect(released).not.toHaveBeenCalled()

        // The removed wallet is still the one stored as current: a read asked
        // for now reads its outputs, and keeps them while the removal runs.
        await wallet.getQbitUtxoSnapshot()
        expect(remembersRead(wallet)).toBe(true)
        ending.release()
        await removing

        // The hold, if it took one, ends with the removal.
        expect(released).toHaveBeenCalledTimes(plansUnderived ? 1 : 0)
        expect(remembersRead(wallet)).toBe(false)
        await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
      })
    }

    it('keeps nothing, once a keyring is removed, of a read of its outputs asked for while the removal ran and completed after', async () => {
      const wallet = controller()
      const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')
      const ending = holdEndingPlans(wallet)
      const removing = removeAccountKeyring(wallet)
      await ending.arrived
      const [statistics] = holdFirst({ matches: url => url.endsWith(`/address/${address}`) })
      const running = wallet.getQbitUtxoSnapshot()
      await statistics.arrived

      ending.release()
      await removing
      statistics.release()
      expect((await running).utxos).toHaveLength(OUTPUTS)

      await expectWalkedAndKeptNothing(wallet, walks)
    })

    it('keeps nothing of a read of the removed wallet’s outputs made while its removal ran, when the removal fails after removing the keyring', async () => {
      const wallet = controller()
      const ending = holdEndingPlans(wallet)
      const removing = removeAccountKeyring(wallet)
      removing.catch(() => undefined)
      await ending.arrived
      await wallet.getQbitUtxoSnapshot()
      expect(remembersRead(wallet)).toBe(true)

      ending.fail(new Error('the send plans could not be ended'))
      await expect(removing).rejects.toThrow('the send plans could not be ended')

      expect(remembersRead(wallet)).toBe(false)
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    })

    it('keeps nothing of the removed wallet’s outputs when the keyring service fails after it saved the emptied slot', async () => {
      const wallet = controller()
      await wallet.getQbitUtxoSnapshot()
      expect(remembersRead(wallet)).toBe(true)
      vi.mocked(keyringService.removeKeyring).mockImplementationOnce(async (index: number) => {
        // The slot is emptied and saved, then updating the keyring service's
        // memory store fails: the wallet is gone, and the removal rejects.
        ;(keyringService as any).keyrings[index] = { type: 'Empty' }
        throw new Error('the keyrings could not be updated')
      })

      await expect(removeAccountKeyring(wallet)).rejects.toThrow(
        'the keyrings could not be updated'
      )

      expect(remembersRead(wallet)).toBe(false)
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    })

    /**
     * The send screen's read (`screen`), asked for while the read of a
     * caller that did not ask to ride out server errors (`prepare`) reads the
     * pending payment's transaction, joins that read, which then fails on that
     * lookup as a ride-out would not have let it: the screen reads again on
     * its own. `meanwhile` runs once the screen has joined, before that
     * failure.
     */
    async function readAgainAfterJoining(
      wallet: WalletController,
      meanwhile: () => Promise<void>
    ): Promise<Awaited<ReturnType<WalletController['getQbitUtxoSnapshot']>>> {
      const joins = vi.spyOn(wallet as any, 'sharedQbitAccountUtxos')
      const lookupPath = `/tx/${fakeTxid(1, 7_000_000)}`
      let failing = 0
      explorer.failures.push(({ path }) =>
        path === lookupPath && failing-- > 0 ? { status: 502 } : undefined
      )
      const [lookup] = holdFirst({ matches: url => url.endsWith(lookupPath) })
      const prepare = wallet.getQbitUtxoSnapshot('prepare')
      prepare.catch(() => undefined)
      await lookup.arrived
      const screen = wallet.getQbitUtxoSnapshot('send-screen', true)
      await vi.waitFor(() => expect(joins).toHaveBeenCalledTimes(2))

      await meanwhile()
      // The client's three attempts.
      failing = 3
      lookup.release()

      await expect(prepare).rejects.toMatchObject({ status: 502 })
      return screen
    }

    it('keeps nothing from the send screen reading again on its own when the wallet locked and unlocked since it was asked', async () => {
      const wallet = controller()
      const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')

      const screen = await readAgainAfterJoining(wallet, () => lockAndUnlock(wallet))

      expect(screen.utxos).toHaveLength(OUTPUTS)
      // The read it joined, then its own, riding out server errors, which
      // started after the unlock.
      expect(walks).toHaveBeenCalledTimes(2)
      expect(walks.mock.calls[1]![5]).toBe(true)
      expect(remembersRead(wallet)).toBe(false)
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
    })

    it('keeps the answer of the send screen reading again on its own over that of a read that started reading before it', async () => {
      const wallet = controller()
      const walks = vi.spyOn(wallet as any, 'qbitAccountUtxosOn')

      const screen = await readAgainAfterJoining(wallet, async () => {
        // A block confirms the pending payment, and another read starts
        // reading after the screen was asked: it reads that payment from the
        // history, not from the lookup the screen's read waits for, and
        // completes first.
        explorer.confirmMempool()
        await wallet.getQbitUtxos()
        await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(TOTAL, TOTAL))
        // A payment arrives before the screen reads again.
        explorer.addTx({
          txid: fakeTxid(3, 7_000_000),
          inputs: [{ txid: fakeTxid(4, 8_000_000), vout: 0 }],
          outputs: [{ address, script: accountScript, value: 4_000 }],
        })
      })

      expect(screen.utxos).toHaveLength(OUTPUTS + 1)
      expect(walks).toHaveBeenCalledTimes(3)
      expect(walks.mock.calls[2]![5]).toBe(true)
      // Nothing was cleared: the read that started last, which saw the
      // payment, is kept.
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(
        split(TOTAL, TOTAL + 4_000)
      )
    })

    it('keeps the read that started later when an earlier one finishes after it, though its caller was asked first', async () => {
      const wallet = controller()
      // The account's own pending send: classifying its change reads the
      // whole transaction, whose answer this test holds back.
      const ownSend = {
        txid: fakeTxid(6, 7_000_000),
        inputs: [{ txid: fakeTxid(0), vout: 0 }],
        outputs: [
          { address: payer, script: payerScript, value: 5_000 },
          { address, script: accountScript, value: 4_000 },
        ],
      }
      explorer.addTx(ownSend)
      const [quote, ownSendRead] = holdFirst(
        { matches: url => url.includes('/fee-estimates') },
        { matches: url => url.endsWith(`/tx/${ownSend.txid}`), answerWhenAsked: true }
      )
      // A send is asked for, and waits for its fee quote before it reads.
      const later = wallet.createSendQbitPsbt({ to: recipient, amount: 25_000 })
      await quote.arrived
      // Meanwhile a read starts, has verified the statistics and is classifying.
      const earlier = wallet.getQbitUtxos()
      await ownSendRead.arrived
      // A block confirms the mempool, and the send's read, which starts only
      // now, completes first.
      explorer.confirmMempool()
      quote.release()
      await later
      ownSendRead.release()
      await earlier

      // The earlier read, of the statistics before the block, does not
      // replace the later one.
      const total = TOTAL - OUTPUT_VALUE + 4_000
      await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(split(total, total))
    })
  })
})
