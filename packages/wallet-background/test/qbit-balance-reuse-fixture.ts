/**
 * An account for the tests of balance answers kept for reuse
 * (`QbitBalanceReuse`): a fake explorer served over fetch to the wallet's own
 * client, the shared reader and kept answers a controller would hold, the
 * two clocks the tests move, and a log of every request as it is asked for.
 */

import { vi } from 'vitest'

import type { EsploraAddressStats, EsploraTxStatus } from '@qbit-oss/api'
import { hexToBytes, outputScriptToAddress } from '@qbit-oss/protocol'

import {
  getQbitSpendableBalanceV2,
  readQbitAddressUtxos,
  QbitWalletEsploraClient,
  type QbitEsploraClient,
} from '../src/utils/qbit-api'
import { QbitBalanceReuse } from '../src/utils/qbit-balance-reuse'
import { QBIT_EXPLORER_FRESH_READ_PARAM } from '../src/utils/qbit-explorer-fetch'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import { ACCOUNT_ADDRESS, ACCOUNT_SCRIPT, FOREIGN_SCRIPT } from './qbit-classify-reads-fake'
import { FakeQbitExplorer, fakeTxid, type FakeTx } from './qbit-fake-explorer'

export const address = ACCOUNT_ADDRESS
export const script = ACCOUNT_SCRIPT
export const STATS = `/address/${address}`
export const LISTING = `/address/${address}/utxo`
export const TIP = '/blocks/tip/height'
/** `path` asked for as a fresh read, as `sent` logs it (the nonce left out). */
export const fresh = (path: string): string => `${path}?${QBIT_EXPLORER_FRESH_READ_PARAM}`
export const FRESH_STATS = fresh(STATS)
export const FRESH_LISTING = fresh(LISTING)
/** The time between two polls of the balance card. */
export const POLL_MS = 10_000
const BASE = 'https://explorer.test/api'

/** `path` without its query: the route it reads, fresh or not. */
export const route = (path: string): string => path.split('?')[0]!

/** An output as the explorer lists it. */
export interface ListedOutput {
  txid: string
  vout: number
  value: number
  status: EsploraTxStatus
}

/** A request held, once asked for (`arrived`), until `release`. */
export interface HeldRequest {
  readonly arrived: Promise<void>
  release(): void
}

export interface PollOptions {
  /** How far both clocks move before the poll: `POLL_MS` by default. */
  advance?: number
  deadlineMs?: number
  signal?: AbortSignal
  readReserved?: () => Promise<ReadonlySet<string>>
  /** The shared reader; the account's by default. */
  fundingTxReads?: QbitFundingTxReads
  /** The address polled; the account's by default. */
  address?: string
  /** The poll's script; the account's by default. */
  p2mrScriptPubKey?: string | undefined
}

/** One poll's answer, and the requests it made, in the order it asked for them. */
export interface Poll {
  value: Awaited<ReturnType<typeof getQbitSpendableBalanceV2>>
  requests: string[]
}

/**
 * An account under a tip of 2,000 paid `deep` times at least a coinbase
 * maturity deep, which the balance classifies from the listing alone, and
 * `young` times 10 or more blocks deep but younger than that, whose
 * transactions the first poll reads and later polls are served from the
 * facts kept.
 */
export class ReuseAccount {
  readonly explorer = new FakeQbitExplorer('esplora')
  /** Every request sent through `fetch`, by path, as each was asked for. */
  readonly sent: string[] = []
  /** The kept answers' monotonic clock, in ms, which only the tests move. */
  time = 0
  /** Their wall clock, in ms, which only the tests move. */
  wallTime = 1_800_000_000_000
  reserved: ReadonlySet<string> = new Set()
  /**
   * How the explorer answers the tip: at once, after this many ms (on the
   * timers the test runs), or never, until the request is given up.
   */
  tip: 'answer' | 'hang' | number = 'answer'
  /** How long, in ms on the timers the test runs, the explorer takes to answer a listing. */
  listingDelayMs = 0
  readonly readReserved = vi.fn(async (): Promise<ReadonlySet<string>> => this.reserved)
  readonly reuse = new QbitBalanceReuse({ now: () => this.time, wallNow: () => this.wallTime })
  readonly fundingTxReads: QbitFundingTxReads
  readonly client: QbitWalletEsploraClient
  readonly payments: FakeTx[] = []
  private seed = 0
  private readonly holds: {
    match: (path: string) => boolean
    arrive: () => void
    released: Promise<void>
  }[] = []

