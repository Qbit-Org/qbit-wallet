import assert from 'node:assert/strict'
import test from 'node:test'

import YAML from 'yaml'

import {
  auditPathDirectDependency,
  fallbackReachability,
  lockfileProductionPaths,
  lockfileSnapshotClosures,
  packageIdentityFromReference,
  resolvedPackageKey,
  snapshotKeyFromReference,
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

test('snapshot references resolve versions, peer suffixes, aliases, and links', () => {
  assert.equal(snapshotKeyFromReference('yaml', '2.8.1'), 'yaml@2.8.1')
  assert.equal(
    snapshotKeyFromReference('@scope/parser', '2.8.1(peer@1.0.0)'),
    '@scope/parser@2.8.1(peer@1.0.0)'
  )
  assert.equal(snapshotKeyFromReference('alias', 'target@1.0.0'), 'target@1.0.0')
  assert.equal(
    snapshotKeyFromReference('alias', '@scope/target@1.0.0(peer@2.0.0)'),
    '@scope/target@1.0.0(peer@2.0.0)'
  )
  assert.equal(
    snapshotKeyFromReference('tool', 'https://registry.example/tool@1.0.0.tgz'),
    'tool@https://registry.example/tool@1.0.0.tgz'
  )
  assert.equal(snapshotKeyFromReference('@qbit/wallet-core', 'link:../wallet-core'), null)
})

test('snapshot closures follow importer sections through the dependency graph', () => {
  const lockfile = YAML.parse(`lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      lint-tool:
        specifier: 1.0.0
        version: 1.0.0
  packages/app:
    dependencies:
      runtime:
        specifier: ^2.0.0
        version: 2.0.0(peer@1.0.0)
      '@qbit/shared':
        specifier: workspace:*
        version: link:../shared
    optionalDependencies:
      native:
        specifier: 3.0.0
        version: 3.0.0
packages: {}
snapshots:
  lint-tool@1.0.0:
    dependencies:
      shared-helper: 1.0.0
      dev-helper: 1.0.0
  runtime@2.0.0(peer@1.0.0):
    dependencies:
      peer: 1.0.0
      aliased: real-helper@4.0.0
  native@3.0.0:
    optionalDependencies:
      shared-helper: 1.0.0
  peer@1.0.0: {}
  real-helper@4.0.0: {}
  shared-helper@1.0.0: {}
  dev-helper@1.0.0: {}
`)
  assert.deepEqual(Object.fromEntries(lockfileSnapshotClosures(lockfile)), {
    'lint-tool@1.0.0': 'development-only',
    'runtime@2.0.0(peer@1.0.0)': 'production-closure',
    'native@3.0.0': 'production-closure',
    'peer@1.0.0': 'production-closure',
    'real-helper@4.0.0': 'production-closure',
    'shared-helper@1.0.0': 'production-closure',
    'dev-helper@1.0.0': 'development-only',
  })

  const orphan = structuredClone(lockfile)
  orphan.snapshots['orphan@1.0.0'] = {}
  assert.throws(() => lockfileSnapshotClosures(orphan), /orphan@1\.0\.0 is not reachable/)

  const missing = structuredClone(lockfile)
  delete missing.snapshots['peer@1.0.0']
  assert.throws(
    () => lockfileSnapshotClosures(missing),
    /runtime@2\.0\.0\(peer@1\.0\.0\) names snapshot peer@1\.0\.0, which pnpm-lock\.yaml does not contain/
  )
})

test('pnpm 11 audit paths resolve their workspace and direct dependency from the lockfile', () => {
  const importers = {
    '.': {
      devDependencies: { lerna: { specifier: '^9.0.7', version: '9.0.7(@types/node@20.8.0)' } },
    },
    'apps/extension': {
      dependencies: {
        webpack: { specifier: '5.109.2', version: '5.109.2(esbuild@0.25.12)' },
        '@qbit/wallet-core': {
          specifier: 'workspace:*',
          version: 'link:../../packages/wallet-core',
        },
      },
    },
  }
  assert.deepEqual(
    auditPathDirectDependency('apps__extension>webpack>schema-utils>ajv>fast-uri', importers),
    { workspace: 'apps/extension', directPackage: 'webpack', directVersion: '5.109.2' }
  )
  assert.deepEqual(auditPathDirectDependency('.>lerna>minimatch', importers), {
    workspace: '.',
    directPackage: 'lerna',
    directVersion: '9.0.7',
  })
  assert.deepEqual(
    auditPathDirectDependency('apps__extension>@qbit/wallet-core>bn.js', importers),
    {
      workspace: 'apps/extension',
      directPackage: '@qbit/wallet-core',
      directVersion: 'link:../../packages/wallet-core',
    }
  )
  assert.deepEqual(auditPathDirectDependency('apps__extension>undeclared>x', importers), {
    workspace: 'apps/extension',
    directPackage: 'undeclared',
    directVersion: null,
  })
  assert.throws(
    () => auditPathDirectDependency('apps/extension > webpack@5.109.2 > ajv@8.17.1', importers),
    /does not start with a pnpm-lock\.yaml importer/
  )
})

test('production paths follow workspace links from the importers that ship them', () => {
  const lockfile = YAML.parse(`lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      lint-tool:
        specifier: 1.0.0
        version: 1.0.0
  apps/extension:
    dependencies:
      '@qbit/keyring':
        specifier: workspace:*
        version: link:../../packages/keyring
      webpack:
        specifier: 5.0.0
        version: 5.0.0
  packages/keyring:
    dependencies:
      bitcore-lib:
        specifier: 10.0.0
        version: 10.0.0
    devDependencies:
      vitest:
        specifier: 3.0.0
        version: 3.0.0
  packages/unlinked:
    optionalDependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0(peer@1.0.0)
packages: {}
snapshots:
  lint-tool@1.0.0:
    dependencies:
      elliptic: 6.5.0
  webpack@5.0.0:
    dependencies:
      ajv: 8.0.0
  bitcore-lib@10.0.0:
    dependencies:
      elliptic: 6.6.1
  vitest@3.0.0: {}
  ajv@8.0.0: {}
  elliptic@6.5.0: {}
  elliptic@6.6.1: {}
  native@1.0.0(peer@1.0.0):
    dependencies:
      peer: 1.0.0
  peer@1.0.0: {}
`)
  assert.deepEqual(Object.fromEntries(lockfileProductionPaths(lockfile)), {
    'webpack@5.0.0': 'apps/extension > webpack@5.0.0',
    'native@1.0.0': 'packages/unlinked > native@1.0.0',
    'ajv@8.0.0': 'apps/extension > webpack@5.0.0 > ajv@8.0.0',
    'bitcore-lib@10.0.0': 'apps/extension > @qbit/keyring > bitcore-lib@10.0.0',
    'peer@1.0.0': 'packages/unlinked > native@1.0.0 > peer@1.0.0',
    'elliptic@6.6.1': 'apps/extension > @qbit/keyring > bitcore-lib@10.0.0 > elliptic@6.6.1',
  })

  // The production paths cover exactly the production closure.
  const production = new Set(
    [...lockfileSnapshotClosures(lockfile)]
      .filter(([, closure]) => closure === 'production-closure')
      .map(([key]) => {
        const identity = packageIdentityFromReference(key)
        return `${identity.package}@${identity.version}`
      })
  )
  assert.deepEqual(new Set(lockfileProductionPaths(lockfile).keys()), production)

  // Importers that link only to each other still start a walk.
  const cycle = structuredClone(lockfile)
  cycle.importers['packages/keyring'].dependencies['@qbit/extension'] = {
    specifier: 'workspace:*',
    version: 'link:../../apps/extension',
  }
  assert.equal(
    lockfileProductionPaths(cycle).get('ajv@8.0.0'),
    'apps/extension > webpack@5.0.0 > ajv@8.0.0'
  )
})
