import { describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  QBIT_SPEND_CHECK_DEADLINE_MS,
  QbitSpendInputCheckError,
  checkQbitSpendInputs,
  getQbitAddressUtxos,
  getQbitAddressUtxosClassified,
  isQbitCheckedSpend,
  readQbitAddressUtxos,
  type QbitSpendInput,
} from '../src/utils/qbit-api'
import { QbitClassificationReads, QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import {
  ACCOUNT_ADDRESS,
  ACCOUNT_SCRIPT,
  ClassifyReadsExplorer,
  FOREIGN_SCRIPT,
  testTxid,
} from './qbit-classify-reads-fake'

// The check of the inputs a transaction spends, made immediately before its
// first signature (#210): each input's funding transaction is read and
// checked, one lookup per transaction, through the shared reader; nothing
// a listing or a kept fact said of it is taken for it.

const address = ACCOUNT_ADDRESS

/** `count` confirmed transactions paying the account once each, and the inputs spending them. */
function funded(
  explorer: ClassifyReadsExplorer,
  count: number,
  { salt = 0, value = 10_000 }: { salt?: number; value?: number } = {}
): QbitSpendInput[] {
  return Array.from({ length: count }, (_, index) => {
    const txid = testTxid(index, salt)
    explorer.addTx(txid, {
      vin: [explorer.input(testTxid(index, salt + 50), 0)],
      outputs: [{ script: ACCOUNT_SCRIPT, value: value + index }],
      confirmed: true,
    })
    return { txid, vout: 0, satoshis: value + index, scriptPk: ACCOUNT_SCRIPT }
  })
}

/** A coinbase reward to the account, confirmed at `height`. */
function reward(explorer: ClassifyReadsExplorer, height: number): QbitSpendInput {
  const txid = testTxid(height, 90)
  explorer.addTx(txid, {
    vin: [{ is_coinbase: true }],
    outputs: [{ script: ACCOUNT_SCRIPT, value: 5_000_000 }],
    confirmed: true,
  })
  explorer.txs.get(txid)!['status'] = { confirmed: true, block_height: height }
  return { txid, vout: 0, satoshis: 5_000_000, scriptPk: ACCOUNT_SCRIPT }
}

/** The check of `inputs` against `explorer`, through `fundingTxReads` when given. */
function check(
  explorer: ClassifyReadsExplorer,
  inputs: readonly QbitSpendInput[],
  options: Parameters<typeof checkQbitSpendInputs>[3] = {}
) {
  return checkQbitSpendInputs(explorer.client as any, address, inputs, options)
}

/** The cause `run` failed for, or `passed`. */
async function causeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'passed'
  } catch (error) {
    if (error instanceof QbitSpendInputCheckError) return error.problem
    throw error
  }
}

