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
import { KeyringType, type QbitSendBroadcastClaim } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { QBIT_WALLET_SEND_CLAIM_ORIGIN } from '../src/services/qbitSendGuards'
import {
  QBIT_BROADCAST_ABSENCE_PROBES,
  QBIT_BROADCAST_DEADLINE_MS,
  QBIT_BROADCAST_MIN_PASS_MS,
  QBIT_BROADCAST_RESEND_DELAYS_MS,
  QBIT_BROADCAST_RESEND_WINDOW_MS,
  qbitBroadcastDeadlineMs,
  qbitBroadcastMinPassMs,
  qbitBroadcastResendWindowMs,
} from '../src/utils/qbit-broadcast'
import { QBIT_FEE_BUMP_RECHECK_WAVE_MS } from '../src/utils/qbit-fee-bump-recheck'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The send guard is the real service, and the explorer and its node a fake
// served over fetch, so every broadcast goes through the real
// `@qbit-oss/api` client's `broadcastTx` and its error classification
// before the wallet reaches its verdict (#356).
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
    sessionService: {},
    contactBookService: {},
    permissionService: {},
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

const SOURCE_TXID = fakeTxid(1)
const SOURCE = { txid: SOURCE_TXID, vout: 0 }
const HTML_BODY = '<html><body>502 Bad Gateway</body></html>'

const pubkeyHex = '11'.repeat(32)
const pubkey = hexToBytes(pubkeyHex)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const script = p2mrScriptPubKey(leafHash)
const address = p2mrAddressFromPubkey(pubkey, 'regtest')

/**
 * A payment of the funding output back to the account, as the keyring signs
 * it; with `inputs`, of that many 50,000-sat outputs of `sourceTxid`.
 */
function payment(inputs = 1, sourceTxid = SOURCE_TXID) {
  const psbt = createP2mrPsbt({
    inputs: Array.from({ length: inputs }, (_, vout) => ({
      prevout: { txid: hexToBytes(sourceTxid).reverse(), vout },
      witnessUtxo: { value: 50_000n, scriptPubKey: script },
      leafScript,
      controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
      merkleRoot: leafHash,
    })),
    outputs: [{ value: BigInt(inputs * 50_000 - 10_000 * inputs), scriptPubKey: script }],
  })
  const signing = signP2mrPsbt({
    psbt,
    keys: Array.from({ length: inputs }, (_, inputIndex) => ({ inputIndex, pubkey, leafHash })),
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
  })
  const finalized = finalizeP2mrPsbt(signing.psbt)
  const rawTx = extractP2mrTransaction(finalized)
  return {
    unsignedPsbtHex: bytesToHex(serializePsbt(psbt)),
    signing,
    psbtHex: bytesToHex(serializePsbt(finalized)),
    rawTxHex: bytesToHex(rawTx),
    txid: transactionCore.Transaction.fromBuffer(Buffer.from(rawTx)).getId(),
  }
}

const fixture = payment()

// The largest standard payment: 106 inputs, about 800 kB of hex (see
// `QBIT_MAX_STANDARD_TX_WEIGHT`), which takes more than 15 s to upload
// below about 430 kbit/s.
const LARGE_SOURCE_TXID = fakeTxid(3)
const LARGE_INPUTS = 106
const largeFixture = payment(LARGE_INPUTS, LARGE_SOURCE_TXID)

/**
 * What the node, or a gateway in front of it, does with the next POST:
 * take the bytes and answer as the node does (`accept`), take them and
 * never answer, so the client's own attempt timer fires (`accept-then-hang`),
 * or answer `status` and `body`, after taking the bytes when `accepted`.
 * With `uploadMs` the bytes take that long to go out, as over a slow uplink,
 * and the node then takes them; `Infinity` is an upload that stalls.
 */
type PostOutcome =
  | 'accept'
  | 'accept-then-hang'
  | { status: number; body: string; accepted?: boolean }
  | { uploadMs: number }

