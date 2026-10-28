import { useEffect, useMemo, useRef, useState } from 'react'

import { numUtils } from '@qbit/base-utils'
import {
  COIN_DUST,
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_DUST,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  useAccountBalance,
  useChain,
  useCurrentAccount,
  estimateQbitP2mrSendAllPreflight,
  estimateQbitP2mrSendPreflight,
  QBIT_MEMO_MAX_BYTES,
  qbitMemoByteLength,
  useFeeRateBar,
  useFetchUtxosCallback,
  getQbitP2mrSpendableUtxos,
  useI18n,
  useNavigation,
  usePrepareSendQBTCallback,
  useQbitUnit,
  useTools,
  useWallet,
  useUiTxCreateScreen,
  useUpdateUiTxCreateScreen,
  useUtxos,
  useUtxosChain,
} from '..'
import { isValidAddress } from '../utils/qbit-utils'

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

  const [autoAdjust, setAutoAdjust] = useState(false)
  const utxos = useUtxos()
  const utxosChain = useUtxosChain()
  const fetchUtxos = useFetchUtxosCallback()
  const wallet = useWallet()

  const tools = useTools()
  // Whether this screen's own read of the outputs has landed: until then an
  // empty cache may be another account's, or no read at all.
  const [utxosFetched, setUtxosFetched] = useState(false)
  // Whether that read failed, as opposed to still running.
  const [utxosFetchFailed, setUtxosFetchFailed] = useState(false)
  // Past the explorer's limit the read walks the account's history, which
  // can take a while; it runs without covering the screen, so Consolidate
  // stays in reach, and Available shows unknown until it lands. The overlay
  // also comes down if the balance shows the limit only once the read runs.
  const loadingOverlayRef = useRef(false)
  const hideLoadingOverlay = (): void => {
    if (!loadingOverlayRef.current) return
    loadingOverlayRef.current = false
    tools.showLoading(false)
  }
  useEffect(() => {
    if (accountBalance.utxoLimitExceeded !== true) {
      loadingOverlayRef.current = true
      tools.showLoading(true)
    }
    fetchUtxos()
      .then(() => setUtxosFetched(true))
      .catch(e => {
        // An account over the explorer's UTXO limit is explained below; any
        // other failure keeps Next disabled until the outputs load.
        setUtxosFetchFailed(true)
        console.log(e)
      })
      .finally(hideLoadingOverlay)
  }, [])
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

  const chain = useChain()
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
  const ownUtxosLoaded = utxosFetched && chain !== undefined && utxosChain === chain.enum
  // Loaded with none left (a pending send holds them all) counts as loaded:
  // Available is then 0, not the balance's figure.
  const hasQbitUtxoPreflight = isQbitP2mrSend && (utxos.length > 0 || ownUtxosLoaded)
  const qbitSpendableSatoshis = useMemo(
    () => qbitSpendableUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0),
    [qbitSpendableUtxos]
  )
  const availableSatoshis = hasQbitUtxoPreflight
    ? qbitSpendableSatoshis
    : accountBalance.availableBalance
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
  const availableAmount = ownUtxosUnknown ? '--' : numUtils.satoshisToAmount(availableSatoshis)
  const unavailableSats = hasQbitUtxoPreflight
    ? Math.max(0, accountBalance.totalBalance - availableSatoshis)
    : Math.max(0, accountBalance.unavailableBalance)
  const unavailableAmount = numUtils.satoshisToAmount(unavailableSats)

  const showUnavailable = unavailableSats > 0

  const immatureSats = Math.min(unavailableSats, Math.max(0, accountBalance.immatureBalance ?? 0))
  const showImmature = immatureSats > 0
  const immatureAmount = numUtils.satoshisToAmount(immatureSats)
  // Both detail rows are subsets of Unavailable. Bound Pending to the remainder
  // so a stale or malformed balance payload cannot contradict its parent row.
  const pendingSats = Math.min(
    Math.max(0, accountBalance.pendingBalance ?? 0),
    Math.max(0, unavailableSats - immatureSats)
  )
  const showPending = pendingSats > 0
  const pendingAmount = numUtils.satoshisToAmount(pendingSats)

  useEffect(() => {
    setError('')
    setDisabled(true)
    setFeeDetail(undefined)
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
    isQbitChain,
    isQbitP2mrSend,
    hasQbitUtxoPreflight,
    qbitSpendableSatoshis,
    qbitSpendableUtxos,
    currentAccount,
    t,
  ])

  const unavailableTipText = useMemo(() => t('unavailable_tooltip'), [t])

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
    if (ownUtxosUnknown) return
    setAutoAdjust(true)
    // Fill from the same spendable total that validation and the send use
    // (availableSatoshis), not accountBalance.availableBalance — otherwise Max
    // can under-fill spendable funds or set an amount that fails validation.
    setUiState({ inputAmount: numUtils.satoshisToAmount(availableSatoshis) })
  }

  const onRBFChange = (value: boolean) => {
    setUiState({ enableRBF: value })
    wallet.setEnableRBF(value)
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
