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
const GATE_RUN = `if [ "$MARKER_JOB_RESULT" = success ] && [ "$MARKER_SKIP" = true ]; then
  echo 'skip=true' >> "$GITHUB_OUTPUT"
  echo "This tree already passed this job in $MARKER_RUN_URL, so its steps are skipped." >> "$GITHUB_STEP_SUMMARY"
fi
`
const MARKED_WORKFLOWS = {
  '.github/workflows/ci.yml': {
    id: 'ci',
    // Required checks keep running and skip their steps.
    stepGated: ['verify'],
    // Other covered jobs are skipped whole.
    jobGated: ['lint'],
    // Never covered: they run on every event.
    uncovered: ['dependency-policy'],
  },
  '.github/workflows/playwright-release-gate.yml': {
    id: 'browser-release-gate',
    stepGated: ['playwright-release-gate'],
    jobGated: [],
    uncovered: [],
  },
}
// Ruleset main-protection (26062908) requires these contexts on main.
const REQUIRED_CONTEXTS = ['Typecheck, test, and build', 'Playwright G3 scenarios']

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
    assert.deepEqual(lookup.outputs, {
      prefix: '${{ steps.key.outputs.prefix }}',
      skip: '${{ steps.decide.outputs.skip }}',
      save: '${{ steps.decide.outputs.save }}',
      'run-url': '${{ steps.decide.outputs.run-url }}',
    })
    // No setup-node: the script runs on the runner image's Node.
    const [checkout, keyStep, lookupStep, decideStep] = lookup.steps
    assert.equal(lookup.steps.length, 4, where)
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
    // decide checks, in the run a marker names, exactly the covered jobs.
    assert.deepEqual(
      JSON.parse(coveredJobs).sort(),
      covered.map(name => jobs[name].name).sort(),
      where
    )

    const save = jobs[SAVE_JOB]
    assert.equal(save.name, SAVE_JOB_NAME, where)
    assert.deepEqual([...save.needs].sort(), [DECIDE_JOB, ...covered].sort(), where)
    assert.equal(save.if, "needs.tree-pass.outputs.save == 'true'", where)
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

    // Every job that waits on the lookup is covered, and the save waits on all of them.
    const dependents = Object.entries(jobs)
      .filter(([name, entry]) => name !== SAVE_JOB && [entry.needs].flat().includes(DECIDE_JOB))
      .map(([name]) => name)
    assert.deepEqual(dependents.sort(), [...covered].sort(), where)
    assert.deepEqual(
      Object.keys(jobs).sort(),
      [DECIDE_JOB, SAVE_JOB, ...covered, ...expected.uncovered].sort(),
      where
    )

    for (const name of covered) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      assert.equal(entry.needs, DECIDE_JOB, at)
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
      assert.equal(last.if, expected.stepGated.includes(name) ? SKIP_STEP : undefined, at)
    }

    for (const name of expected.stepGated) {
      const entry = jobs[name]
      const at = `${where} job ${name}`
      assert.equal(entry.if, '${{ !cancelled() }}', at)
      const [gate, ...rest] = entry.steps
      assert.equal(gate.id, 'gate', at)
      assert.equal(gate.if, undefined, at)
      assert.deepEqual(gate.env, {
        MARKER_JOB_RESULT: '${{ needs.tree-pass.result }}',
        MARKER_SKIP: '${{ needs.tree-pass.outputs.skip }}',
        MARKER_RUN_URL: '${{ needs.tree-pass.outputs.run-url }}',
      })
      assert.equal(gate.run, GATE_RUN, at)
      for (const step of rest) {
        assert.ok(
          step.if === SKIP_STEP || step.if === `always() && ${SKIP_STEP}`,
          `${at}: step ${step.name} must be skipped only by the gate, found ${JSON.stringify(step.if)}`
        )
      }
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

// The required checks: the contexts above, and those in
// .github/rulesets/required-checks.json once that file exists (its format is
// not settled, so every string under a "context" key, or in a list under a key
// naming checks or contexts, counts).
function requiredContexts() {
  const contexts = new Set(REQUIRED_CONTEXTS)
  const file = join(repoRoot, '.github/rulesets/required-checks.json')
  if (!existsSync(file)) return contexts
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
  assert.ok(found.size > 0, `${file} lists no check this test can read; update requiredContexts()`)
  for (const context of found) contexts.add(context)
  return contexts
}

test('every required check comes from a job that reports a real result in the skip path', () => {
  for (const context of requiredContexts()) {
    const producers = []
    for (const file of trackedWorkflows()) {
      for (const [name, entry] of Object.entries(readWorkflow(file).jobs)) {
        if (entry.name === context) producers.push({ file, name, job: entry })
      }
    }
    assert.equal(producers.length, 1, `${context} must come from exactly one job`)
    const [{ file, name, job: entry }] = producers
    assert.equal(entry.strategy, undefined, `${context} must not be a matrix job`)
    if (entry.needs !== undefined) {
      assert.ok(
        MARKED_WORKFLOWS[file]?.stepGated.includes(name),
        `${context} depends on another job, so it must be a step-gated job`
      )
      assert.equal(entry.if, '${{ !cancelled() }}', `${context} must run when its dependency fails`)
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
  for (const file of [
    '.github/workflows/release.yml',
    '.github/workflows/build-regtest-images.yml',
  ]) {
    assert.ok(trackedWorkflows().includes(file), `${file} must still exist and run in full`)
  }
})

// The step's script goes in on stdin, the way the runner's bash -e reads a file.
function runGate(temp, index, { result, skip, url = '' }) {
  const outputFile = join(temp, `output-${index}`)
  const summaryFile = join(temp, `summary-${index}`)
  const run = spawnSync('bash', ['-e', '-s'], {
    input: GATE_RUN,
    env: {
      PATH: process.env.PATH,
      MARKER_JOB_RESULT: result,
      MARKER_SKIP: skip,
      MARKER_RUN_URL: url,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  return {
    skip: outputs(outputFile).skip,
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
  for (const [index, [result, skip, expected]] of rows.entries()) {
    const gate = runGate(temp, index, { result, skip, url })
    assert.equal(gate.skip, expected, `${result}/${skip}`)
    assert.equal(gate.summary.includes(url), expected === 'true', `${result}/${skip}`)
  }
  // The URL is data, not shell: a hostile value cannot run a command.
  const hostile = runGate(temp, 'hostile', {
    result: 'success',
    skip: 'true',
    url: '$(touch pwned) `touch pwned` ; touch pwned',
  })
  assert.equal(hostile.skip, 'true')
  assert.ok(!existsSync(join(process.cwd(), 'pwned')))
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
  const tokens = text.match(
    /&&|\|\||==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*(?:\(\))?/g
  )
  assert.equal(tokens.join(''), text.replace(/\s+/g, ''), `cannot evaluate ${expression}`)
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
      value = Boolean(value) && Boolean(right)
    }
    return value
  }
  function or() {
    let value = and()
    while (peek() === '||') {
      take()
      const right = and()
      value = Boolean(value) || Boolean(right)
    }
    return value
  }
  const result = or()
  assert.equal(position, tokens.length, `trailing tokens in ${expression}`)
  return Boolean(result)
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

// One run of a marked workflow, as far as the conditions decide it. The
// tree-pass job's result and outputs are given when it runs; every other job
// succeeds when it runs. Returns, per job, whether it ran and which steps did.
function simulate(
  t,
  file,
  { event, treePass, record = { ok: 'true' }, upload = 'success', runCancelled = false }
) {
  const temp = scratch(t, 'tree-pass-simulate-')
  const { jobs } = readWorkflow(file)
  const expected = MARKED_WORKFLOWS[file]
  const github = { event_name: event }
  const outcome = {}

  const lookupRuns = evaluateIf(jobs[DECIDE_JOB].if, {
    github,
    status: jobStatus({}, runCancelled),
  })
  const marker = lookupRuns ? treePass : { result: 'skipped', outputs: {} }
  outcome[DECIDE_JOB] = { ran: lookupRuns, ...marker }

  const needs = { [DECIDE_JOB]: marker }
  for (const name of [...expected.stepGated, ...expected.jobGated]) {
    const job = jobs[name]
    const ran = evaluateIf(job.if, { github, needs, status: jobStatus(needs, runCancelled) })
    if (!ran) {
      outcome[name] = { ran: false, result: 'skipped', steps: [] }
      needs[name] = { result: 'skipped', outputs: {} }
      continue
    }
    const steps = {}
    const ranSteps = []
    for (const [index, step] of job.steps.entries()) {
      if (step.id === 'gate') {
        const gate = runGate(temp, `${name}-${index}`, {
          result: marker.result,
          skip: marker.outputs.skip ?? '',
          url: marker.outputs['run-url'] ?? '',
        })
        steps.gate = { outputs: { skip: gate.skip ?? '' } }
        ranSteps.push(step.name)
        continue
      }
      const status = { success: true, failure: false, cancelled: runCancelled, always: true }
      if (evaluateIf(step.if, { github, steps, status })) ranSteps.push(step.name)
    }
    const tested = ranSteps.includes(job.steps.at(-1).name)
    outcome[name] = { ran: true, result: 'success', steps: ranSteps, total: job.steps.length }
    needs[name] = { result: 'success', outputs: tested ? { tested: 'true' } : {} }
  }

  const save = jobs[SAVE_JOB]
  const saveRuns = evaluateIf(save.if, { github, needs, status: jobStatus(needs, runCancelled) })
  const saveSteps = []
  if (saveRuns) {
    const steps = { record: { outputs: record }, upload: { outcome: upload } }
    for (const step of save.steps) {
      const status = { success: true, failure: false, cancelled: false, always: true }
      if (evaluateIf(step.if, { github, steps, status })) saveSteps.push(step.uses ?? step.run)
    }
  }
  outcome[SAVE_JOB] = { ran: saveRuns, steps: saveSteps, needs }
  return outcome
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
      assert.equal(run[SAVE_JOB].ran, false, `${where}: nothing is saved`)
      // Even if the save job ran, record refuses a skipped tree-pass.
      assert.notDeepEqual(recordErrors({ needs: run[SAVE_JOB].needs }), [], where)
    }
  }
})

test('the conditions run everything unless a successful marker job said skip, and save only a full pass', t => {
  const fullRun = {
    result: 'success',
    outputs: { prefix: PREFIX, skip: 'false', save: 'true', 'run-url': '' },
  }
  const skipRun = {
    result: 'success',
    outputs: {
      prefix: PREFIX,
      skip: 'true',
      save: 'false',
      'run-url': 'https://github.com/Qbit-Org/qbit-wallet/actions/runs/1001/attempts/1',
    },
  }
  for (const [file, expected] of Object.entries(MARKED_WORKFLOWS)) {
    const covered = [...expected.stepGated, ...expected.jobGated]

    // A full pull request run saves, through the artifact and then the cache.
    const full = simulate(t, file, { event: 'pull_request', treePass: fullRun })
    for (const name of covered)
      assert.equal(full[name].steps.length, full[name].total, `${file} ${name}`)
    assert.equal(full[SAVE_JOB].ran, true, file)
    assert.equal(full[SAVE_JOB].steps.length, 4, file)
    assert.deepEqual(recordErrors({ needs: full[SAVE_JOB].needs }), [], file)

    // record declined, or the artifact upload failed: no cache entry.
    const declined = simulate(t, file, {
      event: 'pull_request',
      treePass: fullRun,
      record: { ok: 'false' },
    })
    assert.equal(declined[SAVE_JOB].steps.length, 2, file)
    const noArtifact = simulate(t, file, {
      event: 'pull_request',
      treePass: fullRun,
      upload: 'failure',
    })
    assert.equal(noArtifact[SAVE_JOB].steps.length, 3, file)
    assert.ok(!noArtifact[SAVE_JOB].steps.some(step => /^actions\/cache\/save@/.test(step)), file)

    // A skip: required jobs run only their gate, other covered jobs are
    // skipped whole, and nothing is saved.
    const skip = simulate(t, file, { event: 'pull_request', treePass: skipRun })
    for (const name of expected.stepGated) {
      assert.equal(skip[name].ran, true, `${file} ${name} reports a result`)
      assert.deepEqual(skip[name].steps, ['Check for a tree pass marker'], `${file} ${name}`)
    }
    for (const name of expected.jobGated) assert.equal(skip[name].ran, false, `${file} ${name}`)
    assert.equal(skip[SAVE_JOB].ran, false, file)

    // A failed or cancelled marker job runs everything and saves nothing.
    for (const result of ['failure', 'cancelled']) {
      const broken = simulate(t, file, {
        event: 'pull_request',
        treePass: { result, outputs: { ...skipRun.outputs, save: 'true' } },
      })
      for (const name of covered) {
        assert.equal(
          broken[name].steps.length,
          broken[name].total,
          `${file} ${name} after ${result}`
        )
      }
      assert.equal(broken[SAVE_JOB].ran, false, `${file} after ${result}`)
    }

    // A cancelled run: no covered job starts.
    const cancelled = simulate(t, file, {
      event: 'pull_request',
      treePass: fullRun,
      runCancelled: true,
    })
    for (const name of covered) assert.equal(cancelled[name].ran, false, `${file} ${name}`)
    assert.equal(cancelled[SAVE_JOB].ran, false, file)
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
})
