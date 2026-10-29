import { useCallback, useMemo } from 'react'
import { useStore } from 'react-redux'

import {
  Account,
  assertQbitFeeRateWithinPolicy,
  canCreateQbitSendRequest,
  QBIT_MAX_FEE_RATE,
  QBIT_P2MR_DUST,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  QbitBroadcastFailure,
  QbitBroadcastResult,
  QbitBroadcastStatusCheck,
  QbitP2mrSendCandidate,
  QbitRetainedBroadcast,
  QbitSendBroadcastClaim,
  QbitUtxoSnapshot,
  ToAddressInfo,
  ToSignData,
  UnspentOutput,
  qbitBroadcastErrorMessage,
  qbitP2mrInputsDominateFee,
  sanitizeQbitBroadcastDetail,
  selectQbitP2mrSendAllCoins,
  selectQbitP2mrSendCoins,
} from '@qbit/wallet-shared'

import { numUtils, timeUtils } from '@qbit/base-utils'
import { ChainType } from '@qbit/wallet-types'
import { AppState, useI18n, useTools } from '..'
import { useWallet } from '../context/WalletContext'
import {
  useAccountAddress,
  useCurrentAccount,
  useCurrentAccountCapabilities,
  useFetchBalanceCallback,
} from '../hooks/accounts'
import { transactionsActions } from '../reducers/transactions'
import { useAppDispatch, useAppSelector } from './base'
import { useChainType, useQbitUnit } from './settings'

export function useTransactionsState(): AppState['transactions'] {
  return useAppSelector(state => state.transactions)
}

export function useQbitTx() {
  const transactionsState = useTransactionsState()
  return transactionsState.qbitTx
}

function hexByteLength(hex?: string): number {
  return hex ? Math.ceil(hex.length / 2) : 0
}

function pushDataLength(dataLength: number): number {
  if (dataLength < 0x4c) return 1
  if (dataLength <= 0xff) return 2
  if (dataLength <= 0xffff) return 3
  return 5
}

/** OP_RETURN standardness cap on embedded memo data. */
export const QBIT_MEMO_MAX_BYTES = 80

/** Byte length of a memo as the wallet controller encodes it (hex text counts as bytes). */
export function qbitMemoByteLength(memo: string): number {
  return /^[0-9a-fA-F]+$/.test(memo) && memo.length % 2 === 0
    ? memo.length / 2
    : new TextEncoder().encode(memo).length
}

function qbitMemoOutputScriptLengths(memo?: string, memos?: string[]): number[] {
  const chunks = memo ? [memo] : memos || []
  if (chunks.length === 0) return []

  const scriptLength = chunks.reduce((sum, chunk) => {
    const dataLength = qbitMemoByteLength(chunk)
    return sum + pushDataLength(dataLength) + dataLength
  }, 1)
  return [scriptLength]
}

export function getQbitP2mrSpendableUtxos(utxos: UnspentOutput[], account: Account) {
  const accountScriptPubKey = account.p2mr?.scriptPubKey.toLowerCase()
  return utxos.filter(utxo => {
    if (!accountScriptPubKey) return true

    const scriptPk = (utxo.scriptPk || account.p2mr!.scriptPubKey).toLowerCase()
    return scriptPk === accountScriptPubKey
  })
}

export function getQbitP2mrSpendableSatoshis(utxos: UnspentOutput[], account: Account) {
  return getQbitP2mrSpendableUtxos(utxos, account).reduce((sum, utxo) => sum + utxo.satoshis, 0)
}

export interface QbitP2mrSendPreflight {
  canCover: boolean
  estimatedFee: number
  inputCount: number
  estimatedVsize: number
  changeDroppedSats: number
  maximumTotalFee: number
  inputsDominateFee: boolean
  exceedsMaximumTotalFee: boolean
  /** The amount needs more inputs than one standard transaction can carry. */
  exceedsStandardSize: boolean
  /** Only the size of the unconfirmed transactions behind the change stops the send. */
  exceedsAncestorSize: boolean
  /** Inputs one standard transaction of this shape can carry. */
  maxInputCount: number
  /** Most one standard transaction can send (the largest inputs, no change). */
  maxStandardAmount: number
}

