import {
  AccountSignMethod,
  QbitProviderApprovalContext,
  SignedMessage,
  SignState,
  ToSignMessage,
} from '@qbit/wallet-shared'
import logger from 'loglevel'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApproval, useI18n, useTools, useWallet } from 'src/context'
import { useCurrentAccountCapabilities } from 'src/hooks'
import { shortAddress } from 'src/utils/ui-utils'
import { useWebsiteSafetyCheck } from './useConnectWebsiteCheck'

export const SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS = 10_000
export interface SignMessageProps {
  header?: React.ReactNode
  params: {
    data: {
      toSignMessages: ToSignMessage[]
    }
    context?: QbitProviderApprovalContext
    session?: {
      origin: string
      icon: string
      name: string
    }
  }
  /** The approval this screen renders; the default handlers settle only it. */
  approvalId?: string
  handleCancel?: () => void
  handleConfirm?: (signedMessages: SignedMessage[]) => void
}

export function useSignMessageLogic(props: SignMessageProps) {
  const {
    params: {
      data: { toSignMessages },
      session,
    },
    approvalId,
    handleCancel,
    handleConfirm,
  } = props

  const { resolveApproval, rejectApproval } = useApproval()

  const [isColdWalletSigning, setIsColdWalletSigning] = useState(false)
  const [readonlySignature, setReadonlySignature] = useState('')

  const wallet = useWallet()
  const tools = useTools()
  const accountCapabilities = useCurrentAccountCapabilities()
  const website = session?.origin
  const {
    status: websiteCheckStatus,
    result: websiteResult,
    warning: websiteCheckWarning,
    retry: onRetryWebsiteCheck,
    guardVersionRef: websiteGuardVersionRef,
    blockedRef: websiteBlockedRef,
  } = useWebsiteSafetyCheck(website, SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS)

  const { t } = useI18n()

  const [disclaimerVisible, setDisclaimerVisible] = useState(false)

  const [signingTxIndex, setSigningTxIndex] = useState(toSignMessages.length > 1 ? -1 : 0)
  const [signedStates, setSignedStates] = useState<SignState[]>(
    toSignMessages.map(() => SignState.PENDING)
  )
  const hasRestoredFloorRisk = toSignMessages.some(
    toSignMessage => toSignMessage.signatureBudget?.restoredFloorRisk
  )

  const isMultipleViewMode = toSignMessages.length > 1
  const [allowQuickMultiSign, setAllowQuickMultiSign] = useState(false)

  useEffect(() => {
    let active = true
    setAllowQuickMultiSign(false)

    if (
      websiteCheckStatus !== 'clear' ||
      !website ||
      toSignMessages.length <= 1 ||
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
    toSignMessages.length,
    wallet,
    website,
    websiteCheckStatus,
    websiteResult,
  ])

  const currentToSignMessage = toSignMessages[signingTxIndex]

  const signedMessages = useRef<SignedMessage[]>([])
  const coldWalletSigningGuardVersion = useRef<number | undefined>(undefined)

  const isBlocked = websiteCheckStatus === 'blocked'

  const isAllSigned = signedStates.every(state => state === SignState.SUCCESS)
  const signedCount = signedStates.filter(state => state === SignState.SUCCESS).length

  const defaultHandleCancel = () => rejectApproval(approvalId)
  const actualHandleCancel = handleCancel || defaultHandleCancel

  const multiSignList = useMemo(() => {
    return toSignMessages.map((data, index) => {
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

      let title = shortAddress(data.text, 10)

      const onClick = () => {
        setSigningTxIndex(index)
      }
      return {
        index,
        title,
        buttonText,
        buttonPreset,
        onClick,
      }
    })
  }, [toSignMessages, signedStates, t])

  // action
  const onClickBack = () => {
    if (websiteCheckStatus === 'blocked') {
      actualHandleCancel()
      return
    }

    if (isMultipleViewMode && signingTxIndex != -1) {
      // back to multi sign view
      setSigningTxIndex(-1)
      return
    }
    actualHandleCancel()
  }

  const onClickSign = () => {
    onNextStep()
  }

  const reviewNextRestoredFloorRequest = (): boolean => {
    const index = toSignMessages.findIndex(
      (toSignMessage, requestIndex) =>
        Boolean(toSignMessage.signatureBudget?.restoredFloorRisk) &&
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
    const signingGuardVersion = websiteGuardVersionRef.current

    for (let i = 0; i < toSignMessages.length; i++) {
      if (
        signingGuardVersion !== websiteGuardVersionRef.current ||
        websiteBlockedRef.current
      ) {
        return
      }

      if (signedStates[i] === SignState.SUCCESS) {
        continue
      }
      try {
        const toSignMessage = toSignMessages[i]
        const signedData = await wallet.signMessage(toSignMessage)
        if (!onSignedData(signedData, i, signingGuardVersion)) return
      } catch (e) {
        if (
          signingGuardVersion !== websiteGuardVersionRef.current ||
          websiteBlockedRef.current
        ) {
          return
        }

        signedStates[i] = SignState.FAILED
        setSignedStates([...signedStates])
        logger.error(`Quick signing message ${i} failed:`, e)
        await rejectApproval(approvalId)
        return
      }
    }
  }

  const localSign = async () => {
    const signingGuardVersion = websiteGuardVersionRef.current

    try {
      const toSignMessage = toSignMessages[signingTxIndex]
      const signedData = await wallet.signMessage(toSignMessage)
      onSignedData(signedData, signingTxIndex, signingGuardVersion)
    } catch (e) {
      if (
        signingGuardVersion !== websiteGuardVersionRef.current ||
        websiteBlockedRef.current
      ) {
        return
      }

      signedStates[signingTxIndex] = SignState.FAILED
      setSignedStates([...signedStates])
      logger.error('Local signing failed:', e)
      await rejectApproval(approvalId)
    }
  }

  const onNextStep = () => {
    switch (accountCapabilities.signMethod) {
      case AccountSignMethod.ColdWallet:
        coldWalletSigningGuardVersion.current = websiteGuardVersionRef.current
        setIsColdWalletSigning(true)
        return
      case AccountSignMethod.External:
        if (!readonlySignature) {
          tools.toastError(t('please_enter_your_signature'))
          return
        }

        if (
          onSignedData(
            { signature: readonlySignature },
            signingTxIndex,
            websiteGuardVersionRef.current
          )
        ) {
          setReadonlySignature('')
        }
        return
      case AccountSignMethod.Local:
        localSign()
        return
      case AccountSignMethod.None:
      default:
        tools.toastError(t('not_supported'))
    }
  }

  const onSignedData = (
    data: SignedMessage,
    signingTxIndex: number,
    signingGuardVersion: number
  ) => {
    if (
      signingGuardVersion !== websiteGuardVersionRef.current ||
      websiteBlockedRef.current
    ) {
      return false
    }

    signedStates[signingTxIndex] = SignState.SUCCESS
    setSignedStates([...signedStates])

    signedMessages.current[signingTxIndex] = data

    // check if all signed

    // single mode
    if (!isMultipleViewMode) {
      if (handleConfirm) {
        handleConfirm(signedMessages.current)
      } else {
        resolveApproval(approvalId, signedMessages.current)
      }
      return true
    }

    // multiple mode
    const isAllSigned = signedStates.every(state => state === SignState.SUCCESS)
    if (isAllSigned) {
      if (handleConfirm) {
        handleConfirm(signedMessages.current)
      } else {
        resolveApproval(approvalId, signedMessages.current)
      }
      return true
    } else {
      setSigningTxIndex(-1)
      return true
    }
  }

  // coldwallet
  const onColdWalletSigningSuccess = (data: SignedMessage) => {
    const signingGuardVersion = coldWalletSigningGuardVersion.current
    coldWalletSigningGuardVersion.current = undefined
    setIsColdWalletSigning(false)
    if (signingGuardVersion === undefined) return
    onSignedData(data, signingTxIndex, signingGuardVersion)
  }

  const onColdWalletSigningBack = () => {
    coldWalletSigningGuardVersion.current = undefined
    setIsColdWalletSigning(false)
  }

  // disclaimer modal
  const onDisclaimerModalClose = () => {
    setDisclaimerVisible(false)
  }

  const showMultiSignView = isMultipleViewMode && signingTxIndex == -1

  return {
    loading: websiteCheckStatus === 'checking',
    t,
    session,

    // page state
    isColdWalletSigning,
    showMultiSignView,

    disclaimerVisible,

    // data
    toSignMessages,
    currentToSignMessage,

    // state
    websiteCheckStatus,
    websiteCheckWarning,
    isBlocked,
    allowQuickMultiSign,

    // multiple sign state
    isAllSigned,
    signedCount,
    multiSignList,

    // actions
    onClickBack,
    onClickSign,
    onRetryWebsiteCheck,
    onQuickMultiSign,
    onTryMultiSign,
    onTrustSite,

    onColdWalletSigningSuccess,
    onColdWalletSigningBack,

    readonlySignature,
    setReadonlySignature,

    onDisclaimerModalClose,
  }
}
