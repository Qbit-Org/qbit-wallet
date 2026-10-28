import * as hmac from '@noble/hashes/hmac'
import * as sha256 from '@noble/hashes/sha256'
import * as noble_secp256k1 from '@noble/secp256k1'
import { ECPairInterface, transactionCore } from '../transaction-core'
noble_secp256k1.utils.hmacSha256Sync = (key, ...msgs) =>
  hmac.hmac(sha256.sha256, key, noble_secp256k1.utils.concatBytes(...msgs))
const MAGIC_BYTES = Buffer.from('Bitcoin Signed Message:\n')

function varintBufNum(n: number) {
  let buf
  if (n < 253) {
    buf = Buffer.alloc(1)
    buf.writeUInt8(n, 0)
  } else if (n < 0x10000) {
    buf = Buffer.alloc(1 + 2)
    buf.writeUInt8(253, 0)
    buf.writeUInt16LE(n, 1)
  } else if (n < 0x100000000) {
    buf = Buffer.alloc(1 + 4)
    buf.writeUInt8(254, 0)
    buf.writeUInt32LE(n, 1)
  } else {
    buf = Buffer.alloc(1 + 8)
    buf.writeUInt8(255, 0)
    buf.writeInt32LE(n & -1, 1)
    buf.writeUInt32LE(Math.floor(n / 0x100000000), 5)
  }
  return buf as any
}

function magicHash(message: string) {
  const prefix1 = varintBufNum(MAGIC_BYTES.length)
  const messageBuffer = Buffer.from(message)
  const prefix2 = varintBufNum(messageBuffer.length)
  const buf = Buffer.concat([prefix1, MAGIC_BYTES, prefix2, messageBuffer])
  return transactionCore.crypto.hash256(buf)
}

function toCompact(i: number, signature: Uint8Array, compressed: boolean) {
  if (!(i === 0 || i === 1 || i === 2 || i === 3)) {
    throw new Error('i must be equal to 0, 1, 2, or 3')
  }

  let val = i + 27 + 4
  if (!compressed) {
    val = val - 4
  }
  const result = noble_secp256k1.utils.concatBytes(new Uint8Array([val]), signature)
  return Buffer.from(result)
}

export function signMessageOfDeterministicECDSA(ecpair: ECPairInterface, message: string): string {
  if (!ecpair.privateKey) {
    throw new Error('Private key is required for signing');
  }
  
  const hash = magicHash(message)
  const [signature, i] = noble_secp256k1.signSync(
    Uint8Array.from(hash),
    ecpair.privateKey.toString('hex'),
    {
      canonical: true,
      recovered: true,
      der: false,
    }
  )
  return toCompact(i, signature, true).toString('base64')
}
