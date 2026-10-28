import { createHash } from 'node:crypto'

export const GENERATOR_NAME = 'scripts/conformance/generate-p2mr-offline-fixture.mjs'
export const GENERATOR_VERSION = 1
export const FIXTURE_DIGEST_CANONICALIZATION =
  'sha256-canonical-json-v1: recursively sort object keys, preserve array order, omit provenance.fixtureDigest.value, JSON.stringify without whitespace, UTF-8'

export const SOURCE_PATHS = Object.freeze({
  manifest: 'src/test/data/p2mr_v1_manifest.json',
  commitments: 'src/test/data/p2mr_vectors.json',
  crossProfile: 'src/test/data/p2mr_cross_profile_vectors.json',
  witness: 'src/test/data/p2mr_pqc_witness_vectors.json',
  boundaries: 'src/test/data/p2mr_script_boundary_vectors.json',
  messageProof: 'src/test/data/p2mr_datapqchash_vectors.json',
})

export const EXTRACTED_WITNESS_CASES = Object.freeze([
  'single_key_sighash_none',
  'single_key_default_sighash_annex_present',
  'single_key_leading_codesep',
  'branch_codesep_true',
  'branch_codesep_false',
])

export const EXTRACTED_CONTROL_CASES = Object.freeze(['control-depth-128', 'control-depth-129'])

export const EXTRACTED_FUTURE_LEAF_CASES = Object.freeze([
  'leaf-production-reserved',
  'leaf-staged-signature-system',
  'leaf-experimental',
  'leaf-extension-fe',
  'leaf-odd-control-mask',
])

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/
const RELEASE_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'binding',
  'repository',
  'tag',
  'commit',
  'releaseSignerFingerprint',
  'checksumSignatureAsset',
  'linuxX64ArchiveSha256',
  'linuxArm64ArchiveSha256',
])

function fail(message) {
  throw new Error(message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`)
}

function assertArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has unexpected keys: expected ${wanted.join(', ')}, got ${actual.join(', ')}`)
  }
}

function assertInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer in [${minimum}, ${maximum}]`)
  }
}

function assertHex(value, label, bytes) {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) {
    fail(`${label} must be lowercase even-length hex`)
  }
  if (bytes !== undefined && value.length !== bytes * 2) {
    fail(`${label} must encode ${bytes} bytes`)
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonicalize(value[key])])
  )
}

export function fixtureDigestValue(fixture) {
  const payload = clone(fixture)
  if (!isObject(payload.provenance?.fixtureDigest)) {
    fail('fixture provenance.fixtureDigest must be an object')
  }
  delete payload.provenance.fixtureDigest.value
  return sha256Hex(Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8'))
}

export function assertFixtureDigest(fixture) {
  const digest = fixture?.provenance?.fixtureDigest
  assertExactKeys(digest, ['algorithm', 'canonicalization', 'value'], 'fixture digest')
  if (digest.algorithm !== 'sha256') fail('fixture digest algorithm must be sha256')
  if (digest.canonicalization !== FIXTURE_DIGEST_CANONICALIZATION) {
    fail('fixture digest canonicalization is unsupported')
  }
  if (!SHA256_PATTERN.test(digest.value)) fail('fixture digest value must be lowercase SHA-256')
  const actual = fixtureDigestValue(fixture)
  if (actual !== digest.value) {
    fail(`fixture digest drift: expected ${digest.value}, computed ${actual}`)
  }
  return actual
}

export function serializeFixture(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`
}

export function validateReleaseEvidence(evidence, runtimeRelease) {
  assertExactKeys(evidence, RELEASE_EVIDENCE_KEYS, 'release provenance evidence')
  assertObject(runtimeRelease, 'runtime release pin')
  const expected = { schemaVersion: 1, ...runtimeRelease }
  for (const key of RELEASE_EVIDENCE_KEYS) {
    if (evidence[key] !== expected[key]) {
      fail(
        `release provenance ${key} mismatch: expected ${JSON.stringify(
          expected[key]
        )}, got ${JSON.stringify(evidence[key])}`
      )
    }
  }
  return clone(evidence)
}

