import { QBIT_P2MR_DUST } from '../constants/common'
import type { QbitUnconfirmedAncestor } from '../types/create-tx'
import {
  QBIT_MIN_RELAY_FEE_RATE,
  estimateQbitP2mrTransaction,
  qbitMaximumTotalFee,
  type QbitP2mrTransactionEstimate,
} from './qbit-p2mr-fees'

/**
 * qbit Core's `MAX_STANDARD_TX_WEIGHT`. With `WITNESS_SCALE_FACTOR = 1` a
 * transaction's weight is its serialized size, so this caps the exact
 * finalized vsize; anything larger is refused for relay as `tx-size`. A
 * single-key P2MR input is 3,762 bytes, so a one- or two-output transaction
 * carries at most 106 of them.
 */
export const QBIT_MAX_STANDARD_TX_WEIGHT = 400_000

export function isQbitStandardTxSize(vsize: number): boolean {
  return Number.isSafeInteger(vsize) && vsize > 0 && vsize <= QBIT_MAX_STANDARD_TX_WEIGHT
}

/**
 * qbit Core's `DEFAULT_ANCESTOR_SIZE_LIMIT_KVB{404}` (`src/policy/policy.h`)
 * in vbytes: a transaction and all of its in-mempool ancestors may total at
 * most this much, or the node refuses it as `too-long-mempool-chain`. Its
 * `DEFAULT_DESCENDANT_SIZE_LIMIT_KVB` is also 404, and each ancestor's
 * descendants the wallet knows of lie in the same package, so this one budget
 * covers them too. Spends of an ancestor's other outputs stay invisible here.
 * A parent near the standard weight leaves room for about one more input.
 */
export const QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT = 404_000

/** The outpoint fields coin selection reads; wallet UTXO records satisfy it. */
export interface QbitSelectableCoin {
  txid: string
  vout: number
  satoshis: number
  /** The account's own unconfirmed change; absent for a confirmed output. */
  unconfirmed?: boolean
  /**
   * With `unconfirmed`: the change's own transaction and each unconfirmed
   * ancestor of it. Change without a readable list is never selected.
   */
  unconfirmedAncestors?: readonly QbitUnconfirmedAncestor[]
}

const QBIT_TXID_PATTERN = /^[0-9a-f]{64}$/i

function isQbitUnconfirmedAncestor(ancestor: unknown): ancestor is QbitUnconfirmedAncestor {
  const { txid, vsize } = (ancestor ?? {}) as { txid?: unknown; vsize?: unknown }
  return (
    typeof txid === 'string' &&
    QBIT_TXID_PATTERN.test(txid) &&
    typeof vsize === 'number' &&
    Number.isSafeInteger(vsize) &&
    vsize > 0
  )
}

/**
 * `ancestors` (txid to vsize) together with the unconfirmed transactions a
 * spend of `coin` builds on; the same map for a confirmed output. Undefined
 * when unconfirmed change does not list a readable ancestry that includes its
 * own transaction, since the package it would join cannot then be sized.
 */
function withUnconfirmedAncestors(
  ancestors: ReadonlyMap<string, number>,
  coin: QbitSelectableCoin
): ReadonlyMap<string, number> | undefined {
  if (!coin.unconfirmed) return ancestors
  const listed = coin.unconfirmedAncestors
  if (
    !Array.isArray(listed) ||
    !listed.every(isQbitUnconfirmedAncestor) ||
    !listed.some(ancestor => ancestor.txid.toLowerCase() === coin.txid.toLowerCase())
  ) {
    return undefined
  }
  const joined = new Map(ancestors)
  for (const ancestor of listed) joined.set(ancestor.txid.toLowerCase(), ancestor.vsize)
  return joined
}

function totalVsize(ancestors: ReadonlyMap<string, number>): number {
  let total = 0
  for (const vsize of ancestors.values()) total += vsize
  return total
}

/** The transaction every candidate selection shares, apart from its inputs and change. */
export interface QbitP2mrSelectionShape {
  /** Recipient and memo output script lengths, in output order. */
  outputScriptLengths: readonly number[]
  leafScriptLength: number
  controlBlockLength: number
  /** Rates below 1 sat/vB use the wallet's 1 sat/vB relay floor. */
  feeRate: number
}

