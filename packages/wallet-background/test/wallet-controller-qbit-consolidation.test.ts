import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  bytesToHex,
  decodePsbt,
  extractP2mrTransaction,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import {
  KeyringType,
  QBIT_MAX_FEE_RATE,
  QBIT_MAX_STANDARD_TX_WEIGHT,
  QBIT_MIN_RELAY_FEE_RATE,
  estimateQbitP2mrTransaction,
  isQbitStandardTxSize,
  type QbitConsolidationRequest,
  type ToSignData,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { QBIT_CONSOLIDATION_BATCH_DEADLINE_MS, WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { FakeQbitExplorer, fakeTxid, type FakeTx } from './qbit-fake-explorer'

// The send guard is the real service, so reservations, claims and recent
// spends between batches come from production logic. The explorer is a fake
// served over fetch, so the real clients page, retry and classify errors.
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      signP2mrPsbtWithCounter: vi.fn(),
      preflightP2mrPsbtSigning: vi.fn(),
      memStore: { getState: () => ({ isUnlocked: true }) },
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

function p2mrAccount(pubkeyHex = '11'.repeat(32)) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const scriptPubKey = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey: pubkeyHex,
    address: p2mrAddressFromPubkey(pubkey, 'regtest'),
    key: 'account-0',
    flag: 0,
    index: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: `m/87'/1'/0'/0/0`,
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: { regtest: p2mrAddressFromPubkey(pubkey, 'regtest') },
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
}

const account = p2mrAccount()
const payer = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')
const payerScript = `5220${'33'.repeat(32)}`
const SIGNATURE_BUDGET = {
  required: 106,
  cached: 0,
  remainingBefore: 1_000_000,
  remainingAfter: 999_894,
  limit: 1_073_741_824,
}

/**
 * An account paid 700 times, values shuffled against block order so the
 * newest pages do not simply hold the largest outputs. The newest output is
 * an immature coinbase reward, and one of the largest recent ones is already
 * spent by a mempool transaction that Esplora's confirmed pages do not show.
 */
function overLimitAccount(funded = 700, surface: 'esplora' | 'mempool-qbit' = 'esplora') {
  const explorer = new FakeQbitExplorer(surface)
  explorer.registerAddress(account.address, account.p2mr.scriptPubKey)
  const funding: FakeTx[] = []
  for (let index = 0; index < funded; index += 1) {
    funding.push(
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [
          {
            address: account.address,
            script: account.p2mr.scriptPubKey,
            value: 20_000 + ((index * 37) % funded) * 10,
          },
          { address: payer, script: payerScript, value: 1_000 },
        ],
        height: 100 + index,
      })
    )
  }
  const immature = explorer.addTx({
    txid: fakeTxid(funded, 9),
    inputs: [],
    outputs: [{ address: account.address, script: account.p2mr.scriptPubKey, value: 9_000_000 }],
    coinbase: true,
    height: explorer.tipHeight - 5,
  })
  // The largest of the newest outputs, which the first batch reads, spent
  // by a payment still in the mempool.
  const largest = funding
    .slice(-100)
    .reduce((best, tx) => (tx.outputs[0]!.value > best.outputs[0]!.value ? tx : best))
  const pendingSpend = explorer.addTx({
    txid: fakeTxid(1, 7_000_000),
    inputs: [{ txid: largest.txid, vout: 0 }],
    outputs: [{ address: payer, script: payerScript, value: 30_000 }],
  })
  return { explorer, funding, immature, largest, pendingSpend }
}

function inputsOf(toSignData: ToSignData): string[] {
  return decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex))).inputs.map(
    input => `${bytesToHex(new Uint8Array(input.prevout.txid).reverse())}:${input.prevout.vout}`
  )
}

const isHistoryPage = ({ path }: { path: string }) => /\/txs(\/chain|\?|$)/.test(path)
const MB = 1024 * 1024

/**
 * The account's first history page, about 30 MB as a page of large
 * consolidations would be, at about 1 Mbit/s: four minutes, longer than a
 * batch used to be allowed, within the large-read ceiling.
 */
function firstPageAtOneMegabit() {
  let pages = 0
  return {
    match: (request: { method: string; path: string }) => isHistoryPage(request) && ++pages === 1,
    chunkBytes: 128 * 1024,
    intervalMs: 1_000,
    padToBytes: 30 * MB,
  }
}
const pageRequests = (explorer: FakeQbitExplorer) => explorer.requests.filter(isHistoryPage).length

