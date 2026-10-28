#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnQbitRpcSync } from './rpc-timeout.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2).filter(arg => arg !== '--')

function option(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

const known = new Set(['--candidate-source', '--repository', '--commit', '--output-dir'])
for (const arg of args) {
  if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}`)
}

const candidateSource = option('--candidate-source')
const repository = option('--repository')
const commit = option('--commit')
const outputDir = option('--output-dir')
if (!candidateSource || !repository || !commit || !outputDir) {
  throw new Error('--candidate-source, --repository, --commit, and --output-dir are all required')
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('--repository must be a GitHub owner/repo slug')
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error('--commit must be a full 40-character lowercase commit ID')
}

const source = resolve(candidateSource)
const destination = resolve(outputDir)
mkdirSync(destination, { recursive: true })

function git(args) {
  const result = spawnQbitRpcSync('git', ['-C', source, ...args], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
      .filter(Boolean)
      .join('\n')
    throw new Error(`git ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

const sourceHead = git(['rev-parse', 'HEAD'])
if (sourceHead !== commit) {
  throw new Error(`candidate source HEAD ${sourceHead} does not match --commit ${commit}`)
}
if (git(['status', '--porcelain=v1', '--untracked-files=normal'])) {
  throw new Error('candidate source must be clean before fixture regeneration')
}
const origin = git(['config', '--get', 'remote.origin.url'])
const originSlug = origin.match(
  /github\.com(?::|\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i
)?.[1]
if (originSlug && originSlug.toLowerCase() !== repository.toLowerCase()) {
  throw new Error(`candidate source origin does not match --repository ${repository}`)
}

const fixtures = [
  {
    name: 'p2mr-sighash.json',
    script: 'scripts/conformance/qbit-js/scripts/gen-sighash-fixtures.py',
  },
  {
    name: 'p2mr-psbt.json',
    script: 'scripts/conformance/qbit-js/scripts/gen-psbt-fixtures.py',
  },
]

const summary = []
for (const fixture of fixtures) {
  const output = resolve(destination, fixture.name)
  // The generators check the checkout's commit and origin themselves, and
  // default to qbit Core v1.0.0 and Qbit-Org/qbit unless told otherwise.
  const generated = spawnQbitRpcSync(
    'python3',
    [
      '-I',
      resolve(root, fixture.script),
      '--qbit',
      source,
      '--out',
      output,
      '--repository',
      repository,
      '--commit',
      commit,
    ],
    { cwd: root, encoding: 'utf8' }
  )
  if (generated.error || generated.status !== 0) {
    const detail = [generated.error?.message, generated.stderr?.trim(), generated.stdout?.trim()]
      .filter(Boolean)
      .join('\n')
    throw new Error(`${fixture.script} failed${detail ? `:\n${detail}` : ''}`)
  }

  const parsed = JSON.parse(readFileSync(output, 'utf8'))
  parsed.source = {
    ...parsed.source,
    repository,
    commit,
    method: `regenerated from candidate source by ${fixture.script}`,
  }
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`
  writeFileSync(output, serialized)
  summary.push({
    path: output,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  })
}

process.stdout.write(`${JSON.stringify({ repository, commit, fixtures: summary }, null, 2)}\n`)
