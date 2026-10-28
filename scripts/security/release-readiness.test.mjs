import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  anonymousGitEnvironment,
  auditExecutableSources,
  auditExpectedOrigin,
  auditRemoteRecords,
  auditSubmoduleFetchability,
  buildReadinessReport,
  collectConfiguredRemotes,
  collectExecutableSourceRepositories,
  collectSubmoduleDeclarations,
  initializedSubmoduleCheckouts,
  mainProtectionHumanGate,
  mapMainProtection,
  mapMainRulesets,
  mergeMainProtection,
  parseGitHubRepository,
  probeAnonymousFetch,
  readinessMessages,
  readSubmoduleDeclarations,
  redactRemoteUrl,
  submoduleUrlProblem,
} from './release-readiness.mjs'

function writeFixtureFile(repoRoot, relativePath, contents) {
  const path = join(repoRoot, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

test('normalizes supported GitHub remote forms without exposing credentials', () => {
  assert.equal(
    parseGitHubRepository('https://github.com/Qbit-Org/qbit-wallet.git'),
    'Qbit-Org/qbit-wallet'
  )
  assert.equal(
    parseGitHubRepository('https://token@github.com/Qbit-Org/qbit-wallet.git'),
    'Qbit-Org/qbit-wallet'
  )
  assert.equal(
    parseGitHubRepository('git@github.com:Qbit-Org/qbit-wallet.git'),
    'Qbit-Org/qbit-wallet'
  )
  assert.equal(parseGitHubRepository('https://example.invalid/repository.git'), null)
  assert.equal(
    redactRemoteUrl('https://token@github.com/Qbit-Org/qbit-wallet.git'),
    'https://github.com/Qbit-Org/qbit-wallet.git'
  )
  assert.equal(
    redactRemoteUrl('https://token@example.invalid/repository.git'),
    'https://[redacted]@example.invalid/repository.git'
  )
})

test('never redacts a remote into a Qbit-Org repository it does not target', () => {
  // The ownership audits parse the redacted URL, so a `@` after the host must
  // not let redaction swap in a different host.
  for (const url of [
    'https://evil.example/x@github.com/Qbit-Org/qbit-wallet.git',
    'https://evil.example/?q=@github.com/Qbit-Org/qbit-wallet.git',
    'https://user:pa/ss@github.com/Qbit-Org/qbit-wallet.git',
  ]) {
    const records = ['fetch', 'push'].map(direction => ({
      scope: '.',
      remote: 'origin',
      direction,
      url: redactRemoteUrl(url),
    }))
    assert.notEqual(parseGitHubRepository(records[0].url), 'Qbit-Org/qbit-wallet', url)
    assert.ok(auditRemoteRecords(records).errors.length > 0, url)
    assert.ok(auditExpectedOrigin(records).length > 0, url)
  }
})

test('rejects a non-Qbit-Org upstream remote', () => {
  const records = [
    {
      scope: '.',
      remote: 'origin',
      direction: 'fetch',
      url: 'https://github.com/Qbit-Org/qbit-wallet.git',
    },
    {
      scope: '.',
      remote: 'origin',
      direction: 'push',
      url: 'https://github.com/Qbit-Org/qbit-wallet.git',
    },
    {
      scope: '.',
      remote: 'upstream',
      direction: 'fetch',
      url: 'git@github.com:untrusted/qbit-wallet.git',
    },
  ]
  const audit = auditRemoteRecords(records)
  assert.equal(audit.errors.length, 1)
  assert.match(audit.errors[0], /upstream.*untrusted\/qbit-wallet/)
  assert.deepEqual(auditExpectedOrigin(records), [])
})

test('requires both root origin directions to target Qbit-Org/qbit-wallet', () => {
  const records = [
    {
      scope: '.',
      remote: 'origin',
      direction: 'fetch',
      url: 'https://github.com/Qbit-Org/different.git',
    },
  ]
  assert.deepEqual(auditExpectedOrigin(records), [
    'root origin is missing a push URL',
    'root origin fetch must target Qbit-Org/qbit-wallet',
  ])
})

test('allows only the exact public Core and electrs repositories as executable sources', () => {
  const safe = [
    { source: 'core', repository: 'Qbit-Org/qbit' },
    { source: 'electrs', repository: 'Qbit-Org/qbit-electrs' },
    { source: 'core-case', repository: 'qbit-org/QBIT' },
  ]
  assert.equal(auditExecutableSources(safe).status, 'pass')

  const external = [
    { source: 'private-core', repository: 'example-org/qbit' },
    { source: 'private-electrs', repository: 'example-org/electrs-qbit' },
    { source: 'other-org-repo', repository: 'Qbit-Org/qbit-mining-bootstrap' },
    { source: 'prefix-lookalike', repository: 'Qbit-Org/qbit-electrs-test' },
    { source: 'suffix', repository: 'Qbit-Org/qbit.git' },
    { source: 'other-owner', repository: 'Qbit-Org2/qbit' },
  ]
  const audit = auditExecutableSources([...safe, ...external])
  assert.equal(audit.status, 'human-gate')
  assert.deepEqual(audit.external, external)
})

test('reports safe workflow and Compose fallbacks with dynamic overrides as human gates', t => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'qbit-release-readiness-'))
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))

  writeFixtureFile(
    repoRoot,
    'docker/regtest/qbitd-release.Dockerfile',
    'ARG QBIT_REPO=Qbit-Org/qbit\n'
  )
  writeFixtureFile(
    repoRoot,
    'docker/regtest/electrs-qbit-source.Dockerfile',
    'ARG ELECTRS_QBIT_REPO=Qbit-Org/qbit-electrs\n'
  )
  writeFixtureFile(
    repoRoot,
    '.github/workflows/build-regtest-images.yml',
    'env:\n  QBIT_REPO: Qbit-Org/qbit\n'
  )
  writeFixtureFile(
    repoRoot,
    '.github/workflows/qbit-conformance.yml',
    "env:\n  QBIT_REPO: ${{ vars.QBIT_REPO || 'Qbit-Org/qbit' }}\n"
  )
  writeFixtureFile(
    repoRoot,
    'docker-compose.regtest.yml',
    [
      'services:',
      '  qbitd:',
      '    build:',
      '      args:',
      '        QBIT_REPO: ${QBIT_REPO:-Qbit-Org/qbit}',
      '  electrs-qbit:',
      '    build:',
      '      args:',
      '        ELECTRS_QBIT_REPO: ${ELECTRS_QBIT_REPO:-Qbit-Org/qbit-electrs}',
      '',
    ].join('\n')
  )
  execFileSync('git', ['init', '-q'], { cwd: repoRoot })
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/Qbit-Org/qbit-wallet.git'],
    { cwd: repoRoot }
  )

  const workflowSources = collectExecutableSourceRepositories(repoRoot).filter(source =>
    source.source.startsWith('.github/workflows/')
  )
  assert.deepEqual(workflowSources, [
    {
      source: '.github/workflows/build-regtest-images.yml:2',
      repository: 'Qbit-Org/qbit',
    },
    {
      source: '.github/workflows/qbit-conformance.yml:2',
      repository: 'Qbit-Org/qbit',
      dynamicSelectors: ['vars.QBIT_REPO'],
    },
  ])
  const composeSources = collectExecutableSourceRepositories(repoRoot).filter(source =>
    source.source.startsWith('docker-compose.regtest.yml:')
  )
  assert.deepEqual(composeSources, [
    {
      source: 'docker-compose.regtest.yml:5',
      repository: 'Qbit-Org/qbit',
      dynamicSelectors: ['env.QBIT_REPO'],
    },
    {
      source: 'docker-compose.regtest.yml:9',
      repository: 'Qbit-Org/qbit-electrs',
      dynamicSelectors: ['env.ELECTRS_QBIT_REPO'],
    },
  ])
  assert.equal(auditExecutableSources([workflowSources[0]]).status, 'pass')

  const report = buildReadinessReport(repoRoot, { offline: true })
  assert.deepEqual(report.submoduleFetchability.submodules, [])
  assert.equal(report.submoduleFetchability.status, 'pass')
  assert.deepEqual(report.executableSources.external, [])
  assert.deepEqual(report.executableSources.dynamic, [workflowSources[1], ...composeSources])
  assert.ok(
    report.humanGates.includes(
      '3 executable source reference(s) use owner-selectable repository variable(s): env.ELECTRS_QBIT_REPO, env.QBIT_REPO, vars.QBIT_REPO'
    )
  )
  assert.equal(report.ready, false)

  writeFixtureFile(
    repoRoot,
    'docker/regtest/qbitd-release.Dockerfile',
    'ARG QBIT_REPO=example-org/qbit\n'
  )
  const privateReport = buildReadinessReport(repoRoot, { offline: true })
  assert.deepEqual(privateReport.executableSources.external, [
    { source: 'docker/regtest/qbitd-release.Dockerfile:1', repository: 'example-org/qbit' },
  ])
  assert.ok(
    privateReport.humanGates.includes(
      '1 executable source reference(s) target a repository outside the allowlist (Qbit-Org/qbit, Qbit-Org/qbit-electrs)'
    )
  )
})

