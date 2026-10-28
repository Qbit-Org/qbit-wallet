import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  TREE_HASH_ALGORITHM,
  candidateFromSource,
  compare,
  createReport,
  readManifest,
  sha256File,
  sha256Tree,
  validateManifest,
} from './report-pin-diff.mjs'

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function sha256TreeBySpecification(repo, entries) {
  const hash = createHash('sha256')
  for (const { path, mode } of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(path, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(mode, 'ascii')
    hash.update(Buffer.from([0]))
    hash.update(readFileSync(join(repo, 'src/core', path)))
  }
  return hash.digest('hex')
}

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'qbit-pin-report-'))
  const repo = join(temporary, 'candidate')
  mkdirSync(join(repo, 'src/core/nested'), { recursive: true })
  writeFileSync(join(repo, 'tracked.txt'), 'tracked-v1\n')
  // Creation order intentionally differs from hash order.
  writeFileSync(join(repo, 'src/core/nested/z.bin'), Buffer.from([0xff, 0x00, 0x41]))
  writeFileSync(join(repo, 'src/core/a.txt'), 'alpha\n')
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'Pin Report Test'])
  git(repo, ['config', 'user.email', 'pin-report@example.invalid'])
  git(repo, ['remote', 'add', 'origin', 'https://token-user:secret@example.invalid/qbit.git'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'fixture'])
  const commit = git(repo, ['rev-parse', 'HEAD'])
  const baseline = {
    schemaVersion: 1,
    fixtureSource: { repository: 'fixture/qbit', commit },
    files: [
      {
        path: 'tracked.txt',
        sha256: sha256File(join(repo, 'tracked.txt')),
        rows: ['addresses'],
      },
    ],
    trees: [
      {
        path: 'src/core',
        sha256: sha256Tree(join(repo, 'src/core')),
        rows: ['tx-fees', 'psbt'],
      },
    ],
    fixtures: [
      {
        path: 'fixtures/address.json',
        rows: ['addresses'],
        generator: 'node generate-addresses.mjs',
        consumer: 'node test-addresses.mjs',
      },
      {
        path: 'fixtures/all.json',
        rows: ['addresses', 'tx-fees'],
        generator: 'node generate-all.mjs',
        consumer: 'node test-all.mjs',
      },
      {
        path: 'fixtures/fees.json',
        rows: ['tx-fees'],
        generator: 'node generate-fees.mjs',
        consumer: 'node test-fees.mjs',
      },
    ],
  }
  validateManifest(baseline)
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  return { temporary, repo, baseline, commit }
}

test('candidate source reports identical file/tree hashes and clean Git provenance', t => {
  const { repo, baseline, commit } = fixture(t)
  assert.equal(
    TREE_HASH_ALGORITHM,
    'sha256-git-tracked-root-or-filesystem-posix-relative-path-nul-mode-nul-raw-bytes-v3'
  )
  assert.equal(
    baseline.trees[0].sha256,
    sha256TreeBySpecification(repo, [
      { path: 'a.txt', mode: '100644' },
      { path: 'nested/z.bin', mode: '100644' },
    ])
  )

  const candidate = candidateFromSource(repo, baseline)
  assert.deepEqual(candidate.sourceBaseline, {
    repository: 'https://example.invalid/qbit.git',
    commit,
    dirty: false,
  })
  assert.deepEqual(compare(baseline, candidate), {
    changed: [],
    missing: [],
    unchanged: ['tracked.txt', 'src/core'],
    affectedRows: [],
    fixturesToRegenerate: [],
  })
  assert.equal(createReport({ baseline, candidate }).status, 'identical')

  const rootHash = sha256Tree(repo)
  writeFileSync(join(repo, 'ignored-by-tree.txt'), 'untracked build artifact\n')
  assert.equal(sha256Tree(repo), rootHash)
})

test('Git tree hash detects executable-bit changes in clean commits', t => {
  const { repo } = fixture(t)
  const before = sha256Tree(repo)
  chmodSync(join(repo, 'tracked.txt'), 0o755)
  git(repo, ['add', 'tracked.txt'])
  git(repo, ['commit', '-q', '-m', 'mark tracked file executable'])

  assert.notEqual(sha256Tree(repo), before)
})

