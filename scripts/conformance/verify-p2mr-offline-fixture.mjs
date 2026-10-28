#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertFixtureDigest,
  sha256Hex,
  validateReleaseEvidence,
} from './p2mr-offline-fixture-lib.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '../..')
const defaultFixture = resolve(root, 'scripts/conformance/fixtures/p2mr-offline.json')
// The @qbit-oss/protocol keyring-service signs with.
const defaultProtocol = resolve(
  dirname(
    createRequire(resolve(root, 'packages/keyring-service/package.json')).resolve(
      '@qbit-oss/protocol/package.json'
    )
  ),
  'lib/index.mjs'
)
const coverageMapRelative = 'scripts/conformance/p2mr-v1-coverage.json'
const corePinPath = resolve(root, 'scripts/conformance/core-pin.json')

function parseOptions(args) {
  const known = new Set(['--fixture', '--protocol'])
  const options = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--') continue
    if (!known.has(name)) throw new Error(`unknown option ${name}`)
    if (options.has(name)) throw new Error(`${name} may only be provided once`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    options.set(name, value)
    index += 1
  }
  return options
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

function compactSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid CompactSize value')
  if (value < 0xfd) return Buffer.from([value])
  if (value <= 0xffff) {
    const bytes = Buffer.alloc(3)
    bytes[0] = 0xfd
    bytes.writeUInt16LE(value, 1)
    return bytes
  }
  if (value <= 0xffffffff) {
    const bytes = Buffer.alloc(5)
    bytes[0] = 0xfe
    bytes.writeUInt32LE(value, 1)
    return bytes
  }
  const bytes = Buffer.alloc(9)
  bytes[0] = 0xff
  bytes.writeBigUInt64LE(BigInt(value), 1)
  return bytes
}

function taggedHash(tag, payload) {
  const tagHash = createHash('sha256').update(tag).digest()
  return createHash('sha256').update(tagHash).update(tagHash).update(payload).digest('hex')
}

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

function serializeWitness(items) {
  const chunks = [compactSize(items.length)]
  for (const item of items) {
    const bytes = Buffer.from(item, 'hex')
    chunks.push(compactSize(bytes.length), bytes)
  }
  return Buffer.concat(chunks).toString('hex')
}

function fixtureTransaction(protocol, value) {
  return {
    version: value.version,
    locktime: value.locktime,
    inputs: value.inputs.map((input, index) => {
      assert.equal(input.scriptSig, '', `transaction input ${index} scriptSig`)
      return {
        prevout: { txid: protocol.hexToBytes(input.txid), vout: input.vout },
        sequence: input.sequence,
      }
    }),
    outputs: value.outputs.map(output => ({
      value: BigInt(output.valueSats),
      scriptPubKey: protocol.hexToBytes(output.scriptPubKey),
    })),
  }
}

function fixtureSpentOutputs(protocol, value) {
  return value.map(output => ({
    value: BigInt(output.valueSats),
    scriptPubKey: protocol.hexToBytes(output.scriptPubKey),
  }))
}

function expectProtocolThrow(fn, pattern, label) {
  assert.throws(fn, pattern, label)
}

