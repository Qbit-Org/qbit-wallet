import { numUtils } from '@qbit/base-utils'
import {
  AccountSignMethod,
  ApprovalSession,
  DecodedPsbt,
  LocalPsbtSummary,
  QbitProviderApprovalContext,
  SignedData,
  SignState,
  ToSignData,
  ToSignInput,
} from '@qbit/wallet-shared'
import logger from 'loglevel'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApproval } from 'src/context/ApprovalContext'
import { useI18n } from 'src/context/I18nContext'
import { useTools } from 'src/context/ToolsContext'
import { useWallet } from 'src/context/WalletContext'
import { useCurrentAccountCapabilities } from 'src/hooks/accounts'
import { useAsyncEffect } from 'src/utils/ui-utils'
import { useWebsiteSafetyCheck } from './useConnectWebsiteCheck'

type AsyncStatus = 'idle' | 'loading' | 'success' | 'error'

interface PsbtDecodeState {
  index: number
  psbtHex: string
  website: string
  status: AsyncStatus
}

interface DecodedPsbtCacheEntry {
  psbtHex: string
  website: string
  decodedPsbt: DecodedPsbt
}

export const PSBT_DECODE_TIMEOUT_MS = 10_000
export const PSBT_WEBSITE_CHECK_TIMEOUT_MS = 10_000

export interface TxInfo {
  changedBalance: number
  rawtx: string
  psbtHex: string
  toSignInputs: ToSignInput[]
  txError: string
  decodedPsbt: DecodedPsbt
}

export const initTxInfo: TxInfo = {
  changedBalance: 0,
  rawtx: '',
  psbtHex: '',
  toSignInputs: [],
  txError: '',
  decodedPsbt: {
    inputInfos: [],
    outputInfos: [],
    fee: 0,
    feeRate: 0,
    risks: [],
    features: {
      rbf: false,
    },
    isScammer: false,
    shouldWarnFeeRate: false,
    recommendedFeeRate: 1,
    isCompleted: false,
  },
}

export interface SignPsbtProps {
  header?: React.ReactNode
  params: {
    data: {
      toSignDatas: ToSignData[]
    }
    context?: QbitProviderApprovalContext
    session?: ApprovalSession
  }
  /** The approval this screen renders; the default handlers settle only it. */
  approvalId?: string
  handleCancel?: () => void
  handleConfirm?: (signedDatas: SignedData[]) => void
  fromApproval?: boolean
}

