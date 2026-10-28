#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const baselinePath = resolve(scriptDir, 'core-pin.json')
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TRACKED_ITEM_KEYS = new Set(['path', 'rows', 'sha256'])
const FIXTURE_KEYS = new Set(['path', 'rows', 'generator', 'consumer'])
const RUNTIME_RELEASE_KEYS = new Set([
  'binding',
  'repository',
  'tag',
  'commit',
  'releaseSignerFingerprint',
  'checksumSignatureAsset',
  'linuxX64ArchiveSha256',
  'linuxArm64ArchiveSha256',
])

/**
 * Tree hash v3 is SHA-256 over each selected entry, ordered by
 * the UTF-8 bytes of its POSIX path relative to the tracked directory:
 *
 *   relative/path + NUL + Git-compatible mode + NUL + raw entry bytes
 *
 * At a Git repository root, only index-tracked paths are included, preventing
 * ignored build/cache artifacts from changing the source pin. Other tracked
 * directories use their complete filesystem contents. Empty directories and a
 * root-level `.git` entry are excluded. Regular files contribute mode 100644 or
 * 100755, symlinks contribute mode 120000 and the raw UTF-8 bytes of their link
 * target, and Git links contribute mode 160000 and their index object ID.
 */
export const TREE_HASH_ALGORITHM =
  'sha256-git-tracked-root-or-filesystem-posix-relative-path-nul-mode-nul-raw-bytes-v3'

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field ${JSON.stringify(key)}`)
  }
}

function validatePath(value, label, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label}.path must be a nonempty trimmed string`)
  }
  if (allowRoot && value === '.') return value
  if (
    value === '.' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label}.path must be a normalized POSIX relative path`)
  }
  return value
}

function validateRows(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}.rows must be a nonempty array`)
  }
  const seen = new Set()
  for (const [index, row] of value.entries()) {
    if (typeof row !== 'string' || row.length === 0 || row !== row.trim()) {
      throw new Error(`${label}.rows[${index}] must be a nonempty trimmed string`)
    }
    if (seen.has(row)) throw new Error(`${label}.rows contains duplicate ${JSON.stringify(row)}`)
    seen.add(row)
  }
  return value
}

function validateTrackedItems(value, kind, { required }) {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`manifest.${kind} must be a nonempty array`)
  }
  return value.map((item, index) => {
    const label = `manifest.${kind}[${index}]`
    assertPlainObject(item, label)
    assertKnownKeys(item, TRACKED_ITEM_KEYS, label)
    validatePath(item.path, label, { allowRoot: kind === 'trees' })
    validateRows(item.rows, label)
    if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
      throw new Error(`${label}.sha256 must be 64 lowercase hexadecimal characters`)
    }
    return item
  })
}

function validateFixtures(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('manifest.fixtures must be a nonempty array')
  }
  return value.map((fixture, index) => {
    const label = `manifest.fixtures[${index}]`
    assertPlainObject(fixture, label)
    assertKnownKeys(fixture, FIXTURE_KEYS, label)
    validatePath(fixture.path, label)
    validateRows(fixture.rows, label)
    for (const field of ['generator', 'consumer']) {
      if (
        typeof fixture[field] !== 'string' ||
        fixture[field].length === 0 ||
        fixture[field] !== fixture[field].trim()
      ) {
        throw new Error(`${label}.${field} must be a nonempty trimmed string`)
      }
    }
    return fixture
  })
}

function assertUniquePaths(items, label) {
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item.path)) throw new Error(`${label} contains duplicate path ${item.path}`)
    seen.add(item.path)
  }
}