test('fails closed for empty branch protection sections', () => {
  assert.deepEqual(
    mapMainProtection({
      required_pull_request_reviews: {},
      required_status_checks: {},
      enforce_admins: { enabled: true },
    }),
    {
      status: 'present',
      requiredPullRequestReviews: false,
      requiredStatusChecks: false,
      enforceAdmins: true,
      requiredCodeOwnerReviews: false,
    }
  )

  assert.equal(
    mapMainProtection({
      required_pull_request_reviews: { required_approving_review_count: 1 },
      required_status_checks: {
        checks: [{ context: ' ' }, {}],
        contexts: [''],
      },
    }).requiredStatusChecks,
    false
  )
})

test('requires a positive safe approving review count', () => {
  for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(
      mapMainProtection({
        required_pull_request_reviews: {
          required_approving_review_count: count,
          require_code_owner_reviews: true,
        },
        required_status_checks: { contexts: ['build'] },
      }).requiredPullRequestReviews,
      false
    )
  }
})

test('accepts positive effective review and status-check settings', () => {
  for (const requiredStatusChecks of [
    { checks: [{ context: 'build', app_id: null }], contexts: [] },
    { checks: [], contexts: ['lint'] },
  ]) {
    assert.deepEqual(
      mapMainProtection({
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          require_code_owner_reviews: true,
        },
        required_status_checks: requiredStatusChecks,
        enforce_admins: { enabled: true },
      }),
      {
        status: 'present',
        requiredPullRequestReviews: true,
        requiredStatusChecks: true,
        enforceAdmins: true,
        requiredCodeOwnerReviews: true,
      }
    )
  }
})