  constructor({
    deep = 1_200,
    young = 0,
    maxOutpoints,
  }: { deep?: number; young?: number; maxOutpoints?: number } = {}) {
    this.explorer.registerAddress(address, script)
    // Lists any of these accounts.
    this.explorer.utxoLimit = 1_000_000
    for (let index = 0; index < deep; index += 1) {
      this.pay(10_000 + index, { depth: 1_000 + (index % 700) })
    }
    for (let index = 0; index < young; index += 1) {
      this.pay(20_000 + index, { depth: 10 + index })
    }
    this.fundingTxReads = new QbitFundingTxReads(maxOutpoints === undefined ? {} : { maxOutpoints })
    this.client = this.newClient()
  }

  /**
   * A payment of `value`, `depth` blocks deep (1 in the tip block) or
   * pending, listed under `to` (the account's address by default) and paying
   * `script` (the account's by default).
   */
  pay(
    value: number,
    {
      depth,
      coinbase = false,
      to = address,
      script: paid = script,
    }: { depth?: number; coinbase?: boolean; to?: string; script?: string } = {}
  ): FakeTx {
    this.seed += 1
    const tx = this.explorer.addTx({
      txid: fakeTxid(this.seed, 31_000_000),
      inputs: coinbase ? [] : [{ txid: fakeTxid(this.seed, 32_000_000), vout: 0 }],
      outputs: [{ address: to, script: paid, value }],
      coinbase,
      ...(depth !== undefined ? { height: this.explorer.tipHeight - depth + 1 } : {}),
    })
    if (to === address) this.payments.push(tx)
    return tx
  }

  /**
   * Another account on the same explorer, paid `count` times, none of them a
   * reward, `depth` blocks deep: a coinbase maturity deep by default.
   */
  addAccount(byte: string, count = 1_100, depth = 1_100): { address: string; script: string } {
    const other = `5220${byte.repeat(32)}`
    const otherAddress = outputScriptToAddress(hexToBytes(other), 'regtest')
    this.explorer.registerAddress(otherAddress, other)
    for (let index = 0; index < count; index += 1) {
      this.pay(7_000 + index, { depth, to: otherAddress, script: other })
    }
    return { address: otherAddress, script: other }
  }

  /** A client of the same explorer, its requests logged in `sent`. */
  newClient(): QbitWalletEsploraClient {
    return new QbitWalletEsploraClient({
      baseUrl: BASE,
      fetchFn: this.fetch as typeof fetch,
      retryBaseDelayMs: 0,
    })
  }

  /** Hold the next request `match` matches, by path as `sent` logs it. */
  hold(match: (path: string) => boolean): HeldRequest {
    let arrive: () => void = () => undefined
    const arrived = new Promise<void>(resolve => (arrive = resolve))
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    this.holds.push({ match, arrive, released })
    return { arrived, release }
  }

  /** Start a poll through `client` without waiting for it. */
  start(options: PollOptions = {}, client: QbitEsploraClient = this.client) {
    const advance = options.advance ?? POLL_MS
    this.time += advance
    this.wallTime += advance
    const from = this.sent.length
    const answer = getQbitSpendableBalanceV2(
      client,
      options.address ?? address,
      'p2mrScriptPubKey' in options ? options.p2mrScriptPubKey : script,
      options.readReserved ?? this.readReserved,
      undefined,
      {
        fundingTxReads: options.fundingTxReads ?? this.fundingTxReads,
        reuse: this.reuse.begin(),
        ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }
    )
    return { answer, requests: (): string[] => this.sent.slice(from) }
  }

  async poll(options: PollOptions = {}, client: QbitEsploraClient = this.client): Promise<Poll> {
    const { answer, requests } = this.start(options, client)
    const value = await answer
    return { value, requests: requests() }
  }

  /**
   * A read of the account's outputs for a send, as the send screen's,
   * through the account's client and shared reader: it reads afresh every
   * output younger than a coinbase maturity, and its answers replace the
   * facts kept of them.
   */
  readOutputs() {
    return readQbitAddressUtxos(this.client, address, { fundingTxReads: this.fundingTxReads })
  }

  /**
   * From now on, until the function returned is called, the explorer
   * answers `tx`'s transaction as a payment from another script, not the
   * coinbase it is.
   */
  answerAsPayment(tx: FakeTx): () => void {
    let wrong = true
    this.explorer.failures.push(({ path }) => {
      if (!wrong || path !== `/tx/${tx.txid}`) return undefined
      const body = this.explorer.esploraTx(tx) as { vin: unknown[] }
      body.vin = [
        {
          txid: '77'.repeat(32),
          vout: 0,
          prevout: {
            scriptpubkey: FOREIGN_SCRIPT,
            scriptpubkey_asm: '',
            scriptpubkey_type: 'v2_p2mr',
            value: tx.outputs[0]!.value + 100,
          },
          scriptsig: '',
          scriptsig_asm: '',
          is_coinbase: false,
          sequence: 0xfffffffd,
        },
      ]
      return { status: 200, body: JSON.stringify(body) }
    })
    return (): void => {
      wrong = false
    }
  }

