import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringType, type QbitSendBroadcastClaim } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { QBIT_BROADCAST_RESEND_DELAYS_MS } from '../src/utils/qbit-broadcast'
import { FakeQbitExplorer, fakeTxid, type FakeFailure } from './qbit-fake-explorer'

// The send guard is the real service and the explorer a fake served over
// fetch, so outputs, statistics and reservations come from production logic.
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      signP2mrPsbtWithCounter: vi.fn(),
      preflightP2mrPsbtSigning: vi.fn(),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
    },
    qbitSendGuardService: guard,
    walletApiService: { transactionCore: { pushTx: vi.fn(), decodePsbt: vi.fn() } },
    sessionService: {},
    contactBookService: {},
    notificationService: {},
    permissionService: {},
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
    const signed = await wallet.runForUiPort(uiPort, () => wallet.signPsbtV2(toSignData))
    const claim = signed.qbitSendBroadcastClaim as QbitSendBroadcastClaim
    return { claim, psbtHex: signed.psbtHex!, held: claim.outpoints.length * OUTPUT_VALUE }
  }

  async function send(wallet: WalletController, uiPort = 'popup:1') {
    const { claim, psbtHex, held } = await sign(wallet, uiPort)
    const result = await wallet.runForUiPort(uiPort, () =>
      wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)
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
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(SIGNATURE_BUDGET)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address: string, { psbt, keys }: any) => {
        const signed = signP2mrPsbt({ psbt, keys, sign: dummySignature })
        return { psbt: signed.psbt, signed: signed.signed, counterResults: [] } as any
      }
    )
    await qbitSendGuardService.resetAllData()
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
    const abandoned = wallet.runForUiPort('popup:1', () => wallet.getQbitUtxoSnapshot('read-1'))
    await pageArrived
    await wallet.runForUiPort('popup:1', () => wallet.abandonQbitUtxoSnapshot('read-1'))
    await expect(abandoned).rejects.toThrow('abandoned')
    release()
    vi.stubGlobal('fetch', explorer.fetch)

    await expect(wallet.getAddressBalanceV2(address)).resolves.toEqual(unknownSplit())
  })
})
