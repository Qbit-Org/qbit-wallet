import { beforeAll, describe, expect, it } from 'vitest'

import { init, keygen, sign } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_NONE,
  buildControlBlock,
  createP2mrPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
  type P2mrSpentOutput,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import {
  isQbitFeeBumpCopyableOutput,
  qbitP2mrTransactionSignedBy,
  qbitRawP2mrTransaction,
} from '../src/utils/qbit-fee-bump'

function accountKey(fill: number) {
  const { publicKey, secretKey } = keygen(new Uint8Array(128).fill(fill))
  const leafScript = singleKeyLeafScript(publicKey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  return { publicKey, secretKey, leafScript, leafHash, scriptPubKey: p2mrScriptPubKey(leafHash) }
}

/** A raw transaction spending `inputCount` outputs of `key`, signed with the real PQC scheme. */
function signedTransaction(
  key: ReturnType<typeof accountKey>,
  inputCount: number,
  hashType?: number
) {
  const spentOutputs: P2mrSpentOutput[] = Array.from({ length: inputCount }, () => ({
    value: 50_000n,
    scriptPubKey: key.scriptPubKey,
  }))
  const psbt = createP2mrPsbt({
    inputs: spentOutputs.map((witnessUtxo, index) => ({
      prevout: { txid: new Uint8Array(32).fill(index + 1), vout: index },
      witnessUtxo,
      leafScript: key.leafScript,
      controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
      merkleRoot: key.leafHash,
    })),
    outputs: [
      { value: 10_000n, scriptPubKey: p2mrScriptPubKey(new Uint8Array(32).fill(0x22)) },
      { value: 0n, scriptPubKey: Uint8Array.of(0x6a, 0x02, 0x68, 0x69) },
      { value: BigInt(inputCount) * 50_000n - 20_000n, scriptPubKey: key.scriptPubKey },
    ],
  })
  const signed = signP2mrPsbt({
    psbt,
    keys: spentOutputs.map((_, inputIndex) => ({
      inputIndex,
      pubkey: key.publicKey,
      leafHash: key.leafHash,
      ...(hashType === undefined ? {} : { hashType }),
    })),
    sign: sighash => sign(key.secretKey, sighash),
    // Only to build the originals these tests refuse.
    allowNonDefaultSighash: hashType !== undefined,
  })
  const raw = transactionCore.Transaction.fromHex(
    Buffer.from(extractP2mrTransaction(finalizeP2mrPsbt(signed.psbt))).toString('hex')
  )
  return { raw, spentOutputs }
}

describe('qbit fee-bump original verification', () => {
  let account: ReturnType<typeof accountKey>
  let other: ReturnType<typeof accountKey>
  let honest: ReturnType<typeof signedTransaction>

  beforeAll(async () => {
    await init()
    account = accountKey(7)
    other = accountKey(8)
    honest = signedTransaction(account, 2)
  }, 30_000)

  it('accepts a transaction every input of which the account signed with the real PQC scheme', () => {
    const transaction = qbitRawP2mrTransaction(honest.raw)!
    expect(transaction.size).toBe(honest.raw.byteLength())
    expect(transaction.inputTxids).toEqual(['01'.repeat(32), '02'.repeat(32)])
    expect(
      qbitP2mrTransactionSignedBy({
        transaction,
        spentOutputs: honest.spentOutputs,
        pubkey: account.publicKey,
      })
    ).toBe(true)
  })

  it('rejects a changed output, a misreported prevout and another key', () => {
    const redirected = honest.raw.clone()
    redirected.outs[0]!.script = Buffer.from(p2mrScriptPubKey(new Uint8Array(32).fill(0xee)))
    const shifted = honest.raw.clone()
    shifted.outs[0]!.value += 1
    shifted.outs[2]!.value -= 1
    for (const raw of [redirected, shifted]) {
      expect(
        qbitP2mrTransactionSignedBy({
          transaction: qbitRawP2mrTransaction(raw)!,
          spentOutputs: honest.spentOutputs,
          pubkey: account.publicKey,
        })
      ).toBe(false)
    }

    const transaction = qbitRawP2mrTransaction(honest.raw)!
    expect(
      qbitP2mrTransactionSignedBy({
        transaction,
        spentOutputs: honest.spentOutputs.map((output, index) =>
          index === 1 ? { ...output, value: output.value + 1n } : output
        ),
        pubkey: account.publicKey,
      })
    ).toBe(false)
    expect(
      qbitP2mrTransactionSignedBy({
        transaction,
        spentOutputs: honest.spentOutputs.map(output => ({
          ...output,
          scriptPubKey: other.scriptPubKey,
        })),
        pubkey: other.publicKey,
      })
    ).toBe(false)
  })

  it('rejects a missing witness, an annex and a different control block', () => {
    const transaction = qbitRawP2mrTransaction(honest.raw)!
    const [signature, leafScript, controlBlock] = transaction.witnesses[0]!
    for (const witness of [
      [],
      [signature!, leafScript!, controlBlock!, Uint8Array.of(0x50)],
      [signature!, leafScript!, Uint8Array.of(...controlBlock!, ...new Uint8Array(32))],
    ]) {
      expect(
        qbitP2mrTransactionSignedBy({
          transaction: { ...transaction, witnesses: [witness, transaction.witnesses[1]!] },
          spentOutputs: honest.spentOutputs,
          pubkey: account.publicKey,
        })
      ).toBe(false)
    }
  })

  it('rejects explicit sighash types, including ones that leave outputs or inputs open', () => {
    const verified = (hashType: number) => {
      const { raw, spentOutputs } = signedTransaction(account, 1, hashType)
      return qbitP2mrTransactionSignedBy({
        transaction: qbitRawP2mrTransaction(raw)!,
        spentOutputs,
        pubkey: account.publicKey,
      })
    }
    expect(verified(SIGHASH_ALL)).toBe(false)
    expect(verified(SIGHASH_NONE)).toBe(false)
    expect(verified(SIGHASH_ANYONECANPAY | SIGHASH_ALL)).toBe(false)
  }, 30_000)

  it('refuses inputs that carry a scriptSig', () => {
    const withScriptSig = honest.raw.clone()
    withScriptSig.ins[0]!.script = Buffer.from([0x51])
    expect(qbitRawP2mrTransaction(withScriptSig)).toBeUndefined()
  })

  it('copies only P2MR outputs and OP_RETURN outputs that pay nothing', () => {
    const p2mr = p2mrScriptPubKey(new Uint8Array(32).fill(0x22))
    expect(isQbitFeeBumpCopyableOutput({ value: 1_000n, scriptPubKey: p2mr })).toBe(true)
    expect(
      isQbitFeeBumpCopyableOutput({ value: 0n, scriptPubKey: Uint8Array.of(0x6a, 0x01, 0x00) })
    ).toBe(true)
    for (const output of [
      { value: 1n, scriptPubKey: Uint8Array.of(0x6a, 0x01, 0x00) },
      { value: 1_000n, scriptPubKey: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)) },
      { value: 1_000n, scriptPubKey: Uint8Array.of(0x51, 0x20, ...new Uint8Array(32)) },
      { value: 1_000n, scriptPubKey: p2mr.slice(0, 33) },
      { value: 1_000n, scriptPubKey: Uint8Array.of(...p2mr, 0x00) },
      { value: 0n, scriptPubKey: new Uint8Array() },
    ]) {
      expect(isQbitFeeBumpCopyableOutput(output)).toBe(false)
    }
  })
})
