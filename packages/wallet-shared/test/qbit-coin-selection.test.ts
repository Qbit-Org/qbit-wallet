import { describe, expect, it } from 'vitest'

import {
  QBIT_MAX_STANDARD_TX_WEIGHT,
  QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT,
  isQbitStandardTxSize,
  qbitP2mrMaxStandardInputCount,
  selectQbitP2mrSendAllCoins,
  selectQbitP2mrSendCoins,
} from '../src/utils/qbit-coin-selection'
import { estimateQbitP2mrTransaction } from '../src/utils/qbit-p2mr-fees'

const P2MR_SCRIPT = 34
const SHAPE = {
  outputScriptLengths: [P2MR_SCRIPT],
  leafScriptLength: 34,
  controlBlockLength: 1,
}

function coin(index: number, satoshis: number) {
  return { txid: index.toString(16).padStart(64, '0'), vout: index % 4, satoshis }
}

function coins(count: number, satoshis: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => coin(offset + index, satoshis))
}

describe('qbit P2MR standard transaction size', () => {
  // Probe B: 106 single-key inputs fit qbit Core's 400,000 WU limit; 107 do not.
  it('caps a one- or two-output transaction at 106 inputs', () => {
    const twoOutputs = { ...SHAPE, outputScriptLengths: [P2MR_SCRIPT, P2MR_SCRIPT] }
    expect(estimateQbitP2mrTransaction({ ...twoOutputs, inputCount: 106 }).vsize).toBe(398_870)
    expect(estimateQbitP2mrTransaction({ ...twoOutputs, inputCount: 107 }).vsize).toBe(402_632)
    expect(isQbitStandardTxSize(398_870)).toBe(true)
    expect(isQbitStandardTxSize(QBIT_MAX_STANDARD_TX_WEIGHT)).toBe(true)
    expect(isQbitStandardTxSize(402_632)).toBe(false)

    expect(qbitP2mrMaxStandardInputCount(SHAPE)).toBe(106)
    expect(qbitP2mrMaxStandardInputCount(twoOutputs)).toBe(106)
  })
})

