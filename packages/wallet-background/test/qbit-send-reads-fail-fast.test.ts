import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  QbitWalletEsploraClient,
  checkQbitSpendInputs,
  getQbitAddressUtxos,
  getQbitSpendableBalanceV2,
  readQbitAddressUtxos,
  readQbitAddressUtxosRidingOut,
} from '../src/utils/qbit-api'
import { QbitBalanceReuse } from '../src/utils/qbit-balance-reuse'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The reads of outputs that feed a signature (the Send screen's, which rides
// out server errors, and those that do not) against explorers that keep
// failing, request by request, and the balance read when nothing fails:
// every request they make, in order, with the time it was made, is
// digested, and the digests were taken from the same test run against
// 1.0.10 (15a5b643). A change to the balance read's ride-out must leave
// every one of them as it was.
const BASE = 'https://explorer.test/api'
const OUTPUT_VALUE = 10_000
const TIP = '/blocks/tip/height'
const txPath = (txid: string): string => `/tx/${txid}`
const isLookup = (path: string): boolean => path.startsWith('/tx/')
/** A request's URL as the client names it in its errors, the base URL redacted. */
const named = (path: string): string => `https://explorer.test/...${path}`

function account(pubkeyByte: string) {
  const pubkey = hexToBytes(pubkeyByte.repeat(32))
  const script = bytesToHex(
    p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pubkey)))
  )
  return { address: p2mrAddressFromPubkey(pubkey, 'testnet4'), script }
}

const main = account('11')
const address = main.address
const LISTING = `/address/${address}/utxo`

/** `count` payments, 600 blocks deep, and with `reward` a coinbase output as deep, immature. */
function accountExplorer(count: number, { reward = false } = {}): FakeQbitExplorer {
  const explorer = new FakeQbitExplorer()
  explorer.utxoLimit = 50_000
  explorer.registerAddress(main.address, main.script)
  for (let index = 0; index < count; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index),
      inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
      outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
      height: explorer.tipHeight - 600,
    })
  }
  if (reward) {
    explorer.addTx({
      txid: fakeTxid(1, 7_000_000),
      inputs: [],
      outputs: [{ address, script: main.script, value: 5 * OUTPUT_VALUE }],
      height: explorer.tipHeight - 600,
      coinbase: true,
    })
  }
  return explorer
}

/**
 * Which requests fail: by path and how many requests that path has had,
 * true for a 502, or the status to answer with; false or undefined for none.
 */
type Fails = (path: string, nth: number) => boolean | number | undefined

/**
 * The fetch the client is handed, and a log of every request, with when it
 * was made: `explorer`'s, but a request `fails` picks gets the status it
 * names (a 502 page for true) with the explorer's `Retry-After: 60`, or with
 * none when `retryAfter` is null.
 */