function verifyCommitments(fixture, protocol) {
  for (const vector of fixture.commitments.valid) {
    const script = protocol.hexToBytes(vector.leaf_script)
    const leafHash = protocol.p2mrLeafHash(vector.leaf_version, script)
    assert.equal(protocol.bytesToHex(leafHash), vector.leaf_hash, `${vector.id} leaf hash`)
    assert.equal(
      `${vector.leaf_version.toString(16).padStart(2, '0')}${compactSize(script.length).toString(
        'hex'
      )}${vector.leaf_script}`,
      vector.leaf_preimage,
      `${vector.id} leaf preimage`
    )
    const siblings = vector.siblings.map(protocol.hexToBytes)
    const control = protocol.buildControlBlock(vector.leaf_version, siblings)
    assert.equal(protocol.bytesToHex(control), vector.control_block, `${vector.id} control block`)

    let current = leafHash
    vector.branch_preimages.forEach((expectedPreimage, index) => {
      const sibling = siblings[index]
      const ordered =
        Buffer.compare(Buffer.from(current), Buffer.from(sibling)) <= 0
          ? [current, sibling]
          : [sibling, current]
      assert.equal(
        Buffer.concat(ordered.map(item => Buffer.from(item))).toString('hex'),
        expectedPreimage,
        `${vector.id} branch preimage ${index}`
      )
      current = protocol.p2mrBranchHash(current, sibling)
    })
    const root = protocol.verifyControlBlock(control, leafHash, vector.leaf_version)
    assert.equal(protocol.bytesToHex(root), vector.merkle_root, `${vector.id} Merkle root`)
    assert.equal(
      protocol.bytesToHex(protocol.p2mrScriptPubKey(root)),
      vector.scriptPubKey,
      `${vector.id} scriptPubKey`
    )
    assert.equal(
      protocol.p2mrAddressFromRoot(root, 'mainnet'),
      vector.mainnet_address,
      `${vector.id} mainnet address`
    )
    assert.equal(
      protocol.p2mrAddressFromRoot(root, 'regtest'),
      vector.regtest_address,
      `${vector.id} regtest address`
    )
    assert.deepEqual(
      vector.expected,
      { accepted: true, stage: 'script-complete', error: 'SCRIPT_ERR_OK' },
      `${vector.id} expected outcome`
    )
  }

  const byId = new Map(fixture.commitments.invalid.map(item => [item.id, item]))
  const expectedErrors = new Map([
    ['missing_bit0_control_marker', ['control-marker', 'SCRIPT_ERR_P2MR_CONTROL_BIT0']],
    ['malformed_control_block_size', ['control-size', 'SCRIPT_ERR_P2MR_WRONG_CONTROL_SIZE']],
    ['wrong_leaf_version', ['commitment', 'SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH']],
    [
      'wrong_compactsize_script_length_encoding',
      ['commitment', 'SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH'],
    ],
    ['mutated_sibling', ['commitment', 'SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH']],
    [
      'unsorted_branch_preimage_when_spent_hash_sorts_after_sibling',
      ['commitment', 'SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH'],
    ],
    ['wrong_address_root_commitment', ['commitment', 'SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH']],
  ])
  for (const [id, [stage, error]] of expectedErrors) {
    const vector = byId.get(id)
    assert.deepEqual(vector.expected, { accepted: false, stage, error }, `${id} expected outcome`)
    assert.equal(vector.expected_error, error, `${id} expected error alias`)
  }
  const leafHash = id => {
    const vector = byId.get(id)
    return protocol.p2mrLeafHash(vector.leaf_version, protocol.hexToBytes(vector.leaf_script))
  }

  {
    const vector = byId.get('missing_bit0_control_marker')
    expectProtocolThrow(
      () =>
        protocol.verifyControlBlock(
          protocol.hexToBytes(vector.control_block),
          leafHash(vector.id),
          vector.leaf_version
        ),
      /bit 0/,
      vector.id
    )
  }
  {
    const vector = byId.get('malformed_control_block_size')
    expectProtocolThrow(
      () =>
        protocol.verifyControlBlock(
          protocol.hexToBytes(vector.control_block),
          leafHash(vector.id),
          vector.leaf_version
        ),
      /control block size/,
      vector.id
    )
  }
  {
    const vector = byId.get('wrong_leaf_version')
    const root = protocol.verifyControlBlock(
      protocol.hexToBytes(vector.control_block),
      leafHash(vector.id),
      vector.leaf_version
    )
    assert.notEqual(protocol.bytesToHex(root), vector.merkle_root, vector.id)
  }
  {
    const vector = byId.get('wrong_compactsize_script_length_encoding')
    const canonical = leafHash(vector.id)
    assert.equal(
      taggedHash('P2MRLeaf', Buffer.from(vector.wrong_leaf_preimage, 'hex')),
      vector.wrong_leaf_hash,
      `${vector.id} wrong leaf hash`
    )
    assert.notEqual(protocol.bytesToHex(canonical), vector.wrong_leaf_hash, vector.id)
  }
  for (const id of ['mutated_sibling', 'wrong_address_root_commitment']) {
    const vector = byId.get(id)
    const root = protocol.verifyControlBlock(
      protocol.hexToBytes(vector.control_block),
      leafHash(id),
      vector.leaf_version
    )
    assert.notEqual(protocol.bytesToHex(root), vector.merkle_root, id)
  }
  {
    const vector = byId.get('unsorted_branch_preimage_when_spent_hash_sorts_after_sibling')
    const root = protocol.verifyControlBlock(
      protocol.hexToBytes(vector.control_block),
      leafHash(vector.id),
      vector.leaf_version
    )
    assert.notEqual(protocol.bytesToHex(root), vector.wrong_merkle_root, vector.id)
    assert.equal(
      taggedHash('P2MRBranch', Buffer.from(vector.wrong_branch_preimage, 'hex')),
      vector.wrong_merkle_root,
      `${vector.id} wrong branch hash`
    )
  }
}