function compactSize(value) {
  assertInteger(value, 'CompactSize value', 0)
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

function taggedHash(tag, ...parts) {
  const tagHash = createHash('sha256').update(tag).digest()
  return createHash('sha256')
    .update(tagHash)
    .update(tagHash)
    .update(Buffer.concat(parts.map(part => Buffer.from(part))))
    .digest()
}

function p2mrLeafMaterial(leafVersion, scriptHex) {
  assertInteger(leafVersion, 'leaf version', 0, 0xff)
  assertHex(scriptHex, 'leaf script')
  const script = Buffer.from(scriptHex, 'hex')
  const preimage = Buffer.concat([Buffer.from([leafVersion]), compactSize(script.length), script])
  const leafHash = taggedHash('P2MRLeaf', preimage)
  return {
    leafPreimage: preimage.toString('hex'),
    leafHash: leafHash.toString('hex'),
  }
}

function p2mrBranchHash(left, right) {
  const ordered = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left]
  return taggedHash('P2MRBranch', ...ordered)
}

function rootFromControl(leafHashHex, controlBlockHex) {
  assertHex(leafHashHex, 'leaf hash', 32)
  assertHex(controlBlockHex, 'control block')
  const control = Buffer.from(controlBlockHex, 'hex')
  if (control.length < 1 || (control.length - 1) % 32 !== 0) {
    fail('control block must contain one control byte plus 32-byte path nodes')
  }
  let root = Buffer.from(leafHashHex, 'hex')
  for (let offset = 1; offset < control.length; offset += 32) {
    root = p2mrBranchHash(root, control.subarray(offset, offset + 32))
  }
  return root.toString('hex')
}

function scriptPubKey(rootHex) {
  assertHex(rootHex, 'P2MR root', 32)
  return `5220${rootHex}`
}

