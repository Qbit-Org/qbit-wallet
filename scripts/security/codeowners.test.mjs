import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const codeowners = readFileSync(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8')
const rules = new Map(
  codeowners
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [pattern, ...owners] = line.split(/\s+/)
      return [pattern, owners]
    })
)

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
    assert.deepEqual(rules.get(pattern), ['@Anatolie', '@RobertClarke'])
  }
})