describe('WalletController broadcasts through the real API client (#356)', () => {
  let explorer: FakeQbitExplorer
  /** Scripted outcomes for the next POSTs, in order; then `accept`. */
  let postOutcomes: PostOutcome[]
  /** The body of every POST, in order. */
  let posts: string[]
  /** Called on every lifecycle lookup the wallet makes, before it is answered. */
  let onLookup: (() => void | Promise<void>) | undefined

  const isLookup = (path: string) => /^\/tx\/[0-9a-f]{64}(?:\/status)?$/.test(path)
  const isStatusLookup = (path: string) => /^\/tx\/[0-9a-f]{64}\/status$/.test(path)
  const statusLookups = () => explorer.requests.filter(({ path }) => isStatusLookup(path)).length

  /** Answer the next `times` status lookups 404, as an explorer lagging the node does. */
  function lagNextLookups(times = 1) {
    let left = times
    explorer.failures.push(({ path }) => {
      if (left === 0 || !isStatusLookup(path)) return undefined
      left -= 1
      return { status: 404, body: 'Transaction not found' }
    })
  }

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    if (init?.method === 'POST' && url.pathname === '/tx') {
      posts.push(String(init.body))
      const outcome = postOutcomes.shift() ?? 'accept'
      if (outcome === 'accept') return explorer.fetch(input, init)
      if (outcome === 'accept-then-hang') {
        await explorer.fetch(input, init)
        const signal = init.signal!
        return new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if ('uploadMs' in outcome) {
        // `fetch` resolves only once the body has gone out, or rejects on abort.
        const signal = init.signal!
        await new Promise<void>((resolve, reject) => {
          const timer = Number.isFinite(outcome.uploadMs)
            ? setTimeout(resolve, outcome.uploadMs)
            : undefined
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(signal.reason)
            },
            { once: true }
          )
        })
        return explorer.fetch(input, init)
      }
      if (outcome.accepted) await explorer.fetch(input, init)
      return new Response(outcome.body, { status: outcome.status })
    }
    if (isLookup(url.pathname)) await onLookup?.()
    return explorer.fetch(input, init)
  }

  function controller() {
    vi.stubGlobal('fetch', fetchFn)
    const wallet = new WalletController()
    wallet.qbitBroadcastProbeDelayMs = 0
    // As many re-sends as in production, without the pauses.
    wallet.qbitBroadcastResendDelaysMs = QBIT_BROADCAST_RESEND_DELAYS_MS.map(() => 0)
    return wallet
  }

  /** Sign the fixture as the wallet's own send, which mints its claim. */
  async function signWalletSend(wallet: WalletController, signedPayment = fixture) {
    const account = {
      type: KeyringType.QbitHdKeyring,
      address,
      pubkey: pubkeyHex,
      key: 'account-0',
      flag: 0,
      index: 0,
    }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValueOnce(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValueOnce({
      psbt: signedPayment.signing.psbt,
      signed: signedPayment.signing.signed,
      counterResults: [],
    } as any)
    const signed = await wallet.signPsbtV2({
      psbtHex: signedPayment.unsignedPsbtHex,
      toSignInputs: [],
      qbitP2mrSigningKeys: signedPayment.signing.signed.map(({ inputIndex }) => ({
        inputIndex,
        publicKey: pubkeyHex,
        leafHash: bytesToHex(leafHash),
      })),
      qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: signedPayment.txid },
    })
    const claim = signed.qbitSendBroadcastClaim as QbitSendBroadcastClaim
    expect(claim).toMatchObject({
      origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
      txid: signedPayment.txid,
    })
    return { psbtHex: signed.psbtHex!, claim }
  }

  /** Sign and broadcast the fixture as the confirm screen does. */
  async function send(wallet: WalletController, signedPayment = fixture) {
    const { psbtHex, claim } = await signWalletSend(wallet, signedPayment)
    const result = await wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)
    return { psbtHex, claim, result }
  }

  /**
   * Run `call` with timers on a fake clock that moves on while it waits, so
   * the client's attempt timer fires on a POST the node never answers
   * without the real wait.
   */
  async function withAttemptTimers<T>(call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const result = call()
      result.then(
        () => (settled = true),
        () => (settled = true)
      )
      while (!settled) await vi.advanceTimersByTimeAsync(1_000)
      return await result
    } finally {
      vi.useRealTimers()
    }
  }

  /** The claim still holds the input: the outcome is open, and a same-byte retry may follow. */
  const expectClaimHeld = () =>
    expect(qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [SOURCE])).rejects.toThrow(
      'claimed by an approved send'
    )
  /** The claim was consumed and the input stays reserved as recently spent. */
  const expectSpentNotClaimed = () =>
    expect(qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [SOURCE])).rejects.toThrow(
      'recent broadcast already spent'
    )

  beforeEach(async () => {
    vi.clearAllMocks()
    explorer = new FakeQbitExplorer('esplora')
    explorer.registerAddress(address, bytesToHex(script))
    explorer.addTx({
      txid: SOURCE_TXID,
      inputs: [{ txid: fakeTxid(1, 5_000_000), vout: 0 }],
      outputs: [{ address, script: bytesToHex(script), value: 50_000 }],
      height: 100,
    })
    explorer.addTx({
      txid: LARGE_SOURCE_TXID,
      inputs: [{ txid: fakeTxid(3, 5_000_000), vout: 0 }],
      outputs: Array.from({ length: LARGE_INPUTS }, () => ({
        address,
        script: bytesToHex(script),
        value: 50_000,
      })),
      height: 101,
    })
    postOutcomes = []
    posts = []
    onLookup = undefined
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await qbitSendGuardService.resetAllData()
  })

  it('sends the same bytes again after a 502 the node never saw, and reports the send that lands', async () => {
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]

    const { result } = await send(wallet)

    expect(result).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(posts).toEqual([fixture.rawTxHex, fixture.rawTxHex])
    // The lookup in between reconciled the first attempt by txid.
    expect(statusLookups()).toBe(1)
    expect(explorer.txs.has(fixture.txid)).toBe(true)
    await expectSpentNotClaimed()
  })

  it('reconciles a timeout after the node took the bytes by txid, and sends nothing again', async () => {
    const wallet = controller()
    postOutcomes = ['accept-then-hang']

    const { result } = await withAttemptTimers(() => send(wallet))

    expect(result).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    expect(posts).toHaveLength(1)
    await expectSpentNotClaimed()
  })

  it('sends again after a timeout the lagging explorer cannot confirm, and the node, already holding the transaction, answers with its txid', async () => {
    const wallet = controller()
    postOutcomes = ['accept-then-hang']
    // The explorer has not caught up with the node yet.
    lagNextLookups()

    const { result } = await withAttemptTimers(() => send(wallet))

    expect(result).toMatchObject({ success: true, txid: fixture.txid, via: 'broadcast' })
    expect(posts).toEqual([fixture.rawTxHex, fixture.rawTxHex])
    // One transaction, whichever attempt the node took it from.
    expect([...explorer.txs.keys()].filter(txid => txid === fixture.txid)).toHaveLength(1)
    expect(explorer.spenderOf(SOURCE_TXID, 0)?.txid).toBe(fixture.txid)
    await expectSpentNotClaimed()
  })

  it.each([
    ['took the bytes', true, 'lookup', 1],
    ['never saw the bytes', false, 'broadcast', 2],
  ] as const)(
    'settles a 200 whose body is not a txid when the node %s',
    async (_label, accepted, via, attempts) => {
      const wallet = controller()
      postOutcomes = [{ status: 200, body: '<html>OK</html>', accepted }]

      const { result } = await send(wallet)

      expect(result).toEqual({
        success: true,
        chain: ChainType.QBIT_REGTEST,
        txid: fixture.txid,
        via,
      })
      expect(posts).toHaveLength(attempts)
      expect(statusLookups()).toBe(1)
      await expectSpentNotClaimed()
    }
  )

  it.each([
    [
      'an esplora relay',
      400,
      'sendrawtransaction RPC error: {"code":-27,"message":"txn-already-in-mempool"}',
    ],
    [
      'the node JSON-RPC envelope',
      500,
      '{"result":null,"error":{"code":-27,"message":"Transaction already in block chain"},"id":1}',
    ],
  ])(
    'counts "already in mempool" (-27) from %s as success, with no lookup and no re-send',
    async (_label, status, body) => {
      const wallet = controller()
      postOutcomes = [{ status, body }]

      const { result } = await send(wallet)

      expect(result).toEqual({
        success: true,
        chain: ChainType.QBIT_REGTEST,
        txid: fixture.txid,
        via: 'broadcast',
      })
      expect(posts).toHaveLength(1)
      expect(statusLookups()).toBe(0)
      await expectSpentNotClaimed()
    }
  )

  it('keeps an outcome that stays unknown through every re-send open, for a same-byte retry', async () => {
    const wallet = controller()
    const gatewayDown = { status: 502, body: HTML_BODY }
    postOutcomes = [gatewayDown, gatewayDown, gatewayDown]

    const { psbtHex, claim, result } = await send(wallet)

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'server',
      lookup: 'gone',
      detail: 'unknown_outcome HTTP 502',
    })
    // The first attempt and two re-sends, each looked up first.
    expect(posts).toEqual([fixture.rawTxHex, fixture.rawTxHex, fixture.rawTxHex])
    expect(statusLookups()).toBe(3)
    await expectClaimHeld()

    // The recovery screen retries the retained bytes once the gateway is back.
    await expect(
      wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: true, via: 'broadcast' })
    await expectSpentNotClaimed()
  })

  it.each([
    ['a wallet send', (wallet: WalletController) => send(wallet).then(({ result }) => result)],
    [
      "a dapp's push (#268)",
      (wallet: WalletController) => wallet.broadcastQbitProviderTx(fixture.psbtHex),
    ],
  ])(
    "stops at the node's verdict on a re-send of %s, which never turns the earlier unknown outcome into not_sent",
    async (_label, broadcast) => {
      const wallet = controller()
      postOutcomes = [
        { status: 502, body: HTML_BODY },
        {
          status: 400,
          body: 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}',
        },
      ]

      const result = await broadcast(wallet)

      // The first attempt may have reached another node behind the endpoint
      // than the one rejecting the re-send, so absence is never proven here:
      // one lookup, which could only have found it.
      expect(result).toEqual({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: fixture.txid,
        outcome: 'unknown',
        reason: 'rejected',
        lookup: 'gone',
        detail: 'HTTP 400: min relay fee not met',
      })
      expect(posts).toHaveLength(2)
      expect(statusLookups()).toBe(2)
    }
  )

  it('proves absence after a node verdict on the first attempt, as before', async () => {
    const wallet = controller()
    postOutcomes = [
      {
        status: 400,
        body: 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}',
      },
    ]

    const { result } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'not_sent', lookup: 'gone' })
    expect(posts).toHaveLength(1)
    expect(statusLookups()).toBe(QBIT_BROADCAST_ABSENCE_PROBES)
  })

  it('sends nothing again once the claim for those bytes is no longer held', async () => {
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    const { psbtHex, claim } = await signWalletSend(wallet)
    // The claim is released while the first attempt is being looked up.
    onLookup = async () => {
      onLookup = undefined
      await qbitSendGuardService.releaseBroadcastClaim(claim)
    }

    const result = await wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)

    // The first attempt's unknown outcome stands, never a "not sent".
    expect(result).toMatchObject({
      success: false,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'server',
      lookup: 'gone',
    })
    expect(posts).toHaveLength(1)
    // Looked up again on the refusal: a claim gone is what a landing leaves.
    expect(statusLookups()).toBe(2)
  })

  it('reports the send a lookup finds once its claim was consumed between attempts', async () => {
    const wallet = controller()
    // The node took the first attempt, whose answer was lost, and the
    // explorer lags it: the wallet's lookup misses, but a status check from
    // another page finds the transaction meanwhile and consumes the claim.
    postOutcomes = [{ status: 502, body: HTML_BODY, accepted: true }]
    const { psbtHex, claim } = await signWalletSend(wallet)
    onLookup = async () => {
      onLookup = undefined
      await expect(
        wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST, claim)
      ).resolves.toMatchObject({ found: true, state: 'pending' })
      // The wallet's own lookup, answered next, still misses it.
      lagNextLookups()
    }

    const result = await wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)

    expect(result).toMatchObject({ success: true, txid: fixture.txid, via: 'lookup' })
    expect(posts).toHaveLength(1)
    await expectSpentNotClaimed()
  })

  it('starts no re-send once the window since the first dispatch has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    // The first attempt took the whole window, a little longer than
    // `QBIT_BROADCAST_RESEND_WINDOW_MS` for the fixture's upload.
    onLookup = () => {
      onLookup = undefined
      vi.setSystemTime(Date.now() + qbitBroadcastResendWindowMs(fixture.rawTxHex))
    }

    const { result } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })
    expect(posts).toHaveLength(1)
    await expectClaimHeld()
  })

  it('does not pause for a re-send that would start past the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const wallet = controller()
    wallet.qbitBroadcastResendDelaysMs = [5_000]
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    // The first attempt took all but a second of the window, less than
    // the pause before the re-send.
    onLookup = () => {
      onLookup = undefined
      vi.setSystemTime(Date.now() + qbitBroadcastResendWindowMs(fixture.rawTxHex) - 1_000)
    }

    const { result } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })
    expect(posts).toHaveLength(1)
    expect(statusLookups()).toBe(1)
    await expectClaimHeld()
  })

  it("starts no re-send the guard's queue held past the window", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    // The re-send is due when it is queued, but other work holds the
    // guard's queue until the window has passed.
    const queue = qbitSendGuardService.broadcastIfAllowed.bind(qbitSendGuardService)
    let queued = 0
    const spy = vi
      .spyOn(qbitSendGuardService, 'broadcastIfAllowed')
      .mockImplementation((...args: Parameters<typeof queue>) => {
        queued += 1
        if (queued === 2) {
          vi.setSystemTime(Date.now() + qbitBroadcastResendWindowMs(fixture.rawTxHex))
        }
        return queue(...args)
      })

    try {
      const { result } = await send(wallet)

      expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })
      expect(queued).toBe(2)
      expect(posts).toHaveLength(1)
      // Looked up again on the refusal, as for any refused re-send.
      expect(statusLookups()).toBe(2)
      await expectClaimHeld()
    } finally {
      spy.mockRestore()
    }
  })

  it('sends nothing again when the lookup cannot run', async () => {
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    explorer.failures.push(({ path }) => (isLookup(path) ? { status: 400 } : undefined))

    const { result } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'unavailable' })
    expect(posts).toHaveLength(1)
    await expectClaimHeld()
  })

  it('sends nothing again once the wallet switched networks after the first attempt', async () => {
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    onLookup = () => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    }

    const { result } = await send(wallet)

    expect(result).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'server',
      lookup: 'gone',
    })
    expect(posts).toHaveLength(1)
  })

  it('never sends again on a refused redirect', async () => {
    const wallet = controller()
    postOutcomes = [{ status: 307, body: '' }]

    const { result } = await send(wallet)

    expect(result).toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })
    expect(posts).toHaveLength(1)
  })

  describe('a large transaction over a slow uplink (#130)', () => {
    /**
     * Run `call` on a fake clock, the deadline's included, that moves on
     * while it waits; resolves to its result and the time it took.
     */
    async function onFakeClock<T>(call: () => Promise<T>) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      try {
        const startedAt = Date.now()
        let settled = false
        const result = call()
        result.then(
          () => (settled = true),
          () => (settled = true)
        )
        while (!settled) await vi.advanceTimersByTimeAsync(1_000)
        return { value: await result, elapsedMs: Date.now() - startedAt }
      } finally {
        vi.useRealTimers()
      }
    }

    const largeInput = { txid: LARGE_SOURCE_TXID, vout: 0 }

    it('gives a re-send the time its upload takes, as the first attempt has', async () => {
      const wallet = controller()
      const passMs = qbitBroadcastMinPassMs(largeFixture.rawTxHex)
      expect(largeFixture.rawTxHex.length).toBeGreaterThan(790_000)
      expect(passMs).toBeGreaterThan(60_000)
      // The gateway drops the first attempt before the node sees it. The
      // re-send then takes 40 s to go out, longer than a small reply's budget.
      postOutcomes = [{ status: 502, body: HTML_BODY }, { uploadMs: 40_000 }]

      const { value, elapsedMs } = await onFakeClock(() => send(wallet, largeFixture))

      expect(value.result).toEqual({
        success: true,
        chain: ChainType.QBIT_REGTEST,
        txid: largeFixture.txid,
        via: 'broadcast',
      })
      expect(posts).toEqual([largeFixture.rawTxHex, largeFixture.rawTxHex])
      expect(elapsedMs).toBeGreaterThanOrEqual(40_000)
      expect(elapsedMs).toBeLessThan(passMs)
      expect(explorer.spenderOf(LARGE_SOURCE_TXID, 0)?.txid).toBe(largeFixture.txid)
      await expect(
        qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [largeInput])
      ).rejects.toThrow('recent broadcast already spent')
    })

    it('sends again after a timeout at the end of its upload budget that the lagging explorer cannot confirm', async () => {
      const wallet = controller()
      wallet.qbitBroadcastResendDelaysMs = [...QBIT_BROADCAST_RESEND_DELAYS_MS]
      const passMs = qbitBroadcastMinPassMs(largeFixture.rawTxHex)
      // The gateway takes the bytes and never answers, so the first attempt
      // times out at the end of its budget, past the fixed window.
      postOutcomes = ['accept-then-hang']
      // The explorer has not caught up with the node yet.
      lagNextLookups()
      expect(passMs).toBeGreaterThan(QBIT_BROADCAST_RESEND_WINDOW_MS)
      expect(passMs).toBeLessThan(qbitBroadcastResendWindowMs(largeFixture.rawTxHex))

      const { value, elapsedMs } = await onFakeClock(() => send(wallet, largeFixture))

      expect(value.result).toMatchObject({
        success: true,
        txid: largeFixture.txid,
        via: 'broadcast',
      })
      expect(posts).toEqual([largeFixture.rawTxHex, largeFixture.rawTxHex])
      expect(elapsedMs).toBeGreaterThanOrEqual(passMs)
      // One transaction, whichever attempt the node took it from.
      expect(explorer.spenderOf(LARGE_SOURCE_TXID, 0)?.txid).toBe(largeFixture.txid)
      await expect(
        qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [largeInput])
      ).rejects.toThrow('recent broadcast already spent')
    })

    it('ends uploads that stall within their budgets as unknown after one re-send, with time left for the lookup', async () => {
      const wallet = controller()
      wallet.qbitBroadcastResendDelaysMs = [...QBIT_BROADCAST_RESEND_DELAYS_MS]
      const passMs = qbitBroadcastMinPassMs(largeFixture.rawTxHex)
      postOutcomes = [
        { uploadMs: Number.POSITIVE_INFINITY },
        { uploadMs: Number.POSITIVE_INFINITY },
      ]

      const { value, elapsedMs } = await onFakeClock(() => send(wallet, largeFixture))

      expect(value.result).toMatchObject({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: largeFixture.txid,
        outcome: 'unknown',
        reason: 'timeout',
        // The deadline left the lookup after the second stall its time: it
        // missed the bytes, rather than running out.
        lookup: 'gone',
      })
      // Each attempt was cut off once its budget was spent. The second ended
      // past the window, so there was no third.
      expect(posts).toEqual([largeFixture.rawTxHex, largeFixture.rawTxHex])
      expect(elapsedMs).toBeGreaterThanOrEqual(2 * passMs)
      expect(elapsedMs).toBeLessThan(qbitBroadcastDeadlineMs(largeFixture.rawTxHex))
      expect(statusLookups()).toBe(2)
      expect(explorer.txs.has(largeFixture.txid)).toBe(false)
      await expect(
        qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [largeInput])
      ).rejects.toThrow('claimed by an approved send')
    })

    /**
     * Retry the large fixture's send after the background restarted: the
     * guard forgot the claim the page still holds. While the lookup its
     * refusal calls for runs, another send takes the guard's queue for
     * `holdMs`, and restoring the claim waits for it, and so does the pass
     * after that: the call's deadline started with the refusal.
     */
    async function retryAfterRestart(wallet: WalletController, holdMs: number) {
      const { psbtHex, claim } = await signWalletSend(wallet, largeFixture)
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ address } as any)
      qbitSendGuardService.init()
      onLookup = () => {
        onLookup = undefined
        void qbitSendGuardService.runWithNoOverlap(
          ChainType.QBIT_REGTEST,
          [{ txid: fakeTxid(9), vout: 0 }],
          () => new Promise<void>(resolve => setTimeout(resolve, holdMs))
        )
      }
      return onFakeClock(() => wallet.broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid))
    }

    it('sends it after a long wait behind another send: its deadline has room for its upload as well', async () => {
      const wallet = controller()
      // Past what a small transaction's deadline would leave its pass.
      const holdMs = 80_000
      expect(QBIT_BROADCAST_DEADLINE_MS - holdMs).toBeLessThan(
        qbitBroadcastMinPassMs(largeFixture.rawTxHex)
      )

      const { value: result } = await retryAfterRestart(wallet, holdMs)

      expect(result).toEqual({
        success: true,
        chain: ChainType.QBIT_REGTEST,
        txid: largeFixture.txid,
        via: 'broadcast',
      })
      expect(posts).toEqual([largeFixture.rawTxHex])
      // The restored claim's explorer check read what spends its inputs, twice.
      expect(
        explorer.requests.filter(({ path }) =>
          path.startsWith(`/tx/${LARGE_SOURCE_TXID}/outspends`)
        )
      ).toHaveLength(2)
    })

    it("sends nothing when a pass is due with less left than its upload needs, though more than a small reply's budget", async () => {
      const wallet = controller()
      const leftMs = qbitBroadcastMinPassMs(largeFixture.rawTxHex) - 10_000
      expect(leftMs).toBeGreaterThan(3 * QBIT_BROADCAST_MIN_PASS_MS)

      const { value: result } = await retryAfterRestart(
        wallet,
        qbitBroadcastDeadlineMs(largeFixture.rawTxHex) - leftMs
      )

      // Sent, it could have been cut off by the deadline before its upload ended.
      expect(posts).toHaveLength(0)
      expect(result).toMatchObject({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: largeFixture.txid,
        outcome: 'not_sent',
        reason: 'timeout',
      })
    })

    it('refuses its explorer check before any read when the check would leave less than its upload needs', async () => {
      const wallet = controller()
      // Enough for the check and a small transaction's submission, not for
      // this one's: the check pauses 5 s between its rounds.
      const leftMs = qbitBroadcastMinPassMs(largeFixture.rawTxHex) + 3_000
      expect(leftMs).toBeGreaterThan(
        QBIT_BROADCAST_MIN_PASS_MS + 2 * QBIT_FEE_BUMP_RECHECK_WAVE_MS + 10_000
      )

      const { value: result } = await retryAfterRestart(
        wallet,
        qbitBroadcastDeadlineMs(largeFixture.rawTxHex) - leftMs
      )

      // The restored claim's check read nothing, so it held the guard's
      // queue for no longer than the refusal took.
      const outspendsReads = explorer.requests.filter(({ path }) =>
        path.startsWith(`/tx/${LARGE_SOURCE_TXID}/outspends`)
      )
      expect(outspendsReads).toHaveLength(0)
      expect(posts).toHaveLength(0)
      expect(result).toMatchObject({
        success: false,
        txid: largeFixture.txid,
        outcome: 'not_sent',
        reason: 'timeout',
      })
    })
  })

  it("follows the same rule for a dapp's push (#268)", async () => {
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]

    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(posts).toEqual([fixture.rawTxHex, fixture.rawTxHex])
    expect(statusLookups()).toBe(1)
  })

  it("sends a dapp's push again only while nothing else holds its inputs", async () => {
    const wallet = controller()
    postOutcomes = [{ status: 502, body: HTML_BODY }]
    // The user signs a send over the same input while the push is being
    // looked up, which claims it.
    onLookup = async () => {
      onLookup = undefined
      await signWalletSend(wallet)
    }

    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toMatchObject({
      success: false,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'server',
      lookup: 'gone',
    })
    expect(posts).toHaveLength(1)
    expect(statusLookups()).toBe(2)
    await expectClaimHeld()
  })

  it("reports a dapp's push whose re-send was refused as sent once a lookup finds it", async () => {
    const wallet = controller()
    // The node took the push, but the answer was lost and the explorer
    // lagged the lookup right after it, during which the inputs were claimed.
    postOutcomes = [{ status: 502, body: HTML_BODY, accepted: true }]
    lagNextLookups()
    onLookup = async () => {
      onLookup = undefined
      await signWalletSend(wallet)
    }

    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    expect(posts).toHaveLength(1)
  })
})