test('file and recursive tree drift maps affected rows to fixtures', t => {
  const { repo, baseline } = fixture(t)
  writeFileSync(join(repo, 'tracked.txt'), 'tracked-v2\n')
  writeFileSync(join(repo, 'src/core/nested/z.bin'), Buffer.from([0x01, 0x02]))

  const candidate = candidateFromSource(repo, baseline)
  const result = compare(baseline, candidate)
  assert.equal(candidate.sourceBaseline.dirty, true)
  assert.deepEqual(
    result.changed.map(item => [item.kind, item.path]),
    [
      ['file', 'tracked.txt'],
      ['tree', 'src/core'],
    ]
  )
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.affectedRows, ['addresses', 'psbt', 'tx-fees'])
  assert.deepEqual(result.fixturesToRegenerate, [
    'fixtures/address.json',
    'fixtures/all.json',
    'fixtures/fees.json',
  ])
})

test('missing files and trees are reported independently', t => {
  const { repo, baseline } = fixture(t)
  unlinkSync(join(repo, 'tracked.txt'))
  rmSync(join(repo, 'src/core'), { recursive: true })

  const result = compare(baseline, candidateFromSource(repo, baseline))
  assert.deepEqual(
    result.missing.map(item => [item.kind, item.path, item.actual]),
    [
      ['file', 'tracked.txt', null],
      ['tree', 'src/core', null],
    ]
  )
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.fixturesToRegenerate, [
    'fixtures/address.json',
    'fixtures/all.json',
    'fixtures/fees.json',
  ])
})

test('unrelated dirty state is provenance, not content drift', t => {
  const { repo, baseline } = fixture(t)
  writeFileSync(join(repo, 'untracked.txt'), 'not part of a tracked file or tree\n')

  const candidate = candidateFromSource(repo, baseline)
  assert.equal(candidate.sourceBaseline.dirty, true)
  assert.deepEqual(compare(baseline, candidate).changed, [])
  assert.equal(createReport({ baseline, candidate }).status, 'drift')
  assert.equal(createReport({ baseline, candidate }).provenanceDirty, true)
})

test('candidate manifests remain supported and malformed manifests are rejected', t => {
  const { temporary, baseline } = fixture(t)
  assert.doesNotThrow(() =>
    validateManifest({
      ...baseline,
      trees: [{ path: '.', sha256: '0'.repeat(64), rows: ['addresses'] }],
    })
  )
  const candidatePath = join(temporary, 'candidate-manifest.json')
  writeFileSync(candidatePath, JSON.stringify(baseline))
  const candidate = readManifest(candidatePath)
  assert.equal(createReport({ baseline, candidate }).status, 'identical')

  assert.throws(
    () => validateManifest({ schemaVersion: 1, files: [] }),
    /files must be a nonempty array/
  )
  assert.throws(
    () => validateManifest({ ...baseline, trees: [] }),
    /trees must be a nonempty array/
  )
  assert.throws(
    () => validateManifest({ ...baseline, fixtures: [] }),
    /fixtures must be a nonempty array/
  )

  const invalidHash = structuredClone(baseline)
  invalidHash.files[0].sha256 = 'not-a-sha256'
  assert.throws(() => validateManifest(invalidHash), /64 lowercase hexadecimal/)

  const duplicatePath = structuredClone(baseline)
  duplicatePath.trees[0].path = duplicatePath.files[0].path
  assert.throws(() => validateManifest(duplicatePath), /duplicate path/)

  const emptyRows = structuredClone(baseline)
  emptyRows.fixtures[0].rows = []
  assert.throws(() => validateManifest(emptyRows), /rows must be a nonempty array/)

  const unboundRuntime = structuredClone(baseline)
  unboundRuntime.sourceBaseline = {
    repository: 'Qbit-Org/qbit',
    commit: '1'.repeat(40),
    treeHashAlgorithm: TREE_HASH_ALGORITHM,
  }
  unboundRuntime.runtimeRelease = {
    binding: 'qbit-signed-release-tag-and-checksums-v1',
    repository: 'Qbit-Org/qbit',
    tag: 'v0.1.2-testnet4',
    commit: '2'.repeat(40),
    releaseSignerFingerprint: 'A'.repeat(40),
    checksumSignatureAsset: 'SHA256SUMS.operator-02.asc',
    linuxX64ArchiveSha256: '3'.repeat(64),
    linuxArm64ArchiveSha256: '4'.repeat(64),
  }
  assert.throws(() => validateManifest(unboundRuntime), /must be bound to sourceBaseline/)

  const unsafeSignatureAsset = structuredClone(unboundRuntime)
  unsafeSignatureAsset.runtimeRelease.commit = unsafeSignatureAsset.sourceBaseline.commit
  unsafeSignatureAsset.runtimeRelease.checksumSignatureAsset = '../SHA256SUMS.asc'
  assert.throws(() => validateManifest(unsafeSignatureAsset), /must identify a signed qbit release/)
})
