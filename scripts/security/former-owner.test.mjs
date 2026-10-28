import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// The repository's former company name and its email domain. Built from parts
// so that this file does not match them itself.
const formerOwnerPatterns = [
  new RegExp(['swap', '[ _-]?', 'labs'].join(''), 'i'),
  new RegExp(['@swap', 'labs', '\\.xyz'].join(''), 'i'),
]

function trackedFiles() {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
    .filter(path => {
      const absolutePath = resolve(repoRoot, path)
      return existsSync(absolutePath) && lstatSync(absolutePath).isFile()
    })
}

function namesFormerOwner(value) {
  return formerOwnerPatterns.some(pattern => pattern.test(value))
}

test('tracked file names and contents do not name the former owner or its email domain', () => {
  const violations = []

  for (const path of trackedFiles()) {
    if (namesFormerOwner(path)) violations.push(path)

    // Binary files are read too: latin1 keeps every ASCII byte as it is.
    const lines = readFileSync(resolve(repoRoot, path), 'latin1').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (namesFormerOwner(line)) violations.push(`${path}:${index + 1}: ${line.trim()}`)
    })
  }

  assert.deepEqual(violations, [])
})
