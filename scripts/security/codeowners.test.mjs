import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// GitHub ignores owner order and the case of handles.
const normalizeOwners = owners => owners.map(owner => owner.toLowerCase()).sort()
const securityOwners = normalizeOwners(['@Anatolie', '@kiwidream', '@djh58', '@RobertClarke'])
const codeowners = readFileSync(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8')
const orderedRules = codeowners
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    const [pattern, ...owners] = line.split(/\s+/)
    return [pattern, normalizeOwners(owners)]
  })
const rules = new Map(orderedRules)
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const globs = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' }

// CODEOWNERS patterns follow gitignore, except that `dir/*` skips nested files.
function toRegExp(pattern) {
  const anchored = pattern.slice(0, -1).includes('/')
  const body = pattern
    .replace(/^\/|\/$/g, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, glob => globs[glob])
  const end = pattern.endsWith('/') ? '/' : pattern.endsWith('/*') ? '$' : '(?:/|$)'
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${end}`)
}

test('CODEOWNERS covers every security release surface', () => {
  const requiredPatterns = [
    '/.github/CODEOWNERS',
    '/.github/workflows/',
    '/packages/keyring-service/',
    '/scripts/security/sdk-package-pins.json',
    '/packages/wallet-core/',
    '/packages/wallet-background/src/controllers/wallet.ts',
    '/packages/wallet-background/src/controllers/provider/',
    '/packages/approval-service/',
    '/packages/permission-service/',
    '/apps/extension/src/background/runtime/',
    '/apps/extension/build/',
    '/apps/extension/scripts/',
    '/package.json',
    '**/package.json',
    '/.npmrc',
    '/patches/',
    '/.changeset/',
    '/pnpm-lock.yaml',
    '/scripts/security/',
    '/scripts/conformance/',
    '/docker/regtest/',
  ]
  for (const pattern of requiredPatterns) {
    assert.ok(rules.has(pattern), `missing CODEOWNERS rule for ${pattern}`)
    assert.deepEqual(rules.get(pattern), securityOwners)
  }
})

// A rule that matches nothing protects nothing, such as one left behind when
// the file it names is renamed.
test('every CODEOWNERS rule matches a tracked file', () => {
  for (const [pattern] of orderedRules) {
    const regex = toRegExp(pattern)
    assert.ok(
      trackedFiles.some(path => regex.test(path)),
      `${pattern} matches no tracked file`
    )
  }
})

// GitHub applies the last matching rule, so a rule below the security rules
// would take over the files they cover. Any rule except the `*` default that
// lists every security owner counts as a security rule, so a security rule
// with an extra owner fails here instead of dropping out of the check.
test('no later CODEOWNERS rule takes over a security file', () => {
  const matchers = orderedRules.map(([pattern, owners]) => ({
    pattern,
    owners,
    regex: toRegExp(pattern),
  }))
  const isSecurityRule = rule =>
    rule.pattern !== '*' && securityOwners.every(owner => rule.owners.includes(owner))
  for (const path of trackedFiles) {
    const matching = matchers.filter(rule => rule.regex.test(path))
    if (matching.some(isSecurityRule)) {
      assert.deepEqual(matching.at(-1).owners, securityOwners, `a later rule takes over ${path}`)
    }
  }
})

// The security rules can only narrow the `*` default if it comes first.
test('the `*` default stays the first CODEOWNERS rule', () => {
  const patterns = orderedRules.map(([pattern]) => pattern)
  assert.equal(patterns.lastIndexOf('*'), 0, 'keep one `*` rule, at the top of CODEOWNERS')
})