const EMPTY_SEND_PREFLIGHT: QbitP2mrSendPreflight = {
  canCover: false,
  estimatedFee: 0,
  inputCount: 0,
  estimatedVsize: 0,
  changeDroppedSats: 0,
  maximumTotalFee: 0,
  inputsDominateFee: false,
  exceedsMaximumTotalFee: false,
  exceedsStandardSize: false,
  exceedsAncestorSize: false,
  maxInputCount: 0,
  maxStandardAmount: 0,
}

/** Mirrors the controller's send builder: both price the same shared coin selection. */
export function estimateQbitP2mrSendPreflight({
  utxos,
  account,
  amount,
  feeRate,
  memo,
  memos,
}: {
  utxos: UnspentOutput[]
  account: Account
  amount: number
  feeRate: number
  memo?: string
  memos?: string[]
}): QbitP2mrSendPreflight {
  if (!account.p2mr) return EMPTY_SEND_PREFLIGHT

  const p2mrOutputScriptLength = hexByteLength(account.p2mr.scriptPubKey)
  const selection = selectQbitP2mrSendCoins({
    utxos,
    amount,
    outputScriptLengths: [p2mrOutputScriptLength, ...qbitMemoOutputScriptLengths(memo, memos)],
    changeScriptLength: p2mrOutputScriptLength,
    leafScriptLength: hexByteLength(account.p2mr.leafScript),
    controlBlockLength: QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
    feeRate,
  })
  // `in` narrows the result here, where this package compiles without strict null checks.
  let failure: Extract<typeof selection, { ok: false }> | undefined
  let candidate: QbitP2mrSendCandidate | undefined
  if ('reason' in selection) {
    failure = selection
    candidate = selection.candidate
  } else {
    candidate = selection
  }
  return {
    canCover: !failure || failure.reason === 'exceeds_maximum_total_fee',
    estimatedFee: candidate?.fee ?? 0,
    inputCount: candidate?.inputCount ?? 0,
    estimatedVsize: candidate?.estimate.vsize ?? 0,
    changeDroppedSats: candidate?.changeDroppedSats ?? 0,
    maximumTotalFee: candidate?.maximumTotalFee ?? 0,
    inputsDominateFee: candidate ? qbitP2mrInputsDominateFee(candidate.estimate) : false,
    exceedsMaximumTotalFee: candidate ? candidate.fee > candidate.maximumTotalFee : false,
    exceedsStandardSize: failure?.reason === 'exceeds_standard_size',
    exceedsAncestorSize: failure?.reason === 'exceeds_ancestor_size',
    maxInputCount: failure?.maxInputCount ?? 0,
    maxStandardAmount: failure?.maxStandardAmount ?? 0,
  }
}

/** Mirrors the controller's send-all builder, including the inputs it leaves behind. */
export function estimateQbitP2mrSendAllPreflight({
  utxos,
  account,
  feeRate,
  memo,
  memos,
}: {
  utxos: UnspentOutput[]
  account: Account
  feeRate: number
  memo?: string
  memos?: string[]
}) {
  const empty = {
    canCover: false,
    estimatedFee: 0,
    outputSatoshis: 0,
    inputCount: 0,
    estimatedVsize: 0,
    changeDroppedSats: 0,
    maximumTotalFee: 0,
    inputsDominateFee: false,
    exceedsMaximumTotalFee: false,
    exceedsAncestorSize: false,
    leftBehindInputCount: 0,
    leftBehindSats: 0,
  }
  if (!account.p2mr || utxos.length === 0) return empty

  const selection = selectQbitP2mrSendAllCoins({
    utxos,
    outputScriptLengths: [
      hexByteLength(account.p2mr.scriptPubKey),
      ...qbitMemoOutputScriptLengths(memo, memos),
    ],
    leafScriptLength: hexByteLength(account.p2mr.leafScript),
    controlBlockLength: QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
    feeRate,
  })
  if (!selection.estimate) return empty
  return {
    canCover: selection.amount >= QBIT_P2MR_DUST,
    estimatedFee: selection.fee,
    outputSatoshis: selection.amount,
    inputCount: selection.selected.length,
    estimatedVsize: selection.estimate.vsize,
    changeDroppedSats: 0,
    maximumTotalFee: selection.maximumTotalFee,
    inputsDominateFee: qbitP2mrInputsDominateFee(selection.estimate),
    exceedsMaximumTotalFee: selection.fee > selection.maximumTotalFee,
    // A send-all below dust is short of balance, whatever else stops it.
    exceedsAncestorSize: selection.amount >= QBIT_P2MR_DUST && selection.exceedsAncestorSize,
    leftBehindInputCount: selection.leftBehind.length,
    leftBehindSats: selection.leftBehindSatoshis,
  }
}

