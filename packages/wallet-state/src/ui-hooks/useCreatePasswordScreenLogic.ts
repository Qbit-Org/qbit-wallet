import { useEffect, useMemo, useState } from 'react'
import {
  isBiometricUnlockSupported,
  BiometricCeremonyCancelledError,
  BiometricEnrollmentIncompleteError,
  BiometricPrfUnsupportedError,
} from 'src/biometric'
import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
import { getPasswordStrengthWord, MIN_PASSWORD_LENGTH } from 'src/utils/password-utils'

import { useBiometricUnlock } from './useBiometricUnlock'

export interface CreatePasswordScreenOptions {
  /**
   * Whether to offer the optional "Enable Touch ID" step after boot. The
   * extension passes false in the browser-action popup, where the TouchID
   * sheet can close the surface mid-ceremony; enrollment stays available
   * later via Settings → Security, which routes the popup to a full tab.
   */
  offerBiometrics?: boolean
}

export function useCreatePasswordScreenLogic(options: CreatePasswordScreenOptions = {}) {
  const nav = useNavigation()
  const { isNewAccount, fromColdWallet } = nav.getRouteState<'CreatePasswordScreen'>()
  const [newPassword, setNewPassword] = useState('')
  const { t } = useI18n()

  const [confirmPassword, setConfirmPassword] = useState('')

  const [disabled, setDisabled] = useState(true)

  // Optional post-boot "Enable Touch ID" step. Kept inside this screen (no
  // route change) so the freshly created password never leaves component
  // state.
  const [biometricStepVisible, setBiometricStepVisible] = useState(false)
  const [biometricEnrolling, setBiometricEnrolling] = useState(false)

  const wallet = useWallet()
  const { enroll: enrollBiometric } = useBiometricUnlock()

  const tools = useTools()

  const navigateAfterBoot = () => {
    if (fromColdWallet) {
      nav.navigate('CreateColdWalletScreen', { fromUnlock: true })
    } else if (isNewAccount) {
      nav.navigate('CreateHDWalletScreen', { isImport: false, fromUnlock: true })
    } else {
      nav.navigate('CreateHDWalletScreen', { isImport: true, fromUnlock: true })
    }
  }

  const bootWithPassword = (password: string) => {
    wallet
      .boot(password)
      .then(() =>
        options.offerBiometrics === false
          ? false
          : isBiometricUnlockSupported().catch(() => false)
      )
      .then(supported => {
        if (supported) {
          setBiometricStepVisible(true)
        } else {
          navigateAfterBoot()
        }
      })
      .catch(err => {
        tools.toastError(err)
      })
  }

  const onEnableBiometric = async () => {
    if (biometricEnrolling) {
      return
    }
    setBiometricEnrolling(true)
    try {
      await enrollBiometric(newPassword)
      navigateAfterBoot()
    } catch (err) {
      if (
        err instanceof BiometricCeremonyCancelledError ||
        (err instanceof BiometricEnrollmentIncompleteError && err.cancelled)
      ) {
        // The user dismissed a prompt; stay on the step so they can retry
        // or skip.
      } else if (err instanceof BiometricPrfUnsupportedError) {
        tools.toastError(t('touch_id_prf_unsupported'))
      } else {
        tools.toastError(t('touch_id_setup_failed'))
      }
    } finally {
      setBiometricEnrolling(false)
    }
  }

  const onSkipBiometric = () => {
    navigateAfterBoot()
  }

  useEffect(() => {
    setDisabled(true)

    if (
      newPassword &&
      newPassword.length >= MIN_PASSWORD_LENGTH &&
      newPassword === confirmPassword
    ) {
      setDisabled(false)
      return
    }
  }, [newPassword, confirmPassword])

  const strongTextRenderData = useMemo(() => {
    if (!newPassword) {
      return null
    }
    return getPasswordStrengthWord(newPassword, t)
  }, [newPassword, t])

  const matchTextRenderData = useMemo(() => {
    if (!confirmPassword) {
      return null
    }

    if (newPassword !== confirmPassword) {
      return {
        text: t('passwords_dont_match'),
      }
    }
    return null
  }, [newPassword, confirmPassword])

  const onClickConfirm = () => {
    bootWithPassword(newPassword)
  }

  const onPasswordChange = (e: string | { target: { value: string } }) => {
    const val = typeof e === 'string' ? e : e.target.value
    setNewPassword(val)
  }

  const onConfirmPasswordChange = (e: string | { target: { value: string } }) => {
    const val = typeof e === 'string' ? e : e.target.value
    setConfirmPassword(val)
  }

  return {
    disabled,
    strongTextRenderData,
    matchTextRenderData,
    onClickConfirm,
    onPasswordChange,
    onConfirmPasswordChange,
    biometricStepVisible,
    biometricEnrolling,
    onEnableBiometric,
    onSkipBiometric,
  }
}
