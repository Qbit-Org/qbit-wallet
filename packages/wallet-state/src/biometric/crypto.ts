/**
 * Pure WebCrypto helpers for biometric unlock: the 32-byte PRF output of a
 * platform-passkey assertion is stretched with HKDF-SHA256 into an
 * AES-256-GCM key that wraps the wallet password.
 */

const HKDF_INFO = 'qbit-biometric-unlock-v1'
const AES_GCM_IV_BYTES = 12

// Implemented without btoa/atob so behavior is identical in every runtime:
// jsdom (the test environment) rejects bytes >= 0x80 in btoa, and this codec
// must round-trip raw AES-GCM ciphertext bytes everywhere.
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE64URL_LOOKUP = (() => {
  const lookup = new Int16Array(128).fill(-1)
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    lookup[BASE64URL_ALPHABET.charCodeAt(i)] = i
  }
  // Accept standard base64 variants of the two url-safe characters.
  lookup['+'.charCodeAt(0)] = 62
  lookup['/'.charCodeAt(0)] = 63
  return lookup
})()

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let output = ''
  for (let i = 0; i < view.length; i += 3) {
    const byte1 = view[i]!
    const byte2 = view[i + 1]
    const byte3 = view[i + 2]
    output += BASE64URL_ALPHABET[byte1 >> 2]!
    output += BASE64URL_ALPHABET[((byte1 & 0x03) << 4) | ((byte2 ?? 0) >> 4)]!
    if (byte2 === undefined) break
    output += BASE64URL_ALPHABET[((byte2 & 0x0f) << 2) | ((byte3 ?? 0) >> 6)]!
    if (byte3 === undefined) break
    output += BASE64URL_ALPHABET[byte3 & 0x3f]!
  }
  return output
}

export function base64UrlToBytes(value: string): Uint8Array {
  const unpadded = value.replace(/=+$/, '')
  const symbols: number[] = []
  for (let i = 0; i < unpadded.length; i++) {
    const code = unpadded.charCodeAt(i)
    const symbol = code < 128 ? BASE64URL_LOOKUP[code]! : -1
    if (symbol === -1) {
      throw new Error('invalid base64url input')
    }
    symbols.push(symbol)
  }
  if (symbols.length % 4 === 1) {
    throw new Error('invalid base64url input length')
  }
  const bytes = new Uint8Array(Math.floor((symbols.length * 3) / 4))
  let byteIndex = 0
  for (let i = 0; i + 1 < symbols.length; i += 4) {
    bytes[byteIndex++] = (symbols[i]! << 2) | (symbols[i + 1]! >> 4)
    if (i + 2 < symbols.length) {
      bytes[byteIndex++] = ((symbols[i + 1]! & 0x0f) << 4) | (symbols[i + 2]! >> 2)
    }
    if (i + 3 < symbols.length) {
      bytes[byteIndex++] = ((symbols[i + 2]! & 0x03) << 6) | symbols[i + 3]!
    }
  }
  return bytes
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * HKDF-SHA256(ikm = PRF output, salt = raw credential id) → AES-256-GCM key.
 * Binding the credential id into the derivation ties the wrapping key to the
 * specific enrolled passkey, matching the MetaMask construction.
 */
async function deriveWrappingKey(
  prfOutput: Uint8Array,
  credentialIdBytes: Uint8Array
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: credentialIdBytes as BufferSource,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export interface WrappedSecret {
  /** base64url AES-256-GCM ciphertext */
  wrapped: string
  /** base64url 12-byte IV */
  iv: string
}

export async function wrapSecret(
  secret: string,
  prfOutput: Uint8Array,
  credentialIdBytes: Uint8Array
): Promise<WrappedSecret> {
  const key = await deriveWrappingKey(prfOutput, credentialIdBytes)
  const iv = randomBytes(AES_GCM_IV_BYTES)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(secret)
  )
  return { wrapped: bytesToBase64Url(ciphertext), iv: bytesToBase64Url(iv) }
}

export async function unwrapSecret(
  wrapped: WrappedSecret,
  prfOutput: Uint8Array,
  credentialIdBytes: Uint8Array
): Promise<string> {
  const key = await deriveWrappingKey(prfOutput, credentialIdBytes)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(wrapped.iv) as BufferSource },
    key,
    base64UrlToBytes(wrapped.wrapped) as BufferSource
  )
  return new TextDecoder().decode(plaintext)
}