function verifyCrossProfile(fixture, protocol) {
  for (const vector of fixture.crossProfile.vectors) {
    const leafHash = protocol.p2mrLeafHash(
      Number.parseInt(vector.leaf_version, 16),
      protocol.hexToBytes(vector.leaf_script)
    )
    assert.equal(protocol.bytesToHex(leafHash), vector.p2mr_leaf_root, `${vector.id} P2MR root`)
    assert.notEqual(vector.p2mr_leaf_root, vector.tapleaf_root, `${vector.id} profile roots`)
    assert.deepEqual(vector.witness, [vector.leaf_script, vector.control_block], vector.id)
    const programRoot = vector.scriptPubKey.slice(4)
    assert.equal(
      programRoot,
      vector.id === 'pinned-bip-root-rejected-by-qbit'
        ? vector.tapleaf_root
        : vector.p2mr_leaf_root,
      `${vector.id} selected program root`
    )
    assert.equal(
      protocol.bytesToHex(protocol.p2mrScriptPubKey(protocol.hexToBytes(programRoot))),
      vector.scriptPubKey
    )
    assert.equal(vector.expected.qbit_p2mr_v1.accepted, false, `${vector.id} qbit outcome`)
  }
}

function verifyControlBoundaries(fixture, protocol) {
  for (const vector of fixture.controlBoundaries) {
    const siblings = Array.from({ length: vector.nodes }, () => new Uint8Array(32))
    if (vector.nodes === 128) {
      const control = protocol.buildControlBlock(vector.leafVersion, siblings)
      assert.equal(protocol.bytesToHex(control), vector.controlBlock, vector.id)
      const leafHash = protocol.p2mrLeafHash(
        vector.leafVersion,
        protocol.hexToBytes(vector.leafScript)
      )
      assert.equal(protocol.bytesToHex(leafHash), vector.leafHash, `${vector.id} leaf hash`)
      const root = protocol.verifyControlBlock(control, leafHash, vector.leafVersion)
      assert.equal(protocol.bytesToHex(root), vector.merkleRoot, `${vector.id} root`)
      assert.equal(
        protocol.bytesToHex(protocol.p2mrScriptPubKey(root)),
        vector.scriptPubKey,
        `${vector.id} scriptPubKey`
      )
      assert.deepEqual(
        vector.consensus,
        { accepted: true, stage: 'script-complete', error: 'SCRIPT_ERR_OK' },
        `${vector.id} consensus outcome`
      )
      assert.deepEqual(vector.policy, vector.consensus, `${vector.id} policy outcome`)
    } else {
      assert.equal(vector.nodes, 129, `${vector.id} node count`)
      assert.equal(Buffer.from(vector.controlBlock, 'hex').length, 1 + 129 * 32, vector.id)
      expectProtocolThrow(
        () => protocol.buildControlBlock(vector.leafVersion, siblings),
        /maximum depth/,
        `${vector.id} builder`
      )
      expectProtocolThrow(
        () =>
          protocol.verifyControlBlock(
            protocol.hexToBytes(vector.controlBlock),
            protocol.hexToBytes(vector.leafHash),
            vector.leafVersion
          ),
        /control block size/,
        `${vector.id} parser`
      )
      assert.deepEqual(
        vector.consensus,
        {
          accepted: false,
          stage: 'control-size',
          error: 'SCRIPT_ERR_P2MR_WRONG_CONTROL_SIZE',
        },
        `${vector.id} consensus outcome`
      )
      assert.deepEqual(vector.policy, vector.consensus, `${vector.id} policy outcome`)
    }
  }
}

