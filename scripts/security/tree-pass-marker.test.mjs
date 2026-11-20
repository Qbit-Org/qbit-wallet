import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'

import {
  artifactName,
  artifactProblem,
  creationProblem,
  decide,
  DECIDE_JOB,
  eligibility,
  eventsProblem,
  githubJson,
  githubList,
  githubTime,
  headPullsProblem,
  headTreeOf,
  isMarkerPrefix,
  jobsProblem,
  laterRunsProblem,
  markerKey,
  markerPrefix,
  markerRunProblem,
  parseMarkerKey,
  readPullRequestLabels,
  recordErrors,
  repositorySalt,
  rerunProblem,
  RULES,
  runContext,
  runDecide,
  runKey,
  runRecord,
  runRecordProblem,
  SAVE_JOB,
  SAVE_JOB_NAME,
  treeOf,
  TreePassConfigError,
  workflowPathFromRef,
} from './tree-pass-marker.mjs'
import { runSignedHeadGate } from './signed-head-gate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(repoRoot, 'scripts/security/tree-pass-marker.mjs')
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)
const HEAD_TREE = 'c'.repeat(40)
const FORCE_LABEL = 'ci:full-run'
const REPOSITORY = 'Qbit-Org/qbit-wallet'
const REPOSITORY_ID = '1436120009'
const PREFIX = markerPrefix({
  workflow: 'ci',
  workflowSalt: '1',
  repositorySalt: '0',
  tree: TREE,
  pullRequest: '42',
})
const RUN = '1001'
const KEY = markerKey(PREFIX, RUN, '1')

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A throwaway repository. Its git commands read no user or system
// configuration, so they behave the same on every machine.
function gitFixture(t) {
  const dir = scratch(t, 'tree-pass-git-')
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tree Pass Test',
    GIT_AUTHOR_EMAIL: 'tree-pass@example.invalid',
    GIT_COMMITTER_NAME: 'Tree Pass Test',
    GIT_COMMITTER_EMAIL: 'tree-pass@example.invalid',
  }
  let clock = 1_700_000_000
  const git = (...args) => {
    clock += 60
    return execFileSync('git', args, {
      cwd: dir,
      env: { ...env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
      encoding: 'utf8',
    }).trim()
  }
  git('init', '-q', '-b', 'main')
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const commit = message => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  // GitHub tests refs/pull/N/merge: the head merged into the base.
  const mergeOf = (baseSha, headSha) => {
    git('checkout', '-q', '--detach', baseSha)
    git('merge', '-q', '--no-ff', '--no-edit', headSha)
    return git('rev-parse', 'HEAD')
  }
  return { dir, git, write, commit, mergeOf }
}

// A head on a branch, a base that moved on since, and GitHub's merge of the
// two, whose tree is neither's.
function pullRequestFixture(t) {
  const repo = gitFixture(t)
  repo.write('base.txt', 'base\n')
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('feature.txt', 'feature\n')
  const head = repo.commit('feature')
  repo.git('checkout', '-q', 'main')
  repo.write('base.txt', 'base, later\n')
  const base = repo.commit('base moves')
  const merge = repo.mergeOf(base, head)
  return { ...repo, base, head, merge }
}

function prefixFor(fixture, sha, overrides = {}) {
  return markerPrefix({
    workflow: 'ci',
    workflowSalt: '1',
    repositorySalt: '0',
    tree: treeOf(sha, { cwd: fixture.dir }),
    pullRequest: '42',
    ...overrides,
  })
}

function outputs(file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
}

// --- The key -------------------------------------------------------------

test('the key is the tree: an amended commit with the same tree gets the same key', t => {
  const repo = gitFixture(t)
  repo.write('src/a.txt', 'one\n')
  repo.write('.github/workflows/ci.yml', 'name: CI\n')
  const first = repo.commit('first')
  repo.git('commit', '-q', '--amend', '-m', 'signed and squashed')
  const amended = repo.git('rev-parse', 'HEAD')

  assert.notEqual(first, amended)
  assert.equal(prefixFor(repo, first), prefixFor(repo, amended))
  assert.ok(prefixFor(repo, first).includes(`-${repo.git('rev-parse', `${first}^{tree}`)}-`))
  assert.ok(!prefixFor(repo, first).includes(first))
})

test('a different tree, including a workflow-only change, gets a different key', t => {
  const repo = gitFixture(t)
  repo.write('src/a.txt', 'one\n')
  repo.write('.github/workflows/ci.yml', 'name: CI\n')
  const base = repo.commit('base')
  repo.write('src/a.txt', 'two\n')
  const code = repo.commit('code change')
  repo.write('.github/workflows/ci.yml', 'name: CI\n# changed\n')
  const workflow = repo.commit('workflow change')
  repo.write('scripts/security/tree-pass-marker.mjs', '// changed\n')
  const decider = repo.commit('decision script change')

  const keys = [base, code, workflow, decider].map(sha => prefixFor(repo, sha))
  assert.equal(new Set(keys).size, keys.length)
})

test('a squashed head merged into the same base keys like the original; a moved base does not', t => {
  const repo = gitFixture(t)
  repo.write('base.txt', 'base\n')
  const base = repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  repo.write('feature.txt', 'step 1\n')
  repo.commit('step 1')
  repo.write('feature.txt', 'step 2\n')
  const head = repo.commit('step 2')
  const firstMerge = repo.mergeOf(base, head)

  // squash-sign: one new commit on the same parent with exactly the same tree.
  const squashed = repo.git('commit-tree', `${head}^{tree}`, '-p', base, '-m', 'squashed')
  const squashedMerge = repo.mergeOf(base, squashed)
  assert.notEqual(squashed, head)
  assert.notEqual(squashedMerge, firstMerge)
  assert.equal(prefixFor(repo, squashedMerge), prefixFor(repo, firstMerge))

  repo.git('checkout', '-q', 'main')
  repo.write('base.txt', 'base moved\n')
  const movedBase = repo.commit('base moves')
  assert.notEqual(prefixFor(repo, repo.mergeOf(movedBase, squashed)), prefixFor(repo, firstMerge))
})

test('the key names the workflow, both salts, the tree, the pull request and the saving run', () => {
  const base = {
    workflow: 'ci',
    workflowSalt: '1',
    repositorySalt: '0',
    tree: TREE,
    pullRequest: '42',
  }
  const variants = [
    PREFIX,
    markerPrefix({ ...base, workflow: 'browser-release-gate' }),
    markerPrefix({ ...base, workflowSalt: '2' }),
    markerPrefix({ ...base, repositorySalt: '1' }),
    markerPrefix({ ...base, tree: OTHER_TREE }),
    markerPrefix({ ...base, pullRequest: '43' }),
  ]
  assert.equal(new Set(variants).size, variants.length)
  assert.ok(variants.every(isMarkerPrefix))
  assert.equal(PREFIX, `tree-pass-v1-ci-salt1.0-${TREE}-pr42-`)
  assert.equal(KEY, `${PREFIX}1001-1`)
  assert.equal(markerKey(PREFIX, '43060937489', '12'), `${PREFIX}43060937489-12`)
  // SHA-256 repositories have 64-character object IDs.
  assert.ok(isMarkerPrefix(markerPrefix({ ...base, tree: 'c'.repeat(64) })))
  // Every key stays far below the cache's 512-character limit.
  const longest = markerKey(
    markerPrefix({
      workflow: 'a'.repeat(40),
      workflowSalt: '999999999',
      repositorySalt: '999999999',
      tree: 'c'.repeat(64),
      pullRequest: '9999999999',
    }),
    '9'.repeat(15),
    '99999'
  )
  assert.ok(longest.length < 256, String(longest.length))
})

test('the key rejects missing, empty and malformed inputs', () => {
  const good = {
    workflow: 'ci',
    workflowSalt: '1',
    repositorySalt: '0',
    tree: TREE,
    pullRequest: '42',
  }
  const bad = [
    { workflow: undefined },
    { workflow: '' },
    { workflow: 'CI' },
    { workflow: 'ci,x' },
    { workflow: 'ci-' },
    { workflow: '-ci' },
    { workflow: 'c i' },
    { workflow: 'a'.repeat(41) },
    { workflowSalt: undefined },
    { workflowSalt: '' },
    { workflowSalt: '01' },
    { workflowSalt: '-1' },
    { workflowSalt: '1.0' },
    { workflowSalt: ' 1' },
    { workflowSalt: '1\n' },
    { workflowSalt: '1234567890' },
    { workflowSalt: 1 },
    { repositorySalt: '' },
    { repositorySalt: 'x' },
    { tree: undefined },
    { tree: '' },
    { tree: 'A'.repeat(40) },
    { tree: 'a'.repeat(39) },
    { tree: 'a'.repeat(41) },
    { tree: 'g'.repeat(40) },
    { tree: `${TREE}\n` },
    { pullRequest: undefined },
    { pullRequest: '' },
    { pullRequest: '0' },
    { pullRequest: '042' },
    { pullRequest: '4-2' },
    { pullRequest: 42 },
  ]
  for (const override of bad) {
    assert.throws(
      () => markerPrefix({ ...good, ...override }),
      TreePassConfigError,
      JSON.stringify(override)
    )
  }
  for (const [prefix, runId, attempt] of [
    ['', RUN, '1'],
    [PREFIX.slice(0, -1), RUN, '1'],
    [`${PREFIX}x-`, RUN, '1'],
    [PREFIX, '', '1'],
    [PREFIX, '0', '1'],
    [PREFIX, '01', '1'],
    [PREFIX, '1'.repeat(16), '1'],
    [PREFIX, RUN, ''],
    [PREFIX, RUN, '0'],
    [PREFIX, RUN, '1-1'],
    [PREFIX, RUN, undefined],
  ]) {
    assert.throws(
      () => markerKey(prefix, runId, attempt),
      TreePassConfigError,
      JSON.stringify([prefix, runId, attempt])
    )
  }
})

test('a matched key names a run only when it is the exact prefix and two numbers', () => {
  assert.deepEqual(parseMarkerKey(KEY, PREFIX), { runId: RUN, runAttempt: '1' })
  assert.deepEqual(parseMarkerKey(`${PREFIX}43060937489-12`, PREFIX), {
    runId: '43060937489',
    runAttempt: '12',
  })
  const otherPrefix = overrides =>
    markerPrefix({
      workflow: 'ci',
      workflowSalt: '1',
      repositorySalt: '0',
      tree: TREE,
      pullRequest: '42',
      ...overrides,
    })
  for (const key of [
    '',
    undefined,
    null,
    PREFIX,
    `${PREFIX}1001`,
    `${PREFIX}1001-`,
    `${PREFIX}-1001-1`,
    `${PREFIX}1001.1`,
    `${PREFIX}1001-1-1`,
    `${PREFIX}1001-1 `,
    `${PREFIX}1001-1\n`,
    `${PREFIX}01001-1`,
    `${PREFIX}1001-01`,
    `${PREFIX}0-1`,
    `${PREFIX}1001-0`,
    `${PREFIX}${'1'.repeat(16)}-1`,
    `${PREFIX}1001-123456`,
    `${PREFIX}x-1`,
    `${PREFIX.toUpperCase()}1001-1`,
    `${otherPrefix({ tree: OTHER_TREE })}1001-1`,
    `${otherPrefix({ pullRequest: '4' })}1001-1`,
    `${otherPrefix({ pullRequest: '421' })}1001-1`,
    `${otherPrefix({ workflowSalt: '2' })}1001-1`,
  ]) {
    assert.equal(parseMarkerKey(key, PREFIX), null, JSON.stringify(key))
  }
  // A prefix that is not a marker prefix matches nothing.
  assert.equal(parseMarkerKey(KEY, ''), null)
  assert.equal(parseMarkerKey(KEY, 'tree-pass-v1-'), null)
})

test('an unset repository salt is 0, and a set one must be a number', () => {
  assert.equal(repositorySalt(undefined), '0')
  assert.equal(repositorySalt(''), '0')
  assert.equal(repositorySalt('0'), '0')
  assert.equal(repositorySalt('42'), '42')
  for (const value of ['x', '01', '-1', ' 1', '1 ', '1e3']) {
    assert.throws(() => repositorySalt(value), TreePassConfigError, value)
  }
})