function readCompactSize(bytes, state, label) {
  if (state.offset >= bytes.length) fail(`${label} is truncated`)
  const first = bytes[state.offset++]
  if (first < 0xfd) return first
  if (first === 0xfd) {
    if (state.offset + 2 > bytes.length) fail(`${label} is truncated`)
    const value = bytes.readUInt16LE(state.offset)
    state.offset += 2
    if (value < 0xfd) fail(`${label} is non-canonical`)
    return value
  }
  if (first === 0xfe) {
    if (state.offset + 4 > bytes.length) fail(`${label} is truncated`)
    const value = bytes.readUInt32LE(state.offset)
    state.offset += 4
    if (value <= 0xffff) fail(`${label} is non-canonical`)
    return value
  }
  if (state.offset + 8 > bytes.length) fail(`${label} is truncated`)
  const value = bytes.readBigUInt64LE(state.offset)
  state.offset += 8
  if (value <= 0xffffffffn || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} is non-canonical or too large`)
  }
  return Number(value)
}

function readBytes(bytes, state, count, label) {
  if (!Number.isSafeInteger(count) || count < 0 || state.offset + count > bytes.length) {
    fail(`${label} is truncated or has invalid length`)
  }
  const value = bytes.subarray(state.offset, state.offset + count)
  state.offset += count
  return value
}

function readVarBytes(bytes, state, label) {
  return readBytes(bytes, state, readCompactSize(bytes, state, `${label} length`), label)
}

export function parseCoreTransaction(rawHex) {
  assertHex(rawHex, 'Core transaction')
  const bytes = Buffer.from(rawHex, 'hex')
  const state = { offset: 0 }
  if (bytes.length < 10) fail('Core transaction is too short')
  const version = bytes.readInt32LE(state.offset)
  state.offset += 4
  let hasWitness = false
  if (bytes[state.offset] === 0 && bytes[state.offset + 1] !== 0) {
    hasWitness = true
    state.offset += 2
  }
  const inputCount = readCompactSize(bytes, state, 'transaction input count')
  const inputs = []
  for (let index = 0; index < inputCount; index += 1) {
    const txid = readBytes(bytes, state, 32, `input ${index} txid`).toString('hex')
    const vout = bytes.readUInt32LE(state.offset)
    state.offset += 4
    const scriptSig = readVarBytes(bytes, state, `input ${index} scriptSig`).toString('hex')
    if (state.offset + 4 > bytes.length) fail(`input ${index} sequence is truncated`)
    const sequence = bytes.readUInt32LE(state.offset)
    state.offset += 4
    inputs.push({ txid, vout, sequence, scriptSig })
  }
  const outputCount = readCompactSize(bytes, state, 'transaction output count')
  const outputs = []
  for (let index = 0; index < outputCount; index += 1) {
    if (state.offset + 8 > bytes.length) fail(`output ${index} amount is truncated`)
    const valueSats = bytes.readBigUInt64LE(state.offset)
    state.offset += 8
    const outputScript = readVarBytes(bytes, state, `output ${index} scriptPubKey`)
    outputs.push({ valueSats: valueSats.toString(), scriptPubKey: outputScript.toString('hex') })
  }
  const witnesses = []
  if (hasWitness) {
    for (let index = 0; index < inputCount; index += 1) {
      const start = state.offset
      const itemCount = readCompactSize(bytes, state, `input ${index} witness item count`)
      const items = []
      for (let item = 0; item < itemCount; item += 1) {
        items.push(
          readVarBytes(bytes, state, `input ${index} witness item ${item}`).toString('hex')
        )
      }
      witnesses.push({
        items,
        serialized: bytes.subarray(start, state.offset).toString('hex'),
      })
    }
  } else {
    for (let index = 0; index < inputCount; index += 1) {
      witnesses.push({ items: [], serialized: '00' })
    }
  }
  if (state.offset + 4 !== bytes.length) fail('Core transaction has trailing or truncated locktime')
  const locktime = bytes.readUInt32LE(state.offset)
  return {
    tx: { version, locktime, inputs, outputs },
    witnesses,
  }
}

function expectedCandidates(corpora) {
  const candidates = []
  for (const item of corpora.commitments.valid) {
    candidates.push({ sourceFile: SOURCE_PATHS.commitments, case: item.id })
  }
  for (const item of corpora.commitments.invalid) {
    candidates.push({ sourceFile: SOURCE_PATHS.commitments, case: item.id })
  }
  for (const item of corpora.witness.vectors) {
    candidates.push({ sourceFile: SOURCE_PATHS.witness, case: item.name })
  }
  for (const item of corpora.crossProfile.vectors) {
    candidates.push({ sourceFile: SOURCE_PATHS.crossProfile, case: item.id })
  }
  for (const item of corpora.boundaries.cases) {
    candidates.push({ sourceFile: SOURCE_PATHS.boundaries, case: item.id })
  }
  for (const item of corpora.messageProof.vectors) {
    candidates.push({ sourceFile: SOURCE_PATHS.messageProof, case: item.name })
  }
  return candidates
}

function assertUniqueCases(items, field, label) {
  const values = items.map(item => item[field])
  if (values.some(value => typeof value !== 'string' || value.length === 0)) {
    fail(`${label} contains an empty case identifier`)
  }
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate case identifiers`)
}