export function usePrepareSendQBTCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const fromAddress = useAccountAddress()
  const currentAccount = useCurrentAccount()
  const utxos = useUtxos()
  const chainType = useChainType()
  const fetchUtxos = useFetchUtxosCallback()
  const qbitUnit = useQbitUnit()

  const { t } = useI18n()
  return useCallback(
    async ({
      toAddressInfo,
      toAmount,
      feeRate,
      memo,
      memos,
      disableAutoAdjust,
      enableRBF,
    }: {
      toAddressInfo: ToAddressInfo
      toAmount: number
      feeRate?: number
      memo?: string
      memos?: string[]
      disableAutoAdjust?: boolean
      enableRBF?: boolean
    }) => {
      if (!canCreateQbitSendRequest(currentAccount)) {
        throw new Error(t('not_supported'))
      }
      // The cached outputs are only usable for the account and on the
      // network they were read for. Another account's read, or a network
      // switch in another window, leaves its outputs in the cache (their
      // scriptPubKey is the same on every network); useUtxos reads such a
      // cache as empty, so reload rather than hand another account's or
      // network's outpoints to the builder. The builder checks the chain
      // that travels with them either way.
      let snapshot: QbitUtxoSnapshot = { address: fromAddress, chain: chainType, utxos }
      if (snapshot.utxos.length === 0) {
        snapshot = await fetchUtxos()
      }
      const spendableUtxos = getQbitP2mrSpendableUtxos(snapshot.utxos, currentAccount)
      const safeBalance = spendableUtxos.reduce((pre, cur) => pre + cur.satoshis, 0)
      if (safeBalance < toAmount) {
        throw new Error(t('insufficient_balance'))
      }

      if (feeRate === undefined) {
        const summary = await wallet.getFeeSummary()
        feeRate = summary.list[1]!.feeRate
      }
      assertQbitFeeRateWithinPolicy(feeRate)
      let res: ToSignData

      if (safeBalance === toAmount && !disableAutoAdjust) {
        const preflight = estimateQbitP2mrSendAllPreflight({
          utxos: spendableUtxos,
          account: currentAccount,
          feeRate,
          memo,
          memos,
        })
        if (preflight.exceedsMaximumTotalFee) {
          throw new Error(
            t('fee_exceeds_wallet_safety_maximum', [
              String(QBIT_MAX_FEE_RATE),
              numUtils.satoshisToAmount(preflight.maximumTotalFee),
              qbitUnit,
            ])
          )
        }
        if (preflight.exceedsAncestorSize) {
          throw new Error(t('send_exceeds_ancestor_size'))
        }
        if (!preflight.canCover) {
          throw new Error(t('insufficient_balance'))
        }
        res = await wallet.createSendAllQbitPsbt({
          to: toAddressInfo.address,
          qbitUtxos: spendableUtxos,
          qbitUtxoChain: snapshot.chain,
          feeRate,
          enableRBF,
          memo,
          memos,
        })
      } else {
        const preflight = estimateQbitP2mrSendPreflight({
          utxos: spendableUtxos,
          account: currentAccount,
          amount: toAmount,
          feeRate,
          memo,
          memos,
        })
        if (preflight.exceedsMaximumTotalFee) {
          throw new Error(
            t('fee_exceeds_wallet_safety_maximum', [
              String(QBIT_MAX_FEE_RATE),
              numUtils.satoshisToAmount(preflight.maximumTotalFee),
              qbitUnit,
            ])
          )
        }
        if (preflight.exceedsStandardSize) {
          throw new Error(
            t('send_exceeds_standard_size', [
              String(preflight.maxInputCount),
              numUtils.satoshisToAmount(preflight.maxStandardAmount),
              qbitUnit,
            ])
          )
        }
        if (preflight.exceedsAncestorSize) {
          throw new Error(t('send_exceeds_ancestor_size'))
        }
        if (!preflight.canCover) {
          throw new Error(t('insufficient_balance'))
        }
        res = await wallet.createSendQbitPsbt({
          to: toAddressInfo.address,
          amount: toAmount,
          qbitUtxos: spendableUtxos,
          qbitUtxoChain: snapshot.chain,
          qbitUtxoAddress: snapshot.address,
          feeRate,
          enableRBF,
          memo: memo!,
          memos: memos!,
        })
      }

      return res
    },
    [
      dispatch,
      wallet,
      fromAddress,
      currentAccount.type,
      currentAccount.p2mr,
      utxos,
      chainType,
      fetchUtxos,
      qbitUnit,
      t,
    ]
  )
}

