import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'react-redux'

import { numUtils } from '@qbit/base-utils'
import {
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_DUST,
  assessQbitFee,
  estimateQbitSendPlanSigningSeconds,
  isQbitFeeRateWithinPolicy,
  isQbitSendPlanAmount,
  qbitRecommendedFeeRate,
  qbitWalletOwnership,
  qbitWalletOwns,
  type QbitSendPlan,
  type QbitSendPlanPrepareParams,
  type QbitSendPlanPrepareRefusal,
  type QbitSendPlanRefusal,
  type QbitSendPlanTarget,
  type UnspentOutput,
} from '@qbit/wallet-shared'
import {
  type AppState,
  useAccountBalance,
  useAccountsState,
  useChain,
  useChainType,
  useCurrentAccount,
  estimateQbitP2mrSendAllPreflight,
  estimateQbitP2mrSendPreflight,
  planQbitP2mrSendPreflight,
  qbitP2mrSendAllSendableSatoshis,
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
  useUIState,
  useUiTxCreateScreen,
  useUpdateUiTxCreateScreen,
  useUtxos,
  useUtxosLoaded,
} from '..'
import { useQbitSendPlan } from '../hooks/sendPlan'
import { hasAccountBalanceRead } from '../reducers/accounts'
import type { SendFormScope } from '../reducers/ui'
import { isValidAddress } from '../utils/qbit-utils'
import { qbitFeeWarningText } from '../utils/qbit-fee-warning-text'
import {
  qbitSendPlanAmount,
  qbitSendPlanCountFormat,
  qbitSendPlanErrorMessage,
  qbitSendPlanRefusalText,
  qbitSendPlanStepsText,
  qbitSendPlanTimeText,
} from '../utils/qbit-send-plan'
import { feeRateBelowMinimumError, useFeeQuoteRead, useFeeRateSettled } from './useFeeRateBarLogic'

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

/**
 * What the send screen previews for a payment one transaction cannot carry
 * (#188): the send plan, or why there is none and what can be sent instead,
 * or that only a plan can pay it while another payment of the account is in
 * progress.
 */
type SendPlanPreview =
  | { kind: 'open' }
  | {
      kind: 'plan'
      plan: QbitSendPlan<UnspentOutput>
      /** What Next prepares, priced for exactly these. */
      recipientAddress: string
      target: QbitSendPlanTarget
      feeRate: number
    }
  | {
      kind: 'refusal'
      reason: QbitSendPlanPrepareRefusal
      /** The largest amount to offer, in bits; 0 for none. */
      offer: number
      /** Funds not confirmed yet that the offer leaves out; 0 when it takes them or there are none. */
      unconfirmedSatoshis: number
    }

/** What Next's request to prepare the plan was answered with, while the form holds. */
type SendPlanPrepareOutcome =
  | {
      kind: 'refused'
      reason: QbitSendPlanPrepareRefusal
      offer: number
      unconfirmedSatoshis: number
    }
  | { kind: 'plan_open' }

/** The send screen's card for a send plan: what will happen, priced in full. */
export interface TxCreateSendPlanNotice {
  title: string
  /** "K to combine your funds, then the payment." */
  steps: string
  /** Exactly what the recipient receives, with the unit. */
  receives: string
  totalFee: string
  /** The signatures it uses and about how long signing takes. */
  signing: string
  /** For the whole balance: what stays in the account as worth less than its fee, when anything does. */
  leftBehind: string
  /** For the whole balance: the funds not confirmed yet, which it does not include; empty for none. */
  unconfirmed: string
}

/** Why the amount cannot be sent as it is, and the amount the user may choose instead. */
export interface TxCreateSendPlanRefusal {
  message: string
  /** "You can send up to …", with the button that sets the amount to it; empty for none. */
  offerText: string
  offerButtonText: string
  unconfirmedText: string
}

/** The send screen's total and fee warning for its preview. */
export interface TxCreateSpendSummary {
  /** Recipient amount plus fee, formatted; `--` until the rate is settled. */
  totalSpend: string
  feeWarningTitle?: string
  feeWarnings: string[]
  /** Present once the quote is read and has no live rates to compare with. */
  feeRecommendationUnavailable?: string
}

