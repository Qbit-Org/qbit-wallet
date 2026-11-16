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
import type { RequestOptions } from '@qbit-oss/api'
import { QbitWalletEsploraClient, getQbitAddressUtxos } from '../src/utils/qbit-api'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The real explorer client, through the wallet's own fetch, over an explorer
// served over fetch that answers every lookup after 100 ms, on the fake
// clock: a classification's burst, then its sustained rate, in time.
const BASE = 'https://explorer.test/api'

const pubkey = hexToBytes('11'.repeat(32))
const script = bytesToHex(
  p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pubkey)))
)
const address = p2mrAddressFromPubkey(pubkey, 'testnet4')

/** `count` payments to the account, younger than a coinbase must be to mature: each is read. */
function accountExplorer(count: number): FakeQbitExplorer {
  const explorer = new FakeQbitExplorer()
  explorer.utxoLimit = 50_000
  explorer.registerAddress(address, script)
  for (let index = 0; index < count; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index),
      inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
      outputs: [{ address, script, value: 10_000 }],
      height: explorer.tipHeight - 600,
    })
  }
  explorer.slowResponses.push({
    match: request => request.path.startsWith('/tx/'),
    chunkBytes: 1 << 20,
    intervalMs: 100,
  })
  return explorer
}

/** The client, with how many lookups were in flight as each one started, in order. */
function countedClient(explorer: FakeQbitExplorer) {
  const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })
  const atStart: number[] = []
  let inFlight = 0
  const getTx = client.getTx.bind(client)
  client.getTx = ((txid: string, request?: RequestOptions) => {
    atStart.push(inFlight++)
    return getTx(txid, request).finally(() => {
      inFlight -= 1
    })
  }) as typeof client.getTx
  return { client, atStart }
}

/** A read's outcome, once it has one, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  promise.then(
    value => Object.assign(outcome, { settled: true, value }),
    error => Object.assign(outcome, { settled: true, error })
  )
  return outcome
}

const most = (values: readonly number[]): number => values.reduce((a, b) => Math.max(a, b), -1)

/** The reply to `path` loses its connection after a few bytes of its body, once, ahead of the 100 ms answers. */
function cutBodyOnce(explorer: FakeQbitExplorer, path: string): void {
  let cut = 0
  explorer.slowResponses.unshift({
    match: request => request.path === path && cut++ < 1,
    chunkBytes: 4,
    intervalMs: 0,
    resetAfterBytes: 4,
  })
}

describe('a classification burst, in time (#209)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    // Sixteen rounds of 256.
    [4_096, 1_600],
    // One lookup more takes one lookup's time more: no cliff.
    [4_097, 1_700],
    // The burst, then 904 lookups 32 at a time, 29 rounds.
    [5_000, 1_600 + 2_900],
  ])(
    'reads %i lookups of 100 ms each in %i ms, the first 4,096 up to 256 at once',
    async (count, ms) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(count)
      const { client, atStart } = countedClient(explorer)
      const fundingTxReads = new QbitFundingTxReads()

      const read = track(getQbitAddressUtxos(client, address, { fundingTxReads }))
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(read.settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      expect(read.settled).toBe(true)
      expect(read.value).toHaveLength(count)
      expect(atStart).toHaveLength(count)
      expect(most(atStart.slice(0, 4_096))).toBe(255)
      if (count > 4_096) expect(most(atStart.slice(4_096))).toBeLessThanOrEqual(31)
      const limiter = fundingTxReads.limiter(client)
      expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('counts a lookup read again once toward its burst: 4,096 lookups, the first 256 read twice, all in the burst', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(4_096)
    // Each body of the first round lost once, and read again 100 ms on in its slot.
    for (let index = 0; index < 256; index += 1) cutBodyOnce(explorer, `/tx/${fakeTxid(index)}`)
    const { client, atStart } = countedClient(explorer)

    const read = track(
      getQbitAddressUtxos(client, address, { fundingTxReads: new QbitFundingTxReads() })
    )
    // The first round takes 200 ms, its pause and its answer; fifteen more of 100 ms.
    await vi.advanceTimersByTimeAsync(1_700 - 1)
    expect(read.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(read.value).toHaveLength(4_096)
    expect(atStart).toHaveLength(4_096 + 256)
    // The last round started together, as the burst's: not 32 at a time.
    expect(most(atStart.slice(-256))).toBe(255)
    expect(vi.getTimerCount()).toBe(0)
  })
})