/**
 * Post-success bookkeeping shared by the broadcast and status-check paths:
 * publish the txid to the transaction slice and refresh the balance card.
 */
function useQbitBroadcastSucceededCallback() {
  const dispatch = useAppDispatch()
  const fetchBalance = useFetchBalanceCallback()
  return useCallback(
    (txid: string) => {
      dispatch((transactionsActions as any).updateQbitTx({ txid }))
      // Refetch instead of only expiring: the balance card reads
      // balanceV2Map, which nothing repopulates until the next poll tick.
      const refreshBalance = () => {
        fetchBalance().catch(() => undefined)
      }
      refreshBalance()
      setTimeout(refreshBalance, 2000)
      setTimeout(refreshBalance, 5000)
    },
    [dispatch, fetchBalance]
  )
}

/**
 * Broadcast an already-signed payload and report a structured verdict. Never
 * throws: a failure that escapes the controller (for example a dead port) is
 * reported as `unknown`, because nothing proves the request was not sent.
 */
export function usePushQbitTxCallback() {
  const wallet = useWallet()
  const tools = useTools()
  const onBroadcastSucceeded = useQbitBroadcastSucceededCallback()
  return useCallback(
    async (
      payload: QbitRetainedBroadcast,
      expectedChain?: ChainType,
      retryOfUnknownOutcome?: boolean
    ): Promise<QbitBroadcastResult> => {
      // The recovery identity has to exist before dispatch: the network and
      // txid the signer fixed, else the ones a provider claim names, else the
      // network the caller expects. It binds this broadcast to that network
      // and txid (the controller refuses bytes for any other transaction
      // before dispatch) and is never derived from the answer.
      const claim = payload.qbitSendBroadcastClaim
      const identity = payload.qbitBroadcastIdentity
      const chain = identity?.chain ?? claim?.chain ?? expectedChain
      const txid = identity?.txid ?? claim?.txid
      tools.showLoading(true)
      try {
        // Only the recovery screen says its verdict for these bytes is
        // unknown: after a background restart, the claim restored for this
        // retry then counts as an earlier unknown outcome.
        const result = retryOfUnknownOutcome
          ? await wallet.broadcastQbitTx(payload.psbtHex, claim, chain, txid, true)
          : await wallet.broadcastQbitTx(payload.psbtHex, claim, chain, txid)
        if (result.success === false) {
          tools.showLoading(false)
          return result
        }
        await timeUtils.sleep(3) // Wait for transaction synchronization
        tools.showLoading(false)
        onBroadcastSucceeded(result.txid)
        return result
      } catch (e) {
        tools.showLoading(false)
        const failure: QbitBroadcastFailure = {
          success: false,
          outcome: 'unknown',
          reason: 'unexpected',
        }
        // The controller never answered (for example the extension port
        // closed mid-call), so nothing proves the request was not sent. The
        // identity captured before dispatch still names the transaction and
        // network, which keeps status checks and retries tied to the original
        // broadcast.
        if (chain !== undefined) failure.chain = chain
        if (typeof txid === 'string' && txid.length > 0) failure.txid = txid
        const detail = sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(e))
        if (detail) failure.detail = detail
        return failure
      }
    },
    [wallet, tools, onBroadcastSucceeded]
  )
}