test('the tree comes from the commit under test and fails on anything else', t => {
  const repo = gitFixture(t)
  repo.write('a.txt', 'a\n')
  const sha = repo.commit('a')
  assert.equal(treeOf(sha, { cwd: repo.dir }), repo.git('rev-parse', `${sha}^{tree}`))
  assert.throws(() => treeOf('', { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => treeOf(undefined, { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => treeOf('HEAD', { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => treeOf(sha.toUpperCase(), { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => treeOf('--help', { cwd: repo.dir }), TreePassConfigError)
  // Well formed but not in the repository.
  assert.throws(() => treeOf('d'.repeat(40), { cwd: repo.dir }))
})

test('the head tree is the tree of a parent of the merge under test, and nothing else', t => {
  const repo = pullRequestFixture(t)
  assert.equal(
    headTreeOf(repo.merge, repo.head, { cwd: repo.dir }),
    repo.git('rev-parse', `${repo.head}^{tree}`)
  )
  assert.notEqual(
    headTreeOf(repo.merge, repo.head, { cwd: repo.dir }),
    treeOf(repo.merge, { cwd: repo.dir })
  )
  // The event's head must be one of exactly two parents of the merge.
  repo.git('checkout', '-q', 'feature')
  repo.write('feature.txt', 'later\n')
  const later = repo.commit('later')
  assert.throws(() => headTreeOf(repo.merge, later, { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => headTreeOf(repo.head, repo.base, { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => headTreeOf(repo.merge, '', { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => headTreeOf(repo.merge, 'HEAD', { cwd: repo.dir }), TreePassConfigError)
  assert.throws(() => headTreeOf('', repo.head, { cwd: repo.dir }), TreePassConfigError)
})

test("the workflow path comes from this repository's workflow ref", () => {
  assert.equal(
    workflowPathFromRef(`${REPOSITORY}/.github/workflows/ci.yml@refs/pull/42/merge`, REPOSITORY),
    '.github/workflows/ci.yml'
  )
  assert.equal(
    workflowPathFromRef(
      `${REPOSITORY}/.github/workflows/playwright-release-gate.yml@refs/heads/a@b`,
      REPOSITORY
    ),
    '.github/workflows/playwright-release-gate.yml'
  )
  for (const ref of [
    undefined,
    '',
    '.github/workflows/ci.yml@refs/pull/42/merge',
    `someone/qbit-wallet/.github/workflows/ci.yml@refs/pull/42/merge`,
    `${REPOSITORY}/.github/workflows/ci.yml`,
    `${REPOSITORY}/.github/workflows/ci.yml@`,
    `${REPOSITORY}/.github/workflows/../ci.yml@refs/pull/42/merge`,
    `${REPOSITORY}/.github/workflows/sub/ci.yml@refs/pull/42/merge`,
    `${REPOSITORY}/ci.yml@refs/pull/42/merge`,
    `${REPOSITORY}/.github/workflows/ci.txt@refs/pull/42/merge`,
  ]) {
    assert.throws(() => workflowPathFromRef(ref, REPOSITORY), TreePassConfigError, String(ref))
  }
})

// --- Eligibility and labels ----------------------------------------------

test('markers are used only for pull requests from this repository without the force label', () => {
  const base = {
    eventName: 'pull_request',
    repositoryId: REPOSITORY_ID,
    headRepositoryId: REPOSITORY_ID,
    labels: ['bug'],
    forceLabel: FORCE_LABEL,
  }
  assert.equal(eligibility(base).eligible, true)

  for (const eventName of [
    'push',
    'merge_group',
    'workflow_dispatch',
    'schedule',
    'pull_request_target',
    'release',
    'create',
    '',
    undefined,
  ]) {
    assert.equal(eligibility({ ...base, eventName }).eligible, false, String(eventName))
  }
  // Another repository: someone else's copy, another repository of the same
  // organization (Qbit-Org/qbit's ID), an ID that only starts or ends the
  // same, and the right ID as a number.
  for (const headRepositoryId of [
    '987654321',
    '1272562877',
    '143612000',
    '14361200091',
    '436120009',
    ` ${REPOSITORY_ID}`,
    '',
    undefined,
    null,
    Number(REPOSITORY_ID),
  ]) {
    assert.equal(
      eligibility({ ...base, headRepositoryId }).eligible,
      false,
      JSON.stringify(headRepositoryId)
    )
  }
  // This repository's ID must itself be readable.
  for (const repositoryId of ['', undefined, 'x', '0', '01']) {
    assert.equal(
      eligibility({ ...base, repositoryId, headRepositoryId: repositoryId }).eligible,
      false,
      JSON.stringify(repositoryId)
    )
  }
  // Labels that could not be read might include the force label.
  assert.equal(eligibility({ ...base, labels: null }).eligible, false)
  assert.equal(eligibility({ ...base, labels: undefined }).eligible, false)
  for (const label of [FORCE_LABEL, 'CI:Full-Run']) {
    assert.equal(eligibility({ ...base, labels: ['bug', label] }).eligible, false, label)
  }
  assert.equal(eligibility({ ...base, labels: [] }).eligible, true)
})

function fakeResponse(status, body, link = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'link' && link ? link : null) },
    json: async () => (typeof body === 'function' ? body() : body),
  }
}

test('labels are read from the current pull request, and every doubt throws', async () => {
  const request = {
    apiUrl: 'https://api.github.com',
    repository: REPOSITORY,
    number: '42',
    token: 'token-value',
  }
  let seen
  const labels = await readPullRequestLabels({
    ...request,
    fetchImpl: async (url, options) => {
      seen = { url, options }
      return fakeResponse(200, { labels: [{ name: 'bug' }, { name: FORCE_LABEL }] })
    },
  })
  assert.deepEqual(labels, ['bug', FORCE_LABEL])
  assert.equal(seen.url, 'https://api.github.com/repos/Qbit-Org/qbit-wallet/pulls/42')
  assert.equal(seen.options.headers.Authorization, 'Bearer token-value')
  assert.ok(seen.options.signal instanceof AbortSignal)

  const failures = [
    async () => fakeResponse(404, { message: 'Not Found' }),
    async () => fakeResponse(500, {}),
    async () =>
      fakeResponse(200, () => {
        throw new SyntaxError('Unexpected token')
      }),
    async () => fakeResponse(200, null),
    async () => fakeResponse(200, {}),
    async () => fakeResponse(200, { labels: 'bug' }),
    async () => fakeResponse(200, { labels: [{ name: 7 }] }),
    async () => fakeResponse(200, { labels: [{ name: '' }] }),
    async () => fakeResponse(200, { labels: [null] }),
    async () => {
      throw new TypeError('fetch failed')
    },
    async (_url, options) => {
      options.signal.throwIfAborted()
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
  ]
  for (const fetchImpl of failures) {
    await assert.rejects(readPullRequestLabels({ ...request, fetchImpl }))
  }

  const neverCalled = async () => assert.fail('fetch must not run for invalid input')
  for (const override of [
    { number: undefined },
    { number: '' },
    { number: '0' },
    { number: '12a' },
    { number: '../1' },
    { token: '' },
    { token: undefined },
    { repository: 'qbit-wallet' },
    { repository: 'a/b/c' },
    { apiUrl: 'http://api.github.com' },
    { apiUrl: '' },
  ]) {
    await assert.rejects(
      readPullRequestLabels({ ...request, ...override, fetchImpl: neverCalled }),
      TreePassConfigError,
      JSON.stringify(override)
    )
  }
  // A timeout is passed to every request.
  let signal
  await githubJson({
    apiUrl: 'https://api.github.com/',
    path: '/x',
    token: 't',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.github.com/x')
      signal = options.signal
      return fakeResponse(200, {})
    },
  })
  assert.ok(signal instanceof AbortSignal)
})

// --- GitHub's record of the run a marker names ----------------------------

const COVERED_CI = ['Lint', 'Typecheck, test, and build']
const CONTEXT = {
  repository: REPOSITORY,
  serverUrl: 'https://github.com',
  workflowPath: '.github/workflows/ci.yml',
  headRepositoryId: '1436120009',
  headBranch: 'feature/same-tree',
  headTree: HEAD_TREE,
  pullRequest: '42',
  jobNames: [...COVERED_CI, SAVE_JOB_NAME],
  currentRunId: '2002',
  currentRunAttempt: '1',
}
// Pull request #42 was opened before run 1001 was created.
const PULL_CREATED = '2026-11-01T00:00:00Z'
const RUN_CREATED = '2026-11-02T00:00:00Z'

function runRecordFor(runId = RUN, attempt = 1, overrides = {}) {
  return {
    id: Number(runId),
    run_attempt: attempt,
    repository: { full_name: REPOSITORY },
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_repository: { id: 1436120009 },
    head_branch: 'feature/same-tree',
    head_commit: { tree_id: HEAD_TREE },
    created_at: RUN_CREATED,
    run_started_at: RUN_CREATED,
    ...overrides,
  }
}

function job(name, runId = RUN, attempt = 1, overrides = {}) {
  return {
    name,
    run_id: Number(runId),
    run_attempt: attempt,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

// The jobs of a full pass of CI that saved a marker. Dependency policy is not
// covered, so its result does not matter.
function passingJobs(runId = RUN, attempt = 1) {
  const jobs = [
    job('Tree pass marker', runId, attempt),
    job('Lint', runId, attempt),
    job('Typecheck, test, and build', runId, attempt),
    job('Dependency policy', runId, attempt, { conclusion: 'failure' }),
    job(SAVE_JOB_NAME, runId, attempt),
  ]
  return { total_count: jobs.length, jobs }
}

function artifactsFor(names, runId = RUN, overrides = {}) {
  const artifacts = names.map(name => ({
    name,
    expired: false,
    workflow_run: { id: Number(runId) },
    ...overrides,
  }))
  return { total_count: artifacts.length, artifacts }
}

test('the run record must be this workflow, this pull request head and the saving attempt', () => {
  const expected = { ...CONTEXT, runId: RUN, runAttempt: '1' }
  assert.equal(runRecordProblem(runRecordFor(), expected), null)
  // The run-level conclusion is not what is judged: the jobs are.
  assert.equal(runRecordProblem(runRecordFor(RUN, 1, { conclusion: 'failure' }), expected), null)

  const refused = [
    ['ID', { id: 1002 }],
    ['ID', { id: '1001' }],
    ['repository', { repository: { full_name: 'someone/qbit-wallet' } }],
    ['repository', { repository: undefined }],
    ['workflow', { path: '.github/workflows/playwright-release-gate.yml' }],
    ['workflow', { path: '.github/workflows/ci.yml@refs/heads/main' }],
    ['event', { event: 'push' }],
    ['event', { event: 'pull_request_target' }],
    ['head repository', { head_repository: { id: 1 } }],
    ['head repository', { head_repository: { id: '1436120009' } }],
    ['head repository', { head_repository: null }],
    ['head branch', { head_branch: 'another-branch' }],
    ['head tree', { head_commit: { tree_id: OTHER_TREE } }],
    ['head tree', { head_commit: null }],
  ]
  for (const [what, overrides] of refused) {
    assert.match(
      runRecordProblem(runRecordFor(RUN, 1, overrides), expected) ?? '',
      new RegExp(`^run 1001: ${what} is `),
      JSON.stringify(overrides)
    )
  }
  for (const record of [null, undefined, [], 'x', 7]) {
    assert.notEqual(runRecordProblem(record, expected), null, JSON.stringify(record))
  }
  // Both attempts: the saving attempt must be the latest, so the jobs read in
  // it are the latest attempt's too. A later attempt refuses even if it passed.
  for (const latest of [2, '1', true, null, undefined, 0]) {
    assert.match(
      runRecordProblem(runRecordFor(RUN, 1, { run_attempt: latest }), expected) ?? '',
      /^\[both attempts\] run 1001: latest attempt is /,
      JSON.stringify(latest)
    )
  }
})

test('the saving attempt must show every covered job and the save job as successful', () => {
  const where = { runId: RUN, runAttempt: '1', jobNames: CONTEXT.jobNames }
  assert.equal(jobsProblem(passingJobs(), where), null)

  const withJob = (name, overrides) => {
    const body = passingJobs()
    body.jobs = body.jobs.map(entry => (entry.name === name ? { ...entry, ...overrides } : entry))
    return body
  }
  const without = name => {
    const body = passingJobs()
    body.jobs = body.jobs.filter(entry => entry.name !== name)
    body.total_count = body.jobs.length
    return body
  }
  const duplicated = name => {
    const body = passingJobs()
    body.jobs.push(job(name))
    body.total_count = body.jobs.length
    return body
  }
  const refused = [
    // A covered job that did not pass in that attempt.
    withJob('Typecheck, test, and build', { conclusion: 'failure' }),
    withJob('Typecheck, test, and build', { conclusion: 'cancelled' }),
    withJob('Lint', { conclusion: 'skipped' }),
    withJob('Lint', { status: 'in_progress', conclusion: null }),
    withJob('Lint', { status: 'in_progress' }),
    // A run the marker skipped: Lint and the save job report skipped.
    withJob(SAVE_JOB_NAME, { conclusion: 'skipped' }),
    without(SAVE_JOB_NAME),
    without('Lint'),
    duplicated('Typecheck, test, and build'),
    // A job of another attempt or run.
    withJob(SAVE_JOB_NAME, { run_attempt: 2 }),
    withJob('Lint', { run_id: 9 }),
    // A list that is not all of the attempt's jobs.
    { ...passingJobs(), total_count: 101 },
    { total_count: 0, jobs: [] },
    { jobs: [] },
    null,
  ]
  for (const body of refused) {
    assert.notEqual(jobsProblem(body, where), null, JSON.stringify(body))
  }
  // A skipped run of the whole workflow is refused whatever its covered jobs say.
  const skippedRun = {
    total_count: 4,
    jobs: [
      job('Tree pass marker'),
      job('Lint', RUN, 1, { conclusion: 'skipped' }),
      job('Typecheck, test, and build'),
      job(SAVE_JOB_NAME, RUN, 1, { conclusion: 'skipped' }),
    ],
  }
  assert.match(jobsProblem(skippedRun, where), /Lint.*skipped/)
  assert.notEqual(jobsProblem(passingJobs(), { ...where, jobNames: [SAVE_JOB_NAME] }), null)
})

test('the run must hold exactly one unexpired artifact named for the full key', () => {
  const name = artifactName(KEY)
  assert.match(name, /^tree-pass-[0-9a-f]{64}$/)
  assert.notEqual(name, artifactName(markerKey(PREFIX, RUN, '2')))
  assert.equal(artifactProblem(artifactsFor([name]), { runId: RUN, name }), null)

  const refused = [
    // A successful run with no artifact.
    artifactsFor([]),
    // An artifact under another key's name only.
    artifactsFor([artifactName(markerKey(PREFIX, RUN, '2'))]),
    artifactsFor([name.replace(/.$/, '0')]),
    // Expired.
    artifactsFor([name], RUN, { expired: true }),
    artifactsFor([name], RUN, { expired: undefined }),
    // Of another run, or more than one.
    artifactsFor([name], '1002'),
    artifactsFor([name, name]),
    { total_count: 2, artifacts: artifactsFor([name]).artifacts },
    { artifacts: [] },
    null,
  ]
  for (const body of refused) {
    assert.notEqual(artifactProblem(body, { runId: RUN, name }), null, JSON.stringify(body))
  }
})

const API = 'https://api.github.com'

// One page of a listing as GitHub serves it: `per_page` entries from `page`,
// and a Link header naming the next page when there is one.
function pageOf(url, entries) {
  const perPage = Number(url.searchParams.get('per_page') ?? 30)
  const page = Number(url.searchParams.get('page') ?? 1)
  const body = entries.slice((page - 1) * perPage, page * perPage)
  if (page * perPage >= entries.length) return { status: 200, body }
  const next = new URL(url)
  next.searchParams.set('page', String(page + 1))
  return { status: 200, body, link: `<${next}>; rel="next", <${url}>; rel="last"` }
}

function pullFor(
  number,
  { state = 'open', merged = false, ref = 'feature/same-tree', created = PULL_CREATED } = {}
) {
  return {
    number,
    state,
    created_at: created,
    merged_at: merged ? '2026-11-01T00:00:00Z' : null,
    owner: 'Qbit-Org',
    head: { ref, repo: { id: Number(REPOSITORY_ID) } },
  }
}

// A simulated GitHub REST API holding runs, attempt jobs, artifacts, pull
// requests, timelines, issue events and the listing of a workflow's runs. It
// reads queries the way GitHub does, and requests whose path and query match
// a pattern in `fail` return HTTP 502.
function fakeGitHub(world) {
  const {
    runs = {},
    jobs = {},
    artifacts = {},
    pulls = [],
    timelines = {},
    events = {},
    workflowRuns = [],
    fail = [],
  } = world
  const requests = []
  const respond = path => {
    requests.push(path)
    if (fail.some(pattern => pattern.test(path))) return { status: 502, body: {} }
    const url = new URL(path, API)
    const prefix = `/repos/${REPOSITORY}`
    assert.ok(url.pathname.startsWith(`${prefix}/`), path)
    const route = url.pathname.slice(prefix.length)
    let match = /^\/actions\/runs\/(\d+)$/.exec(route)
    if (match) return runs[match[1]] ? { status: 200, body: runs[match[1]] } : { status: 404 }
    match = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(route)
    if (match) {
      const body = jobs[`${match[1]}/${match[2]}`]
      return body ? { status: 200, body } : { status: 404 }
    }
    match = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(route)
    if (match) {
      const named = (artifacts[match[1]] ?? []).filter(
        artifact => artifact.name === url.searchParams.get('name')
      )
      return { status: 200, body: { total_count: named.length, artifacts: named } }
    }
    if (route === '/pulls') {
      const head = url.searchParams.get('head')
      const state = url.searchParams.get('state') ?? 'open'
      const listed = pulls
        .filter(pull => head === null || `${pull.owner}:${pull.head.ref}` === head)
        .filter(pull => state === 'all' || pull.state === state)
        .sort((a, b) => a.number - b.number)
        .map(({ owner: _owner, ...pull }) => pull)
      return pageOf(url, listed)
    }
    match = /^\/issues\/(\d+)\/timeline$/.exec(route)
    if (match) return pageOf(url, timelines[match[1]] ?? [])
    match = /^\/issues\/(\d+)\/events$/.exec(route)
    if (match) return pageOf(url, events[match[1]] ?? [])
    match = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(route)
    if (match) {
      const listed = workflowRuns
        .filter(run => run.path === `.github/workflows/${match[1]}`)
        .filter(run => run.event === url.searchParams.get('event'))
        .filter(run => run.head_branch === url.searchParams.get('branch'))
        .sort((a, b) => b.id - a.id)
      const { body, link } = pageOf(url, listed)
      return { status: 200, body: { total_count: listed.length, workflow_runs: body }, link }
    }
    throw new Error(`unexpected request ${path}`)
  }
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer token-value')
    assert.ok(url.startsWith(API), url)
    const { status, body = {}, link } = respond(url.slice(API.length))
    return fakeResponse(status, body, link)
  }
  const request = { apiUrl: API, token: 'token-value', fetchImpl }
  return {
    fetchImpl,
    requests,
    fetchJson: path => githubJson({ ...request, path }),
    fetchList: (path, maxPages, field) => githubList({ ...request, path, maxPages, field }),
  }
}

// Runs of CI on head branch feature/same-tree that do not stand in the way:
// an earlier failure of this head tree, a later failure of another head tree,
// a later pass of this head tree, this run (still going) and the run that
// saved the marker.
function laterRuns() {
  return [
    runRecordFor('900', 1, {
      conclusion: 'failure',
      created_at: '2026-11-01T12:00:00Z',
      run_started_at: '2026-11-01T12:00:00Z',
    }),
    runRecordFor(RUN),
    runRecordFor('1500', 1, {
      head_commit: { tree_id: OTHER_TREE },
      conclusion: 'failure',
      created_at: '2026-11-03T00:00:00Z',
      run_started_at: '2026-11-03T00:00:00Z',
    }),
    runRecordFor('1600', 1, {
      created_at: '2026-11-04T00:00:00Z',
      run_started_at: '2026-11-04T00:00:00Z',
    }),
    runRecordFor('2002', 1, {
      status: 'in_progress',
      conclusion: null,
      created_at: '2026-11-05T00:00:00Z',
      run_started_at: '2026-11-05T00:00:00Z',
    }),
  ]
}

// Run 1001 attempt 1 passed this tree and saved KEY. Pull request #42 is the
// only one from its head branch, opened before that run, and neither its base
// nor its head branch ever changed; no run of this tree failed since.
function passingWorld() {
  return {
    runs: { [RUN]: runRecordFor() },
    jobs: { [`${RUN}/1`]: passingJobs() },
    artifacts: { [RUN]: artifactsFor([artifactName(KEY)]).artifacts },
    pulls: [pullFor(42), pullFor(43, { ref: 'another-branch' })],
    timelines: {
      42: [{ event: 'committed' }, { event: 'reviewed' }, { event: 'head_ref_force_pushed' }],
      43: [{ event: 'base_ref_changed' }],
    },
    events: {
      42: [
        { id: 11, event: 'labeled' },
        { id: 12, event: 'head_ref_force_pushed' },
      ],
      43: [{ id: 13, event: 'head_ref_deleted' }],
    },
    // Pull request #43's run of another branch, which GitHub does not list
    // for this branch, failed later.
    workflowRuns: [
      ...laterRuns(),
      runRecordFor('1700', 1, {
        head_branch: 'another-branch',
        conclusion: 'failure',
        created_at: '2026-11-04T00:00:00Z',
        run_started_at: '2026-11-04T00:00:00Z',
      }),
    ],
  }
}

test('GitHub must vouch for the run a marker names, through its record, jobs and artifact', async () => {
  const check = async (world, key = KEY) => {
    const github = fakeGitHub(world)
    const named = parseMarkerKey(key, PREFIX)
    // decide turns a failed request into a full run, as it does a problem.
    const problem = await markerRunProblem({
      ...named,
      key,
      context: CONTEXT,
      fetchJson: github.fetchJson,
      fetchList: github.fetchList,
    }).catch(error => error.message)
    return { problem, requests: github.requests }
  }
  const passing = await check(passingWorld())
  assert.equal(passing.problem, null)
  assert.deepEqual(passing.requests, [
    `/repos/${REPOSITORY}/actions/runs/1001`,
    `/repos/${REPOSITORY}/actions/runs/1001/attempts/1/jobs?per_page=100`,
    `/repos/${REPOSITORY}/actions/runs/1001/artifacts?name=${artifactName(KEY)}&per_page=100`,
    `/repos/${REPOSITORY}/pulls?state=all&sort=created&direction=asc&head=Qbit-Org%3Afeature%2Fsame-tree&per_page=2`,
    `/repos/${REPOSITORY}/issues/42/timeline?per_page=100&page=1`,
    `/repos/${REPOSITORY}/issues/42/events?per_page=100&page=1`,
    `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=pull_request&branch=feature%2Fsame-tree&per_page=100&page=1`,
  ])

  const world = mutate => {
    const value = passingWorld()
    mutate(value)
    return value
  }
  const refused = {
    'a successful run with no artifact': world(w => {
      w.artifacts[RUN] = []
    }),
    "an artifact under another key's name": world(w => {
      w.artifacts[RUN] = artifactsFor([
        artifactName(`${PREFIX.replace(TREE, OTHER_TREE)}1001-1`),
      ]).artifacts
    }),
    'an expired artifact': world(w => {
      w.artifacts[RUN][0].expired = true
    }),
    'a covered job not successful in that attempt': world(w => {
      w.jobs[`${RUN}/1`].jobs[2].conclusion = 'failure'
    }),
    'a run that the marker skipped': world(w => {
      w.jobs[`${RUN}/1`].jobs[1].conclusion = 'skipped'
      w.jobs[`${RUN}/1`].jobs[4].conclusion = 'skipped'
      w.artifacts[RUN] = []
    }),
    // The labelled failing re-run: the run that saved the marker was re-run
    // with ci:full-run and failed, so its latest attempt is not the saving one.
    'a re-run of the saving run, which failed': world(w => {
      w.runs[RUN] = runRecordFor(RUN, 2, { conclusion: 'failure' })
      w.jobs[`${RUN}/2`] = passingJobs(RUN, 2)
      w.jobs[`${RUN}/2`].jobs[2].conclusion = 'failure'
    }),
    // A modified workflow on an earlier push planted the entry naming its own
    // run: that run's head commit has another tree.
    'a run of an earlier head': world(w => {
      w.runs[RUN].head_commit.tree_id = OTHER_TREE
    }),
    'a run of another workflow': world(w => {
      w.runs[RUN].path = '.github/workflows/pqc.yml'
    }),
    'a run from another branch': world(w => {
      w.runs[RUN].head_branch = 'other'
    }),
    'a run of a push': world(w => {
      w.runs[RUN].event = 'push'
    }),
    'a run that does not exist': world(w => {
      delete w.runs[RUN]
    }),
    // This pull request alone, from its head branch, with its base unchanged.
    'a second open pull request from the same head branch': world(w => {
      w.pulls.push(pullFor(44))
    }),
    'a closed pull request from the same head branch': world(w => {
      w.pulls.push(pullFor(7, { state: 'closed' }))
    }),
    'a merged pull request from the same head branch': world(w => {
      w.pulls.push(pullFor(7, { state: 'closed', merged: true }))
    }),
    'only another pull request from the head branch': world(w => {
      w.pulls = [pullFor(44)]
    }),
    'no pull request from the head branch': world(w => {
      w.pulls = []
    }),
    'this pull request listed with another head repository': world(w => {
      w.pulls[0].head.repo.id = 1
    }),
    'a retargeted pull request': world(w => {
      w.timelines[42].push({ event: 'base_ref_changed' })
    }),
    'a retarget by GitHub after the base was merged and deleted': world(w => {
      w.timelines[42].push({ event: 'automatic_base_change_succeeded' })
    }),
    'a deleted base': world(w => {
      w.timelines[42].push({ event: 'base_ref_deleted' })
    }),
    'a force-pushed base': world(w => {
      w.timelines[42].push({ event: 'base_ref_force_pushed' })
    }),
    'a timeline entry without an event name': world(w => {
      w.timelines[42].push({ id: 1 })
    }),
    'a retarget on the second page of the timeline': world(w => {
      w.timelines[42] = [
        ...Array.from({ length: 120 }, () => ({ event: 'commented' })),
        { event: 'base_ref_changed' },
      ]
    }),
    'a failing pull request listing': world(w => {
      w.fail = [/\/pulls\?/]
    }),
    'a failing timeline': world(w => {
      w.fail = [/\/timeline\?/]
    }),
    'a timeline truncated by a failing second page': world(w => {
      w.timelines[42] = Array.from({ length: 150 }, () => ({ event: 'commented' }))
      w.fail = [/\/timeline\?.*&page=2$/]
    }),
  }
  for (const [name, value] of Object.entries(refused)) {
    assert.notEqual((await check(value)).problem, null, name)
  }
  // Each rule that binds the run to this pull request refuses by name, and
  // so does a listing it reads that fails or is cut short.
  const many = (count, entry) => Array.from({ length: count }, () => ({ ...entry }))
  const laterRun = (id, overrides) =>
    runRecordFor(id, 1, {
      created_at: '2026-11-03T00:00:00Z',
      run_started_at: '2026-11-03T00:00:00Z',
      ...overrides,
    })
  const byRule = {
    'one pull request per head branch': {
      'a closed pull request from the same head branch': world(w => {
        w.pulls.push(pullFor(7, { state: 'closed' }))
      }),
      'a failing pull request listing': world(w => {
        w.fail = [/\/pulls\?/]
      }),
    },
    'base unchanged': {
      'a retarget only in the issue events': world(w => {
        w.events[42].push({ id: 14, event: 'base_ref_changed' })
      }),
      'a failed retarget by GitHub in the issue events': world(w => {
        w.events[42].push({ id: 14, event: 'automatic_base_change_failed' })
      }),
      'a base force-push only in the issue events': world(w => {
        w.events[42].push({ id: 14, event: 'base_ref_force_pushed' })
      }),
      'a base deletion on the second page of the issue events': world(w => {
        w.events[42] = [...many(120, { event: 'labeled' }), { event: 'base_ref_deleted' }]
      }),
      'a retarget by GitHub in the timeline': world(w => {
        w.timelines[42].push({ event: 'automatic_base_change_succeeded' })
      }),
    },
    'head branch kept': {
      'a deleted head branch in the timeline': world(w => {
        w.timelines[42].push({ event: 'head_ref_deleted' })
      }),
      'a restored head branch in the timeline': world(w => {
        w.timelines[42].push({ event: 'head_ref_restored' })
      }),
      'a deleted head branch in the issue events': world(w => {
        w.events[42].push({ id: 14, event: 'head_ref_deleted' })
      }),
      'a restored head branch in the issue events': world(w => {
        w.events[42].push({ id: 14, event: 'head_ref_restored' })
      }),
    },
    'base unchanged, head branch kept': {
      'a failing issue events listing': world(w => {
        w.fail = [/\/events\?/]
      }),
      'issue events cut short by a failing second page': world(w => {
        w.events[42] = many(150, { event: 'labeled' })
        w.fail = [/\/events\?.*&page=2$/]
      }),
      'issue events longer than 30 pages': world(w => {
        w.events[42] = many(3000, { event: 'labeled' })
      }),
      'an issue event without a name': world(w => {
        w.events[42].push({ id: 14 })
      }),
      'an issue event whose name is not a string': world(w => {
        w.events[42].push({ id: 14, event: 7 })
      }),
    },
    'run after the pull request': {
      'a run created before the pull request': world(w => {
        w.runs[RUN].created_at = '2026-10-31T00:00:00Z'
      }),
      'a run created in the same second as the pull request': world(w => {
        w.runs[RUN].created_at = PULL_CREATED
      }),
      'a run without created_at': world(w => {
        delete w.runs[RUN].created_at
      }),
      'a pull request without created_at': world(w => {
        delete w.pulls[0].created_at
      }),
      'a pull request whose created_at is a number': world(w => {
        w.pulls[0].created_at = 1794427138
      }),
    },
    'no later failure': {
      'a later failed run of this tree': world(w => {
        w.workflowRuns.push(laterRun('1800', { conclusion: 'failure' }))
      }),
      'a later cancelled run of this tree': world(w => {
        w.workflowRuns.push(laterRun('1800', { conclusion: 'cancelled' }))
      }),
      'a later run of this tree still going': world(w => {
        w.workflowRuns.push(laterRun('1800', { status: 'in_progress', conclusion: null }))
      }),
      'an earlier run of this tree re-run since, which failed': world(w => {
        w.workflowRuns.push(
          laterRun('950', { conclusion: 'failure', created_at: '2026-11-01T12:00:00Z' })
        )
      }),
      'a later failure on the second page': world(w => {
        w.workflowRuns.push(
          ...Array.from({ length: 120 }, (_, index) => laterRun(String(3000 + index), {})),
          laterRun('1800', { conclusion: 'failure' })
        )
      }),
      'a failing run listing': world(w => {
        w.fail = [/\/actions\/workflows\/ci\.yml\/runs\?/]
      }),
      'a run listing cut short by a failing second page': world(w => {
        w.workflowRuns.push(
          ...Array.from({ length: 120 }, (_, index) => laterRun(String(3000 + index), {}))
        )
        w.fail = [/\/runs\?.*&page=2$/]
      }),
      'a run listing longer than 10 pages': world(w => {
        w.workflowRuns.push(
          ...Array.from({ length: 1000 }, (_, index) => laterRun(String(3000 + index), {}))
        )
      }),
      'a listed run whose head tree is unreadable': world(w => {
        w.workflowRuns.push(laterRun('1800', { head_commit: { tree_id: null } }))
      }),
      // The vouching run, re-run while the decision was under way: its record
      // was read at attempt 1, and the listing shows the newer attempt.
      'the vouching run re-run since, still going': world(w => {
        w.workflowRuns = w.workflowRuns.map(listed =>
          listed.id === Number(RUN)
            ? { ...listed, run_attempt: 2, status: 'in_progress', conclusion: null }
            : listed
        )
      }),
      'the vouching run re-run since, failed': world(w => {
        w.workflowRuns = w.workflowRuns.map(listed =>
          listed.id === Number(RUN) ? { ...listed, run_attempt: 2, conclusion: 'failure' } : listed
        )
      }),
      'the vouching run not in the listing': world(w => {
        w.workflowRuns = w.workflowRuns.filter(listed => listed.id !== Number(RUN))
      }),
      // Ten full pages are not known to be the whole listing.
      'exactly 1,000 listed runs': world(w => {
        w.workflowRuns.push(
          ...Array.from({ length: 1000 - laterRuns().length }, (_, index) =>
            laterRun(String(3000 + index), {})
          )
        )
      }),
      'a listed failure whose start is unreadable': world(w => {
        w.workflowRuns.push(laterRun('1800', { conclusion: 'failure', run_started_at: 'later' }))
      }),
    },
    'both attempts': {
      'a re-run of the saving run that passed too': world(w => {
        w.runs[RUN] = runRecordFor(RUN, 2)
        w.jobs[`${RUN}/2`] = passingJobs(RUN, 2)
      }),
      'the save job skipped in the saving attempt': world(w => {
        w.jobs[`${RUN}/1`].jobs[4].conclusion = 'skipped'
      }),
      'a failing jobs listing': world(w => {
        w.fail = [/\/jobs\?/]
      }),
    },
  }
  for (const [rule, cases] of Object.entries(byRule)) {
    for (const [name, value] of Object.entries(cases)) {
      const { problem } = await check(value)
      assert.ok(
        typeof problem === 'string' && problem.startsWith(`[${rule}] `),
        `${name}: ${problem}`
      )
    }
  }
  assert.deepEqual(Object.values(RULES).sort(), [
    'base unchanged',
    'both attempts',
    'head branch kept',
    'no later failure',
    'one pull request per head branch',
    'run after the pull request',
  ])
  // The listing of runs is GitHub's for this workflow file and head branch,
  // whose name is encoded; a long listing is read to the end and passes.
  const longRuns = world(w => {
    w.workflowRuns.push(
      ...Array.from({ length: 230 }, (_, index) => laterRun(String(3000 + index), {}))
    )
  })
  // The vouching run red at run level only, with its gate and save jobs
  // green in that attempt: Dependency policy failed, or the run was
  // cancelled, or is still finishing, after it saved the marker. It vouches.
  for (const overrides of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { status: 'in_progress', conclusion: null },
  ]) {
    const redRun = world(w => {
      w.runs[RUN] = runRecordFor(RUN, 1, overrides)
      w.workflowRuns = w.workflowRuns.map(listed =>
        listed.id === Number(RUN) ? { ...listed, ...overrides } : listed
      )
    })
    assert.equal((await check(redRun)).problem, null, JSON.stringify(overrides))
  }
  const longRunsCheck = await check(longRuns)
  assert.equal(longRunsCheck.problem, null)
  assert.equal(longRunsCheck.requests.filter(path => path.includes('/runs?')).length, 3)
  // 999 runs end on a short tenth page and are read to the end.
  const justUnder = world(w => {
    w.workflowRuns.push(
      ...Array.from({ length: 999 - laterRuns().length }, (_, index) =>
        laterRun(String(3000 + index), {})
      )
    )
  })
  assert.equal((await check(justUnder)).problem, null)
  // This run's own earlier attempts are not read, so a re-run never skips,
  // and it is refused before the run listing is read.
  const rerun = fakeGitHub(passingWorld())
  const rerunProblemText = await markerRunProblem({
    ...parseMarkerKey(KEY, PREFIX),
    key: KEY,
    context: { ...CONTEXT, currentRunAttempt: '2' },
    fetchJson: rerun.fetchJson,
    fetchList: rerun.fetchList,
  })
  assert.match(rerunProblemText, /^\[no later failure\] this is attempt 2 of run 2002/)
  assert.ok(!rerun.requests.some(path => path.includes('/runs?')))

  // A long timeline without a base change is read to the end and passes.
  const long = world(w => {
    w.timelines[42] = Array.from({ length: 250 }, () => ({ event: 'commented' }))
  })
  const longCheck = await check(long)
  assert.equal(longCheck.problem, null)
  assert.equal(longCheck.requests.filter(path => path.includes('/timeline?')).length, 3)
  // A pass of the same head against an older base, or by another pull request
  // from the same branch, saved under its own key: an entry claiming this
  // key for that run finds no artifact named for it.
  for (const planted of [
    `${PREFIX}1001-1`.replace('-pr42-', '-pr43-'),
    `${PREFIX.replace(TREE, OTHER_TREE)}1001-1`,
  ]) {
    const value = world(w => {
      w.artifacts[RUN] = artifactsFor([artifactName(planted)]).artifacts
    })
    assert.notEqual((await check(value)).problem, null, planted)
  }
})

test('only a marker that GitHub vouches for, named by a successful lookup, skips', async () => {
  const hit = {
    eligible: 'true',
    prefix: PREFIX,
    lookupOutcome: 'success',
    matchedKey: KEY,
    currentRunId: '2002',
  }
  let verified
  const vouch = async named => {
    verified = named
    return null
  }
  assert.deepEqual(await decide({ ...hit, verify: vouch }), {
    skip: true,
    save: false,
    reason: 'run 1001 attempt 1 already passed this tree',
    runId: RUN,
    runAttempt: '1',
  })
  assert.deepEqual(verified, { runId: RUN, runAttempt: '1', key: KEY })

  // A verify that would vouch: any row that reached it would skip.
  let verifyCalls = 0
  const wouldVouch = async () => {
    verifyCalls += 1
    return null
  }
  // Each row breaks one part of the hit. None skips; the first group may save.
  const rows = [
    [{ lookupOutcome: 'failure' }, true],
    [{ lookupOutcome: 'cancelled' }, true],
    [{ lookupOutcome: 'skipped' }, true],
    [{ lookupOutcome: '' }, true],
    [{ lookupOutcome: undefined }, true],
    // A miss leaves cache-matched-key empty.
    [{ matchedKey: '' }, true],
    [{ matchedKey: undefined }, true],
    // A forged or foreign entry under the prefix, or another prefix.
    [{ matchedKey: PREFIX }, true],
    [{ matchedKey: `${PREFIX}1001` }, true],
    [{ matchedKey: `${PREFIX}x-1` }, true],
    [{ matchedKey: `${PREFIX}1001-1-1` }, true],
    [{ matchedKey: KEY.toUpperCase() }, true],
    [{ matchedKey: KEY.replace(TREE, OTHER_TREE) }, true],
    // This run's own marker: a re-run of the run that saved it runs in full.
    [{ currentRunId: RUN }, true],
    [{ currentRunId: '' }, true],
    [{ currentRunId: undefined }, true],
    // Markers are not used at all: no save either.
    [{ eligible: 'false' }, false],
    [{ eligible: '' }, false],
    [{ eligible: undefined }, false],
    [{ eligible: 'TRUE' }, false],
    [{ prefix: '' }, false],
    [{ prefix: undefined }, false],
    [{ prefix: `${PREFIX}\n` }, false],
    [{ prefix: PREFIX.replace('tree-pass-v1', 'tree-pass-v0') }, false],
  ]
  for (const [override, save] of rows) {
    const verdict = await decide({ ...hit, ...override, verify: wouldVouch })
    assert.equal(verdict.skip, false, JSON.stringify(override))
    assert.equal(verdict.save, save, JSON.stringify(override))
  }
  assert.equal(verifyCalls, 0)

  // An entry which fails the checks never skips: whatever the check reports,
  // or however it fails, the run runs in full and may save its own marker.
  for (const verify of [
    async () => 'run 1001: head tree is "b", not "c"',
    async () => {
      throw new Error('GET /repos/x returned HTTP 502')
    },
    async () => {
      throw new TreePassConfigError('TREE_PASS_COVERED_JOBS must be a JSON list of job names')
    },
    () => {
      throw new TypeError('synchronous failure')
    },
  ]) {
    const verdict = await decide({ ...hit, verify })
    assert.deepEqual([verdict.skip, verdict.save], [false, true], verdict.reason)
  }
})

// --- Recording ------------------------------------------------------------

function needsFor({ covered = ['lint', 'verify'], decideOutputs = {}, jobs = {} } = {}) {
  const needs = {
    [DECIDE_JOB]: {
      result: 'success',
      outputs: { prefix: PREFIX, skip: 'false', save: 'true', 'run-url': '', ...decideOutputs },
    },
  }
  for (const name of covered) {
    needs[name] = { result: 'success', outputs: { tested: 'true' }, ...jobs[name] }
  }
  return needs
}

test('a marker is recorded only after every covered job ran and passed in this run', () => {
  assert.deepEqual(recordErrors({ needs: needsFor() }), [])

  const refused = [
    // A covered job that failed, was cancelled or was skipped.
    needsFor({ jobs: { verify: { result: 'failure' } } }),
    needsFor({ jobs: { verify: { result: 'cancelled' } } }),
    needsFor({ jobs: { lint: { result: 'skipped', outputs: {} } } }),
    needsFor({ jobs: { lint: { result: undefined } } }),
    // A covered job that reported success with its steps skipped.
    needsFor({ jobs: { verify: { result: 'success', outputs: {} } } }),
    needsFor({ jobs: { verify: { result: 'success', outputs: { tested: 'false' } } } }),
    // A run the marker skipped, or one that did not ask for a save.
    needsFor({ decideOutputs: { skip: 'true', save: 'false' } }),
    needsFor({ decideOutputs: { skip: 'true', save: 'true' } }),
    needsFor({ decideOutputs: { skip: '' } }),
    needsFor({ decideOutputs: { save: 'false' } }),
    needsFor({ decideOutputs: { save: '' } }),
    // No well-formed key prefix.
    needsFor({ decideOutputs: { prefix: '' } }),
    needsFor({ decideOutputs: { prefix: undefined } }),
    needsFor({ decideOutputs: { prefix: `${PREFIX}1001-1` } }),
    needsFor({ decideOutputs: { prefix: PREFIX.slice(0, -1) } }),
    // Nothing covered.
    needsFor({ covered: [] }),
  ]
  for (const needs of refused) {
    assert.notDeepEqual(recordErrors({ needs }), [], JSON.stringify(needs))
  }
  const failedDecide = needsFor()
  failedDecide[DECIDE_JOB].result = 'failure'
  assert.notDeepEqual(recordErrors({ needs: failedDecide }), [])
  // A skipped tree-pass (any event but pull_request) has no outputs.
  const skippedDecide = needsFor()
  skippedDecide[DECIDE_JOB] = { result: 'skipped', outputs: {} }
  assert.notDeepEqual(recordErrors({ needs: skippedDecide }), [])
  const noDecide = needsFor()
  delete noDecide[DECIDE_JOB]
  assert.notDeepEqual(recordErrors({ needs: noDecide }), [])
  for (const needs of [undefined, null, [], 'x']) {
    assert.notDeepEqual(recordErrors({ needs }), [])
  }
})

function runEnvironment(sha, extra = {}) {
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ci.yml@refs/pull/42/merge`,
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '2002',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: '',
    GH_TOKEN: 'token-value',
    TREE_PASS_WORKFLOW: 'ci',
    TREE_PASS_WORKFLOW_SALT: '1',
    TREE_PASS_REPOSITORY_SALT: '',
    TREE_PASS_FORCE_LABEL: FORCE_LABEL,
    TREE_PASS_PR_NUMBER: '42',
    GITHUB_REPOSITORY_ID: REPOSITORY_ID,
    TREE_PASS_HEAD_REPOSITORY_ID: REPOSITORY_ID,
    ...extra,
  }
}

function messages() {
  const lines = []
  return { lines, log: { log: line => lines.push(line) } }
}
const labelsFetch = names => async () =>
  fakeResponse(200, { labels: names.map(name => ({ name })) })

test('the key step marks a pull request eligible only when everything checks out', async t => {
  const repo = pullRequestFixture(t)
  const outputFile = join(scratch(t, 'tree-pass-out-'), 'output')
  const env = runEnvironment(repo.merge, {
    GITHUB_OUTPUT: outputFile,
    TREE_PASS_HEAD_SHA: repo.head,
  })
  const expectedPrefix = prefixFor(repo, repo.merge)
  const headTree = repo.git('rev-parse', `${repo.head}^{tree}`)

  const run = async (extra, fetchImpl) => {
    rmSync(outputFile, { force: true })
    const { log } = messages()
    const result = await runKey({ ...env, ...extra }, { cwd: repo.dir, fetchImpl, log })
    return { result, written: outputs(outputFile) }
  }

  const eligible = await run({}, labelsFetch(['bug']))
  assert.deepEqual(eligible.written, {
    prefix: expectedPrefix,
    'head-tree': headTree,
    eligible: 'true',
  })

  const forced = await run({}, labelsFetch([FORCE_LABEL]))
  assert.deepEqual(forced.written, { eligible: 'false' })

  const unreadable = await run({}, async () => fakeResponse(403, {}))
  assert.deepEqual(unreadable.written, { eligible: 'false' })

  const noNumber = await run({ TREE_PASS_PR_NUMBER: '' }, labelsFetch([]))
  assert.deepEqual(noNumber.written, { eligible: 'false' })

  const otherRepository = await run({ TREE_PASS_HEAD_REPOSITORY_ID: '1272562877' }, labelsFetch([]))
  assert.deepEqual(otherRepository.written, { eligible: 'false' })

  const salted = await run({ TREE_PASS_REPOSITORY_SALT: '7' }, labelsFetch([]))
  assert.equal(salted.written.prefix, prefixFor(repo, repo.merge, { repositorySalt: '7' }))

  // A run that does not use markers reads no labels and never validates the
  // salts or the key, so a bad salt cannot fail it.
  const noFetch = async () => assert.fail('a push must not read pull request labels')
  for (const extra of [
    {},
    { TREE_PASS_WORKFLOW_SALT: 'one' },
    { TREE_PASS_REPOSITORY_SALT: 'x' },
    { TREE_PASS_WORKFLOW: undefined },
    { GITHUB_SHA: '' },
  ]) {
    const push = await run(
      { GITHUB_EVENT_NAME: 'push', TREE_PASS_HEAD_REPOSITORY_ID: '', ...extra },
      noFetch
    )
    assert.deepEqual(push.written, { eligible: 'false' }, JSON.stringify(extra))
  }
  const forcedBadSalt = await run({ TREE_PASS_WORKFLOW_SALT: 'one' }, labelsFetch([FORCE_LABEL]))
  assert.deepEqual(forcedBadSalt.written, { eligible: 'false' })

  // On an eligible pull request, configuration errors fail the step, which
  // makes every job run.
  for (const extra of [
    { TREE_PASS_WORKFLOW_SALT: '' },
    { TREE_PASS_WORKFLOW_SALT: 'one' },
    { TREE_PASS_WORKFLOW: undefined },
    { TREE_PASS_REPOSITORY_SALT: 'x' },
    { TREE_PASS_FORCE_LABEL: '' },
    { TREE_PASS_FORCE_LABEL: undefined },
    { GITHUB_SHA: '' },
    { GITHUB_SHA: 'e'.repeat(40) },
    { TREE_PASS_HEAD_SHA: '' },
    { TREE_PASS_HEAD_SHA: repo.base.replace(/^./, c => (c === '0' ? '1' : '0')) },
    { GITHUB_SHA: repo.head, TREE_PASS_HEAD_SHA: repo.base },
    { GITHUB_OUTPUT: '' },
  ]) {
    rmSync(outputFile, { force: true })
    await assert.rejects(
      runKey(
        { ...env, ...extra },
        { cwd: repo.dir, fetchImpl: labelsFetch([]), log: messages().log }
      ),
      undefined,
      JSON.stringify(extra)
    )
    assert.equal(outputs(outputFile).eligible, undefined, JSON.stringify(extra))
  }
})

function decideEnvironment(extra = {}) {
  return {
    ...runEnvironment('f'.repeat(40)),
    TREE_PASS_ELIGIBLE: 'true',
    TREE_PASS_PREFIX: PREFIX,
    TREE_PASS_HEAD_TREE: HEAD_TREE,
    TREE_PASS_LOOKUP_OUTCOME: 'success',
    TREE_PASS_MATCHED_KEY: KEY,
    TREE_PASS_HEAD_REPOSITORY_ID: '1436120009',
    TREE_PASS_HEAD_BRANCH: 'feature/same-tree',
    TREE_PASS_COVERED_JOBS: JSON.stringify(COVERED_CI),
    ...extra,
  }
}

test('the decide step skips with the passing run URL only when GitHub vouches for it', async t => {
  // What the run knows about itself, as the checks use it.
  assert.deepEqual(runContext(decideEnvironment()), CONTEXT)
  for (const [name, value] of [
    ['GITHUB_RUN_ID', ''],
    ['GITHUB_RUN_ID', '02002'],
    ['GITHUB_RUN_ID', undefined],
    ['GITHUB_RUN_ATTEMPT', ''],
    ['GITHUB_RUN_ATTEMPT', '0'],
    ['GITHUB_RUN_ATTEMPT', '1 '],
    ['GITHUB_RUN_ATTEMPT', undefined],
  ]) {
    assert.throws(
      () => runContext(decideEnvironment({ [name]: value })),
      new RegExp(`^TreePassConfigError: ${name} `),
      `${name}=${JSON.stringify(value)}`
    )
  }
  const outputFile = join(scratch(t, 'tree-pass-decide-'), 'output')
  const run = async (extra, world = passingWorld()) => {
    rmSync(outputFile, { force: true })
    const { fetchImpl, requests } = fakeGitHub(world)
    const { lines, log } = messages()
    const verdict = await runDecide(decideEnvironment({ GITHUB_OUTPUT: outputFile, ...extra }), {
      fetchImpl,
      log,
    })
    return { verdict, written: outputs(outputFile), lines, requests }
  }

  const hit = await run({})
  assert.deepEqual(hit.written, {
    skip: 'true',
    save: 'false',
    'run-url': 'https://github.com/Qbit-Org/qbit-wallet/actions/runs/1001/attempts/1',
  })
  assert.match(
    hit.lines.join('\n'),
    /^::notice title=Tree pass marker::Skipping the covered jobs: /m
  )
  assert.equal(hit.requests.length, 7)

  const full = { skip: 'false', save: 'true', 'run-url': '' }
  for (const extra of [
    { TREE_PASS_MATCHED_KEY: '' },
    { TREE_PASS_LOOKUP_OUTCOME: 'failure' },
    { TREE_PASS_MATCHED_KEY: `${PREFIX}2002-1`, GITHUB_RUN_ID: '2002' },
    // Context the checks need but cannot read.
    { TREE_PASS_HEAD_TREE: '' },
    { TREE_PASS_HEAD_REPOSITORY_ID: '' },
    { TREE_PASS_HEAD_REPOSITORY_ID: '1436120009x' },
    { TREE_PASS_HEAD_BRANCH: '' },
    { TREE_PASS_COVERED_JOBS: '' },
    { TREE_PASS_COVERED_JOBS: '[]' },
    { TREE_PASS_COVERED_JOBS: JSON.stringify([SAVE_JOB_NAME]) },
    { TREE_PASS_COVERED_JOBS: '"Lint"' },
    { GITHUB_SERVER_URL: 'http://github.com' },
    { GITHUB_SERVER_URL: 'https://github.com/evil path' },
    { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/pqc.yml@refs/pull/42/merge` },
    { GITHUB_WORKFLOW_REF: '' },
    { GH_TOKEN: '' },
    { GITHUB_API_URL: 'http://api.github.com' },
    // Another workflow's view of the same run.
    { TREE_PASS_COVERED_JOBS: JSON.stringify(['Playwright G3 scenarios']) },
    // Another pull request, or none.
    { TREE_PASS_PR_NUMBER: '43' },
    { TREE_PASS_PR_NUMBER: '' },
    // A re-run of this run, or an attempt that cannot be read.
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_RUN_ATTEMPT: '0' },
  ]) {
    const result = await run(extra)
    assert.deepEqual(result.written, full, JSON.stringify(extra))
    assert.match(result.lines.join('\n'), /^::notice title=Tree pass marker::Running every job: /m)
  }
  const ineligible = await run({ TREE_PASS_ELIGIBLE: 'false', TREE_PASS_PREFIX: '' })
  assert.deepEqual(ineligible.written, { skip: 'false', save: 'false', 'run-url': '' })
  assert.deepEqual(ineligible.requests, [])

  // A check that fails runs everything.
  const noArtifact = passingWorld()
  noArtifact.artifacts[RUN] = []
  assert.deepEqual((await run({}, noArtifact)).written, full)
  const reused = passingWorld()
  reused.pulls.push(pullFor(7, { state: 'closed', merged: true }))
  assert.deepEqual((await run({}, reused)).written, full)
  const retargeted = passingWorld()
  retargeted.timelines[42].push({ event: 'base_ref_changed' })
  assert.deepEqual((await run({}, retargeted)).written, full)

  // The log names the rule that refused, and the event or run it found.
  const logged = async (world, extra = {}) => (await run(extra, world)).lines.join('\n')
  const movedBase = passingWorld()
  movedBase.events[42].push({ id: 35054321753, event: 'base_ref_force_pushed' })
  assert.match(
    await logged(movedBase),
    /^::notice title=Tree pass marker::Running every job: \[base unchanged\] base_ref_force_pushed \(event 35054321753\) is in pull request #42's issue events$/m
  )
  const laterFailure = passingWorld()
  laterFailure.workflowRuns.push(
    runRecordFor('1800', 1, {
      conclusion: 'cancelled',
      created_at: '2026-11-03T00:00:00Z',
      run_started_at: '2026-11-03T00:00:00Z',
    })
  )
  assert.match(
    await logged(laterFailure),
    /Running every job: \[no later failure\] run 1800 of this tree ended "cancelled"/
  )
  const failedEvents = passingWorld()
  failedEvents.fail = [/\/events\?/]
  assert.match(
    await logged(failedEvents),
    /Running every job: GitHub's record of run 1001 could not be checked: \[base unchanged, head branch kept\] GET \/repos\/Qbit-Org\/qbit-wallet\/issues\/42\/events\?per_page=100&page=1 returned HTTP 502$/m
  )
  assert.match(
    await logged(passingWorld(), { GITHUB_RUN_ATTEMPT: '2' }),
    /Running every job: \[no later failure\] this is attempt 2 of run 2002/
  )

  // One deadline covers every request of the decision: once it has passed
  // nothing more is sent, and the run runs everything.
  const timed = async (budgetMs, delayMs) => {
    rmSync(outputFile, { force: true })
    const github = fakeGitHub(passingWorld())
    const { lines, log } = messages()
    const fetchImpl = async (url, options) => {
      await new Promise(done => setTimeout(done, delayMs))
      return github.fetchImpl(url, options)
    }
    await runDecide(decideEnvironment({ GITHUB_OUTPUT: outputFile }), {
      fetchImpl,
      log,
      budgetMs,
    })
    return { written: outputs(outputFile), lines, requests: github.requests }
  }
  const noTime = await timed(0, 0)
  assert.deepEqual(noTime.written, full)
  assert.deepEqual(noTime.requests, [])
  assert.match(noTime.lines.join('\n'), /was not sent: the time for the decision ran out/)
  // Each request is far inside its own 15 seconds; together they are not.
  // The deadline either cuts the request in flight short or leaves the next
  // one unsent.
  const slow = await timed(150, 40)
  assert.deepEqual(slow.written, full)
  assert.ok(slow.requests.length > 0 && slow.requests.length < 7, slow.requests.join('\n'))
  assert.match(slow.lines.join('\n'), /the time for the decision ran out|timed out after \d+ ms/)
  // A request still in flight when the deadline passes is cut short there.
  const cutStarted = Date.now()
  const cut = await timed(60, 1000)
  assert.ok(Date.now() - cutStarted < 900)
  assert.deepEqual(cut.written, full)
  assert.match(
    cut.lines.join('\n'),
    /could not be checked: GET \/repos\/Qbit-Org\/qbit-wallet\/actions\/runs\/1001 timed out after \d+ ms$/m
  )
  assert.equal((await timed(5000, 1)).written.skip, 'true')

  // A head branch whose name needs encoding in the query: `+`, `&`, `=`,
  // `#`, `%` and a non-ASCII letter all reach GitHub as part of the name.
  const branch = 'feature/a+b&state=open#c%d-ü'
  const odd = passingWorld()
  odd.runs[RUN].head_branch = branch
  odd.workflowRuns = odd.workflowRuns.map(listed =>
    listed.head_branch === 'feature/same-tree' ? { ...listed, head_branch: branch } : listed
  )
  odd.pulls = [pullFor(42, { ref: branch }), pullFor(7, { state: 'closed', ref: 'feature/a b' })]
  const encoded = await run({ TREE_PASS_HEAD_BRANCH: branch }, odd)
  assert.equal(encoded.written.skip, 'true')
  assert.ok(
    encoded.requests.includes(
      `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=pull_request&branch=feature%2Fa%2Bb%26state%3Dopen%23c%25d-%C3%BC&per_page=100&page=1`
    ),
    encoded.requests.join('\n')
  )
  assert.ok(
    encoded.requests.includes(
      `/repos/${REPOSITORY}/pulls?state=all&sort=created&direction=asc&head=Qbit-Org%3Afeature%2Fa%2Bb%26state%3Dopen%23c%25d-%C3%BC&per_page=2`
    ),
    encoded.requests.join('\n')
  )
  odd.pulls.push(pullFor(8, { state: 'closed', ref: branch }))
  assert.equal((await run({ TREE_PASS_HEAD_BRANCH: branch }, odd)).written.skip, 'false')
})

test('a listing is read page by page to its end, and any gap throws', async () => {
  const listing = (entries, { short = false, failPage, notList, oversize } = {}) => {
    const requests = []
    const fetchImpl = async url => {
      requests.push(url.slice(API.length))
      const parsed = new URL(url)
      const page = Number(parsed.searchParams.get('page'))
      if (page === failPage) return fakeResponse(502, {})
      if (page === notList) return fakeResponse(200, { entries: [] })
      if (page === oversize)
        return fakeResponse(
          200,
          Array.from({ length: 101 }, () => ({}))
        )
      const served = pageOf(parsed, entries)
      // A short page that still names a next page.
      if (short && page === 1) return fakeResponse(200, served.body.slice(1), served.link)
      return fakeResponse(200, served.body, served.link)
    }
    return {
      requests,
      read: (maxPages = 5, path = '/repos/Qbit-Org/qbit-wallet/issues/42/timeline') =>
        githubList({ apiUrl: API, token: 't', fetchImpl, path, maxPages }),
    }
  }
  const entries = count => Array.from({ length: count }, (_, index) => ({ index }))

  const twoPages = listing(entries(150))
  assert.deepEqual(await twoPages.read(), entries(150))
  assert.deepEqual(twoPages.requests, [
    '/repos/Qbit-Org/qbit-wallet/issues/42/timeline?per_page=100&page=1',
    '/repos/Qbit-Org/qbit-wallet/issues/42/timeline?per_page=100&page=2',
  ])
  // A full last page is confirmed by an empty one.
  const exact = listing(entries(100))
  assert.deepEqual(await exact.read(), entries(100))
  assert.equal(exact.requests.length, 2)
  assert.deepEqual(await listing([]).read(), [])
  // A path with a query gets `&`.
  const queried = listing(entries(3))
  await queried.read(5, '/repos/Qbit-Org/qbit-wallet/pulls?state=all')
  assert.deepEqual(queried.requests, [
    '/repos/Qbit-Org/qbit-wallet/pulls?state=all&per_page=100&page=1',
  ])

  await assert.rejects(listing(entries(150), { failPage: 2 }).read(), /HTTP 502/)
  await assert.rejects(listing(entries(150), { short: true }).read(), /names a next page/)
  await assert.rejects(listing(entries(150), { notList: 2 }).read(), /did not return a list/)
  await assert.rejects(listing(entries(150), { oversize: 1 }).read(), /did not return a list/)
  await assert.rejects(listing(entries(350)).read(3), /more than 3 pages/)
  assert.deepEqual(await listing(entries(350)).read(4), entries(350))
  // An object listing: the entries under `field`, counted by total_count.
  const objectListing = (
    entries,
    { total = () => entries.length, field = 'workflow_runs' } = {}
  ) => {
    const requests = []
    const fetchImpl = async url => {
      requests.push(url.slice(API.length))
      const parsed = new URL(url)
      const served = pageOf(parsed, entries)
      const page = Number(parsed.searchParams.get('page'))
      return fakeResponse(200, { total_count: total(page), [field]: served.body }, served.link)
    }
    return {
      requests,
      read: (maxPages = 5) =>
        githubList({
          apiUrl: API,
          token: 't',
          fetchImpl,
          path: '/repos/Qbit-Org/qbit-wallet/actions/workflows/ci.yml/runs?event=pull_request',
          maxPages,
          field: 'workflow_runs',
        }),
    }
  }
  const runsListing = objectListing(entries(150))
  assert.deepEqual(await runsListing.read(), entries(150))
  assert.deepEqual(runsListing.requests, [
    '/repos/Qbit-Org/qbit-wallet/actions/workflows/ci.yml/runs?event=pull_request&per_page=100&page=1',
    '/repos/Qbit-Org/qbit-wallet/actions/workflows/ci.yml/runs?event=pull_request&per_page=100&page=2',
  ])
  assert.deepEqual(await objectListing(entries(100)).read(), entries(100))
  assert.deepEqual(await objectListing([]).read(), [])
  // A total that says more were listed than the pages hold: GitHub stops a
  // filtered run listing at 1,000 runs while total_count goes on counting.
  await assert.rejects(objectListing(entries(50), { total: () => 51 }).read(), /listed 50 of 51/)
  await assert.rejects(objectListing(entries(50), { total: () => 49 }).read(), /listed 50 of 49/)
  // A total that moves between pages: a run was added or removed meanwhile.
  await assert.rejects(
    objectListing(entries(150), { total: page => (page === 1 ? 150 : 151) }).read(),
    /total_count 151, not 150/
  )
  for (const total of [undefined, '150', 1.5, null]) {
    await assert.rejects(
      objectListing(entries(150), { total: () => total }).read(),
      /total_count/,
      String(total)
    )
  }
  await assert.rejects(objectListing(entries(3), { field: 'runs' }).read(), /did not return a list/)
  await assert.rejects(objectListing(entries(1000)).read(9), /more than 9 pages/)
  // A bare list where an object is expected.
  await assert.rejects(
    githubList({
      apiUrl: API,
      token: 't',
      path: '/x',
      maxPages: 1,
      field: 'workflow_runs',
      fetchImpl: async () => fakeResponse(200, []),
    }),
    /did not return a list/
  )
  // A deadline that has passed sends nothing; one that is near cuts the
  // request's own timeout short.
  let sent = 0
  await assert.rejects(
    githubJson({
      apiUrl: API,
      token: 't',
      path: '/x',
      deadline: Date.now() - 1,
      fetchImpl: async () => {
        sent += 1
        return fakeResponse(200, {})
      },
    }),
    /GET \/x was not sent: the time for the decision ran out/
  )
  assert.equal(sent, 0)
  // A request that waits on nothing but its signal, as a fetch stuck with no
  // socket would: nothing else keeps the event loop alive, so the timeout's
  // own timer must, or the test (and a real decide step) never settles.
  const hanging = async (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  // A fetch that ignores its signal and never settles: the deadline still
  // ends the request.
  const deaf = async () => new Promise(() => {})
  for (const fetchImpl of [hanging, deaf]) {
    const started = Date.now()
    await assert.rejects(
      githubJson({ apiUrl: API, token: 't', path: '/x', deadline: Date.now() + 50, fetchImpl }),
      error =>
        error.name === 'TimeoutError' && /^GET \/x timed out after \d+ ms$/.test(error.message)
    )
    assert.ok(Date.now() - started < 5000)
  }
  // A body that never ends is cut off the same way.
  await assert.rejects(
    githubJson({
      apiUrl: API,
      token: 't',
      path: '/x',
      timeoutMs: 50,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => new Promise(() => {}),
      }),
    }),
    /timed out after 50 ms/
  )
  // The request's own timeout, without a shared deadline, applies the same way.
  await assert.rejects(
    githubJson({ apiUrl: API, token: 't', path: '/x', timeoutMs: 30, fetchImpl: hanging }),
    /timed out after 30 ms/
  )
  await assert.rejects(
    githubList({
      apiUrl: API,
      token: 't',
      path: '/x',
      maxPages: 1,
      deadline: Date.now() - 1,
      fetchImpl: async () => fakeResponse(200, []),
    }),
    /ran out/
  )
  // A response without readable headers.
  await assert.rejects(
    githubList({
      apiUrl: API,
      token: 't',
      path: '/x',
      maxPages: 1,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
    }),
    /no readable headers/
  )
})

test('only this pull request may come from its head branch, and its base never changed', () => {
  const context = {
    pullRequest: '42',
    headBranch: 'feature/same-tree',
    headRepositoryId: REPOSITORY_ID,
  }
  const ours = {
    number: 42,
    head: { ref: 'feature/same-tree', repo: { id: Number(REPOSITORY_ID) } },
  }
  assert.equal(headPullsProblem([ours], context), null)
  for (const pulls of [
    [],
    [ours, { ...ours, number: 43 }],
    [{ ...ours, number: 7 }, ours],
    [{ ...ours, number: 43 }],
    [{ ...ours, number: '42' }],
    [{ ...ours, head: { ...ours.head, ref: 'other' } }],
    [{ ...ours, head: { ref: 'feature/same-tree', repo: null } }],
    [{ ...ours, head: { ref: 'feature/same-tree', repo: { id: REPOSITORY_ID } } }],
    [null],
    null,
    { 0: ours, length: 1 },
  ]) {
    assert.notEqual(headPullsProblem(pulls, context), null, JSON.stringify(pulls))
  }

  for (const listing of ['timeline', 'issue events']) {
    const check = events => eventsProblem(events, context, listing)
    assert.equal(check([]), null)
    // Events about the head that do not delete or restore it, and events
    // that only contain the words, change neither the base nor the branch.
    const other = [
      'committed',
      'reviewed',
      'head_ref_force_pushed',
      'closed',
      'reopened',
      'merged',
      'base',
      'base_ref',
      'rebase_ref_changed',
      'automatic_base_change',
      'head_ref',
      'head_ref_deleted_later',
      'convert_to_draft',
    ]
    assert.equal(check(other.map(event => ({ event }))), null, listing)
    // Every event named for the base turns skipping off, by prefix: the names
    // seen in this organization, and any other GitHub may add.
    for (const event of [
      'base_ref_changed',
      'base_ref_force_pushed',
      'base_ref_deleted',
      'automatic_base_change_succeeded',
      'automatic_base_change_failed',
      'base_ref_restored',
      'automatic_base_change_queued',
    ]) {
      assert.equal(
        check([...other.map(name => ({ event: name })), { id: 35054321753, event }]),
        `[base unchanged] ${event} (event 35054321753) is in pull request #42's ${listing}`,
        event
      )
    }
    // A deleted or restored head branch, by exact name.
    for (const event of ['head_ref_deleted', 'head_ref_restored']) {
      assert.equal(
        check([...other.map(name => ({ event: name })), { event }]),
        `[head branch kept] ${event} is in pull request #42's ${listing}`,
        event
      )
      assert.match(check([{ id: 7, event }]), /\] head_ref_\w+ \(event 7\) is in /)
    }
    // An id that is not a whole number is not quoted as one.
    assert.match(check([{ id: '7', event: 'base_ref_changed' }]), /\] base_ref_changed is in /)
    for (const events of [
      [{ event: 'committed' }, { event: 'base_ref_force_pushed' }],
      [{ id: 1 }],
      [{ event: 7 }],
      [null],
      ['base_ref_changed'],
      null,
      {},
    ]) {
      assert.match(
        check(events) ?? '',
        /^\[(base unchanged|base unchanged, head branch kept)\] /,
        JSON.stringify(events)
      )
    }
  }
})

test('the run a marker names was created strictly after this pull request', () => {
  const where = { runId: RUN, pullRequest: '42' }
  const ok = runRecordFor()
  const pull = pullFor(42)
  assert.equal(creationProblem(ok, pull, where), null)
  assert.equal(
    creationProblem(runRecordFor(RUN, 1, { created_at: '2026-11-01T00:00:01Z' }), pull, where),
    null
  )
  const refused = [
    // Before the pull request, or in the same second.
    [{ created_at: '2026-10-31T23:59:59Z' }, {}],
    [{ created_at: PULL_CREATED }, {}],
    [{}, { created_at: RUN_CREATED }],
    [{}, { created_at: '2026-11-03T00:00:00Z' }],
    // Unreadable on either side.
    [{ created_at: undefined }, {}],
    [{ created_at: null }, {}],
    [{ created_at: 1794427138 }, {}],
    [{ created_at: '2026-11-02' }, {}],
    [{ created_at: '2026-11-02T00:00:00+00:00' }, {}],
    [{ created_at: '2026-11-02T00:00:00.000Z' }, {}],
    [{ created_at: '2026-02-30T00:00:00Z' }, {}],
    [{}, { created_at: undefined }],
    [{}, { created_at: '' }],
    [{}, { created_at: '2026-11-01T24:00:00Z' }],
  ]
  for (const [runOverrides, pullOverrides] of refused) {
    assert.match(
      creationProblem(runRecordFor(RUN, 1, runOverrides), { ...pull, ...pullOverrides }, where) ??
        '',
      /^\[run after the pull request\] /,
      JSON.stringify([runOverrides, pullOverrides])
    )
  }
  assert.equal(
    creationProblem(runRecordFor(RUN, 1, { created_at: PULL_CREATED }), pull, where),
    '[run after the pull request] run 1001 was created at 2026-11-01T00:00:00Z, not after pull request #42 (2026-11-01T00:00:00Z)'
  )
  assert.match(creationProblem(null, pull, where), /run 1001 has no readable created_at \(null\)/)
  assert.match(creationProblem(ok, null, where), /#42 has no readable created_at \(null\)/)
})

test('GitHub timestamps are read exactly, and anything else is unreadable', () => {
  assert.equal(githubTime('2026-11-11T19:58:58Z'), Date.UTC(2026, 10, 11, 19, 58, 58))
  assert.equal(githubTime('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29))
  for (const value of [
    '2026-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-11-11T24:00:00Z',
    '2026-11-11T19:58:60Z',
    '2026-11-11T19:58:58.000Z',
    '2026-11-11T19:58:58+00:00',
    '2026-11-11 19:58:58Z',
    ' 2026-11-11T19:58:58Z',
    '2026-11-11T19:58:58Z\n',
    '',
    null,
    undefined,
    1794427138000,
    {},
    ['2026-11-11T19:58:58Z'],
    { toString: () => '2026-11-11T19:58:58Z' },
  ]) {
    assert.equal(githubTime(value), null, JSON.stringify(value))
  }
})

test('no run of this tree failed, was cancelled or is still going since the vouching run', () => {
  const since = githubTime(RUN_CREATED)
  const checkListing = (runs, context = CONTEXT) =>
    laterRunsProblem(runs, { runId: RUN, runAttempt: '1', since, context })
  // A listing as GitHub serves it holds the vouching run, as it passed.
  const check = (runs, context) =>
    checkListing(Array.isArray(runs) ? [runRecordFor(RUN), ...runs] : runs, context)
  assert.equal(checkListing(laterRuns()), null)
  assert.equal(check([]), null)
  const later = (id, overrides) =>
    runRecordFor(id, 1, {
      created_at: '2026-11-03T00:00:00Z',
      run_started_at: '2026-11-03T00:00:00Z',
      ...overrides,
    })
  const refused = {
    'a later failure': [later('1800', { conclusion: 'failure' })],
    'a later cancelled run': [later('1800', { conclusion: 'cancelled' })],
    'a later timed-out run': [later('1800', { conclusion: 'timed_out' })],
    'a later skipped run': [later('1800', { conclusion: 'skipped' })],
    'a later run with no conclusion': [later('1800', { conclusion: null })],
    'a later run still going': [later('1800', { status: 'in_progress', conclusion: null })],
    'a later run queued': [later('1800', { status: 'queued', conclusion: null })],
    'a later run without a status': [later('1800', { status: undefined })],
    // Created in the same second as the vouching run.
    'a failure in the same second': [
      later('1800', {
        conclusion: 'failure',
        created_at: RUN_CREATED,
        run_started_at: RUN_CREATED,
      }),
    ],
    // An earlier run re-run since: created before, its latest attempt after.
    'an earlier run re-run since that failed': [
      later('900', { conclusion: 'failure', created_at: '2026-11-01T12:00:00Z' }),
    ],
    // A tie on either time alone: created in the same second, or re-run then.
    'a failure created in the same second, started earlier': [
      later('1800', {
        conclusion: 'failure',
        created_at: RUN_CREATED,
        run_started_at: '2026-11-01T12:00:00Z',
      }),
    ],
    'an earlier failure re-run in the same second': [
      later('900', {
        conclusion: 'failure',
        created_at: '2026-11-01T12:00:00Z',
        run_started_at: RUN_CREATED,
      }),
    ],
    // An earlier run whose latest attempt's start cannot be read may have
    // been re-run since.
    'an earlier failure whose re-run time is unreadable': [
      later('900', {
        conclusion: 'failure',
        created_at: '2026-11-01T12:00:00Z',
        run_started_at: null,
      }),
    ],
    'a failure whose creation is later than its start': [
      later('1800', { conclusion: 'failure', run_started_at: '2026-11-01T12:00:00Z' }),
    ],
    // An earlier run still going, whenever it was created.
    'an earlier run still going': [
      later('900', {
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-11-01T12:00:00Z',
        run_started_at: '2026-11-01T12:00:00Z',
      }),
    ],
    // A failure whose times are unreadable.
    'a failure without run_started_at': [
      later('1800', { conclusion: 'failure', run_started_at: null }),
    ],
    'a failure with a malformed created_at': [
      later('1800', { conclusion: 'failure', created_at: '2026-11-03' }),
    ],
    // A listing that is not what was asked for, or not readable.
    'a run of another branch': [later('1800', { head_branch: 'other' })],
    'a run of a push': [later('1800', { event: 'push' })],
    'a run of another workflow': [later('1800', { path: '.github/workflows/pqc.yml' })],
    'a run without an ID': [later('1800', { id: '1800' })],
    'a run without a head tree': [later('1800', { head_commit: null })],
    'a run with a short head tree': [later('1800', { head_commit: { tree_id: 'c'.repeat(39) } })],
    'an entry that is not a run': [null],
    'a listing that is not a list': { workflow_runs: [] },
  }
  for (const [name, runs] of Object.entries(refused)) {
    assert.match(check(runs) ?? '', /^\[no later failure\] /, name)
  }
  assert.equal(
    check([later('1800', { conclusion: 'failure' })]),
    '[no later failure] run 1800 of this tree ended "failure" in an attempt started at 2026-11-03T00:00:00Z, after run 1001 was created'
  )
  assert.equal(
    check([later('1800', { status: 'in_progress', conclusion: null })]),
    '[no later failure] run 1800 of this tree is "in_progress", not completed'
  )
  // The vouching run is read again: listed for this tree, at the attempt the
  // marker names. A re-run started while the decision was under way shows
  // here at a later attempt and refuses, whatever that attempt shows. Its
  // status and conclusion are not judged: its jobs were (both attempts), and
  // Dependency policy, the one job outside them, runs again in this run.
  const vouching = overrides => checkListing([runRecordFor(RUN, 1, overrides)])
  const vouches = {
    'completed with success': {},
    'the same attempt still in progress': { status: 'in_progress', conclusion: null },
    'the same attempt queued': { status: 'queued', conclusion: null },
    'the same attempt failed (Dependency policy)': { conclusion: 'failure' },
    'the same attempt cancelled after it saved': { conclusion: 'cancelled' },
    'the same attempt with no status': { status: undefined, conclusion: undefined },
  }
  for (const [name, overrides] of Object.entries(vouches)) {
    assert.equal(vouching(overrides), null, name)
  }
  const vouchingRefused = {
    'a later attempt that passed': { run_attempt: 2 },
    'a later attempt still going': { run_attempt: 2, status: 'in_progress', conclusion: null },
    'a later attempt that failed': { run_attempt: 2, conclusion: 'failure' },
    'a later attempt cancelled': { run_attempt: 3, conclusion: 'cancelled' },
    'an earlier attempt': { run_attempt: 0 },
    'an attempt as a string': { run_attempt: '1' },
    'no attempt': { run_attempt: undefined },
    'a null attempt': { run_attempt: null },
  }
  for (const [name, overrides] of Object.entries(vouchingRefused)) {
    assert.match(vouching(overrides) ?? '', /^\[no later failure\] run 1001 is listed at /, name)
  }
  assert.equal(
    vouching({ run_attempt: 2, status: 'in_progress', conclusion: null }),
    '[no later failure] run 1001 is listed at attempt 2, not attempt 1: it was re-run after its record was read'
  )
  assert.equal(
    vouching({ head_commit: { tree_id: OTHER_TREE } }),
    `[no later failure] run 1001 is listed with head tree ${OTHER_TREE}, not ${HEAD_TREE}`
  )
  // A listing that does not show the vouching run is not the whole listing.
  assert.equal(checkListing([]), '[no later failure] the run listing does not show run 1001')
  assert.equal(
    checkListing(laterRuns().filter(listed => listed.id !== Number(RUN))),
    '[no later failure] the run listing does not show run 1001'
  )
  // This run is not judged here, whatever it says.
  assert.equal(check([later('2002', { status: 'in_progress', conclusion: null })]), null)
  assert.notEqual(
    check([later('2002', { status: 'in_progress', conclusion: null })], {
      ...CONTEXT,
      currentRunId: '2003',
    }),
    null
  )

  // A re-run of this run never skips: its earlier attempts are not read.
  assert.equal(rerunProblem(CONTEXT), null)
  assert.equal(
    rerunProblem({ ...CONTEXT, currentRunAttempt: '2' }),
    '[no later failure] this is attempt 2 of run 2002, whose earlier attempts are not read'
  )
  for (const currentRunAttempt of ['3', '', undefined, 1]) {
    assert.notEqual(rerunProblem({ ...CONTEXT, currentRunAttempt }), null)
  }
})

test('the record step writes the marker once, and only for a full pass of this tree with the label off', async t => {
  const repo = pullRequestFixture(t)
  const prefix = prefixFor(repo, repo.merge)
  const temp = scratch(t, 'tree-pass-record-')
  const outputFile = join(temp, 'output')
  const env = runEnvironment(repo.merge, {
    GITHUB_RUN_ID: '1001',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: join(temp, 'summary'),
    TREE_PASS_NEEDS: JSON.stringify(needsFor({ decideOutputs: { prefix } })),
    TREE_PASS_MARKER_DIR: join(temp, 'marker'),
  })
  const record = async (extra = {}, fetchImpl = labelsFetch(['bug'])) => {
    rmSync(outputFile, { force: true })
    const { lines, log } = messages()
    const result = await runRecord({ ...env, ...extra }, { cwd: repo.dir, fetchImpl, log })
    return { result, lines, written: outputs(outputFile) }
  }

  const recorded = await record()
  const key = `${prefix}1001-2`
  assert.equal(recorded.result.ok, true)
  assert.deepEqual(recorded.written, { ok: 'true', key, artifact: artifactName(key) })
  assert.equal(recorded.result.marker.runAttempt, '2')
  assert.deepEqual(recorded.result.marker.covered, ['lint', 'verify'])
  assert.deepEqual(
    JSON.parse(readFileSync(join(temp, 'marker', 'marker.json'), 'utf8')),
    recorded.result.marker
  )
  // A second write into the same directory is refused, not merged.
  await assert.rejects(record(), /already exists/)

  // Doubts a correct run can meet: a warning and ok=false, never a red run.
  const declined = [
    [{ TREE_PASS_REPOSITORY_SALT: '9' }, labelsFetch([]), /a salt changed during the run/],
    // tree-pass computed its prefix with other salts.
    [
      { TREE_PASS_NEEDS: JSON.stringify(needsFor({ decideOutputs: { prefix: PREFIX } })) },
      labelsFetch([]),
      /a salt changed during the run/,
    ],
    [{ TREE_PASS_WORKFLOW_SALT: 'one' }, labelsFetch([]), /cannot be computed/],
    [{}, labelsFetch([FORCE_LABEL]), /the ci:full-run label is on the pull request/],
    [{}, labelsFetch(['CI:FULL-RUN']), /label is on the pull request/],
    [{}, async () => fakeResponse(502, {}), /labels could not be read/],
  ]
  for (const [index, [extra, fetchImpl, reason]] of declined.entries()) {
    const markerDir = join(temp, `declined-${index}`)
    const result = await record({ ...extra, TREE_PASS_MARKER_DIR: markerDir }, fetchImpl)
    assert.deepEqual(result.written, { ok: 'false' }, JSON.stringify(extra))
    assert.match(
      result.lines.join('\n'),
      /^::warning title=Tree pass marker::Not recording a tree pass: /m
    )
    assert.match(result.result.reason, reason)
    assert.ok(!existsSync(markerDir), JSON.stringify(extra))
  }

  // Wiring errors fail the step.
  const refusals = [
    { TREE_PASS_NEEDS: '' },
    { TREE_PASS_NEEDS: '{' },
    {
      TREE_PASS_NEEDS: JSON.stringify(
        needsFor({
          decideOutputs: { prefix },
          jobs: { verify: { result: 'success', outputs: {} } },
        })
      ),
    },
    { TREE_PASS_NEEDS: JSON.stringify(needsFor({ decideOutputs: { prefix: '' } })) },
    { TREE_PASS_MARKER_DIR: 'relative/marker' },
    { TREE_PASS_MARKER_DIR: '' },
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ATTEMPT: '0' },
  ]
  for (const [index, extra] of refusals.entries()) {
    const markerDir = extra.TREE_PASS_MARKER_DIR ?? join(temp, `refused-${index}`)
    await assert.rejects(
      record({ ...extra, TREE_PASS_MARKER_DIR: markerDir }),
      undefined,
      JSON.stringify(extra)
    )
    if (markerDir.startsWith('/')) assert.ok(!existsSync(markerDir), JSON.stringify(extra))
    assert.equal(outputs(outputFile).ok, undefined, JSON.stringify(extra))
  }
})

// The decide step in a process of its own, as a workflow step runs it, so no
// other test's timers keep its event loop alive. `fetchMode` picks the
// request GitHub never answers: one that waits on its signal only, one that
// ignores the signal, or one that fails at once.
const DECIDE_CHILD = `
const { runDecide } = await import(process.argv[1])
const mode = process.env.TREE_PASS_TEST_FETCH
const fetchImpl = {
  hang: (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  deaf: () => new Promise(() => {}),
  fail: async () => ({ ok: false, status: 502 }),
}[mode]
const budgetMs = process.env.TREE_PASS_TEST_BUDGET ? Number(process.env.TREE_PASS_TEST_BUDGET) : undefined
await runDecide(process.env, { fetchImpl, budgetMs })
`

function decideInChild(t, fetchMode, budgetMs) {
  const outputFile = join(scratch(t, 'tree-pass-child-'), 'output')
  const env = {
    PATH: process.env.PATH,
    ...decideEnvironment({ GITHUB_OUTPUT: outputFile }),
    TREE_PASS_TEST_FETCH: fetchMode,
    ...(budgetMs === undefined ? {} : { TREE_PASS_TEST_BUDGET: String(budgetMs) }),
  }
  const started = Date.now()
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', DECIDE_CHILD, pathToFileURL(script).href],
    { env, encoding: 'utf8', timeout: 60_000 }
  )
  return { ...result, elapsed: Date.now() - started, written: outputs(outputFile) }
}

test('a decide step whose request never answers ends in a full run, in a process of its own', t => {
  const full = { skip: 'false', save: 'true', 'run-url': '' }
  // Nothing but the request's own timer keeps the event loop alive: it must,
  // or Node ends the step with exit 13 (an unsettled top-level await) and no
  // answer.
  for (const fetchMode of ['hang', 'deaf']) {
    const result = decideInChild(t, fetchMode, 300)
    assert.equal(result.status, 0, `${fetchMode}: ${result.stderr}`)
    assert.deepEqual(result.written, full, fetchMode)
    assert.match(
      result.stdout,
      /Running every job: GitHub's record of run 1001 could not be checked: GET \/repos\/Qbit-Org\/qbit-wallet\/actions\/runs\/1001 timed out after \d+ ms/,
      fetchMode
    )
    assert.ok(result.elapsed < 10_000, `${fetchMode}: ${result.elapsed} ms`)
  }
  // A request that settles leaves no timer behind: the step does not wait out
  // the 15 seconds the request was allowed.
  const failed = decideInChild(t, 'fail')
  assert.equal(failed.status, 0, failed.stderr)
  assert.deepEqual(failed.written, full)
  assert.match(failed.stdout, /returned HTTP 502/)
  assert.ok(failed.elapsed < 5_000, `${failed.elapsed} ms`)
})

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  })
}

test('the command line runs each mode and fails closed', t => {
  const repo = pullRequestFixture(t)
  const temp = scratch(t, 'tree-pass-cli-')
  const outputFile = join(temp, 'output')
  const base = runEnvironment(repo.merge, {
    GITHUB_OUTPUT: outputFile,
    TREE_PASS_HEAD_SHA: repo.head,
  })

  // A push never uses markers, reads no labels and ignores a bad salt.
  let result = cli(
    ['key'],
    { ...base, GITHUB_EVENT_NAME: 'push', TREE_PASS_WORKFLOW_SALT: '01' },
    repo.dir
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(outputs(outputFile), { eligible: 'false' })

  // A pull request whose labels cannot be read runs in full, with a warning.
  rmSync(outputFile)
  result = cli(['key'], { ...base, GITHUB_API_URL: 'https://127.0.0.1:9' }, repo.dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(outputs(outputFile), { eligible: 'false' })
  assert.match(result.stdout, /^::warning title=Tree pass marker::Running in full: /m)

  // An unreachable API in decide runs everything.
  rmSync(outputFile)
  result = cli(
    ['decide'],
    { ...decideEnvironment({ GITHUB_OUTPUT: outputFile, GITHUB_API_URL: 'https://127.0.0.1:9' }) },
    temp
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(outputs(outputFile), { skip: 'false', save: 'true', 'run-url': '' })
  for (const [extra, expected] of [
    [{ TREE_PASS_MATCHED_KEY: '' }, { skip: 'false', save: 'true', 'run-url': '' }],
    [{ TREE_PASS_ELIGIBLE: 'false' }, { skip: 'false', save: 'false', 'run-url': '' }],
  ]) {
    rmSync(outputFile, { force: true })
    result = cli(['decide'], decideEnvironment({ GITHUB_OUTPUT: outputFile, ...extra }), temp)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(outputs(outputFile), expected, JSON.stringify(extra))
  }

  for (const args of [[], ['save'], ['key', 'extra']]) {
    result = cli(args, base, repo.dir)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.stdout, /^::error title=Tree pass marker::/m)
  }
})

// --- The workflow wiring -------------------------------------------------

const MARKER_PATH = '${{ runner.temp }}/tree-pass-marker'
const SKIP_STEP = "steps.gate.outputs.skip != 'true'"
// The gate step, whose summary says what a hit, or a docs-only change
// (docs-only-change.mjs), does to its job: a gated job skips its steps; a job
// that aggregates shards or lanes still checks them. `docsConsequence` is
// null for a job that a docs-only change does not skip, whose gate has no
// docs-only branch.
// `waitSummary` is null for every gate but that of a job that reports while
// the run waits for a signed head; that gate's last branch sets `wait`, never
// `skip`, and says how to run G3.
// `docsChange` is what the docs-only branch says the pull request changes:
// where a version bump counts as docs-only too (`versionBump` below), it says
// so.
const DOCS_CHANGE = 'changes only documentation that no skipped step reads'
const VERSION_DOCS_CHANGE = `${DOCS_CHANGE}, or only that and the extension version`
const gateRun = (
  consequence,
  docsConsequence = consequence,
  waitSummary = null,
  docsChange = DOCS_CHANGE
) => `if [ "$MARKER_JOB_RESULT" = success ] && [ "$MARKER_SKIP" = true ]; then
  echo 'skip=true' >> "$GITHUB_OUTPUT"
  echo "This tree already passed this job in $MARKER_RUN_URL, ${consequence}" >> "$GITHUB_STEP_SUMMARY"
${
  docsConsequence === null
    ? ''
    : `elif [ "$MARKER_JOB_RESULT" = success ] && [ "$DOCS_ONLY" = true ]; then
  echo 'skip=true' >> "$GITHUB_OUTPUT"
  echo "This pull request ${docsChange}, ${docsConsequence} Add the $TREE_PASS_FORCE_LABEL label and re-run all jobs to run everything." >> "$GITHUB_STEP_SUMMARY"
`
}${
  waitSummary === null
    ? ''
    : `elif [ "$MARKER_JOB_RESULT" = success ] && [ "$SIGNED_HEAD_WAIT" = true ]; then
  echo 'wait=true' >> "$GITHUB_OUTPUT"
  echo "${waitSummary}" >> "$GITHUB_STEP_SUMMARY"
`
}fi
`
const GATE_RUN = gateRun('so its steps are skipped.')
// The same gate where a version bump counts as docs-only.
const VERSION_GATE_RUN = gateRun('so its steps are skipped.', undefined, null, VERSION_DOCS_CHANGE)
// A job in `runsOnDocsOnly`: only a marker hit skips it.
const MARKER_ONLY_GATE_RUN = gateRun('so its steps are skipped.', null)
const AGGREGATE_GATE_RUN = gateRun(
  'so the shards skipped their steps; this job still checks that every shard succeeded.'
)
// How to get G3 while the run waits for a signed head, as the step summaries
// and the check step's notice say it.
const HOW_TO_RUN_G3 =
  'To run G3, sign the head commit and push it, or add the $TREE_PASS_FORCE_LABEL label and re-run all jobs.'
// The gate of `Playwright G3 scenarios`, which also tells a run that waits for
// a signed head.
const SIGNED_AGGREGATE_GATE_RUN = gateRun(
  'so the shards skipped their steps; this job still checks that every shard succeeded.',
  undefined,
  "GitHub has not verified the signature of this pull request's head commit, so G3 waits for " +
    `a signed head and no shard started; this job checks that none did. ${HOW_TO_RUN_G3}`,
  VERSION_DOCS_CHANGE
)
const LANE_AGGREGATE_GATE_RUN = gateRun(
  'so the lanes skipped their steps; this job still checks that every lane succeeded.',
  "so the lanes skipped their steps, except 'Typecheck, security checks and other unit tests', " +
    'which ran in full because its security tooling tests read every tracked file; ' +
    'this job still checks that every lane succeeded.'
)
// The command whose tests read every tracked file, documentation included:
// former-owner.test.mjs reads their contents and codeowners.test.mjs their
// names. No allowlist can name a reader that reads everything.
const SECURITY_TOOLING_RUN = /^corepack pnpm run test:security-tooling$/m
// The command that builds the extension package twice and compares the builds.
const REPRODUCIBLE_BUILD_RUN = /^corepack pnpm run build:repro:extension\b/m
const MARKED_WORKFLOWS = {
  '.github/workflows/ci.yml': {
    id: 'ci',
    // Required checks, and the lanes below, keep running and skip their steps.
    stepGated: [
      'verify-extension-tests',
      'verify-wallet-background-tests',
      'verify-workspace',
      'verify-package',
      'verify',
    ],
    // Other covered jobs are skipped whole.
    jobGated: ['lint'],
    // Matrix jobs that each run one shard of a suite, keyed to the step-gated
    // job that needs them and reports their combined result.
    sharded: {},
    // Step-gated jobs that each run one part of a required job's work, keyed
    // to that job, which needs them and reports their combined result. Each
    // is a job of its own with its own `tested`, so the save job needs it
    // directly too.
    lanes: {
      'verify-extension-tests': 'verify',
      'verify-wallet-background-tests': 'verify',
      'verify-workspace': 'verify',
      'verify-package': 'verify',
    },
    // Step-gated jobs that only a marker hit skips, not a docs-only change:
    // the lane that runs the security tooling tests, which read every tracked
    // file, documentation included, so that a required check still runs them
    // on a docs-only change. `Dependency policy` runs them too, but it is not
    // required. The wiring test ties this list to the jobs that run them.
    runsOnDocsOnly: ['verify-workspace'],
    // Whether a version bump counts as a docs-only change
    // (DOCS_ONLY_VERSION_BUMP). Not here: these lanes build and package the
    // extension under its version, and check the built manifest's version
    // against package.json.
    versionBump: false,
    // Never covered: they run on every event. `Package versions applied`
    // judges a commit against its first parent, so a tree that passed for
    // one base says nothing about another.
    uncovered: ['dependency-policy', 'package-versions'],
    // ci.yml never waits for a signed head.
    signedHead: null,
  },
  '.github/workflows/playwright-release-gate.yml': {
    id: 'browser-release-gate',
    stepGated: ['playwright-release-gate'],
    jobGated: [],
    sharded: { 'playwright-g3-shard': 'playwright-release-gate' },
    lanes: {},
    runsOnDocsOnly: [],
    // No scenario depends on which version the extension has.
    versionBump: true,
    uncovered: [],
    // G3 waits for a signed head (signed-head-gate.mjs): the sharded job is
    // skipped whole, and the job that aggregates it reports under another
    // name. These, and the save job, are the only places where its wiring
    // differs from ci.yml's; the wiring test names each one.
    signedHead: { sharded: 'playwright-g3-shard', aggregate: 'playwright-release-gate' },
  },
}
// The run waits for a signed head: the marker job succeeded and said so.
const SIGNED_HEAD_WAIT =
  "needs.tree-pass.result == 'success' && needs.tree-pass.outputs.signed-head-wait == 'true'"
const REQUIRED_G3 = 'Playwright G3 scenarios'
const WAITING_G3 = 'Playwright G3 scenarios (waits for a signed head)'
// The sharded job's condition: not in a cancelled run, and not while the run
// waits for a signed head, when the whole matrix is skipped.
const SIGNED_SHARD_IF = `\${{ !cancelled() && !(${SIGNED_HEAD_WAIT}) }}`
// The aggregating job's name: the required check's, except while waiting.
const SIGNED_AGGREGATE_NAME = `\${{ ${SIGNED_HEAD_WAIT} && '${WAITING_G3}' || '${REQUIRED_G3}' }}`
const SAVE_IF =
  "needs.tree-pass.outputs.save == 'true' && needs.tree-pass.outputs.docs-only != 'true'"
const SIGNED_SAVE_IF = `${SAVE_IF} && needs.tree-pass.outputs.signed-head-wait != 'true'`
// The aggregating job records nothing while waiting.
const SIGNED_TESTED_IF = `${SKIP_STEP} && steps.gate.outputs.wait != 'true'`
// A shard leg's matrix value, its one run of the suite, and its own output.
const SHARD_MATRIX_VALUE = '${{ matrix.shard }}'
const SHARD_SUITE_RUN = total =>
  `xvfb-run --auto-servernum corepack pnpm exec playwright test --shard="$G3_SHARD/${total}"`
const SHARD_TESTED_RUN = `echo "tested-$G3_SHARD=true" >> "$GITHUB_OUTPUT"`
const SHARD_ARTIFACT =
  'playwright-release-gate-${{ github.run_id }}-${{ github.run_attempt }}-shard-${{ matrix.shard }}'
// The aggregating job's check of its shards, after its gate.
const SHARD_CHECK_NAME = 'Check every shard ran and passed'
const SHARD_CHECK_RUN = total => `status=0
if [ "$SHARDS_RESULT" != success ]; then
  echo "::error::The shards' result is \\"$SHARDS_RESULT\\", not success; see each shard's job."
  status=1
fi
if [ "$MARKER_HIT" != true ]; then
  for shard in ${shardRange(total).join(' ')}; do
    tested="SHARD_\${shard}_TESTED"
    if [ "\${!tested}" != true ]; then
      echo "::error::Shard $shard of ${total} did not run all its steps."
      status=1
    fi
  done
fi
exit "$status"
`
// The same check where the run can wait for a signed head: then the shards'
// result must be skipped and no shard may have recorded anything. Otherwise
// it is the check above, unchanged.
const SIGNED_SHARD_CHECK_RUN = total => `status=0
if [ "$SIGNED_HEAD_WAIT" = true ]; then
  if [ "$SHARDS_RESULT" != skipped ]; then
    echo "::error::This run waits for a signed head, so the shards should have been skipped, but their result is \\"$SHARDS_RESULT\\"."
    status=1
  fi
  for shard in ${shardRange(total).join(' ')}; do
    tested="SHARD_\${shard}_TESTED"
    if [ -n "\${!tested}" ]; then
      echo "::error::Shard $shard of ${total} recorded that it ran, though this run waits for a signed head."
      status=1
    fi
  done
  if [ "$status" = 0 ]; then
    echo "::notice::G3 waits for a signed head. ${HOW_TO_RUN_G3}"
  fi
  exit "$status"
fi
${SHARD_CHECK_RUN(total).slice('status=0\n'.length)}`

function shardRange(total) {
  return Array.from({ length: total }, (_, index) => index + 1)
}

// The shards of a sharded job: its matrix is exactly `shard: [1, …, n]` with
// fail-fast off, and n is the total that every other place must use.
function shardsOf(entry, at) {
  assert.deepEqual(Object.keys(entry.strategy ?? {}).sort(), ['fail-fast', 'matrix'], at)
  assert.equal(entry.strategy['fail-fast'], false, `${at}: every shard must finish`)
  assert.deepEqual(Object.keys(entry.strategy.matrix ?? {}), ['shard'], at)
  const shards = entry.strategy.matrix.shard
  assert.ok(Array.isArray(shards) && shards.length >= 2, `${at}: at least two shards`)
  assert.deepEqual(
    shards,
    shardRange(shards.length),
    `${at}: the shards must be 1 to ${shards.length}`
  )
  return shards
}

// The name GitHub gives each leg of a sharded job, which decide looks for.
function shardJobNames(entry) {
  const shards = entry.strategy?.matrix?.shard ?? []
  return shards.map(shard => entry.name.replaceAll(SHARD_MATRIX_VALUE, String(shard)))
}

function shardedJobsOf(expected, aggregate) {
  return Object.entries(expected.sharded)
    .filter(([, name]) => name === aggregate)
    .map(([name]) => name)
}

function laneJobsOf(expected, aggregate) {
  return Object.entries(expected.lanes)
    .filter(([, name]) => name === aggregate)
    .map(([name]) => name)
}

// The jobs whose combined result a step-gated job reports: its shards or its
// lanes.
function partsOf(expected, aggregate) {
  return [...shardedJobsOf(expected, aggregate), ...laneJobsOf(expected, aggregate)]
}

// The aggregating job's check of its lanes, after its gate. It names each
// lane as GitHub names the lane's job, and reads the lane's result and
// `tested` from variables named for its job ID.
const LANE_CHECK_NAME = 'Check every lane ran and passed'
const laneVariable = id => id.toUpperCase().replaceAll('-', '_')
const LANE_CHECK_RUN = lanes => `status=0
fail() {
  echo "::error::$1"
  echo "- $1" >> "$GITHUB_STEP_SUMMARY"
  status=1
}
check_lane() {
  if [ "$2" != success ]; then
    fail "Lane \\"$1\\": its result is \\"$2\\", not success; see its job."
  elif [ "$MARKER_HIT" != true ] && [ "$3" != true ]; then
    fail "Lane \\"$1\\" did not run all its steps."
  fi
}
${lanes
  .map(
    ({ id, name }) =>
      `check_lane '${name}' "$${laneVariable(id)}_RESULT" "$${laneVariable(id)}_TESTED"`
  )
  .join('\n')}
exit "$status"
`

// The job-level condition of a job that always reports a result. A required
// job that waits only for the marker job runs unless the run is cancelled,
// and GitHub then reports it cancelled, not skipped (the doc cites the runs).
// One that aggregates shards or lanes runs even in a cancelled run, so the
// check does not depend on how GitHub reports a job that never started there:
// its check step fails unless every shard or lane succeeded. A leg or lane
// that hits its timeout ends cancelled without making `cancelled()` true for
// the jobs that need it, so that case alone would not need `always()`.
function requiredJobIf(expected, name) {
  return partsOf(expected, name).length > 0 ? '${{ always() }}' : '${{ !cancelled() }}'
}
// Ruleset main-protection (26062908) requires these contexts on main.
const REQUIRED_CONTEXTS = ['Typecheck, test, and build', 'Playwright G3 scenarios']
// The signed-head step's settings, each read by signed-head-gate.mjs; the
// force label comes from the workflow's env, the rest from the runner.
const SIGNED_HEAD_STEP_ENV = {
  GH_TOKEN: '${{ github.token }}',
  TREE_PASS_PR_NUMBER: '${{ github.event.pull_request.number }}',
  TREE_PASS_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
  TREE_PASS_MARKER_SKIP: '${{ steps.decide.outputs.skip }}',
  TREE_PASS_DOCS_ONLY: '${{ steps.docs-only.outputs.docs-only }}',
}

function readWorkflow(file) {
  return YAML.parse(readFileSync(join(repoRoot, file), 'utf8'))
}

// Steps with every local composite action (`uses: ./path`) replaced by the
// steps it runs, read from the working tree.
function inlineLocalActions(steps, chain = []) {
  return steps.flatMap(step => {
    const uses = typeof step?.uses === 'string' ? step.uses : ''
    if (!uses.startsWith('./')) return [step]
    const path = uses.slice(2).replace(/\/+$/, '')
    assert.ok(!path.split('/').includes('..') && !chain.includes(path), uses)
    const file = ['action.yml', 'action.yaml']
      .map(name => join(repoRoot, path, name))
      .find(candidate => existsSync(candidate))
    assert.ok(file, `local action ${uses} has no action.yml`)
    const definition = YAML.parse(readFileSync(file, 'utf8'))
    if (definition?.runs?.using !== 'composite') return [step]
    return inlineLocalActions(definition.runs.steps ?? [], [...chain, path])
  })
}

function trackedFiles(pattern) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => pattern.test(file))
}

function trackedWorkflows() {
  return execFileSync('git', ['ls-files', '-z', '--', '.github/workflows'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(file => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))
}

function actionPin(action) {
  const pins = new Set()
  for (const file of trackedWorkflows()) {
    const text = readFileSync(join(repoRoot, file), 'utf8')
    const pattern = new RegExp(`uses: ${action.replace('/', '\\/')}@([0-9a-f]{40})`, 'g')
    for (const [, sha] of text.matchAll(pattern)) pins.add(sha)
  }
  assert.equal(pins.size, 1, `expected one ${action} pin, found ${[...pins].join(', ')}`)
  return [...pins][0]
}

test('each marked workflow wires the lookup, the gates and the save the same way', () => {
  const cachePin = actionPin('actions/cache')
  const uploadPin = actionPin('actions/upload-artifact')
  const ids = new Set()
  for (const [file, expected] of Object.entries(MARKED_WORKFLOWS)) {
    const workflow = readWorkflow(file)
    const where = file
    ids.add(workflow.env.TREE_PASS_WORKFLOW)

    // The same pull requests as before, and the push and dispatch that never
    // use markers; no merge queue, whose runs this design does not cover.
    assert.deepEqual(
      Object.keys(workflow.on).sort(),
      ['pull_request', 'push', 'workflow_dispatch'],
      where
    )
    assert.deepEqual(workflow.on.pull_request, { branches: ['main', 'release/**'] }, where)
    assert.deepEqual(workflow.on.push, { branches: ['main'] }, where)
    assert.equal(workflow.env.TREE_PASS_WORKFLOW, expected.id, where)
    assert.match(workflow.env.TREE_PASS_WORKFLOW_SALT, /^(?:0|[1-9][0-9]{0,8})$/, where)
    assert.equal(workflow.env.TREE_PASS_REPOSITORY_SALT, '${{ vars.TREE_PASS_SALT }}', where)
    assert.equal(workflow.env.TREE_PASS_FORCE_LABEL, FORCE_LABEL, where)

    const jobs = workflow.jobs
    const covered = [...expected.stepGated, ...expected.jobGated]
    const sharded = Object.keys(expected.sharded)
    const lookup = jobs[DECIDE_JOB]
    assert.equal(lookup.if, "github.event_name == 'pull_request'", where)
    assert.equal(lookup['runs-on'], 'ubuntu-24.04', `${where}: the lookup must use GitHub's cache`)
    assert.equal(lookup['timeout-minutes'], 10, where)
    assert.equal(lookup['cache-mode'], 'read', where)
    assert.deepEqual(
      lookup.permissions,
      { contents: 'read', 'pull-requests': 'read', actions: 'read' },
      where
    )
    assert.equal(lookup.needs, undefined, where)
    const signedHead = expected.signedHead
    assert.deepEqual(lookup.outputs, {
      prefix: '${{ steps.key.outputs.prefix }}',
      skip: '${{ steps.decide.outputs.skip }}',
      save: '${{ steps.decide.outputs.save }}',
      'run-url': '${{ steps.decide.outputs.run-url }}',
      'docs-only': '${{ steps.docs-only.outputs.docs-only }}',
      // G3 only: whether the run waits for a signed head.
      ...(signedHead ? { 'signed-head-wait': '${{ steps.signed-head.outputs.wait }}' } : {}),
    })
    // No setup-node: the scripts run on the runner image's Node.
    const [checkout, keyStep, lookupStep, decideStep, docsOnlyStep, signedHeadStep] = lookup.steps
    assert.equal(lookup.steps.length, signedHead ? 6 : 5, where)
    assert.match(checkout.uses, /^actions\/checkout@/)
    // The event's commit (no ref), and its parents for the head tree.
    assert.deepEqual(checkout.with, { 'persist-credentials': false, 'fetch-depth': 2 }, where)
    assert.equal(keyStep.id, 'key')
    assert.equal(keyStep.run, 'node scripts/security/tree-pass-marker.mjs key')
    assert.deepEqual(keyStep.env, {
      GH_TOKEN: '${{ github.token }}',
      TREE_PASS_PR_NUMBER: '${{ github.event.pull_request.number }}',
      TREE_PASS_HEAD_REPOSITORY_ID: '${{ github.event.pull_request.head.repo.id }}',
      TREE_PASS_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    })
    assert.equal(lookupStep.id, 'lookup')
    assert.equal(lookupStep.uses, `actions/cache/restore@${cachePin}`, where)
    assert.equal(lookupStep.if, "steps.key.outputs.eligible == 'true'")
    assert.equal(lookupStep['continue-on-error'], true, where)
    assert.equal(lookupStep['timeout-minutes'], 3, where)
    // Lookup-only, by prefix: the entry is never downloaded or extracted.
    assert.deepEqual(lookupStep.with, {
      path: MARKER_PATH,
      key: '${{ steps.key.outputs.prefix }}',
      'restore-keys': '${{ steps.key.outputs.prefix }}',
      'lookup-only': true,
    })
    assert.equal(decideStep.id, 'decide')
    assert.equal(decideStep.if, undefined)
    assert.equal(decideStep.run, 'node scripts/security/tree-pass-marker.mjs decide')
    const { TREE_PASS_COVERED_JOBS: coveredJobs, ...decideEnv } = decideStep.env
    assert.deepEqual(decideEnv, {
      GH_TOKEN: '${{ github.token }}',
      TREE_PASS_ELIGIBLE: '${{ steps.key.outputs.eligible }}',
      TREE_PASS_PREFIX: '${{ steps.key.outputs.prefix }}',
      TREE_PASS_HEAD_TREE: '${{ steps.key.outputs.head-tree }}',
      TREE_PASS_LOOKUP_OUTCOME: '${{ steps.lookup.outcome }}',
      TREE_PASS_MATCHED_KEY: '${{ steps.lookup.outputs.cache-matched-key }}',
      TREE_PASS_PR_NUMBER: '${{ github.event.pull_request.number }}',
      TREE_PASS_HEAD_REPOSITORY_ID: '${{ github.event.pull_request.head.repo.id }}',
      TREE_PASS_HEAD_BRANCH: '${{ github.event.pull_request.head.ref }}',
    })
    // The docs-only check comes last, so it cannot keep the marker's steps
    // from running, and sets the output every gate reads next to skip.
    assert.equal(docsOnlyStep.id, 'docs-only', where)
    assert.equal(docsOnlyStep.if, undefined, where)
    assert.equal(docsOnlyStep['continue-on-error'], undefined, where)
    assert.equal(docsOnlyStep.run, 'node scripts/security/docs-only-change.mjs', where)
    // Only a workflow whose skipped steps do not depend on the extension
    // version lets a version bump count; the others leave the setting unset.
    assert.deepEqual(
      docsOnlyStep.env,
      {
        GH_TOKEN: '${{ github.token }}',
        TREE_PASS_PR_NUMBER: '${{ github.event.pull_request.number }}',
        TREE_PASS_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
        ...(expected.versionBump ? { DOCS_ONLY_VERSION_BUMP: 'true' } : {}),
      },
      where
    )
    // A version bump changes the name and the manifest of the package that
    // the reproducible build makes, so no workflow that makes it lets one
    // count.
    // Nothing else sets it: a step inherits its workflow's and its job's
    // `env`, so the setting anywhere above the step would reach it too.
    const settings = value =>
      value && typeof value === 'object'
        ? Object.entries(value).reduce(
            (count, [key, inner]) =>
              count + (key === 'DOCS_ONLY_VERSION_BUMP' ? 1 : 0) + settings(inner),
            0
          )
        : 0
    assert.equal(
      settings(workflow),
      expected.versionBump ? 1 : 0,
      `${where}: only the docs-only step may set DOCS_ONLY_VERSION_BUMP`
    )
    const buildsPackage = Object.values(jobs).some(job =>
      (job.steps ?? []).some(step => REPRODUCIBLE_BUILD_RUN.test(step.run ?? ''))
    )
    assert.ok(
      !(expected.versionBump && buildsPackage),
      `${where}: a workflow that builds the extension package must not skip on a version bump`
    )
    assert.ok(
      file !== '.github/workflows/ci.yml' || buildsPackage,
      `${where}: the reproducible build was not found, so nothing ties versionBump to it`
    )
    // G3 only: the signed-head check comes after the docs-only check, last,
    // reads both verdicts and sets the output its gates read.
    if (signedHead) {
      assert.equal(signedHeadStep, lookup.steps.at(-1), where)
      assert.equal(signedHeadStep.id, 'signed-head', where)
      assert.equal(signedHeadStep.if, undefined, where)
      assert.equal(signedHeadStep['continue-on-error'], undefined, where)
      assert.equal(signedHeadStep['timeout-minutes'], undefined, where)
      assert.equal(signedHeadStep.run, 'node scripts/security/signed-head-gate.mjs', where)
      assert.deepEqual(signedHeadStep.env, SIGNED_HEAD_STEP_ENV, where)
    } else {
      assert.equal(signedHeadStep, undefined, where)
      assert.doesNotMatch(JSON.stringify(workflow), /signed-head/i, where)
    }
    // decide checks, in the run a marker names, exactly the covered jobs and
    // every leg of each sharded job, by the name GitHub gives the leg; for a
    // job whose name is computed, the name it has in a run that tests.
    assert.deepEqual(
      JSON.parse(coveredJobs).sort(),
      [
        ...covered.map(name => testingNameOf(jobs[name])),
        ...sharded.flatMap(name => shardJobNames(jobs[name])),
      ].sort(),
      where
    )

    // The save job needs every covered job. A sharded job reaches it through
    // the job that aggregates it, which is covered, needs it and is the only
    // job that does: the save job's record step reads one `tested` output per
    // job it needs, and a matrix job's legs each set their own.
    const save = jobs[SAVE_JOB]
    assert.equal(save.name, SAVE_JOB_NAME, where)
    assert.deepEqual([...save.needs].sort(), [DECIDE_JOB, ...covered].sort(), where)
    // A docs-only run skipped the covered jobs' steps: nothing to record. In
    // G3 only, neither has a run that waits for a signed head.
    assert.equal(save.if, signedHead ? SIGNED_SAVE_IF : SAVE_IF, where)
    assert.equal(save['runs-on'], 'ubuntu-24.04', where)
    assert.equal(save['timeout-minutes'], 10, where)
    assert.equal(save['cache-mode'], 'write-only', where)
    assert.deepEqual(save.permissions, { contents: 'read', 'pull-requests': 'read' }, where)
    const [saveCheckout, recordStep, uploadStep, saveStep] = save.steps
    assert.equal(save.steps.length, 4, where)
    assert.match(saveCheckout.uses, /^actions\/checkout@/)
    assert.deepEqual(saveCheckout.with, { 'persist-credentials': false }, where)
    assert.equal(recordStep.id, 'record')
    assert.equal(recordStep.if, undefined)
    assert.equal(recordStep.run, 'node scripts/security/tree-pass-marker.mjs record')
    assert.deepEqual(recordStep.env, {
      GH_TOKEN: '${{ github.token }}',
      TREE_PASS_NEEDS: '${{ toJSON(needs) }}',
      TREE_PASS_PR_NUMBER: '${{ github.event.pull_request.number }}',
      TREE_PASS_MARKER_DIR: MARKER_PATH,
    })
    assert.equal(uploadStep.id, 'upload')
    assert.equal(uploadStep.uses, `actions/upload-artifact@${uploadPin}`, where)
    assert.equal(uploadStep.if, "steps.record.outputs.ok == 'true'", where)
    assert.equal(uploadStep['continue-on-error'], true, where)
    assert.deepEqual(uploadStep.with, {
      name: '${{ steps.record.outputs.artifact }}',
      path: MARKER_PATH,
      'if-no-files-found': 'error',
      'retention-days': 14,
    })
    assert.equal(saveStep.uses, `actions/cache/save@${cachePin}`, where)
    assert.equal(
      saveStep.if,
      "steps.record.outputs.ok == 'true' && steps.upload.outcome == 'success'",
      where
    )
    assert.deepEqual(saveStep.with, { path: MARKER_PATH, key: '${{ steps.record.outputs.key }}' })

    // These two are the workflow's only actions/cache sub-action steps, local
    // composite actions included: no other step restores the marker path, or
    // anything else, through them.
    const subActionSteps = Object.values(jobs).flatMap(entry =>
      inlineLocalActions(entry.steps ?? []).filter(step =>
        /^actions\/cache\/[^@]*@/i.test(step.uses ?? '')
      )
    )
    assert.equal(subActionSteps.length, 2, where)
    assert.ok(subActionSteps.includes(lookupStep) && subActionSteps.includes(saveStep), where)

    // Every job that waits on the lookup is covered or sharded, and the save
    // waits on all of them.
    const dependents = Object.entries(jobs)
      .filter(([name, entry]) => name !== SAVE_JOB && [entry.needs].flat().includes(DECIDE_JOB))
      .map(([name]) => name)
    assert.deepEqual(dependents.sort(), [...covered, ...sharded].sort(), where)
    assert.deepEqual(
      Object.keys(jobs).sort(),
      [DECIDE_JOB, SAVE_JOB, ...covered, ...sharded, ...expected.uncovered].sort(),
      where
    )

    // No covered job, sharded ones included, and none of their steps may
    // carry on after a failure: a suite step that did would let a failing
    // shard set its output, and a marker be recorded.
    for (const name of [...covered, ...sharded]) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      assert.ok(!Object.hasOwn(entry, 'continue-on-error'), `${at}: continue-on-error`)
      for (const step of entry.steps) {
        assert.ok(
          !Object.hasOwn(step, 'continue-on-error'),
          `${at} step ${step.name}: continue-on-error`
        )
      }
    }

    for (const name of covered) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      assert.deepEqual(
        [entry.needs].flat().sort(),
        [DECIDE_JOB, ...partsOf(expected, name)].sort(),
        at
      )
      assert.equal(
        entry.strategy,
        undefined,
        `${at}: a matrix job skipped by if reports one unexpanded check`
      )
      assert.deepEqual(entry.outputs, { tested: '${{ steps.tested.outputs.tested }}' }, at)
      const last = entry.steps.at(-1)
      assert.equal(last.id, 'tested', at)
      assert.equal(last.run, `echo 'tested=true' >> "$GITHUB_OUTPUT"`, at)
      // Never always(): a step that failed before it must leave tested unset.
      // In G3 only, the aggregating job also records nothing while the run
      // waits for a signed head.
      assert.equal(
        last.if,
        signedHead?.aggregate === name
          ? SIGNED_TESTED_IF
          : expected.stepGated.includes(name)
            ? SKIP_STEP
            : undefined,
        at
      )
    }

    // Step-gated jobs, lanes included, and every leg of a sharded job run
    // unless the run is cancelled, and only the gate skips their steps. A job
    // that aggregates shards or lanes runs even then (see requiredJobIf).
    // Each job a docs-only change does not skip is a lane, whose result the
    // required check needs, and ci.yml must have one: the security tooling
    // tests run in a required check on every pull request.
    for (const name of expected.runsOnDocsOnly) {
      assert.ok(Object.hasOwn(expected.lanes, name), `${where} job ${name} must be a lane`)
    }
    assert.ok(
      file !== '.github/workflows/ci.yml' || expected.runsOnDocsOnly.length > 0,
      `${where}: a required check must run the security tooling tests on a docs-only change`
    )
    for (const name of [...expected.stepGated, ...sharded]) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      // In G3 only, the sharded job is skipped whole while the run waits for
      // a signed head; the job that aggregates it still always runs.
      assert.equal(
        entry.if,
        signedHead?.sharded === name ? SIGNED_SHARD_IF : requiredJobIf(expected, name),
        at
      )
      const [gate, ...rest] = entry.steps
      assert.equal(gate.id, 'gate', at)
      assert.equal(gate.if, undefined, at)
      // A job that runs the security tooling tests reads every tracked file,
      // so a docs-only change must not skip it: its gate has no docs-only
      // input or branch. Every other gate has both.
      const runsTooling = entry.steps.some(step => SECURITY_TOOLING_RUN.test(step.run ?? ''))
      const marksOnly = expected.runsOnDocsOnly.includes(name)
      assert.equal(
        marksOnly,
        runsTooling,
        `${at}: runsOnDocsOnly must list exactly the jobs that run the security tooling tests`
      )
      // In G3 only, the aggregating job's gate also reads whether the run
      // waits for a signed head; the legs' gates do not, as the legs never
      // start then.
      const waits = signedHead?.aggregate === name
      assert.deepEqual(gate.env, {
        MARKER_JOB_RESULT: '${{ needs.tree-pass.result }}',
        MARKER_SKIP: '${{ needs.tree-pass.outputs.skip }}',
        MARKER_RUN_URL: '${{ needs.tree-pass.outputs.run-url }}',
        ...(marksOnly ? {} : { DOCS_ONLY: '${{ needs.tree-pass.outputs.docs-only }}' }),
        ...(waits ? { SIGNED_HEAD_WAIT: '${{ needs.tree-pass.outputs.signed-head-wait }}' } : {}),
      })
      // An aggregating job checks its shards or lanes on a marker hit too;
      // that step is checked below, and its gate's summary says so.
      const shardAggregate = shardedJobsOf(expected, name).length > 0
      const laneAggregate = laneJobsOf(expected, name).length > 0
      assert.equal(
        gate.run,
        waits
          ? SIGNED_AGGREGATE_GATE_RUN
          : shardAggregate
            ? AGGREGATE_GATE_RUN
            : laneAggregate
              ? LANE_AGGREGATE_GATE_RUN
              : marksOnly
                ? MARKER_ONLY_GATE_RUN
                : expected.versionBump
                  ? VERSION_GATE_RUN
                  : GATE_RUN,
        at
      )
      // Every gate with a docs-only branch says that a version bump counts
      // exactly where one does.
      if (!marksOnly) {
        assert.equal(gate.run.includes(VERSION_DOCS_CHANGE), expected.versionBump, at)
      }
      for (const step of rest) {
        if (shardAggregate && step.name === SHARD_CHECK_NAME) continue
        if (laneAggregate && step.name === LANE_CHECK_NAME) continue
        if (waits && step.id === 'tested') continue
        assert.ok(
          step.if === SKIP_STEP || step.if === `always() && ${SKIP_STEP}`,
          `${at}: step ${step.name} must be skipped only by the gate, found ${JSON.stringify(step.if)}`
        )
      }
    }

    for (const [name, aggregate] of Object.entries(expected.sharded)) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      // The one source of the shard list and total: the matrix. The leg's
      // name, its output, its run of the suite and the aggregating job's
      // check all follow it.
      const shards = shardsOf(entry, at)
      const total = shards.length
      assert.equal(entry.needs, DECIDE_JOB, at)
      const nameMatch = /^[^$]+ \$\{\{ matrix\.shard \}\} of ([0-9]+)$/.exec(entry.name)
      assert.ok(nameMatch, `${at}: the name must be "<name> ${SHARD_MATRIX_VALUE} of <total>"`)
      assert.equal(Number(nameMatch[1]), total, `${at}: the name's total`)
      for (const legName of shardJobNames(entry)) {
        assert.ok(!REQUIRED_CONTEXTS.includes(legName), `${at}: ${legName} is a required check`)
      }
      // Each leg sets an output of its own; one name would hold only the
      // leg that finished last.
      assert.deepEqual(
        entry.outputs,
        Object.fromEntries(
          shards.map(shard => [`tested-${shard}`, `\${{ steps.tested.outputs.tested-${shard} }}`])
        ),
        at
      )
      assert.equal(entry.env.G3_SHARD, SHARD_MATRIX_VALUE, at)
      assert.ok(
        entry.steps.every(step => step.env?.G3_SHARD === undefined),
        `${at}: no step sets G3_SHARD`
      )
      // Playwright's default split, from the command line alone.
      assert.doesNotMatch(JSON.stringify(workflow), /PWTEST_/, at)
      const suiteRuns = entry.steps.filter(step => /\bplaywright\s+test\b/.test(step.run ?? ''))
      assert.equal(suiteRuns.length, 1, `${at}: one run of the suite`)
      assert.equal(suiteRuns[0].run, SHARD_SUITE_RUN(total), at)
      assert.equal(suiteRuns[0].if, SKIP_STEP, at)
      // Each leg's report under its own name, and the harness stopped, even
      // after a failure or a cancellation.
      const uploads = entry.steps.filter(step => /^actions\/upload-artifact@/.test(step.uses ?? ''))
      assert.equal(uploads.length, 1, at)
      assert.equal(uploads[0].with.name, SHARD_ARTIFACT, at)
      assert.equal(uploads[0].if, `always() && ${SKIP_STEP}`, at)
      const stops = entry.steps.filter(step => step.run === 'corepack pnpm regtest:down')
      assert.equal(stops.length, 1, at)
      assert.equal(stops[0].if, `always() && ${SKIP_STEP}`, at)
      // Never always(): a step that failed before it must leave tested unset.
      const last = entry.steps.at(-1)
      assert.equal(last.id, 'tested', at)
      assert.equal(last.if, SKIP_STEP, at)
      assert.equal(last.run, SHARD_TESTED_RUN, at)

      // The aggregating job: a required check that is not a matrix job, needs
      // the shards and reports tested=true only after checking every one.
      const job = jobs[aggregate]
      const aggregateAt = `${where} job ${aggregate}`
      const waits = signedHead?.aggregate === aggregate
      assert.ok(expected.stepGated.includes(aggregate), `${aggregateAt} must be step-gated`)
      // In G3 only, its name is computed: the required check's in a run that
      // tests, another while the run waits for a signed head.
      assert.ok(
        REQUIRED_CONTEXTS.includes(testingNameOf(job)),
        `${aggregateAt} must be the required check`
      )
      assert.equal(job.name, waits ? SIGNED_AGGREGATE_NAME : testingNameOf(job), aggregateAt)
      assert.equal(
        signedHead?.sharded === name,
        waits,
        `${aggregateAt} and its shards wait together`
      )
      assert.deepEqual(
        Object.entries(jobs)
          .filter(([, other]) => [other.needs].flat().includes(name))
          .map(([other]) => other),
        [aggregate],
        `${at}: only ${aggregate} needs it`
      )
      // It reads only `needs`, so its token has no permissions.
      assert.deepEqual(job.permissions, {}, aggregateAt)
      assert.equal(job.steps.length, 3, aggregateAt)
      const check = job.steps[1]
      assert.equal(check.name, SHARD_CHECK_NAME, aggregateAt)
      // It runs whatever the gate decided.
      assert.equal(check.if, undefined, aggregateAt)
      assert.deepEqual(
        check.env,
        {
          SHARDS_RESULT: `\${{ needs.${name}.result }}`,
          MARKER_HIT: '${{ steps.gate.outputs.skip }}',
          ...(waits ? { SIGNED_HEAD_WAIT: '${{ steps.gate.outputs.wait }}' } : {}),
          ...Object.fromEntries(
            shards.map(shard => [
              `SHARD_${shard}_TESTED`,
              `\${{ needs.${name}.outputs.tested-${shard} }}`,
            ])
          ),
        },
        aggregateAt
      )
      assert.equal(
        check.run,
        waits ? SIGNED_SHARD_CHECK_RUN(total) : SHARD_CHECK_RUN(total),
        aggregateAt
      )
    }

    // Each lane runs one part of a required job's work. It is step-gated and
    // covered, as checked above: not a matrix job, needed by the save job and
    // named in TREE_PASS_COVERED_JOBS. Apart from the save job, only the job
    // that aggregates it needs it.
    for (const [name, aggregate] of Object.entries(expected.lanes)) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      assert.ok(expected.stepGated.includes(name), `${at} must be step-gated`)
      assert.ok(!REQUIRED_CONTEXTS.includes(entry.name), `${at}: ${entry.name} is a required check`)
      // The aggregating job's check names it in single quotes.
      assert.match(entry.name, /^[^'"$`\\]+$/, at)
      assert.deepEqual(
        Object.entries(jobs)
          .filter(([other, job]) => other !== SAVE_JOB && [job.needs].flat().includes(name))
          .map(([other]) => other),
        [aggregate],
        `${at}: only ${aggregate} and the save job need it`
      )
    }

    // The job that aggregates lanes: a required check that is not a matrix
    // job, needs the lanes (checked above) and reports tested=true only after
    // checking every one, each by its own result and `tested`.
    for (const aggregate of new Set(Object.values(expected.lanes))) {
      const job = jobs[aggregate]
      const at = `${where} job ${aggregate}`
      const lanes = laneJobsOf(expected, aggregate)
      assert.ok(expected.stepGated.includes(aggregate), `${at} must be step-gated`)
      assert.ok(REQUIRED_CONTEXTS.includes(job.name), `${at} must be the required check`)
      assert.deepEqual(shardedJobsOf(expected, aggregate), [], `${at}: shards or lanes, not both`)
      // It reads only `needs`, so its token has no permissions.
      assert.deepEqual(job.permissions, {}, at)
      assert.equal(job.steps.length, 3, at)
      const check = job.steps[1]
      assert.equal(check.name, LANE_CHECK_NAME, at)
      // It runs whatever the gate decided.
      assert.equal(check.if, undefined, at)
      assert.deepEqual(
        check.env,
        {
          MARKER_HIT: '${{ steps.gate.outputs.skip }}',
          ...Object.fromEntries(
            lanes.flatMap(lane => [
              [`${laneVariable(lane)}_RESULT`, `\${{ needs.${lane}.result }}`],
              [`${laneVariable(lane)}_TESTED`, `\${{ needs.${lane}.outputs.tested }}`],
            ])
          ),
        },
        at
      )
      // Every lane once, by the name GitHub gives its job.
      assert.equal(
        check.run,
        LANE_CHECK_RUN(lanes.map(lane => ({ id: lane, name: jobs[lane].name }))),
        at
      )
    }

    for (const name of expected.jobGated) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      assert.equal(
        entry.if,
        "${{ !cancelled() && !(needs.tree-pass.result == 'success' && needs.tree-pass.outputs.skip == 'true') }}",
        at
      )
      assert.ok(
        !REQUIRED_CONTEXTS.includes(entry.name),
        `${at}: a required check must not be skipped whole`
      )
      for (const step of entry.steps) assert.equal(step.if, undefined, `${at} step ${step.name}`)
    }

    for (const name of expected.uncovered) {
      assert.equal(jobs[name].needs, undefined, `${where} job ${name}`)
      assert.equal(jobs[name].if, undefined, `${where} job ${name}`)
    }
  }
  assert.equal(
    ids.size,
    Object.keys(MARKED_WORKFLOWS).length,
    'each workflow needs its own identity'
  )
})