test('keeps the branch protection human gate until every AR-03 setting is enabled', () => {
  const completeProtection = {
    status: 'present',
    requiredPullRequestReviews: true,
    requiredStatusChecks: true,
    enforceAdmins: true,
    requiredCodeOwnerReviews: true,
  }
  const requiredSettings = [
    ['requiredPullRequestReviews', /required pull request reviews/],
    ['requiredStatusChecks', /required status checks/],
    ['enforceAdmins', /admin enforcement/],
    ['requiredCodeOwnerReviews', /required CODEOWNERS review/],
  ]

  for (const [setting, expectedGate] of requiredSettings) {
    assert.match(mainProtectionHumanGate({ ...completeProtection, [setting]: false }), expectedGate)
  }

  assert.equal(mainProtectionHumanGate(completeProtection), null)
})

function rulesetRules(rulesetId, { codeOwners = false, reviewCount = 1, checks = ['Typecheck, test, and build'] } = {}) {
  return [
    { type: 'deletion', ruleset_id: rulesetId, parameters: null },
    {
      type: 'pull_request',
      ruleset_id: rulesetId,
      parameters: { required_approving_review_count: reviewCount, require_code_owner_review: codeOwners },
    },
    {
      type: 'required_status_checks',
      ruleset_id: rulesetId,
      parameters: { required_status_checks: checks.map(context => ({ context })) },
    },
  ]
}

test('reads main protection from repository rulesets', () => {
  assert.deepEqual(mapMainRulesets([]), { status: 'missing' })

  const bypassable = mapMainRulesets(rulesetRules(7), {
    7: { bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] },
  })
  assert.deepEqual(bypassable, {
    status: 'present',
    source: 'ruleset',
    rulesetIds: [7],
    requiredPullRequestReviews: true,
    requiredStatusChecks: true,
    enforceAdmins: false,
    requiredCodeOwnerReviews: false,
    adminEnforcedSettings: {
      requiredPullRequestReviews: false,
      requiredStatusChecks: false,
      requiredCodeOwnerReviews: false,
    },
  })
  assert.equal(
    mainProtectionHumanGate(bypassable),
    'main branch protection is missing admin enforcement, required CODEOWNERS review'
  )

  const complete = mapMainRulesets(rulesetRules(7, { codeOwners: true }), { 7: { bypass_actors: [] } })
  assert.equal(complete.enforceAdmins, true)
  assert.equal(mainProtectionHumanGate(complete), null)
})

test('fails closed for unreadable rulesets and empty ruleset parameters', () => {
  const unreadable = mapMainRulesets(rulesetRules(7, { codeOwners: true }))
  assert.equal(unreadable.enforceAdmins, false)

  // Ruleset 7 binds admins but supplies only reviews; the status checks come
  // only from ruleset 8, whose bypass list cannot be read.
  const partlyUnreadable = mapMainRulesets(
    [...rulesetRules(7, { codeOwners: true, checks: [] }), ...rulesetRules(8)],
    { 7: { bypass_actors: [] } }
  )
  assert.equal(partlyUnreadable.requiredStatusChecks, true)
  assert.equal(partlyUnreadable.adminEnforcedSettings.requiredStatusChecks, false)
  assert.equal(partlyUnreadable.enforceAdmins, false)

  // A setting supplied by a non-bypassable ruleset binds admins even when a
  // second, bypassable ruleset supplies it too.
  const overlapping = mapMainRulesets(
    [...rulesetRules(7, { codeOwners: true }), ...rulesetRules(8)],
    { 7: { bypass_actors: [] } }
  )
  assert.equal(overlapping.enforceAdmins, true)

  const empty = mapMainRulesets(rulesetRules(7, { reviewCount: 0, checks: [' '] }), {
    7: { bypass_actors: [] },
  })
  assert.equal(empty.requiredPullRequestReviews, false)
  assert.equal(empty.requiredStatusChecks, false)

  const deletionOnly = mapMainRulesets([{ type: 'deletion', ruleset_id: 7, parameters: null }], {
    7: { bypass_actors: [] },
  })
  assert.equal(deletionOnly.requiredPullRequestReviews, false)
  assert.equal(deletionOnly.enforceAdmins, false)
})