describe('selectQbitP2mrSendCoins', () => {
  const sendShape = { ...SHAPE, changeScriptLength: P2MR_SCRIPT }

  // Probe F: twenty 5,000-bit payouts listed before one 1,000,000-bit output.
  const probeF = [...coins(20, 5_000), coin(20, 1_000_000)]

  it('spends the one large output instead of every small one listed before it', () => {
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: probeF,
      amount: 50_000,
      feeRate: 1,
    })
    expect(selection).toMatchObject({
      ok: true,
      inputCount: 1,
      fee: 3_860,
      change: 1_000_000 - 50_000 - 3_860,
      includeChange: true,
    })
    expect(selection.ok && selection.selected).toEqual([coin(20, 1_000_000)])
  })

  it('still covers the send at a rate where the small outputs cost more than they carry', () => {
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: probeF,
      amount: 50_000,
      feeRate: 50,
    })
    expect(selection).toMatchObject({ ok: true, inputCount: 1, fee: 193_000 })
  })

  it('skips outputs worth no more than the fee they add', () => {
    // Listed first, the 3,000- and 3,762-bit outputs would each cost at least
    // what they carry; neither is spent.
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: [coin(1, 3_000), coin(2, 3_762), coin(3, 20_000)],
      amount: 10_000,
      feeRate: 1,
    })
    expect(selection).toMatchObject({ ok: true, inputCount: 1, fee: 3_860, change: 6_140 })
    expect(selection.ok && selection.selected).toEqual([coin(3, 20_000)])
  })

  it('refuses an amount only more than 106 inputs could reach and names the largest standard send', () => {
    // Probe B: a send needing 113 small inputs.
    const utxos = coins(150, 10_000)
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos,
      amount: 700_000,
      feeRate: 1,
    })
    const largestSend =
      106 * 10_000 - estimateQbitP2mrTransaction({ ...SHAPE, inputCount: 106 }).fee
    expect(selection).toMatchObject({
      ok: false,
      reason: 'exceeds_standard_size',
      maxInputCount: 106,
      maxStandardAmount: largestSend,
    })

    const reachable = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos,
      amount: largestSend,
      feeRate: 1,
    })
    expect(reachable).toMatchObject({ ok: true, inputCount: 106, includeChange: false })
    expect(reachable.ok && isQbitStandardTxSize(reachable.estimate.vsize)).toBe(true)
  })

  it('never folds real change into the fee when the change output would not fit', () => {
    // A 1,120-byte second output leaves room for 106 inputs without change
    // (399,958 vB) but not with it (400,001 vB).
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      outputScriptLengths: [P2MR_SCRIPT, 1_120],
      utxos: coins(106, 10_000),
      amount: 655_000,
      feeRate: 1,
    })
    // 106 inputs would owe 4,999 bits of change; it is never paid as fee.
    expect(selection).toMatchObject({ ok: false, reason: 'exceeds_standard_size' })
  })

  it('reports a plain shortfall when even every output could not cover the amount', () => {
    expect(
      selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: coins(150, 10_000),
        amount: 1_500_000,
        feeRate: 1,
      })
    ).toMatchObject({ ok: false, reason: 'insufficient_balance' })
  })

  describe('own unconfirmed change', () => {
    const change = (index: number, satoshis: number) => ({
      ...coin(index, satoshis),
      unconfirmed: true,
      unconfirmedAncestors: [{ txid: coin(index, 0).txid, vsize: 3_860 }],
    })
    const selectedTxids = (selection: ReturnType<typeof selectQbitP2mrSendCoins>) =>
      selection.ok ? selection.selected.map(utxo => utxo.txid) : []

    it('spends a confirmed output that covers the send before larger unconfirmed change', () => {
      const selection = selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: [change(0, 80_000), coin(1, 50_000)],
        amount: 20_000,
        feeRate: 1,
      })
      expect(selectedTxids(selection)).toEqual([coin(1, 0).txid])
    })

    it('adds unconfirmed change only once the confirmed outputs fall short', () => {
      const selection = selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: [change(0, 30_000), coin(1, 4_000)],
        amount: 20_000,
        feeRate: 1,
      })
      expect(selectedTxids(selection)).toEqual([coin(1, 0).txid, coin(0, 0).txid])
    })

    it('ranks every output by value when confirmed outputs first would exceed the standard size', () => {
      // 106 confirmed 5,000-bit outputs net too little to pay 500,000; the
      // change alone pays it.
      const selection = selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: [...coins(106, 5_000), change(106, 1_000_000)],
        amount: 500_000,
        feeRate: 1,
      })
      expect(selection).toMatchObject({ ok: true, inputCount: 1 })
      expect(selectedTxids(selection)).toEqual([coin(106, 0).txid])
    })
  })
})

// A send of `inputCount` inputs that pays one P2MR output and returns change.
const withChangeVsize = (inputCount: number) =>
  estimateQbitP2mrTransaction({
    ...SHAPE,
    outputScriptLengths: [P2MR_SCRIPT, P2MR_SCRIPT],
    inputCount,
  }).vsize

/** Change of an unconfirmed transaction of `vsize` with no unconfirmed ancestor. */
function changeOf(parent: number, vsize: number, satoshis: number, vout = 1) {
  const txid = parent.toString(16).padStart(2, '0').repeat(32)
  return {
    txid,
    vout,
    satoshis,
    unconfirmed: true,
    unconfirmedAncestors: [{ txid, vsize }],
  }
}