describe('the check of the inputs a transaction spends (#210)', () => {
  it('reads each of 106 inputs once, by its own funding transaction, and the tip once', async () => {
    const explorer = new ClassifyReadsExplorer()
    const inputs = funded(explorer, 106)

    const checked = await check(explorer, inputs, { fundingTxReads: new QbitFundingTxReads() })

    expect(isQbitCheckedSpend(checked)).toBe(true)
    expect(checked.inputs.map(input => input.txid)).toEqual(inputs.map(input => input.txid))
    expect(explorer.started).toHaveLength(106)
    expect(new Set(explorer.started).size).toBe(106)
    expect(explorer.tipReads).toBe(1)
  })

  it('reads a funding transaction once however many of its outputs are spent', async () => {
    const explorer = new ClassifyReadsExplorer()
    const txid = testTxid(1, 3)
    explorer.addTx(txid, {
      vin: [explorer.input(testTxid(2, 3), 0)],
      outputs: [0, 1, 2].map(index => ({ script: ACCOUNT_SCRIPT, value: 7_000 + index })),
      confirmed: true,
    })
    const inputs = [0, 1, 2].map(vout => ({
      txid,
      vout,
      satoshis: 7_000 + vout,
      scriptPk: ACCOUNT_SCRIPT,
    }))

    await check(explorer, inputs)

    expect(explorer.started).toEqual([txid])
  })

  it('lets go of each confirmed funding transaction once its inputs are checked, and of no unconfirmed one', async () => {
    const letGo = vi.spyOn(QbitClassificationReads.prototype, 'forget')
    try {
      const explorer = new ClassifyReadsExplorer()
      const inputs = funded(explorer, 3, { salt: 7 })
      const parent = testTxid(1, 8)
      explorer.addTx(parent, {
        vin: [explorer.input(testTxid(3, 8), 0)],
        outputs: [],
        confirmed: true,
      })
      const change = testTxid(2, 8)
      explorer.addTx(change, {
        vin: [explorer.input(parent, 0, 30_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
        size: 1_200,
      })

      await check(explorer, [
        ...inputs,
        { txid: change, vout: 0, satoshis: 20_000, scriptPk: ACCOUNT_SCRIPT },
      ])

      // A plan's one pass checks thousands of inputs, and an answer holds
      // every witness of its transaction: none is held past its own check.
      for (const input of inputs) expect(letGo).toHaveBeenCalledWith(input.txid)
      expect(letGo).not.toHaveBeenCalledWith(change)
    } finally {
      letGo.mockRestore()
    }
  })

  it('does not read again a confirmed funding transaction it let go of when a walk reaches it', async () => {
    const letGo = vi.spyOn(QbitClassificationReads.prototype, 'forget')
    try {
      const explorer = new ClassifyReadsExplorer()
      // One confirmed transaction pays the account twice; its second output
      // is spent by the account's own unconfirmed change.
      const parent = testTxid(1, 9)
      explorer.addTx(parent, {
        vin: [explorer.input(testTxid(3, 9), 0)],
        outputs: [
          { script: ACCOUNT_SCRIPT, value: 11_000 },
          { script: ACCOUNT_SCRIPT, value: 30_000 },
        ],
        confirmed: true,
      })
      const change = testTxid(2, 9)
      explorer.addTx(change, {
        vin: [explorer.input(parent, 1, 30_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
        size: 1_200,
      })
      // The change is answered only once the parent's own input is checked
      // and its answer let go of.
      const getTx = explorer.client.getTx
      explorer.client.getTx = async (txid, options) => {
        if (txid === change) await vi.waitFor(() => expect(letGo).toHaveBeenCalledWith(parent))
        return getTx(txid, options)
      }

      const checked = await check(explorer, [
        { txid: parent, vout: 0, satoshis: 11_000, scriptPk: ACCOUNT_SCRIPT },
        { txid: change, vout: 0, satoshis: 20_000, scriptPk: ACCOUNT_SCRIPT },
      ])

      expect(checked.unconfirmedAncestors.get(`${change}:0`)).toEqual([
        { txid: change, vsize: 1_200 },
      ])
      expect(explorer.readsOf(parent)).toBe(1)
    } finally {
      letGo.mockRestore()
    }
  })

  it('makes nothing that passes for a checked spend but a check', () => {
    const forged = { inputs: [], unconfirmedAncestors: new Map() }

    expect(isQbitCheckedSpend(forged)).toBe(false)
    expect(isQbitCheckedSpend(undefined)).toBe(false)
  })

  describe('a mismatch, named as one', () => {
    it('refuses an input whose funding transaction gives another value', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)

      expect(await causeOf(() => check(explorer, [{ ...input!, satoshis: 10_001 }]))).toBe(
        'mismatch'
      )
    })

    it('refuses an input at an index its funding transaction has no output at', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)

      expect(await causeOf(() => check(explorer, [{ ...input!, vout: 1 }]))).toBe('mismatch')
    })

    it('refuses an input whose funding transaction pays another script', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)
      const tx = explorer.txs.get(input!.txid)!
      tx['vout'] = [{ scriptpubkey: FOREIGN_SCRIPT, value: input!.satoshis }]

      expect(await causeOf(() => check(explorer, [input!]))).toBe('mismatch')
    })

    it('refuses an answer for another transaction', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)
      explorer.txs.get(input!.txid)!['txid'] = testTxid(9, 9)

      expect(await causeOf(() => check(explorer, [input!]))).toBe('mismatch')
    })

    it('refuses an input of another script before reading anything', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)

      expect(await causeOf(() => check(explorer, [{ ...input!, scriptPk: FOREIGN_SCRIPT }]))).toBe(
        'mismatch'
      )
      expect(explorer.started).toEqual([])
    })
  })

  describe('an input not spendable yet', () => {
    it('refuses a coinbase output under 1,000 blocks deep by the tip it reads itself', async () => {
      const explorer = new ClassifyReadsExplorer()
      // 999 confirmations at the tip: one short of maturity.
      const young = reward(explorer, explorer.tipHeight - 998)
      const mature = reward(explorer, explorer.tipHeight - 999)

      expect(await causeOf(() => check(explorer, [young]))).toBe('not_spendable')
      expect(await causeOf(() => check(explorer, [mature]))).toBe('passed')
      // Each check asked for the tip of its own.
      expect(explorer.tipReads).toBe(2)
      explorer.tipHeight += 1
      expect(await causeOf(() => check(explorer, [young]))).toBe('passed')
    })

    it('refuses an unconfirmed output that is not the account’s own change', async () => {
      const explorer = new ClassifyReadsExplorer()
      const txid = testTxid(1, 20)
      explorer.addTx(txid, {
        vin: [
          {
            txid: testTxid(2, 20),
            vout: 0,
            is_coinbase: false,
            prevout: { scriptpubkey: FOREIGN_SCRIPT, value: 30_000 },
          },
        ],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
      })

      expect(
        await causeOf(() =>
          check(explorer, [{ txid, vout: 0, satoshis: 20_000, scriptPk: ACCOUNT_SCRIPT }])
        )
      ).toBe('not_spendable')
    })

    it('takes the account’s own unconfirmed change, with the ancestors it read', async () => {
      const explorer = new ClassifyReadsExplorer()
      const parent = testTxid(1, 21)
      explorer.addTx(parent, {
        vin: [explorer.input(testTxid(3, 21), 0)],
        outputs: [],
        confirmed: true,
      })
      const txid = testTxid(2, 21)
      explorer.addTx(txid, {
        vin: [explorer.input(parent, 0, 30_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
        size: 1_200,
      })

      const checked = await check(explorer, [
        { txid, vout: 0, satoshis: 20_000, scriptPk: ACCOUNT_SCRIPT },
      ])

      expect(checked.unconfirmedAncestors.get(`${txid}:0`)).toEqual([{ txid, vsize: 1_200 }])
      expect(explorer.started).toEqual([txid, parent])
    })
  })

  it('reports a funding transaction the explorer does not have as not found', async () => {
    const explorer = new ClassifyReadsExplorer()
    const [input] = funded(explorer, 1)
    explorer.failures.set(input!.txid, new QbitApiError('not_found', 'HTTP 404', { status: 404 }))

    expect(await causeOf(() => check(explorer, [input!]))).toBe('not_found')
  })

  describe('an unknown outcome, never a mismatch and never a pass', () => {
    it.each([
      ['a server error', new QbitApiError('http', 'HTTP 503', { status: 503 })],
      ['a network failure', new QbitApiError('network', 'network error')],
      ['a timeout', new QbitApiError('timeout', 'timed out')],
    ])('reports %s on a lookup as could not be checked', async (_, failure) => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)
      explorer.failures.set(input!.txid, failure)

      expect(await causeOf(() => check(explorer, [input!]))).toBe('unchecked')
    })

    it('reports a failed read of an ancestor as could not be checked, not as foreign change', async () => {
      const explorer = new ClassifyReadsExplorer()
      const parent = testTxid(1, 22)
      const txid = testTxid(2, 22)
      explorer.addTx(txid, {
        vin: [explorer.input(parent, 0, 30_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
      })
      explorer.failures.set(parent, new QbitApiError('http', 'HTTP 502', { status: 502 }))

      expect(
        await causeOf(() =>
          check(explorer, [{ txid, vout: 0, satoshis: 20_000, scriptPk: ACCOUNT_SCRIPT }])
        )
      ).toBe('unchecked')
    })

    it('reports an answer without its status, and a coinbase without a readable tip, as could not be checked', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)
      delete explorer.txs.get(input!.txid)!['status']
      const coinbase = reward(explorer, 100)

      expect(await causeOf(() => check(explorer, [input!]))).toBe('unchecked')
      explorer.tipFailure = new QbitApiError('http', 'HTTP 503', { status: 503 })
      expect(await causeOf(() => check(explorer, [coinbase]))).toBe('unchecked')
    })

    it('stops every read at its deadline, the tip and the lookups alike, and leaves none in flight', async () => {
      const explorer = new ClassifyReadsExplorer()
      const inputs = funded(explorer, 5)
      explorer.hold()
      explorer.holdTip()

      expect(await causeOf(() => check(explorer, inputs, { deadlineMs: 20 }))).toBe('unchecked')

      expect([...explorer.aborted].sort()).toEqual(inputs.map(input => input.txid).sort())
      expect(explorer.inFlight).toBe(0)
      explorer.release()
      explorer.releaseTip()
    })

    it('rejects with the caller’s reason once its signal aborts, and leaves no read in flight', async () => {
      const explorer = new ClassifyReadsExplorer()
      const inputs = funded(explorer, 3)
      explorer.hold()
      const stop = new AbortController()
      const reason = new Error('the signing stopped')

      const checking = check(explorer, inputs, { signal: stop.signal })
      stop.abort(reason)

      await expect(checking).rejects.toBe(reason)
      expect(explorer.inFlight).toBe(0)
      explorer.release()
    })
  })

  describe('the facts the shared reader keeps', () => {
    it.each([
      ['a coinbase answer', true],
      ['a not-a-coinbase answer', false],
    ])('never serves the check %s it keeps: each input is read afresh', async (_, coinbase) => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 4, { coinbaseCount: coinbase ? 4 : 0 })
      const fundingTxReads = new QbitFundingTxReads()
      // A read of outputs keeps the facts of every deep output it reads.
      await getQbitAddressUtxosClassified(explorer.client as any, address, { fundingTxReads })
      expect(fundingTxReads.size).toBe(4)
      const inputs = explorer.listings.get(address)!.map(listed => ({
        txid: listed.txid,
        vout: listed.vout,
        satoshis: listed.value,
        scriptPk: ACCOUNT_SCRIPT,
      }))
      explorer.started.length = 0

      await check(explorer, inputs, { fundingTxReads })

      expect(explorer.started.sort()).toEqual(inputs.map(input => input.txid).sort())
    })

    it('reads afresh a young reward a kept wrong answer calls no coinbase, and refuses it', async () => {
      const explorer = new ClassifyReadsExplorer()
      const young = reward(explorer, explorer.tipHeight - 9)
      explorer.list(address, {
        txid: young.txid,
        vout: 0,
        value: young.satoshis,
        status: { confirmed: true, block_height: explorer.tipHeight - 9 },
      })
      const fundingTxReads = new QbitFundingTxReads()
      // One wrong answer, kept: the reward is no coinbase.
      const tx = explorer.txs.get(young.txid)!
      tx['vin'] = [explorer.input(testTxid(5, 91), 0)]
      await getQbitAddressUtxosClassified(explorer.client as any, address, { fundingTxReads })
      tx['vin'] = [{ is_coinbase: true }]

      expect(await causeOf(() => check(explorer, [young], { fundingTxReads }))).toBe(
        'not_spendable'
      )
    })

    it('keeps what it reads, and nothing from a check a clear came during', async () => {
      const explorer = new ClassifyReadsExplorer()
      const fundingTxReads = new QbitFundingTxReads()
      const first = funded(explorer, 3)
      await check(explorer, first, { fundingTxReads })
      expect(fundingTxReads.size).toBe(3)

      const second = funded(explorer, 3, { salt: 400 })
      explorer.hold()
      const checking = check(explorer, second, { fundingTxReads })
      fundingTxReads.clear()
      explorer.release()
      await checking

      expect(fundingTxReads.size).toBe(0)
    })
  })

  describe('an input of a transaction the caller holds', () => {
    const ownTxid = testTxid(1, 30)
    const own = new Map([[ownTxid, [{ value: 40_000, script: ACCOUNT_SCRIPT }]]])

    it('is checked against that transaction with no lookup', async () => {
      const explorer = new ClassifyReadsExplorer()

      const checked = await check(
        explorer,
        [{ txid: ownTxid, vout: 0, satoshis: 40_000, scriptPk: ACCOUNT_SCRIPT }],
        { ownTransactions: own }
      )

      expect(checked.inputs).toHaveLength(1)
      expect(explorer.started).toEqual([])
    })

    it('is refused when it does not match that transaction, still with no lookup', async () => {
      const explorer = new ClassifyReadsExplorer()

      for (const input of [
        { txid: ownTxid, vout: 0, satoshis: 40_001, scriptPk: ACCOUNT_SCRIPT },
        { txid: ownTxid, vout: 1, satoshis: 40_000, scriptPk: ACCOUNT_SCRIPT },
      ]) {
        expect(await causeOf(() => check(explorer, [input], { ownTransactions: own }))).toBe(
          'mismatch'
        )
      }
      expect(explorer.started).toEqual([])
    })

    it('leaves every other input to be read', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [other] = funded(explorer, 1)

      await check(
        explorer,
        [{ txid: ownTxid, vout: 0, satoshis: 40_000, scriptPk: ACCOUNT_SCRIPT }, other!],
        { ownTransactions: own }
      )

      expect(explorer.started).toEqual([other!.txid])
    })
  })
})

