import { transactionCore, eccManager } from './transaction-core'

export const toXOnly = (pubKey: Buffer) => (pubKey.length === 32 ? pubKey : pubKey.slice(1, 33))

function tapTweakHash(pubKey: Buffer, h: Buffer | undefined): Buffer {
  return transactionCore.crypto.taggedHash('TapTweak', Buffer.concat((h ? [pubKey, h] : [pubKey]) as any))
}

/**
 * Transform raw private key to taproot address private key
 */
export function tweakSigner(signer: transactionCore.Signer, opts: any = {}): transactionCore.Signer {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let privateKey: Uint8Array | undefined = signer.privateKey!
  if (!privateKey) {
    throw new Error('Private key is required for tweaking signer!')
  }
  if (signer.publicKey[0] === 3) {
    privateKey = eccManager.ecc.privateNegate(privateKey)
  }

  const tweakedPrivateKey = eccManager.ecc.privateAdd(
    privateKey,
    tapTweakHash(toXOnly(signer.publicKey), opts.tweakHash) as any
  )
  if (!tweakedPrivateKey) {
    throw new Error('Invalid tweaked private key!')
  }

  return eccManager.eccPair.fromPrivateKey(Buffer.from(tweakedPrivateKey), {
    network: opts.network,
  })
}

/**
 * ECDSA signature validator
 */
export const validator = (pubkey: Buffer, msghash: Buffer, signature: Buffer): boolean => {
  return eccManager.eccPair.fromPublicKey(pubkey).verify(msghash, signature)
}

/**
 * Schnorr signature validator
 */
export const schnorrValidator = (pubkey: Buffer, msghash: Buffer, signature: Buffer): boolean => {
  return eccManager.eccPair.fromPublicKey(pubkey).verifySchnorr(msghash, signature)
}