describe('unconfirmed ancestor size limit (#345)', () => {
  const sendShape = { ...SHAPE, changeScriptLength: P2MR_SCRIPT, feeRate: 1 }
  // Send #1 spent 105 inputs and left change: about 395 kB, still unconfirmed.
  const parent105 = withChangeVsize(105)
  const parent106 = withChangeVsize(106)
  const packageVsize = (selection: ReturnType<typeof selectQbitP2mrSendCoins>, parent: number) =>
    selection.ok ? parent + selection.estimate.vsize : NaN

  it("uses qbit Core's 404 kvB limit", () => {
    expect(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT).toBe(404_000)
    expect(parent105).toBe(395_108)
    expect(parent106).toBe(398_870)
  })

  it('refuses a send that needs 45 confirmed outputs plus the change of a 105-input parent', () => {
    const utxos = [...coins(45, 100_000), changeOf(0xaa, parent105, 1_000_000)]
    // Unbounded, that send has 46 inputs, about 173 kB: a 568 kB package.
    expect(withChangeVsize(46)).toBe(173_150)
    expect(parent105 + withChangeVsize(46)).toBeGreaterThan(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT)

    const selection = selectQbitP2mrSendCoins({ ...sendShape, utxos, amount: 4_500_000 })
    expect(selection).toMatchObject({ ok: false, reason: 'exceeds_ancestor_size' })
    // Nothing priced can go out now, so no fee or ceiling is offered for it.
    expect(selection).not.toHaveProperty('candidate')
  })

  it('spends the change of a 105-input parent with one more input, not two', () => {
    expect(parent105 + withChangeVsize(2)).toBeLessThanOrEqual(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT)
    expect(parent105 + withChangeVsize(3)).toBeGreaterThan(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT)
    const change = changeOf(0xaa, parent105, 1_000_000)

    const fits = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: [coin(1, 100_000), change],
      amount: 1_050_000,
    })
    expect(fits).toMatchObject({ ok: true, inputCount: 2, includeChange: true })
    expect(packageVsize(fits, parent105)).toBeLessThanOrEqual(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT)

    const tooBig = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: [coin(1, 100_000), coin(2, 100_000), change],
      amount: 1_150_000,
    })
    expect(tooBig).toMatchObject({ ok: false, reason: 'exceeds_ancestor_size' })
  })

  it('spends the change of a 106-input parent only on its own', () => {
    const change = changeOf(0xaa, parent106, 1_000_000)
    // Even one extra confirmed input goes past the limit.
    expect(
      selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: [coin(1, 100_000), change],
        amount: 1_050_000,
      })
    ).toMatchObject({ ok: false, reason: 'exceeds_ancestor_size' })

    // Confirmed first would join both; ranked by value, the change alone pays.
    const alone = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: [coin(1, 100_000), change],
      amount: 900_000,
    })
    expect(alone).toMatchObject({ ok: true, inputCount: 1 })
    expect(alone.ok && alone.selected).toEqual([change])
    expect(packageVsize(alone, parent106)).toBe(402_730)
  })

  it('allows a package of exactly 404,000 vB and nothing over it', () => {
    const own = withChangeVsize(1)
    const at = (ancestorVsize: number) =>
      selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: [changeOf(0xaa, ancestorVsize, 100_000)],
        amount: 50_000,
      })
    expect(at(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT - own)).toMatchObject({ ok: true, inputCount: 1 })
    expect(at(QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT - own + 1)).toMatchObject({
      ok: false,
      reason: 'exceeds_ancestor_size',
    })
  })

  it('passes over change with large ancestors for change with small ones', () => {
    const large = changeOf(0xaa, parent105, 500_000)
    const small = changeOf(0xbb, 4_000, 300_000)
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: [...coins(3, 100_000), large, small],
      amount: 500_000,
    })
    expect(selection).toMatchObject({ ok: true, inputCount: 4 })
    expect(selection.ok && selection.selected).toContain(small)
    expect(selection.ok && selection.selected).not.toContain(large)
  })

  it('counts an ancestor that two selected change outputs share once', () => {
    // Two outputs of one 200 kB transaction: 207,622 vB together, not 407,622.
    const first = changeOf(0xaa, 200_000, 300_000, 0)
    const second = changeOf(0xaa, 200_000, 300_000, 1)
    const selection = selectQbitP2mrSendCoins({
      ...sendShape,
      utxos: [first, second],
      amount: 550_000,
    })
    expect(selection).toMatchObject({ ok: true, inputCount: 2 })
    expect(packageVsize(selection, 200_000)).toBe(207_622)
  })

  it('counts every ancestor the change lists', () => {
    const change = changeOf(0xaa, 200_000, 300_000)
    change.unconfirmedAncestors.push({ txid: 'bb'.repeat(32), vsize: 201_000 })
    expect(
      selectQbitP2mrSendCoins({ ...sendShape, utxos: [change], amount: 100_000 })
    ).toMatchObject({ ok: false, reason: 'exceeds_ancestor_size' })
  })

  it('never selects change whose ancestors cannot be sized', () => {
    const malformed = (unconfirmedAncestors: unknown) => ({
      ...changeOf(0xaa, 4_000, 300_000),
      unconfirmedAncestors: unconfirmedAncestors as { txid: string; vsize: number }[],
    })
    const own = 'aa'.repeat(32)
    for (const change of [
      malformed(undefined),
      malformed([]),
      // Its own transaction is missing from the list.
      malformed([{ txid: 'bb'.repeat(32), vsize: 4_000 }]),
      malformed([{ txid: own, vsize: 0 }]),
      malformed([{ txid: own, vsize: 4_000.5 }]),
      malformed([{ txid: own, vsize: '4000' }]),
      malformed([
        { txid: 'not-a-txid', vsize: 4_000 },
        { txid: own, vsize: 4_000 },
      ]),
      malformed([null, { txid: own, vsize: 4_000 }]),
    ]) {
      expect(
        selectQbitP2mrSendCoins({ ...sendShape, utxos: [change], amount: 100_000 })
      ).toMatchObject({ ok: false, reason: 'exceeds_ancestor_size' })
      // Confirmed outputs that pay on their own are still used.
      expect(
        selectQbitP2mrSendCoins({
          ...sendShape,
          utxos: [coin(1, 200_000), change],
          amount: 100_000,
        })
      ).toMatchObject({ ok: true, inputCount: 1 })
    }
  })

  it('reports a plain shortfall when even confirmed change would not cover the amount', () => {
    expect(
      selectQbitP2mrSendCoins({
        ...sendShape,
        utxos: [coin(1, 100_000), changeOf(0xaa, parent106, 100_000)],
        amount: 500_000,
      })
    ).toMatchObject({ ok: false, reason: 'insufficient_balance' })
  })

  it('flags a send-all whose change and ancestors pass the limit', () => {
    const sendAll = (utxos: ReturnType<typeof changeOf>[] | ReturnType<typeof coin>[]) =>
      selectQbitP2mrSendAllCoins({ ...SHAPE, utxos, feeRate: 1 })

    expect(sendAll(coins(106, 10_000)).exceedsAncestorSize).toBe(false)
    expect(sendAll([changeOf(0xaa, parent106, 100_000)]).exceedsAncestorSize).toBe(false)
    const withConfirmed = sendAll([
      ...coins(2, 100_000),
      changeOf(0xaa, parent105, 100_000),
    ] as ReturnType<typeof changeOf>[])
    expect(withConfirmed.selected).toHaveLength(3)
    expect(withConfirmed.exceedsAncestorSize).toBe(true)
    // Change the standard weight leaves behind does not count.
    const leftBehind = sendAll([
      ...coins(106, 100_000),
      changeOf(0xaa, parent105, 1_000),
    ] as ReturnType<typeof changeOf>[])
    expect(leftBehind.leftBehind).toHaveLength(1)
    expect(leftBehind.exceedsAncestorSize).toBe(false)
    expect(
      sendAll([{ ...changeOf(0xaa, 4_000, 100_000), unconfirmedAncestors: [] }]).exceedsAncestorSize
    ).toBe(true)
  })
})

