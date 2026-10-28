/**
 * WebAuthn ceremonies for biometric unlock. Must run in an extension UI page
 * (popup/tab/sidepanel) — navigator.credentials does not exist in the MV3
 * service worker. The extension origin acts as its own relying party
 * (rp.id omitted → the chrome-extension:// effective domain), the pattern
 * MetaMask and OKX ship.
 */
import { base64UrlToBytes, bytesToBase64Url, randomBytes } from './crypto'

const CEREMONY_TIMEOUT_MS = 60_000
export const PRF_SALT_BYTES = 32

/** The user dismissed or failed the platform authenticator prompt. */
export class BiometricCeremonyCancelledError extends Error {
  constructor(message = 'biometric prompt was cancelled') {
    super(message)
    this.name = 'BiometricCeremonyCancelledError'
  }
}

/** The authenticator or browser cannot evaluate the PRF extension. */
export class BiometricPrfUnsupportedError extends Error {
  constructor(message = 'authenticator does not support the WebAuthn PRF extension') {
    super(message)
    this.name = 'BiometricPrfUnsupportedError'
  }
}

/**
 * The passkey was created (overwriting any prior credential with the same
 * user handle) but the follow-up assertion that captures the PRF secret
 * failed or was dismissed, so no record could be wrapped. Callers must treat
 * any previously stored record as invalid — it may reference the overwritten
 * credential.
 */
export class BiometricEnrollmentIncompleteError extends Error {
  constructor(
    readonly cancelled: boolean,
    message = 'passkey was created but the PRF capture did not complete'
  ) {
    super(message)
    this.name = 'BiometricEnrollmentIncompleteError'
  }
}

function rethrowCeremonyError(error: unknown): never {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    throw new BiometricCeremonyCancelledError()
  }
  throw error
}

let cachedSupport: Promise<boolean> | undefined

/**
 * Whether biometric unlock can be offered at all on this browser/device.
 *
 * Deliberately probed via isUserVerifyingPlatformAuthenticatorAvailable(),
 * NOT PublicKeyCredential.getClientCapabilities(): calling the latter on a
 * chrome-extension:// page was observed (Chromium 149) to make every later
 * credentials.create()/get() on that page fail with a spurious "page does
 * not have focus" NotAllowedError. The uvpaa probe has no such side effect.
 *
 * PRF is hard-required regardless of what any probe says: enrollment fails
 * closed unless the authenticator proves PRF support during the ceremony
 * itself (prf.enabled === true), and no userHandle-derived fallback exists.
 */
export function isBiometricUnlockSupported(): Promise<boolean> {
  if (!cachedSupport) {
    cachedSupport = probeSupport().catch(() => false)
  }
  return cachedSupport
}

async function probeSupport(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    return false
  }
  if (!window.isSecureContext) {
    return false
  }
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
}

export interface BiometricEnrollment {
  /** base64url credential id */
  credentialId: string
  /** base64url PRF evaluation input */
  prfSalt: string
  /** 32-byte PRF output for this credential+salt */
  prfOutput: Uint8Array
}

/**
 * Create a platform passkey with PRF and return the PRF secret for it.
 * Chrome evaluates PRF during create() when the authenticator allows it;
 * otherwise an immediate assertion (second biometric prompt) fetches it.
 */
export async function createBiometricCredential(): Promise<BiometricEnrollment> {
  const prfSalt = randomBytes(PRF_SALT_BYTES)

  let credential: PublicKeyCredential | null
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { name: 'Qbit Wallet' },
        user: {
          // Constant user handle: WebAuthn overwrites a resident credential
          // with the same rp + user.id, so re-enrollment replaces the prior
          // passkey instead of accumulating dead "Qbit Wallet" entries in the
          // platform keychain. The handle is never used for key derivation.
          id: new TextEncoder().encode('qbit-wallet-unlock') as BufferSource,
          name: 'Qbit Wallet',
          displayName: 'Qbit Wallet',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } } as any,
        timeout: CEREMONY_TIMEOUT_MS,
      },
    })) as PublicKeyCredential | null
  } catch (error) {
    rethrowCeremonyError(error)
  }
  if (!credential) {
    throw new BiometricCeremonyCancelledError()
  }

  const extensionResults = credential.getClientExtensionResults() as any
  if (extensionResults?.prf?.enabled !== true) {
    // Hard requirement: never fall back to userHandle-derived keys.
    throw new BiometricPrfUnsupportedError()
  }

  const credentialId = credential.id
  const createPrfFirst: ArrayBuffer | undefined = extensionResults?.prf?.results?.first
  let prfOutput: Uint8Array
  if (createPrfFirst) {
    prfOutput = new Uint8Array(createPrfFirst)
  } else {
    try {
      prfOutput = await assertPrfOutput(credentialId, bytesToBase64Url(prfSalt))
    } catch (error) {
      // The credential already exists (and replaced any prior one); a failure
      // here must be distinguishable so callers can invalidate a stored
      // record that now points at the overwritten credential.
      throw new BiometricEnrollmentIncompleteError(
        error instanceof BiometricCeremonyCancelledError
      )
    }
  }

  return {
    credentialId,
    prfSalt: bytesToBase64Url(prfSalt),
    prfOutput,
  }
}

/**
 * Run a TouchID-gated assertion against the enrolled credential and return
 * the PRF output for the stored salt.
 */
export async function assertPrfOutput(
  credentialId: string,
  prfSalt: string
): Promise<Uint8Array> {
  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        allowCredentials: [
          {
            type: 'public-key',
            id: base64UrlToBytes(credentialId) as BufferSource,
            transports: ['internal'] as AuthenticatorTransport[],
          },
        ],
        userVerification: 'required',
        extensions: { prf: { eval: { first: base64UrlToBytes(prfSalt) as BufferSource } } } as any,
        timeout: CEREMONY_TIMEOUT_MS,
      },
    })) as PublicKeyCredential | null
  } catch (error) {
    rethrowCeremonyError(error)
  }
  if (!assertion) {
    throw new BiometricCeremonyCancelledError()
  }

  const prfFirst: ArrayBuffer | undefined = (assertion.getClientExtensionResults() as any)?.prf
    ?.results?.first
  if (!prfFirst) {
    throw new BiometricPrfUnsupportedError()
  }
  return new Uint8Array(prfFirst)
}
