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
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import { KeyringType, type QbitSendBroadcastClaim, type ToSignData } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import {
  QBIT_RECENT_SPEND_GONE_GRACE_MS,
  QBIT_RECENT_SPEND_PROBE_INTERVAL_MS,
} from '../src/services/qbitSendGuards'
import { QBIT_BROADCAST_RESEND_DELAYS_MS } from '../src/utils/qbit-broadcast'
import { FakeQbitExplorer, fakeTxid, type FakeFailure } from './qbit-fake-explorer'

// The send guard is the real service and the explorer a fake served over
// fetch, so claims, recent spends and probes come from production logic.
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
const recipientPubkey = hexToBytes('33'.repeat(32))
const recipient = p2mrAddressFromPubkey(recipientPubkey, 'regtest')
const recipientScript = p2mrScriptPubKey(
  p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(recipientPubkey))
)
const SIGNATURE_BUDGET = {
  required: 1,
  cached: 0,
  remainingBefore: 1_000_000,
  remainingAfter: 999_999,
  limit: 1_073_741_824,
}

/** The output the payment spends, and one it leaves alone. */
const SPENT = { txid: fakeTxid(1), vout: 0, value: 200_000 }
const KEPT = { txid: fakeTxid(2), vout: 0, value: 90_000 }

const dummySignature = () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7)

/**
 * What Speed up hands the signer for a replacement of `originalTxid`: the
 * same input and payment, less change. Built by hand because the explorer
 * fake cannot vouch for the original's signatures, which the replacement's
 * assessment verifies.
 */
function feeBumpOf(originalTxid: string): ToSignData {
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: hexToBytes(SPENT.txid).reverse(), vout: SPENT.vout },
        sequence: 0xfffffffd,
        witnessUtxo: { value: BigInt(SPENT.value), scriptPubKey: hexToBytes(accountScript) },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      },
    ],
    outputs: [
      { value: 10_000n, scriptPubKey: recipientScript },
      { value: BigInt(SPENT.value - 10_000 - 8_000), scriptPubKey: hexToBytes(accountScript) },
    ],
  })
  // The txid leaves the witness out, so a dummy-signed copy names it.
  const signedCopy = signP2mrPsbt({
    psbt,
    keys: [{ inputIndex: 0, pubkey: hexToBytes(pubkeyHex), leafHash }],
    sign: dummySignature,
  }).psbt
  const txid = transactionCore.Transaction.fromBuffer(
    Buffer.from(extractP2mrTransaction(finalizeP2mrPsbt(signedCopy)))
  ).getId()
  return {
    psbtHex: bytesToHex(serializePsbt(psbt)),
    toSignInputs: [{ index: 0, publicKey: pubkeyHex }],
    qbitP2mrSigningKeys: [{ inputIndex: 0, publicKey: pubkeyHex, leafHash: bytesToHex(leafHash) }],
    qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid },
    feeBump: { originalTxid } as ToSignData['feeBump'],
    autoFinalized: true,
  }
}