/** Advance fake time until `promise` settles; resolves to its outcome and the time it took. */
async function settle<T>(promise: Promise<T>, stepMs = 100, maxMs = 30 * 60_000) {
  const startedAt = Date.now()
  let outcome: { value: T } | { error: unknown } | undefined
  promise.then(
    value => (outcome = { value }),
    error => (outcome = { error })
  )
  while (outcome === undefined && Date.now() - startedAt < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  if (outcome === undefined) throw new Error(`still pending after ${maxMs}ms`)
  return { ...outcome, elapsedMs: Date.now() - startedAt }
}

async function signBatch(wallet: WalletController, toSignData: ToSignData) {
  return wallet.signPsbtV2(toSignData)
}

describe('WalletController consolidation of an account over the explorer UTXO limit (#277)', () => {
  let explorer: FakeQbitExplorer

  function controller(options: { now?: () => number } = {}) {
    vi.stubGlobal('fetch', explorer.fetch)
    const wallet = new WalletController(options)
    wallet.qbitBroadcastProbeDelayMs = 0
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    return wallet
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(SIGNATURE_BUDGET)
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address: string, { psbt, keys }: any) => {
        const signed = signP2mrPsbt({
          psbt,
          keys,
          sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
        })
        return { psbt: signed.psbt, signed: signed.signed, counterResults: [] } as any
      }
    )
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await qbitSendGuardService.resetAllData()
  })

  it('builds a standard batch of the largest mature unspent outputs, paid back to the account', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()

    const status = await wallet.getQbitConsolidationStatus()
    expect(status).toMatchObject({
      address: account.address,
      confirmedUnspent: 701,
      pendingSpent: 1,
      // As the explorer's 413 states it (#169).
      overLimit: true,
      outputLimit: 500,
      // Within the standard size.
      maxInputCount: 106,
      batchShape: { outputScriptLengths: [34], leafScriptLength: 34, controlBlockLength: 1 },
    })

    const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })

    const inputs = inputsOf(batch)
    expect(inputs).toHaveLength(106)
    // The status's shape prices the batch exactly, as the screen does before
    // preparing one, and keeps it within the standard size.
    const priced = estimateQbitP2mrTransaction({
      ...status.batchShape,
      inputCount: inputs.length,
      feeRate: 1,
    })
    expect(priced).toMatchObject({ vsize: batch.estimatedVsize, fee: batch.estimatedFee })
    expect(isQbitStandardTxSize(priced.vsize)).toBe(true)
    // The immature reward and the output a pending payment spends stay out.
    expect(inputs).not.toContain(`${fixture.immature.txid}:0`)
    expect(inputs).not.toContain(`${fixture.largest.txid}:0`)
    // Largest first among everything the walk has read so far; the walk
    // keeps the rest, and hands the chosen ones out once only.
    const scan = (wallet as any).qbitConsolidationScans.get(
      `${ChainType.QBIT_REGTEST}:${account.address}`
    ).scan
    const valueOf = (key: string) => {
      const [txid, vout] = key.split(':')
      return explorer.txs.get(txid!)!.outputs[Number(vout)]!.value
    }
    const smallestChosen = Math.min(...inputs.map(valueOf))
    for (const key of inputs) expect(scan.candidates.has(key)).toBe(false)
    const passedOver = [...scan.candidates.keys()].filter(
      key =>
        key !== `${fixture.immature.txid}:0` &&
        explorer.spenderOf(key.split(':')[0]!, 0) === undefined
    )
    expect(passedOver.length).toBeGreaterThan(0)
    expect(passedOver.every(key => valueOf(key) <= smallestChosen)).toBe(true)
    // One output, to the account itself, worth the inputs less the fee.
    const decoded = decodePsbt(parsePsbt(hexToBytes(batch.psbtHex)))
    expect(decoded.outputs).toHaveLength(1)
    expect(bytesToHex(decoded.outputs[0]!.scriptPubKey)).toBe(account.p2mr.scriptPubKey)
    const inputTotal = inputs.reduce((sum, key) => sum + valueOf(key), 0)
    expect(batch.qbitConsolidation).toEqual({
      confirmedOutputCount: 701,
      outputLimit: 500,
      amount: inputTotal - batch.estimatedFee!,
      fundingOutputCounts: inputs.map(() => 2),
      maxInputs: 106,
    })
    expect(batch.estimatedFee).toBe(batch.estimatedVsize)
    // The pending spend was caught by the outspends check, not by a balance.
    expect(
      explorer.requests.some(request => request.path === `/tx/${fixture.largest.txid}/outspends`)
    ).toBe(true)
  })

  describe('batch size (#170)', () => {
    // qbit Core's standard size: 106 single-key inputs to one output.
    const MAX_BATCH = 106

    /** `toSignData` signed, and its signed bytes as the explorer parses them. */
    async function signedTransaction(wallet: WalletController, toSignData: ToSignData) {
      const signed = await signBatch(wallet, toSignData)
      const raw = extractP2mrTransaction(parsePsbt(hexToBytes(signed.psbtHex!)))
      return { signed, transaction: transactionCore.Transaction.fromBuffer(Buffer.from(raw)) }
    }

    /** A controller on the mempool-qbit surface, as production broadcasts. */
    function mempoolQbitController() {
      const wallet = controller()
      const { endpoint } = (wallet as any).getQbitApiEndpoint()
      vi.spyOn(wallet as any, 'getQbitApiEndpoint').mockReturnValue({
        endpoint,
        apiSurface: 'mempool-qbit',
      })
      return wallet
    }

    async function broadcast(
      wallet: WalletController,
      toSignData: ToSignData,
      signed: Awaited<ReturnType<typeof signBatch>>
    ) {
      return wallet.broadcastQbitTx(
        signed.psbtHex!,
        signed.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        toSignData.qbitBroadcastIdentity!.txid
      )
    }

    it("sends a full batch of 106 through an explorer with qbit-explorer#58's push check", async () => {
      explorer = overLimitAccount(700, 'mempool-qbit').explorer
      // Explorer 1.1.0: the serialized size with witness over 400,000 is refused.
      explorer.pushWeightLimit = 400_000
      const wallet = mempoolQbitController()

      const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      const { signed, transaction } = await signedTransaction(wallet, batch)

      expect(inputsOf(batch)).toHaveLength(MAX_BATCH)
      expect(batch.qbitConsolidation?.maxInputs).toBe(MAX_BATCH)
      expect(transaction.byteLength()).toBe(398_827)
      expect(transaction.byteLength()).toBe(batch.estimatedVsize)
      expect(transaction.byteLength()).toBeLessThanOrEqual(QBIT_MAX_STANDARD_TX_WEIGHT)
      await expect(broadcast(wallet, batch, signed)).resolves.toMatchObject({
        success: true,
        via: 'broadcast',
      })
      expect(explorer.txs.has(batch.qbitBroadcastIdentity!.txid)).toBe(true)
      expect(explorer.pushedInputCounts).toEqual([MAX_BATCH])
    })

    it('reads a full batch an explorer before 1.1.0 refuses as not sent, frees its inputs, and sends a batch of 102', async () => {
      explorer = overLimitAccount(700, 'mempool-qbit').explorer
      // An explorer not yet updated to 1.1.0: base bytes ×4 plus witness bytes
      // over 400,000 is refused, so 106 inputs (412,024) are.
      explorer.pushWeightLimit = 400_000
      explorer.pushWeightRule = 'base-times-four'
      const wallet = mempoolQbitController()
      const inconclusive = vi.spyOn(qbitSendGuardService, 'recordInconclusiveBroadcast')

      const full = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      const { signed, transaction } = await signedTransaction(wallet, full)
      expect(inputsOf(full)).toHaveLength(MAX_BATCH)
      expect(transaction.weight()).toBe(412_024)

      await expect(broadcast(wallet, full, signed)).resolves.toEqual({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: full.qbitBroadcastIdentity!.txid,
        outcome: 'not_sent',
        reason: 'too_large',
        lookup: 'gone',
        detail: 'HTTP 400: RPC error -3',
      })
      expect(explorer.txs.has(full.qbitBroadcastIdentity!.txid)).toBe(false)
      // Proven absent: never held as possibly spent. The failure screen
      // abandons the bytes, and nothing else holds the inputs.
      expect(inconclusive).not.toHaveBeenCalled()
      await expect(
        wallet.releaseQbitSendBroadcastClaim(signed.qbitSendBroadcastClaim!)
      ).resolves.toBe(true)
      await expect(
        qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, account.address)
      ).resolves.toEqual(new Set())

      // A batch of 102 weighs 396,484 that way and goes through, from the
      // largest of the freed outputs.
      const smaller = await wallet.createQbitConsolidationPsbt({ feeRate: 1, maxInputs: 102 })
      const resent = await signedTransaction(wallet, smaller)
      expect(inputsOf(smaller)).toHaveLength(102)
      expect(inputsOf(full)).toEqual(expect.arrayContaining(inputsOf(smaller)))
      expect(resent.transaction.weight()).toBe(396_484)
      await expect(broadcast(wallet, smaller, resent.signed)).resolves.toMatchObject({
        success: true,
        via: 'broadcast',
      })
      expect(explorer.txs.has(smaller.qbitBroadcastIdentity!.txid)).toBe(true)
      expect(explorer.pushedInputCounts).toEqual([MAX_BATCH, 102])
    })

    describe("sends from more than 106 outputs, through an explorer with qbit-explorer#58's push check", () => {
      /** An account within the listing limit holding 150 outputs, as the explorer lists them. */
      function sendFixture() {
        const fixture = overLimitAccount(150, 'mempool-qbit')
        explorer = fixture.explorer
        explorer.pushWeightLimit = 400_000
        // What the send may spend: every output but the immature reward and
        // the one a pending payment spends, largest first.
        const values = fixture.funding
          .filter(tx => tx.txid !== fixture.largest.txid)
          .map(tx => tx.outputs[0]!.value)
          .sort((a, b) => b - a)
        return { values, wallet: mempoolQbitController() }
      }
      const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

      it('sends the 106 largest on send-all and leaves the rest', async () => {
        const { values, wallet } = sendFixture()
        expect(values).toHaveLength(149)

        const sendAll = await wallet.createSendAllQbitPsbt({ to: payer, feeRate: 1 })
        const { signed, transaction } = await signedTransaction(wallet, sendAll)

        expect(sendAll).toMatchObject({
          inputCount: MAX_BATCH,
          estimatedVsize: 398_827,
          leftBehindInputCount: 149 - MAX_BATCH,
          leftBehindSats: sum(values.slice(MAX_BATCH)),
        })
        expect(transaction.ins).toHaveLength(MAX_BATCH)
        expect(transaction.outs).toHaveLength(1)
        expect(transaction.byteLength()).toBe(398_827)
        await expect(broadcast(wallet, sendAll, signed)).resolves.toMatchObject({
          success: true,
          via: 'broadcast',
        })
        expect(Math.max(...explorer.pushedInputCounts)).toBe(MAX_BATCH)
      })

      it('sends an amount that needs 106 inputs with change, and never builds 107', async () => {
        const { values, wallet } = sendFixture()
        const largest = sum(values.slice(0, MAX_BATCH))
        // The most one transaction sends: the 106 largest, less their fee
        // without change (398,827 bytes at 1 bit/vB). One bit more would need
        // a 107th input, and nothing is built.
        await expect(
          wallet.createSendQbitPsbt({ to: payer, amount: largest - 398_827 + 1, feeRate: 1 })
        ).rejects.toThrow(
          `Amount needs more than 106 inputs, over the standard transaction size; at most ${largest - 398_827} sats can be sent in one transaction.`
        )
        // 106 inputs pay this amount, the fee with change (398,870 bytes),
        // and 10,000 bits of change; 105 could not pay it.
        const amount = largest - 398_870 - 10_000

        const send = await wallet.createSendQbitPsbt({ to: payer, amount, feeRate: 1 })
        const { signed, transaction } = await signedTransaction(wallet, send)

        expect(send).toMatchObject({ inputCount: MAX_BATCH, estimatedVsize: 398_870 })
        expect(transaction.ins).toHaveLength(MAX_BATCH)
        expect(transaction.outs.map(output => Number(output.value))).toEqual([amount, 10_000])
        expect(transaction.byteLength()).toBe(398_870)
        await expect(broadcast(wallet, send, signed)).resolves.toMatchObject({
          success: true,
          via: 'broadcast',
        })
        expect(explorer.pushedInputCounts).toEqual([MAX_BATCH])
      })
    })

    it.each([2, 10, MAX_BATCH])(
      'builds a batch of the %i inputs asked for and records the size',
      async size => {
        const fixture = overLimitAccount()
        explorer = fixture.explorer
        const wallet = controller()

        const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1, maxInputs: size })

        const inputs = inputsOf(batch)
        expect(inputs).toHaveLength(size)
        expect(batch.inputCount).toBe(size)
        expect(batch.qbitConsolidation?.maxInputs).toBe(size)
        // Still the largest of what the walk read.
        const valueOf = (key: string) => {
          const [txid, vout] = key.split(':')
          return explorer.txs.get(txid!)!.outputs[Number(vout)]!.value
        }
        const scan = (wallet as any).qbitConsolidationScans.get(
          `${ChainType.QBIT_REGTEST}:${account.address}`
        ).scan
        const smallestChosen = Math.min(...inputs.map(valueOf))
        const passedOver = [...scan.candidates.keys()].filter(
          key =>
            key !== `${fixture.immature.txid}:0` &&
            explorer.spenderOf(key.split(':')[0]!, 0) === undefined
        )
        expect(passedOver.every(key => valueOf(key) <= smallestChosen)).toBe(true)
      }
    )

    it('takes the maximum when the size is omitted, an explicit undefined included', async () => {
      const fixture = overLimitAccount()
      explorer = fixture.explorer
      const wallet = controller()

      // As a caller inside the background may pass it; over the port the key is dropped.
      const request: { feeRate: number; maxInputs: undefined } = {
        feeRate: 1,
        maxInputs: undefined,
      }
      const batch = await wallet.createQbitConsolidationPsbt(
        request as unknown as QbitConsolidationRequest
      )

      expect(inputsOf(batch)).toHaveLength(MAX_BATCH)
      expect(batch.qbitConsolidation?.maxInputs).toBe(MAX_BATCH)
    })

    it('reads fewer history pages for a smaller batch', async () => {
      explorer = overLimitAccount().explorer
      await controller().createQbitConsolidationPsbt({ feeRate: 1 })
      const fullBatchPages = pageRequests(explorer)

      explorer = overLimitAccount().explorer
      const small = await controller().createQbitConsolidationPsbt({ feeRate: 1, maxInputs: 10 })

      expect(inputsOf(small)).toHaveLength(10)
      // About 25 outputs a page: one page holds ten, a full batch needs five.
      expect(pageRequests(explorer)).toBe(1)
      expect(fullBatchPages).toBeGreaterThanOrEqual(5)
    })

    it.each([
      ['zero', 0],
      ['one input', 1],
      ['one past the maximum', MAX_BATCH + 1],
      ['a fraction', 2.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a negative number', -5],
      ['a numeric string', '5'],
      // What the port's JSON delivers for NaN and ±Infinity: never the maximum.
      ['null', null],
      ['a boolean', true],
      ['an object', { value: 5 }],
    ])('refuses %s as the batch size before any explorer read', async (_label, maxInputs) => {
      explorer = overLimitAccount().explorer
      const wallet = controller()

      // No fee rate either, so even the fee quote would be a read.
      const refusal = await wallet
        .createQbitConsolidationPsbt({ maxInputs: maxInputs as any })
        .catch(error => error)

      expect(refusal).toBeInstanceOf(RangeError)
      expect(refusal.message).toBe(`maxInputs must be a whole number from 2 to ${MAX_BATCH}`)
      expect(explorer.requests).toEqual([])
    })

    it.each([
      // What the port's JSON delivers for NaN and ±Infinity: never the normal rate.
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['zero', 0],
      ['a rate below the relay floor', QBIT_MIN_RELAY_FEE_RATE / 2],
      ['a rate past the ceiling', QBIT_MAX_FEE_RATE + 1],
      ['a numeric string', '2'],
    ])('refuses %s as the fee rate before any explorer read', async (_label, feeRate) => {
      explorer = overLimitAccount().explorer
      const wallet = controller()
      const quote = vi.spyOn(wallet, 'getFeeSummary')

      const refusal = await wallet
        .createQbitConsolidationPsbt({ feeRate: feeRate as any, maxInputs: 10 })
        .catch(error => error)

      expect(refusal).toBeInstanceOf(RangeError)
      expect(refusal.message).toBe(
        `feeRate must be between ${QBIT_MIN_RELAY_FEE_RATE} and ${QBIT_MAX_FEE_RATE} bits/vB`
      )
      expect(quote).not.toHaveBeenCalled()
      expect(explorer.requests).toEqual([])
    })

    it('takes the normal rate only for a fee rate left out, an explicit undefined included', async () => {
      const fixture = overLimitAccount()
      explorer = fixture.explorer
      const wallet = controller()
      const quote = vi.spyOn(wallet, 'getFeeSummary').mockResolvedValue({
        list: [
          { title: 'slow', desc: '', feeRate: 1 },
          { title: 'avg', desc: '', feeRate: 3 },
          { title: 'fast', desc: '', feeRate: 5 },
        ],
      } as any)

      // As a caller inside the background may pass it; over the port the key is dropped.
      const request = { feeRate: undefined, maxInputs: 10 }
      const batch = await wallet.createQbitConsolidationPsbt(
        request as unknown as QbitConsolidationRequest
      )

      expect(quote).toHaveBeenCalledTimes(1)
      expect(inputsOf(batch)).toHaveLength(10)
      // Priced at the normal rate of 3 bits/vB.
      expect(batch.estimatedFee).toBe(batch.estimatedVsize! * 3)
    })

    it('reads a request the port delivers as null as an empty one, and refuses one that is no object', async () => {
      explorer = overLimitAccount().explorer
      const wallet = controller()

      await expect(wallet.createQbitConsolidationPsbt('5' as any)).rejects.toThrow(TypeError)
      await expect(wallet.createQbitConsolidationPsbt([5] as any)).rejects.toThrow(TypeError)
      expect(explorer.requests).toEqual([])

      const batch = await wallet.createQbitConsolidationPsbt(null as any)
      expect(inputsOf(batch)).toHaveLength(MAX_BATCH)
      expect(batch.qbitConsolidation?.maxInputs).toBe(MAX_BATCH)
    })

    it('never hands an input of a signed batch to a later batch of another size', async () => {
      const fixture = overLimitAccount()
      explorer = fixture.explorer
      const wallet = controller()

      const small = await wallet.createQbitConsolidationPsbt({ feeRate: 1, maxInputs: 10 })
      await signBatch(wallet, small)
      const full = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      await signBatch(wallet, full)
      const tiny = await wallet.createQbitConsolidationPsbt({ feeRate: 1, maxInputs: 2 })

      expect(inputsOf(full)).toHaveLength(MAX_BATCH)
      expect(inputsOf(tiny)).toHaveLength(2)
      const keys = [...inputsOf(small), ...inputsOf(full), ...inputsOf(tiny)]
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('refuses to sign a batch whose inputs a batch of another size took since', async () => {
      const fixture = overLimitAccount()
      explorer = fixture.explorer
      const wallet = controller()

      // The screen dropped the first batch for the new size, unsigned: its
      // inputs return to the walk, and the larger batch takes them again.
      const small = await wallet.createQbitConsolidationPsbt({ feeRate: 1, maxInputs: 10 })
      const full = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      expect(inputsOf(full)).toEqual(expect.arrayContaining(inputsOf(small)))

      await signBatch(wallet, full)
      vi.mocked(keyringService.signP2mrPsbtWithCounter).mockClear()

      // The dropped batch can never spend them a second time.
      await expect(signBatch(wallet, small)).rejects.toThrow(
        'Qbit transaction spends an input claimed by an approved send'
      )
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    })
  })

  it('resumes after a failed broadcast without spending a reserved input twice', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()

    // Batch 1: signed, then its broadcast fails with no answer and the
    // follow-up lookups fail too, so nothing proves it was not sent.
    const first = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const firstSigned = await signBatch(wallet, first)
    explorer.failures.push(({ method, path }) =>
      method === 'POST' || path.startsWith(`/tx/${first.qbitBroadcastIdentity!.txid}`)
        ? new TypeError('fetch failed')
        : undefined
    )
    const firstResult = await wallet.broadcastQbitTx(
      firstSigned.psbtHex!,
      firstSigned.qbitSendBroadcastClaim,
      ChainType.QBIT_REGTEST,
      first.qbitBroadcastIdentity!.txid
    )
    expect(firstResult).toMatchObject({ success: false, outcome: 'unknown' })
    explorer.failures.length = 0

    // The same walk hands batch 1's inputs out once only.
    const again = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(inputsOf(again).filter(key => inputsOf(first).includes(key))).toEqual([])

    // A fresh walk (the scan lost, as after a restart) finds batch 1's inputs
    // again, unspent on chain, and still leaves them alone: the claim holds them.
    const resumed = controller()
    const second = await resumed.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(inputsOf(second)).toHaveLength(106)
    expect(inputsOf(second).filter(key => inputsOf(first).includes(key))).toEqual([])
    const secondSigned = await signBatch(resumed, second)

    // The node takes batch 2, but the answer is lost on the way back.
    explorer.failures.push(({ method }) => (method === 'POST' ? 'accept-then-fail' : undefined))
    const secondResult = await resumed.broadcastQbitTx(
      secondSigned.psbtHex!,
      secondSigned.qbitSendBroadcastClaim,
      ChainType.QBIT_REGTEST,
      second.qbitBroadcastIdentity!.txid
    )
    explorer.failures.length = 0
    expect(secondResult).toMatchObject({ success: true, txid: second.qbitBroadcastIdentity!.txid })
    expect(explorer.txs.has(second.qbitBroadcastIdentity!.txid)).toBe(true)

    // Batch 3 avoids both: one held by an unresolved claim, the other spent.
    const third = await resumed.createQbitConsolidationPsbt({ feeRate: 1 })
    const used = new Set([...inputsOf(first), ...inputsOf(second)])
    expect(inputsOf(third)).toHaveLength(106)
    expect(inputsOf(third).filter(key => used.has(key))).toEqual([])
    const thirdSigned = await signBatch(resumed, third)
    await expect(
      resumed.broadcastQbitTx(
        thirdSigned.psbtHex!,
        thirdSigned.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        third.qbitBroadcastIdentity!.txid
      )
    ).resolves.toMatchObject({ success: true })
    // Batch 1's bytes still go out unchanged on retry, and nothing conflicts.
    await expect(
      resumed.broadcastQbitTx(
        firstSigned.psbtHex!,
        firstSigned.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        first.qbitBroadcastIdentity!.txid
      )
    ).resolves.toMatchObject({ success: true })
    const spenders = [first, second, third].map(batch => batch.qbitBroadcastIdentity!.txid)
    for (const txid of spenders) expect(explorer.txs.has(txid)).toBe(true)
  })

  it('checks every input again right before signing and refuses one spent since', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()
    const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const [txid, vout] = inputsOf(batch)[40]!.split(':')
    explorer.addTx({
      txid: fakeTxid(2, 7_000_000),
      inputs: [{ txid: txid!, vout: Number(vout) }],
      outputs: [{ address: payer, script: payerScript, value: 1_000 }],
    })

    await expect(signBatch(wallet, batch)).rejects.toThrow('consolidation_error_input_spent')
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, account.address)
    ).resolves.toEqual(new Set())

    // The next batch leaves the spent output out and signs.
    const next = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(inputsOf(next)).not.toContain(`${txid}:${vout}`)
    await expect(signBatch(wallet, next)).resolves.toMatchObject({
      qbitSendBroadcastClaim: { txid: next.qbitBroadcastIdentity!.txid },
    })
  })

  it('gives the largest outputs back to the walk when their batch is never signed', async () => {
    explorer = overLimitAccount().explorer
    const wallet = controller()
    const abandoned = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })

    // Prepared again, for example at another fee rate: the same outputs.
    const again = await wallet.createQbitConsolidationPsbt({ feeRate: 2 })

    expect(new Set(inputsOf(again))).toEqual(new Set(inputsOf(abandoned)))
  })

  it('re-checks a batch it built even when the request has lost its consolidation details', async () => {
    explorer = overLimitAccount().explorer
    const wallet = controller()
    const { qbitConsolidation: _details, ...request } = await wallet.createQbitConsolidationPsbt({
      feeRate: 1,
    })
    const [txid, vout] = inputsOf(request)[0]!.split(':')
    explorer.addTx({
      txid: fakeTxid(3, 7_000_000),
      inputs: [{ txid: txid!, vout: Number(vout) }],
      outputs: [{ address: payer, script: payerScript, value: 1_000 }],
    })

    await expect(signBatch(wallet, request)).rejects.toThrow('consolidation_error_input_spent')
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('refuses to sign when the explorer cannot vouch for the inputs', async () => {
    explorer = overLimitAccount().explorer
    const wallet = controller()
    const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    explorer.failures.push(({ path }) =>
      path.endsWith('/outspends') ? { status: 503 } : undefined
    )

    await expect(signBatch(wallet, batch)).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('starts the walk over when the explorer no longer accepts its cursor', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()
    const first = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const firstSigned = await signBatch(wallet, first)
    await wallet.broadcastQbitTx(
      firstSigned.psbtHex!,
      firstSigned.qbitSendBroadcastClaim,
      ChainType.QBIT_REGTEST,
      first.qbitBroadcastIdentity!.txid
    )
    // A reorg drops the transaction the scan's cursor names.
    const key = `${ChainType.QBIT_REGTEST}:${account.address}`
    const cursor = (wallet as any).qbitConsolidationScans.get(key).scan.afterTxid
    explorer.removeTx(cursor)

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
      status: 400,
    })
    expect((wallet as any).qbitConsolidationScans.has(key)).toBe(false)

    const next = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(inputsOf(next)).toHaveLength(106)
    expect(inputsOf(next).filter(input => inputsOf(first).includes(input))).toEqual([])
  })

  it('refuses an account within the explorer limit', async () => {
    explorer = overLimitAccount(450).explorer
    const wallet = controller()

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toThrow(
      'consolidation_error_within_limit'
    )
  })

  describe('as the explorer answers, not by the count (#169)', () => {
    it('consolidates an account the explorer still refuses with fewer outputs than its limit', async () => {
      explorer = overLimitAccount(450).explorer
      // electrs keeps refusing an address whose set passed its limit since
      // it last cached that set.
      explorer.utxoRefusedAddresses.add(account.address)
      const wallet = controller()

      await expect(wallet.getQbitConsolidationStatus()).resolves.toMatchObject({
        confirmedUnspent: 451,
        overLimit: true,
        outputLimit: 500,
      })
      const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      expect(inputsOf(batch)).toHaveLength(106)
      expect(batch.qbitConsolidation).toMatchObject({ confirmedOutputCount: 451, outputLimit: 500 })
    })

    it('refuses an account the explorer lists since its limit was raised past it', async () => {
      explorer = overLimitAccount().explorer
      // 701 confirmed outputs: over an older explorer's 500, within 50,000.
      explorer.utxoLimit = 50_000
      const wallet = controller()

      await expect(wallet.getQbitConsolidationStatus()).resolves.toMatchObject({
        confirmedUnspent: 701,
        overLimit: false,
        outputLimit: null,
      })
      await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toThrow(
        'consolidation_error_within_limit'
      )
      // Nothing was walked or handed out for it.
      expect((wallet as any).qbitConsolidationScans.size).toBe(0)
    })

    it('consolidates when the refusal states no limit, and says none', async () => {
      explorer = overLimitAccount().explorer
      explorer.failures.push(({ path }) =>
        path.endsWith('/utxo') ? { status: 413, body: '{"error":"history too long"}' } : undefined
      )
      const wallet = controller()

      await expect(wallet.getQbitConsolidationStatus()).resolves.toMatchObject({
        overLimit: true,
        outputLimit: null,
      })
      const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      expect(batch.qbitConsolidation).toMatchObject({ confirmedOutputCount: 701, outputLimit: null })
    })

    it("assumes 500 for an older explorer's bare 500, and only past it", async () => {
      explorer = overLimitAccount().explorer
      explorer.utxoRefusal = 'bare-500'
      const wallet = controller()

      await expect(wallet.getQbitConsolidationStatus()).resolves.toMatchObject({
        overLimit: true,
        outputLimit: 500,
      })
      expect((await wallet.createQbitConsolidationPsbt({ feeRate: 1 })).qbitConsolidation).toMatchObject({
        outputLimit: 500,
      })

      explorer = overLimitAccount(450).explorer
      explorer.utxoRefusal = 'bare-500'
      explorer.utxoRefusedAddresses.add(account.address)
      const older = controller()
      // Within the assumed limit, a bare 500 is no different from an outage.
      await expect(older.getQbitConsolidationStatus()).rejects.toMatchObject({ status: 500 })
      await expect(older.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
        status: 500,
      })
    })
  })

  it('starts the walk over when a candidate turns out to be gone, instead of failing every batch', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()
    // A batch is built and never signed, and a reorg removes the
    // transaction behind one of its outputs, which the walk checks before
    // taking them back.
    const first = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const key = `${ChainType.QBIT_REGTEST}:${account.address}`
    const goneTxid = inputsOf(first)[0]!.split(':')[0]!
    explorer.removeTx(goneTxid)

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
      kind: 'not_found',
    })
    expect((wallet as any).qbitConsolidationScans.has(key)).toBe(false)

    const next = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(inputsOf(next)).toHaveLength(106)
    expect(inputsOf(next).some(input => input.startsWith(goneTxid))).toBe(false)
  })

  it('keeps the walk through rate limiting', async () => {
    explorer = overLimitAccount().explorer
    const wallet = controller()
    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const key = `${ChainType.QBIT_REGTEST}:${account.address}`
    const scan = (wallet as any).qbitConsolidationScans.get(key).scan
    explorer.failures.push(({ path }) => (path.endsWith('/outspends') ? { status: 429 } : undefined))

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
      kind: 'rate_limit',
    })
    expect((wallet as any).qbitConsolidationScans.get(key).scan).toBe(scan)
  })

  it('keeps the walk through a transient failure and resumes it', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()
    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const key = `${ChainType.QBIT_REGTEST}:${account.address}`
    const scan = (wallet as any).qbitConsolidationScans.get(key).scan
    explorer.failures.push(({ path }) => (path.endsWith('/outspends') ? { status: 503 } : undefined))

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
      status: 503,
    })
    expect((wallet as any).qbitConsolidationScans.get(key).scan).toBe(scan)
  })

  it('starts the walk over after two failed batches in a row, whatever the explorer called them', async () => {
    explorer = overLimitAccount().explorer
    const wallet = controller()
    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const key = `${ChainType.QBIT_REGTEST}:${account.address}`
    const scan = (wallet as any).qbitConsolidationScans.get(key).scan
    // A lasting refusal the backend relays as a bare 500.
    explorer.failures.push(({ path }) => (path.endsWith('/outspends') ? { status: 500 } : undefined))

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
      status: 500,
    })
    expect((wallet as any).qbitConsolidationScans.get(key).scan).toBe(scan)
    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toMatchObject({
      status: 500,
    })
    expect((wallet as any).qbitConsolidationScans.has(key)).toBe(false)
  })

  it('reads past newer outputs too small to pay for their own inputs (Codex review)', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    // 125 recent payments of 3,000 bits: each costs 3,762 bits to spend at 1 bit/vB.
    const dust: string[] = []
    for (let index = 0; index < 125; index += 1) {
      const tx = explorer.addTx({
        txid: fakeTxid(index, 4_000_000),
        inputs: [{ txid: fakeTxid(index, 4_500_000), vout: 0 }],
        outputs: [{ address: account.address, script: account.p2mr.scriptPubKey, value: 3_000 }],
        height: explorer.tipHeight - 1,
      })
      dust.push(`${tx.txid}:0`)
    }
    const wallet = controller()

    const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })

    expect(inputsOf(batch)).toHaveLength(106)
    expect(inputsOf(batch).filter(key => dust.includes(key))).toEqual([])
    expect(batch.qbitConsolidation!.amount).toBeGreaterThan(0)
  })

  it('asks to read further, not to wait, when the page budget ends before a batch is found', async () => {
    // Every one of the newest 1,800 outputs is still immature.
    const fixture = overLimitAccount(200)
    explorer = fixture.explorer
    for (let index = 0; index < 1_800; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index, 3_000_000),
        inputs: [],
        outputs: [{ address: account.address, script: account.p2mr.scriptPubKey, value: 50_000 }],
        coinbase: true,
        height: explorer.tipHeight - 900 + Math.floor(index / 2),
      })
    }
    const wallet = controller()

    await expect(wallet.createQbitConsolidationPsbt({ feeRate: 1 })).rejects.toThrow(
      'consolidation_error_keep_reading'
    )
    // The walk is kept, and the next request reads on and finds the mature outputs.
    const next = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(inputsOf(next).length).toBeGreaterThanOrEqual(2)
  })

  it('finds the mature outputs behind a full page of pending rows on qbit-electrs (#343)', async () => {
    const fixture = overLimitAccount(700, 'mempool-qbit')
    explorer = fixture.explorer
    explorer.emptyPageAfterLastMempoolRow = true
    const pendingRows = () =>
      explorer.history(account.address).filter(tx => tx.height === undefined).length
    // Pending payments to the account fill the first combined page exactly.
    for (let index = 0; pendingRows() < 50; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index, 9_000_000),
        inputs: [{ txid: fakeTxid(index, 9_500_000), vout: 0 }],
        outputs: [{ address: account.address, script: account.p2mr.scriptPubKey, value: 3_000 }],
      })
    }
    const wallet = controller()
    const { endpoint } = (wallet as any).getQbitApiEndpoint()
    vi.spyOn(wallet as any, 'getQbitApiEndpoint').mockReturnValue({
      endpoint,
      apiSurface: 'mempool-qbit',
    })

    const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 1 })

    expect(inputsOf(batch)).toHaveLength(106)
    expect(inputsOf(batch)).not.toContain(`${fixture.largest.txid}:0`)
  })

  it('asks the keyring to sign during a migration only for an account too long to read (#344)', async () => {
    explorer = overLimitAccount().explorer
    const wallet = controller()

    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenLastCalledWith(
      account.address,
      expect.anything()
    )

    // Past the 10,000 transactions a recovery migration reads.
    explorer.failures.push(({ path }) => {
      if (path !== `/address/${account.address}`) return undefined
      const stats = explorer.stats(account.address)
      return {
        status: 200,
        body: JSON.stringify({ ...stats, chain_stats: { ...stats.chain_stats, tx_count: 10_001 } }),
      }
    })
    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenLastCalledWith(
      account.address,
      expect.anything(),
      { allowMigrationConsolidation: true }
    )
  })

  it('starts a scan over once it has sat unused for 30 minutes', async () => {
    let clock = 1_000_000
    explorer = overLimitAccount().explorer
    const wallet = controller({ now: () => clock })
    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    const key = `${ChainType.QBIT_REGTEST}:${account.address}`
    const scan = (wallet as any).qbitConsolidationScans.get(key).scan

    // Kept while in use, however long the consolidation runs.
    for (let use = 0; use < 3; use += 1) {
      clock += 29 * 60_000
      await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      expect((wallet as any).qbitConsolidationScans.get(key).scan).toBe(scan)
    }

    clock += 31 * 60_000
    await wallet.createQbitConsolidationPsbt({ feeRate: 1 })
    expect((wallet as any).qbitConsolidationScans.get(key).scan).not.toBe(scan)
  })

  it('serves sends from the history-derived outputs of an over-limit account', async () => {
    const fixture = overLimitAccount()
    explorer = fixture.explorer
    const wallet = controller()

    const snapshot = await wallet.getQbitUtxoSnapshot()

    const expected = explorer.unspent(account.address, { confirmedOnly: true })
    expected.delete(`${fixture.immature.txid}:0`)
    expect(new Set(snapshot.utxos.map(utxo => `${utxo.txid}:${utxo.vout}`))).toEqual(expected)
  })

  describe('fee rates from the 0.25 bits/vB relay floor (#182)', () => {
    /** What the public explorers' `/fees/precise` answered on an empty mempool. */
    const EMPTY_MEMPOOL = {
      fastestFee: 1,
      halfHourFee: 0.5,
      hourFee: 0.25,
      economyFee: 0.25,
      minimumFee: 0.25,
    }
    const feeRequests = () =>
      explorer.requests.map(request => request.path).filter(path => path.startsWith('/fee'))
    const tierRates = (summary: { list: { feeRate: number }[] }) =>
      summary.list.map(tier => tier.feeRate)

    /** A controller on the mempool-qbit surface, with the real client. */
    function mempoolQbitController(options: { now?: () => number } = {}) {
      const wallet = controller(options)
      const { endpoint } = (wallet as any).getQbitApiEndpoint()
      vi.spyOn(wallet as any, 'getQbitApiEndpoint').mockReturnValue({
        endpoint,
        apiSurface: 'mempool-qbit',
      })
      return wallet
    }

    function inputsLessOutputs(toSignData: ToSignData): number {
      const decoded = decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex)))
      const inputs = decoded.inputs.reduce((sum, input) => sum + input.witnessUtxo!.value, 0n)
      const outputs = decoded.outputs.reduce((sum, output) => sum + output.value, 0n)
      return Number(inputs - outputs)
    }

    it('quotes the precise tiers below 1 bit/vB and prepares a batch at the normal one', async () => {
      explorer = overLimitAccount(700, 'mempool-qbit').explorer
      explorer.preciseFees = EMPTY_MEMPOOL
      const wallet = mempoolQbitController({ now: () => 1_000 })

      await expect(wallet.getFeeSummary()).resolves.toEqual({
        list: [
          { title: 'Slow', desc: '~3 min (3 blocks)', feeRate: 0.25, targetBlocks: 3 },
          { title: 'Normal', desc: '~2 min (2 blocks)', feeRate: 0.5, targetBlocks: 2 },
          { title: 'Fast', desc: '~1 min (1 block)', feeRate: 1, targetBlocks: 1 },
        ],
        quote: {
          source: 'mempool-qbit',
          availability: 'available',
          freshness: 'live',
          fetchedAt: 1_000,
        },
      })
      expect(feeRequests()).toEqual(['/fees/precise'])

      // Ten inputs to one output are 37,675 vB: 18,837.5 bits at 0.5, rounded up.
      const batch = await wallet.createQbitConsolidationPsbt({ maxInputs: 10 })
      expect(batch).toMatchObject({ estimatedVsize: 37_675, estimatedFee: 18_838 })
      expect(inputsLessOutputs(batch)).toBe(18_838)
      // From the cached quote.
      expect(feeRequests()).toEqual(['/fees/precise'])
    })

    it('quotes the whole-number tiers when the precise read fails', async () => {
      explorer = overLimitAccount(700, 'mempool-qbit').explorer
      explorer.feeRate = 2
      explorer.failures.push(({ path }) => (path === '/fees/precise' ? { status: 503 } : undefined))
      const wallet = mempoolQbitController()

      const summary = await wallet.getFeeSummary()

      expect(tierRates(summary)).toEqual([2, 2, 2])
      expect(summary.quote).toMatchObject({ availability: 'available', freshness: 'live' })
      expect(feeRequests()).toEqual(['/fees/precise', '/fees/recommended'])
    })

    it('reads only the whole-number tiers on its refreshes for 10 minutes after the precise read fails', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_000_000)
      explorer = overLimitAccount(700, 'mempool-qbit').explorer
      explorer.feeRate = 2
      explorer.preciseFees = EMPTY_MEMPOOL
      let preciseFails = true
      explorer.failures.push(({ path }) =>
        preciseFails && path === '/fees/precise' ? { status: 404 } : undefined
      )
      const wallet = mempoolQbitController({ now: () => Date.now() })

      expect(tierRates(await wallet.getFeeSummary())).toEqual([2, 2, 2])
      // Each refresh after the first comes once the 60 s quote has expired,
      // and reads through the controller's one client for the endpoint.
      vi.setSystemTime(1_060_000)
      expect(tierRates(await wallet.getFeeSummary())).toEqual([2, 2, 2])
      vi.setSystemTime(1_599_999)
      expect(tierRates(await wallet.getFeeSummary())).toEqual([2, 2, 2])
      expect(feeRequests()).toEqual([
        '/fees/precise',
        '/fees/recommended',
        '/fees/recommended',
        '/fees/recommended',
      ])

      // The first refresh 10 minutes after the failure reads the route again.
      preciseFails = false
      vi.setSystemTime(1_660_000)
      const summary = await wallet.getFeeSummary()
      expect(tierRates(summary)).toEqual([0.25, 0.5, 1])
      expect(summary.quote).toMatchObject({ availability: 'available', freshness: 'live' })
      expect(feeRequests().slice(4)).toEqual(['/fees/precise'])
    })

    it('offers 1 bit/vB on every tier when neither fee endpoint answers', async () => {
      explorer = overLimitAccount(700, 'mempool-qbit').explorer
      explorer.preciseFees = EMPTY_MEMPOOL
      let now = 1_000
      const wallet = mempoolQbitController({ now: () => now })
      const bothFail = () =>
        explorer.failures.push(({ path }) =>
          path.startsWith('/fees/') ? { status: 404 } : undefined
        )

      await wallet.getFeeSummary()
      now += 60_000
      bothFail()
      const stale = await wallet.getFeeSummary()
      expect(tierRates(stale)).toEqual([1, 1, 1])
      expect(stale.quote).toEqual({
        source: 'mempool-qbit',
        availability: 'unavailable',
        freshness: 'fallback',
        fallbackReason: 'stale',
      })

      const unquoted = mempoolQbitController({ now: () => now })
      const unavailable = await unquoted.getFeeSummary()
      expect(tierRates(unavailable)).toEqual([1, 1, 1])
      expect(unavailable.quote).toMatchObject({
        availability: 'unavailable',
        fallbackReason: 'unavailable',
      })
      expect(feeRequests()).toEqual([
        '/fees/precise',
        '/fees/precise',
        '/fees/recommended',
        '/fees/precise',
        '/fees/recommended',
      ])

      // Its batch is priced at that 1 bit/vB, not the 0.25 floor.
      const batch = await unquoted.createQbitConsolidationPsbt({ maxInputs: 10 })
      expect(batch).toMatchObject({ estimatedVsize: 37_675, estimatedFee: 37_675 })
    })

    it('prepares a batch at 0.25 bits/vB and refuses 0.24 before any explorer read', async () => {
      explorer = overLimitAccount().explorer
      const wallet = controller()

      const refusal = await wallet
        .createQbitConsolidationPsbt({ feeRate: 0.24, maxInputs: 10 })
        .catch(error => error)
      expect(refusal).toBeInstanceOf(RangeError)
      expect(refusal.message).toBe('feeRate must be between 0.25 and 10000 bits/vB')
      expect(explorer.requests).toEqual([])

      // 37,675 vB at 0.25 bits/vB is 9,418.75 bits, rounded up.
      const batch = await wallet.createQbitConsolidationPsbt({ feeRate: 0.25, maxInputs: 10 })
      expect(inputsOf(batch)).toHaveLength(10)
      expect(batch).toMatchObject({ estimatedVsize: 37_675, estimatedFee: 9_419 })
      expect(inputsLessOutputs(batch)).toBe(9_419)
    })
  })

  describe('over a slow explorer (#56)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('finishes a batch whose first page arrives at about 1 Mbit/s and takes four minutes', async () => {
      explorer = overLimitAccount().explorer
      explorer.slowResponses.push(firstPageAtOneMegabit())
      const wallet = controller()

      const result = await settle(wallet.createQbitConsolidationPsbt({ feeRate: 1 }), 1_000)

      expect(result).not.toHaveProperty('error')
      expect(inputsOf((result as { value: ToSignData }).value)).toHaveLength(106)
      // Longer than the 180 s a batch had before, within its deadline now.
      expect(result.elapsedMs).toBeGreaterThan(180_000)
      expect(result.elapsedMs).toBeLessThanOrEqual(QBIT_CONSOLIDATION_BATCH_DEADLINE_MS)
      expect(explorer.releasedBodies).toEqual([])
    })

    it("starts a batch's deadline once it has the account's scan, not while it waits for another", async () => {
      explorer = overLimitAccount().explorer
      const wallet = controller()
      // Another Prepare holds the account's scan for five minutes.
      let release: () => void = () => undefined
      vi.spyOn(wallet as any, 'selectQbitConsolidationInputs').mockImplementationOnce(
        () => new Promise(resolve => (release = () => resolve([])))
      )
      const first = wallet.createQbitConsolidationPsbt({ feeRate: 1 }).catch(error => error)
      await vi.advanceTimersByTimeAsync(0)
      const second = wallet.createQbitConsolidationPsbt({ feeRate: 1 })
      // The page the waiting batch reads first takes four minutes.
      explorer.slowResponses.push(firstPageAtOneMegabit())
      await vi.advanceTimersByTimeAsync(300_000)
      release()
      expect(await first).toBeInstanceOf(Error)

      const result = await settle(second, 1_000)

      expect(result).not.toHaveProperty('error')
      expect(inputsOf((result as { value: ToSignData }).value)).toHaveLength(106)
      expect(explorer.releasedBodies).toEqual([])
    })

    it('ends a batch whose history page trickles in within the batch deadline, and keeps its walk', async () => {
      explorer = overLimitAccount().explorer
      const wallet = controller()
      // Each page arrives just inside the idle budget, about 1 KB every 14 s:
      // a batch used to hold the screen for up to 3 attempts of 300 s a page.
      explorer.slowResponses.push({ match: isHistoryPage, chunkBytes: 1_024, intervalMs: 14_000 })

      const result = await settle(wallet.createQbitConsolidationPsbt({ feeRate: 1 }), 1_000)

      expect((result as { error: unknown }).error).toMatchObject({ kind: 'timeout' })
      expect(result.elapsedMs).toBeLessThanOrEqual(QBIT_CONSOLIDATION_BATCH_DEADLINE_MS + 1_000)
      // The page still arriving is aborted, not left downloading.
      expect(explorer.releasedBodies).toHaveLength(1)
      expect(explorer.abortedRequests).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      // A timeout is transient: the walk is kept for the next Prepare.
      const key = `${ChainType.QBIT_REGTEST}:${account.address}`
      expect((wallet as any).qbitConsolidationScans.has(key)).toBe(true)

      explorer.slowResponses.length = 0
      const batch = await settle(wallet.createQbitConsolidationPsbt({ feeRate: 1 }))
      expect(inputsOf((batch as { value: ToSignData }).value)).toHaveLength(106)
    })

    /** The send screen of `uiPort` reads the account's outputs as read `readId`. */
    const openSend = (wallet: WalletController, uiPort: string, readId: string) =>
      wallet.runForUiPort(uiPort, () => wallet.getQbitUtxoSnapshot(readId), 'getQbitUtxoSnapshot')

    it("stops a send screen's walk once the screen is left", async () => {
      explorer = overLimitAccount().explorer
      // About 4 KB a second: each page takes a few seconds.
      explorer.slowResponses.push({ match: isHistoryPage, chunkBytes: 4_096, intervalMs: 1_000 })
      const wallet = controller()
      const read = openSend(wallet, 'popup:1', '1').catch(error => error)
      await vi.advanceTimersByTimeAsync(10_000)
      const pagesRead = pageRequests(explorer)
      expect(pagesRead).toBeGreaterThan(0)

      await wallet.runForUiPort(
        'popup:1',
        () => wallet.abandonQbitUtxoSnapshot('1'),
        'abandonQbitUtxoSnapshot'
      )
      expect(await read).toBeInstanceOf(Error)
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      // No page is asked for once nothing waits, and the one arriving is released.
      expect(pageRequests(explorer)).toBe(pagesRead)
      expect(explorer.releasedBodies).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps a walk another page still waits for, and stops it when that page closes', async () => {
      explorer = overLimitAccount().explorer
      explorer.slowResponses.push({ match: isHistoryPage, chunkBytes: 4_096, intervalMs: 1_000 })
      const wallet = controller()
      const popup = openSend(wallet, 'popup:1', '1').catch(error => error)
      const tab = openSend(wallet, 'tab:2', '1').catch(error => error)
      await vi.advanceTimersByTimeAsync(10_000)

      // The popup's screen is left; the tab's still waits, for the same walk.
      await wallet.runForUiPort(
        'popup:1',
        () => wallet.abandonQbitUtxoSnapshot('1'),
        'abandonQbitUtxoSnapshot'
      )
      expect(await popup).toBeInstanceOf(Error)
      const pagesRead = pageRequests(explorer)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(pageRequests(explorer)).toBeGreaterThan(pagesRead)
      expect(explorer.releasedBodies).toHaveLength(0)

      // The tab closes: its port goes, and the walk with it.
      await wallet.onUiPortDisconnected('tab:2')
      expect(await tab).toBeInstanceOf(Error)
      const pagesAtClose = pageRequests(explorer)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(pageRequests(explorer)).toBe(pagesAtClose)
      expect(explorer.releasedBodies).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('lets a read that sees older statistics walk on its own, never restarting the running walk', async () => {
      const fixture = overLimitAccount()
      explorer = fixture.explorer
      explorer.slowResponses.push({ match: isHistoryPage, chunkBytes: 4_096, intervalMs: 1_000 })
      const before = explorer.stats(account.address)
      // A payment to the account confirms, and Send opens: the walk starts.
      const payment = explorer.addTx({
        txid: fakeTxid(2, 7_000_000),
        inputs: [{ txid: fakeTxid(3, 7_000_000), vout: 0 }],
        outputs: [{ address: account.address, script: account.p2mr.scriptPubKey, value: 77_000 }],
        height: explorer.tipHeight,
      })
      const wallet = controller()
      const first = openSend(wallet, 'popup:1', '1')
      await vi.advanceTimersByTimeAsync(10_000)

      // Another page opens Send, and a lagging node behind the explorer
      // answers its statistics read from before the payment.
      let lagged = false
      explorer.failures.push(({ method, path }) => {
        if (lagged || method !== 'GET' || path !== `/address/${account.address}`) return undefined
        lagged = true
        return { status: 200, body: JSON.stringify(before) }
      })
      const second = openSend(wallet, 'tab:2', '1')
      await vi.advanceTimersByTimeAsync(0)
      expect(lagged).toBe(true)

      const answers = await settle(Promise.all([first, second]), 1_000)
      const [firstSnapshot, secondSnapshot] = (answers as { value: [any, any] }).value
      const keys = (snapshot: { utxos: { txid: string; vout: number }[] }) =>
        new Set(snapshot.utxos.map(utxo => `${utxo.txid}:${utxo.vout}`))
      // The first walk is never restarted. The second screen cannot tell the
      // older statistics from an eviction, so it walks on its own; that walk
      // reads the current node and finds the payment too.
      expect(explorer.releasedBodies).toEqual([])
      expect(explorer.abortedRequests).toEqual([])
      expect(keys(firstSnapshot).has(`${payment.txid}:0`)).toBe(true)
      expect(keys(secondSnapshot)).toEqual(keys(firstSnapshot))
    })

    /**
     * A pending send from the account, with change, whose funding
     * transaction the walk fetches only after its statistics check: that
     * fetch is slow, so the walk is past the check while the test moves the
     * history under it.
     */
    function pendingSendPastTheCheck() {
      const fixture = overLimitAccount()
      const funding = fixture.funding[10]!
      const send = fixture.explorer.addTx({
        txid: fakeTxid(4, 7_000_000),
        inputs: [{ txid: funding.txid, vout: 0 }],
        outputs: [
          { address: payer, script: payerScript, value: 10_000 },
          {
            address: account.address,
            script: account.p2mr.scriptPubKey,
            value: funding.outputs[0]!.value - 11_000,
          },
        ],
      })
      fixture.explorer.slowResponses.push({
        match: ({ path }) => path === `/tx/${send.txid}`,
        chunkBytes: 64,
        intervalMs: 1_000,
      })
      return { ...fixture, funding, send }
    }

    const outpoints = (snapshot: { utxos: { txid: string; vout: number }[] }) =>
      new Set(snapshot.utxos.map(utxo => `${utxo.txid}:${utxo.vout}`))

    /** Advance until the walk of the first screen asks for `txid`, past its statistics check. */
    async function untilFetched(txid: string) {
      for (let step = 0; step < 600; step += 1) {
        if (explorer.requests.some(({ path }) => path === `/tx/${txid}`)) return
        await vi.advanceTimersByTimeAsync(100)
      }
      throw new Error(`/tx/${txid} never asked for`)
    }

    it('does not hand a screen the outputs of a walk that a replacement of its send made stale', async () => {
      const fixture = pendingSendPastTheCheck()
      explorer = fixture.explorer
      const wallet = controller()
      const first = openSend(wallet, 'popup:1', '1')
      await untilFetched(fixture.send.txid)
      const before = explorer.stats(account.address)

      // The send is replaced (RBF) at a higher fee: the counts stay the same,
      // the sums do not. Another page opens Send.
      explorer.removeTx(fixture.send.txid)
      const replacement = explorer.addTx({
        txid: fakeTxid(5, 7_000_000),
        inputs: fixture.send.inputs,
        outputs: [
          fixture.send.outputs[0]!,
          { ...fixture.send.outputs[1]!, value: fixture.send.outputs[1]!.value - 500 },
        ],
      })
      const after = explorer.stats(account.address)
      expect(after.mempool_stats.tx_count).toBe(before.mempool_stats.tx_count)
      expect(after).not.toEqual(before)
      const second = openSend(wallet, 'tab:2', '1')

      const answers = await settle(Promise.all([first, second]), 1_000)
      const [firstSnapshot, secondSnapshot] = (answers as { value: [any, any] }).value
      // The screen that saw the replacement gets its change, not the
      // replaced send's, which no longer exists.
      expect(outpoints(secondSnapshot).has(`${fixture.send.txid}:1`)).toBe(false)
      expect(outpoints(secondSnapshot).has(`${replacement.txid}:1`)).toBe(true)
      // The walk the first screen started was not restarted for it.
      expect(outpoints(firstSnapshot).has(`${fixture.send.txid}:1`)).toBe(true)
      expect(explorer.releasedBodies).toEqual([])
    })

    it('does not hand a screen the outputs of a walk that an eviction of its send made stale', async () => {
      const fixture = pendingSendPastTheCheck()
      explorer = fixture.explorer
      const wallet = controller()
      const first = openSend(wallet, 'popup:1', '1')
      await untilFetched(fixture.send.txid)
      const before = explorer.stats(account.address)

      // The send is evicted: the counts drop. Another page opens Send.
      explorer.removeTx(fixture.send.txid)
      expect(explorer.stats(account.address).mempool_stats.tx_count).toBe(
        before.mempool_stats.tx_count - 1
      )
      const second = openSend(wallet, 'tab:2', '1')

      const answers = await settle(Promise.all([first, second]), 1_000)
      const [, secondSnapshot] = (answers as { value: [any, any] }).value
      // No change of a send that is gone; the output it spent is back.
      expect(outpoints(secondSnapshot).has(`${fixture.send.txid}:1`)).toBe(false)
      expect(outpoints(secondSnapshot).has(`${fixture.funding.txid}:0`)).toBe(true)
      expect(explorer.releasedBodies).toEqual([])
    })

    it('replaces a walk once a newer read sees the history move, and answers both screens from it', async () => {
      const fixture = overLimitAccount()
      explorer = fixture.explorer
      explorer.slowResponses.push({ match: isHistoryPage, chunkBytes: 4_096, intervalMs: 1_000 })
      const wallet = controller()
      const first = openSend(wallet, 'popup:1', '1')
      await vi.advanceTimersByTimeAsync(10_000)

      // A payment to the account confirms while that walk runs, and another
      // page opens Send: its read sees the new statistics.
      const payment = explorer.addTx({
        txid: fakeTxid(2, 7_000_000),
        inputs: [{ txid: fakeTxid(3, 7_000_000), vout: 0 }],
        outputs: [{ address: account.address, script: account.p2mr.scriptPubKey, value: 77_000 }],
        height: explorer.tipHeight,
      })
      const second = openSend(wallet, 'tab:2', '1')
      await vi.advanceTimersByTimeAsync(0)
      // The older walk stops at once; its page in flight is released.
      expect(explorer.releasedBodies).toHaveLength(1)

      const answers = await settle(Promise.all([first, second]), 1_000)
      const [firstSnapshot, secondSnapshot] = (answers as { value: [any, any] }).value
      const keys = (snapshot: { utxos: { txid: string; vout: number }[] }) =>
        new Set(snapshot.utxos.map(utxo => `${utxo.txid}:${utxo.vout}`))
      // The screen that asked first gets the newer answer, with the payment.
      expect(keys(firstSnapshot).has(`${payment.txid}:0`)).toBe(true)
      expect(keys(firstSnapshot)).toEqual(keys(secondSnapshot))
      expect(explorer.releasedBodies).toHaveLength(1)
    })
  })
})
