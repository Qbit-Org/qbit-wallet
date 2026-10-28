/**
 * Biometric (WebAuthn PRF) unlock types shared between the extension UI, the
 * background service, and wallet-state.
 *
 * The wallet password is wrapped with AES-256-GCM under a key derived via
 * HKDF-SHA256 from the PRF output of a platform passkey assertion. The PRF
 * secret never leaves the UI page that ran the WebAuthn ceremony; only this
 * wrapped record is persisted (chrome.storage.local via the background).
 */

export const BIOMETRIC_UNLOCK_RECORD_VERSION = 1

export interface BiometricUnlockRecord {
  version: typeof BIOMETRIC_UNLOCK_RECORD_VERSION
  /** WebAuthn credential id (base64url, as returned by the authenticator). */
  credentialId: string
  /** Random 32-byte PRF evaluation input (base64url). */
  prfSalt: string
  /** AES-256-GCM ciphertext of the wallet password (base64url). */
  wrappedPassword: string
  /** 12-byte AES-GCM IV (base64url). */
  iv: string
  /** Enrollment timestamp (ms since epoch), informational only. */
  createdAt: number
}

/** Status safe to expose broadly; contains no wrapped material. */
export interface BiometricUnlockStatus {
  enrolled: boolean
}
