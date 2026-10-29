import { useEffect, useMemo, useRef, useState } from 'react'

import { numUtils } from '@qbit/base-utils'
import {
  COIN_DUST,
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_DUST,
  assessQbitFee,
  qbitRecommendedFeeRate,
  qbitWalletOwnership,
  qbitWalletOwns,
  type FeeSummary,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  useAccountBalance,
  useAccountsState,
  useChain,
  useChainType,
  useCurrentAccount,
  estimateQbitP2mrSendAllPreflight,
  estimateQbitP2mrSendPreflight,
  QBIT_MEMO_MAX_BYTES,
  qbitMemoByteLength,
  useFeeRateBar,
  useFetchUtxosCallback,
  getQbitP2mrSpendableUtxos,
  useAccounts,
  useKeyrings,
  useI18n,
  useNavigation,
  usePrepareSendQBTCallback,
  useQbitUnit,
  useTools,
  useWallet,
  useUiTxCreateScreen,
  useUpdateUiTxCreateScreen,
  useUtxos,
  useUtxosLoaded,
} from '..'
import { hasAccountBalanceRead } from '../reducers/accounts'
import { isValidAddress } from '../utils/qbit-utils'
import { qbitFeeWarningText } from '../utils/qbit-fee-warning-text'

/** What the previewed send takes from the wallet, for the total and the fee check. */
interface SendSpendPreview {
  /** The recipient the preview was computed for. */
  recipientAddress: string
  /** What the recipient receives. */
  recipientSatoshis: number
  /** Exact fee, including any change folded into it. */
  fee: number
  vsize: number
}

type FeeQuoteState = { status: 'loading' } | { status: 'loaded'; summary?: FeeSummary }

/** The send screen's total and fee warning for its preview. */
export interface TxCreateSpendSummary {
  /** Recipient amount plus fee, formatted. */
  totalSpend: string
  feeWarningTitle?: string
  feeWarnings: string[]
  /** Present once the quote is read and has no live rates to compare with. */
  feeRecommendationUnavailable?: string
}