function classicProtection({ reviews = true, checks = true, admins = true, codeOwners = false } = {}) {
  return mapMainProtection({
    required_pull_request_reviews: reviews
      ? { required_approving_review_count: 1, require_code_owner_reviews: codeOwners }
      : undefined,
    required_status_checks: checks ? { contexts: ['Typecheck, test, and build'] } : undefined,
    enforce_admins: { enabled: admins },
  })
}

test('merges classic branch protection with rulesets', () => {
  // CODEOWNERS review supplied only by a ruleset still counts when classic
  // protection is also present.
  const rulesetCodeOwners = mapMainRulesets(rulesetRules(7, { codeOwners: true }), {
    7: { bypass_actors: [] },
  })
  const merged = mergeMainProtection(classicProtection(), rulesetCodeOwners)
  assert.deepEqual(merged, {
    status: 'present',
    source: 'classic+ruleset',
    rulesetIds: [7],
    requiredPullRequestReviews: true,
    requiredStatusChecks: true,
    enforceAdmins: true,
    requiredCodeOwnerReviews: true,
  })
  assert.equal(mainProtectionHumanGate(merged), null)

  // A non-bypassable ruleset binds admins to settings classic protection
  // leaves bypassable.
  assert.equal(
    mergeMainProtection(classicProtection({ admins: false }), rulesetCodeOwners).enforceAdmins,
    true
  )

  // CODEOWNERS review that only a bypassable ruleset supplies is not admin
  // enforced, even though classic protection enforces admins for the rest.
  const bypassableCodeOwners = mapMainRulesets(rulesetRules(7, { codeOwners: true }), {
    7: { bypass_actors: [{ actor_type: 'OrganizationAdmin', actor_id: null, bypass_mode: 'always' }] },
  })
  const partlyBypassable = mergeMainProtection(classicProtection(), bypassableCodeOwners)
  assert.equal(partlyBypassable.requiredCodeOwnerReviews, true)
  assert.equal(partlyBypassable.enforceAdmins, false)
})

test('merged protection is missing or unknown only when no source supplies settings', () => {
  assert.deepEqual(mergeMainProtection({ status: 'missing' }, { status: 'missing' }), {
    status: 'missing',
  })
  assert.deepEqual(
    mergeMainProtection({ status: 'missing' }, { status: 'unknown', error: 'HTTP 403' }),
    { status: 'unknown', error: 'HTTP 403' }
  )

  const classicOnly = mergeMainProtection(
    classicProtection({ codeOwners: true }),
    { status: 'unknown', error: 'HTTP 403' }
  )
  assert.equal(classicOnly.source, 'classic')
  assert.equal(classicOnly.partialError, 'HTTP 403')
  assert.equal(mainProtectionHumanGate(classicOnly), null)

  const rulesetOnly = mergeMainProtection(
    { status: 'missing' },
    mapMainRulesets(rulesetRules(7), { 7: { bypass_actors: [] } })
  )
  assert.equal(rulesetOnly.source, 'ruleset')
  assert.equal(rulesetOnly.enforceAdmins, true)
})

test('only an absolute https URL without credentials qualifies for the anonymous probe', () => {
  assert.equal(submoduleUrlProblem('https://github.com/Qbit-Org/qbit-js.git'), null)
  const rejected = [
    [undefined, /missing URL/],
    [null, /missing URL/],
    ['', /missing URL/],
    ['   ', /missing URL/],
    ['git@github.com:example-org/qbit-js.git', /scp-style SSH URL requires credentials/],
    ['ssh://git@github.com/example-org/qbit-js.git', /SSH URL requires credentials/],
    ['git+ssh://github.com/example-org/qbit-js.git', /SSH URL requires credentials/],
    ['https://x-access-token:secret@github.com/example-org/qbit-js.git', /embeds credentials/],
    ['https://token@github.com/example-org/qbit-js.git', /embeds credentials/],
    ['http://github.com/example-org/qbit-js.git', /http: URL is not anonymous HTTPS/],
    ['git://github.com/example-org/qbit-js.git', /git: URL is not anonymous HTTPS/],
    ['file:///srv/git/qbit-js.git', /file: URL is not anonymous HTTPS/],
    ['../qbit-js.git', /relative URL; use an absolute https URL/],
    ['./qbit-js.git', /relative URL/],
    ['external/qbit-js', /not an absolute URL/],
    ['https://github.com/example-org/qbit-js.git?token=1', /malformed HTTPS URL/],
    ['https://github.com/example-org/qbit-js.git?', /malformed HTTPS URL/],
    ['https://github.com/example-org/qbit-js.git#main', /malformed HTTPS URL/],
    ['https://github.com/example-org/qbit-js@v1.git', /embeds credentials/],
    ['https://github.com\\@evil.example/qbit-js.git', /embeds credentials/],
    ['https://github.com\\evil.example/qbit-js.git', /malformed HTTPS URL/],
    ['https://github.com/example\torg/qbit-js.git', /malformed HTTPS URL/],
    ['https://github.com/example-org/qbit-js.git\u0000', /malformed HTTPS URL/],
    ['https:github.com/example-org/qbit-js.git', /malformed HTTPS URL/],
    ['https:/github.com/example-org/qbit-js.git', /malformed HTTPS URL/],
    ['https:///github.com/example-org/qbit-js.git', /malformed HTTPS URL/],
    ['https://', /malformed HTTPS URL/],
    [' https://github.com/example-org/qbit-js.git', /not an absolute URL/],
    ['\u0001https://github.com/example-org/qbit-js.git', /not an absolute URL/],
  ]
  for (const [url, reason] of rejected) {
    assert.match(submoduleUrlProblem(url), reason, String(url))
  }
})

