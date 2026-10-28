import {
  BIOMETRIC_UNLOCK_RECORD_VERSION,
  type BiometricUnlockRecord,
} from '@qbit/wallet-shared'

import { base64UrlToBytes, unwrapSecret, wrapSecret } from './crypto'
import { assertPrfOutput, createBiometricCredential } from './webauthn'

export {
  BiometricCeremonyCancelledError,
  BiometricEnrollmentIncompleteError,
  BiometricPrfUnsupportedError,
  isBiometricUnlockSupported,
} from './webauthn'

/**
 * The PRF-derived key from a live assertion failed to decrypt the stored
 * record — the one condition that definitively proves the record is stale
 * (wrapped under a different password/secret). Every other failure mode
 * (ceremony errors, transient authenticator DOMExceptions) keeps its own
 * type so callers never discard a possibly-valid record over a hiccup.
 */
export class BiometricUnwrapFailedError extends Error {
  constructor(message = 'stored biometric record failed to decrypt') {
    super(message)
    this.name = 'BiometricUnwrapFailedError'
  }
}

/**
 * Full enrollment: create a platform passkey (PRF hard-required), wrap the
 * wallet password under the PRF-derived AES-256-GCM key, and return the
 * record for the background to persist. The PRF secret and derived key never
 * leave this function.
 */
export async function enrollBiometricUnlock(password: string): Promise<BiometricUnlockRecord> {
  const enrollment = await createBiometricCredential()
  const { wrapped, iv } = await wrapSecret(
    password,
    enrollment.prfOutput,
    base64UrlToBytes(enrollment.credentialId)
  )
  return {
    version: BIOMETRIC_UNLOCK_RECORD_VERSION,
    credentialId: enrollment.credentialId,
    prfSalt: enrollment.prfSalt,
    wrappedPassword: wrapped,
    iv,
    createdAt: Date.now(),
  }
}

/**
 * TouchID-gated assertion → unwrap the wallet password from the record.
 * Throws BiometricCeremonyCancelledError when the user dismisses the prompt;
 * any decrypt failure means the record is stale (e.g. wrapped under an old
 * password scheme) and the caller should clear it.
 */
export async function unwrapBiometricPassword(record: BiometricUnlockRecord): Promise<string> {
  const prfOutput = await assertPrfOutput(record.credentialId, record.prfSalt)
  try {
    return await unwrapSecret(
      { wrapped: record.wrappedPassword, iv: record.iv },
      prfOutput,
      base64UrlToBytes(record.credentialId)
    )
  } catch (error) {
    throw new BiometricUnwrapFailedError()
  }
}

/**
 * Re-wrap a new password under the already-enrolled credential (one fresh
 * assertion, no new passkey). Used right after a password change so the
 * feature survives it without re-enrollment.
 */
export async function rewrapBiometricPassword(
  record: BiometricUnlockRecord,
  newPassword: string
): Promise<BiometricUnlockRecord> {
  const prfOutput = await assertPrfOutput(record.credentialId, record.prfSalt)
  const { wrapped, iv } = await wrapSecret(
    newPassword,
    prfOutput,
    base64UrlToBytes(record.credentialId)
  )
  return {
    ...record,
    wrappedPassword: wrapped,
    iv,
    createdAt: Date.now(),
  }
}