function estimate(
  shape: QbitP2mrSelectionShape,
  inputCount: number,
  outputScriptLengths: readonly number[] = shape.outputScriptLengths
): QbitP2mrTransactionEstimate {
  return estimateQbitP2mrTransaction({
    inputCount,
    outputScriptLengths,
    leafScriptLength: shape.leafScriptLength,
    controlBlockLength: shape.controlBlockLength,
    feeRate: shape.feeRate,
  })
}

/** The most inputs a transaction of this shape can carry within the standard weight. */
export function qbitP2mrMaxStandardInputCount(
  shape: Omit<QbitP2mrSelectionShape, 'feeRate'>
): number {
  const sized = { ...shape, feeRate: QBIT_MIN_RELAY_FEE_RATE }
  const one = estimate(sized, 1).vsize
  const perInput = estimate(sized, 2).vsize - one
  let count = Math.max(0, Math.floor((QBIT_MAX_STANDARD_TX_WEIGHT - one) / perInput) + 1)
  // The input-count prefix widens past 252 inputs; step back over it.
  while (count > 0 && !isQbitStandardTxSize(estimate(sized, count).vsize)) count -= 1
  return count
}

/** Fee one more input adds at the shape's rate: the input penalty of effective value. */
export function qbitP2mrInputFee(shape: QbitP2mrSelectionShape): number {
  const { inputVsize } = estimate(shape, 1)
  return inputVsize * Math.max(QBIT_MIN_RELAY_FEE_RATE, shape.feeRate)
}

/** Highest value first; ties by txid then vout, so every caller orders alike. */
export function sortQbitCoinsByValue<T extends QbitSelectableCoin>(coins: readonly T[]): T[] {
  return [...coins].sort((left, right) => {
    if (left.satoshis !== right.satoshis) return right.satoshis - left.satoshis
    const txidOrder = left.txid.localeCompare(right.txid)
    return txidOrder === 0 ? left.vout - right.vout : txidOrder
  })
}

export interface QbitP2mrSendCandidate {
  /** Exact fee the transaction pays, including any sub-dust remainder folded into it. */
  fee: number
  estimate: QbitP2mrTransactionEstimate
  inputCount: number
  changeDroppedSats: number
  maximumTotalFee: number
}

export type QbitP2mrSendSelection<T extends QbitSelectableCoin> =
  | (QbitP2mrSendCandidate & {
      ok: true
      selected: T[]
      change: number
      includeChange: boolean
    })
  | {
      ok: false
      reason:
        | 'insufficient_balance'
        | 'exceeds_maximum_total_fee'
        | 'exceeds_standard_size'
        | 'exceeds_ancestor_size'
      /** The closest selection the wallet could price, for previews. */
      candidate?: QbitP2mrSendCandidate
      /** Inputs the standard weight allows for this shape. */
      maxInputCount: number
      /** Most the recipient can receive in one standard transaction (send-all of the largest inputs). */
      maxStandardAmount: number
    }

/**
 * Choose inputs for a payment of `amount`. Inputs are ranked by effective
 * value (value minus the fee the input itself adds), and inputs that cannot
 * pay for themselves are skipped. Taking the largest first reaches the
 * amount with the fewest inputs; since every single-key P2MR input costs the
 * same 3,762 vB, that is also the lowest fee. The first prefix that covers
 * the amount wins: with standard change, or without change when the
 * remainder is below dust and is paid as fee. A prefix whose folded fee
 * would cross the safety ceiling is passed over so that a further input can
 * turn the remainder into change. Selection never exceeds the standard
 * weight; an amount that only more inputs could reach reports
 * `exceeds_standard_size` together with the largest standard send.
 *
 * Confirmed outputs are taken before the account's own unconfirmed change,
 * so an earlier payment keeps no descendant and can still be fee-bumped.
 * When that order cannot build a standard transaction, every output is
 * ranked by value alone. Either way a selection holding change stays within
 * `QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT` together with the change's unconfirmed
 * ancestors: change that would pass it is skipped. A send that only that
 * limit stops reports `exceeds_ancestor_size`; it goes through once the
 * ancestors confirm.
 */