test('reads every .gitmodules declaration, including one without a URL', t => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'qbit-release-readiness-'))
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }))
  assert.deepEqual(readSubmoduleDeclarations(repoRoot), [])

  writeFixtureFile(repoRoot, '.gitmodules', '# no submodules\n')
  assert.deepEqual(readSubmoduleDeclarations(repoRoot), [])

  writeFixtureFile(
    repoRoot,
    '.gitmodules',
    [
      '[submodule "external/qbit-js"]',
      '\tpath = external/qbit-js',
      '\turl = https://github.com/example-org/qbit-js.git',
      '[submodule "vendor.with.dots"]',
      '\tpath = vendor/with dots',
      '\turl = git@github.com:example-org/qbit-pqc.git',
      '[submodule "no-url"]',
      '\tpath = external/no-url',
      '',
    ].join('\n')
  )
  assert.deepEqual(readSubmoduleDeclarations(repoRoot), [
    {
      name: 'external/qbit-js',
      path: 'external/qbit-js',
      url: 'https://github.com/example-org/qbit-js.git',
    },
    {
      name: 'vendor.with.dots',
      path: 'vendor/with dots',
      url: 'git@github.com:example-org/qbit-pqc.git',
    },
    { name: 'no-url', path: 'external/no-url', url: null },
  ])

  writeFixtureFile(repoRoot, '.gitmodules', '[submodule "broken"\n')
  assert.throws(() => readSubmoduleDeclarations(repoRoot), /cannot read \.gitmodules/)
})

// Fixture commits are local and unsigned so the tests never need a key. No
// GIT_* variable (GIT_DIR from a hook, GIT_CONFIG_* pairs) or global config
// reaches the fixture repositories.
function fixtureGitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(tmpdir(), 'qbit-no-global-config') }
}

