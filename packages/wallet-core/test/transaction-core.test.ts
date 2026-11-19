import { describe, expect, it } from 'vitest'
import * as tinysecp256k1 from 'tiny-secp256k1'
import { eccManager } from '../src/transaction-core'

// The secp256k1 generator point, the public key of private key 1.
const generator = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('eccManager', () => {
  it('uses tiny-secp256k1', () => {
    expect(eccManager.ecc.isPoint).toBe(tinysecp256k1.isPoint)
  })

  it('makes key pairs that sign and verify', () => {
    const privateKey = Buffer.alloc(32)
    privateKey[31] = 1
    const pair = eccManager.eccPair.fromPrivateKey(privateKey)
    const hash = Buffer.alloc(32, 7)

    expect(pair.publicKey.toString('hex')).toBe(generator)
    expect(pair.verifySchnorr(hash, pair.signSchnorr(hash))).toBe(true)
  })
})
