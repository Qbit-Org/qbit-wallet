import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { BIOMETRIC_UNLOCK_RECORD_VERSION } from '@qbit/wallet-shared'
import { base64UrlToBytes, bytesToBase64Url } from '../../src/biometric/crypto'
import {
  BiometricUnwrapFailedError,
  enrollBiometricUnlock,
  unwrapBiometricPassword,
} from '../../src/biometric'
import {
  BiometricCeremonyCancelledError,
  BiometricEnrollmentIncompleteError,
  BiometricPrfUnsupportedError,
} from '../../src/biometric/webauthn'

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import('node:crypto')
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

const credentialIdBytes = new Uint8Array(16).fill(3)
const credentialId = bytesToBase64Url(credentialIdBytes)

// Deterministic stand-in for the authenticator PRF: output depends only on
// the salt, matching the real hmac-secret behavior for a fixed credential.
async function fakePrf(saltBuffer: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const salt = saltBuffer instanceof Uint8Array ? saltBuffer : new Uint8Array(saltBuffer)
  const keyMaterial = new Uint8Array(32).fill(42)
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return crypto.subtle.sign('HMAC', key, salt as BufferSource)
}

interface MockAuthenticatorOptions {
  prfOnCreate?: boolean
  prfEnabled?: boolean
}

function installMockAuthenticator({
  prfOnCreate = true,
  prfEnabled = true,
}: MockAuthenticatorOptions = {}) {
  const create = vi.fn(async (options: any) => {
    const salt = options.publicKey.extensions?.prf?.eval?.first
    const prfResults =
      prfEnabled && prfOnCreate && salt ? { first: await fakePrf(salt) } : undefined
    return {
      id: credentialId,
      rawId: credentialIdBytes.buffer,
      getClientExtensionResults: () => ({
        prf: { enabled: prfEnabled, ...(prfResults ? { results: prfResults } : {}) },
      }),
    }
  })
  const get = vi.fn(async (options: any) => {
    const salt = options.publicKey.extensions?.prf?.eval?.first
    const results = prfEnabled && salt ? { first: await fakePrf(salt) } : undefined
    return {
      id: credentialId,
      rawId: credentialIdBytes.buffer,
      response: { userHandle: null },
      getClientExtensionResults: () => ({
        prf: results ? { enabled: true, results } : { enabled: prfEnabled },
      }),
    }
  })
  Object.defineProperty(globalThis, 'navigator', {
    value: { credentials: { create, get } },
    configurable: true,
  })
  return { create, get }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('enrollBiometricUnlock', () => {
  it('creates a record that unwraps back to the password (PRF on create)', async () => {
    const mocks = installMockAuthenticator({ prfOnCreate: true })
    const record = await enrollBiometricUnlock('hunter2-hunter2')

    expect(record.version).toBe(BIOMETRIC_UNLOCK_RECORD_VERSION)
    expect(record.credentialId).toBe(credentialId)
    expect(mocks.get).not.toHaveBeenCalled()

    const password = await unwrapBiometricPassword(record)
    expect(password).toBe('hunter2-hunter2')
  })

  it('falls back to an immediate assertion when create returns no PRF output', async () => {
    const mocks = installMockAuthenticator({ prfOnCreate: false })
    const record = await enrollBiometricUnlock('hunter2-hunter2')
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(await unwrapBiometricPassword(record)).toBe('hunter2-hunter2')
  })

  it('maps a dismissed second (PRF-capture) prompt to BiometricEnrollmentIncompleteError', async () => {
    installMockAuthenticator({ prfOnCreate: false })
    ;(navigator.credentials.get as any).mockRejectedValueOnce(
      new DOMException('user cancelled', 'NotAllowedError')
    )
    const error = await enrollBiometricUnlock('hunter2-hunter2').catch(e => e)
    expect(error).toBeInstanceOf(BiometricEnrollmentIncompleteError)
    expect(error.cancelled).toBe(true)
  })

  it('fails closed when the authenticator does not prove PRF support', async () => {
    installMockAuthenticator({ prfEnabled: false })
    await expect(enrollBiometricUnlock('hunter2-hunter2')).rejects.toBeInstanceOf(
      BiometricPrfUnsupportedError
    )
  })

  it('surfaces a decrypt failure as BiometricUnwrapFailedError, distinct from ceremony errors', async () => {
    installMockAuthenticator()
    const record = await enrollBiometricUnlock('hunter2-hunter2')
    const bytes = base64UrlToBytes(record.wrappedPassword)
    bytes[0]! ^= 0xff
    const tampered = { ...record, wrappedPassword: bytesToBase64Url(bytes) }
    await expect(unwrapBiometricPassword(tampered)).rejects.toBeInstanceOf(
      BiometricUnwrapFailedError
    )
  })

  it('maps a dismissed prompt to BiometricCeremonyCancelledError', async () => {
    installMockAuthenticator()
    ;(navigator.credentials.create as any).mockRejectedValueOnce(
      new DOMException('user cancelled', 'NotAllowedError')
    )
    await expect(enrollBiometricUnlock('hunter2-hunter2')).rejects.toBeInstanceOf(
      BiometricCeremonyCancelledError
    )
  })
})
