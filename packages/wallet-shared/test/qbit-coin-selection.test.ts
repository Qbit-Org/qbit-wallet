import { describe, expect, it } from 'vitest'

import {
  QBIT_MAX_STANDARD_TX_WEIGHT,
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