// The required checks: the contexts above, and those in each ruleset file
// that requires status checks and exists here: required-checks.json for the
// default branch and required-checks-release.json for release branches, which
// reaches a release branch with a back-merge. Their format is not settled, so
// every string under a "context" key, or in a list under a key naming checks
// or contexts, counts.
const REQUIRED_CHECK_FILES = [
  '.github/rulesets/required-checks.json',
  '.github/rulesets/required-checks-release.json',
]

function requiredContexts(root = repoRoot) {
  const contexts = new Set(REQUIRED_CONTEXTS)
  for (const relative of REQUIRED_CHECK_FILES) {
    const file = join(root, relative)
    if (!existsSync(file)) continue
    const found = new Set()
    const visit = (value, key) => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string' && /check|context/i.test(key ?? '')) found.add(entry)
          else visit(entry, key)
        }
      } else if (value && typeof value === 'object') {
        for (const [name, entry] of Object.entries(value)) {
          if (name === 'context' && typeof entry === 'string') found.add(entry)
          else visit(entry, name)
        }
      }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) visit(parsed, 'checks')
    else visit(parsed)
    assert.ok(
      found.size > 0,
      `${file} lists no check this test can read; update requiredContexts()`
    )
    for (const context of found) contexts.add(context)
  }
  return contexts
}