describe('the check of the inputs a transaction spends: causes, deadline and clean-up (#210)', () => {
  describe('an input no output can be, refused as a mismatch before any read', () => {
    it.each([
      ['a negative index', (input: QbitSpendInput) => ({ ...input, vout: -1 })],
      ['an index past any output', (input: QbitSpendInput) => ({ ...input, vout: 2 ** 32 })],
      [
        'a value no number holds exactly',
        (input: QbitSpendInput) => ({ ...input, satoshis: 2 ** 53 }),
      ],
      ['a negative value', (input: QbitSpendInput) => ({ ...input, satoshis: -1 })],
      ['a txid that is none', (input: QbitSpendInput) => ({ ...input, txid: 'not a txid' })],
    ])('%s', async (_, change) => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)

      expect(await causeOf(() => check(explorer, [change(input!)]))).toBe('mismatch')
      expect(explorer.started).toEqual([])
      expect(explorer.tipReads).toBe(0)
    })

    it('an output spent twice', async () => {
      const explorer = new ClassifyReadsExplorer()
      const [input] = funded(explorer, 1)

      expect(await causeOf(() => check(explorer, [input!, { ...input! }]))).toBe('mismatch')
      expect(explorer.started).toEqual([])
    })
  })

  describe('the walk of unconfirmed change', () => {
    /** An unconfirmed transaction paying the account 20,000 at index 0, its inputs `vin`. */
    function unconfirmed(
      explorer: ClassifyReadsExplorer,
      txid: string,
      vin: Record<string, unknown>[]
    ) {
      explorer.addTx(txid, {
        vin,
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
      })
      return { txid, vout: 0, satoshis: 20_000, scriptPk: ACCOUNT_SCRIPT }
    }

    it.each([
      [
        'an input without the script it spends',
        (parent: string) => [{ txid: parent, vout: 0, is_coinbase: false, prevout: {} }],
      ],
      [
        'an input with no valid txid',
        () => [
          {
            txid: 'not a txid',
            vout: 0,
            is_coinbase: false,
            prevout: { scriptpubkey: ACCOUNT_SCRIPT, value: 30_000 },
          },
        ],
      ],
      ['no input at all', () => []],
    ])('reports %s as could not be checked, not as someone else’s', async (_, vin) => {
      const explorer = new ClassifyReadsExplorer()
      const input = unconfirmed(explorer, testTxid(1, 960), vin(testTxid(2, 960)))

      expect(await causeOf(() => check(explorer, [input]))).toBe('unchecked')
    })

    it('refuses own change with as many unconfirmed transactions before it as qbit Core allows as not spendable yet', async () => {
      const explorer = new ClassifyReadsExplorer()
      const root = testTxid(0, 961)
      explorer.addTx(root, {
        vin: [explorer.input(testTxid(0, 962), 0)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 30_000 }],
        confirmed: true,
      })
      // 25 unconfirmed transactions of own change, each spending the one before.
      let previous = root
      let input: QbitSpendInput | undefined
      for (let index = 1; index <= 25; index += 1) {
        const txid = testTxid(index, 961)
        input = unconfirmed(explorer, txid, [explorer.input(previous, 0, 30_000)])
        previous = txid
      }

      let failure: unknown
      try {
        await check(explorer, [input!])
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(QbitSpendInputCheckError)
      expect((failure as QbitSpendInputCheckError).problem).toBe('not_spendable')
      expect(String((failure as Error).message)).toContain('too many unconfirmed ancestors')
    })

    it('rides out a server error on an ancestor of own unconfirmed change when it rides out server errors, and only then', async () => {
      for (const rideOut of [true, false]) {
        const explorer = new ClassifyReadsExplorer()
        const parent = testTxid(1, 963 + (rideOut ? 0 : 1))
        explorer.addTx(parent, {
          vin: [explorer.input(testTxid(3, 963), 0)],
          outputs: [{ script: ACCOUNT_SCRIPT, value: 30_000 }],
          confirmed: true,
        })
        const input = unconfirmed(explorer, testTxid(2, 963 + (rideOut ? 0 : 1)), [
          explorer.input(parent, 0, 30_000),
        ])
        // The parent's first lookup answers 502; every later one answers.
        const getTx = explorer.client.getTx
        let failed = false
        explorer.client.getTx = (txid: string, options?: { signal?: AbortSignal }) => {
          if (txid === parent && !failed) {
            failed = true
            return Promise.reject(new QbitApiError('http', 'HTTP 502', { status: 502 }))
          }
          return getTx(txid, options)
        }

        expect(
          await causeOf(() =>
            check(explorer, [input], rideOut ? { rideOutServerErrors: true } : {})
          )
        ).toBe(rideOut ? 'passed' : 'unchecked')
      }
    })
  })

  describe('coinbase inputs', () => {
    it('reports a tip below the block of the coinbase it judges as could not be checked', async () => {
      const explorer = new ClassifyReadsExplorer()
      const coinbase = reward(explorer, explorer.tipHeight + 5)

      expect(await causeOf(() => check(explorer, [coinbase]))).toBe('unchecked')
    })

    it('refuses an unconfirmed coinbase as not spendable', async () => {
      const explorer = new ClassifyReadsExplorer()
      const coinbase = reward(explorer, 100)
      explorer.txs.get(coinbase.txid)!['status'] = { confirmed: false }

      expect(await causeOf(() => check(explorer, [coinbase]))).toBe('not_spendable')
    })

    it('reports a confirmed coinbase answer without its height as could not be checked', async () => {
      const explorer = new ClassifyReadsExplorer()
      const coinbase = reward(explorer, 100)
      explorer.txs.get(coinbase.txid)!['status'] = { confirmed: true }

      expect(await causeOf(() => check(explorer, [coinbase]))).toBe('unchecked')
    })
  })

  it('keeps what it checked under that outpoint alone: a strict read of another output of it reads it', async () => {
    const explorer = new ClassifyReadsExplorer()
    const fundingTxReads = new QbitFundingTxReads()
    const txid = testTxid(1, 950)
    explorer.addTx(txid, {
      vin: [explorer.input(testTxid(2, 950), 0)],
      outputs: [
        { script: ACCOUNT_SCRIPT, value: 11_111 },
        { script: ACCOUNT_SCRIPT, value: 22_222 },
      ],
      confirmed: true,
    })
    await check(explorer, [{ txid, vout: 0, satoshis: 11_111, scriptPk: ACCOUNT_SCRIPT }], {
      fundingTxReads,
    })
    explorer.list(address, {
      txid,
      vout: 1,
      value: 22_222,
      status: { confirmed: true, block_height: 100 },
    })
    const before = explorer.readsOf(txid)

    const utxos = await getQbitAddressUtxos(explorer.client as any, address, { fundingTxReads })

    expect(explorer.readsOf(txid) - before).toBe(1)
    expect(utxos.find(utxo => utxo.vout === 1)?.satoshis).toBe(22_222)
  })

  it('refuses an input of a transaction the caller holds that pays another script, with no lookup', async () => {
    const explorer = new ClassifyReadsExplorer()
    const ownTxid = testTxid(1, 951)

    expect(
      await causeOf(() =>
        check(explorer, [{ txid: ownTxid, vout: 0, satoshis: 40_000, scriptPk: ACCOUNT_SCRIPT }], {
          ownTransactions: new Map([[ownTxid, [{ value: 40_000, script: FOREIGN_SCRIPT }]]]),
        })
      )
    ).toBe('mismatch')
    expect(explorer.started).toEqual([])
  })

  it('stops by itself after 60 s when given no deadline', async () => {
    expect(QBIT_SPEND_CHECK_DEADLINE_MS).toBe(60_000)
    vi.useFakeTimers()
    try {
      const explorer = new ClassifyReadsExplorer()
      const inputs = funded(explorer, 2)
      explorer.hold()
      let cause: string | undefined
      void causeOf(() => check(explorer, inputs)).then(found => (cause = found))

      await vi.advanceTimersByTimeAsync(59_999)
      expect(cause).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(cause).toBe('unchecked')
      expect(explorer.inFlight).toBe(0)
      explorer.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no deadline and no listener behind when it cannot begin its reads', async () => {
    vi.useFakeTimers()
    try {
      const explorer = new ClassifyReadsExplorer()
      const inputs = funded(explorer, 1)
      const fundingTxReads = new QbitFundingTxReads()
      vi.spyOn(fundingTxReads, 'begin').mockImplementation(() => {
        throw new Error('the shared reader cannot begin')
      })
      const caller = new AbortController()
      const added = vi.spyOn(caller.signal, 'addEventListener')
      const removed = vi.spyOn(caller.signal, 'removeEventListener')

      expect(
        await causeOf(() => check(explorer, inputs, { fundingTxReads, signal: caller.signal }))
      ).toBe('unchecked')
      expect(vi.getTimerCount()).toBe(0)
      expect(added).toHaveBeenCalledTimes(1)
      expect(removed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the candidate read of the outputs a send may select (#210)', () => {
  /** 20,000 deep outputs, 5 young ones, and 2 of unconfirmed change on one confirmed parent. */
  function largeAccount(): ClassifyReadsExplorer {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 20_000)
    explorer.fund(address, 5, { salt: 200, young: true })
    const parent = testTxid(1, 300)
    explorer.addTx(parent, {
      vin: [explorer.input(testTxid(2, 300), 0)],
      outputs: [],
      confirmed: true,
    })
    for (const index of [0, 1]) {
      const txid = testTxid(index, 301)
      explorer.addTx(txid, {
        vin: [explorer.input(parent, index, 30_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
      })
      explorer.list(address, { txid, vout: 0, value: 20_000, status: { confirmed: false } })
    }
    return explorer
  }

  it('lists 20,000 deep outputs with no lookup, reading only its young and unconfirmed outputs', async () => {
    const explorer = largeAccount()

    const { utxos } = await readQbitAddressUtxos(explorer.client as any, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(utxos).toHaveLength(20_007)
    // The 5 young outputs, the 2 of change, and the parent their walk reads.
    expect(explorer.started).toHaveLength(8)
    // Each deep one carries its listed value and the address's own script.
    const deep = utxos.find(utxo => utxo.txid === testTxid(17, 0))!
    expect(deep).toMatchObject({ satoshis: 10_017, scriptPk: ACCOUNT_SCRIPT })
  })

  it('leaves every other read of outputs reading each one, as before', async () => {
    const explorer = largeAccount()

    const utxos = await getQbitAddressUtxos(explorer.client as any, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(utxos).toHaveLength(20_007)
    expect(explorer.started).toHaveLength(20_008)
  })
})