// The store records a new scope object for the first account and network it
// knows, which clears nothing, and at each clear of the send form for another
// account or network, also for one that comes back. Each gets a key of its
// own here, so the key changes with every scope the store records.
const formKeys = new WeakMap<SendFormScope, string>()
let formKeysGiven = 0

function formKeyOf(scope: SendFormScope | null): string {
  if (!scope) return ''
  let key = formKeys.get(scope)
  if (key === undefined) {
    key = String(++formKeysGiven)
    formKeys.set(scope, key)
  }
  return key
}

export function useTxCreateScreenLogic() {
  const { t, locale } = useI18n()
  const accountBalance = useAccountBalance()
  const currentAccount = useCurrentAccount()
  const nav = useNavigation()
  const qbitUnit = useQbitUnit()

  const [disabled, setDisabled] = useState(true)

  const setUiState = useUpdateUiTxCreateScreen()
  const uiState = useUiTxCreateScreen()
  const feeRateBarState = useFeeRateBar()
  // The account and network the form's values belong to. The store clears
  // the values when other ones replace them, and records those instead.
  const { sendFormScope } = useUIState()
  const store = useStore<AppState>()
  const formKey = formKeyOf(sendFormScope)

  const toInfo = uiState.toInfo
  const inputAmount = uiState.inputAmount
  const enableRBF = uiState.enableRBF
  const memo = uiState.memo || ''
  const feeRate = feeRateBarState.feeRate

  const [error, setError] = useState('')
  // An error of the checks of the fee below, which hold only at the rate they ran at.
  const [feeCheckError, setFeeCheckError] = useState('')
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
  // The send plan for a payment one transaction cannot carry, or why there
  // is none, from the same checks; and what Next's request to prepare the
  // plan was answered with. Both hold only for the form they were made for.
  const [sendPlanPreview, setSendPlanPreview] = useState<SendPlanPreview | undefined>(undefined)
  // MAX sends one transaction of what the account's payment in progress
  // leaves free, where a plan would have combined more (#188).
  const [sendAllBesidePlan, setSendAllBesidePlan] = useState(false)
  const [prepareOutcome, setPrepareOutcome] = useState<SendPlanPrepareOutcome | undefined>(
    undefined
  )
  const [planPreparing, setPlanPreparing] = useState(false)
  const planPreparingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    return (): void => {
      mountedRef.current = false
    }
  }, [])
  // The rate the checks below last ran at: until they run at the selected
  // rate, Next and the preview are for an earlier one.
  const [checkedFeeRate, setCheckedFeeRate] = useState<number | undefined>(undefined)

  const [autoAdjust, setAutoAdjust] = useState(false)
  // The selected account's cached outputs on the active network; none while
  // the cache holds another account's or network's.
  const utxos = useUtxos()
  const utxosLoaded = useUtxosLoaded()
  const fetchUtxos = useFetchUtxosCallback()
  const wallet = useWallet()
  const chain = useChain()
  const chainType = useChainType()

  // The account's send plan on this network, as this page follows it
  // (#188). One that has not completed is in progress: the background
  // starts no other plan for the account until it ends (`plan_open`). A
  // completed one waiting to be dismissed is not; a new plan starts beside it.
  const { plan: accountSendPlan, refresh: refreshSendPlan } = useQbitSendPlan()
  const sendPlanInProgress =
    accountSendPlan !== undefined &&
    accountSendPlan !== null &&
    accountSendPlan.phase !== 'completed'
  // The background leaves what a plan holds out of every read of the
  // outputs, from the moment it holds it: outputs read before the plan
  // started, or before its transactions changed (a new review, a fee raise),
  // can include outputs it holds now, and outputs read before it ended lack
  // the ones it let go. Its id and transactions name what it holds, for
  // that: undefined until this page has read the plan, '' with none in
  // progress.
  const sendPlanHolds =
    accountSendPlan === undefined
      ? undefined
      : sendPlanInProgress
        ? `${accountSendPlan.id}:${accountSendPlan.steps.map(step => step.txid).join(',')}`
        : ''
  // Counts the changes of that this page sees, for which the outputs are
  // read again below. Its first read of the plan, on opening the screen or
  // after an account or network change, is not one: the outputs are read
  // at the same moment.
  const [sendPlanHoldsChanges, setSendPlanHoldsChanges] = useState(0)
  const seenSendPlanHoldsRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const seen = seenSendPlanHoldsRef.current
    seenSendPlanHoldsRef.current = sendPlanHolds
    if (seen !== undefined && sendPlanHolds !== undefined && seen !== sendPlanHolds) {
      setSendPlanHoldsChanges(changes => changes + 1)
    }
  }, [sendPlanHolds])

  const tools = useTools()
  // The account and network this screen reads outputs for, as the cache
  // keys them. The read runs again when either changes under the open
  // screen, and when what the account's plan in progress holds changes.
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
  }, [utxoReadKey, sendPlanHoldsChanges])
  useEffect(() => {
    if (accountBalance.utxoLimitExceeded === true) hideLoadingOverlay()
  }, [accountBalance.utxoLimitExceeded])

  // The user's replace-by-fee choices on this form, counted.
  const rbfChoices = useRef(0)
  // The saved choice, read again when the store clears the form for another
  // account or network, as a newly opened form reads it. A read lands only
  // if no later read has started and the user has not chosen since it did.
  useEffect(() => {
    let latest = true
    const choices = rbfChoices.current
    wallet.getEnableRBF().then(enableRBF => {
      if (latest && rbfChoices.current === choices) setUiState({ enableRBF })
    })
    return (): void => {
      latest = false
    }
  }, [wallet, setUiState, formKey])

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

  // The quote the selected rate is compared with, and the one the fee bar
  // offers its rates from, so the two never come from different quotes. A
  // failed read leaves no recommendation, which the screen says instead of
  // skipping the check.
  const feeQuote = useFeeQuoteRead()
  // Why a Custom rate typed below the relay floor is refused, as the
  // consolidation screen gives it too; '' for any other rate.
  const feeRateBelowMinimum = feeRateBelowMinimumError(feeRateBarState, t)

  const dustSats = QBIT_P2MR_DUST
  const dustAmount = useMemo(() => numUtils.satoshisToAmount(dustSats), [dustSats])
  const qbitSpendableUtxos = useMemo(
    () => getQbitP2mrSpendableUtxos(utxos, currentAccount),
    [utxos, currentAccount]
  )
  const isQbitP2mrSend = Boolean(currentAccount.p2mr)
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
  const splitUnknown = ownUtxosUnknown || balanceAvailableUnknown
  const availableAmount = splitUnknown ? '--' : numUtils.satoshisToAmount(availableSatoshis)
  const unavailableSats = hasQbitUtxoPreflight
    ? Math.max(0, accountBalance.totalBalance - availableSatoshis)
    : Math.max(0, accountBalance.unavailableBalance)
  // Before a balance read the rest of the balance is unknown too, even when
  // the outputs are: those rows show `--` rather than hiding behind the
  // stand-in zeros, as the balance card does.
  const unknownAmount = (sats: number) => (balanceRead ? numUtils.satoshisToAmount(sats) : '--')
  // While Available is unknown so is the rest of the balance: Unavailable
  // shows `--`, as on the balance card, not the whole total.
  const unavailableAmount = splitUnknown ? '--' : unknownAmount(unavailableSats)

  const showUnavailable = !balanceRead || splitUnknown || unavailableSats > 0

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
    setCheckedFeeRate(feeRate)
    setError('')
    setFeeCheckError('')
    setDisabled(true)
    setFeeDetail(undefined)
    setSpendPreview(undefined)
    setSendPlanPreview(undefined)
    setSendAllBesidePlan(false)
    setPrepareOutcome(undefined)
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

    // A Custom rate typed below the relay floor is refused, and the screen
    // says why, as it does for one above the ceiling.
    if (feeRateBelowMinimum) {
      setFeeCheckError(feeRateBelowMinimum)
      return
    }
    // Refused without a word: no rate yet (an empty input, "0" or "0." still
    // being typed) and a tier's rate below the floor, which the user did not
    // type.
    if (!Number.isFinite(feeRate) || feeRate < QBIT_MIN_RELAY_FEE_RATE) {
      return
    }

    if (hasQbitUtxoPreflight) {
      const previewFeeRate = Math.min(feeRate, QBIT_MAX_FEE_RATE)
      const sendAll = toSatoshis === qbitSpendableSatoshis
      // What MAX sends in one transaction; for an amount, also what the
      // largest outputs could send now, to offer when it is refused.
      const sendAllPreflight = estimateQbitP2mrSendAllPreflight({
        utxos: qbitSpendableUtxos,
        account: currentAccount,
        feeRate: previewFeeRate,
        memo: memo || undefined,
      })
      // What that one transaction pays the recipient if sent now; 0 when it cannot be sent.
      const sendAllSendable = qbitP2mrSendAllSendableSatoshis(sendAllPreflight)
      const preflight = sendAll
        ? sendAllPreflight
        : estimateQbitP2mrSendPreflight({
            utxos: qbitSpendableUtxos,
            account: currentAccount,
            amount: toSatoshis,
            feeRate: previewFeeRate,
            memo: memo || undefined,
          })

      // A payment one transaction cannot carry is priced as a send plan
      // (#188), on the same outputs and shape: MAX past what one
      // transaction carries, when the plan pays the recipient more, an
      // amount that needs more outputs than that, and an amount the balance
      // covers without its fees, for which the plan names what can be sent
      // instead.
      let planTarget: QbitSendPlanTarget | undefined
      if (isQbitFeeRateWithinPolicy(feeRate)) {
        if (sendAll) {
          if (sendAllPreflight.leftBehindInputCount > 0) planTarget = { kind: 'everything' }
        } else if (
          isQbitSendPlanAmount(toSatoshis) &&
          'exceedsStandardSize' in preflight &&
          (preflight.exceedsStandardSize ||
            (!preflight.canCover &&
              !preflight.exceedsAncestorSize &&
              !preflight.exceedsMaximumTotalFee))
        ) {
          planTarget = { kind: 'amount', amount: toSatoshis }
        }
      }
      // While another payment of the account is in progress the background
      // starts no plan beside it. MAX then sends one transaction of the
      // outputs that payment leaves free, which are the ones read here, as
      // MAX did before plans, and says that payment holds the rest. An
      // amount only a plan can pay waits for it, below.
      if (sendPlanInProgress && planTarget?.kind === 'everything') {
        planTarget = undefined
        setSendAllBesidePlan(true)
      }
      let planned: QbitSendPlan<UnspentOutput> | QbitSendPlanRefusal | undefined
      if (planTarget) {
        try {
          planned = planQbitP2mrSendPreflight({
            utxos: qbitSpendableUtxos,
            account: currentAccount,
            target: planTarget,
            feeRate,
            memo: memo || undefined,
          })
        } catch (e) {
          // The planner refuses only malformed input, which the checks above rule out.
          console.error('The send plan could not be priced:', e)
        }
      }
      // A plan that combines outputs replaces the one-transaction send; one
      // without merges is that send, previewed as before. MAX sends the most
      // the wallet can send now: a plan spends confirmed outputs only, and
      // one transaction of the largest outputs, unconfirmed ones included,
      // can pay more. The plan is chosen only when it pays the recipient
      // more; on a tie one transaction is, since it waits for nothing.
      // `in` narrows the plan here, where this package compiles without strict null checks.
      const planRefusal = planned && 'reason' in planned ? planned : undefined
      const plan = planned && !('reason' in planned) ? planned : undefined
      if (
        planTarget &&
        plan &&
        plan.merges.length > 0 &&
        (planTarget.kind === 'amount' || plan.payment.amount > sendAllSendable)
      ) {
        if (sendPlanInProgress) {
          // Only a plan pays this amount: Next waits for the payment in
          // progress, which the screen names and links to.
          setSendPlanPreview({ kind: 'open' })
          return
        }
        setSendPlanPreview({
          kind: 'plan',
          plan,
          recipientAddress: toInfo.address,
          target: planTarget,
          feeRate,
        })
        setSpendPreview({
          recipientAddress: toInfo.address,
          recipientSatoshis: plan.payment.amount,
          fee: plan.totalFee,
          vsize: plan.merges.reduce((sum, merge) => sum + merge.vsize, plan.payment.vsize),
        })
        setDisabled(false)
        return
      }
      // A refusal offers the most the user can send now: the plan's, from
      // confirmed outputs, or one transaction of the largest outputs,
      // unconfirmed ones included, when that sends more. While another
      // payment is in progress no plan can start, and only that one
      // transaction can be sent.
      const refuse = (refused: QbitSendPlanRefusal): void => {
        setSendPlanPreview(
          sendPlanInProgress || sendAllSendable > refused.maxSendable
            ? {
                kind: 'refusal',
                reason: refused.reason,
                offer: sendAllSendable,
                unconfirmedSatoshis: 0,
              }
            : {
                kind: 'refusal',
                reason: refused.reason,
                offer: refused.maxSendable,
                unconfirmedSatoshis: refused.unconfirmedSatoshis,
              }
        )
      }

      if (feeRate > QBIT_MAX_FEE_RATE || preflight.exceedsMaximumTotalFee) {
        setFeeCheckError(
          t('fee_exceeds_wallet_safety_maximum', [
            String(QBIT_MAX_FEE_RATE),
            numUtils.satoshisToAmount(preflight.maximumTotalFee),
            qbitUnit,
          ])
        )
        return
      }
      if ('exceedsStandardSize' in preflight && preflight.exceedsStandardSize) {
        if (planRefusal) {
          refuse(planRefusal)
          return
        }
        // A plan without merges would be a send that one transaction carries.
        setFeeCheckError(t('unknown_error'))
        return
      }
      if (preflight.exceedsAncestorSize) {
        setFeeCheckError(t('send_exceeds_ancestor_size'))
        return
      }
      if (!preflight.canCover) {
        if (planRefusal) {
          refuse(planRefusal)
          return
        }
        setFeeCheckError(t('amount_exceeds_your_available_balance'))
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
    isQbitP2mrSend,
    hasQbitUtxoPreflight,
    qbitSpendableSatoshis,
    qbitSpendableUtxos,
    currentAccount,
    feeRateBelowMinimum,
    sendPlanInProgress,
    t,
  ])

  const unavailableTipText = useMemo(() => t('unavailable_tooltip'), [t])

  // Until the fee bar has chosen the selected tier's rate from this screen's
  // quote, the rate is the bar's default or one from an earlier quote,
  // possibly another network's; once it has, the checks above run at that
  // rate a render later. Until then Next waits, and the fee is neither shown,
  // judged nor checked. A Custom rate is the user's own.
  const feeRateHeld = !useFeeRateSettled(feeQuote, checkedFeeRate)

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
    if (feeRateHeld) return { totalSpend: '--', feeWarnings: [] }
    const totalSpend = numUtils.satoshisToAmount(sentToOthers + fee)
    const assessment = assessQbitFee({
      fee,
      feeRate: fee / vsize,
      amount: sentToOthers,
      recommendedFeeRate:
        feeQuote.status === 'loaded' ? qbitRecommendedFeeRate(feeQuote.summary) : undefined,
    })
    const warning = qbitFeeWarningText(assessment, t, qbitUnit)
    return {
      totalSpend,
      ...(warning.title !== undefined ? { feeWarningTitle: warning.title } : {}),
      feeWarnings: warning.lines,
      // Said only once the quote has been read, not while it loads.
      ...(feeQuote.status === 'loaded' && warning.recommendationUnavailable !== undefined
        ? { feeRecommendationUnavailable: warning.recommendationUnavailable }
        : {}),
    }
  }, [spendPreview, walletOwnership, feeQuote, feeRateHeld, t, qbitUnit])

  // Max past the standard transaction size sends the largest outputs only.
  const leftBehindNote =
    !feeRateHeld && feeDetail && feeDetail.leftBehindInputCount > 0
      ? t('send_all_leaves_outputs_behind', [
          String(feeDetail.inputCount),
          numUtils.satoshisToAmount(feeDetail.leftBehindSats),
          qbitUnit,
          String(feeDetail.leftBehindInputCount),
        ])
      : undefined

  const formatCount = useMemo(() => qbitSendPlanCountFormat(locale), [locale])
  // The plan's card, priced at the settled rate, until Next's request to
  // prepare it is answered with a refusal.
  const plannedSend =
    !feeRateHeld && !prepareOutcome && sendPlanPreview?.kind === 'plan'
      ? sendPlanPreview
      : undefined
  const sendPlanNotice = useMemo((): TxCreateSendPlanNotice | undefined => {
    if (!plannedSend) return undefined
    const { plan } = plannedSend
    const transactions = plan.merges.length + 1
    // For the whole balance: confirmed outputs not worth their fee stay in
    // the account, and outputs not confirmed yet are not included, each
    // said on its own.
    const everything = plan.target === 'everything'
    const stays = everything ? plan.leftBehindSatoshis : 0
    const unconfirmed = everything ? plan.unconfirmedSatoshis : 0
    return {
      title: t(
        plan.target === 'everything'
          ? 'send_plan_notice_title_everything'
          : 'send_plan_notice_title',
        [String(transactions)]
      ),
      steps: qbitSendPlanStepsText(plan.merges.length, t),
      receives: `${qbitSendPlanAmount(plan.payment.amount)} ${qbitUnit}`,
      totalFee: `${qbitSendPlanAmount(plan.totalFee)} ${qbitUnit}`,
      signing: `${t('send_plan_signatures', [formatCount(plan.signatureCount)])} · ${qbitSendPlanTimeText(
        estimateQbitSendPlanSigningSeconds(plan.signatureCount, transactions),
        t
      )}`,
      leftBehind:
        stays > 0 ? t('send_plan_left_behind', [qbitSendPlanAmount(stays), qbitUnit]) : '',
      unconfirmed:
        unconfirmed > 0
          ? t('send_plan_unconfirmed_not_included', [qbitSendPlanAmount(unconfirmed), qbitUnit])
          : '',
    }
  }, [plannedSend, t, qbitUnit, formatCount])

  // Why the amount cannot be sent as it is: from the checks at the settled
  // rate, or from the background's answer to Next.
  const refusal =
    prepareOutcome?.kind === 'refused'
      ? prepareOutcome
      : !feeRateHeld && !prepareOutcome && sendPlanPreview?.kind === 'refusal'
        ? sendPlanPreview
        : undefined
  const sendPlanRefusal = useMemo((): TxCreateSendPlanRefusal | undefined => {
    if (!refusal) return undefined
    const { reason, offer, unconfirmedSatoshis } = refusal
    return {
      message: qbitSendPlanRefusalText(reason, t),
      offerText:
        offer > 0 ? t('send_plan_max_sendable', [qbitSendPlanAmount(offer), qbitUnit]) : '',
      offerButtonText:
        offer > 0 ? t('send_plan_use_max_sendable', [qbitSendPlanAmount(offer), qbitUnit]) : '',
      unconfirmedText:
        unconfirmedSatoshis > 0
          ? t('send_plan_unconfirmed_note', [qbitSendPlanAmount(unconfirmedSatoshis), qbitUnit])
          : '',
    }
  }, [refusal, t, qbitUnit])

  // The account's payment in progress keeps this amount waiting: from the
  // checks at the settled rate, or from the background's answer to Next.
  const sendPlanWaits =
    prepareOutcome?.kind === 'plan_open' ||
    (!feeRateHeld && !prepareOutcome && sendPlanPreview?.kind === 'open')

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
    if (splitUnknown) return
    setAutoAdjust(true)
    // Fill from the same spendable total that validation and the send use
    // (availableSatoshis), not accountBalance.availableBalance — otherwise Max
    // can under-fill spendable funds or set an amount that fails validation.
    setUiState({ inputAmount: numUtils.satoshisToAmount(availableSatoshis) })
  }

  const onRBFChange = (value: boolean) => {
    rbfChoices.current += 1
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

  // The amount a refusal offers, set only when the user chooses it: never
  // in place of the amount they typed without their say.
  const onClickMaxSendable = (): void => {
    if (!refusal || refusal.offer <= 0) return
    setAutoAdjust(false)
    setUiState({ inputAmount: numUtils.satoshisToAmount(refusal.offer) })
  }

  const onClickViewSendPlan = (): void => {
    nav.navigate('QbitSendPlanScreen')
  }

  // What Next's request was made for; an answer for anything else is dropped.
  const formScope = [
    chainType,
    currentAccount.address,
    toInfo.address,
    toSatoshis,
    feeRate,
    memo,
    enableRBF,
  ].join('|')
  const formScopeRef = useRef(formScope)
  formScopeRef.current = formScope

  /**
   * The background found the payment fits one transaction after all (it read
   * the account's outputs afresh): send it as one, from outputs read again
   * now, so the build does not refuse what the cache still holds. MAX takes
   * the whole balance those outputs hold.
   */
  const sendInOneTransaction = async (
    preview: Extract<SendPlanPreview, { kind: 'plan' }>,
    scope: string
  ): Promise<void> => {
    const snapshot = await fetchUtxos()
    if (!mountedRef.current || formScopeRef.current !== scope) return
    const toAmount =
      preview.target.kind === 'everything'
        ? getQbitP2mrSpendableUtxos(snapshot.utxos, currentAccount).reduce(
            (sum, utxo) => sum + utxo.satoshis,
            0
          )
        : preview.target.amount
    const toSignData = await prepareSendQBT({
      toAddressInfo: toInfo,
      toAmount,
      feeRate: preview.feeRate,
      enableRBF,
      memo: memo || undefined,
      utxoSnapshot: snapshot,
    })
    if (!mountedRef.current || formScopeRef.current !== scope) return
    nav.navigate('TxConfirmScreen', { toSignData })
  }

  /**
   * Ask the background to price the plan for review, once at a time. The
   * arguments cross a JSON port, so they are checked first as the background
   * checks them. A review goes to the review screen; a refusal stays on this
   * screen with its reason, and `not_needed` sends the payment as one
   * transaction. An answer that lands after the form changed is dropped.
   */
  const prepareSendPlan = async (
    preview: Extract<SendPlanPreview, { kind: 'plan' }>
  ): Promise<void> => {
    if (planPreparingRef.current) return
    const params: QbitSendPlanPrepareParams = {
      to: preview.recipientAddress,
      target: preview.target,
      feeRate: preview.feeRate,
      enableRBF,
      ...(memo ? { memo } : {}),
    }
    if (!isQbitFeeRateWithinPolicy(params.feeRate)) return
    if (params.target.kind === 'amount' && !isQbitSendPlanAmount(params.target.amount)) return
    const scope = formScopeRef.current
    planPreparingRef.current = true
    setPlanPreparing(true)
    setError('')
    tools.showLoading(true)
    try {
      const result = await wallet.prepareQbitSendPlan(params)
      if (!mountedRef.current || formScopeRef.current !== scope) return
      // `in` narrows the result here, where this package compiles without strict null checks.
      if ('review' in result) {
        nav.navigate('QbitSendPlanReviewScreen', { review: result.review })
        return
      }
      switch (result.reason) {
        case 'not_needed':
          await sendInOneTransaction(preview, scope)
          return
        case 'plan_open':
          // A plan this page has not read yet: it reads it now, and once the
          // plan shows, prices this send beside it.
          setPrepareOutcome({ kind: 'plan_open' })
          refreshSendPlan()
          return
        case 'outputs_unavailable':
          setError(t('send_plan_outputs_unavailable'))
          return
        default:
          setPrepareOutcome({
            kind: 'refused',
            reason: result.reason,
            offer: Number.isSafeInteger(result.maxSendable) ? Math.max(0, result.maxSendable) : 0,
            unconfirmedSatoshis: Number.isSafeInteger(result.unconfirmedSatoshis)
              ? Math.max(0, result.unconfirmedSatoshis)
              : 0,
          })
      }
    } catch (e) {
      if (mountedRef.current && formScopeRef.current === scope) {
        setError(qbitSendPlanErrorMessage(e, t('unknown_error')))
      }
    } finally {
      tools.showLoading(false)
      planPreparingRef.current = false
      if (mountedRef.current) setPlanPreparing(false)
    }
  }

  // Next's clicks, counted; leaving the screen counts as one more.
  const nextClicks = useRef(0)
  useEffect(
    () => (): void => {
      nextClicks.current += 1
    },
    []
  )

  const onClickNext = () => {
    const click = ++nextClicks.current
    if (plannedSend) {
      void prepareSendPlan(plannedSend)
      return
    }
    // A send built, or refused, for the form as it was when Next was
    // clicked: neither is shown once Next is clicked again or the screen is
    // left, nor once the store has cleared the form for another account or
    // network, which records a new scope.
    const isLatest = (): boolean =>
      nextClicks.current === click && store.getState().ui.sendFormScope === sendFormScope
    prepareSendQBT({
      toAddressInfo: toInfo,
      toAmount: toSatoshis,
      feeRate,
      enableRBF,
      memo: memo || undefined,
    })
      .then(toSignData => {
        if (!isLatest()) return
        nav.navigate('TxConfirmScreen', {
          toSignData,
        })
      })
      .catch(e => {
        if (!isLatest()) return
        console.log(e)
        setError(e.message)
      })
  }

  return {
    headerTitle,
    chain,

    toInfo,
    onAddressInputChange,
    // A new key for each scope the store records: the first account and
    // network known, and each clear for another account or network, also for
    // one that comes back. An input that keeps its own copy of a value, as
    // the address input does, is keyed on it to start again from the store's.
    formKey,

    toSatoshis,
    inputAmount,
    onAmountInputChange,
    onAmountMaxClick,
    enableRBF,
    onRBFChange,
    memo,
    onMemoChange,
    // None at a rate not yet settled: the estimate is then pending, also
    // when the check at the earlier rate failed and its error is not shown.
    feeDetail: feeRateHeld ? undefined : feeDetail,
    feeEstimatePending:
      feeRateHeld &&
      (feeDetail !== undefined || sendPlanPreview !== undefined || feeCheckError !== ''),
    leftBehindNote,
    spendSummary,
    // For the fee bar: the quote the fee check uses.
    feeQuote,

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

    // Checks of the fee made at a rate not yet settled say nothing of the settled one.
    error: error || (feeRateHeld ? '' : feeCheckError),
    disabled: disabled || feeRateHeld || planPreparing || prepareOutcome !== undefined,
    // A payment one transaction cannot carry (#188): the plan that sends it,
    // or why it cannot be sent and what can be sent instead.
    sendPlanNotice,
    sendPlanRefusal,
    // The account already has a payment in progress, shown with the link to
    // it: one this amount waits for, as only a plan can pay it, or, for MAX,
    // one that holds the rest of the balance.
    sendPlanOpenText: sendPlanWaits
      ? t('send_plan_already_open')
      : !feeRateHeld && sendAllBesidePlan
        ? t('send_plan_open_holds_rest')
        : '',
    onClickMaxSendable,
    onClickViewSendPlan,
    // Over the explorer's listing limit: the account can consolidate its outputs.
    showConsolidate: overExplorerLimit,
    // What consolidating does for sends, which read the outputs from the
    // account's history; not once that read has failed and the account
    // cannot send.
    consolidationNote: overExplorerLimit && !utxoLimitExceeded ? t('consolidation_send_note') : '',

    onClickNext,
    onClickConsolidate,
  }
}