// Whether a matrix job whose legs this test does not name could still have a
// leg named `context`. Its name's literal text must match around the
// expressions in it; a name of expressions only could be any value in the
// matrix. A name without expressions gets the values appended, and is
// refused only if it is the context itself.
function matrixNameCouldBe(entry, context) {
  if (typeof entry.name !== 'string') return false
  const parts = entry.name.split(/\$\{\{[\s\S]*?\}\}/)
  if (parts.length === 1) return entry.name === context
  if (parts.every(part => part.trim() === '')) {
    const values = []
    const collect = value => {
      if (typeof value === 'string') values.push(value)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(entry.strategy.matrix)
    return values.includes(context)
  }
  const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('[\\s\\S]*')}$`).test(context)
}

// Every name a job that is not a matrix job can report under: its literal
// name, its ID when it has none, or both outcomes of a computed name. A
// computed name must be `${{ <condition> && '<A>' || '<B>' }}` with no || in
// the condition and A not empty: GitHub's && binds tighter than ||, so the
// name is A when the condition holds and B otherwise, and never anything
// else.
function namesJobCanHave(entry, id) {
  if (entry.name === undefined) return [id]
  assert.equal(typeof entry.name, 'string', `job ${id}: its name must be a string`)
  if (!entry.name.includes('${{')) return [entry.name]
  const match = /^\$\{\{ (.+) && '((?:[^']|'')+)' \|\| '((?:[^']|'')*)' \}\}$/.exec(entry.name)
  assert.ok(match, `job ${id}: a computed name must be \${{ <condition> && '<A>' || '<B>' }}`)
  const [, condition, whenTrue, whenFalse] = match
  assert.doesNotMatch(condition, /\|\|/, `job ${id}: the name's condition must have no ||`)
  return [whenTrue, whenFalse].map(value => value.replaceAll("''", "'"))
}

