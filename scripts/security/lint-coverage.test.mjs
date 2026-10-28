import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { trackedSourceFiles } from '../lint.mjs'

test('root lint includes tracked source, tests, build tooling, and configs', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const files = trackedSourceFiles(repoRoot)
  for (const file of [
    '.eslintrc.js',
    'apps/extension/build/webpack.pro.config.js',
    'apps/extension/gulpfile.js',
    'apps/extension/scripts/deterministic-package.js',
    'apps/extension/test/DiscoverTabScreen.test.tsx',
    'scripts/conformance/protocol-package-vectors.test.mjs',
    'packages/keyring-service/test/qbit-hd-keyring.test.ts',
    'packages/wallet-background/vitest.integration.config.ts',
    'playwright.config.ts',
    'scripts/security/dependency-policy.mjs',
  ]) {
    assert.ok(files.includes(file), `${file} must be included in deterministic root lint`)
  }
  assert.ok(files.every(file => !/(?:^|\/)(?:coverage|dist|lib|node_modules)\//.test(file)))
})