function failing(explorer: FakeQbitExplorer, fails: Fails, retryAfter: string | null = '60') {
  const log: { path: string; at: number }[] = []
  const seen = new Map<string, number>()
  const start = Date.now()
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`
    const nth = (seen.get(path) ?? 0) + 1
    seen.set(path, nth)
    log.push({ path, at: Date.now() - start })
    const failure = fails(path, nth)
    if (failure === undefined || failure === false) return explorer.fetch(input, init)
    const status = failure === true ? 502 : failure
    return new Response(status === 502 ? '502 Bad Gateway' : `HTTP ${status}`, {
      status,
      headers: retryAfter === null ? {} : { 'retry-after': retryAfter },
    })
  }
  return { fetchFn, log }
}

/** Run `read` on the faked clock until it settles; its outcome, and every request it made. */
async function outcomeOf(
  explorer: FakeQbitExplorer,
  fails: Fails,
  read: (client: QbitWalletEsploraClient, fundingTxReads: QbitFundingTxReads) => Promise<unknown>,
  retryAfter: string | null = '60'
) {
  vi.useFakeTimers()
  const { fetchFn, log } = failing(explorer, fails, retryAfter)
  const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn })
  const fundingTxReads = new QbitFundingTxReads()
  const start = Date.now()
  let settled: { error?: unknown; value?: unknown; at: number } | undefined
  read(client, fundingTxReads).then(
    value => (settled = { value, at: Date.now() - start }),
    (error: unknown) => (settled = { error, at: Date.now() - start })
  )
  for (let spent = 0; settled === undefined && spent < 120_000; spent += 100) {
    await vi.advanceTimersByTimeAsync(100)
  }
  const limiter = fundingTxReads.limiter(client)
  const error = settled?.error as
    | { name?: string; kind?: string; status?: number; url?: string }
    | undefined
  return {
    outcome: error
      ? { name: error.name, kind: error.kind, status: error.status, url: error.url }
      : Array.isArray(settled?.value)
        ? { outputs: settled.value.length }
        : { value: settled?.value },
    at: settled?.at,
    requests: log.length,
    lookups: log.filter(request => isLookup(request.path)).length,
    digest: createHash('sha256').update(JSON.stringify(log)).digest('hex').slice(0, 16),
    idle: [limiter.inFlight, limiter.queued, vi.getTimerCount()],
  }
}

const everyLookup = (path: string): boolean => isLookup(path)
const oneLookup = (path: string): boolean => path === txPath(fakeTxid(150))

const ridingOut = (client: QbitWalletEsploraClient, fundingTxReads: QbitFundingTxReads) =>
  readQbitAddressUtxosRidingOut(client, address, { fundingTxReads }).then(read => read.utxos)
const candidates = (client: QbitWalletEsploraClient, fundingTxReads: QbitFundingTxReads) =>
  readQbitAddressUtxos(client, address, { fundingTxReads }).then(read => read.utxos)
const checked = (client: QbitWalletEsploraClient, fundingTxReads: QbitFundingTxReads) =>
  getQbitAddressUtxos(client, address, { fundingTxReads })

describe('the reads of outputs that feed a signature, against an explorer that keeps failing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("the Send screen's read, every lookup answered 502 throughout", async () => {
    expect(await outcomeOf(accountExplorer(300), everyLookup, ridingOut)).toEqual({
      outcome: { name: 'QbitApiError', kind: 'http', status: 502, url: named(txPath(fakeTxid(0))) },
      at: 14_000,
      requests: 1_027,
      lookups: 1_025,
      digest: 'c1347087db274dac',
      idle: [0, 0, 0],
    })
  })

  it("the Send screen's read, one lookup answered 502 throughout", async () => {
    expect(await outcomeOf(accountExplorer(300), oneLookup, ridingOut)).toEqual({
      outcome: {
        name: 'QbitApiError',
        kind: 'http',
        status: 502,
        url: named(txPath(fakeTxid(150))),
      },
      at: 14_000,
      requests: 306,
      lookups: 304,
      digest: '764940e78a5f4add',
      idle: [0, 0, 0],
    })
  })

  it("the Send screen's read, the tip answered 502 throughout with a reward to judge", async () => {
    expect(
      await outcomeOf(accountExplorer(20, { reward: true }), path => path === TIP, ridingOut)
    ).toEqual({
      outcome: { name: 'QbitApiError', kind: 'http', status: 502, url: named(TIP) },
      at: 14_000,
      requests: 27,
      lookups: 21,
      digest: 'cfa595a242c479d5',
      idle: [0, 0, 0],
    })
  })

  it('the read of candidates for a send, every lookup answered 502', async () => {
    expect(await outcomeOf(accountExplorer(300), everyLookup, candidates)).toEqual({
      outcome: { name: 'QbitApiError', kind: 'http', status: 502, url: named(txPath(fakeTxid(0))) },
      at: 0,
      requests: 258,
      lookups: 256,
      digest: '3a6ea1f09347efbf',
      idle: [0, 0, 0],
    })
  })

  it('the read of candidates for a send, the listing answered 502 once', async () => {
    let failed = false
    const once = (path: string): boolean => {
      if (path !== LISTING || failed) return false
      failed = true
      return true
    }
    expect(await outcomeOf(accountExplorer(20), once, candidates)).toEqual({
      outcome: { name: 'QbitApiError', kind: 'http', status: 502, url: named(LISTING) },
      at: 0,
      requests: 2,
      lookups: 0,
      digest: '4d7da93b805a6ea5',
      idle: [0, 0, 0],
    })
  })

  it('the read that checks every output, one lookup answered 502 without Retry-After', async () => {
    expect(await outcomeOf(accountExplorer(300), oneLookup, checked, null)).toEqual({
      outcome: {
        name: 'QbitApiError',
        kind: 'http',
        status: 502,
        url: named(txPath(fakeTxid(150))),
      },
      at: 900,
      requests: 304,
      lookups: 302,
      digest: '96246365c81729db',
      idle: [0, 0, 0],
    })
  })
})

/** The account, with a young reward and one only the tip shows mature (1,100 blocks deep). */
function rewardedExplorer(count: number): FakeQbitExplorer {
  const explorer = accountExplorer(count)
  explorer.addTx({
    txid: fakeTxid(1, 7_000_000),
    inputs: [],
    outputs: [{ address, script: main.script, value: 5 * OUTPUT_VALUE }],
    height: explorer.tipHeight - 600,
    coinbase: true,
  })
  explorer.addTx({
    txid: fakeTxid(2, 7_000_000),
    inputs: [],
    outputs: [{ address, script: main.script, value: 6 * OUTPUT_VALUE }],
    height: explorer.tipHeight - 1_100,
    coinbase: true,
  })
  return explorer
}

describe('the reads of outputs that feed a signature, on a listing refused with a bare 500 or a tip answered 504 once', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the read of candidates for a send, the listing a bare 500 and the statistics 502 once', async () => {
    const fails: Fails = (path, nth) =>
      path === LISTING ? 500 : path === `/address/${address}` && nth === 1 ? 502 : undefined
    expect(await outcomeOf(rewardedExplorer(600), fails, candidates)).toEqual({
      outcome: { name: 'QbitApiError', kind: 'http', status: 500, url: named(LISTING) },
      at: 0,
      requests: 3,
      lookups: 0,
      digest: '2958e5ca8ffafffa',
      idle: [0, 0, 0],
    })
  })

  it("the check of a send plan's inputs, a reward only the tip shows mature, the tip 504 once", async () => {
    const inputs = [0, 1, 2, 3, 4]
      .map(index => ({
        txid: fakeTxid(index),
        vout: 0,
        satoshis: OUTPUT_VALUE,
        scriptPk: main.script,
      }))
      .concat([
        {
          txid: fakeTxid(2, 7_000_000),
          vout: 0,
          satoshis: 6 * OUTPUT_VALUE,
          scriptPk: main.script,
        },
      ])
    const check = (client: QbitWalletEsploraClient, fundingTxReads: QbitFundingTxReads) =>
      checkQbitSpendInputs(client, address, inputs, { fundingTxReads })
    const fails: Fails = (path, nth) => (path === TIP && nth === 1 ? 504 : undefined)
    expect(await outcomeOf(rewardedExplorer(60), fails, check)).toEqual({
      outcome: { name: 'QbitSpendInputCheckError' },
      at: 0,
      requests: 7,
      lookups: 6,
      digest: '6d6b71477600a236',
      idle: [0, 0, 0],
    })
  })
})

describe('the balance read, when every read answers first time', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([false, true])('makes exactly the requests 1.0.10 makes (reuse: %s)', async withReuse => {
    const read = (client: QbitWalletEsploraClient, fundingTxReads: QbitFundingTxReads) =>
      getQbitSpendableBalanceV2(client, address, main.script, undefined, undefined, {
        fundingTxReads,
        ...(withReuse ? { reuse: new QbitBalanceReuse().begin() } : {}),
      })
    expect(await outcomeOf(rewardedExplorer(60), () => undefined, read)).toEqual({
      outcome: {
        value: {
          availableBalance: 66 * OUTPUT_VALUE,
          unavailableBalance: 5 * OUTPUT_VALUE,
          totalBalance: 71 * OUTPUT_VALUE,
          immatureBalance: 5 * OUTPUT_VALUE,
          pendingBalance: 0,
        },
      },
      at: 0,
      requests: 64,
      lookups: 61,
      digest: 'c77edef92d584326',
      idle: [0, 0, 0],
    })
  })
})