test('the required checks come from both ruleset files, each when it exists', t => {
  const root = scratch(t, 'tree-pass-rulesets-')
  mkdirSync(join(root, '.github/rulesets'), { recursive: true })
  const ruleset = contexts => ({
    rules: [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: contexts.map(context => ({ context })) },
      },
    ],
  })
  // Neither file: the contexts this test names.
  assert.deepEqual([...requiredContexts(root)].sort(), [...REQUIRED_CONTEXTS].sort())
  // Only the release file, as on a release branch before a back-merge brings
  // the default branch's, and then both.
  writeFileSync(
    join(root, '.github/rulesets/required-checks-release.json'),
    JSON.stringify(ruleset(['signed-landing', WAITING_G3]))
  )
  assert.ok(requiredContexts(root).has(WAITING_G3))
  assert.ok(requiredContexts(root).has('signed-landing'))
  writeFileSync(
    join(root, '.github/rulesets/required-checks.json'),
    JSON.stringify(ruleset(['main-only']))
  )
  const both = requiredContexts(root)
  for (const context of ['main-only', 'signed-landing', WAITING_G3, ...REQUIRED_CONTEXTS]) {
    assert.ok(both.has(context), context)
  }
  // A file that names no check this test can read fails, so a format change
  // cannot silently drop the release ruleset's checks.
  writeFileSync(join(root, '.github/rulesets/required-checks-release.json'), '{"rules": []}')
  assert.throws(() => requiredContexts(root), /lists no check this test can read/)
})