export function useTxCreateScreenLogic() {
  const { t } = useI18n()
  const accountBalance = useAccountBalance()
  const currentAccount = useCurrentAccount()
  const nav = useNavigation()
  const qbitUnit = useQbitUnit()

  const [disabled, setDisabled] = useState(true)

  const setUiState = useUpdateUiTxCreateScreen()
  const uiState = useUiTxCreateScreen()
  const feeRateBarState = useFeeRateBar()

  const toInfo = uiState.toInfo
  const inputAmount = uiState.inputAmount
  const enableRBF = uiState.enableRBF
  const memo = uiState.memo || ''
  const feeRate = feeRateBarState.feeRate

  const [error, setError] = useState('')
  const [feeDetail, setFeeDetail] = useState<
    | {
        estimatedFee: number
        inputCount: number
        estimatedVsize: number
        changeDroppedSats: number
        maximumTotalFee: number
        inputsDominateFee: boolean
        /** Send-all only: outputs one standard transaction cannot carry; they stay in the account. */
        leftBehindInputCount: number
        leftBehindSats: number
      }
    | undefined
  >(undefined)

  const [spendPreview, setSpendPreview] = useState<SendSpendPreview | undefined>(undefined)
  const [feeQuote, setFeeQuote] = useState<FeeQuoteState>({ status: 'loading' })

  const [autoAdjust, setAutoAdjust] = useState(false)
  // The selected account's cached outputs on the active network; none while
  // the cache holds another account's or network's.
  const utxos = useUtxos()
  const utxosLoaded = useUtxosLoaded()
  const fetchUtxos = useFetchUtxosCallback()
  const wallet = useWallet()
  const chain = useChain()
  const chainType = useChainType()

  const tools = useTools()
  // The account and network this screen reads outputs for, as the cache
  // keys them. The read runs again when either changes under the open screen.
  const utxoReadKey = `${chainType}:${currentAccount.address}`
  // How this screen's own read for `utxoReadKey` ended. Until it lands an
  // empty cache may be from an earlier read, or no read at all; `failed`
  // tells a failed read from one still running.
  const [utxoRead, setUtxoRead] = useState<{ key: string; failed: boolean } | undefined>(undefined)
  // Past the explorer's limit the read walks the account's history, which
  // can take a while; it runs without covering the screen, so Consolidate
  // stays in reach, and Available shows unknown until it lands. The overlay
  // also comes down if the balance shows the limit only once the read runs.
  const loadingOverlayRef = useRef(false)
  // Only the read the screen opens with covers it. A read again under the
  // open screen, after an account or network change, runs before that
  // account's balance can say whether it is over the limit, and must not
  // hide Consolidate for the length of a walk.
  const firstUtxoReadRef = useRef(true)
  const hideLoadingOverlay = (): void => {
    if (!loadingOverlayRef.current) return
    loadingOverlayRef.current = false
    tools.showLoading(false)
  }
  useEffect(() => {
    // An earlier read's outcome, for this key or another, says nothing
    // about the read starting now.
    setUtxoRead(undefined)
    if (firstUtxoReadRef.current && accountBalance.utxoLimitExceeded !== true) {
      loadingOverlayRef.current = true
      tools.showLoading(true)
    }
    firstUtxoReadRef.current = false
    // Leaving the screen, or its account or network, abandons the read: its
    // answer is not cached, and the background stops waiting for it too, so
    // a walk that nothing else waits for stops reading. A read the screen
    // opens again for the same account, whose statistics have not moved,
    // joins a walk another page still waits for rather than repeating it.
    const read = new AbortController()
    fetchUtxos({ signal: read.signal })
      .then(() => {
        if (!read.signal.aborted) setUtxoRead({ key: utxoReadKey, failed: false })
      })
      .catch(e => {
        if (read.signal.aborted) return
        // An account over the explorer's UTXO limit is explained below; any
        // other failure keeps Next disabled until the outputs load.
        setUtxoRead({ key: utxoReadKey, failed: true })
        console.log(e)
      })
      .finally(() => {
        if (!read.signal.aborted) hideLoadingOverlay()
      })
    return () => {
      read.abort()
      hideLoadingOverlay()
    }
  }, [utxoReadKey])
  useEffect(() => {
    if (accountBalance.utxoLimitExceeded === true) hideLoadingOverlay()
  }, [accountBalance.utxoLimitExceeded])

  useEffect(() => {
    wallet.getEnableRBF().then(enableRBF => {
      setUiState({ enableRBF })
    })
  }, [wallet, setUiState])

  const prepareSendQBT = usePrepareSendQBTCallback()

  const toSatoshis = useMemo(() => {
    if (!inputAmount) return 0
    return numUtils.amountToSatoshis(inputAmount)
  }, [inputAmount])

  const accounts = useAccounts()
  const keyrings = useKeyrings()
  // The accounts the approval counts as the wallet's (the same getAccounts
  // list, as loaded here), so a send to one of them shows only the fee
  // leaving, as the confirm screen will.
  const walletOwnership = useMemo(
    () =>
      qbitWalletOwnership([
        currentAccount,
        ...accounts,
        ...keyrings.flatMap(keyring => keyring.accounts ?? []),
      ]),
    [currentAccount, accounts, keyrings]
  )

  // The quote the selected rate is compared with. A failed read leaves no
  // recommendation, which the screen says instead of skipping the check.
  useEffect(() => {
    let cancelled = false
    setFeeQuote({ status: 'loading' })
    wallet
      .getFeeSummary()
      .then(summary => {
        if (!cancelled) setFeeQuote({ status: 'loaded', summary })
      })
      .catch(e => {
        console.log(e)
        if (!cancelled) setFeeQuote({ status: 'loaded' })
      })
    return () => {
      cancelled = true
    }
  }, [wallet, chain?.enum])

  const isQbitChain =
    chain?.enum === ChainType.QBIT_MAINNET ||
    chain?.enum === ChainType.QBIT_TESTNET4 ||
    chain?.enum === ChainType.QBIT_REGTEST
  const dustSats = isQbitChain ? QBIT_P2MR_DUST : COIN_DUST
  const dustAmount = useMemo(() => numUtils.satoshisToAmount(dustSats), [dustSats])
  const qbitSpendableUtxos = useMemo(
    () => getQbitP2mrSpendableUtxos(utxos, currentAccount),
    [utxos, currentAccount]
  )
  const isQbitP2mrSend = isQbitChain && Boolean(currentAccount.p2mr)
  // This screen's own read of the account's outputs landed on this network.
  const ownUtxosLoaded = utxoRead?.key === utxoReadKey && !utxoRead.failed && utxosLoaded
  const utxosFetchFailed = utxoRead?.key === utxoReadKey && utxoRead.failed
  // Loaded with none left (a pending send holds them all) counts as loaded:
  // Available is then 0, not the balance's figure.
  const hasQbitUtxoPreflight = isQbitP2mrSend && (utxos.length > 0 || ownUtxosLoaded)
  const qbitSpendableSatoshis = useMemo(
    () => qbitSpendableUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0),
    [qbitSpendableUtxos]
  )
  // The balance's own figure is unknown (null) past the explorer's limit:
  // nothing can be selected from it, and Available shows it as unknown. So
  // it is until a balance read for this account on this network succeeds:
  // the stand-in zeros before that are no measurement.
  const accountsState = useAccountsState()
  const balanceRead = hasAccountBalanceRead(accountsState, currentAccount.address, chainType)
  const balanceAvailableUnknown =
    !hasQbitUtxoPreflight && (!balanceRead || accountBalance.availableBalance === null)
  const availableSatoshis = hasQbitUtxoPreflight
    ? qbitSpendableSatoshis
    : (accountBalance.availableBalance ?? 0)
  // Keyed on this account's own outputs: the cached list may still hold
  // another account's outputs after a load for this one failed. Loaded with
  // none left, the account's outputs are known and simply all held. While
  // the read (a long history walk past the limit) runs they are unknown, and
  // only once it fails is that explained.
  const overExplorerLimit = isQbitP2mrSend && accountBalance.utxoLimitExceeded === true
  const ownUtxosUnknown = overExplorerLimit && qbitSpendableUtxos.length === 0 && !ownUtxosLoaded
  const utxoLimitExceeded = ownUtxosUnknown && utxosFetchFailed

  // The Available row shows the amount the preflight checks against and Max
  // fills, so the two can never disagree; Unavailable is the rest of the
  // balance, including outputs a pending send holds. Outputs the explorer
  // would not list and the wallet could not read from history are unknown,
  // not zero.
  const availableAmount =
    ownUtxosUnknown || balanceAvailableUnknown ? '--' : numUtils.satoshisToAmount(availableSatoshis)
  const unavailableSats = hasQbitUtxoPreflight
    ? Math.max(0, accountBalance.totalBalance - availableSatoshis)
    : Math.max(0, accountBalance.unavailableBalance)
  // Before a balance read the rest of the balance is unknown too, even when
  // the outputs are: those rows show `--` rather than hiding behind the
  // stand-in zeros, as the balance card does.
  const unknownAmount = (sats: number) => (balanceRead ? numUtils.satoshisToAmount(sats) : '--')
  const unavailableAmount = unknownAmount(unavailableSats)

  const showUnavailable = !balanceRead || unavailableSats > 0

  const immatureSats = Math.min(unavailableSats, Math.max(0, accountBalance.immatureBalance ?? 0))
  const showImmature = !balanceRead || immatureSats > 0
  const immatureAmount = unknownAmount(immatureSats)
  // Both detail rows are subsets of Unavailable. Bound Pending to the remainder
  // so a stale or malformed balance payload cannot contradict its parent row.
  const pendingSats = Math.min(
    Math.max(0, accountBalance.pendingBalance ?? 0),
    Math.max(0, unavailableSats - immatureSats)
  )
  const showPending = !balanceRead || pendingSats > 0
  const pendingAmount = unknownAmount(pendingSats)

  useEffect(() => {
    setError('')
    setDisabled(true)
    setFeeDetail(undefined)
    setSpendPreview(undefined)
    if (utxoLimitExceeded) {
      setError(t('utxo_limit_exceeded_send'))
      return
    }
    if (!isValidAddress(toInfo.address, chain?.networkType)) {
      // A parseable P2MR address with the wrong HRP deserves an inline error;
      // a partially-typed address stays silently disabled.
      if (toInfo.address && isValidAddress(toInfo.address)) {
        setError(t('invalid_address_format_for_selected_network'))
      }
      return
    }
    if (!toSatoshis) {
      return
    }
    if (toSatoshis < dustSats) {
      setError(`${t('amount_must_be_at_least')} ${dustAmount} ${qbitUnit}`)
      return
    }

    if (memo && qbitMemoByteLength(memo) > QBIT_MEMO_MAX_BYTES) {
      setError(t('memo_too_long_max_80_bytes'))
      return
    }

    // For qbit P2MR sends the spendable total and fee coverage come from the
    // UTXO preflight below. Until UTXOs load we can't validate either, so keep
    // Next disabled rather than enabling it from accountBalance alone —
    // usePrepareSendQBTCallback caps at the spendable UTXO total and would
    // otherwise reject the amount on the next screen.
    if (isQbitP2mrSend && !hasQbitUtxoPreflight) {
      return
    }
    // Nor, for an account without a P2MR script, against a balance figure
    // that is unknown.
    if (balanceAvailableUnknown) {
      return
    }

    if (toSatoshis > availableSatoshis) {
      setError(t('amount_exceeds_your_available_balance'))
      return
    }

    if (!Number.isFinite(feeRate) || feeRate <= 0) {
      return
    }
    if (isQbitChain && feeRate < QBIT_MIN_RELAY_FEE_RATE) {
      return
    }

    if (hasQbitUtxoPreflight) {
      const previewFeeRate = Math.min(feeRate, QBIT_MAX_FEE_RATE)
      const preflight =
        toSatoshis === qbitSpendableSatoshis
          ? estimateQbitP2mrSendAllPreflight({
              utxos: qbitSpendableUtxos,
              account: currentAccount,
              feeRate: previewFeeRate,
              memo: memo || undefined,
            })
          : estimateQbitP2mrSendPreflight({
              utxos: qbitSpendableUtxos,
              account: currentAccount,
              amount: toSatoshis,
              feeRate: previewFeeRate,
              memo: memo || undefined,
            })
      if (feeRate > QBIT_MAX_FEE_RATE || preflight.exceedsMaximumTotalFee) {
        setError(
          t('fee_exceeds_wallet_safety_maximum', [
            String(QBIT_MAX_FEE_RATE),
            numUtils.satoshisToAmount(preflight.maximumTotalFee),
            qbitUnit,
          ])
        )
        return
      }
      if ('exceedsStandardSize' in preflight && preflight.exceedsStandardSize) {
        setError(
          t('send_exceeds_standard_size', [
            String(preflight.maxInputCount),
            numUtils.satoshisToAmount(preflight.maxStandardAmount),
            qbitUnit,
          ])
        )
        return
      }
      if (preflight.exceedsAncestorSize) {
        setError(t('send_exceeds_ancestor_size'))
        return
      }
      if (!preflight.canCover) {
        setError(t('amount_exceeds_your_available_balance'))
        return
      }
      setFeeDetail({
        estimatedFee: preflight.estimatedFee,
        inputCount: preflight.inputCount,
        estimatedVsize: preflight.estimatedVsize,
        changeDroppedSats: preflight.changeDroppedSats,
        maximumTotalFee: preflight.maximumTotalFee,
        inputsDominateFee: preflight.inputsDominateFee,
        leftBehindInputCount:
          'leftBehindInputCount' in preflight ? preflight.leftBehindInputCount : 0,
        leftBehindSats: 'leftBehindSats' in preflight ? preflight.leftBehindSats : 0,
      })
      if (preflight.estimatedVsize > 0) {
        setSpendPreview({
          recipientAddress: toInfo.address,
          recipientSatoshis: 'outputSatoshis' in preflight ? preflight.outputSatoshis : toSatoshis,
          fee: preflight.estimatedFee,
          vsize: preflight.estimatedVsize,
        })
      }
    }

    setDisabled(false)
  }, [
    utxoLimitExceeded,
    toInfo,
    chain?.networkType,
    inputAmount,
    feeRate,
    toSatoshis,
    dustSats,
    dustAmount,
    qbitUnit,
    memo,
    availableSatoshis,
    balanceAvailableUnknown,
    isQbitChain,
    isQbitP2mrSend,
    hasQbitUtxoPreflight,
    qbitSpendableSatoshis,
    qbitSpendableUtxos,
    currentAccount,
    t,
  ])

  const unavailableTipText = useMemo(() => t('unavailable_tooltip'), [t])

  // What leaves the wallet (the recipient's amount plus the fee; change comes
  // back, and so does a payment to another of the wallet's accounts) and
  // whether that fee is abnormal, from the same preflight that enables Next.
  // The confirm screen repeats both on the built PSBT.
  const spendSummary = useMemo((): TxCreateSpendSummary | undefined => {
    if (!spendPreview) return undefined
    const { recipientAddress, recipientSatoshis, fee, vsize } = spendPreview
    const sentToOthers = qbitWalletOwns(walletOwnership, { address: recipientAddress })
      ? 0
      : recipientSatoshis
    const assessment = assessQbitFee({
      fee,
      feeRate: fee / vsize,
      amount: sentToOthers,
      recommendedFeeRate:
        feeQuote.status === 'loaded' ? qbitRecommendedFeeRate(feeQuote.summary) : undefined,
    })
    const warning = qbitFeeWarningText(assessment, t, qbitUnit)
    return {
      totalSpend: numUtils.satoshisToAmount(sentToOthers + fee),
      ...(warning.title !== undefined ? { feeWarningTitle: warning.title } : {}),
      feeWarnings: warning.lines,
      // Said only once the quote has been read, not while it loads.
      ...(feeQuote.status === 'loaded' && warning.recommendationUnavailable !== undefined
        ? { feeRecommendationUnavailable: warning.recommendationUnavailable }
        : {}),
    }
  }, [spendPreview, walletOwnership, feeQuote, t, qbitUnit])

  // Max past the standard transaction size sends the largest outputs only.
  const leftBehindNote =
    feeDetail && feeDetail.leftBehindInputCount > 0
      ? t('send_all_leaves_outputs_behind', [
          String(feeDetail.inputCount),
          numUtils.satoshisToAmount(feeDetail.leftBehindSats),
          qbitUnit,
          String(feeDetail.leftBehindInputCount),
        ])
      : undefined

  const headerTitle = `${t('send')} ${qbitUnit}`

  const onAddressInputChange = val => setUiState({ toInfo: val })

  const onAmountInputChange = amount => {
    if (autoAdjust == true) {
      setAutoAdjust(false)
    }
    setUiState({ inputAmount: amount })
  }

  const onAmountMaxClick = () => {
    // Nothing to fill while Available is unknown.
    if (ownUtxosUnknown || balanceAvailableUnknown) return
    setAutoAdjust(true)
    // Fill from the same spendable total that validation and the send use
    // (availableSatoshis), not accountBalance.availableBalance — otherwise Max
    // can under-fill spendable funds or set an amount that fails validation.
    setUiState({ inputAmount: numUtils.satoshisToAmount(availableSatoshis) })
  }

  const onRBFChange = (value: boolean) => {
    setUiState({ enableRBF: value })
    // The choice applies to this send either way; only the saved default failed.
    wallet.setEnableRBF(value).catch(error => {
      console.error('Failed to save the RBF preference:', error)
    })
  }

  const onMemoChange = (value: string) => {
    setUiState({ memo: value })
  }

  const onClickConsolidate = (): void => {
    nav.navigate('QbitConsolidationScreen')
  }

  const onClickNext = () => {
    prepareSendQBT({
      toAddressInfo: toInfo,
      toAmount: toSatoshis,
      feeRate,
      enableRBF,
      memo: memo || undefined,
    })
      .then(toSignData => {
        nav.navigate('TxConfirmScreen', {
          toSignData,
        })
      })
      .catch(e => {
        console.log(e)
        setError(e.message)
      })
  }

  return {
    headerTitle,
    chain,

    toInfo,
    onAddressInputChange,

    toSatoshis,
    inputAmount,
    onAmountInputChange,
    onAmountMaxClick,
    enableRBF,
    onRBFChange,
    memo,
    onMemoChange,
    feeDetail,
    leftBehindNote,
    spendSummary,

    showUnavailable,
    availableAmount,
    unavailableAmount,
    showImmature,
    immatureAmount,
    showPending,
    pendingAmount,
    unavailableTipText,
    qbitUnit,
    t,

    error,
    disabled,
    // Over the explorer's listing limit: the account can consolidate its outputs.
    showConsolidate: overExplorerLimit,

    onClickNext,
    onClickConsolidate,
  }
}