export function useSignPsbtLogic(props: SignPsbtProps) {
  const {
    params: {
      data: { toSignDatas },
      session,
    },
    approvalId,
    handleCancel,
    handleConfirm,
  } = props
  const { resolveApproval, rejectApproval } = useApproval()

  const [isPsbtSigning, setIsPsbtSigning] = useState(false)
  const [isPsbtRiskPopoverVisible, setIsPsbtRiskPopoverVisible] = useState(false)
  const [isColdWalletSigning, setIsColdWalletSigning] = useState(false)
  const [readonlySignedPsbtHex, setReadonlySignedPsbtHex] = useState('')

  const wallet = useWallet()
  const tools = useTools()
  const accountCapabilities = useCurrentAccountCapabilities()
  const website = session?.origin
  const {
    status: websiteCheckStatus,
    result: websiteResult,
    warning: websiteCheckWarning,
    retry: retryWebsiteCheck,
    guardVersionRef: websiteGuardVersionRef,
    blockedRef: websiteBlockedRef,
  } = useWebsiteSafetyCheck(website, PSBT_WEBSITE_CHECK_TIMEOUT_MS)

  const { t } = useI18n()

  const [disclaimerVisible, setDisclaimerVisible] = useState(false)
  const [localPsbtSummary, setLocalPsbtSummary] = useState<LocalPsbtSummary | null>(null)

  const [signingTxIndex, setSigningTxIndex] = useState(toSignDatas.length > 1 ? -1 : 0)
  const [signedStates, setSignedStates] = useState<SignState[]>(
    toSignDatas.map(() => SignState.PENDING)
  )
  const hasRestoredFloorRisk = toSignDatas.some(
    toSignData => toSignData.signatureBudget?.restoredFloorRisk
  )

  const initialToSignData = toSignDatas[signingTxIndex]
  const initialWebsite = session?.origin || ''
  const [decodeState, setDecodeState] = useState<PsbtDecodeState>({
    index: signingTxIndex,
    psbtHex: initialToSignData?.psbtHex || '',
    website: initialWebsite,
    status: initialToSignData ? 'loading' : 'idle',
  })
  const [decodeAttempt, setDecodeAttempt] = useState(0)
  const decodeRequestGeneration = useRef(0)
  const decodedPsbtDatas = useRef<Array<DecodedPsbtCacheEntry | undefined>>([])

  const coldWalletSigningWebsiteGuardVersion = useRef<number | undefined>(undefined)

  const isMultipleViewMode = toSignDatas.length > 1

  const [allowQuickMultiSign, setAllowQuickMultiSign] = useState(false)

  //

  useEffect(() => {
    let active = true
    setAllowQuickMultiSign(false)

    if (
      websiteCheckStatus !== 'clear' ||
      !website ||
      toSignDatas.length <= 1 ||
      hasRestoredFloorRisk ||
      accountCapabilities.signMethod !== AccountSignMethod.Local
    ) {
      return undefined
    }

    if (websiteResult?.allowQuickMultiSign) {
      setAllowQuickMultiSign(true)
      return undefined
    }

    void wallet
      .getConnectedSites()
      .then(sites => {
        if (!active) return
        const site = sites.find(s => s.origin === website)
        setAllowQuickMultiSign(site?.allowQuickMultiSign === true)
      })
      .catch(error => {
        logger.error('Failed to read connected-site signing permissions:', error)
      })

    return () => {
      active = false
    }
  }, [
    accountCapabilities.signMethod,
    hasRestoredFloorRisk,
    toSignDatas.length,
    wallet,
    website,
    websiteCheckStatus,
    websiteResult,
  ])

  const currentToSignData = toSignDatas[signingTxIndex]
  const currentWebsite = session?.origin || ''

  const signedDatas = useRef<SignedData[]>([])

  useEffect(() => {
    if (!currentToSignData) {
      setDecodeState({
        index: signingTxIndex,
        psbtHex: '',
        website: currentWebsite,
        status: 'idle',
      })
      return undefined
    }

    const cachedEntry = decodedPsbtDatas.current[signingTxIndex]
    if (
      cachedEntry?.psbtHex === currentToSignData.psbtHex &&
      cachedEntry.website === currentWebsite
    ) {
      setDecodeState({
        index: signingTxIndex,
        psbtHex: currentToSignData.psbtHex,
        website: currentWebsite,
        status: 'success',
      })
      return undefined
    }

    const generation = ++decodeRequestGeneration.current
    setDecodeState({
      index: signingTxIndex,
      psbtHex: currentToSignData.psbtHex,
      website: currentWebsite,
      status: 'loading',
    })

    const timeoutId = setTimeout(() => {
      if (generation !== decodeRequestGeneration.current) {
        return
      }

      decodeRequestGeneration.current += 1
      setDecodeState({
        index: signingTxIndex,
        psbtHex: currentToSignData.psbtHex,
        website: currentWebsite,
        status: 'error',
      })
    }, PSBT_DECODE_TIMEOUT_MS)

    Promise.resolve()
      .then(() => wallet.decodePsbt(currentToSignData.psbtHex, currentWebsite))
      .then(decodedPsbt => {
        if (generation !== decodeRequestGeneration.current) {
          return
        }

        clearTimeout(timeoutId)
        decodedPsbtDatas.current[signingTxIndex] = {
          psbtHex: currentToSignData.psbtHex,
          website: currentWebsite,
          decodedPsbt,
        }
        setDecodeState({
          index: signingTxIndex,
          psbtHex: currentToSignData.psbtHex,
          website: currentWebsite,
          status: 'success',
        })
      })
      .catch(error => {
        if (generation !== decodeRequestGeneration.current) {
          return
        }

        clearTimeout(timeoutId)
        logger.error('Failed to decode PSBT data:', error)
        setDecodeState({
          index: signingTxIndex,
          psbtHex: currentToSignData.psbtHex,
          website: currentWebsite,
          status: 'error',
        })
      })

    return () => {
      clearTimeout(timeoutId)
      if (generation === decodeRequestGeneration.current) {
        decodeRequestGeneration.current += 1
      }
    }
  }, [currentToSignData?.psbtHex, currentWebsite, decodeAttempt, signingTxIndex, wallet])

  const currentDecodedPsbtEntry = decodedPsbtDatas.current[signingTxIndex]
  const currentDecodedPsbt =
    currentDecodedPsbtEntry?.website === currentWebsite &&
    currentDecodedPsbtEntry.psbtHex === currentToSignData?.psbtHex
      ? currentDecodedPsbtEntry.decodedPsbt
      : undefined

  const isDecodeStateCurrent =
    decodeState.index === signingTxIndex &&
    decodeState.psbtHex === (currentToSignData?.psbtHex || '') &&
    decodeState.website === currentWebsite
  const decodeError = isDecodeStateCurrent && decodeState.status === 'error'

  const networkFee = currentDecodedPsbt ? numUtils.satoshisToAmount(currentDecodedPsbt.fee) : '0'
  const isValid = currentDecodedPsbt ? currentDecodedPsbt.inputInfos.length > 0 : false
  const hasRisk = currentDecodedPsbt ? currentDecodedPsbt.risks.length > 0 : false

  let showFeeSection = false
  if (currentDecodedPsbt && currentDecodedPsbt.isCompleted) {
    showFeeSection = true
  }

  let isBlocked = false
  if (currentDecodedPsbt && currentDecodedPsbt.isScammer == true) {
    isBlocked = true
  }
  if (websiteCheckStatus === 'blocked') {
    isBlocked = true
  }

  const isAllSigned = signedStates.every(state => state === SignState.SUCCESS)
  const signedCount = signedStates.filter(state => state === SignState.SUCCESS).length

  const defaultHandleCancel = () => rejectApproval(approvalId)
  const actualHandleCancel = handleCancel || defaultHandleCancel

  const onRetryDecode = () => {
    if (!currentToSignData) {
      return
    }

    decodeRequestGeneration.current += 1
    decodedPsbtDatas.current[signingTxIndex] = undefined
    setDecodeState({
      index: signingTxIndex,
      psbtHex: currentToSignData.psbtHex,
      website: currentWebsite,
      status: 'loading',
    })
    setDecodeAttempt(attempt => attempt + 1)
  }

  const onRetryWebsiteCheck = () => {
    retryWebsiteCheck()
  }

  const onRejectApprovalError = () => {
    decodeRequestGeneration.current += 1
    actualHandleCancel()
  }

  const multiSignList = useMemo(() => {
    return toSignDatas.map((data, index) => {
      const signState = signedStates[index]
      let buttonText = 'View'
      if (signState == SignState.PENDING) {
        buttonText = t('view')
      } else if (signState == SignState.SUCCESS) {
        buttonText = t('signed')
      } else if (signState == SignState.FAILED) {
        buttonText = t('reject')
      }

      let buttonPreset = 'primary'
      if (signState === SignState.SUCCESS) {
        buttonPreset = 'approval'
      } else if (signState === SignState.FAILED) {
        buttonPreset = 'danger'
      }

      const psbtInfo = localPsbtSummary?.items?.[index]

      const onClick = () => {
        setSigningTxIndex(index)
      }
      return {
        index,
        buttonText,
        buttonPreset,
        psbtInfo,
        onClick,
      }
    })
  }, [toSignDatas, signedStates, localPsbtSummary, t])

  // action
  const onClickBack = () => {
    if (websiteCheckStatus === 'blocked') {
      actualHandleCancel()
      return
    }

    if (isMultipleViewMode && signingTxIndex != -1) {
      // back to multi sign view
      setSigningTxIndex(-1)
      setIsPsbtRiskPopoverVisible(false)
      return
    }
    actualHandleCancel()
  }

  // Resolves false only when a signing attempt failed while the approval
  // stayed interactive, so callers holding a restored-floor single-flight
  // lock know the challenge was not consumed and can re-arm a retry.
  const onClickSign = async (): Promise<boolean> => {
    if (currentDecodedPsbt?.risks?.length > 0) {
      setIsPsbtRiskPopoverVisible(true)
      return true
    }
    return onNextStep()
  }

  useAsyncEffect(async () => {
    if (toSignDatas.length <= 1) return
    try {
      const summary = await wallet.analyzeLocalPsbts(toSignDatas)
      setLocalPsbtSummary(summary)
    } catch (e) {
      logger.error('analyzeLocalPsbts failed:', e)
    }
  }, [])

  const reviewNextRestoredFloorRequest = (): boolean => {
    const index = toSignDatas.findIndex(
      (toSignData, requestIndex) =>
        Boolean(toSignData.signatureBudget?.restoredFloorRisk) &&
        signedStates[requestIndex] !== SignState.SUCCESS
    )
    if (index < 0) return false
    setDisclaimerVisible(false)
    setSigningTxIndex(index)
    tools.toastWarning(t('qbit_review_each_restored_signing_request'))
    return true
  }

  const onTryMultiSign = async () => {
    if (reviewNextRestoredFloorRequest()) return
    setDisclaimerVisible(true)
  }

  const onTrustSite = async () => {
    const origin = session?.origin
    if (!origin || websiteCheckStatus !== 'clear') return
    const trustWebsiteGuardVersion = websiteGuardVersionRef.current
    await wallet.updateConnectSite(origin, { allowQuickMultiSign: true })
    if (trustWebsiteGuardVersion !== websiteGuardVersionRef.current || websiteBlockedRef.current) {
      return
    }
    setAllowQuickMultiSign(true)
  }

  const onQuickMultiSign = async () => {
    if (reviewNextRestoredFloorRequest()) return
    // Run analysis if not yet done (user clicked before async summary completed)
    const signingWebsiteGuardVersion = websiteGuardVersionRef.current

    try {
      setIsPsbtSigning(true)
      // Yield to the JS event loop so the loading UI can render before heavy signing work begins
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      const summary = localPsbtSummary ?? (await wallet.analyzeLocalPsbts(toSignDatas))
      if (!localPsbtSummary) setLocalPsbtSummary(summary)

      if (summary.parseErrorCount > 0) {
        tools.toastError(t('failed_to_parse_psbt'))
        return
      }
      if (summary.hasSighashNone) {
        tools.toastError(t('sighash_none_detected'))
        return
      }
      for (let i = 0; i < toSignDatas.length; i++) {
        if (
          signingWebsiteGuardVersion !== websiteGuardVersionRef.current ||
          websiteBlockedRef.current
        ) {
          return
        }

        try {
          const toSignData = toSignDatas[i]
          const signedData = await wallet.signPsbtV2(toSignData)
          if (!onSignedData(signedData, i, signingWebsiteGuardVersion)) {
            return
          }
        } catch (e) {
          if (
            signingWebsiteGuardVersion !== websiteGuardVersionRef.current ||
            websiteBlockedRef.current
          ) {
            return
          }

          signedStates[i] = SignState.FAILED
          setSignedStates([...signedStates])
          tools.toastError(`Signing failed for PSBT ${i}: ${e.message}`)
        }
      }
    } catch (e) {
    } finally {
      setIsPsbtSigning(false)
      setDisclaimerVisible(false)
    }
  }

  const localSign = async (): Promise<boolean> => {
    const signingWebsiteGuardVersion = websiteGuardVersionRef.current

    try {
      const toSignData = toSignDatas[signingTxIndex]
      const signedData = await wallet.signPsbtV2(toSignData)
      onSignedData(signedData, signingTxIndex, signingWebsiteGuardVersion)
      // Even when the website guard rejects the handoff above, the successful
      // signPsbtV2 call already consumed the restored-floor challenge and PQC
      // budget, so the attempt must not be reported as retryable.
      return true
    } catch (e) {
      if (
        signingWebsiteGuardVersion !== websiteGuardVersionRef.current ||
        websiteBlockedRef.current
      ) {
        return false
      }

      logger.error('Local signing failed:', e)
      if (e.message.includes('Can not sign for input')) {
        tools.toastError(t('sign_psbt_input_error'))
      } else {
        tools.toastError(e.message)
      }
      signedStates[signingTxIndex] = SignState.FAILED
      setSignedStates([...signedStates])
      return false
    }
  }

  /**
   * A P2MR send the wallet built but does not sign itself (an external or
   * cold-wallet account) comes back as bytes this hook cannot parse and
   * never passes through signPsbtV2, which reserves the inputs of a locally
   * signed send until its broadcast is proven. The wallet reserves them here
   * instead, before the bytes reach the confirm screen: it checks the bytes
   * against the identity fixed at creation, registers the same wallet-owned
   * claim, and hands back that claim and identity for the result. A provider
   * request is not reserved here (the background locks its inputs at
   * approval), and a result that already carries a claim needs nothing.
   * Returns undefined, after reporting, when the wallet refuses the bytes.
   */
  const reserveExternallySignedSend = async (
    data: SignedData,
    index: number
  ): Promise<SignedData | undefined> => {
    const toSignData = toSignDatas[index]
    const signedTxData = data.psbtHex || data.rawtx
    if (
      !toSignData?.qbitBroadcastIdentity ||
      toSignData.providerContext ||
      data.qbitSendBroadcastClaim ||
      !signedTxData
    ) {
      return data
    }
    try {
      const reserved = await wallet.reserveExternallySignedQbitSend(toSignData, signedTxData)
      return {
        ...data,
        qbitBroadcastIdentity: reserved.qbitBroadcastIdentity,
        qbitSendBroadcastClaim: reserved.qbitSendBroadcastClaim,
      }
    } catch (e) {
      tools.toastError(e.message)
      return undefined
    }
  }

  const onNextStep = async (): Promise<boolean> => {
    switch (accountCapabilities.signMethod) {
      case AccountSignMethod.ColdWallet:
        coldWalletSigningWebsiteGuardVersion.current = websiteGuardVersionRef.current
        setIsColdWalletSigning(true)
        return true
      case AccountSignMethod.External: {
        if (!readonlySignedPsbtHex) {
          tools.toastError(t('invalid_psbt'))
          return false
        }

        const signingWebsiteGuardVersion = websiteGuardVersionRef.current
        const signedData = await reserveExternallySignedSend(
          { psbtHex: readonlySignedPsbtHex },
          signingTxIndex
        )
        if (!signedData) return false
        if (onSignedData(signedData, signingTxIndex, signingWebsiteGuardVersion)) {
          setReadonlySignedPsbtHex('')
          return true
        }
        return false
      }
      case AccountSignMethod.Local:
        return localSign()
      case AccountSignMethod.None:
      default:
        tools.toastError(t('not_supported'))
        return false
    }
  }

  /**
   * A result refused by the handoff below already carries the reservation
   * the wallet registered for it: the claim signPsbtV2 mints when it signs
   * a wallet-built send locally, or the one reserveExternallySignedQbitSend
   * registers for externally or cold-wallet signed bytes. The bytes are
   * discarded and never reach the confirm screen, so nothing could retry or
   * abandon them afterwards, and without this release the claim would keep
   * the inputs reserved until the background restarts. A provider result is
   * left alone: its claim belongs to the provider request that opened the
   * approval, which the background releases when the request is rejected or
   * fails, the window closing included. Never throws: the claim lives in
   * background memory only, and a dead port is cleared by the next restart.
   */
  const releaseRefusedSendClaim = async (data: SignedData, index: number): Promise<void> => {
    const claim = data.qbitSendBroadcastClaim
    if (!claim || toSignDatas[index]?.providerContext) return
    try {
      await wallet.releaseQbitSendBroadcastClaim(claim)
    } catch {
      // Nothing to do: see above.
    }
  }

  const onSignedData = (
    data: SignedData,
    signingTxIndex: number,
    signingWebsiteGuardVersion: number
  ) => {
    if (
      signingWebsiteGuardVersion !== websiteGuardVersionRef.current ||
      websiteBlockedRef.current
    ) {
      void releaseRefusedSendClaim(data, signingTxIndex)
      return false
    }

    signedStates[signingTxIndex] = SignState.SUCCESS
    setSignedStates([...signedStates])

    // The local signer echoes the network and expected txid the wallet fixed
    // when it built the PSBT; an external or cold-wallet signer returns only
    // the bytes it produced, which this hook cannot parse. That identity does
    // not depend on the signature, so it is carried from the request onto
    // every result as the transaction the bytes are expected to be. The send
    // flow hands both to the controller, which refuses bytes for any other
    // transaction before the first broadcast and every retry, and binds an
    // accepted broadcast, and any probe after a lost answer, to that network
    // and txid.
    const requestIdentity = toSignDatas[signingTxIndex]?.qbitBroadcastIdentity
    signedDatas.current[signingTxIndex] =
      requestIdentity && !data.qbitBroadcastIdentity
        ? { ...data, qbitBroadcastIdentity: requestIdentity }
        : data

    // single mode
    if (!isMultipleViewMode) {
      if (handleConfirm) {
        handleConfirm(signedDatas.current)
      } else {
        resolveApproval(approvalId, signedDatas.current)
      }
      return true
    }

    // multiple mode
    const isAllSigned = signedStates.every(state => state === SignState.SUCCESS)
    if (isAllSigned) {
      if (handleConfirm) {
        handleConfirm(signedDatas.current)
      } else {
        resolveApproval(approvalId, signedDatas.current)
      }
      return true
    } else {
      setSigningTxIndex(-1)
      setIsPsbtRiskPopoverVisible(false)
      return true
    }
  }

  // coldwallet
  /**
   * The cold-wallet signer hands back only the signed PSBT hex it scanned,
   * as a bare string. It is wrapped into signed data here, before the
   * reservation and the handoff, so both see the shape every other signer
   * produces and the confirm screen or approval reads its `psbtHex`.
   */
  const onColdWalletSigningSuccess = async (signedPsbtHex: string) => {
    const signingWebsiteGuardVersion = coldWalletSigningWebsiteGuardVersion.current
    coldWalletSigningWebsiteGuardVersion.current = undefined
    setIsColdWalletSigning(false)
    if (signingWebsiteGuardVersion === undefined) {
      return
    }

    const signedData = await reserveExternallySignedSend({ psbtHex: signedPsbtHex }, signingTxIndex)
    if (!signedData) return
    onSignedData(signedData, signingTxIndex, signingWebsiteGuardVersion)
  }

  const onColdWalletSigningBack = () => {
    coldWalletSigningWebsiteGuardVersion.current = undefined
    setIsColdWalletSigning(false)
  }

  // risk popover
  const onRiskPopoverConfirm = async (): Promise<boolean> => {
    setIsPsbtRiskPopoverVisible(false)
    return onNextStep()
  }

  const onRiskPopoverClose = () => {
    setIsPsbtRiskPopoverVisible(false)
  }

  // disclaimer modal
  const onDisclaimerModalClose = () => {
    setDisclaimerVisible(false)
  }

  const showMultiSignView = isMultipleViewMode && signingTxIndex == -1
  const isDecodeLoading =
    !showMultiSignView &&
    !!currentToSignData &&
    (!isDecodeStateCurrent || decodeState.status === 'loading' || !currentDecodedPsbt)
  const showLoading = !decodeError && (websiteCheckStatus === 'checking' || isDecodeLoading)

  const backButtonText = isMultipleViewMode ? t('back') : t('reject')

  return {
    isPsbtRiskPopoverVisible,
    t,
    session,
    isPsbtSigning,

    // page state
    isColdWalletSigning,
    showMultiSignView,
    showLoading,
    decodeError,
    websiteCheckStatus,
    websiteCheckWarning,

    disclaimerVisible,
    localPsbtSummary,

    // data
    toSignDatas,
    currentToSignData,
    currentDecodedPsbt,
    readonlySignedPsbtHex,
    setReadonlySignedPsbtHex,

    // state
    networkFee,
    isValid,
    hasRisk,
    showFeeSection,
    isBlocked,
    allowQuickMultiSign,

    // multiple sign state
    isAllSigned,
    signedCount,
    multiSignList,

    // actions
    backButtonText,
    onClickBack,
    onClickSign,
    onRetryDecode,
    onRetryWebsiteCheck,
    onRejectApprovalError,
    onQuickMultiSign,
    onTryMultiSign,
    onTrustSite,

    onColdWalletSigningSuccess,
    onColdWalletSigningBack,

    onRiskPopoverConfirm,
    onRiskPopoverClose,

    onDisclaimerModalClose,
  }
}