export function validateCoreCorpora(corpora, sourceFiles) {
  assertExactKeys(
    corpora,
    ['manifest', 'commitments', 'crossProfile', 'witness', 'boundaries', 'messageProof'],
    'Core corpora'
  )
  const { manifest, commitments, crossProfile, witness, boundaries, messageProof } = corpora
  assertExactKeys(
    manifest,
    [
      'schema_version',
      'profile',
      'profile_version',
      'specification',
      'reference_implementation',
      'ancestry',
      'case_count',
      'case_counts',
      'files',
    ],
    'P2MR manifest'
  )
  assertExactKeys(
    commitments,
    ['schema_version', 'profile', 'profile_version', 'generator', 'valid', 'invalid'],
    'P2MR commitment corpus'
  )
  assertExactKeys(
    witness,
    ['schema_version', 'profile', 'profile_version', 'vectors'],
    'P2MR witness corpus'
  )
  assertExactKeys(
    crossProfile,
    ['schema_version', 'profile', 'profile_version', 'comparison_profile', 'vectors'],
    'P2MR cross-profile corpus'
  )
  assertExactKeys(
    boundaries,
    ['schema_version', 'profile', 'profile_version', 'limits', 'cases'],
    'P2MR boundary corpus'
  )
  assertExactKeys(
    messageProof,
    ['schema_version', 'description', 'vectors'],
    'P2MR message-proof corpus'
  )
  if (
    manifest.schema_version !== 1 ||
    manifest.profile !== 'qbit-p2mr-v1' ||
    manifest.profile_version !== 1 ||
    manifest.case_count !== 78
  ) {
    fail('P2MR manifest identity or case count is invalid')
  }
  const manifestCounts = {
    commitment_valid: 4,
    commitment_invalid: 7,
    witness: 14,
    cross_profile: 2,
    script_boundary: 51,
  }
  if (JSON.stringify(manifest.case_counts) !== JSON.stringify(manifestCounts)) {
    fail('P2MR manifest case counts are invalid')
  }
  assertArray(manifest.files, 'P2MR manifest files')
  const expectedManifestFiles = new Map([
    [SOURCE_PATHS.crossProfile, 2],
    [SOURCE_PATHS.witness, 14],
    [SOURCE_PATHS.boundaries, 51],
    [SOURCE_PATHS.commitments, 11],
  ])
  if (manifest.files.length !== expectedManifestFiles.size) {
    fail('P2MR manifest must list exactly four vector corpora')
  }
  const expectedSourcePaths = new Set(Object.values(SOURCE_PATHS))
  if (
    sourceFiles.length !== expectedSourcePaths.size ||
    new Set(sourceFiles.map(file => file.path)).size !== expectedSourcePaths.size
  ) {
    fail('Core source metadata must contain every allowlisted path exactly once')
  }
  for (const file of sourceFiles) {
    assertExactKeys(file, ['path', 'gitBlobOid', 'sha256'], `source metadata ${file.path}`)
    if (!expectedSourcePaths.has(file.path))
      fail(`unexpected Core source metadata path ${file.path}`)
    if (!/^[0-9a-f]{40}$/.test(file.gitBlobOid)) {
      fail(`Core source metadata ${file.path} has an invalid Git blob OID`)
    }
    if (!SHA256_PATTERN.test(file.sha256)) {
      fail(`Core source metadata ${file.path} has an invalid SHA-256`)
    }
  }
  const sourceByPath = new Map(sourceFiles.map(file => [file.path, file]))
  for (const file of manifest.files) {
    assertExactKeys(
      file,
      ['path', 'purpose', 'case_count', 'sha256'],
      `P2MR manifest file ${file.path}`
    )
    if (expectedManifestFiles.get(file.path) !== file.case_count) {
      fail(`P2MR manifest case count mismatch for ${file.path}`)
    }
    const actual = sourceByPath.get(file.path)
    if (!actual || actual.sha256 !== file.sha256) {
      fail(`P2MR manifest digest mismatch for ${file.path}`)
    }
  }

  if (
    commitments.schema_version !== 1 ||
    commitments.profile !== 'qbit-p2mr-v1' ||
    commitments.valid?.length !== 4 ||
    commitments.invalid?.length !== 7
  ) {
    fail('P2MR commitment corpus shape is invalid')
  }
  if (
    witness.schema_version !== 1 ||
    witness.profile !== 'qbit-p2mr-v1' ||
    witness.vectors?.length !== 14
  ) {
    fail('P2MR witness corpus shape is invalid')
  }
  if (
    crossProfile.schema_version !== 1 ||
    crossProfile.profile !== 'qbit-p2mr-v1' ||
    crossProfile.vectors?.length !== 2
  ) {
    fail('P2MR cross-profile corpus shape is invalid')
  }
  if (
    boundaries.schema_version !== 1 ||
    boundaries.profile !== 'qbit-p2mr-v1' ||
    boundaries.cases?.length !== 51
  ) {
    fail('P2MR boundary corpus shape is invalid')
  }
  if (messageProof.schema_version !== 1 || messageProof.vectors?.length !== 1) {
    fail('P2MR message-proof corpus shape is invalid')
  }

  assertUniqueCases([...commitments.valid, ...commitments.invalid], 'id', 'commitment corpus')
  assertUniqueCases(witness.vectors, 'name', 'witness corpus')
  assertUniqueCases(crossProfile.vectors, 'id', 'cross-profile corpus')
  assertUniqueCases(boundaries.cases, 'id', 'boundary corpus')
  assertUniqueCases(messageProof.vectors, 'name', 'message-proof corpus')

  const boundaryCounts = Object.fromEntries(
    [...new Set(boundaries.cases.map(item => item.category))].map(category => [
      category,
      boundaries.cases.filter(item => item.category === category).length,
    ])
  )
  if (
    JSON.stringify(boundaryCounts) !==
    JSON.stringify({ 'witness-control': 10, 'leaf-version': 7, opcode: 22, resource: 12 })
  ) {
    fail('P2MR boundary category counts are invalid')
  }

  for (const name of EXTRACTED_WITNESS_CASES) {
    if (!witness.vectors.some(item => item.name === name))
      fail(`missing selected witness case ${name}`)
  }
  for (const id of [...EXTRACTED_CONTROL_CASES, ...EXTRACTED_FUTURE_LEAF_CASES]) {
    if (!boundaries.cases.some(item => item.id === id)) fail(`missing selected boundary case ${id}`)
  }
  return expectedCandidates(corpora)
}

