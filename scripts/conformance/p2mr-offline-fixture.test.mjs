import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertFixtureDigest,
  fixtureDigestValue,
  parseCoreTransaction,
  serializeFixture,
  sha256Hex,
  validateReleaseEvidence,
} from './p2mr-offline-fixture-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = resolve(root, 'scripts/conformance/fixtures/p2mr-offline.json')
const coverageMapPath = resolve(root, 'scripts/conformance/p2mr-v1-coverage.json')
const corePinPath = resolve(root, 'scripts/conformance/core-pin.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const coverageMapBytes = readFileSync(coverageMapPath)
const coverageMap = JSON.parse(coverageMapBytes)
const corePin = JSON.parse(readFileSync(corePinPath, 'utf8'))

function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

test('committed P2MR offline fixture has a valid non-self-referential digest', () => {
  assert.equal(assertFixtureDigest(fixture), fixture.provenance.fixtureDigest.value)
  assert.equal(fixtureDigestValue(fixture), fixture.provenance.fixtureDigest.value)
})

test('fixture canonicalization and serialization are deterministic', () => {
  const first = copy(fixture)
  const second = copy(fixture)
  assert.equal(fixtureDigestValue(first), fixtureDigestValue(second))
  assert.equal(serializeFixture(first), serializeFixture(second))
  assert.equal(serializeFixture(first), readFileSync(fixturePath, 'utf8'))
})

test('fixture digest tampering fails closed', () => {
  const tampered = copy(fixture)
  tampered.commitments.valid[0].leaf_hash = '00'.repeat(32)
  assert.throws(() => assertFixtureDigest(tampered), /fixture digest drift/)
})

test('release provenance tampering fails generator validation', async t => {
  const evidence = fixture.provenance.release
  validateReleaseEvidence(evidence, corePin.runtimeRelease)
  for (const [field, value] of [
    ['repository', 'attacker/qbit'],
    ['tag', 'v1.0.0-mutated'],
    ['commit', '0'.repeat(40)],
    ['releaseSignerFingerprint', '0'.repeat(40)],
    ['linuxX64ArchiveSha256', '0'.repeat(64)],
  ]) {
    await t.test(field, () => {
      const tampered = copy(evidence)
      tampered[field] = value
      assert.throws(() => validateReleaseEvidence(tampered, corePin.runtimeRelease), /mismatch/)
    })
  }
})

test('coverage map is complete, unique, and bound by digest', () => {
  assert.equal(coverageMap.candidates.length, 79)
  assert.equal(
    new Set(coverageMap.candidates.map(item => `${item.sourceFile}\u0000${item.case}`)).size,
    79
  )
  assert.equal(coverageMap.candidates.filter(item => item.status === 'uncovered').length, 25)
  assert.equal(coverageMap.candidates.filter(item => item.status === 'covered').length, 54)
  assert.equal(sha256Hex(coverageMapBytes), fixture.provenance.coverageMap.sha256)
  assert.notEqual(
    sha256Hex(Buffer.concat([coverageMapBytes, Buffer.from('\n')])),
    fixture.provenance.coverageMap.sha256
  )
})

test('Core transaction extraction rejects malformed or noncanonical bytes', () => {
  assert.throws(() => parseCoreTransaction('00'), /too short/)
  assert.throws(
    () => parseCoreTransaction(`02000000fd0100${'00'.repeat(64)}`),
    /non-canonical|truncated/
  )
  assert.throws(() => parseCoreTransaction(`02000000000100`), /truncated|too short|trailing/)
})