test('every required check comes from a job that reports a real result in the skip path', () => {
  const required = requiredContexts()
  for (const context of required) {
    const producers = []
    for (const file of trackedWorkflows()) {
      for (const [name, entry] of Object.entries(readWorkflow(file).jobs)) {
        // A matrix job's legs are judged below.
        const names = entry.strategy?.matrix ? [entry.name] : namesJobCanHave(entry, name)
        if (names.includes(context)) producers.push({ file, name, job: entry })
      }
    }
    assert.equal(producers.length, 1, `${context} must come from exactly one job`)
    // Any other name that job can have is no required check: the waiting
    // name of `Playwright G3 scenarios`, and the name `Package versions
    // applied` has on a run that is not a pull request's, are the only such
    // names.
    const [producer] = producers
    for (const other of namesJobCanHave(producer.job, producer.name)) {
      if (other === context) continue
      assert.ok(!required.has(other), `${producer.name} can also report as ${other}`)
      assert.ok(
        [WAITING_G3, 'Package versions applied (not a pull request)'].includes(other),
        `${producer.name} can report as ${other}`
      )
    }
    // Nor may a leg of a matrix job take the name: GitHub names each leg
    // with its matrix values, in the name or after it (after the job ID when
    // the job has no name). The legs of a one-key matrix are named here; a
    // sharded job the marker covers must have one. Any other matrix is
    // judged by its name alone (matrixNameCouldBe).
    for (const file of trackedWorkflows()) {
      for (const [name, entry] of Object.entries(readWorkflow(file).jobs)) {
        const matrix = entry.strategy?.matrix
        if (!matrix) continue
        const [key, ...others] = Object.keys(matrix)
        const oneKey = others.length === 0 && Array.isArray(matrix[key])
        if (Object.hasOwn(MARKED_WORKFLOWS[file]?.sharded ?? {}, name)) {
          assert.ok(oneKey, `${file} job ${name}: a sharded job has a one-key matrix`)
        }
        if (!oneKey) {
          assert.ok(
            !matrixNameCouldBe(entry, context),
            `${file} job ${name}: a leg of this matrix job could be named "${context}", a required check; give the job a name that cannot render as it`
          )
          continue
        }
        for (const value of matrix[key]) {
          const placeholder = `\${{ matrix.${key} }}`
          const legName =
            typeof entry.name === 'string' && entry.name.includes(placeholder)
              ? entry.name.replaceAll(placeholder, String(value))
              : `${entry.name ?? name} (${value})`
          assert.notEqual(legName, context, `${file} job ${name}`)
        }
      }
    }
    const [{ file, name, job: entry }] = producers
    assert.equal(entry.strategy, undefined, `${context} must not be a matrix job`)
    if (entry.needs !== undefined) {
      assert.ok(
        MARKED_WORKFLOWS[file]?.stepGated.includes(name),
        `${context} depends on another job, so it must be a step-gated job`
      )
      assert.equal(
        entry.if,
        requiredJobIf(MARKED_WORKFLOWS[file], name),
        `${context} must run when its dependency fails`
      )
    }
  }
})

// The marker jobs run the script on the runner image's Node, without
// setup-node or an install, so it may load only Node's built-in modules.
test('the script loads only Node built-in modules', t => {
  const source = readFileSync(script, 'utf8')
  const specifiers = [
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
  ].map(([, specifier]) => specifier)
  assert.ok(specifiers.length >= 5, specifiers.join(', '))
  for (const specifier of specifiers) assert.match(specifier, /^node:[a-z_/]+$/, specifier)
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|createRequire/)

  // What Node itself resolves: a copy in a folder with no node_modules above
  // it, as on the runner, loads every module it names.
  const dir = scratch(t, 'tree-pass-builtins-')
  for (let up = dir; ; up = dirname(up)) {
    assert.ok(!existsSync(join(up, 'node_modules')), `${up} has node_modules`)
    if (dirname(up) === up) break
  }
  const copy = join(dir, 'tree-pass-marker.mjs')
  writeFileSync(copy, source)
  const loaded = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(copy).href)})`],
    { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' }
  )
  assert.equal(loaded.status, 0, loaded.stderr)
})

test('workflows and local actions outside the marker never reference it', () => {
  const others = [
    ...trackedWorkflows().filter(file => !Object.hasOwn(MARKED_WORKFLOWS, file)),
    ...trackedFiles(/(?:^|\/)action\.ya?ml$/),
  ]
  for (const file of others) {
    const text = readFileSync(join(repoRoot, file), 'utf8')
    assert.doesNotMatch(text, /tree-pass|TREE_PASS|actions\/cache\/(?:restore|save)@/i, file)
  }
  for (const file of ['.github/workflows/build-regtest-images.yml']) {
    assert.ok(trackedWorkflows().includes(file), `${file} must still exist and run in full`)
  }
})

// The step's script goes in on stdin, the way the runner's bash -e reads a file.
function runGate(
  temp,
  index,
  { result, skip, url = '', docsOnly = '', wait = '' },
  script = GATE_RUN
) {
  const outputFile = join(temp, `output-${index}`)
  const summaryFile = join(temp, `summary-${index}`)
  const run = spawnSync('bash', ['-e', '-s'], {
    input: script,
    env: {
      PATH: process.env.PATH,
      MARKER_JOB_RESULT: result,
      MARKER_SKIP: skip,
      MARKER_RUN_URL: url,
      DOCS_ONLY: docsOnly,
      SIGNED_HEAD_WAIT: wait,
      TREE_PASS_FORCE_LABEL: FORCE_LABEL,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  return {
    skip: outputs(outputFile).skip,
    wait: outputs(outputFile).wait,
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '',
  }
}

test('the gate step skips only on a successful marker job that said skip, and names the passing run', t => {
  const temp = scratch(t, 'tree-pass-gate-')
  const url = 'https://github.com/Qbit-Org/qbit-wallet/actions/runs/1001/attempts/1'
  const rows = [
    ['success', 'true', 'true'],
    ['success', 'false', undefined],
    ['success', '', undefined],
    ['success', 'TRUE', undefined],
    ['failure', 'true', undefined],
    ['cancelled', 'true', undefined],
    ['skipped', 'true', undefined],
    ['skipped', '', undefined],
    ['', '', undefined],
  ]
  const rerun = `Add the ${FORCE_LABEL} label and re-run all jobs to run everything.`
  for (const [kind, script, consequence, docsSummary] of [
    [
      'gated',
      GATE_RUN,
      'so its steps are skipped.',
      `changes only documentation that no skipped step reads, so its steps are skipped. ${rerun}`,
    ],
    [
      'gated, where a version bump counts',
      VERSION_GATE_RUN,
      'so its steps are skipped.',
      'changes only documentation that no skipped step reads, or only that and the extension ' +
        `version, so its steps are skipped. ${rerun}`,
    ],
    // A job that runs in full on a docs-only change: no docs-only summary.
    ['marker only', MARKER_ONLY_GATE_RUN, 'so its steps are skipped.', null],
    [
      'aggregate',
      AGGREGATE_GATE_RUN,
      'this job still checks that every shard succeeded.',
      'changes only documentation that no skipped step reads, so the shards skipped their steps; ' +
        `this job still checks that every shard succeeded. ${rerun}`,
    ],
    [
      'lane aggregate',
      LANE_AGGREGATE_GATE_RUN,
      'this job still checks that every lane succeeded.',
      'changes only documentation that no skipped step reads, so the lanes skipped their steps, ' +
        "except 'Typecheck, security checks and other unit tests', which ran in full because its " +
        `security tooling tests read every tracked file; this job still checks that every lane succeeded. ${rerun}`,
    ],
  ]) {
    for (const [index, [result, skip, expected]] of rows.entries()) {
      const gate = runGate(temp, `${kind}-${index}`, { result, skip, url }, script)
      assert.equal(gate.skip, expected, `${kind} ${result}/${skip}`)
      assert.equal(gate.summary.includes(url), expected === 'true', `${kind} ${result}/${skip}`)
      assert.equal(gate.summary.includes(consequence), expected === 'true', kind)
    }
    // A docs-only change skips the same way, on a successful marker job only,
    // and its summary says so and how to run everything. A hit names its run.
    const docsRows = [
      ['success', 'false', 'true', 'docs-only'],
      ['success', '', 'true', 'docs-only'],
      ['success', 'true', 'true', 'hit'],
      ['success', 'false', 'TRUE', undefined],
      ['success', 'false', 'false', undefined],
      ['success', 'false', '', undefined],
      ['failure', 'false', 'true', undefined],
      ['cancelled', '', 'true', undefined],
      ['skipped', '', 'true', undefined],
      ['', '', 'true', undefined],
    ]
    for (const [index, [result, skip, docsOnly, kindOfSkip]] of docsRows.entries()) {
      const at = `${kind} ${result}/${skip}/docs-only ${docsOnly}`
      const gate = runGate(temp, `${kind}-docs-${index}`, { result, skip, url, docsOnly }, script)
      // A marker-only gate ignores a docs-only change and runs everything.
      const skips = kindOfSkip === 'hit' || (kindOfSkip === 'docs-only' && docsSummary !== null)
      assert.equal(gate.skip, skips ? 'true' : undefined, at)
      assert.equal(gate.summary.includes(url), kindOfSkip === 'hit', at)
      assert.equal(gate.summary.includes(consequence), skips, at)
      assert.equal(
        gate.summary.includes('changes only documentation'),
        skips && kindOfSkip !== 'hit',
        at
      )
      if (docsSummary !== null) {
        assert.equal(gate.summary.includes(docsSummary), kindOfSkip === 'docs-only', at)
      }
    }
    // The URL is data, not shell: a hostile value cannot run a command.
    const hostile = runGate(
      temp,
      `${kind}-hostile`,
      { result: 'success', skip: 'true', url: '$(touch pwned) `touch pwned` ; touch pwned' },
      script
    )
    assert.equal(hostile.skip, 'true', kind)
    assert.ok(!existsSync(join(process.cwd(), 'pwned')), kind)
  }
})

// --- The workflow conditions, evaluated ------------------------------------

// Evaluates the `if` expressions the marked workflows use: string literals,
// true and false, property paths, the status functions, !, ==, !=, && and ||
// with GitHub's precedence, and parentheses. String comparisons ignore case,
// as GitHub's do, and a missing property is ''. Without a status function,
// GitHub adds success() &&.
function evaluateIf(expression, context) {
  if (expression === undefined) expression = 'success()'
  let text = String(expression).trim()
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text)
  if (wrapped) text = wrapped[1].trim()
  if (!/\b(?:success|failure|cancelled|always)\(\)/.test(text)) text = `success() && (${text})`
  return Boolean(evaluateExpression(text, context, expression))
}

// The name GitHub gives a job: each `${{ … }}` in it evaluated as a value, as
// in `jobs.<job_id>.name`, which may read `needs` and `matrix`. No status
// function and no implicit success() there.
function renderName(entry, context) {
  return entry.name.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, inner) => {
    const value = evaluateExpression(inner.trim(), { status: {}, ...context }, entry.name)
    return typeof value === 'string' ? value : String(value)
  })
}

// The name a job has in a pull request run that tests: the marker job
// succeeded and the run does not wait for a signed head.
function testingNameOf(entry) {
  return renderName(entry, {
    needs: { [DECIDE_JOB]: { result: 'success', outputs: { 'signed-head-wait': 'false' } } },
  })
}

// The value of an expression, as GitHub computes it: && gives its left
// operand when that is falsy and its right one otherwise, || its left operand
// when that is truthy and its right one otherwise, and ! and the comparisons
// give booleans. An empty string and false are falsy, as in GitHub.
function evaluateExpression(text, context, expression = text) {
  const token = /&&|\|\||==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*(?:\(\))?/g
  const tokens = text.match(token) ?? []
  // Nothing but whitespace between the tokens; a string literal keeps its own.
  assert.equal(text.replace(token, '').replace(/\s+/g, ''), '', `cannot evaluate ${expression}`)
  assert.ok(tokens.length > 0, `cannot evaluate ${expression}`)
  let position = 0
  const peek = () => tokens[position]
  const take = expected => {
    const token = tokens[position++]
    if (expected !== undefined) assert.equal(token, expected, `in ${expression}`)
    return token
  }
  const equal = (left, right) =>
    typeof left === 'string' && typeof right === 'string'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  const primary = () => {
    const token = take()
    if (token === '(') {
      const value = or()
      take(')')
      return value
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (token === 'true') return true
    if (token === 'false') return false
    if (token.endsWith('()')) {
      const name = token.slice(0, -2)
      assert.ok(name in context.status, `unknown function ${token}`)
      return context.status[name]
    }
    let value = context
    for (const part of token.split('.')) value = value?.[part]
    return value ?? ''
  }
  const unary = () => {
    if (peek() === '!') {
      take()
      return !unary()
    }
    return primary()
  }
  const comparison = () => {
    let value = unary()
    while (peek() === '==' || peek() === '!=') {
      const operator = take()
      const right = unary()
      value = operator === '==' ? equal(value, right) : !equal(value, right)
    }
    return value
  }
  const and = () => {
    let value = comparison()
    while (peek() === '&&') {
      take()
      const right = comparison()
      value = value ? right : value
    }
    return value
  }
  function or() {
    let value = and()
    while (peek() === '||') {
      take()
      const right = and()
      value = value ? value : right
    }
    return value
  }
  const result = or()
  assert.equal(position, tokens.length, `trailing tokens in ${expression}`)
  return result
}

function jobStatus(needs, runCancelled) {
  const results = Object.values(needs).map(need => need.result)
  return {
    success: !runCancelled && results.every(result => result === 'success'),
    failure: results.some(result => result === 'failure'),
    cancelled: runCancelled,
    always: true,
  }
}

// Runs a step's script as runGate does (bash -e, the script on stdin; the
// runner adds pipefail, and these scripts have no pipes) with the given
// environment, and returns its exit status and outputs.
function runStep(temp, label, script, env, path = process.env.PATH) {
  const outputFile = join(temp, `step-output-${label}`)
  const summaryFile = join(temp, `step-summary-${label}`)
  const run = spawnSync('bash', ['-e', '-s'], {
    input: script,
    env: { ...env, PATH: path, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
    encoding: 'utf8',
  })
  assert.equal(run.error, undefined, label)
  return {
    status: run.status,
    stdout: run.stdout,
    outputs: outputs(outputFile),
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '',
  }
}

// Fills in the `${{ <property path> }}` templates of each value, as GitHub
// does for the ones the simulated steps use. A missing property is '', and
// any other template fails the test.
function resolveTemplates(map, context) {
  return Object.fromEntries(
    Object.entries(map ?? {}).map(([key, value]) => {
      const text = String(value).replace(
        /\$\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g,
        (_, path) => {
          let found = context
          for (const part of path.split('.')) found = found?.[part]
          return found === undefined || found === null ? '' : String(found)
        }
      )
      assert.doesNotMatch(text, /\$\{\{/, `cannot resolve ${key}: ${value}`)
      return [key, text]
    })
  )
}

// A job's outputs as GitHub records them: an empty value is not recorded.
function jobOutputs(job, steps) {
  return Object.fromEntries(
    Object.entries(resolveTemplates(job.outputs, { steps })).filter(([, value]) => value !== '')
  )
}

function pick(needs, names) {
  return Object.fromEntries([names].flat().map(name => [name, needs[name]]))
}

// A stand-in for xvfb-run that records the command it was asked to run.
function fakeXvfb(temp) {
  const bin = join(temp, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'xvfb-run'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$XVFB_ARGS"\n`, {
    mode: 0o755,
  })
  return bin
}

// One leg of a sharded job. Its gate, its run of the suite (through the
// stand-in xvfb-run, which records the command line) and its last step run
// for real, with the environment the job gives the leg; the other steps
// only by their conditions. `result` is how the leg ends: success, failure
// (its run of the suite fails), cancelled (during that run, as on a timeout)
// or skipped (it never starts).
function simulateLeg(temp, bin, name, job, { shard, result, marker, github }) {
  if (result === 'skipped') return { shard, result, steps: [], outputs: {} }
  const label = `${name}-${shard}`
  const argsFile = join(temp, `xvfb-args-${label}`)
  const env = {
    ...resolveTemplates(job.env, { matrix: { shard }, github }),
    XVFB_ARGS: argsFile,
  }
  const steps = {}
  const ran = []
  let status = { success: true, failure: false, cancelled: false, always: true }
  let suiteArgs
  for (const [index, step] of job.steps.entries()) {
    if (!evaluateIf(step.if, { github, steps, status })) continue
    ran.push(step.name)
    const stepEnv = { ...env, ...resolveTemplates(step.env, { needs: { [DECIDE_JOB]: marker } }) }
    if (step.id === 'gate' || step.id === 'tested') {
      const done = runStep(temp, `${label}-${index}`, step.run, stepEnv)
      assert.equal(done.status, 0, `${label} ${step.name}`)
      steps[step.id] = { outputs: done.outputs }
    } else if (/\bplaywright\s+test\b/.test(step.run ?? '')) {
      const done = runStep(
        temp,
        `${label}-${index}`,
        step.run,
        stepEnv,
        `${bin}:${process.env.PATH}`
      )
      assert.equal(done.status, 0, `${label} ${step.name}`)
      suiteArgs = readFileSync(argsFile, 'utf8').split('\n').slice(0, -1)
      if (result === 'failure') status = { ...status, success: false, failure: true }
      if (result === 'cancelled') status = { ...status, success: false, cancelled: true }
    }
  }
  return {
    shard,
    result,
    steps: ran,
    total: job.steps.length,
    outputs: jobOutputs(job, steps),
    suiteArgs,
  }
}