export function validateCoverageMap(coverageMap, corpora, runtimeRelease) {
  assertExactKeys(
    coverageMap,
    ['schemaVersion', 'baseline', 'liveRows', 'existingFixtures', 'candidates'],
    'coverage map'
  )
  if (coverageMap.schemaVersion !== 1) fail('coverage map schemaVersion must be 1')
  const expectedBaseline = {
    repository: runtimeRelease.repository,
    releaseTag: runtimeRelease.tag,
    releaseCommit: runtimeRelease.commit,
  }
  if (JSON.stringify(coverageMap.baseline) !== JSON.stringify(expectedBaseline)) {
    fail('coverage map baseline does not match the runtime release pin')
  }
  assertArray(coverageMap.liveRows, 'coverage map liveRows')
  const rowIds = coverageMap.liveRows.map(row => row.id).sort()
  const expectedRows = [
    'addresses',
    'derivation',
    'descriptors',
    'message-proof',
    'psbt',
    'sighash-sign',
    'tx-fees',
  ]
  if (JSON.stringify(rowIds) !== JSON.stringify(expectedRows)) {
    fail('coverage map must account for all seven live rows exactly once')
  }
  assertArray(coverageMap.existingFixtures, 'coverage map existingFixtures')
  const requiredFixtures = [
    'scripts/conformance/fixtures/matrix.json',
    'node_modules/@qbit-oss/pqc/fixtures/qbit-core-derivation.json',
    'experiments/pqc-wasm/fixtures/slh-dsa-golden.json',
    'scripts/conformance/qbit-js/fixtures/p2mr-sighash.json',
    'scripts/conformance/qbit-js/fixtures/p2mr-psbt.json',
    'scripts/conformance/fixtures/message-proof.json',
  ]
  for (const path of requiredFixtures) {
    if (!coverageMap.existingFixtures.some(fixture => fixture.path === path)) {
      fail(`coverage map is missing existing fixture ${path}`)
    }
  }

  assertArray(coverageMap.candidates, 'coverage map candidates')
  const expected = expectedCandidates(corpora)
  const expectedKeys = new Set(expected.map(item => `${item.sourceFile}\u0000${item.case}`))
  const actualKeys = new Set()
  for (const [index, candidate] of coverageMap.candidates.entries()) {
    assertExactKeys(
      candidate,
      ['sourceFile', 'case', 'status', 'currentCoverage', 'byteLevelReason', 'resolution'],
      `coverage candidate ${index}`
    )
    const key = `${candidate.sourceFile}\u0000${candidate.case}`
    if (actualKeys.has(key))
      fail(`coverage map duplicates ${candidate.sourceFile} → ${candidate.case}`)
    actualKeys.add(key)
    if (!expectedKeys.has(key)) {
      fail(`coverage map contains unexpected candidate ${candidate.sourceFile} → ${candidate.case}`)
    }
    if (!['covered', 'uncovered'].includes(candidate.status)) {
      fail(`coverage candidate ${candidate.case} has invalid status`)
    }
    assertArray(candidate.currentCoverage, `coverage candidate ${candidate.case} currentCoverage`)
    if (candidate.currentCoverage.some(item => typeof item !== 'string' || item.length === 0)) {
      fail(`coverage candidate ${candidate.case} has invalid currentCoverage`)
    }
    if (typeof candidate.byteLevelReason !== 'string' || candidate.byteLevelReason.length < 12) {
      fail(`coverage candidate ${candidate.case} needs a byte-level reason`)
    }
    if (typeof candidate.resolution !== 'string' || candidate.resolution.length === 0) {
      fail(`coverage candidate ${candidate.case} needs a resolution`)
    }
  }
  if (actualKeys.size !== expectedKeys.size) {
    const missing = [...expectedKeys].filter(key => !actualKeys.has(key))
    fail(`coverage map is incomplete; missing ${missing.join(', ')}`)
  }
  return expected
}

