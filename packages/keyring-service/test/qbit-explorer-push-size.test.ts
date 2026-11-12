import { describe, expect, it } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import {
  QBIT_MAX_STANDARD_TX_WEIGHT,
  QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES,
  estimateQbitP2mrTransaction,
  isQbitStandardTxSize,
  qbitP2mrMaxStandardInputCount,
} from '@qbit/wallet-shared'

// The explorer's push check parses the pushed hex with this transaction
// library. Since qbit-explorer#58 (explorer 1.1.0) it refuses a transaction,
// with code -3, when qbit's weight of it is over MAX_PUSH_TX_SIZE_WEIGHT:
// `getTransactionWeight(tx.byteLength(false), tx.byteLength())` with
// WITNESS_SCALE_FACTOR = 1, the serialized size with witness. qbit Core
// sizes the same bytes, and the wallet's estimator must match both (#170).
const { Transaction } = transactionCore
type PushedTransaction = InstanceType<typeof Transaction>

const WITNESS_SCALE_FACTOR = 1
const MAX_PUSH_TX_SIZE_WEIGHT = 400_000

/** qbit-explorer#58's push check, as `validateTransactionHex` applies it. */
function explorerRefuses(transaction: PushedTransaction): boolean {
  const weight =
    transaction.byteLength(false) * (WITNESS_SCALE_FACTOR - 1) + transaction.byteLength()
  return weight > MAX_PUSH_TX_SIZE_WEIGHT
}

const LEAF_SCRIPT = Buffer.from(singleKeyLeafScript(new Uint8Array(32).fill(0x11)))
const CONTROL_BLOCK = Buffer.from(buildControlBlock(P2MR_LEAF_VERSION_V1, []))
const outputScript = (seed: number) => Buffer.from(p2mrScriptPubKey(new Uint8Array(32).fill(seed)))

/** A finalized single-key P2MR spend of `inputCount` inputs to `outputCount` P2MR outputs, as pushed. */
function singleKeySpend(inputCount: number, outputCount: number): PushedTransaction {
  const transaction = new Transaction()
  transaction.version = 2
  for (let index = 0; index < inputCount; index += 1) {
    const prevoutHash = Buffer.alloc(32)
    prevoutHash.writeUInt32BE(index + 1, 0)
    transaction.addInput(prevoutHash, index % 3, 0xfffffffd)
    transaction.setWitness(index, [
      Buffer.alloc(QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES, 0x5a),
      LEAF_SCRIPT,
      CONTROL_BLOCK,
    ])
  }
  for (let index = 0; index < outputCount; index += 1) {
    transaction.addOutput(outputScript(0x21 + index), 10_000 + index)
  }
  // Parsed back from hex, as the explorer reads it.
  return Transaction.fromHex(transaction.toHex())
}

function shape(outputCount: number) {
  return {
    outputScriptLengths: Array.from(
      { length: outputCount },
      (_, index) => outputScript(0x21 + index).length
    ),
    leafScriptLength: LEAF_SCRIPT.length,
    controlBlockLength: CONTROL_BLOCK.length,
  }
}

const estimate = (inputCount: number, outputCount: number) =>
  estimateQbitP2mrTransaction({ ...shape(outputCount), inputCount })

describe("the explorer's push size check of single-key P2MR transactions (#170)", () => {
  it('uses the witness of a single-key spend', () => {
    // A 3,680-byte signature, the 34-byte leaf script and a 1-byte control block.
    expect(QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES).toBe(3_680)
    expect(LEAF_SCRIPT).toHaveLength(34)
    expect(CONTROL_BLOCK).toHaveLength(1)
    expect(outputScript(0x21)).toHaveLength(34)
    expect(MAX_PUSH_TX_SIZE_WEIGHT).toBe(QBIT_MAX_STANDARD_TX_WEIGHT)
  })

  // 253 inputs widen the input count prefix from 1 byte to 3.
  const cases = [1, 106, 107, 253].flatMap(inputCount =>
    [1, 2].map(outputCount => ({ inputCount, outputCount }))
  )

  it.each(cases)(
    '$inputCount inputs, $outputCount outputs: the estimated vsize is byteLength()',
    ({ inputCount, outputCount }) => {
      const pushed = singleKeySpend(inputCount, outputCount)
      expect(pushed.ins).toHaveLength(inputCount)
      expect(pushed.outs).toHaveLength(outputCount)
      expect(pushed.hasWitnesses()).toBe(true)
      expect(pushed.byteLength()).toBe(estimate(inputCount, outputCount).vsize)
    }
  )

  it('accepts 106 inputs and refuses 107, for one output and for two', () => {
    const sizes = [106, 107].map(inputCount =>
      [1, 2].map(outputCount => singleKeySpend(inputCount, outputCount).byteLength())
    )
    expect(sizes).toEqual([
      [398_827, 398_870],
      [402_589, 402_632],
    ])
    for (const outputCount of [1, 2]) {
      expect(explorerRefuses(singleKeySpend(106, outputCount))).toBe(false)
      expect(explorerRefuses(singleKeySpend(107, outputCount))).toBe(true)
      // The same bound as qbit Core's standard size, which the wallet keeps to.
      expect(isQbitStandardTxSize(estimate(106, outputCount).vsize)).toBe(true)
      expect(isQbitStandardTxSize(estimate(107, outputCount).vsize)).toBe(false)
      expect(qbitP2mrMaxStandardInputCount(shape(outputCount))).toBe(106)
    }
  })

  // The check of deployments before explorer 1.1.0: `weight()`, base bytes ×4
  // plus witness bytes, against the same 400,000. Measured on mainnet and
  // testnet4 before the update, 102 inputs reached the node and 103 were
  // refused with -3.
  it('refused from 103 inputs before explorer 1.1.0, which weighed base bytes four times', () => {
    const weights = [102, 103, 106].map(inputCount =>
      [1, 2].map(outputCount => singleKeySpend(inputCount, outputCount).weight())
    )
    expect(weights).toEqual([
      [396_484, 396_656],
      [400_369, 400_541],
      [412_024, 412_196],
    ])
  })
})