// GitHub's result for a matrix job: any failed leg makes it a failure, else
// any cancelled leg cancelled, and legs that were all skipped skipped. A
// skipped leg among passing ones counts as a pass here, the most lenient
// reading, so the aggregating job must not rely on the result alone.
function matrixResult(legs) {
  const results = legs.map(leg => leg.result)
  if (results.includes('failure')) return 'failure'
  if (results.includes('cancelled')) return 'cancelled'
  if (results.every(result => result === 'skipped')) return 'skipped'
  return 'success'
}

// The job that aggregates a sharded job: every step runs for real, with the
// workflow's env, and the job reports under the name GitHub renders for it. A
// job that `always()` starts after the run was cancelled is not itself
// cancelled, so its steps run as usual.
function simulateAggregate(temp, name, job, { needs, github, runCancelled, workflowEnv = {} }) {
  const jobNeeds = pick(needs, job.needs)
  const jobName = renderName(job, { github, needs: jobNeeds })
  if (!evaluateIf(job.if, { github, needs: jobNeeds, status: jobStatus(jobNeeds, runCancelled) })) {
    return { ran: false, name: jobName, result: 'skipped', steps: [], outputs: {} }
  }
  const steps = {}
  const ran = []
  const errors = []
  const notices = []
  let summary = ''
  let status = { success: true, failure: false, cancelled: false, always: true }
  for (const [index, step] of job.steps.entries()) {
    if (!evaluateIf(step.if, { github, steps, status })) continue
    ran.push(step.name)
    const env = { ...workflowEnv, ...resolveTemplates(step.env, { needs: jobNeeds, steps }) }
    const done = runStep(temp, `${name}-${index}`, step.run, env)
    errors.push(...done.stdout.split('\n').filter(line => line.startsWith('::error::')))
    notices.push(...done.stdout.split('\n').filter(line => line.startsWith('::notice::')))
    summary += done.summary
    if (step.id) steps[step.id] = { outputs: done.outputs }
    if (done.status !== 0) status = { ...status, success: false, failure: true }
  }
  return {
    ran: true,
    name: jobName,
    notices,
    result: status.success ? 'success' : 'failure',
    steps: ran,
    total: job.steps.length,
    outputs: jobOutputs(job, steps),
    errors,
    summary,
  }
}

// One run of a marked workflow, as far as the conditions decide it. The
// tree-pass job's result and outputs are given when it runs. Each leg of a
// sharded job ends as `legs` says (success unless named), `lostOutputs` are
// left out of the sharded job's outputs, `runCancelled` cancels the run
// before the marker job starts, `cancelledAfterMarker` once it ended with the
// result `treePass` gives and before any other job starts, and
// `cancelledAfterShards` once the shards and lanes ended; the job that
// aggregates them runs its steps for real. Each lane that runs ends as `lanes` says (success
// unless named), and one that fails or is cancelled stops before its last
// step; `lostLaneOutputs` names lanes whose `tested` is lost. Every other job
// succeeds when it runs. Returns, per job, whether it ran and which steps
// did.
function simulate(
  t,
  file,
  {
    event,
    treePass,
    record = { ok: 'true' },
    upload = 'success',
    runCancelled = false,
    legs = {},
    lostOutputs = [],
    cancelledAfterMarker = false,
    cancelledAfterShards = false,
    lanes = {},
    lostLaneOutputs = [],
  }
) {
  const temp = scratch(t, 'tree-pass-simulate-')
  const bin = fakeXvfb(temp)
  const { jobs, env } = readWorkflow(file)
  const expected = MARKED_WORKFLOWS[file]
  const github = { event_name: event, run_id: '2002', run_attempt: '1' }
  // The workflow's env, which every step sees: the force label, for one.
  const workflowEnv = resolveTemplates(env, {})
  const outcome = {}

  const lookupRuns = evaluateIf(jobs[DECIDE_JOB].if, {
    github,
    status: jobStatus({}, runCancelled),
  })
  const marker = lookupRuns ? treePass : { result: 'skipped', outputs: {} }
  outcome[DECIDE_JOB] = { ran: lookupRuns, ...marker }

  const needs = { [DECIDE_JOB]: marker }
  // Every job after the marker job is cancelled by a cancellation before it.
  const afterMarkerCancelled = runCancelled || cancelledAfterMarker
  // Sharded jobs first: the jobs that aggregate them need them.
  for (const name of Object.keys(expected.sharded)) {
    const job = jobs[name]
    const jobNeeds = pick(needs, job.needs)
    const ran = evaluateIf(job.if, {
      github,
      needs: jobNeeds,
      status: jobStatus(jobNeeds, afterMarkerCancelled),
    })
    if (!ran) {
      // GitHub reports a job that a cancelled run never started as cancelled.
      const result = afterMarkerCancelled ? 'cancelled' : 'skipped'
      outcome[name] = { ran: false, result, legs: [] }
      needs[name] = { result, outputs: {} }
      continue
    }
    const legRuns = job.strategy.matrix.shard.map(shard =>
      simulateLeg(temp, bin, name, job, { shard, result: legs[shard] ?? 'success', marker, github })
    )
    const merged = Object.assign({}, ...legRuns.map(leg => leg.outputs))
    for (const key of lostOutputs) delete merged[key]
    outcome[name] = { ran: true, result: matrixResult(legRuns), legs: legRuns }
    needs[name] = { result: matrixResult(legRuns), outputs: merged }
  }

  const cancelled = afterMarkerCancelled || cancelledAfterShards
  // Lanes before the jobs that aggregate them, which need them.
  const aggregates = expected.stepGated.filter(name => partsOf(expected, name).length > 0)
  const others = expected.stepGated.filter(name => !aggregates.includes(name))
  for (const name of [...others, ...expected.jobGated, ...aggregates]) {
    const job = jobs[name]
    const lane = Object.hasOwn(expected.lanes, name)
    // A job that needs only the marker job, such as a lane, ends before a
    // cancellation that comes after the shards and lanes.
    const jobCancelled = aggregates.includes(name) ? cancelled : afterMarkerCancelled
    if (partsOf(expected, name).length > 0) {
      const aggregate = simulateAggregate(temp, name, job, {
        needs,
        github,
        runCancelled: cancelled,
        workflowEnv,
      })
      outcome[name] = aggregate
      needs[name] = { result: aggregate.result, outputs: aggregate.outputs }
      continue
    }
    const jobNeeds = pick(needs, job.needs)
    const ran = evaluateIf(job.if, {
      github,
      needs: jobNeeds,
      status: jobStatus(jobNeeds, jobCancelled),
    })
    const ending = (lane && lanes[name]) || 'success'
    if (!ran || ending === 'skipped') {
      const result = jobCancelled ? 'cancelled' : 'skipped'
      outcome[name] = { ran: false, result, steps: [] }
      needs[name] = { result, outputs: {} }
      continue
    }
    const steps = {}
    const ranSteps = []
    for (const [index, step] of job.steps.entries()) {
      if (step.id === 'gate') {
        const gate = runGate(
          temp,
          `${name}-${index}`,
          {
            result: marker.result,
            skip: marker.outputs.skip ?? '',
            url: marker.outputs['run-url'] ?? '',
            docsOnly: marker.outputs['docs-only'] ?? '',
          },
          step.run
        )
        steps.gate = { outputs: { skip: gate.skip ?? '' } }
        ranSteps.push(step.name)
        continue
      }
      const status = { success: true, failure: false, cancelled: jobCancelled, always: true }
      if (evaluateIf(step.if, { github, steps, status })) ranSteps.push(step.name)
    }
    // A lane that fails or is cancelled never reaches its last step.
    if (ending !== 'success' && ranSteps.at(-1) === job.steps.at(-1).name) ranSteps.pop()
    const tested = ranSteps.includes(job.steps.at(-1).name) && !lostLaneOutputs.includes(name)
    outcome[name] = { ran: true, result: ending, steps: ranSteps, total: job.steps.length }
    needs[name] = { result: ending, outputs: tested ? { tested: 'true' } : {} }
  }

  const save = jobs[SAVE_JOB]
  const saveNeeds = pick(needs, save.needs)
  const saveRuns = evaluateIf(save.if, {
    github,
    needs: saveNeeds,
    status: jobStatus(saveNeeds, cancelled),
  })
  const saveSteps = []
  if (saveRuns) {
    const steps = { record: { outputs: record }, upload: { outcome: upload } }
    for (const step of save.steps) {
      const status = { success: true, failure: false, cancelled: false, always: true }
      if (evaluateIf(step.if, { github, steps, status })) saveSteps.push(step.uses ?? step.run)
    }
  }
  outcome[SAVE_JOB] = { ran: saveRuns, steps: saveSteps, needs: saveNeeds }
  return outcome
}

// Every leg of each sharded job ran all its steps, or only its gate.
function assertLegs(run, expected, where, { full }) {
  for (const name of Object.keys(expected.sharded)) {
    assert.equal(run[name].ran, true, `${where}: ${name} runs`)
    for (const leg of run[name].legs) {
      const at = `${where}: ${name} shard ${leg.shard}`
      if (full) assert.equal(leg.steps.length, leg.total, `${at} runs every step`)
      else assert.deepEqual(leg.steps, ['Check for a tree pass marker'], at)
    }
  }
}

const FULL_RUN = {
  result: 'success',
  outputs: { prefix: PREFIX, skip: 'false', save: 'true', 'run-url': '' },
}
const SKIP_RUN = {
  result: 'success',
  outputs: {
    prefix: PREFIX,
    skip: 'true',
    save: 'false',
    'run-url': 'https://github.com/Qbit-Org/qbit-wallet/actions/runs/1001/attempts/1',
  },
}
// A marker miss that would save, on a docs-only change.
const DOCS_ONLY_RUN = {
  result: 'success',
  outputs: { ...FULL_RUN.outputs, 'docs-only': 'true' },
}

test('a skipped tree-pass runs everything and saves nothing', t => {
  for (const [file, expected] of Object.entries(MARKED_WORKFLOWS)) {
    for (const event of ['push', 'workflow_dispatch', 'merge_group']) {
      const run = simulate(t, file, {
        event,
        treePass: { result: 'success', outputs: { skip: 'true' } },
      })
      const where = `${file} on ${event}`
      assert.equal(run[DECIDE_JOB].ran, false, where)
      assert.equal(run[DECIDE_JOB].result, 'skipped', where)
      for (const name of [...expected.stepGated, ...expected.jobGated]) {
        assert.equal(run[name].ran, true, `${where}: ${name} runs`)
        assert.equal(
          run[name].steps.length,
          run[name].total,
          `${where}: every step of ${name} runs`
        )
      }
      assertLegs(run, expected, where, { full: true })
      assert.equal(run[SAVE_JOB].ran, false, `${where}: nothing is saved`)
      // Even if the save job ran, record refuses a skipped tree-pass.
      assert.notDeepEqual(recordErrors({ needs: run[SAVE_JOB].needs }), [], where)
    }
  }
})

test('the conditions run everything unless a successful marker job said skip, and save only a full pass', t => {
  for (const [file, expected] of Object.entries(MARKED_WORKFLOWS)) {
    const covered = [...expected.stepGated, ...expected.jobGated]

    // A full pull request run saves, through the artifact and then the cache.
    const full = simulate(t, file, { event: 'pull_request', treePass: FULL_RUN })
    for (const name of covered)
      assert.equal(full[name].steps.length, full[name].total, `${file} ${name}`)
    assertLegs(full, expected, file, { full: true })
    assert.equal(full[SAVE_JOB].ran, true, file)
    assert.equal(full[SAVE_JOB].steps.length, 4, file)
    assert.deepEqual(recordErrors({ needs: full[SAVE_JOB].needs }), [], file)

    // record declined, or the artifact upload failed: no cache entry.
    const declined = simulate(t, file, {
      event: 'pull_request',
      treePass: FULL_RUN,
      record: { ok: 'false' },
    })
    assert.equal(declined[SAVE_JOB].steps.length, 2, file)
    const noArtifact = simulate(t, file, {
      event: 'pull_request',
      treePass: FULL_RUN,
      upload: 'failure',
    })
    assert.equal(noArtifact[SAVE_JOB].steps.length, 3, file)
    assert.ok(!noArtifact[SAVE_JOB].steps.some(step => /^actions\/cache\/save@/.test(step)), file)

    // A skip: required jobs and lanes run only their gate, and an
    // aggregating job also its check of the shards or lanes; every leg of a
    // sharded job runs only its gate; other covered jobs are skipped whole,
    // and nothing is saved.
    const skip = simulate(t, file, { event: 'pull_request', treePass: SKIP_RUN })
    for (const name of expected.stepGated) {
      assert.equal(skip[name].ran, true, `${file} ${name} reports a result`)
      assert.equal(skip[name].result, 'success', `${file} ${name}`)
      const check =
        shardedJobsOf(expected, name).length > 0
          ? [SHARD_CHECK_NAME]
          : laneJobsOf(expected, name).length > 0
            ? [LANE_CHECK_NAME]
            : []
      assert.deepEqual(
        skip[name].steps,
        ['Check for a tree pass marker', ...check],
        `${file} ${name}`
      )
    }
    assertLegs(skip, expected, file, { full: false })
    for (const name of expected.jobGated) assert.equal(skip[name].ran, false, `${file} ${name}`)
    assert.equal(skip[SAVE_JOB].ran, false, file)

    // A docs-only change: required jobs, the lanes and the legs run only
    // their gates, and an aggregating job also its check, as on a skip; but
    // other covered jobs, and the lanes in runsOnDocsOnly, run in full, and
    // nothing is saved. With a marker hit as well, it is a skip.
    for (const treePass of [
      DOCS_ONLY_RUN,
      { ...SKIP_RUN, outputs: { ...SKIP_RUN.outputs, 'docs-only': 'true' } },
    ]) {
      const docs = simulate(t, file, { event: 'pull_request', treePass })
      const where = `${file} docs-only, marker skip ${treePass.outputs.skip}`
      for (const name of expected.stepGated) {
        assert.equal(docs[name].ran, true, `${where}: ${name} reports a result`)
        assert.equal(docs[name].result, 'success', `${where}: ${name}`)
        if (expected.runsOnDocsOnly.includes(name) && treePass.outputs.skip !== 'true') {
          assert.equal(docs[name].steps.length, docs[name].total, `${where}: ${name} runs in full`)
          continue
        }
        const check =
          shardedJobsOf(expected, name).length > 0
            ? [SHARD_CHECK_NAME]
            : laneJobsOf(expected, name).length > 0
              ? [LANE_CHECK_NAME]
              : []
        assert.deepEqual(
          docs[name].steps,
          ['Check for a tree pass marker', ...check],
          `${where}: ${name}`
        )
      }
      assertLegs(docs, expected, where, { full: false })
      for (const name of expected.jobGated) {
        const skipped = treePass.outputs.skip === 'true'
        assert.equal(docs[name].ran, !skipped, `${where}: ${name}`)
        if (!skipped) assert.equal(docs[name].steps.length, docs[name].total, `${where}: ${name}`)
      }
      assert.equal(docs[SAVE_JOB].ran, false, where)
    }

    // A failed or cancelled marker job runs everything and saves nothing,
    // whatever it said about a skip or a docs-only change.
    for (const result of ['failure', 'cancelled']) {
      const broken = simulate(t, file, {
        event: 'pull_request',
        treePass: { result, outputs: { ...SKIP_RUN.outputs, save: 'true', 'docs-only': 'true' } },
      })
      for (const name of covered) {
        assert.equal(
          broken[name].steps.length,
          broken[name].total,
          `${file} ${name} after ${result}`
        )
      }
      assertLegs(broken, expected, `${file} after ${result}`, { full: true })
      assert.equal(broken[SAVE_JOB].ran, false, `${file} after ${result}`)
    }

    // A cancelled run: no covered job starts, except a job that aggregates
    // shards or lanes, which runs and fails because its parts did not pass.
    const cancelled = simulate(t, file, {
      event: 'pull_request',
      treePass: FULL_RUN,
      runCancelled: true,
    })
    for (const name of [...covered, ...Object.keys(expected.sharded)]) {
      const aggregates = partsOf(expected, name).length > 0
      assert.equal(cancelled[name].ran, aggregates, `${file} ${name}`)
      if (aggregates) assert.equal(cancelled[name].result, 'failure', `${file} ${name}`)
    }
    assert.equal(cancelled[SAVE_JOB].ran, false, file)
  }
})

// --- The shards of the browser release gate --------------------------------

const SHARDED_FILE = '.github/workflows/playwright-release-gate.yml'

test('each shard runs the suite on its own part of the total, and together they run every part once', t => {
  const expected = MARKED_WORKFLOWS[SHARDED_FILE]
  const { jobs } = readWorkflow(SHARDED_FILE)
  for (const [name] of Object.entries(expected.sharded)) {
    const total = jobs[name].strategy.matrix.shard.length
    for (const [label, options] of [
      ['a full run', { event: 'pull_request', treePass: FULL_RUN }],
      ['a push', { event: 'push', treePass: FULL_RUN }],
    ]) {
      const run = simulate(t, SHARDED_FILE, options)
      const args = run[name].legs.map(leg => leg.suiteArgs)
      // What the runner hands Playwright, read from the command line the
      // step actually ran: one --shard per leg, 1 to the total, each once.
      assert.deepEqual(
        args,
        shardRange(total).map(shard => [
          '--auto-servernum',
          'corepack',
          'pnpm',
          'exec',
          'playwright',
          'test',
          `--shard=${shard}/${total}`,
        ]),
        `${name} in ${label}`
      )
      // And each leg reports its own output, which no other leg sets.
      assert.deepEqual(
        run[name].legs.map(leg => leg.outputs),
        shardRange(total).map(shard => ({ [`tested-${shard}`]: 'true' })),
        `${name} in ${label}`
      )
    }
  }
})

// The aggregating job's result, whether it reports tested=true, whether the
// save job runs and whether its record step accepts, for each state of the
// marker job and each way the shards can end.
test('Playwright G3 scenarios passes only when every shard passed, and a marker needs every shard tested', t => {
  const expected = MARKED_WORKFLOWS[SHARDED_FILE]
  const [[shardJob, aggregate]] = Object.entries(expected.sharded)
  const { jobs } = readWorkflow(SHARDED_FILE)
  const total = jobs[shardJob].strategy.matrix.shard.length
  // Every leg ending one way, and the legs after shard `failed` reused.
  const allLegs = result => Object.fromEntries(shardRange(total).map(shard => [shard, result]))
  const reusedOutputs = failed =>
    shardRange(total)
      .filter(shard => shard !== failed)
      .map(shard => `tested-${shard}`)
  const markers = {
    'skipped (no pull request)': { event: 'push', treePass: FULL_RUN },
    failed: {
      event: 'pull_request',
      treePass: { result: 'failure', outputs: { ...SKIP_RUN.outputs, save: 'true' } },
    },
    hit: { event: 'pull_request', treePass: SKIP_RUN },
    miss: { event: 'pull_request', treePass: FULL_RUN },
    // A miss that would save, on a docs-only change: it ends as a hit does,
    // and saves nothing.
    'docs-only': { event: 'pull_request', treePass: DOCS_ONLY_RUN },
  }
  const shards = {
    'all passed': {},
    'one failed': { legs: { 3: 'failure' } },
    'one cancelled': { legs: { 2: 'cancelled' } },
    // GitHub decides a matrix job's `if` once for every leg, so one leg is
    // never skipped alone; were it, and counted as a pass, only a hit,
    // where no leg runs its steps, would still pass.
    'one skipped': { legs: { [total]: 'skipped' } },
    'all skipped': { legs: allLegs('skipped') },
    // "Re-run failed jobs" after a shard failed: the passing legs are reused.
    // If GitHub did not carry their outputs into the new attempt, the check
    // fails and nothing is recorded.
    'rerun without reused outputs': { lostOutputs: reusedOutputs(3) },
    // The run cancelled, by a newer push or by hand: before the shards
    // started (they never run, and GitHub reports them cancelled), while
    // they run (each leg is cancelled), or after they ended. The required
    // job runs in each case; a cancellation that lands before it can start
    // may report it cancelled instead, which does not pass either.
    'run cancelled before the shards': { runCancelled: true },
    'run cancelled while the shards run': {
      legs: allLegs('cancelled'),
      cancelledAfterShards: true,
    },
    'run cancelled after one failed': { legs: { 3: 'failure' }, cancelledAfterShards: true },
    'run cancelled after all passed': { cancelledAfterShards: true },
  }
  // [aggregate result, its tested output, save job runs, record accepts]. The
  // record step also refuses a skipped or failed tree-pass, should the save
  // job run without it.
  const pass = ['success', 'true', false, false]
  const hitPass = ['success', undefined, false, false]
  const fail = ['failure', undefined, false, false]
  const table = {
    'skipped (no pull request)': {
      'all passed': pass,
      'one failed': fail,
      'one cancelled': fail,
      'one skipped': fail,
      'all skipped': fail,
      'rerun without reused outputs': fail,
      'run cancelled before the shards': fail,
      'run cancelled while the shards run': fail,
      'run cancelled after one failed': fail,
      'run cancelled after all passed': pass,
    },
    failed: {
      'all passed': pass,
      'one failed': fail,
      'one cancelled': fail,
      'one skipped': fail,
      'all skipped': fail,
      'rerun without reused outputs': fail,
      'run cancelled before the shards': fail,
      'run cancelled while the shards run': fail,
      'run cancelled after one failed': fail,
      'run cancelled after all passed': pass,
    },
    hit: {
      'all passed': hitPass,
      'one failed': fail,
      'one cancelled': fail,
      'one skipped': hitPass,
      'all skipped': fail,
      'rerun without reused outputs': hitPass,
      'run cancelled before the shards': fail,
      'run cancelled while the shards run': fail,
      'run cancelled after one failed': fail,
      'run cancelled after all passed': hitPass,
    },
    miss: {
      'all passed': ['success', 'true', true, true],
      'one failed': fail,
      'one cancelled': fail,
      'one skipped': fail,
      'all skipped': fail,
      'rerun without reused outputs': fail,
      'run cancelled before the shards': fail,
      'run cancelled while the shards run': fail,
      'run cancelled after one failed': fail,
      // The shards passed, so the check does; a cancelled run saves nothing.
      'run cancelled after all passed': ['success', 'true', false, true],
    },
  }
  table['docs-only'] = table.hit
  for (const [markerState, markerRun] of Object.entries(markers)) {
    for (const [shardState, shardRun] of Object.entries(shards)) {
      const where = `marker ${markerState}, shards ${shardState}`
      const run = simulate(t, SHARDED_FILE, { ...markerRun, ...shardRun })
      const [result, tested, saves, records] = table[markerState][shardState]
      const job = run[aggregate]
      assert.equal(job.ran, true, `${where}: ${aggregate} always reports a result`)
      // None of these runs waits for a signed head: the real name.
      assert.equal(job.name, REQUIRED_G3, where)
      assert.equal(job.result, result, where)
      assert.equal(job.outputs.tested, tested, where)
      if (result === 'failure') assert.notDeepEqual(job.errors, [], `${where}: it says why`)
      assert.equal(run[SAVE_JOB].ran, saves, where)
      assert.equal(recordErrors({ needs: run[SAVE_JOB].needs }).length === 0, records, where)
      // A failed or cancelled leg still uploads its report and stops its
      // harness, and records nothing.
      for (const leg of run[shardJob].legs) {
        if (
          !['failure', 'cancelled'].includes(leg.result) ||
          ['hit', 'docs-only'].includes(markerState)
        )
          continue
        assert.ok(leg.steps.includes('Upload Playwright release-gate artifacts'), where)
        assert.ok(leg.steps.includes('Stop qbit regtest harness'), where)
        assert.deepEqual(leg.outputs, {}, where)
      }
    }
  }

  // Each shard on its own: a leg that recorded nothing fails the check, which
  // names it, even if GitHub counted the shard job as passed.
  for (const shard of shardRange(total)) {
    const run = simulate(t, SHARDED_FILE, { ...markers.miss, legs: { [shard]: 'skipped' } })
    assert.equal(run[shardJob].result, 'success', `shard ${shard}`)
    assert.equal(run[aggregate].result, 'failure', `shard ${shard}`)
    assert.deepEqual(
      run[aggregate].errors,
      [`::error::Shard ${shard} of ${total} did not run all its steps.`],
      `shard ${shard}`
    )
    assert.equal(run[SAVE_JOB].ran, false, `shard ${shard}`)
  }
})

// --- G3 waits for a signed head ----------------------------------------------

const SIGNED_HEAD_SHA = 'f'.repeat(40)

// The signed-head step's environment as a pull request run gives it: what
// the runner sets for every step, the workflow's env, then the step's own,
// which wins, each resolved from the workflow file. `markerSkip` and
// `docsOnly` are what the decide and docs-only steps wrote.
function signedHeadStepEnvironment({ markerSkip = 'false', docsOnly = 'false', output, summary }) {
  const { env, jobs } = readWorkflow(SHARDED_FILE)
  const step = jobs[DECIDE_JOB].steps.find(entry => entry.id === 'signed-head')
  const context = {
    github: {
      token: 'token-value',
      event: { pull_request: { number: 42, head: { sha: SIGNED_HEAD_SHA } } },
    },
    steps: {
      decide: { outputs: { skip: markerSkip } },
      'docs-only': { outputs: { 'docs-only': docsOnly } },
    },
    vars: {},
  }
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_API_URL: API,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_OUTPUT: output,
    ...(summary ? { GITHUB_STEP_SUMMARY: summary } : {}),
    ...resolveTemplates(env, context),
    ...resolveTemplates(step.env, context),
  }
}

// GitHub as the signed-head step reads it: the pull request's labels and the
// head commit's verification. Records each URL asked for.
function signedHeadGitHub({ labels = [], verification = { verified: false, reason: 'unsigned' } }) {
  const asked = []
  const fetchImpl = async (url, options) => {
    asked.push(url)
    assert.equal(options.headers.Authorization, 'Bearer token-value')
    if (url === `${API}/repos/${REPOSITORY}/pulls/42`) {
      return fakeResponse(200, { labels: labels.map(name => ({ name })) })
    }
    if (url === `${API}/repos/${REPOSITORY}/commits/${SIGNED_HEAD_SHA}`) {
      return fakeResponse(200, { sha: SIGNED_HEAD_SHA, commit: { verification } })
    }
    return assert.fail(`unexpected request ${url}`)
  }
  return { fetchImpl, asked }
}