function validateCommitmentVectors(commitments) {
  for (const item of commitments.valid) {
    const material = p2mrLeafMaterial(item.leaf_version, item.leaf_script)
    if (material.leafPreimage !== item.leaf_preimage || material.leafHash !== item.leaf_hash) {
      fail(`commitment vector ${item.id} leaf bytes drifted`)
    }
    const controlBlock = `${(item.leaf_version | 1).toString(16).padStart(2, '0')}${item.siblings.join(
      ''
    )}`
    if (controlBlock !== item.control_block)
      fail(`commitment vector ${item.id} control block drifted`)
    const root = rootFromControl(item.leaf_hash, item.control_block)
    if (root !== item.merkle_root || scriptPubKey(root) !== item.scriptPubKey) {
      fail(`commitment vector ${item.id} root or scriptPubKey drifted`)
    }
  }
}

function selectedWitnessVector(vector) {
  const parsed = parseCoreTransaction(vector.spendTx)
  assertInteger(vector.inputIndex, `${vector.name} inputIndex`, 0, parsed.tx.inputs.length - 1)
  const actualWitness = parsed.witnesses[vector.inputIndex]
  if (JSON.stringify(actualWitness.items) !== JSON.stringify(vector.witness)) {
    fail(`${vector.name} raw transaction witness does not match its witness field`)
  }
  const parseLittleEndianHex = (value, label) => {
    assertHex(value, label, 4)
    return Buffer.from(value, 'hex').readUInt32LE(0)
  }
  const nearMisses = {}
  if (vector.noAnnexSighash !== undefined) {
    nearMisses.withoutAnnex = {
      sigMsg: vector.noAnnexSigMsg,
      sighash: vector.noAnnexSighash,
    }
  }
  if (vector.wrongCodeseparatorSighash !== undefined) {
    nearMisses.wrongCodeSeparator = {
      position: parseLittleEndianHex(
        vector.wrongCodeSeparatorPosition,
        `${vector.name} wrong code-separator position`
      ),
      sigMsg: vector.wrongCodeseparatorSigMsg,
      sighash: vector.wrongCodeseparatorSighash,
    }
  }
  return {
    id: vector.id,
    name: vector.name,
    expected: clone(vector.expected),
    transaction: parsed.tx,
    inputIndex: vector.inputIndex,
    spentOutputs: vector.spentOutputs.map(output => ({
      valueSats: String(output.amount),
      scriptPubKey: output.scriptPubKey,
    })),
    hashType: Number.parseInt(vector.hashType, 16),
    epoch: Number.parseInt(vector.epoch, 16),
    spendType: Number.parseInt(vector.spendType, 16),
    keyVersion: Number.parseInt(vector.keyVersion, 16),
    codeSeparatorPosition: parseLittleEndianHex(
      vector.codeSeparatorPosition,
      `${vector.name} code-separator position`
    ),
    annex: vector.annex === 'none' ? null : vector.annex,
    annexHash: vector.annexHash ?? null,
    leafVersion: Number.parseInt(vector.leafVersion, 16),
    leafScript: vector.leafScript,
    leafHash: vector.leafHash,
    controlBlock: vector.controlBlock,
    sigMsg: vector.p2mrSigMsg,
    sighash: vector.p2mrSighash,
    witness: clone(vector.witness),
    serializedWitness: actualWitness.serialized,
    nearMisses,
  }
}