/**
 * Probe a txid the wallet already tried to broadcast. A found transaction gets
 * the same bookkeeping as a clean broadcast; absence and lookup failures are
 * both reported as plain values and never upgraded to "not sent".
 */
export function useCheckQbitBroadcastStatusCallback() {
  const wallet = useWallet()
  const onBroadcastSucceeded = useQbitBroadcastSucceededCallback()
  return useCallback(
    async (
      txid: string,
      chain: ChainType,
      qbitSendBroadcastClaim?: QbitSendBroadcastClaim
    ): Promise<QbitBroadcastStatusCheck> => {
      try {
        const status = await wallet.checkQbitBroadcastStatus(txid, chain, qbitSendBroadcastClaim)
        if (status.found === true) onBroadcastSucceeded(status.txid)
        return status
      } catch (e) {
        const detail = sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(e))
        return detail
          ? { found: false, txid, state: 'unavailable', detail }
          : { found: false, txid, state: 'unavailable' }
      }
    },
    [wallet, onBroadcastSucceeded]
  )
}

/**
 * Release the send claim behind a broadcast the user is abandoning. A claim
 * keeps the transaction's inputs reserved for as long as the retained bytes
 * can still be retried; leaving the recovery screen drops those bytes, so a
 * lingering claim would only block a corrected send, or a fee bump of a
 * payment that did go out, until the page closes.
 *
 * Only a proven `not_sent` verdict releases outright, and only the claim
 * that names the verdict's exact network and txid. Any other verdict may
 * hide an accepted transaction, so the claim is handed back to the
 * background instead, which keeps its inputs reserved as recently spent
 * (fail closed) until a lifecycle probe finds the transaction confirmed or
 * gone, and lets a fee bump replace it meanwhile. Never throws and never
 * logs: the claim identifies the signed transaction.
 */
export function useAbandonQbitBroadcastCallback(): (
  result: QbitBroadcastFailure,
  retained: QbitRetainedBroadcast | undefined
) => Promise<void> {
  const wallet = useWallet()
  return useCallback(
    async (
      result: QbitBroadcastFailure,
      retained: QbitRetainedBroadcast | undefined
    ): Promise<void> => {
      const claim = retained?.qbitSendBroadcastClaim
      if (!claim) return
      const provenNotSent =
        result.outcome === 'not_sent' &&
        result.chain !== undefined &&
        claim.chain === result.chain &&
        typeof result.txid === 'string' &&
        typeof claim.txid === 'string' &&
        claim.txid.toLowerCase() === result.txid.toLowerCase()
      try {
        if (provenNotSent) {
          await wallet.releaseQbitSendBroadcastClaim(claim)
        } else {
          await wallet.abandonQbitSendBroadcastClaim(claim)
        }
      } catch {
        // The claim lives in background memory only; if the port is gone its
        // disconnect decides the claim, and nothing here must delay leaving.
      }
    },
    [wallet]
  )
}

const NO_UTXOS: UnspentOutput[] = []

/** Whether outputs read for `address` on `chain` are the selected account's on the active network. */
function isSelectedUtxoKey(
  state: AppState,
  address: string | null,
  chain: ChainType | null
): boolean {
  return address === state.accounts.current.address && chain === state.settings.chainType
}