export function validateManifest(manifest, source = 'manifest') {
  assertPlainObject(manifest, source)
  if (manifest.schemaVersion !== 1) {
    throw new Error(`${source}.schemaVersion must equal 1`)
  }
  if (manifest.sourceBaseline !== undefined) {
    assertPlainObject(manifest.sourceBaseline, `${source}.sourceBaseline`)
    if (
      typeof manifest.sourceBaseline.repository !== 'string' ||
      !/^[0-9a-f]{40}$/.test(manifest.sourceBaseline.commit) ||
      manifest.sourceBaseline.treeHashAlgorithm !== TREE_HASH_ALGORITHM
    ) {
      throw new Error(`${source}.sourceBaseline must identify a commit and tree hash algorithm`)
    }
  }
  if (manifest.runtimeRelease !== undefined) {
    const runtime = manifest.runtimeRelease
    assertPlainObject(runtime, `${source}.runtimeRelease`)
    assertKnownKeys(runtime, RUNTIME_RELEASE_KEYS, `${source}.runtimeRelease`)
    if (
      runtime.binding !== 'qbit-signed-release-tag-and-checksums-v1' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(runtime.repository) ||
      !/^v[0-9A-Za-z][0-9A-Za-z._-]*$/.test(runtime.tag) ||
      !/^[0-9a-f]{40}$/.test(runtime.commit) ||
      !/^[0-9A-F]{40}$/.test(runtime.releaseSignerFingerprint) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runtime.checksumSignatureAsset) ||
      !SHA256_PATTERN.test(runtime.linuxX64ArchiveSha256) ||
      !SHA256_PATTERN.test(runtime.linuxArm64ArchiveSha256)
    ) {
      throw new Error(`${source}.runtimeRelease must identify a signed qbit release`)
    }
    if (
      manifest.sourceBaseline &&
      (runtime.repository !== manifest.sourceBaseline.repository ||
        runtime.commit !== manifest.sourceBaseline.commit)
    ) {
      throw new Error(`${source}.runtimeRelease must be bound to sourceBaseline`)
    }
  }

  const files = validateTrackedItems(manifest.files, 'files', { required: true })
  const trees = validateTrackedItems(manifest.trees, 'trees', { required: false })
  const fixtures = validateFixtures(manifest.fixtures)
  assertUniquePaths([...files, ...trees], 'manifest files/trees')
  assertUniquePaths(fixtures, 'manifest fixtures')
  return manifest
}

export function readManifest(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`could not read Core pin manifest ${path}: ${error.message}`)
  }
  return validateManifest(parsed, `Core pin manifest ${path}`)
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function posixRelativePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

function regularFileMode(stat) {
  return stat.mode & 0o111 ? '100755' : '100644'
}

function collectTreeEntries(root, current = root, entries = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (current === root && entry.name === '.git') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      collectTreeEntries(root, path, entries)
    } else if (entry.isFile()) {
      entries.push({
        path: posixRelativePath(root, path),
        mode: regularFileMode(lstatSync(path)),
        bytes: readFileSync(path),
      })
    } else if (entry.isSymbolicLink()) {
      entries.push({
        path: posixRelativePath(root, path),
        mode: '120000',
        bytes: Buffer.from(readlinkSync(path)),
      })
    } else {
      throw new Error(`unsupported filesystem entry in tracked tree: ${path}`)
    }
  }
  return entries
}

function collectGitTrackedEntries(root) {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--stage', '-z'], {
    encoding: 'buffer',
  })
  if (listed.status !== 0) {
    throw new Error(`could not enumerate Git-tracked files under ${root}`)
  }
  return listed.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(line)
      if (!match) throw new Error(`could not parse Git index entry under ${root}`)
      const [, mode, objectId, stage, relativePath] = match
      if (stage !== '0') {
        throw new Error(`unmerged Git index entry is not valid pin evidence: ${relativePath}`)
      }
      const path = join(root, relativePath)
      if (!existsSync(path)) {
        return { path: relativePath, mode, bytes: Buffer.from('<missing>') }
      }
      const stat = lstatSync(path)
      if (mode === '100644' || mode === '100755') {
        if (!stat.isFile()) return { path: relativePath, mode, bytes: Buffer.from('<wrong-type>') }
        return { path: relativePath, mode, bytes: readFileSync(path) }
      }
      if (stat.isSymbolicLink()) {
        return { path: relativePath, mode, bytes: Buffer.from(readlinkSync(path)) }
      }
      if (mode === '160000' && stat.isDirectory()) {
        return { path: relativePath, mode, bytes: Buffer.from(objectId) }
      }
      return { path: relativePath, mode, bytes: Buffer.from('<wrong-type>') }
    })
}

export function sha256Tree(path) {
  const root = resolve(path)
  const entries = (
    existsSync(join(root, '.git')) ? collectGitTrackedEntries(root) : collectTreeEntries(root)
  ).sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
  )
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.path, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(entry.mode, 'ascii')
    hash.update(Buffer.from([0]))
    hash.update(entry.bytes)
  }
  return hash.digest('hex')
}

function hashCandidatePath(root, item, kind) {
  const path = resolve(root, item.path)
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (kind === 'file') return stat.isFile() ? sha256File(path) : null
  return stat.isDirectory() ? sha256Tree(path) : null
}