describe('WalletController wallet send whose broadcast outcome is unknown (#339)', () => {
  let explorer: FakeQbitExplorer
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

  function controller() {
    vi.stubGlobal('fetch', explorer.fetch)
    const wallet = new WalletController()
    wallet.qbitBroadcastProbeDelayMs = 0
    wallet.qbitBroadcastResendDelaysMs = QBIT_BROADCAST_RESEND_DELAYS_MS.map(() => 0)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    return wallet
  }

  /**
   * A broadcast's attempts: the first, and each re-send of the same bytes
   * after a lookup missed them (#356). A failure injected on every one of
   * them leaves the outcome unknown.
   */
  const BROADCAST_ATTEMPTS = 1 + QBIT_BROADCAST_RESEND_DELAYS_MS.length

  /** Fail the next `times` requests matching `matches` with `injected`. */
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

  /**
   * Hold back the next lifecycle probe the wallet makes: the read that made
   * it returns without its answer, and `answer` delivers it later, as a
   * slow explorer would, after newer probes have answered.
   */
  function holdNextProbe(wallet: WalletController) {
    let deliver: (state: 'confirmed' | 'pending' | 'gone') => void = () => undefined
    vi.spyOn(wallet as any, 'qbitTxLifecycleStatusOn').mockImplementationOnce(
      () => new Promise(resolve => (deliver = state => resolve({ state })))
    )
    wallet.qbitRecentSpendProbeWaitMs = 5
    return {
      answer: async (state: 'confirmed' | 'pending' | 'gone') => {
        deliver(state)
        // Let the settlement it queues run.
        await qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, address)
      },
      restoreWait: () => {
        wallet.qbitRecentSpendProbeWaitMs = 2_000
      },
    }
  }

  /** The page `uiPort` builds, signs and broadcasts a 10,000-sat payment. */
  async function send(wallet: WalletController, uiPort: string) {
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 10_000,
      feeRate: 1,
    })
    const signed = await wallet.runForUiPort(uiPort, () => wallet.signPsbtV2(toSignData))
    const claim = signed.qbitSendBroadcastClaim as QbitSendBroadcastClaim
    expect(claim.outpoints).toEqual([{ txid: SPENT.txid, vout: SPENT.vout }])
    const result = await wallet.runForUiPort(uiPort, () =>
      wallet.broadcastQbitTx(signed.psbtHex!, claim, claim.chain, claim.txid)
    )
    return { claim, result, psbtHex: signed.psbtHex! }
  }

  /** What the home balance card and the send screen each count as available. */
  async function available(wallet: WalletController) {
    const balance = await wallet.getAddressBalanceV2(address)
    const snapshot = await wallet.getQbitUtxoSnapshot()
    return {
      balanceCard: balance.availableBalance,
      sendScreen: snapshot.utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0),
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    explorer = new FakeQbitExplorer('esplora')
    explorer.registerAddress(address, accountScript)
    for (const [index, output] of [SPENT, KEPT].entries()) {
      explorer.addTx({
        txid: output.txid,
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [{ address, script: accountScript, value: output.value }],
        height: 100 + index,
      })
    }
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

  it('leaves nothing to reconcile when a re-send gets past a single gateway timeout', async () => {
    const wallet = controller()
    // The gateway times out before the node sees the bytes, once (#356).
    failNext(isBroadcast, { status: 504 })
    const { claim, result } = await send(wallet, 'popup:1')
    expect(result).toMatchObject({ success: true, txid: claim.txid, via: 'broadcast' })
    expect(explorer.requests.filter(isBroadcast)).toHaveLength(2)
    expect(explorer.spenderOf(SPENT.txid, SPENT.vout)?.txid).toBe(claim.txid)

    // No recovery screen: the claim is consumed, the input is spent for both
    // views, and Speed up may replace the payment at once.
    const { balanceCard, sendScreen } = await available(wallet)
    expect(balanceCard).toBe(sendScreen)
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).rejects.toThrow('recent broadcast already spent')
    await expect(
      wallet.runForUiPort('popup:1', () => wallet.signPsbtV2(feeBumpOf(claim.txid)))
    ).resolves.toMatchObject({ qbitSendBroadcastClaim: { origin: 'qbit-wallet' } })
  })

  it('frees the input of a send that never reached the node once its recovery screen is left and probes find it gone', async () => {
    const wallet = controller()
    // The gateway times out before the node sees the bytes, on every attempt.
    failNext(isBroadcast, { status: 504 }, BROADCAST_ATTEMPTS)
    const { claim, result } = await send(wallet, 'popup:1')
    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })

    // The balance card and the send screen agree that the input is held.
    await expect(available(wallet)).resolves.toEqual({
      balanceCard: KEPT.value,
      sendScreen: KEPT.value,
    })

    // The user leaves the recovery screen; the popup, and its port, stay open.
    await wallet.runForUiPort('popup:1', () => wallet.abandonQbitSendBroadcastClaim(claim))

    // The home screen polls the balance. A probe inside the grace period is
    // slow to answer, and one past it answers first: the transaction is
    // gone, and the input comes back for both.
    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    const slow = holdNextProbe(wallet)
    await expect(available(wallet)).resolves.toEqual({
      balanceCard: KEPT.value,
      sendScreen: KEPT.value,
    })
    slow.restoreWait()
    advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await expect(available(wallet)).resolves.toEqual({
      balanceCard: SPENT.value + KEPT.value,
      sendScreen: SPENT.value + KEPT.value,
    })

    // The slow probe's answer lands last, from before the newer one, and
    // changes nothing.
    await slow.answer('pending')
    await expect(available(wallet)).resolves.toEqual({
      balanceCard: SPENT.value + KEPT.value,
      sendScreen: SPENT.value + KEPT.value,
    })

    // A corrected send can spend the input again.
    await expect(send(wallet, 'popup:1')).resolves.toMatchObject({
      result: { success: true, via: 'broadcast' },
    })
  })

  it('lets Speed up sign a bump of a send that landed unseen, while its recovery screen is still open', async () => {
    const wallet = controller()
    // The node takes the bytes but the answer is lost, on every attempt,
    // and the explorer lags the node, so each lookup after one misses too.
    failNext(isBroadcast, 'accept-then-fail', BROADCAST_ATTEMPTS)
    failNext(isStatusLookup, { status: 404 }, BROADCAST_ATTEMPTS)
    const { claim, result } = await send(wallet, 'popup:1')
    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })
    expect(explorer.spenderOf(SPENT.txid, SPENT.vout)?.txid).toBe(claim.txid)

    // The recovery screen stays open in the popup, holding the claim.
    const bump = feeBumpOf(claim.txid)
    await expect(wallet.runForUiPort('tab:2', () => wallet.signPsbtV2(bump))).rejects.toThrow(
      'claimed by an approved send'
    )

    // In a tab, the home screen's balance poll probes the transaction past
    // the grace period; that answer is slow. The next poll's probe finds it
    // pending, which consumes its claim into a recent spend.
    advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    const slow = holdNextProbe(wallet)
    await wallet.runForUiPort('tab:2', () => wallet.getAddressBalanceV2(address))
    slow.restoreWait()
    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    await wallet.runForUiPort('tab:2', () => wallet.getAddressBalanceV2(address))

    // The slow probe's miss, from while the explorer still lagged, lands
    // last and frees nothing: the transaction was found pending since.
    await slow.answer('gone')
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).rejects.toThrow('recent broadcast already spent')

    // Speed up signs: only a replacement of that very transaction may.
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockClear()
    await expect(
      wallet.runForUiPort('tab:2', () => wallet.signPsbtV2(bump))
    ).resolves.toMatchObject({
      qbitSendBroadcastClaim: { txid: bump.qbitBroadcastIdentity!.txid },
    })
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
  })

  it('answers a balance read while a broadcast is held open, with the split unknown', async () => {
    const wallet = controller()
    // The node is slow to answer the POST; every other request is served.
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
    const sending = send(wallet, 'popup:1')
    await postArrived

    // The home screen polls the balance meanwhile. It answers within the
    // guard's bounded wait instead of the broadcast's, without the
    // reservations, so the split is unknown (`--`) rather than late; the
    // total is still measured, and nothing marks the explorer's limit.
    const STILL_WAITING = 'still waiting'
    let read: Awaited<ReturnType<typeof wallet.getAddressBalanceV2>> | typeof STILL_WAITING
    try {
      read = await Promise.race([
        wallet.getAddressBalanceV2(address),
        new Promise<typeof STILL_WAITING>(resolve =>
          setTimeout(() => resolve(STILL_WAITING), 3_000)
        ),
      ])
    } finally {
      // Once the node answers, the send completes.
      answerPost()
    }
    expect(read).toEqual({
      availableBalance: null,
      unavailableBalance: SPENT.value + KEPT.value,
      totalBalance: SPENT.value + KEPT.value,
      immatureBalance: null,
      pendingBalance: null,
      chainType: ChainType.QBIT_REGTEST,
    })

    // And the next read has the split again.
    const { claim, result } = await sending
    expect(result).toMatchObject({ success: true, txid: claim.txid, via: 'broadcast' })
    const { balanceCard, sendScreen } = await available(wallet)
    expect(balanceCard).not.toBeNull()
    expect(balanceCard).toBe(sendScreen)
  })

  it("keeps an unknown outcome when the recovery screen's Retry is rejected by the node", async () => {
    const wallet = controller()
    // The gateway times out on every attempt: whether the node saw the
    // bytes is unknown.
    failNext(isBroadcast, { status: 504 }, BROADCAST_ATTEMPTS)
    const { claim, result, psbtHex } = await send(wallet, 'popup:1')
    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })

    // The recovery screen's Retry is a new call. The node behind the
    // endpoint now rejects the bytes, and the lookup misses them; another
    // node may still hold what the first call sent, so this proves nothing.
    failNext(isBroadcast, {
      status: 400,
      body: 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}',
    })
    const posts = explorer.requests.filter(isBroadcast).length
    const lookups = explorer.requests.filter(isStatusLookup).length
    const retry = await wallet.runForUiPort('popup:1', () =>
      wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)
    )
    expect(retry).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: claim.txid,
      outcome: 'unknown',
      reason: 'rejected',
      lookup: 'gone',
      detail: 'HTTP 400: min relay fee not met',
    })
    // One POST, which the node answered, and one lookup, which could only
    // have found the transaction.
    expect(explorer.requests.filter(isBroadcast).length - posts).toBe(1)
    expect(explorer.requests.filter(isStatusLookup).length - lookups).toBe(1)

    // The recovery screen still holds the claim, and the input stays held
    // for both views.
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).rejects.toThrow('claimed by an approved send')
    await expect(available(wallet)).resolves.toEqual({
      balanceCard: KEPT.value,
      sendScreen: KEPT.value,
    })

    // Leaving the screen on that verdict hands the claim back; the input
    // stays reserved until a probe settles the transaction.
    await wallet.runForUiPort('popup:1', () => wallet.abandonQbitSendBroadcastClaim(claim))
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).rejects.toThrow('recent broadcast already spent')
    await expect(available(wallet)).resolves.toEqual({
      balanceCard: KEPT.value,
      sendScreen: KEPT.value,
    })
  })

  it('lets Speed up sign a bump once the recovery screen of a send that landed is left', async () => {
    const wallet = controller()
    failNext(isBroadcast, 'accept-then-fail', BROADCAST_ATTEMPTS)
    failNext(isStatusLookup, { status: 404 }, BROADCAST_ATTEMPTS)
    const { claim, result } = await send(wallet, 'popup:1')
    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })

    await wallet.runForUiPort('popup:1', () => wallet.abandonQbitSendBroadcastClaim(claim))
    await expect(
      wallet.runForUiPort('popup:1', () => wallet.signPsbtV2(feeBumpOf(claim.txid)))
    ).resolves.toMatchObject({ qbitSendBroadcastClaim: { origin: 'qbit-wallet' } })
  })
})