/**
 * The cached outputs if they were read for the selected account on the
 * active network, and none otherwise. The cache holds one account's outputs
 * at a time, and another account's or network's list must not stand in for
 * this one's.
 */
export function useUtxos() {
  const transactionsState = useTransactionsState()
  return useUtxosLoaded() ? transactionsState.utxos : NO_UTXOS
}

/**
 * Whether the cache holds the selected account's outputs on the active
 * network, including a read that found none.
 */
export function useUtxosLoaded() {
  return useAppSelector(state =>
    isSelectedUtxoKey(state, state.transactions.utxosAddress, state.transactions.utxosChain)
  )
}

/**
 * The network the cached outputs were loaded on, whichever account they were
 * read for; null before the first load. `useUtxosLoaded` tells whether they
 * are the selected account's on the active network.
 */
export function useUtxosChain() {
  const transactionsState = useTransactionsState()
  return transactionsState.utxosChain
}

/** Numbers this UI's output reads in the order they start. */
let utxoReads = 0

function utxoReadAborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('UTXO read aborted')
}

/**
 * Read the selected account's outputs and cache them. Past the explorer's
 * output limit the read walks the account's history and can take minutes,
 * so its answer is cached only if, when it lands, its caller has not
 * aborted it, its account and network are still the selected ones, and the
 * cache does not already hold a later read's answer for them. An earlier or
 * abandoned read can then never replace the outputs of the account the user
 * moved on to, nor a newer read's.
 *
 * The caller's abort reaches the background too: the read is abandoned
 * there, and a walk nothing else waits for stops reading.
 *
 * The caller gets the answer whether or not it was cached, unless it
 * aborted. An answer for an account or network other than the ones this
 * hook rendered for is an error: those are not the outputs it asked for.
 */
export function useFetchUtxosCallback() {
  const dispatch = useAppDispatch()
  const store = useStore<AppState>()
  const wallet = useWallet()
  const address = useAccountAddress()
  const chainType = useChainType()
  return useCallback(
    async ({ signal }: { signal?: AbortSignal } = {}): Promise<QbitUtxoSnapshot> => {
      if (signal?.aborted) throw utxoReadAborted(signal)
      const read = ++utxoReads
      const readId = String(read)
      const abandon = (): void => {
        void wallet.abandonQbitUtxoSnapshot(readId).catch(() => undefined)
      }
      signal?.addEventListener('abort', abandon, { once: true })
      let snapshot: QbitUtxoSnapshot
      try {
        snapshot = await wallet.getQbitUtxoSnapshot(readId)
      } finally {
        signal?.removeEventListener('abort', abandon)
      }
      if (signal?.aborted) throw utxoReadAborted(signal)
      if (snapshot.address !== address || snapshot.chain !== chainType) {
        throw new Error('The selected account or network changed while its outputs were loading')
      }
      // Checked and written in one step: nothing else runs in between. The
      // answer is for the selected key, so a cache for that key holding a
      // later read's answer is the one to keep.
      const state = store.getState()
      const { utxosAddress, utxosChain, utxosRead } = state.transactions
      if (
        isSelectedUtxoKey(state, snapshot.address, snapshot.chain) &&
        !(isSelectedUtxoKey(state, utxosAddress, utxosChain) && utxosRead > read)
      ) {
        dispatch((transactionsActions as any).setUtxos({ ...snapshot, read }))
      }
      return snapshot
    },
    [dispatch, store, wallet, address, chainType]
  )
}

export function useSpendUnavailableUtxos() {
  const transactionsState = useTransactionsState()
  return transactionsState.spendUnavailableUtxos
}

export function useSetSpendUnavailableUtxosCallback() {
  const dispatch = useAppDispatch()
  return useCallback(
    (utxos: UnspentOutput[]) => {
      dispatch((transactionsActions as any).setSpendUnavailableUtxos(utxos))
    },
    [dispatch]
  )
}

export function useSafeBalance() {
  const utxos = useUtxos()
  return useMemo(() => {
    const satoshis = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    return numUtils.satoshisToAmount(satoshis)
  }, [utxos])
}
