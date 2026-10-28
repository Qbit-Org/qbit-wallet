import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fallbackReachability,
  packageIdentityFromReference,
  resolvedPackageKey,
} from './dependency-evidence-identity.mjs'

test('resolved package identities ignore peer suffixes without conflating versions', () => {
  assert.deepEqual(packageIdentityFromReference('yaml@1.10.2'), {
    package: 'yaml',
    version: '1.10.2',
  })
  assert.deepEqual(packageIdentityFromReference('@scope/parser@2.8.1(peer@1.0.0)'), {
    package: '@scope/parser',
    version: '2.8.1',
  })
  assert.equal(resolvedPackageKey('yaml', '2.8.1(peer@1.0.0)'), resolvedPackageKey('yaml', '2.8.1'))
  assert.notEqual(resolvedPackageKey('yaml', '1.10.2'), resolvedPackageKey('yaml', '2.8.1'))
})

test('fallback reachability prioritizes exact delivery before closure metadata', () => {
  const yamlDevelopmentDeclaration = [{ delivery: 'development-quality-tooling' }]
  const directByPackage = new Map([['yaml', yamlDevelopmentDeclaration]])
  const directByResolvedPackage = new Map([
    [resolvedPackageKey('yaml', '2.8.1'), yamlDevelopmentDeclaration],
  ])
  const productionClosure = new Set(['production-closure'])
  const closuresByPackage = new Map([['yaml', productionClosure]])
  const closuresByResolvedPackage = new Map([
    [resolvedPackageKey('yaml', '1.10.2'), productionClosure],
    [resolvedPackageKey('yaml', '2.8.1'), productionClosure],
    [resolvedPackageKey('uuid', '11.1.0'), new Set(['development-only'])],
  ])

  const lookup = (packageName, version) =>
    fallbackReachability({
      packageName,
      version,
      directByPackage,
      directByResolvedPackage,
      closuresByPackage: new Map([
        ...closuresByPackage,
        ['uuid', productionClosure],
      ]),
      closuresByResolvedPackage,
    })

  assert.equal(lookup('yaml', '1.10.2'), 'reachable')
  assert.equal(lookup('yaml', '2.8.1'), 'development-tooling-path')
  assert.equal(lookup('yaml', 'missing-exact-version'), 'reachable')
  assert.equal(lookup('yaml', null), 'reachable')
  assert.equal(lookup('uuid', '11.1.0'), 'development-tooling-path')
})

test('exception path coverage requires an explicit path list', async () => {
  const { exceptionCoversPath } = await import('./dependency-evidence-identity.mjs')
  const path = 'apps/extension > loader@1.0.0 > vulnerable@2.0.0'
  assert.equal(exceptionCoversPath({ paths: [path] }, path), true)
  assert.equal(exceptionCoversPath({ paths: ['other > vulnerable@2.0.0'] }, path), false)
  assert.equal(exceptionCoversPath({ paths: path }, path), false)
  assert.equal(exceptionCoversPath({}, path), false)
  assert.equal(exceptionCoversPath(undefined, path), false)
})