  /**
   * From now on, until the function returned is called, the explorer
   * answers `tx`'s transaction with its first output paying `paid`, not the
   * script it pays.
   */
  answerWithScript(tx: FakeTx, paid: string): () => void {
    let wrong = true
    this.explorer.failures.push(({ path }) => {
      if (!wrong || path !== `/tx/${tx.txid}`) return undefined
      const body = this.explorer.esploraTx(tx) as { vout: { scriptpubkey: string }[] }
      body.vout[0]!.scriptpubkey = paid
      return { status: 200, body: JSON.stringify(body) }
    })
    return (): void => {
      wrong = false
    }
  }

  /**
   * What a read of the same explorer answers with nothing kept for it, or
   * reused: a client and reader of its own, the same reservations, and
   * exactly the script given (the account's when none is).
   */
  async fresh(options: { address?: string; p2mrScriptPubKey?: string | undefined } = {}) {
    return getQbitSpendableBalanceV2(
      this.newClient(),
      options.address ?? address,
      'p2mrScriptPubKey' in options ? options.p2mrScriptPubKey : script,
      async () => this.reserved,
      undefined,
      { fundingTxReads: new QbitFundingTxReads() }
    )
  }

  /** The listing a fresh read of the explorer gives now, parsed. */
  async listing(): Promise<ListedOutput[]> {
    const response = await this.explorer.fetch(`${BASE}${FRESH_LISTING}=listing`)
    return response.json()
  }

  /** From now on the explorer answers every listing with `change` of it as it reads now. */
  async serveListing(change: (listing: ListedOutput[]) => unknown[]): Promise<void> {
    const body = JSON.stringify(change(await this.listing()))
    this.explorer.failures.push(({ path }) =>
      route(path) === LISTING ? { status: 200, body } : undefined
    )
  }

  /**
   * From now on a listing not asked for fresh is answered with the listing
   * as it reads now, as a cache in front of the explorer hands out a reply
   * it holds; a fresh read is answered as the explorer reads then.
   */
  async cacheListing(): Promise<void> {
    const body = JSON.stringify(await this.listing())
    this.explorer.failures.push(({ path }) =>
      path === LISTING ? { status: 200, body } : undefined
    )
  }

  /** As `cacheListing`, for the statistics. */
  cacheStats(): void {
    const body = JSON.stringify(this.explorer.stats(address))
    this.explorer.failures.push(({ path }) => (path === STATS ? { status: 200, body } : undefined))
  }

  /** From now on the explorer answers all statistics of the account with `change` of them. */
  serveStats(change: (stats: EsploraAddressStats) => unknown): void {
    this.explorer.failures.push(({ path }) =>
      route(path) === STATS
        ? {
            status: 200,
            body: JSON.stringify(change(this.explorer.stats(address) as EsploraAddressStats)),
          }
        : undefined
    )
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const asked = url.searchParams.has(QBIT_EXPLORER_FRESH_READ_PARAM)
      ? `?${QBIT_EXPLORER_FRESH_READ_PARAM}`
      : url.search
    const path = `${url.pathname.replace(/^\/api/, '')}${asked}`
    this.sent.push(path)
    const index = this.holds.findIndex(hold => hold.match(path))
    if (index >= 0) {
      const [hold] = this.holds.splice(index, 1)
      hold!.arrive()
      await hold!.released
    }
    if (route(path) === LISTING && this.listingDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.listingDelayMs))
    }
    if (path === TIP && this.tip !== 'answer') {
      const after = this.tip
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal
        const timer = after === 'hang' ? undefined : setTimeout(resolve, after)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(signal.reason)
          },
          { once: true }
        )
      })
    }
    return this.explorer.fetch(input, init)
  }
}

/** The txids of the `/tx` reads among `requests`. */
export const txReads = (requests: readonly string[]): string[] =>
  requests.flatMap(path => path.match(/^\/tx\/([0-9a-f]{64})$/)?.[1] ?? [])

/** The split of `available`, all of the total, as a complete read answers it. */
export const split = ({
  available,
  immature = 0,
  pending = 0,
}: {
  available: number
  immature?: number
  pending?: number
}) => ({
  availableBalance: available,
  unavailableBalance: immature + pending,
  totalBalance: available + immature + pending,
  immatureBalance: immature,
  pendingBalance: pending,
})

/** The total with the split unknown, as a read that did not finish answers. */
export const incomplete = (total: number, failed = false) => ({
  availableBalance: null,
  unavailableBalance: total,
  totalBalance: total,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  ...(failed ? { utxoReadFailed: true } : {}),
})

/** The value `txs` pay. */
export const sum = (txs: readonly FakeTx[]): number =>
  txs.reduce((total, tx) => total + tx.outputs[0]!.value, 0)
