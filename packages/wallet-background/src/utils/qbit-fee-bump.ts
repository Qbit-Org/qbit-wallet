import { verify as verifyPqc } from '@qbit-oss/pqc'
import {
  OP_2,
  P2MR_LEAF_VERSION_V1,
  P2MR_PROGRAM_BYTES,
  SIGHASH_DEFAULT,
  buildControlBlock,
  bytesToHex,
  decodeP2mrWitnessSignature,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  precomputeSighashMidstates,
  singleKeyLeafScript,
  type P2mrSpentOutput,
  type P2mrTransaction,
  type P2mrTransactionOutput,
} from '@qbit-oss/protocol'
import type { transactionCore } from '@qbit/wallet-core'

const OP_RETURN = 0x6a

/** A raw qbit transaction in the form the P2MR sighash commits to, plus its witnesses. */
export interface QbitRawP2mrTransaction {
  tx: P2mrTransaction
  /** Display-order (explorer) txid of each input's prevout, aligned with `tx.inputs`. */
  inputTxids: string[]
  witnesses: Uint8Array[][]
  /** Serialized size in bytes, witnesses included. */
  size: number
}

/**
 * Converts a parsed raw transaction, or returns undefined when an input
 * carries a scriptSig, which no P2MR spend has.
 */
export function qbitRawP2mrTransaction(
  transaction: transactionCore.Transaction
): QbitRawP2mrTransaction | undefined {
  if (transaction.ins.some(input => input.script.length > 0)) return undefined
  return {
    tx: {
      // Parsed as a signed int32; the sighash serializes the same four bytes unsigned.
      version: transaction.version >>> 0,
      locktime: transaction.locktime,
      inputs: transaction.ins.map(input => ({
        prevout: { txid: Uint8Array.from(input.hash), vout: input.index },
        sequence: input.sequence,
      })),
      outputs: transaction.outs.map(output => ({
        value: BigInt(output.value),
        scriptPubKey: Uint8Array.from(output.script),
      })),
    },
    inputTxids: transaction.ins.map(input => bytesToHex(Uint8Array.from(input.hash).reverse())),
    witnesses: transaction.ins.map(input => input.witness.map(item => Uint8Array.from(item))),
    size: transaction.byteLength(),
  }
}

/** Outputs a fee bump may carry over into its replacement: P2MR, or an OP_RETURN paying nothing. */
export function isQbitFeeBumpCopyableOutput(output: P2mrTransactionOutput): boolean {
  const script = output.scriptPubKey
  if (script[0] === OP_RETURN) return output.value === 0n
  return (
    script.length === 2 + P2MR_PROGRAM_BYTES &&
    script[0] === OP_2 &&
    script[1] === P2MR_PROGRAM_BYTES
  )
}

/**
 * True only when every input is a single-key P2MR spend of `pubkey` whose
 * SIGHASH_DEFAULT witness signature, the type the wallet signs with, verifies
 * over this exact transaction. SIGHASH_DEFAULT commits to every outpoint,
 * prevout amount and script, sequence and output, so a pass proves the key
 * holder signed these outputs while spending these amounts. `spentOutputs`
 * may therefore come from an untrusted source: a wrong amount or script fails
 * verification.
 */
export function qbitP2mrTransactionSignedBy(params: {
  transaction: QbitRawP2mrTransaction
  spentOutputs: readonly P2mrSpentOutput[]
  pubkey: Uint8Array
}): boolean {
  const { transaction, spentOutputs, pubkey } = params
  const { tx, witnesses } = transaction
  if (
    tx.inputs.length === 0 ||
    spentOutputs.length !== tx.inputs.length ||
    witnesses.length !== tx.inputs.length ||
    pubkey.length !== P2MR_PROGRAM_BYTES
  ) {
    return false
  }

  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
  if (!spentOutputs.every(output => bytesEqual(output.scriptPubKey, scriptPubKey))) {
    return false
  }

  // One set of midstates for every input keeps the hashing linear in the input count.
  const midstates = precomputeSighashMidstates(tx, spentOutputs)
  return witnesses.every((witness, inputIndex) => {
    // [signature, leaf script, control block]; an annex or any other shape is refused.
    const [signatureItem, witnessLeafScript, witnessControlBlock] = witness
    if (
      witness.length !== 3 ||
      !signatureItem ||
      !witnessLeafScript ||
      !witnessControlBlock ||
      !bytesEqual(witnessLeafScript, leafScript) ||
      !bytesEqual(witnessControlBlock, controlBlock)
    ) {
      return false
    }
    try {
      const { signature, hashType } = decodeP2mrWitnessSignature(signatureItem)
      if (hashType !== SIGHASH_DEFAULT) return false
      const sighash = p2mrSighash({ tx, inputIndex, spentOutputs, leafHash, hashType, midstates })
      return verifyPqc(pubkey, sighash, signature) === true
    } catch {
      return false
    }
  })
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
