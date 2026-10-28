#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GENERATOR_NAME,
  SOURCE_PATHS,
  buildOfflineFixture,
  serializeFixture,
  sha256Hex,
  validateReleaseEvidence,
} from './p2mr-offline-fixture-lib.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '../..')
const defaultCoverageMap = resolve(root, 'scripts/conformance/p2mr-v1-coverage.json')
const corePinPath = resolve(root, 'scripts/conformance/core-pin.json')

function parseOptions(args) {
  const known = new Set(['--source', '--core-provenance', '--coverage-map', '--output'])
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
  for (const required of ['--source', '--core-provenance', '--output']) {
    if (!options.has(required)) throw new Error(`${required} is required`)
  }
  return options
}

function parseJson(path, label) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return parsed
}

function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (!result.error && result.status === 0) return result.stdout
  const detail = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
    .filter(Boolean)
    .join('\n')
  throw new Error(`git ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
}

function assertInsideSource(source, path) {
  const child = realpathSync(path)
  const location = relative(source, child)
  if (location === '..' || location.startsWith(`..${sep}`) || location === '') {
    throw new Error(`source path escaped the checkout: ${path}`)
  }
  return child
}

function validateSource(source, evidence) {
  const expectedRemote = `https://github.com/${evidence.repository}.git`
  const remote = git(source, ['config', '--get', 'remote.origin.url']).trim()
  if (remote !== expectedRemote) {
    throw new Error(`source remote mismatch: expected ${expectedRemote}, got ${remote}`)
  }
  if (git(source, ['cat-file', '-t', `refs/tags/${evidence.tag}`]).trim() !== 'tag') {
    throw new Error(`${evidence.tag} must be an annotated tag`)
  }
  const target = git(source, ['rev-parse', `refs/tags/${evidence.tag}^{commit}`]).trim()
  if (target !== evidence.commit) {
    throw new Error(`release tag target mismatch: expected ${evidence.commit}, got ${target}`)
  }
  if (git(source, ['rev-parse', 'HEAD']).trim() !== evidence.commit) {
    throw new Error(`source HEAD must equal signed release target ${evidence.commit}`)
  }
  if (git(source, ['status', '--porcelain=v1', '--untracked-files=normal']).trim()) {
    throw new Error('release source checkout must be clean')
  }
}

function readSourceFile(source, path) {
  if (!Object.values(SOURCE_PATHS).includes(path)) {
    throw new Error(`unexpected Core source path ${path}`)
  }
  const absolute = resolve(source, path)
  assertInsideSource(source, absolute)
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Core source path must be a regular non-symlink file: ${path}`)
  }
  const treeEntry = git(source, ['ls-tree', '-z', 'HEAD', '--', path])
  const match = /^100644 blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(treeEntry)
  if (!match || match[2] !== path) {
    throw new Error(
      `Core source path is missing, has an unexpected mode, or is not a blob: ${path}`
    )
  }
  const bytes = readFileSync(absolute)
  const worktreeBlob = git(source, ['hash-object', '--', path]).trim()
  if (worktreeBlob !== match[1]) {
    throw new Error(`Core source worktree bytes do not match HEAD for ${path}`)
  }
  return {
    path,
    gitBlobOid: match[1],
    sha256: sha256Hex(bytes),
    bytes,
  }
}

function withoutBytes(sourceFile) {
  return {
    path: sourceFile.path,
    gitBlobOid: sourceFile.gitBlobOid,
    sha256: sourceFile.sha256,
  }
}

function readCorpora(files) {
  const byPath = new Map(files.map(file => [file.path, file]))
  const read = (path, label) => {
    try {
      return JSON.parse(byPath.get(path).bytes.toString('utf8'))
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8 JSON: ${error.message}`)
    }
  }
  return {
    manifest: read(SOURCE_PATHS.manifest, 'P2MR manifest'),
    commitments: read(SOURCE_PATHS.commitments, 'P2MR commitment corpus'),
    crossProfile: read(SOURCE_PATHS.crossProfile, 'P2MR cross-profile corpus'),
    witness: read(SOURCE_PATHS.witness, 'P2MR witness corpus'),
    boundaries: read(SOURCE_PATHS.boundaries, 'P2MR boundary corpus'),
    messageProof: read(SOURCE_PATHS.messageProof, 'P2MR message-proof corpus'),
  }
}

export function generate(options) {
  const source = realpathSync(resolve(options.get('--source')))
  const output = resolve(options.get('--output'))
  const coverageMapPath = resolve(options.get('--coverage-map') || defaultCoverageMap)
  const corePin = parseJson(corePinPath, 'Core pin manifest')
  const evidence = validateReleaseEvidence(
    parseJson(resolve(options.get('--core-provenance')), 'Core release provenance'),
    corePin.runtimeRelease
  )
  if (
    corePin.sourceBaseline?.repository !== evidence.repository ||
    corePin.sourceBaseline?.commit !== evidence.commit
  ) {
    throw new Error('Core source baseline must match the signed runtime release before extraction')
  }
  validateSource(source, evidence)

  const sourceFilesWithBytes = Object.values(SOURCE_PATHS).map(path => readSourceFile(source, path))
  const sourceFiles = sourceFilesWithBytes.map(withoutBytes)
  const corpora = readCorpora(sourceFilesWithBytes)
  const coverageMapBytes = readFileSync(coverageMapPath)
  const coverageMap = parseJson(coverageMapPath, 'P2MR coverage map')
  const coverageRelative = relative(root, coverageMapPath)
  if (coverageRelative !== 'scripts/conformance/p2mr-v1-coverage.json') {
    throw new Error('coverage map must be scripts/conformance/p2mr-v1-coverage.json')
  }
  const fixture = buildOfflineFixture({
    corpora,
    releaseEvidence: evidence,
    sourceFiles,
    coverageMap,
    coverageMapPath: coverageRelative,
    coverageMapSha256: sha256Hex(coverageMapBytes),
  })
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, serializeFixture(fixture))
  return fixture
}

export function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const fixture = generate(options)
  process.stdout.write(
    `${JSON.stringify(
      {
        generator: GENERATOR_NAME,
        release: fixture.provenance.release,
        output: resolve(options.get('--output')),
        fixtureDigest: fixture.provenance.fixtureDigest.value,
        caseCounts: {
          commitments: fixture.commitments.valid.length + fixture.commitments.invalid.length,
          crossProfile: fixture.crossProfile.vectors.length,
          witness: fixture.witness.length,
          controlBoundaries: fixture.controlBoundaries.length,
          futureLeafVersions: fixture.futureLeafVersions.length,
        },
      },
      null,
      2
    )}\n`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    main()
  } catch (error) {
    console.error(
      `[p2mr-offline-fixture] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  }
}