export function selectQbitP2mrSendCoins<T extends QbitSelectableCoin>(
  params: QbitP2mrSelectionShape & {
    utxos: readonly T[]
    amount: number
    changeScriptLength: number
  }
): QbitP2mrSendSelection<T> {
  const { utxos, amount, changeScriptLength, ...shape } = params
  const inputFee = qbitP2mrInputFee(shape)
  const byValue = sortQbitCoinsByValue(utxos.filter(utxo => utxo.satoshis > inputFee))
  const select = (candidates: readonly T[], ancestorLimit?: { reached: boolean }) =>
    selectQbitP2mrSendCoinsInOrder(
      shape,
      candidates,
      amount,
      changeScriptLength,
      utxos.length,
      ancestorLimit
    )
  if (!byValue.some(utxo => utxo.unconfirmed)) return select(byValue)
  const confirmedFirst = [
    ...byValue.filter(utxo => !utxo.unconfirmed),
    ...byValue.filter(utxo => utxo.unconfirmed),
  ]
  const ancestorLimit = { reached: false }
  const preferred = select(confirmedFirst, ancestorLimit)
  if (preferred.ok) return preferred
  const ranked = select(byValue, ancestorLimit)
  if (ranked.ok) return ranked
  if (ancestorLimit.reached && (select(confirmedFirst).ok || select(byValue).ok)) {
    // No candidate: none that was priced can be sent before the ancestors confirm.
    return {
      ok: false,
      reason: 'exceeds_ancestor_size',
      maxInputCount: ranked.maxInputCount,
      maxStandardAmount: ranked.maxStandardAmount,
    }
  }
  return ranked
}

/**
 * The first prefix of `candidates` that pays `amount`, as described above.
 * Unconfirmed ancestors count only with `ancestorLimit`, which records
 * whether they stopped the pass; without it the pass tells whether they
 * alone stand in the way.
 */
function selectQbitP2mrSendCoinsInOrder<T extends QbitSelectableCoin>(
  shape: QbitP2mrSelectionShape,
  candidates: readonly T[],
  amount: number,
  changeScriptLength: number,
  utxoCount: number,
  ancestorLimit: { reached: boolean } | undefined
): QbitP2mrSendSelection<T> {
  const changeOutputs = [...shape.outputScriptLengths, changeScriptLength]
  const selected: T[] = []
  let selectedSatoshis = 0
  let ancestors: ReadonlyMap<string, number> = new Map()
  let ancestorVsize = 0
  let overMaximum: QbitP2mrSendCandidate | undefined
  let lastNoChange: QbitP2mrSendCandidate | undefined
  let reachedStandardSize = false
  for (const utxo of candidates) {
    const inputCount = selected.length + 1
    const withoutChange = estimate(shape, inputCount)
    if (!isQbitStandardTxSize(withoutChange.vsize)) {
      reachedStandardSize = true
      break
    }
    const withChange = estimate(shape, inputCount, changeOutputs)
    const change = selectedSatoshis + utxo.satoshis - amount - withChange.fee
    if (change >= QBIT_P2MR_DUST && !isQbitStandardTxSize(withChange.vsize)) {
      // Real change is owed but its output no longer fits; only a sub-dust
      // remainder may ever be folded into the fee.
      reachedStandardSize = true
      break
    }
    if (ancestorLimit) {
      // A longer prefix keeps these ancestors and only adds inputs.
      if (ancestorVsize + withoutChange.vsize > QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT) {
        ancestorLimit.reached = true
        break
      }
      const joined = withUnconfirmedAncestors(ancestors, utxo)
      const joinedVsize =
        joined === ancestors ? ancestorVsize : joined ? totalVsize(joined) : Infinity
      const vsize = change >= QBIT_P2MR_DUST ? withChange.vsize : withoutChange.vsize
      if (!joined || joinedVsize + vsize > QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT) {
        // An output that does not bring these ancestors may still fit.
        ancestorLimit.reached = true
        continue
      }
      ancestors = joined
      ancestorVsize = joinedVsize
    }
    selected.push(utxo)
    selectedSatoshis += utxo.satoshis

    if (change >= QBIT_P2MR_DUST) {
      return {
        ok: true,
        selected: [...selected],
        fee: withChange.fee,
        change,
        includeChange: true,
        estimate: withChange,
        inputCount,
        changeDroppedSats: 0,
        maximumTotalFee: qbitMaximumTotalFee(withChange.vsize),
      }
    }

    const maximumTotalFee = qbitMaximumTotalFee(withoutChange.vsize)
    lastNoChange = {
      fee: withoutChange.fee,
      estimate: withoutChange,
      inputCount,
      changeDroppedSats: 0,
      maximumTotalFee,
    }
    if (selectedSatoshis >= amount + withoutChange.fee) {
      // A sub-dust remainder cannot be returned as standard change, so it is paid as fee.
      const fee = selectedSatoshis - amount
      const candidate = {
        fee,
        estimate: withoutChange,
        inputCount,
        changeDroppedSats: fee - withoutChange.fee,
        maximumTotalFee,
      }
      if (fee > maximumTotalFee) {
        overMaximum ??= candidate
        continue
      }
      return { ok: true, selected: [...selected], change: 0, includeChange: false, ...candidate }
    }
  }

  if (!lastNoChange && utxoCount > 0) {
    // Nothing was worth spending; price the smallest such send so the
    // preview can still name its exact fee ceiling.
    const smallest = estimate(shape, 1)
    lastNoChange = {
      fee: smallest.fee,
      estimate: smallest,
      inputCount: 1,
      changeDroppedSats: 0,
      maximumTotalFee: qbitMaximumTotalFee(smallest.vsize),
    }
  }
  const sendAll = selectQbitP2mrSendAllCoins({ ...shape, utxos: candidates })
  const failure = {
    ok: false as const,
    maxInputCount: sendAll.maxInputCount,
    maxStandardAmount: Math.max(0, sendAll.amount),
  }
  if (overMaximum) {
    return { ...failure, reason: 'exceeds_maximum_total_fee', candidate: overMaximum }
  }
  const closest = lastNoChange ? { candidate: lastNoChange } : {}
  if (reachedStandardSize) {
    const total = candidates.reduce((sum, utxo) => sum + utxo.satoshis, 0)
    if (total >= amount + estimate(shape, candidates.length).fee) {
      return { ...failure, ...closest, reason: 'exceeds_standard_size' }
    }
  }
  return { ...failure, ...closest, reason: 'insufficient_balance' }
}

