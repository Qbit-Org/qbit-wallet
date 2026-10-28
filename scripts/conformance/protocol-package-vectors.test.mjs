import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The qbit Core-derived P2MR sighash and PSBT fixtures (vendored from the
// commit @qbit-oss/protocol was published from, see ./qbit-js/README.md),
// run against the installed @qbit-oss/protocol the wallet signs with.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromKeyring = createRequire(join(repoRoot, 'packages/keyring-service/package.json'))
const packageRoot = dirname(requireFromKeyring.resolve('@qbit-oss/protocol/package.json'))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const sighashFixture = readJson(
  join(repoRoot, 'scripts/conformance/qbit-js/fixtures/p2mr-sighash.json')
)
const psbtFixture = readJson(join(repoRoot, 'scripts/conformance/qbit-js/fixtures/p2mr-psbt.json'))

let protocol
before(async () => {
  protocol = await import(pathToFileURL(join(packageRoot, 'lib/index.mjs')).href)
})

function toTransaction(tx) {
  return {
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs.map(input => ({
      prevout: { txid: protocol.hexToBytes(input.txid), vout: input.vout },
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map(output => ({
      value: BigInt(output.valueSats),
      scriptPubKey: protocol.hexToBytes(output.scriptPubKey),
    })),
  }
}

function toSpentOutputs(tx) {
  return tx.spentOutputs.map(output => ({
    value: BigInt(output.valueSats),
    scriptPubKey: protocol.hexToBytes(output.scriptPubKey),
  }))
}

test('the shared sighash machinery reproduces qbit Core key-path vectors', () => {
  const keyPath = sighashFixture.bip341KeyPath
  const tx = toTransaction(keyPath)
  const spentOutputs = toSpentOutputs(keyPath)
  const midstates = protocol.precomputeSighashMidstates(tx, spentOutputs)
  for (const field of ['prevouts', 'amounts', 'scriptPubKeys', 'sequences', 'outputs']) {
    assert.equal(protocol.bytesToHex(midstates[field]), keyPath.midstates[field], field)
  }
  assert.ok(keyPath.cases.length > 0)
  for (const testCase of keyPath.cases) {
    const digest = protocol.schnorrSignatureHash({
      tx,
      inputIndex: testCase.inputIndex,
      spentOutputs,
      hashType: testCase.hashType,
      sigVersion: 'taproot',
    })
    assert.equal(protocol.bytesToHex(digest), testCase.sigHash, `input ${testCase.inputIndex}`)
  }
})

test('p2mrSighash reproduces every P2MR vector across all hash types', () => {
  const vectors = sighashFixture.p2mr
  assert.ok(vectors.length >= 13)
  assert.equal(new Set(vectors.map(vector => vector.hashType)).size, 7)
  for (const vector of vectors) {
    const leafScript = protocol.singleKeyLeafScript(protocol.hexToBytes(vector.leaf.pubkey))
    assert.equal(protocol.bytesToHex(leafScript), vector.leaf.leafScript, vector.label)
    const leafHash = protocol.p2mrLeafHash(vector.leaf.leafVersion, leafScript)
    assert.equal(protocol.bytesToHex(leafHash), vector.leaf.leafHash, vector.label)
    const digest = protocol.p2mrSighash({
      tx: toTransaction(vector.tx),
      inputIndex: vector.inputIndex,
      spentOutputs: toSpentOutputs(vector.tx),
      leafHash,
      hashType: vector.hashType,
    })
    assert.equal(protocol.bytesToHex(digest), vector.sigHash, `${vector.label} ${vector.hashType}`)
  }
})

test('the qbit Core PSBT round-trips byte for byte and decodes to its summary', () => {
  const bytes = protocol.hexToBytes(psbtFixture.psbtHex)
  const psbt = protocol.parsePsbt(bytes)
  assert.equal(protocol.bytesToHex(protocol.serializePsbt(psbt)), psbtFixture.psbtHex)

  const { expected } = psbtFixture
  const summary = protocol.decodePsbt(psbt)
  assert.equal(summary.version, expected.version)
  assert.equal(summary.locktime, expected.locktime)
  assert.equal(summary.inputs.length, expected.inputCount)
  assert.equal(summary.outputs.length, expected.outputCount)
  assert.equal(summary.fee, BigInt(expected.fee))
  const [input0, input1] = summary.inputs
  assert.equal(input0.witnessUtxo.value, BigInt(expected.inputs[0].witnessValue))
  assert.equal(input0.leafScripts.length, expected.inputs[0].leafScripts)
  assert.equal(input0.scriptSigs.length, expected.inputs[0].scriptSigs)
  assert.equal(protocol.bytesToHex(input0.merkleRoot), expected.inputs[0].merkleRoot)
  assert.equal(protocol.bytesToHex(input0.scriptSigs[0].pubkey), expected.inputs[0].scriptSigPubkey)
  assert.equal(
    protocol.bytesToHex(input0.scriptSigs[0].leafHash),
    expected.inputs[0].scriptSigLeafHash
  )
  assert.equal(input0.finalized, expected.inputs[0].finalized)
  assert.equal(input1.witnessUtxo.value, BigInt(expected.inputs[1].witnessValue))
  assert.equal(input1.finalized, expected.inputs[1].finalized)
})