describe('selectQbitP2mrSendAllCoins', () => {
  it('spends every output when they fit one standard transaction', () => {
    const selection = selectQbitP2mrSendAllCoins({ ...SHAPE, utxos: coins(3, 10_000), feeRate: 1 })
    expect(selection.selected).toHaveLength(3)
    expect(selection.leftBehind).toEqual([])
    expect(selection.leftBehindSatoshis).toBe(0)
  })

  it('fills the transaction with the 106 largest outputs and reports the rest', () => {
    // Probe B: send-all over 150 outputs.
    const small = coins(44, 4_000)
    const large = coins(106, 20_000, 44)
    const selection = selectQbitP2mrSendAllCoins({
      ...SHAPE,
      utxos: [...small, ...large],
      feeRate: 1,
    })
    expect(selection.selected).toHaveLength(106)
    expect(selection.selected.every(utxo => utxo.satoshis === 20_000)).toBe(true)
    expect(selection.leftBehind).toHaveLength(44)
    expect(selection.leftBehindSatoshis).toBe(44 * 4_000)
    expect(selection.estimate?.vsize).toBeLessThanOrEqual(QBIT_MAX_STANDARD_TX_WEIGHT)
    expect(selection.amount).toBe(106 * 20_000 - selection.fee)
  })
})
