import { describe, expect, it } from 'vitest'

import { getQbitSpendableBalanceV2, QbitWalletEsploraClient } from '../src/utils/qbit-api'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import { ACCOUNT_ADDRESS, ACCOUNT_SCRIPT } from './qbit-classify-reads-fake'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

const address = ACCOUNT_ADDRESS
const script = ACCOUNT_SCRIPT
const BASE = 'https://explorer.test/api'

/**
 * An explorer of the account with `deep` outputs a coinbase maturity deep and
 * `young` outputs a few blocks deep, and a client whose lookups of
 * transactions are held until the test lets them go.
 */
function setup(deep: number, young: number) {
  const explorer = new FakeQbitExplorer('esplora')
  explorer.registerAddress(address, script)
  for (let index = 0; index < deep + young; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index, 31_000_000),
      inputs: [{ txid: fakeTxid(index, 32_000_000), vout: 0 }],
      outputs: [{ address, script, value: 10_000 }],
      height: index < deep ? 100 : explorer.tipHeight - 3,
    })
  }
  const held: Array<() => void> = []
  let holding = false
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (holding && /\/tx\/[0-9a-f]{64}$/.test(String(input))) {
      await new Promise<void>(resolve => held.push(resolve))
    }
    return explorer.fetch(input as string, init)
  }
  const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn, retryBaseDelayMs: 0 })
  return {
    client,
    explorer,
    hold: (on: boolean) => {
      holding = on
    },
    release: () => held.splice(0).forEach(resolve => resolve()),
    heldCount: () => held.length,
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the balance read observer (QbitBalanceReadOptions.observer)', () => {
  it('is told the total as the statistics answer, before any output is read, and counts each output as it is classified', async () => {
    const { client, hold, release, heldCount } = setup(3, 2)
    hold(true)
    const told: Array<{
      total: number
      outputs: () => { read: number; total: number } | undefined
    }> = []
    const reading = getQbitSpendableBalanceV2(client, address, script, undefined, undefined, {
      observer: { totalRead: (total, outputs) => told.push({ total, outputs }) },
    })
    while (heldCount() < 2) await settle()

    expect(told.map(({ total }) => total)).toEqual([50_000])
    // The deep outputs are read from the listing alone; the young ones wait for their lookups.
    expect(told[0]!.outputs()).toEqual({ read: 3, total: 5 })
    release()
    const answer = await reading
    expect(answer.totalBalance).toBe(50_000)
    expect(answer.availableBalance).toBe(50_000)
    expect(told[0]!.outputs()).toEqual({ read: 5, total: 5 })
  })

  it('counts an output served from kept facts as read', async () => {
    const { client, hold, release, heldCount, explorer } = setup(0, 2)
    const fundingTxReads = new QbitFundingTxReads()
    await getQbitSpendableBalanceV2(client, address, script, undefined, undefined, {
      fundingTxReads,
    })
    explorer.addTx({
      txid: fakeTxid(99, 31_000_000),
      inputs: [{ txid: fakeTxid(99, 32_000_000), vout: 0 }],
      outputs: [{ address, script, value: 10_000 }],
      height: explorer.tipHeight - 3,
    })
    hold(true)
    let outputs: (() => { read: number; total: number } | undefined) | undefined
    const reading = getQbitSpendableBalanceV2(client, address, script, undefined, undefined, {
      fundingTxReads,
      observer: { totalRead: (_total, count) => (outputs = count) },
    })
    while (heldCount() < 1) await settle()
    expect(outputs?.()).toEqual({ read: 2, total: 3 })
    release()
    await reading
  })

  it('changes nothing in the read when it throws', async () => {
    const { client } = setup(2, 1)
    const answer = await getQbitSpendableBalanceV2(client, address, script, undefined, undefined, {
      observer: {
        totalRead: () => {
          throw new Error('the page went away')
        },
      },
    })
    expect(answer).toMatchObject({ totalBalance: 30_000, availableBalance: 30_000 })
  })
})