function verifyFutureLeafVersions(fixture, protocol) {
  for (const vector of fixture.futureLeafVersions) {
    assert.equal(vector.controlByte & 0xfe, vector.leafVersion, `${vector.id} version mask`)
    const leafHash = protocol.p2mrLeafHash(
      vector.leafVersion,
      protocol.hexToBytes(vector.leafScript)
    )
    assert.equal(protocol.bytesToHex(leafHash), vector.leafHash, `${vector.id} leaf hash`)
    const control = protocol.buildControlBlock(vector.leafVersion)
    assert.equal(protocol.bytesToHex(control), vector.controlBlock, `${vector.id} control block`)
    const root = protocol.verifyControlBlock(control, leafHash, vector.leafVersion)
    assert.equal(protocol.bytesToHex(root), vector.merkleRoot, `${vector.id} root`)
    assert.equal(
      protocol.bytesToHex(protocol.p2mrScriptPubKey(root)),
      vector.scriptPubKey,
      `${vector.id} scriptPubKey`
    )
    assert.deepEqual(
      vector.consensus,
      { accepted: true, stage: 'upgrade-success', error: 'SCRIPT_ERR_OK' },
      `${vector.id} consensus outcome`
    )
    assert.deepEqual(
      vector.policy,
      {
        accepted: false,
        stage: 'policy',
        error: 'SCRIPT_ERR_DISCOURAGE_UPGRADABLE_TAPROOT_VERSION',
      },
      `${vector.id} policy outcome`
    )
  }
}

function verifyWitness(fixture, protocol) {
  for (const vector of fixture.witness) {
    const tx = fixtureTransaction(protocol, vector.transaction)
    const spentOutputs = fixtureSpentOutputs(protocol, vector.spentOutputs)
    const leafHash = protocol.p2mrLeafHash(
      vector.leafVersion,
      protocol.hexToBytes(vector.leafScript)
    )
    assert.equal(protocol.bytesToHex(leafHash), vector.leafHash, `${vector.id} leaf hash`)
    const root = protocol.verifyControlBlock(
      protocol.hexToBytes(vector.controlBlock),
      leafHash,
      vector.leafVersion
    )
    assert.equal(
      protocol.bytesToHex(protocol.p2mrScriptPubKey(root)),
      vector.spentOutputs[vector.inputIndex].scriptPubKey,
      `${vector.id} prevout commitment`
    )
    const annex = vector.annex === null ? undefined : protocol.hexToBytes(vector.annex)
    const digest = protocol.p2mrSighash({
      tx,
      inputIndex: vector.inputIndex,
      spentOutputs,
      leafHash,
      hashType: vector.hashType,
      keyVersion: vector.keyVersion,
      codeSeparatorPos: vector.codeSeparatorPosition,
      annex,
    })
    assert.equal(protocol.bytesToHex(digest), vector.sighash, `${vector.id} sighash`)
    assert.equal(
      taggedHash('P2MRSighash', Buffer.from(vector.sigMsg, 'hex')),
      vector.sighash,
      `${vector.id} sigmsg`
    )
    assert.equal(vector.epoch, 0, `${vector.id} epoch`)
    assert.equal(vector.spendType, 2 + (annex === undefined ? 0 : 1), `${vector.id} spendType`)
    assert.equal(serializeWitness(vector.witness), vector.serializedWitness, `${vector.id} witness`)
    assert.deepEqual(
      vector.expected,
      { accepted: true, stage: 'script-complete', error: 'SCRIPT_ERR_OK' },
      `${vector.id} expected outcome`
    )

    const decoded = protocol.decodeP2mrWitnessSignature(protocol.hexToBytes(vector.witness[0]))
    assert.equal(decoded.hashType, vector.hashType, `${vector.id} witness hashtype`)
    assert.equal(decoded.explicitHashType, vector.hashType !== 0, `${vector.id} explicit hashtype`)
    const leafIndex = annex === undefined ? vector.witness.length - 2 : 1
    const controlIndex = annex === undefined ? vector.witness.length - 1 : 2
    assert.equal(vector.witness[leafIndex], vector.leafScript, `${vector.id} witness leaf`)
    assert.equal(vector.witness[controlIndex], vector.controlBlock, `${vector.id} witness control`)
    if (annex !== undefined) {
      assert.equal(vector.witness.at(-1), vector.annex, `${vector.id} witness annex`)
      assert.equal(
        sha256(Buffer.concat([compactSize(annex.length), Buffer.from(annex)])),
        vector.annexHash,
        `${vector.id} annex hash`
      )
      const withoutAnnex = protocol.p2mrSighash({
        tx,
        inputIndex: vector.inputIndex,
        spentOutputs,
        leafHash,
        hashType: vector.hashType,
        keyVersion: vector.keyVersion,
        codeSeparatorPos: vector.codeSeparatorPosition,
      })
      assert.equal(
        protocol.bytesToHex(withoutAnnex),
        vector.nearMisses.withoutAnnex.sighash,
        `${vector.id} no-annex near miss`
      )
      assert.equal(
        taggedHash('P2MRSighash', Buffer.from(vector.nearMisses.withoutAnnex.sigMsg, 'hex')),
        vector.nearMisses.withoutAnnex.sighash,
        `${vector.id} no-annex sigmsg`
      )
      assert.notEqual(protocol.bytesToHex(withoutAnnex), vector.sighash, vector.id)
    }
    if (vector.nearMisses.wrongCodeSeparator !== undefined) {
      const wrong = protocol.p2mrSighash({
        tx,
        inputIndex: vector.inputIndex,
        spentOutputs,
        leafHash,
        hashType: vector.hashType,
        keyVersion: vector.keyVersion,
        codeSeparatorPos: vector.nearMisses.wrongCodeSeparator.position,
        annex,
      })
      assert.equal(
        protocol.bytesToHex(wrong),
        vector.nearMisses.wrongCodeSeparator.sighash,
        `${vector.id} wrong-code-separator near miss`
      )
      assert.equal(
        taggedHash('P2MRSighash', Buffer.from(vector.nearMisses.wrongCodeSeparator.sigMsg, 'hex')),
        vector.nearMisses.wrongCodeSeparator.sighash,
        `${vector.id} wrong-code-separator sigmsg`
      )
      assert.notEqual(protocol.bytesToHex(wrong), vector.sighash, vector.id)
    }
  }
}