function git(root, args, { optional = false } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (!result.error && result.status === 0) return result.stdout.trim()
  if (optional) return undefined
  const detail = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
    .filter(Boolean)
    .join('\n')
  throw new Error(`git ${args.join(' ')} failed for ${root}${detail ? `:\n${detail}` : ''}`)
}

function sanitizeRepository(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.replace(/^[^/@\s]+@([^:\s]+):/, '$1:')
  }
}

export function candidateFromSource(source, baseline) {
  validateManifest(baseline, 'baseline manifest')
  const root = resolve(source)
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`candidate source is not a directory: ${root}`)
  }

  const commit = git(root, ['rev-parse', 'HEAD'])
  const repository = sanitizeRepository(
    git(root, ['config', '--get', 'remote.origin.url'], { optional: true }) || root
  )
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']).length > 0
  const files = baseline.files.map(file => ({
    path: file.path,
    rows: file.rows,
    sha256: hashCandidatePath(root, file, 'file'),
  }))
  const trees = (baseline.trees || []).map(tree => ({
    path: tree.path,
    rows: tree.rows,
    sha256: hashCandidatePath(root, tree, 'tree'),
  }))

  return {
    schemaVersion: 1,
    sourceBaseline: { repository, commit, dirty },
    files,
    ...(baseline.trees === undefined ? {} : { trees }),
  }
}

function compareItems(kind, expectedItems, candidateItems, result) {
  const candidates = new Map((candidateItems || []).map(item => [item.path, item]))
  for (const expected of expectedItems || []) {
    const actual = candidates.get(expected.path)
    if (!actual || actual.sha256 === null) {
      result.missing.push({
        kind,
        path: expected.path,
        rows: expected.rows,
        expected: expected.sha256,
        actual: null,
      })
    } else if (actual.sha256 !== expected.sha256) {
      result.changed.push({
        kind,
        path: expected.path,
        rows: expected.rows,
        expected: expected.sha256,
        actual: actual.sha256,
      })
    } else {
      result.unchanged.push(expected.path)
    }
  }
}

export function compare(baseline, candidate) {
  validateManifest(baseline, 'baseline manifest')
  const result = { changed: [], missing: [], unchanged: [] }
  compareItems('file', baseline.files, candidate.files, result)
  compareItems('tree', baseline.trees, candidate.trees, result)
  const affectedRows = [
    ...new Set([...result.changed, ...result.missing].flatMap(item => item.rows)),
  ].sort()
  const affectedRowSet = new Set(affectedRows)
  const fixturesToRegenerate = (baseline.fixtures || [])
    .filter(fixture => fixture.rows.some(row => affectedRowSet.has(row)))
    .map(fixture => fixture.path)
    .sort()
  return { ...result, affectedRows, fixturesToRegenerate }
}

function parseOptions(args) {
  const options = new Map()
  const known = new Set(['--candidate-source', '--candidate-manifest', '--output'])
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

export function createReport({ baseline, candidate }) {
  const diff = compare(baseline, candidate)
  const provenanceDirty = Boolean(candidate.sourceBaseline?.dirty || candidate.fixtureSource?.dirty)
  return {
    schemaVersion: 1,
    treeHashAlgorithm: TREE_HASH_ALGORITHM,
    baseline: baseline.sourceBaseline || baseline.fixtureSource,
    candidate: candidate.sourceBaseline ||
      candidate.fixtureSource ||
      candidate.runtimeRelease || { manifest: 'unknown' },
    status:
      diff.changed.length === 0 && diff.missing.length === 0 && !provenanceDirty
        ? 'identical'
        : 'drift',
    provenanceDirty,
    ...diff,
  }
}

export function run(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const candidateSource = options.get('--candidate-source')
  const candidateManifestPath = options.get('--candidate-manifest')
  const outputPath = options.get('--output')
  if (Boolean(candidateSource) === Boolean(candidateManifestPath)) {
    throw new Error('provide exactly one of --candidate-source or --candidate-manifest')
  }

  const baseline = readManifest(baselinePath)
  const candidate = candidateSource
    ? candidateFromSource(candidateSource, baseline)
    : readManifest(resolve(candidateManifestPath))
  const report = createReport({ baseline, candidate })
  if (!candidate.sourceBaseline && !candidate.fixtureSource && !candidate.runtimeRelease) {
    report.candidate = { manifest: candidateManifestPath }
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath) writeFileSync(resolve(outputPath), serialized)
  process.stdout.write(serialized)
  if (report.status === 'drift') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run()
  } catch (error) {
    console.error(`[qbit-pin-report] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