// What the signed-head step writes as `wait`, run for real with the
// workflow's settings against `signedHeadGitHub`.
async function signedHeadWait(t, { markerSkip, docsOnly, ...github } = {}) {
  const output = join(scratch(t, 'signed-head-wait-'), 'output')
  const { fetchImpl, asked } = signedHeadGitHub(github)
  await runSignedHeadGate(signedHeadStepEnvironment({ markerSkip, docsOnly, output }), {
    fetchImpl,
    log: { log() {} },
  })
  return { wait: outputs(output).wait, asked }
}

test('Playwright G3 scenarios has its real name in every state but a wait for a signed head', () => {
  const expected = MARKED_WORKFLOWS[SHARDED_FILE]
  const { jobs } = readWorkflow(SHARDED_FILE)
  const job = jobs[expected.signedHead.aggregate]
  assert.equal(job.name, SIGNED_AGGREGATE_NAME)
  // It can have only these two names, and only the real one is a required
  // check, whatever the required checks are.
  assert.deepEqual(namesJobCanHave(job, expected.signedHead.aggregate), [WAITING_G3, REQUIRED_G3])
  assert.ok(!requiredContexts().has(WAITING_G3))
  assert.ok(REQUIRED_CONTEXTS.includes(REQUIRED_G3))
  const nameFor = (marker, extra = {}) =>
    renderName(job, {
      github: { event_name: 'pull_request' },
      needs: {
        [DECIDE_JOB]: marker,
        [expected.signedHead.sharded]: { result: 'skipped', outputs: {} },
      },
      ...extra,
    })
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const wait of ['true', 'TRUE', 'false', '', undefined, 'yes', ' true', 'true ']) {
      const marker = { result, outputs: wait === undefined ? {} : { 'signed-head-wait': wait } }
      // GitHub's == ignores case, so TRUE waits too; signed-head-gate.mjs
      // writes only true or false.
      const waits = result === 'success' && wait?.toLowerCase() === 'true'
      const name = nameFor(marker)
      assert.equal(name, waits ? WAITING_G3 : REQUIRED_G3, `${result}/${JSON.stringify(wait)}`)
      assert.ok(namesJobCanHave(job, 'aggregate').includes(name))
    }
  }
  // A push or a dispatch: no marker job, so no outputs.
  assert.equal(nameFor({ result: 'skipped', outputs: {} }), REQUIRED_G3)
  assert.equal(renderName(job, { needs: {} }), REQUIRED_G3)
  // A marker job that hit or found a docs-only change but also said wait,
  // which the script never writes, still renders by the wait alone.
  assert.equal(
    nameFor({ result: 'success', outputs: { skip: 'true', 'signed-head-wait': 'false' } }),
    REQUIRED_G3
  )
  // The name decide looks for in a run that tested is the real one.
  assert.equal(testingNameOf(job), REQUIRED_G3)
})

test('the gate of Playwright G3 scenarios tells a wait for a signed head after a hit and a docs-only change', t => {
  const temp = scratch(t, 'signed-head-gate-')
  const { jobs } = readWorkflow(SHARDED_FILE)
  const gate = jobs[MARKED_WORKFLOWS[SHARDED_FILE].signedHead.aggregate].steps[0]
  assert.equal(gate.run, SIGNED_AGGREGATE_GATE_RUN)
  const url = 'https://github.com/Qbit-Org/qbit-wallet/actions/runs/1001/attempts/1'
  const howTo = HOW_TO_RUN_G3.replace('$TREE_PASS_FORCE_LABEL', FORCE_LABEL)
  // [marker job result, skip, docs-only, wait, gate's skip, gate's wait]
  const rows = [
    ['success', 'false', 'false', 'true', undefined, 'true'],
    ['success', '', '', 'true', undefined, 'true'],
    // A hit and a docs-only change come first, and wait never sets skip.
    ['success', 'true', 'false', 'true', 'true', undefined],
    ['success', 'false', 'true', 'true', 'true', undefined],
    ['success', 'true', 'true', 'true', 'true', undefined],
    ['success', 'false', 'false', 'TRUE', undefined, undefined],
    ['success', 'false', 'false', 'false', undefined, undefined],
    ['success', 'false', 'false', '', undefined, undefined],
    ['failure', 'false', 'false', 'true', undefined, undefined],
    ['cancelled', 'false', 'false', 'true', undefined, undefined],
    ['skipped', '', '', 'true', undefined, undefined],
    ['', '', '', 'true', undefined, undefined],
  ]
  for (const [index, [result, skip, docsOnly, wait, gateSkip, gateWait]] of rows.entries()) {
    const at = `${result}/${skip}/${docsOnly}/${wait}`
    const run = runGate(temp, `signed-${index}`, { result, skip, url, docsOnly, wait }, gate.run)
    assert.equal(run.skip, gateSkip, at)
    assert.equal(run.wait, gateWait, at)
    assert.equal(run.summary.includes(howTo), gateWait === 'true', at)
    assert.equal(run.summary.includes('waits for a signed head'), gateWait === 'true', at)
  }
})

test('G3 waits for a signed head only when a successful marker job says so, and then never passes', async t => {
  const expected = MARKED_WORKFLOWS[SHARDED_FILE]
  const { sharded: shardJob, aggregate } = expected.signedHead
  const { jobs } = readWorkflow(SHARDED_FILE)
  const total = jobs[shardJob].strategy.matrix.shard.length
  const allLegs = result => Object.fromEntries(shardRange(total).map(shard => [shard, result]))

  // What the step writes, from GitHub's answers: an unsigned head waits; the
  // label, a marker hit, a docs-only change, a verified head and a head
  // GitHub could not check do not. The commit is read only when none of the
  // label, a marker hit and a docs-only change decided, and a marker hit or
  // a docs-only change sends no request.
  const commit = `${API}/repos/${REPOSITORY}/commits/${SIGNED_HEAD_SHA}`
  const unsigned = await signedHeadWait(t)
  assert.deepEqual(unsigned, {
    wait: 'true',
    asked: [`${API}/repos/${REPOSITORY}/pulls/42`, commit],
  })
  const labelled = await signedHeadWait(t, { labels: [FORCE_LABEL] })
  const hit = await signedHeadWait(t, { markerSkip: 'true' })
  const docs = await signedHeadWait(t, { docsOnly: 'true' })
  for (const decided of [labelled, hit, docs]) assert.equal(decided.wait, 'false')
  assert.deepEqual(labelled.asked, [`${API}/repos/${REPOSITORY}/pulls/42`])
  assert.deepEqual(hit.asked, [])
  assert.deepEqual(docs.asked, [])
  const signed = await signedHeadWait(t, { verification: { verified: true, reason: 'valid' } })
  const unchecked = await signedHeadWait(t, {
    verification: { verified: false, reason: 'gpgverify_unavailable' },
  })
  assert.equal(signed.wait, 'false')
  assert.equal(unchecked.wait, 'false')
  // Nor does a reason outside GitHub's definite ones, such as S/MIME's.
  for (const reason of ['ocsp_pending', 'some_future_reason']) {
    const doubt = await signedHeadWait(t, { verification: { verified: false, reason } })
    assert.equal(doubt.wait, 'false', reason)
  }

  const withWait = (marker, wait) => ({
    result: marker.result,
    outputs: { ...marker.outputs, 'signed-head-wait': wait },
  })
  // With the label on, the key step uses no marker: decide neither skips
  // nor saves.
  const LABELLED_RUN = {
    result: 'success',
    outputs: { prefix: PREFIX, skip: 'false', save: 'false', 'run-url': '' },
  }
  const scenarios = [
    // [label, simulate options, shards, name, result, tested, saves]
    [
      'unsigned',
      { treePass: withWait(FULL_RUN, unsigned.wait) },
      'skipped',
      WAITING_G3,
      'success',
      undefined,
      false,
    ],
    [
      'unsigned with the label',
      { treePass: withWait(LABELLED_RUN, labelled.wait) },
      'full',
      REQUIRED_G3,
      'success',
      'true',
      false,
    ],
    [
      'unsigned with a marker hit',
      { treePass: withWait(SKIP_RUN, hit.wait) },
      'gate',
      REQUIRED_G3,
      'success',
      undefined,
      false,
    ],
    [
      'unsigned and docs-only',
      { treePass: withWait(DOCS_ONLY_RUN, docs.wait) },
      'gate',
      REQUIRED_G3,
      'success',
      undefined,
      false,
    ],
    [
      'signed',
      { treePass: withWait(FULL_RUN, signed.wait) },
      'full',
      REQUIRED_G3,
      'success',
      'true',
      true,
    ],
    [
      'not checked by GitHub',
      { treePass: withWait(FULL_RUN, unchecked.wait) },
      'full',
      REQUIRED_G3,
      'success',
      'true',
      true,
    ],
    // A marker job that did not succeed runs everything under the real name,
    // whatever its outputs say, and saves nothing.
    ...['failure', 'cancelled', 'skipped'].map(result => [
      `the marker job ${result}, saying wait`,
      { treePass: { result, outputs: { ...FULL_RUN.outputs, 'signed-head-wait': 'true' } } },
      'full',
      REQUIRED_G3,
      'success',
      'true',
      false,
    ]),
    // A wait the gate does not read as one (GitHub's == ignores case, the
    // shell does not): no shard runs and the check fails, under the waiting
    // name. The script never writes it.
    [
      'wait in upper case',
      { treePass: withWait(FULL_RUN, 'TRUE') },
      'skipped',
      WAITING_G3,
      'failure',
      undefined,
      false,
    ],
    // Cancelled runs, waiting and not.
    [
      'unsigned, run cancelled before the shards',
      { treePass: withWait(FULL_RUN, 'true'), cancelledAfterMarker: true },
      'cancelled',
      WAITING_G3,
      'failure',
      undefined,
      false,
    ],
    [
      'run cancelled before the marker job',
      { treePass: withWait(FULL_RUN, 'true'), runCancelled: true },
      'cancelled',
      REQUIRED_G3,
      'failure',
      undefined,
      false,
    ],
    [
      'unsigned, run cancelled after the shards were skipped',
      { treePass: withWait(FULL_RUN, 'true'), cancelledAfterShards: true },
      'skipped',
      WAITING_G3,
      'success',
      undefined,
      false,
    ],
    [
      'signed, run cancelled before the shards',
      { treePass: withWait(FULL_RUN, 'false'), cancelledAfterMarker: true },
      'cancelled',
      REQUIRED_G3,
      'failure',
      undefined,
      false,
    ],
    [
      'signed, run cancelled while the shards run',
      {
        treePass: withWait(FULL_RUN, 'false'),
        legs: allLegs('cancelled'),
        cancelledAfterShards: true,
      },
      'cancelled legs',
      REQUIRED_G3,
      'failure',
      undefined,
      false,
    ],
    [
      'the marker job cancelled by the run, saying wait',
      {
        treePass: {
          result: 'cancelled',
          outputs: { ...FULL_RUN.outputs, 'signed-head-wait': 'true' },
        },
        cancelledAfterMarker: true,
      },
      'cancelled',
      REQUIRED_G3,
      'failure',
      undefined,
      false,
    ],
  ]
  for (const [label, options, shards, name, result, tested, saves] of scenarios) {
    const run = simulate(t, SHARDED_FILE, { event: 'pull_request', ...options })
    const job = run[aggregate]
    if (shards === 'skipped' || shards === 'cancelled') {
      // The matrix is skipped whole: no leg starts, so no runner is taken.
      assert.equal(run[shardJob].ran, false, `${label}: no shard starts`)
      assert.deepEqual(run[shardJob].legs, [], label)
      assert.equal(run[shardJob].result, shards, label)
    } else if (shards === 'cancelled legs') {
      assert.equal(run[shardJob].result, 'cancelled', label)
    } else {
      assertLegs(run, expected, label, { full: shards === 'full' })
    }
    assert.equal(job.ran, true, `${label}: ${aggregate} always reports a result`)
    assert.equal(job.name, name, label)
    assert.equal(job.result, result, label)
    assert.equal(job.outputs.tested, tested, label)
    assert.equal(run[SAVE_JOB].ran, saves, label)
    if (result === 'failure') assert.notDeepEqual(job.errors, [], `${label}: it says why`)
    // A wait never gives a passing check under the required name.
    if (name === WAITING_G3) assert.notEqual(job.name, REQUIRED_G3, label)
    // While waiting, the check says how to get G3, and the gate's summary too.
    if (label === 'unsigned') {
      const howTo = HOW_TO_RUN_G3.replace('$TREE_PASS_FORCE_LABEL', FORCE_LABEL)
      assert.deepEqual(job.steps, ['Check for a tree pass marker', SHARD_CHECK_NAME], label)
      assert.deepEqual(job.notices, [`::notice::G3 waits for a signed head. ${howTo}`], label)
      assert.ok(job.summary.includes(howTo), label)
      assert.deepEqual(job.errors, [], label)
      // Even if the save job ran, record refuses: nothing was tested.
      assert.notDeepEqual(
        recordErrors({
          needs: {
            [DECIDE_JOB]: options.treePass,
            [aggregate]: { result: job.result, outputs: job.outputs },
          },
        }),
        [],
        label
      )
    }
  }

  // While waiting, the check passes only when the shards' result is skipped
  // and no shard recorded anything; anything else fails it, and records
  // nothing.
  const waiting = withWait(FULL_RUN, 'true')
  const everyTested = Object.fromEntries(
    shardRange(total).map(shard => [`tested-${shard}`, 'true'])
  )
  const checks = [
    ['skipped', {}, 'success'],
    ['skipped', { 'tested-2': 'true' }, 'failure'],
    ['skipped', { 'tested-5': 'false' }, 'failure'],
    ['success', {}, 'failure'],
    ['success', everyTested, 'failure'],
    ['failure', {}, 'failure'],
    ['cancelled', {}, 'failure'],
    ['', {}, 'failure'],
  ]
  for (const [index, [shardsResult, shardOutputs, result]] of checks.entries()) {
    const at = `waiting, shards ${shardsResult || '(none)'} ${JSON.stringify(shardOutputs)}`
    const job = simulateAggregate(
      scratch(t, `signed-head-check-${index}-`),
      aggregate,
      jobs[aggregate],
      {
        needs: {
          [DECIDE_JOB]: waiting,
          [shardJob]: { result: shardsResult, outputs: shardOutputs },
        },
        github: { event_name: 'pull_request' },
        runCancelled: false,
        workflowEnv: { TREE_PASS_FORCE_LABEL: FORCE_LABEL },
      }
    )
    assert.equal(job.name, WAITING_G3, at)
    assert.equal(job.result, result, at)
    assert.equal(job.outputs.tested, undefined, at)
    if (result === 'failure') assert.notDeepEqual(job.errors, [], at)
  }
})

test('the signed-head step passes every setting the script reads, by the names the workflow gives them', async t => {
  const { env: workflowEnv, jobs } = readWorkflow(SHARDED_FILE)
  const lookup = jobs[DECIDE_JOB]
  const step = lookup.steps.find(entry => entry.id === 'signed-head')
  const temp = scratch(t, 'signed-head-settings-')
  const output = join(temp, 'output')
  const env = signedHeadStepEnvironment({ output, summary: join(temp, 'summary') })
  // Every read the script makes, on the path that reads the most: a wait.
  const reads = new Set()
  const recorded = new Proxy(env, {
    get(target, key) {
      if (typeof key === 'string') reads.add(key)
      return target[key]
    },
  })
  const github = signedHeadGitHub({})
  await runSignedHeadGate(recorded, { fetchImpl: github.fetchImpl, log: { log() {} } })
  assert.equal(readFileSync(output, 'utf8'), 'wait=true\n')

  // What the runner sets for every step; the rest must come from the
  // workflow's env or the step's.
  const runner = [
    'GITHUB_EVENT_NAME',
    'GITHUB_API_URL',
    'GITHUB_REPOSITORY',
    'GITHUB_OUTPUT',
    'GITHUB_STEP_SUMMARY',
  ]
  const fromWorkflow = Object.keys(workflowEnv)
  const fromStep = Object.keys(step.env)
  for (const name of reads) {
    assert.ok(
      runner.includes(name) || fromStep.includes(name) || fromWorkflow.includes(name),
      `the script reads ${name}, which neither the runner nor the workflow sets`
    )
  }
  for (const name of fromStep) {
    assert.ok(reads.has(name), `the step passes ${name}, which the script never reads`)
  }
  // The force label is the workflow's, which the step does not override, and
  // no setting shadows a runner variable.
  assert.ok(reads.has('TREE_PASS_FORCE_LABEL'))
  assert.equal(workflowEnv.TREE_PASS_FORCE_LABEL, FORCE_LABEL)
  assert.ok(!fromStep.includes('TREE_PASS_FORCE_LABEL'))
  for (const name of [...fromStep, ...fromWorkflow]) assert.doesNotMatch(name, /^GITHUB_/)

  // Each value reaches the reader: the pull request number names the label
  // read, the head SHA the commit read, and the earlier steps' outputs, read
  // through the names the job also exposes, decide.
  assert.deepEqual(github.asked, [
    `${API}/repos/${REPOSITORY}/pulls/42`,
    `${API}/repos/${REPOSITORY}/commits/${SIGNED_HEAD_SHA}`,
  ])
  assert.equal(lookup.outputs.skip, '${{ steps.decide.outputs.skip }}')
  assert.equal(lookup.outputs['docs-only'], '${{ steps.docs-only.outputs.docs-only }}')
  assert.equal(lookup.outputs['signed-head-wait'], '${{ steps.signed-head.outputs.wait }}')
  const ids = lookup.steps.map(entry => entry.id)
  assert.ok(ids.indexOf('decide') < ids.indexOf('signed-head'))
  assert.ok(ids.indexOf('docs-only') < ids.indexOf('signed-head'))
  for (const [settings, reason] of [
    [{ markerSkip: 'true' }, /marker already vouches/],
    [{ docsOnly: 'true' }, /changes only documentation/],
  ]) {
    const quiet = join(scratch(t, 'signed-head-settings-'), 'output')
    const other = signedHeadGitHub({})
    const verdict = await runSignedHeadGate(
      signedHeadStepEnvironment({ ...settings, output: quiet }),
      { fetchImpl: other.fetchImpl, log: { log() {} } }
    )
    assert.match(verdict.reason, reason)
    assert.equal(readFileSync(quiet, 'utf8'), 'wait=false\n')
    // The earlier steps' verdicts settle it before any request.
    assert.deepEqual(other.asked, [])
  }
})

// --- The lanes of Typecheck, test, and build -------------------------------

const LANED_FILE = '.github/workflows/ci.yml'

// The aggregating job's result, whether it reports tested=true, whether the
// save job runs and whether its record step accepts, for each state of the
// marker job and each way the lanes can end. Each lane is a job of its own
// and reports its own result, unlike a leg of a matrix job.
test('Typecheck, test, and build passes only when every lane passed, and a marker needs every lane tested', t => {
  const expected = MARKED_WORKFLOWS[LANED_FILE]
  const { jobs } = readWorkflow(LANED_FILE)
  const lanes = Object.keys(expected.lanes)
  const [aggregate, ...otherAggregates] = new Set(Object.values(expected.lanes))
  assert.deepEqual(otherAggregates, [])
  assert.ok(lanes.length >= 2, 'at least two lanes')
  const [firstLane, secondLane] = lanes
  const lastLane = lanes.at(-1)
  const allLanes = result => Object.fromEntries(lanes.map(lane => [lane, result]))
  const markers = {
    'skipped (no pull request)': { event: 'push', treePass: FULL_RUN },
    failed: {
      event: 'pull_request',
      treePass: { result: 'failure', outputs: { ...SKIP_RUN.outputs, save: 'true' } },
    },
    hit: { event: 'pull_request', treePass: SKIP_RUN },
    miss: { event: 'pull_request', treePass: FULL_RUN },
    // A miss that would save, on a docs-only change: it ends as a hit does,
    // and saves nothing.
    'docs-only': { event: 'pull_request', treePass: DOCS_ONLY_RUN },
  }
  const states = {
    'all passed': {},
    'one failed': { lanes: { [secondLane]: 'failure' } },
    // A lane that hits its timeout ends cancelled.
    'one cancelled': { lanes: { [lastLane]: 'cancelled' } },
    // GitHub skips a lane only in a cancelled run, and then reports it
    // cancelled; were one skipped, its own result would still show it.
    'one skipped': { lanes: { [firstLane]: 'skipped' } },
    'all skipped': { lanes: allLanes('skipped') },
    // "Re-run failed jobs" after a lane failed: the passing lanes are
    // reused. If GitHub did not carry their outputs into the new attempt,
    // the check fails and nothing is recorded.
    'rerun without reused outputs': {
      lostLaneOutputs: lanes.filter(lane => lane !== secondLane),
    },
    // The run cancelled before the lanes started (they never run, and
    // GitHub reports them cancelled), while they run (each is cancelled), or
    // after they ended.
    'run cancelled before the lanes': { runCancelled: true },
    'run cancelled while the lanes run': {
      lanes: allLanes('cancelled'),
      cancelledAfterShards: true,
    },
    'run cancelled after one failed': {
      lanes: { [secondLane]: 'failure' },
      cancelledAfterShards: true,
    },
    'run cancelled after all passed': { cancelledAfterShards: true },
  }
  // [aggregate result, its tested output, save job runs, record accepts]. The
  // record step also refuses a skipped or failed tree-pass, should the save
  // job run without it.
  const pass = ['success', 'true', false, false]
  const hitPass = ['success', undefined, false, false]
  const fail = ['failure', undefined, false, false]
  const onlyFullPasses = {
    'all passed': pass,
    'one failed': fail,
    'one cancelled': fail,
    'one skipped': fail,
    'all skipped': fail,
    'rerun without reused outputs': fail,
    'run cancelled before the lanes': fail,
    'run cancelled while the lanes run': fail,
    'run cancelled after one failed': fail,
    'run cancelled after all passed': pass,
  }
  const table = {
    'skipped (no pull request)': onlyFullPasses,
    failed: onlyFullPasses,
    hit: {
      ...onlyFullPasses,
      'all passed': hitPass,
      'rerun without reused outputs': hitPass,
      'run cancelled after all passed': hitPass,
    },
    miss: {
      ...onlyFullPasses,
      'all passed': ['success', 'true', true, true],
      // The lanes passed, so the check does; a cancelled run saves nothing.
      'run cancelled after all passed': ['success', 'true', false, true],
    },
  }
  table['docs-only'] = table.hit
  for (const [markerState, markerRun] of Object.entries(markers)) {
    for (const [laneState, laneRun] of Object.entries(states)) {
      const where = `marker ${markerState}, lanes ${laneState}`
      const run = simulate(t, LANED_FILE, { ...markerRun, ...laneRun })
      const [result, tested, saves, records] = table[markerState][laneState]
      const job = run[aggregate]
      assert.equal(job.ran, true, `${where}: ${aggregate} always reports a result`)
      assert.equal(job.result, result, where)
      assert.equal(job.outputs.tested, tested, where)
      if (result === 'failure') {
        assert.notDeepEqual(job.errors, [], `${where}: it says why`)
        // Each error names a lane, and the summary repeats it.
        for (const error of job.errors) {
          const message = error.slice('::error::'.length)
          assert.ok(
            lanes.some(lane => message.startsWith(`Lane "${jobs[lane].name}"`)),
            `${where}: ${error}`
          )
          assert.ok(job.summary.includes(`- ${message}\n`), `${where}: ${error}`)
        }
      } else {
        assert.deepEqual(job.errors, [], where)
      }
      // A run cancelled before the marker job started has no marker hit and
      // no docs-only verdict.
      assert.equal(
        job.summary.includes('so the lanes skipped their steps'),
        ['hit', 'docs-only'].includes(markerState) && run[DECIDE_JOB].ran,
        where
      )
      assert.equal(
        job.summary.includes('changes only documentation that no skipped step reads'),
        markerState === 'docs-only' && run[DECIDE_JOB].ran,
        where
      )
      assert.equal(run[SAVE_JOB].ran, saves, where)
      assert.equal(recordErrors({ needs: run[SAVE_JOB].needs }).length === 0, records, where)
    }
  }

  // Each lane on its own: a lane that failed, was cancelled or skipped, or
  // recorded nothing fails the check, which names that lane alone, even when
  // every other lane passed.
  for (const lane of lanes) {
    const name = jobs[lane].name
    for (const [ending, error] of [
      ['failure', `Lane "${name}": its result is "failure", not success; see its job.`],
      ['cancelled', `Lane "${name}": its result is "cancelled", not success; see its job.`],
      ['skipped', `Lane "${name}": its result is "skipped", not success; see its job.`],
      ['lost', `Lane "${name}" did not run all its steps.`],
    ]) {
      const options =
        ending === 'lost' ? { lostLaneOutputs: [lane] } : { lanes: { [lane]: ending } }
      for (const markerState of ['miss', 'hit', 'docs-only']) {
        const run = simulate(t, LANED_FILE, { ...markers[markerState], ...options })
        const where = `${lane} ${ending} on a ${markerState}`
        // A hit or a docs-only change needs no lane's `tested`, only its
        // success.
        if (ending === 'lost' && markerState !== 'miss') {
          assert.equal(run[aggregate].result, 'success', where)
          continue
        }
        assert.equal(run[aggregate].result, 'failure', where)
        assert.deepEqual(run[aggregate].errors, [`::error::${error}`], where)
        assert.equal(run[SAVE_JOB].ran, false, where)
      }
    }
  }
})

test('the condition evaluator follows GitHub for the forms the workflows use', () => {
  const status = { success: true, failure: false, cancelled: false, always: true }
  const needs = { 'tree-pass': { result: 'success', outputs: { skip: 'TRUE' } } }
  assert.equal(evaluateIf("needs.tree-pass.outputs.skip == 'true'", { needs, status }), true)
  assert.equal(evaluateIf("needs.tree-pass.outputs.missing == ''", { needs, status }), true)
  assert.equal(evaluateIf('${{ !cancelled() }}', { needs, status }), true)
  assert.equal(evaluateIf("!(true && 'a' == 'b') || false", { status }), true)
  assert.equal(evaluateIf('true && false || true', { status }), true)
  assert.equal(evaluateIf("'x' != 'X'", { status }), false)
  // The implicit success().
  assert.equal(evaluateIf('true', { status: { ...status, success: false } }), false)
  assert.equal(evaluateIf('always() && true', { status: { ...status, success: false } }), true)
  assert.throws(() => evaluateIf("contains('a', 'b')", { status }))
  // As a value, && and || give an operand, as in a computed job name.
  assert.equal(evaluateExpression("true && 'a' || 'b'", { status }), 'a')
  assert.equal(evaluateExpression("false && 'a' || 'b'", { status }), 'b')
  assert.equal(evaluateExpression("'' || 'b'", { status }), 'b')
  assert.equal(evaluateExpression("'x' && ''", { status }), '')
  assert.equal(evaluateExpression("'it''s (here)'", { status }), "it's (here)")
  assert.equal(
    evaluateExpression("needs.tree-pass.outputs.skip == 'true' && 'hit' || 'miss'", { needs }),
    'hit'
  )
  assert.equal(
    renderName({ name: 'Shard ${{ matrix.shard }} of 5' }, { matrix: { shard: 3 } }),
    'Shard 3 of 5'
  )
  assert.throws(() => renderName({ name: "${{ always() && 'a' }}" }, {}))
})