export function verifyOfflineFixture(fixture, protocol, { corePin, coverageMapBytes } = {}) {
  assert.equal(fixture.schemaVersion, 1, 'fixture schemaVersion')
  assert.equal(fixture.name, 'qbit-core-p2mr-offline-gaps', 'fixture name')
  const digest = assertFixtureDigest(fixture)
  if (corePin !== undefined) {
    validateReleaseEvidence(fixture.provenance.release, corePin.runtimeRelease)
    assert.deepEqual(
      {
        repository: corePin.sourceBaseline.repository,
        commit: corePin.sourceBaseline.commit,
      },
      {
        repository: fixture.provenance.release.repository,
        commit: fixture.provenance.release.commit,
      },
      'source baseline'
    )
    const pinnedFiles = new Map(corePin.files.map(file => [file.path, file.sha256]))
    assert.equal(fixture.provenance.sourceFiles.length, 6, 'source file count')
    for (const source of fixture.provenance.sourceFiles) {
      assert.equal(pinnedFiles.get(source.path), source.sha256, `${source.path} pinned SHA-256`)
      assert.match(source.gitBlobOid, /^[0-9a-f]{40}$/, `${source.path} Git blob OID`)
    }
  }
  if (coverageMapBytes !== undefined) {
    assert.equal(
      sha256Hex(coverageMapBytes),
      fixture.provenance.coverageMap.sha256,
      'coverage map digest'
    )
  }
  verifyCommitments(fixture, protocol)
  verifyCrossProfile(fixture, protocol)
  verifyWitness(fixture, protocol)
  verifyControlBoundaries(fixture, protocol)
  verifyFutureLeafVersions(fixture, protocol)
  return {
    fixtureDigest: digest,
    cases:
      fixture.commitments.valid.length +
      fixture.commitments.invalid.length +
      fixture.crossProfile.vectors.length +
      fixture.witness.length +
      fixture.controlBoundaries.length +
      fixture.futureLeafVersions.length,
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const fixturePath = resolve(options.get('--fixture') || defaultFixture)
  const protocolPath = resolve(options.get('--protocol') || defaultProtocol)
  const fixture = readJson(fixturePath, 'P2MR offline fixture')
  const corePin = readJson(corePinPath, 'Core pin manifest')
  assert.equal(fixture.provenance.coverageMap.path, coverageMapRelative, 'coverage map path')
  const coverageMapPath = resolve(root, coverageMapRelative)
  const protocol = await import(pathToFileURL(protocolPath).href)
  const result = verifyOfflineFixture(fixture, protocol, {
    corePin,
    coverageMapBytes: readFileSync(coverageMapPath),
  })
  console.log(`[p2mr-offline-fixture] PASS cases=${result.cases} digest=${result.fixtureDigest}`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch(error => {
    console.error(
      `[p2mr-offline-fixture] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  })
}
