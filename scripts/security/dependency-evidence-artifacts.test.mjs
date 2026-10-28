import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeGeneratedEvidence } from './dependency-evidence-artifacts.mjs'

function evidenceRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dependency-evidence-'))
  mkdirSync(join(root, 'docs/security'), { recursive: true })
  writeFileSync(join(root, 'docs/security/audit.json'), 'previous audit\n')
  writeFileSync(join(root, 'docs/security/inventory.json'), 'previous inventory\n')
  return root
}

test('generated evidence replaces both artifacts without leaving staging files', () => {
  const root = evidenceRoot()
  writeGeneratedEvidence(root, [
    { file: 'docs/security/audit.json', content: 'new audit\n' },
    { file: 'docs/security/inventory.json', content: 'new inventory\n' },
  ])
  assert.equal(readFileSync(join(root, 'docs/security/audit.json'), 'utf8'), 'new audit\n')
  assert.equal(readFileSync(join(root, 'docs/security/inventory.json'), 'utf8'), 'new inventory\n')
  assert.deepEqual(readdirSync(join(root, 'docs/security')).sort(), ['audit.json', 'inventory.json'])
})

test('a failing artifact leaves the previously written pair untouched', () => {
  const root = evidenceRoot()
  assert.throws(() =>
    writeGeneratedEvidence(root, [
      { file: 'docs/security/audit.json', content: 'new audit\n' },
      { file: 'docs/missing/inventory.json', content: 'new inventory\n' },
    ])
  )
  assert.equal(readFileSync(join(root, 'docs/security/audit.json'), 'utf8'), 'previous audit\n')
  assert.equal(
    readFileSync(join(root, 'docs/security/inventory.json'), 'utf8'),
    'previous inventory\n'
  )
  assert.equal(existsSync(join(root, 'docs/missing')), false)
  assert.deepEqual(readdirSync(join(root, 'docs/security')).sort(), ['audit.json', 'inventory.json'])
})

test('a failing replacement restores every artifact it already replaced', () => {
  const root = evidenceRoot()
  mkdirSync(join(root, 'docs/security/nested'))
  assert.throws(() =>
    writeGeneratedEvidence(root, [
      { file: 'docs/security/audit.json', content: 'new audit\n' },
      { file: 'docs/security/fresh.json', content: 'new fresh\n' },
      // Renaming a file over an existing directory fails after staging succeeded.
      { file: 'docs/security/nested', content: 'new inventory\n' },
    ])
  )
  assert.equal(readFileSync(join(root, 'docs/security/audit.json'), 'utf8'), 'previous audit\n')
  assert.equal(
    readFileSync(join(root, 'docs/security/inventory.json'), 'utf8'),
    'previous inventory\n'
  )
  assert.equal(existsSync(join(root, 'docs/security/fresh.json')), false)
  assert.deepEqual(readdirSync(join(root, 'docs/security')).sort(), [
    'audit.json',
    'inventory.json',
    'nested',
  ])
})