function fixtureGit(cwd, args) {
  return execFileSync(
    'git',
    [
      '-c',
      'protocol.file.allow=always',
      '-c',
      'user.name=Readiness Test',
      '-c',
      'user.email=readiness@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: fixtureGitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

// collectExecutableSourceRepositories reads these files.
function writeEmptyExecutableSources(repoRoot) {
  for (const relativePath of [
    'docker/regtest/qbitd-release.Dockerfile',
    'docker/regtest/electrs-qbit-source.Dockerfile',
    '.github/workflows/build-regtest-images.yml',
    '.github/workflows/qbit-conformance.yml',
    'docker-compose.regtest.yml',
  ]) {
    writeFixtureFile(repoRoot, relativePath, '\n')
  }
}

function fixtureRepository(directory, files) {
  mkdirSync(directory, { recursive: true })
  fixtureGit(directory, ['init', '-q'])
  for (const [path, contents] of Object.entries(files)) writeFixtureFile(directory, path, contents)
  fixtureGit(directory, ['add', '-A'])
  fixtureGit(directory, ['commit', '-q', '-m', 'fixture'])
}

// root -> external/lib (initialized) -> vendor/deep (initialized), and
// external/lib also declares vendor/private, which is never initialized.
function nestedSubmoduleFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'qbit-release-readiness-nested-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const deep = join(base, 'deep')
  const lib = join(base, 'lib')
  const root = join(base, 'root')
  fixtureRepository(deep, { 'README.md': 'deep\n' })
  fixtureRepository(lib, { 'README.md': 'lib\n' })
  fixtureGit(lib, ['submodule', 'add', '-q', deep, 'vendor/deep'])
  writeFixtureFile(
    lib,
    '.gitmodules',
    `${readFileSync(join(lib, '.gitmodules'), 'utf8')}[submodule "vendor/private"]\n\tpath = vendor/private\n\turl = git@github.com:example-org/private.git\n`
  )
  fixtureGit(lib, ['add', '-A'])
  fixtureGit(lib, ['commit', '-q', '-m', 'nested'])
  fixtureRepository(root, { 'README.md': 'root\n' })
  fixtureGit(root, ['submodule', 'add', '-q', lib, 'external/lib'])
  fixtureGit(root, ['submodule', 'update', '-q', '--init', '--recursive'])
  fixtureGit(root, ['remote', 'add', 'origin', 'https://github.com/Qbit-Org/qbit-wallet.git'])
  for (const [path, url] of [
    ['external/lib', 'https://github.com/Qbit-Org/lib.git'],
    ['external/lib/vendor/deep', 'https://github.com/untrusted/deep.git'],
  ]) {
    fixtureGit(join(root, path), ['remote', 'set-url', 'origin', url])
  }
  return { root, lib, deep }
}

test('reads nested declarations from the submodules git reports as initialized', t => {
  const { root, lib, deep } = nestedSubmoduleFixture(t)
  assert.deepEqual(initializedSubmoduleCheckouts(root), ['external/lib', 'external/lib/vendor/deep'])
  assert.deepEqual(collectSubmoduleDeclarations(root), [
    { name: 'external/lib', path: 'external/lib', url: lib, parent: null },
    { name: 'vendor/deep', path: 'vendor/deep', url: deep, parent: 'external/lib' },
    {
      name: 'vendor/private',
      path: 'vendor/private',
      url: 'git@github.com:example-org/private.git',
      parent: 'external/lib',
    },
  ])

  const audit = auditSubmoduleFetchability(collectSubmoduleDeclarations(root), { offline: true })
  assert.deepEqual(
    audit.notFetchable.map(({ path, parent, reason }) => [path, parent, reason]),
    [
      ['external/lib', undefined, 'not an absolute URL'],
      ['vendor/deep', 'external/lib', 'not an absolute URL'],
      ['vendor/private', 'external/lib', 'scp-style SSH URL requires credentials'],
    ]
  )
})

test('audits remotes of every initialized submodule, recursively', t => {
  const { root } = nestedSubmoduleFixture(t)
  const records = collectConfiguredRemotes(root)
  assert.deepEqual([...new Set(records.map(({ scope }) => scope))], [
    '.',
    'external/lib',
    'external/lib/vendor/deep',
  ])
  assert.deepEqual(auditRemoteRecords(records).errors, [
    'external/lib/vendor/deep:origin:fetch targets untrusted/deep, not Qbit-Org',
    'external/lib/vendor/deep:origin:push targets untrusted/deep, not Qbit-Org',
  ])

  // A declared top-level submodule must still be initialized.
  fixtureGit(root, ['submodule', 'deinit', '-q', '-f', 'external/lib'])
  assert.deepEqual(initializedSubmoduleCheckouts(root), [])
  assert.throws(() => collectConfiguredRemotes(root), /submodule external\/lib is not initialized/)
})

test('names the declaring checkout of a nested submodule in the gate', t => {
  const { root } = nestedSubmoduleFixture(t)
  writeEmptyExecutableSources(root)
  const report = buildReadinessReport(root, { offline: true })
  assert.ok(
    report.humanGates.includes(
      '3 submodule URL(s) cannot be fetched anonymously: external/lib (not an absolute URL); vendor/deep (in external/lib) (not an absolute URL); vendor/private (in external/lib) (scp-style SSH URL requires credentials)'
    ),
    report.humanGates.join('\n')
  )
})

test('treats missing, malformed, credential-requiring and failed URLs as not fetchable', () => {
  const probed = []
  const probe = url => {
    probed.push(url)
    if (url === 'https://github.com/Qbit-Org/public.git') return { fetchable: true }
    if (url === 'https://github.com/Qbit-Org/odd.git') return {}
    return { fetchable: false, reason: 'git ls-remote exited 128: terminal prompts disabled' }
  }
  const audit = auditSubmoduleFetchability(
    [
      { name: 'public', path: 'external/public', url: 'https://github.com/Qbit-Org/public.git' },
      { name: 'private', path: 'external/private', url: 'https://github.com/example-org/qbit-js.git' },
      { name: 'odd', path: 'external/odd', url: 'https://github.com/Qbit-Org/odd.git' },
      { name: 'missing', path: 'external/missing', url: null },
      { name: 'ssh', path: 'external/ssh', url: 'git@github.com:example-org/qbit-pqc.git' },
      {
        name: 'token',
        path: 'external/token',
        url: 'https://x-access-token:secret@github.com/example-org/qbit-pqc.git',
      },
    ],
    { probe }
  )

  // Only well-formed anonymous https URLs reach the network probe.
  assert.deepEqual(probed, [
    'https://github.com/Qbit-Org/public.git',
    'https://github.com/example-org/qbit-js.git',
    'https://github.com/Qbit-Org/odd.git',
  ])
  assert.equal(audit.status, 'human-gate')
  assert.deepEqual(
    audit.submodules.map(({ name, fetchable }) => [name, fetchable]),
    [
      ['public', true],
      ['private', false],
      ['odd', false],
      ['missing', false],
      ['ssh', false],
      ['token', false],
    ]
  )
  assert.equal(audit.submodules.find(({ name }) => name === 'odd').reason, 'probe gave no result')
  const token = audit.submodules.find(({ name }) => name === 'token')
  assert.equal(token.url, 'https://[redacted]@github.com/example-org/qbit-pqc.git')
  assert.doesNotMatch(JSON.stringify(audit), /secret/)

  // A password with a raw `@` and a token in the query are both redacted.
  const leaky = auditSubmoduleFetchability(
    [
      { name: 'at', path: 'a', url: 'https://ci:p@ss-secret@github.com/example-org/x.git' },
      { name: 'query', path: 'b', url: 'https://github.com/example-org/x.git?access_token=ghp_secret' },
      { name: 'fragment', path: 'c', url: 'https://github.com/example-org/x.git#secret' },
      { name: 'scp-token', path: 'd', url: 'ghp_secret@github.com:example-org/x.git' },
      { name: 'scp-pair', path: 'e', url: 'x-access-token:secret@github.com:example-org/x.git' },
      { name: 'ssh-token', path: 'f', url: 'ssh://secret@github.com/example-org/x.git' },
      { name: 'ssh-git', path: 'g', url: 'ssh://git@github.com/example-org/x.git' },
      { name: 'slash', path: 'h', url: 'https://user:pa/ss-secret@github.com/example-org/x.git' },
    ],
    { probe: () => assert.fail('a credential-bearing URL must not be probed') }
  )
  assert.deepEqual(
    leaky.submodules.map(({ url }) => url),
    [
      'https://[redacted]@github.com/example-org/x.git',
      'https://github.com/example-org/x.git?[redacted]',
      'https://github.com/example-org/x.git#[redacted]',
      '[redacted]@github.com:example-org/x.git',
      '[redacted]@github.com:example-org/x.git',
      'ssh://[redacted]@github.com/example-org/x.git',
      'ssh://git@github.com/example-org/x.git',
      'https://[redacted]@github.com/example-org/x.git',
    ]
  )
  assert.doesNotMatch(JSON.stringify(leaky), /secret/)
  assert.equal(
    audit.submodules.find(({ name }) => name === 'ssh').url,
    'git@github.com:example-org/qbit-pqc.git'
  )

  // A URL declared at two paths is probed once and reported for both.
  probed.length = 0
  const duplicate = auditSubmoduleFetchability(
    [
      { name: 'one', path: 'a', url: 'https://github.com/example-org/qbit-js.git' },
      { name: 'two', path: 'b/c', url: 'https://github.com/example-org/qbit-js.git' },
    ],
    { probe }
  )
  assert.deepEqual(probed, ['https://github.com/example-org/qbit-js.git'])
  assert.deepEqual(duplicate.notFetchable.map(({ path }) => path), ['a', 'b/c'])

  const allPublic = auditSubmoduleFetchability(
    [{ name: 'public', path: 'external/public', url: 'https://github.com/Qbit-Org/public.git' }],
    { probe }
  )
  assert.equal(allPublic.status, 'pass')
  assert.deepEqual(allPublic.notFetchable, [])

  const offline = auditSubmoduleFetchability(
    [
      { name: 'public', path: 'external/public', url: 'https://github.com/Qbit-Org/public.git' },
      { name: 'ssh', path: 'external/ssh', url: 'git@github.com:example-org/qbit-pqc.git' },
    ],
    { offline: true, probe: () => assert.fail('offline mode must not probe') }
  )
  assert.equal(offline.status, 'human-gate')
  assert.deepEqual(offline.unknown.map(({ name }) => name), ['public'])
  assert.deepEqual(offline.notFetchable.map(({ name }) => name), ['ssh'])
})

test('adds a release-readiness human gate for each submodule not fetchable anonymously', t => {
  const base = mkdtempSync(join(tmpdir(), 'qbit-release-readiness-gate-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const sdk = join(base, 'sdk')
  const repoRoot = join(base, 'root')
  fixtureRepository(sdk, { 'README.md': 'sdk\n' })
  fixtureRepository(repoRoot, { 'README.md': 'root\n' })
  writeEmptyExecutableSources(repoRoot)
  fixtureGit(repoRoot, ['submodule', 'add', '-q', sdk, 'external/qbit-js'])
  fixtureGit(repoRoot, ['remote', 'add', 'origin', 'https://github.com/Qbit-Org/qbit-wallet.git'])
  fixtureGit(join(repoRoot, 'external/qbit-js'), [
    'remote',
    'set-url',
    'origin',
    'https://github.com/Qbit-Org/qbit-js.git',
  ])
  const setUrl = url =>
    fixtureGit(repoRoot, ['config', '--file', '.gitmodules', 'submodule.external/qbit-js.url', url])

  // Offline runs never probe, so an unchecked URL stays a gate.
  setUrl('https://github.com/Qbit-Org/qbit-js.git')
  const offlineReport = buildReadinessReport(repoRoot, {
    offline: true,
    probeSubmoduleFetch: () => assert.fail('offline mode must not probe'),
  })
  assert.ok(
    offlineReport.humanGates.includes('anonymous fetch of 1 submodule URL(s) was not checked')
  )

  setUrl('git@github.com:Qbit-Org/qbit-js.git')
  const sshReport = buildReadinessReport(repoRoot, { offline: true })
  assert.ok(
    sshReport.humanGates.includes(
      '1 submodule URL(s) cannot be fetched anonymously: external/qbit-js (scp-style SSH URL requires credentials)'
    ),
    sshReport.humanGates.join('\n')
  )
  assert.equal(sshReport.remoteOwnership.status, 'pass')
  assert.equal(sshReport.ready, false)

  // A declared path git does not report is never entered, even outside the
  // repository.
  fixtureRepository(join(base, 'other'), { 'README.md': 'other\n' })
  fixtureGit(join(base, 'other'), ['remote', 'add', 'origin', 'https://github.com/untrusted/other.git'])
  fixtureGit(repoRoot, ['config', '--file', '.gitmodules', 'submodule.other.path', '../other'])
  fixtureGit(repoRoot, ['config', '--file', '.gitmodules', 'submodule.other.url', 'https://x.invalid/o.git'])
  assert.throws(() => collectConfiguredRemotes(repoRoot), /submodule \.\.\/other is not initialized/)
})

test('probes with git isolated from every inherited credential source', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qbit-release-readiness-git-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const capture = join(directory, 'capture.json')
  const fakeGit = join(directory, 'git')
  writeFileSync(
    fakeGit,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }))`,
      "if (process.env.FAKE_GIT_MODE === 'ok') process.exit(0)",
      "process.stderr.write(\"fatal: could not read Username for 'https://github.com': terminal prompts disabled\\n\")",
      'process.exit(128)',
      '',
    ].join('\n')
  )
  chmodSync(fakeGit, 0o755)

  const inheritedEnv = {
    PATH: process.env.PATH,
    GH_TOKEN: 'gh-secret',
    GITHUB_TOKEN: 'github-secret',
    QBIT_SDK_READ_TOKEN: 'sdk-secret',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic c2VjcmV0',
    GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_DIR: '/tmp/not-a-repository',
    HTTPS_PROXY: 'http://proxy.invalid:3128',
    NO_PROXY: 'localhost',
  }
  const url = 'https://github.com/example-org/qbit-js.git'
  const failed = probeAnonymousFetch(url, { gitBinary: fakeGit, inheritedEnv })
  assert.deepEqual(failed, {
    fetchable: false,
    reason:
      "git ls-remote exited 128: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  })

  const { args, env, cwd } = JSON.parse(readFileSync(capture, 'utf8'))
  assert.deepEqual(args, [
    '-c',
    'credential.helper=',
    '-c',
    'core.askPass=',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    'ls-remote',
    '--',
    url,
    'HEAD',
  ])
  assert.doesNotMatch(JSON.stringify(env), /secret|c2VjcmV0|extraheader|store|not-a-repository/)
  assert.deepEqual(
    Object.keys(env).sort(),
    Object.keys(anonymousGitEnvironment(cwd, inheritedEnv)).sort()
  )
  assert.equal(env.HTTPS_PROXY, undefined)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_ASKPASS, '')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.HOME, cwd)
  assert.equal(env.XDG_CONFIG_HOME, cwd)
  assert.equal(dirname(env.GIT_CONFIG_GLOBAL), cwd)
  assert.equal(env.GIT_CEILING_DIRECTORIES, dirname(cwd))

  // An inherited variable cannot switch the fake git to success either.
  assert.deepEqual(
    probeAnonymousFetch(url, {
      gitBinary: fakeGit,
      inheritedEnv: { ...inheritedEnv, FAKE_GIT_MODE: 'ok' },
    }),
    failed
  )

  const slowGit = join(directory, 'slow-git')
  writeFileSync(slowGit, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000)\n')
  chmodSync(slowGit, 0o755)
  assert.deepEqual(probeAnonymousFetch(url, { gitBinary: slowGit, timeoutMs: 300 }), {
    fetchable: false,
    reason: 'git ls-remote timed out after 300 ms',
  })
})

test('real git accepts the anonymous probe arguments and fails closed when nothing answers', () => {
  // A usage error (exit 129) would mean git rejected an option.
  const result = probeAnonymousFetch('https://127.0.0.1:9/qbit-js.git', {
    timeoutMs: 20_000,
    inheritedEnv: { PATH: process.env.PATH },
  })
  assert.equal(result.fetchable, false)
  assert.match(result.reason, /^git ls-remote exited 128: fatal: unable to access/)
})

test('prints open gates as warnings in report-only mode and errors in strict mode', () => {
  const report = {
    remoteOwnership: { errors: ['root origin is missing a push URL'] },
    humanGates: ['1 submodule URL(s) cannot be fetched anonymously: a\n::add-mask::x 100%'],
  }
  assert.deepEqual(readinessMessages(report, { reportOnly: true }), [
    'error: root origin is missing a push URL',
    'warning: 1 submodule URL(s) cannot be fetched anonymously: a ::add-mask::x 100%',
  ])
  assert.deepEqual(readinessMessages(report, { githubActions: true }), [
    '::error title=Release readiness::root origin is missing a push URL',
    '::error title=Release readiness::1 submodule URL(s) cannot be fetched anonymously: a%0A::add-mask::x 100%25',
  ])
  assert.deepEqual(
    readinessMessages({ remoteOwnership: { errors: [] }, humanGates: [] }, { reportOnly: true }),
    []
  )
})
