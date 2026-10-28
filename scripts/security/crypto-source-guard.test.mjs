import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const productionRoots = [
  'packages/keyring-service/src/',
  'packages/wallet-background/src/',
  'packages/wallet-core/src/',
  'apps/extension/src/background/',
]
const productionFiles = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js', '*.mjs'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(file => productionRoots.some(root => file.startsWith(root)))

test('wallet signing does not route through transitive elliptic or Bitcore ECDSA', () => {
  const violations = []
  for (const file of productionFiles) {
    const source = readFileSync(join(repoRoot, file), 'utf8')
    if (/(?:from\s+|require\()['"]elliptic['"]/.test(source)) {
      violations.push(`${file}: direct elliptic import`)
    }
    if (/(?:from\s+|require\()['"]browser-passworder['"]/.test(source)) {
      violations.push(`${file}: earlier 10,000-round vault encryptor import`)
    }
    if (
      /\bbitcore\.(?:Message|Transaction|crypto\.ECDSA)\b/.test(source) ||
      /\bECDSA\.sign\s*\(/.test(source)
    ) {
      violations.push(`${file}: Bitcore/elliptic signing primitive`)
    }
  }
  assert.deepEqual(violations, [])

  const simpleKeyring = readFileSync(
    join(repoRoot, 'packages/keyring-service/src/keyrings/simple-keyring.ts'),
    'utf8'
  )
  assert.match(simpleKeyring, /eccManager\.eccPair\.fromPrivateKey/)
  assert.match(simpleKeyring, /signMessageOfDeterministicECDSA/)
})

test('production log calls do not directly interpolate custody secrets', () => {
  const violations = []
  const secretName = /\b(?:password|mnemonic|privateKey|secretKey|preMnemonics|vault)\b/i
  for (const file of productionFiles) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      const withoutQuotedMessages = line
        .replace(/'(?:\\.|[^'\\])*'/g, '')
        .replace(/"(?:\\.|[^"\\])*"/g, '')
        .replace(/`(?:\\.|[^`\\])*`/g, '')
      if (
        /(?:console|logger|log)\.(?:debug|info|log|warn|error)\s*\(/.test(line) &&
        (secretName.test(withoutQuotedMessages) ||
          /\$\{[^}]*(?:password|mnemonic|privateKey|secretKey|preMnemonics|vault)\b/i.test(
            line
          ))
      ) {
        violations.push(`${file}:${index + 1}`)
      }
    }
  }
  assert.deepEqual(violations, [])
})
