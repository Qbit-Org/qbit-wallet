import { beforeAll, describe, expect, it } from 'vitest'

import {
  base64UrlToBytes,
  bytesToBase64Url,
  randomBytes,
  unwrapSecret,
  wrapSecret,
} from '../../src/biometric/crypto'

beforeAll(async () => {
  // jsdom does not ship WebCrypto's subtle API; use Node's implementation.
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import('node:crypto')
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes without padding characters', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63])
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes))
  })

  it('round-trips every single-byte value', () => {
    for (let value = 0; value < 256; value++) {
      const bytes = new Uint8Array([value])
      expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes)))).toEqual([value])
    }
  })
})

describe('password wrapping', () => {
  const credentialId = new Uint8Array(16).fill(7)

  it('wraps and unwraps the password', async () => {
    const prfOutput = randomBytes(32)
    const wrapped = await wrapSecret('correct horse battery staple', prfOutput, credentialId)
    const unwrapped = await unwrapSecret(wrapped, prfOutput, credentialId)
    expect(unwrapped).toBe('correct horse battery staple')
  })

  it('produces a fresh IV per wrap', async () => {
    const prfOutput = randomBytes(32)
    const first = await wrapSecret('secret', prfOutput, credentialId)
    const second = await wrapSecret('secret', prfOutput, credentialId)
    expect(first.iv).not.toBe(second.iv)
    expect(first.wrapped).not.toBe(second.wrapped)
  })

  it('rejects the wrong PRF output', async () => {
    const wrapped = await wrapSecret('secret', randomBytes(32), credentialId)
    await expect(unwrapSecret(wrapped, randomBytes(32), credentialId)).rejects.toThrow()
  })

  it('binds the key to the credential id', async () => {
    const prfOutput = randomBytes(32)
    const wrapped = await wrapSecret('secret', prfOutput, credentialId)
    const otherCredential = new Uint8Array(16).fill(8)
    await expect(unwrapSecret(wrapped, prfOutput, otherCredential)).rejects.toThrow()
  })

  it('rejects tampered ciphertext', async () => {
    const prfOutput = randomBytes(32)
    const wrapped = await wrapSecret('secret', prfOutput, credentialId)
    const bytes = base64UrlToBytes(wrapped.wrapped)
    bytes[0]! ^= 0xff
    const tampered = { ...wrapped, wrapped: bytesToBase64Url(bytes) }
    await expect(unwrapSecret(tampered, prfOutput, credentialId)).rejects.toThrow()
  })
})