function selectedControlCase(item) {
  const nodes = item.parameters.nodes
  assertInteger(nodes, `${item.id} nodes`, 0, 129)
  const leafVersion = 0xc0
  const leafScript = '51'
  const material = p2mrLeafMaterial(leafVersion, leafScript)
  const controlBlock = `c1${'00'.repeat(nodes * 32)}`
  const acceptedDepth = nodes <= 128
  const merkleRoot = acceptedDepth ? rootFromControl(material.leafHash, controlBlock) : null
  return {
    id: item.id,
    nodes,
    leafVersion,
    leafScript,
    leafPreimage: material.leafPreimage,
    leafHash: material.leafHash,
    controlBlock,
    merkleRoot,
    scriptPubKey: merkleRoot === null ? null : scriptPubKey(merkleRoot),
    consensus: clone(item.consensus),
    policy: clone(item.policy),
  }
}

function selectedFutureLeafCase(item) {
  const controlByte = item.parameters.control_byte
  assertInteger(controlByte, `${item.id} control byte`, 0, 0xff)
  if ((controlByte & 1) !== 1) fail(`${item.id} control byte must set marker bit`)
  const leafVersion = controlByte & 0xfe
  const leafScript = item.parameters.script === 'true' ? '51' : '00'
  const material = p2mrLeafMaterial(leafVersion, leafScript)
  return {
    id: item.id,
    controlByte,
    leafVersion,
    leafScript,
    leafPreimage: material.leafPreimage,
    leafHash: material.leafHash,
    controlBlock: controlByte.toString(16).padStart(2, '0'),
    merkleRoot: material.leafHash,
    scriptPubKey: scriptPubKey(material.leafHash),
    consensus: clone(item.consensus),
    policy: clone(item.policy),
  }
}

export function buildOfflineFixture({
  corpora,
  releaseEvidence,
  sourceFiles,
  coverageMap,
  coverageMapPath,
  coverageMapSha256,
}) {
  validateCoreCorpora(corpora, sourceFiles)
  validateCoverageMap(coverageMap, corpora, releaseEvidence)
  validateCommitmentVectors(corpora.commitments)
  if (!SHA256_PATTERN.test(coverageMapSha256)) fail('coverage map SHA-256 is invalid')
  const witnessByName = new Map(corpora.witness.vectors.map(item => [item.name, item]))
  const boundaryById = new Map(corpora.boundaries.cases.map(item => [item.id, item]))
  const fixture = {
    schemaVersion: 1,
    name: 'qbit-core-p2mr-offline-gaps',
    profile: 'qbit-p2mr-v1',
    profileVersion: 1,
    provenance: {
      release: clone(releaseEvidence),
      sourceFiles: clone(sourceFiles),
      extraction: {
        generator: GENERATOR_NAME,
        generatorVersion: GENERATOR_VERSION,
        method:
          'Allowlisted extraction from signed Core JSON corpora; transaction witnesses are decoded from spendTx; control-depth and future-leaf bytes are independently derived with P2MRLeaf/P2MRBranch tagged hashes.',
        selectedCases: {
          commitments: [
            ...corpora.commitments.valid.map(item => item.id),
            ...corpora.commitments.invalid.map(item => item.id),
          ],
          crossProfile: corpora.crossProfile.vectors.map(item => item.id),
          witness: [...EXTRACTED_WITNESS_CASES],
          controlBoundaries: [...EXTRACTED_CONTROL_CASES],
          futureLeafVersions: [...EXTRACTED_FUTURE_LEAF_CASES],
        },
      },
      coverageMap: {
        path: coverageMapPath,
        sha256: coverageMapSha256,
      },
      fixtureDigest: {
        algorithm: 'sha256',
        canonicalization: FIXTURE_DIGEST_CANONICALIZATION,
        value: '',
      },
    },
    commitments: clone(corpora.commitments),
    crossProfile: {
      comparisonProfile: clone(corpora.crossProfile.comparison_profile),
      vectors: clone(corpora.crossProfile.vectors),
    },
    witness: EXTRACTED_WITNESS_CASES.map(name => selectedWitnessVector(witnessByName.get(name))),
    controlBoundaries: EXTRACTED_CONTROL_CASES.map(id => selectedControlCase(boundaryById.get(id))),
    futureLeafVersions: EXTRACTED_FUTURE_LEAF_CASES.map(id =>
      selectedFutureLeafCase(boundaryById.get(id))
    ),
  }
  fixture.provenance.fixtureDigest.value = fixtureDigestValue(fixture)
  return fixture
}
