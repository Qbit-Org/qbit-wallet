import { useCallback, useEffect, useState } from 'react'
import { BiometricUnlockRecord } from '@qbit/wallet-shared'
import {
  BiometricEnrollmentIncompleteError,
  BiometricPrfUnsupportedError,
  BiometricUnwrapFailedError,
  enrollBiometricUnlock,
  isBiometricUnlockSupported,
  rewrapBiometricPassword,
  unwrapBiometricPassword,
} from 'src/biometric'
import { useWallet } from 'src/context'
import { useUnlockCallback } from 'src/hooks/global'

/** Thrown when the stored record no longer decrypts to the wallet password. */
export class BiometricRecordStaleError extends Error {
  constructor(message = 'biometric unlock record is stale and has been cleared') {
    super(message)
    this.name = 'BiometricRecordStaleError'
  }
}

/** Thrown when enrollment step-up is attempted with a wrong wallet password. */
export class BiometricPasswordInvalidError extends Error {
  constructor(message = 'wallet password is incorrect') {
    super(message)
    this.name = 'BiometricPasswordInvalidError'
  }
}

/** Outcome of a password change for an enrolled (or unenrolled) wallet. */
export type BiometricPasswordChangeOutcome = 'kept' | 'dropped' | 'none'

/**
 * UI-side orchestration for biometric unlock — the single front door for
 * every biometric flow (enroll, unlock, disable, password change).
 * Capability detection runs once on mount (never inline before a ceremony —
 * see isBiometricUnlockSupported); enrollment state lives in the background
 * service.
 */
export function useBiometricUnlock() {
  const wallet = useWallet()
  const unlock = useUnlockCallback()
  const [supported, setSupported] = useState(false)
  const [enrolled, setEnrolled] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([isBiometricUnlockSupported(), wallet.getBiometricUnlockStatus()])
      .then(([isSupported, status]) => {
        if (cancelled) return
        setSupported(isSupported)
        setEnrolled(status.enrolled)
      })
      .catch(() => {
        // Detection failure just leaves the feature hidden.
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [wallet])

  /** Passkey ceremony + persist; requires the wallet password (step-up). */
  const enroll = useCallback(
    async (password: string) => {
      // Step-up check BEFORE the ceremony: a wrong password must not mint an
      // orphaned platform credential. The background re-verifies on save.
      const isValidPassword = await wallet.verifyPassword(password)
      if (!isValidPassword) {
        throw new BiometricPasswordInvalidError()
      }
      let record
      try {
        record = await enrollBiometricUnlock(password)
      } catch (error) {
        if (
          error instanceof BiometricEnrollmentIncompleteError ||
          error instanceof BiometricPrfUnsupportedError
        ) {
          // Both are thrown only after create() succeeded and replaced any
          // prior credential with the same user handle, so a previously
          // stored record can no longer be asserted — discard it rather
          // than leave broken TouchID unlock.
          await wallet.clearBiometricUnlock()
          setEnrolled(false)
        }
        throw error
      }
      await wallet.saveBiometricUnlockRecord(record, password)
      setEnrolled(true)
    },
    [wallet]
  )

  const disable = useCallback(async () => {
    await wallet.clearBiometricUnlock()
    setEnrolled(false)
  }, [wallet])

  /**
   * TouchID assertion → unwrap password → normal unlock path. A record that
   * no longer decrypts or no longer verifies is cleared (self-heal) and
   * surfaced as BiometricRecordStaleError so the UI can fall back to the
   * password input.
   */
  const unlockWithBiometric = useCallback(async () => {
    const record = await wallet.getBiometricUnlockRecord()
    if (!record) {
      setEnrolled(false)
      throw new BiometricRecordStaleError()
    }
    let password: string
    try {
      password = await unwrapBiometricPassword(record)
    } catch (error) {
      // Only a definitive AES-GCM decrypt failure proves the record stale.
      // Everything else — dismissed prompt, PRF hiccup, or any transient
      // authenticator DOMException (AbortError, NotReadableError, ...) —
      // keeps the record and lets the user retry or type the password.
      if (!(error instanceof BiometricUnwrapFailedError)) {
        throw error
      }
      await wallet.clearBiometricUnlock()
      setEnrolled(false)
      throw new BiometricRecordStaleError()
    }
    // Discard the record only when the unwrapped password provably no longer
    // matches the vault. A verifyPassword rejection (background hiccup,
    // port drop) is transient — propagate it without clearing.
    const isValidPassword = await wallet.verifyPassword(password)
    if (!isValidPassword) {
      await wallet.clearBiometricUnlock()
      setEnrolled(false)
      throw new BiometricRecordStaleError()
    }
    await unlock(password)
  }, [wallet, unlock])

  /**
   * The full password-change protocol for a biometric-capable wallet: the
   * record must be snapshotted BEFORE changePassword (the keyring lifecycle
   * hook destroys it inside the change mutex) and re-wrapped under the same
   * passkey afterwards with one fresh assertion. Owning the ordering here
   * keeps that temporal invariant out of UI screens. A changePassword
   * failure propagates untouched; a rewrap failure degrades to 'dropped'
   * (biometrics off until re-enrolled) — never to a stale record.
   */
  const changePasswordKeepingBiometric = useCallback(
    async (
      oldPassword: string,
      newPassword: string
    ): Promise<BiometricPasswordChangeOutcome> => {
      const staleRecord = await wallet.getBiometricUnlockRecord()
      await wallet.changePassword(oldPassword, newPassword)
      if (!staleRecord) {
        return 'none'
      }
      try {
        const record: BiometricUnlockRecord = await rewrapBiometricPassword(
          staleRecord,
          newPassword
        )
        await wallet.saveBiometricUnlockRecord(record, newPassword)
        setEnrolled(true)
        return 'kept'
      } catch {
        // Assertion declined or failed: the old record is already
        // invalidated, so biometric unlock is simply off.
        setEnrolled(false)
        return 'dropped'
      }
    },
    [wallet]
  )

  return {
    ready,
    supported,
    enrolled,
    enroll,
    disable,
    unlockWithBiometric,
    changePasswordKeepingBiometric,
  }
}