export interface QbitP2mrSendAllSelection<T extends QbitSelectableCoin> {
  /** The largest inputs, up to the standard weight; empty when there is nothing to spend. */
  selected: T[]
  /** Inputs the standard weight keeps out of this transaction; they stay in the account. */
  leftBehind: T[]
  leftBehindSatoshis: number
  /**
   * `selected` holds unconfirmed change, and this transaction with the
   * change's unconfirmed ancestors would pass `QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT`
   * (or the ancestors cannot be sized). It must wait for them to confirm.
   */
  exceedsAncestorSize: boolean
  totalInput: number
  /** Exact fee for `selected`, or 0 when nothing is selected. */
  fee: number
  /** What the single output receives: `totalInput - fee` (may be below dust or negative). */
  amount: number
  estimate?: QbitP2mrTransactionEstimate
  maximumTotalFee: number
  maxInputCount: number
}

/**
 * Choose inputs for sending the whole balance to one output. Every input is
 * spent when the standard weight allows; otherwise the highest-value inputs
 * fill the transaction and the rest are reported as left behind.
 */
export function selectQbitP2mrSendAllCoins<T extends QbitSelectableCoin>(
  params: QbitP2mrSelectionShape & { utxos: readonly T[] }
): QbitP2mrSendAllSelection<T> {
  const { utxos, ...shape } = params
  const maxInputCount = qbitP2mrMaxStandardInputCount(shape)
  const sorted = sortQbitCoinsByValue(utxos)
  const selected = sorted.slice(0, maxInputCount)
  const leftBehind = sorted.slice(maxInputCount)
  const totalInput = selected.reduce((sum, utxo) => sum + utxo.satoshis, 0)
  const leftBehindSatoshis = leftBehind.reduce((sum, utxo) => sum + utxo.satoshis, 0)
  if (selected.length === 0) {
    return {
      selected,
      leftBehind,
      leftBehindSatoshis,
      exceedsAncestorSize: false,
      totalInput,
      fee: 0,
      amount: 0,
      maximumTotalFee: 0,
      maxInputCount,
    }
  }
  const sized = estimate(shape, selected.length)
  let ancestors: ReadonlyMap<string, number> | undefined = new Map()
  for (const utxo of selected) ancestors = ancestors && withUnconfirmedAncestors(ancestors, utxo)
  return {
    selected,
    leftBehind,
    leftBehindSatoshis,
    exceedsAncestorSize:
      !ancestors || totalVsize(ancestors) + sized.vsize > QBIT_MEMPOOL_ANCESTOR_SIZE_LIMIT,
    totalInput,
    fee: sized.fee,
    amount: totalInput - sized.fee,
    estimate: sized,
    maximumTotalFee: qbitMaximumTotalFee(sized.vsize),
    maxInputCount,
  }
}
