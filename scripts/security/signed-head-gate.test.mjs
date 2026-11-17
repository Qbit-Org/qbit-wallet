import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  NOT_VALIDLY_SIGNED,
  SIGNED_HEAD_BUDGET_MS,
  SignedHeadConfigError,
  decideSignedHead,
  howToRun,
  main,
  runSignedHeadGate,
  verificationVerdict,
} from './signed-head-gate.mjs'
import { API_TIMEOUT_MS } from './tree-pass-marker.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(repoRoot, 'scripts/security/signed-head-gate.mjs')
const FORCE_LABEL = 'ci:full-run'
const HEAD = 'd'.repeat(40)
const OTHER = 'e'.repeat(40)
const API = 'https://api.github.com'
const PULL_URL = `${API}/repos/Qbit-Org/qbit-wallet/pulls/42`
const COMMIT_URL = `${API}/repos/Qbit-Org/qbit-wallet/commits/${HEAD}`
const HOW_TO = `To run G3, sign the head commit and push it, or add the ${FORCE_LABEL} label and re-run all jobs.`

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
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

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => (typeof body === 'function' ? body() : body),
  }
}

// GitHub's answer for a commit, with `verification` replaced by `overrides`.
function commitBody(verification = { verified: false, reason: 'unsigned' }, sha = HEAD) {
  return { sha, commit: { message: 'm', verification } }
}

// A fake GitHub that answers the label read and the commit read, and records
// each URL it was asked for. `commit` is the commit read's response, or a
// function that makes it from the request.
function fakeGitHub({ labels = [], commit = fakeResponse(200, commitBody()) } = {}) {
  const asked = []
  const fetchImpl = async (url, options) => {
    asked.push(url)
    assert.equal(options.headers.Authorization, 'Bearer token')
    assert.ok(options.signal instanceof AbortSignal)
    if (url === PULL_URL) {
      if (typeof labels === 'function') return labels(url, options)
      return fakeResponse(200, { labels: labels.map(name => ({ name })) })
    }
    if (url === COMMIT_URL) return typeof commit === 'function' ? commit(url, options) : commit
    return assert.fail(`unexpected request ${url}`)
  }
  return { fetchImpl, asked }
}

function stepEnvironment(temp, extra = {}) {
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_API_URL: API,
    GITHUB_REPOSITORY: 'Qbit-Org/qbit-wallet',
    GH_TOKEN: 'token',
    TREE_PASS_PR_NUMBER: '42',
    TREE_PASS_FORCE_LABEL: FORCE_LABEL,
    TREE_PASS_HEAD_SHA: HEAD,
    TREE_PASS_MARKER_SKIP: 'false',
    TREE_PASS_DOCS_ONLY: 'false',
    GITHUB_OUTPUT: join(temp, 'output'),
    GITHUB_STEP_SUMMARY: join(temp, 'summary'),
    ...extra,
  }
}

const quiet = { log() {} }

// --- GitHub's answer ---------------------------------------------------------

// GitHub's REST documentation of `verification.reason`: the reasons that say
// for certain that a commit is not validly signed.
const DEFINITE_REASONS = [
  'unsigned',
  'unknown_key',
  'no_user',
  'unverified_email',
  'bad_email',
  'expired_key',
  'not_signing_key',
  'malformed_signature',
  'invalid',
  'unknown_signature_type',
]

test('only a well-formed answer for the head that says unverified, for a definite reason, waits', () => {
  assert.deepEqual([...NOT_VALIDLY_SIGNED].sort(), [...DEFINITE_REASONS].sort())
  for (const reason of DEFINITE_REASONS) {
    const verdict = verificationVerdict(commitBody({ verified: false, reason }), HEAD)
    assert.equal(verdict.wait, true, reason)
    assert.equal(
      verdict.reason,
      `GitHub has not verified the signature of the head commit ${HEAD} (${reason})`
    )
  }

  // Verified: a full run.
  const verified = verificationVerdict(
    commitBody({ verified: true, reason: 'valid', signature: 's' }),
    HEAD
  )
  assert.deepEqual(verified, {
    wait: false,
    reason: `GitHub verified the signature of the head commit ${HEAD}`,
  })

  // Every other reason is a doubt, a full run: GitHub could not check (GPG,
  // or S/MIME's OCSP), a valid signature it did not verify, a reason it may
  // add later, and a listed reason spelled another way.
  for (const reason of [
    'gpgverify_error',
    'gpgverify_unavailable',
    'ocsp_pending',
    'ocsp_error',
    'valid',
    'pending',
    'some_future_reason',
    'UNSIGNED',
    ' unsigned',
    'unsigned ',
  ]) {
    const verdict = verificationVerdict(commitBody({ verified: false, reason }), HEAD)
    assert.equal(verdict.wait, false, reason)
    assert.equal(
      verdict.reason,
      `GitHub's reason ${JSON.stringify(reason)} does not say for certain that ${HEAD} is not validly signed`,
      reason
    )
  }

  // Unknown or malformed: a full run.
  const fullRuns = [
    ['null', null, /not an object/],
    ['an array', [commitBody()], /not an object/],
    ['a string', 'unsigned', /not an object/],
    ['a number', 7, /not an object/],
    ['no sha', { commit: commitBody().commit }, /answered for commit null, not d{40}/],
    ['another sha', commitBody(undefined, OTHER), /answered for commit "e{40}"/],
    ['an upper-case sha', commitBody(undefined, HEAD.toUpperCase()), /answered for commit "D{40}"/],
    ['an abbreviated sha', commitBody(undefined, HEAD.slice(0, 7)), /answered for commit "d{7}"/],
    ['no commit', { sha: HEAD }, /no verification object/],
    ['a commit that is a string', { sha: HEAD, commit: 'x' }, /no verification object/],
    ['a commit that is a list', { sha: HEAD, commit: [] }, /no verification object/],
    ['no verification', { sha: HEAD, commit: {} }, /no verification object/],
    ['a null verification', commitBody(null), /no verification object/],
    ['a list verification', commitBody([]), /no verification object/],
    ['a string verification', commitBody('unsigned'), /no verification object/],
    ['no verified flag', commitBody({ reason: 'unsigned' }), /verified flag .* is null/],
    ['a null verified flag', commitBody({ verified: null, reason: 'unsigned' }), /is null/],
    ['a string verified flag', commitBody({ verified: 'false', reason: 'unsigned' }), /"false"/],
    ['a zero verified flag', commitBody({ verified: 0, reason: 'unsigned' }), /is 0, not/],
    ['an empty verified flag', commitBody({ verified: '', reason: 'unsigned' }), /is "", not/],
    ['a one verified flag', commitBody({ verified: 1, reason: 'unsigned' }), /is 1, not/],
    ['no reason', commitBody({ verified: false }), /gave no reason/],
    ['a null reason', commitBody({ verified: false, reason: null }), /gave no reason/],
    ['an empty reason', commitBody({ verified: false, reason: '' }), /gave no reason/],
    ['a numeric reason', commitBody({ verified: false, reason: 3 }), /gave no reason/],
    ['a list reason', commitBody({ verified: false, reason: ['unsigned'] }), /gave no reason/],
  ]
  for (const [label, body, reason] of fullRuns) {
    const verdict = verificationVerdict(body, HEAD)
    assert.equal(verdict.wait, false, label)
    assert.match(verdict.reason, reason, label)
  }
})

// --- The step ------------------------------------------------------------------

async function runStep(t, extra, github, options = {}) {
  const temp = scratch(t, 'signed-head-step-')
  const env = stepEnvironment(temp, extra)
  const lines = []
  const verdict = await runSignedHeadGate(env, {
    fetchImpl: github.fetchImpl,
    log: { log: line => lines.push(line) },
    ...options,
  })
  return {
    verdict,
    output: existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, 'utf8') : null,
    summary: existsSync(env.GITHUB_STEP_SUMMARY)
      ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
      : '',
    lines,
    asked: github.asked,
  }
}

function assertSummaryLines(summary, label) {
  // Every line is a heading, a list entry or blank: the reason is on one line.
  for (const line of summary.split('\n')) {
    assert.match(line, /^(?:### .+|- .+|)$/, `${label}: ${JSON.stringify(line)}`)
  }
}

test('an unsigned head with no label, no marker hit and no docs-only change waits', async t => {
  const result = await runStep(t, {}, fakeGitHub())
  assert.equal(result.output, 'wait=true\n')
  assert.equal(result.verdict.wait, true)
  assert.deepEqual(result.asked, [PULL_URL, COMMIT_URL])
  assert.equal(
    result.summary,
    [
      '### Signed head',
      '',
      `- Waits for a signed head: yes, no G3 shard starts (GitHub has not verified the signature of the head commit ${HEAD} (unsigned))`,
      `- ${HOW_TO}`,
      '',
    ].join('\n')
  )
  assert.equal(howToRun(FORCE_LABEL), HOW_TO)
  // A label is text: the replacement patterns $&, $` and $' stay as they are.
  for (const odd of ["ci:$'", 'ci:$&', 'ci:$`', 'ci:$$', 'ci:$1']) {
    assert.equal(
      howToRun(odd),
      `To run G3, sign the head commit and push it, or add the ${odd} label and re-run all jobs.`,
      odd
    )
  }
  const odd = await runStep(t, { TREE_PASS_FORCE_LABEL: "ci:$'" }, fakeGitHub())
  assert.equal(odd.output, 'wait=true\n')
  assert.ok(odd.summary.includes("or add the ci:$' label and re-run all jobs."), odd.summary)
  assert.deepEqual(result.lines, [
    `::notice title=Signed head::G3 waits for a signed head, so no shard starts: GitHub has not verified the signature of the head commit ${HEAD} (unsigned)`,
  ])
  assertSummaryLines(result.summary, 'unsigned')

  // A fork's pull request is judged the same way: its head commit is read
  // from this repository by its SHA, with this run's token. The settings that
  // name the fork play no part.
  const fork = await runStep(
    t,
    {
      TREE_PASS_HEAD_REPOSITORY_ID: '999',
      GITHUB_HEAD_REF: 'patch-1',
    },
    fakeGitHub()
  )
  assert.equal(fork.output, 'wait=true\n')
  assert.deepEqual(fork.asked, [PULL_URL, COMMIT_URL])
})

test('the label, a marker hit, a docs-only change and other events never wait or read the commit', async t => {
  const unsigned = { commit: () => assert.fail('the commit must not be read') }
  const silent = { fetchImpl: url => assert.fail(`no request, but ${url}`), asked: [] }
  // [label, settings, GitHub, reason, the requests made]. A marker hit and a
  // docs-only change send no request at all, the label read included.
  for (const [label, extra, github, reason, asked] of [
    [
      'the label',
      {},
      fakeGitHub({ ...unsigned, labels: ['bug', 'CI:Full-Run'] }),
      'the ci:full-run label forces a full run',
      [PULL_URL],
    ],
    [
      'another force label',
      { TREE_PASS_FORCE_LABEL: 'run everything' },
      fakeGitHub({ ...unsigned, labels: ['run everything'] }),
      'the run everything label forces a full run',
      [PULL_URL],
    ],
    [
      'a marker hit',
      { TREE_PASS_MARKER_SKIP: 'true' },
      silent,
      'a tree pass marker already vouches for this tree',
      [],
    ],
    [
      'a docs-only change',
      { TREE_PASS_DOCS_ONLY: 'true' },
      silent,
      'the pull request changes only documentation that no skipped step reads',
      [],
    ],
    [
      'a marker hit on a docs-only change',
      { TREE_PASS_MARKER_SKIP: 'true', TREE_PASS_DOCS_ONLY: 'true' },
      silent,
      'a tree pass marker already vouches for this tree',
      [],
    ],
  ]) {
    const result = await runStep(t, extra, github)
    assert.equal(result.output, 'wait=false\n', label)
    assert.equal(result.verdict.reason, reason, label)
    assert.deepEqual(result.asked, asked, label)
    assert.equal(
      result.summary,
      `### Signed head\n\n- Waits for a signed head: no (${reason})\n`,
      label
    )
    assert.deepEqual(
      result.lines,
      [`::notice title=Signed head::G3 does not wait for a signed head: ${reason}`],
      label
    )
  }

  // Any other event asks GitHub nothing and checks no pull request setting.
  for (const event of ['push', 'workflow_dispatch', 'merge_group', '']) {
    const result = await runStep(
      t,
      {
        GITHUB_EVENT_NAME: event,
        TREE_PASS_HEAD_SHA: '',
        TREE_PASS_MARKER_SKIP: undefined,
        TREE_PASS_DOCS_ONLY: undefined,
        GH_TOKEN: undefined,
      },
      { fetchImpl: () => assert.fail('no request'), asked: [] }
    )
    assert.equal(result.output, 'wait=false\n', event)
    assert.equal(result.verdict.reason, `${event || 'an unknown'} event always runs in full`, event)
  }
})

test('every doubt about the labels or the commit runs in full, and the step stays green', async t => {
  const labelFailures = [
    [
      'labels HTTP 502',
      async () => fakeResponse(502, {}),
      /labels could not be read \(GET .* returned HTTP 502\)/,
    ],
    [
      'unreadable labels',
      async () => fakeResponse(200, { labels: [{ name: '' }] }),
      /labels could not be read \(pull request 42 has no readable labels list\)/,
    ],
    [
      'labels not JSON',
      async () =>
        fakeResponse(200, () => {
          throw new SyntaxError('Unexpected token <')
        }),
      /labels could not be read \(Unexpected token </,
    ],
    [
      'labels network failure',
      async () => {
        throw new TypeError('fetch failed')
      },
      /labels could not be read \(fetch failed\)/,
    ],
  ]
  for (const [label, labels, reason] of labelFailures) {
    const result = await runStep(
      t,
      {},
      fakeGitHub({ labels, commit: () => assert.fail('no commit read') })
    )
    assert.equal(result.output, 'wait=false\n', label)
    assert.match(result.verdict.reason, reason, label)
    assert.deepEqual(result.asked, [PULL_URL], label)
  }

  const commitFailures = [
    [
      'HTTP 404',
      fakeResponse(404, { message: 'Not Found' }),
      /could not be read \(GET .*\/commits\/d{40} returned HTTP 404\)/,
    ],
    ['HTTP 422', fakeResponse(422, { message: 'No commit found' }), /returned HTTP 422/],
    ['HTTP 500', fakeResponse(500, {}), /returned HTTP 500/],
    // A success that is not 200: GitHub answers this read with 200 only.
    ['HTTP 203', fakeResponse(203, commitBody()), /returned HTTP 203, not 200/],
    ['HTTP 204', fakeResponse(204, commitBody()), /returned HTTP 204, not 200/],
    [
      'not JSON',
      fakeResponse(200, () => {
        throw new SyntaxError('Unexpected token <')
      }),
      /could not be read \(Unexpected token </,
    ],
    ['null', fakeResponse(200, null), /not an object/],
    ['a list', fakeResponse(200, []), /not an object/],
    [
      'verified',
      fakeResponse(200, commitBody({ verified: true, reason: 'valid' })),
      /GitHub verified/,
    ],
    ...['gpgverify_error', 'gpgverify_unavailable', 'ocsp_pending', 'some_future_reason'].map(
      reason => [
        reason,
        fakeResponse(200, commitBody({ verified: false, reason })),
        /does not say for certain that d{40} is not validly signed/,
      ]
    ),
    ['no verification', fakeResponse(200, { sha: HEAD, commit: {} }), /no verification object/],
    [
      'a string verified flag',
      fakeResponse(200, commitBody({ verified: 'false', reason: 'unsigned' })),
      /not a boolean/,
    ],
    ['no reason', fakeResponse(200, commitBody({ verified: false })), /gave no reason/],
    [
      'another commit',
      fakeResponse(200, commitBody(undefined, OTHER)),
      /answered for commit "e{40}"/,
    ],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed')
      },
      /could not be read \(fetch failed\)/,
    ],
    [
      'a response without headers',
      { ok: true, status: 200, json: async () => commitBody() },
      /no readable headers/,
    ],
  ]
  // An answer whose fields cannot even be read ends in the step's own catch.
  commitFailures.push([
    'unreadable fields',
    fakeResponse(200, {
      get sha() {
        throw new Error('unreadable sha')
      },
    }),
    /^the decision could not be made \(unreadable sha\)$/,
  ])
  for (const [label, commit, reason] of commitFailures) {
    const result = await runStep(t, {}, fakeGitHub({ commit }))
    assert.equal(result.output, 'wait=false\n', label)
    assert.equal(result.verdict.wait, false, label)
    assert.match(result.verdict.reason, reason, label)
    assert.deepEqual(result.asked, [PULL_URL, COMMIT_URL], label)
    assertSummaryLines(result.summary, label)
    assert.doesNotMatch(result.summary, /To run G3/, label)
  }
})

// The milliseconds a timed-out read was allowed, from its reason.
function allowedMs(reason) {
  const match = /timed out after (\d+) ms\)$/.exec(reason)
  assert.ok(match, reason)
  return Number(match[1])
}

// A fetch that holds the event loop for `ms`, so no timer, its own timeout's
// included, can fire before it answers, then answers with no labels.
const busyLabels = ms => async () => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Busy: no timer runs meanwhile.
  }
  return fakeResponse(200, { labels: [] })
}

// Real timers, so only bounds: how long a read was allowed depends on the
// clock's ticks, and no assertion here names an exact count.
test('one deadline covers both reads, each keeps its own cap, and a read that never answers runs in full', async t => {
  // A request that waits on its signal, and one that ignores it.
  const hang = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const deaf = () => new Promise(() => {})
  for (const [label, never] of [
    ['hang', hang],
    ['deaf', deaf],
  ]) {
    // The commit read never answers: it gets what is left of the budget.
    let started = Date.now()
    let result = await runStep(t, {}, fakeGitHub({ commit: never }), { budgetMs: 50 })
    assert.equal(result.output, 'wait=false\n', label)
    assert.match(
      result.verdict.reason,
      /^the head commit could not be read \(GET \/repos\/Qbit-Org\/qbit-wallet\/commits\/d{40} timed out after \d+ ms\)$/,
      label
    )
    assert.ok(allowedMs(result.verdict.reason) <= 50, label)
    assert.ok(Date.now() - started < 5_000, label)

    // The label read never answers: it gets at most the budget, and the
    // commit is never read.
    started = Date.now()
    result = await runStep(
      t,
      {},
      fakeGitHub({ labels: never, commit: () => assert.fail('no commit read') }),
      { budgetMs: 50 }
    )
    assert.equal(result.output, 'wait=false\n', label)
    assert.match(result.verdict.reason, /^the pull request labels could not be read \(GET /, label)
    assert.ok(allowedMs(result.verdict.reason) <= 50, label)
    assert.ok(Date.now() - started < 5_000, label)

    // Each read keeps its own cap when the budget is larger: neither may take
    // the whole budget, so a slow label read cannot leave the commit unread.
    for (const [which, github] of [
      ['label', fakeGitHub({ labels: never, commit: () => assert.fail('no commit read') })],
      ['commit', fakeGitHub({ commit: never })],
    ]) {
      started = Date.now()
      result = await runStep(t, {}, github, { budgetMs: 5_000, requestTimeoutMs: 40 })
      assert.equal(result.output, 'wait=false\n', `${label} ${which}`)
      assert.ok(
        allowedMs(result.verdict.reason) <= 40,
        `${label} ${which}: ${result.verdict.reason}`
      )
      assert.ok(Date.now() - started < 2_500, `${label} ${which}`)
    }
  }

  // The commit read gets only what the label read left of the one deadline.
  const result = await runStep(t, {}, fakeGitHub({ labels: busyLabels(60), commit: hang }), {
    budgetMs: 200,
  })
  assert.equal(result.output, 'wait=false\n')
  assert.ok(allowedMs(result.verdict.reason) <= 140, result.verdict.reason)

  // A label read that took the whole budget leaves the commit read unsent.
  const late = await runStep(
    t,
    {},
    fakeGitHub({ labels: busyLabels(30), commit: () => assert.fail('not sent') }),
    { budgetMs: 20 }
  )
  assert.equal(late.output, 'wait=false\n')
  assert.match(late.verdict.reason, /was not sent: the time for the decision ran out/)
})

// The defaults the command line uses, on a mocked clock, so the test takes no
// real time and the counts are exact: 30 s for the whole decision, and the
// marker script's 15 s for each request.
// A wrong default leaves a request waiting on the mocked clock: the timeout
// turns that into a failure instead of a hang.
test(
  'the command line allows 30 s for the decision and 15 s for each request',
  { timeout: 10_000 },
  async t => {
    assert.equal(SIGNED_HEAD_BUDGET_MS, 30_000)
    assert.equal(API_TIMEOUT_MS, 15_000)
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    const deaf = () => new Promise(() => {})
    const settled = () => new Promise(done => setImmediate(done))
    // Starts the decision, lets its requests go out, moves the clock by `ms`,
    // and returns the verdict.
    const after = async (ms, start) => {
      const pending = start()
      await settled()
      await settled()
      t.mock.timers.tick(ms)
      return pending
    }
    let index = 0
    const env = () => stepEnvironment(scratch(t, `signed-head-defaults-${(index += 1)}-`))

    // Each request stops at its 15 s cap.
    let verdict = await after(15_000, () =>
      decideSignedHead(env(), {
        fetchImpl: fakeGitHub({ labels: deaf, commit: () => assert.fail('no commit read') })
          .fetchImpl,
      })
    )
    assert.equal(
      verdict.reason,
      'the pull request labels could not be read (GET /repos/Qbit-Org/qbit-wallet/pulls/42 timed out after 15000 ms)'
    )
    verdict = await after(15_000, () =>
      decideSignedHead(env(), { fetchImpl: fakeGitHub({ commit: deaf }).fetchImpl })
    )
    assert.equal(
      verdict.reason,
      `the head commit could not be read (GET /repos/Qbit-Org/qbit-wallet/commits/${HEAD} timed out after 15000 ms)`
    )

    // Without the cap, the budget shows: each entry point, the command line's
    // included, leaves it at 30 s.
    const uncapped = () => ({
      fetchImpl: fakeGitHub({ labels: deaf, commit: () => assert.fail('no commit read') })
        .fetchImpl,
      requestTimeoutMs: Number.POSITIVE_INFINITY,
      log: quiet,
    })
    for (const [label, start] of [
      ['decideSignedHead', () => decideSignedHead(env(), uncapped())],
      ['runSignedHeadGate', () => runSignedHeadGate(env(), uncapped())],
      ['main', () => main([], env(), uncapped())],
    ]) {
      verdict = await after(30_000, start)
      assert.equal(
        verdict.reason,
        'the pull request labels could not be read (GET /repos/Qbit-Org/qbit-wallet/pulls/42 timed out after 30000 ms)',
        label
      )
    }
  }
)

test('wiring errors fail the step before any request, and write no output', async t => {
  for (const extra of [
    { GITHUB_OUTPUT: '' },
    { GITHUB_OUTPUT: undefined },
    { TREE_PASS_FORCE_LABEL: '' },
    { TREE_PASS_FORCE_LABEL: undefined },
    { TREE_PASS_FORCE_LABEL: 'a,b' },
    { TREE_PASS_HEAD_SHA: undefined },
    { TREE_PASS_HEAD_SHA: '' },
    { TREE_PASS_HEAD_SHA: HEAD.slice(0, 7) },
    { TREE_PASS_HEAD_SHA: HEAD.toUpperCase() },
    { TREE_PASS_HEAD_SHA: `${HEAD}\n` },
    { TREE_PASS_HEAD_SHA: 'g'.repeat(40) },
    { TREE_PASS_MARKER_SKIP: undefined },
    { TREE_PASS_MARKER_SKIP: '' },
    { TREE_PASS_MARKER_SKIP: 'TRUE' },
    { TREE_PASS_MARKER_SKIP: 'yes' },
    { TREE_PASS_DOCS_ONLY: undefined },
    { TREE_PASS_DOCS_ONLY: '' },
    { TREE_PASS_DOCS_ONLY: 'True' },
    { TREE_PASS_DOCS_ONLY: '1' },
    { GH_TOKEN: '' },
    { GH_TOKEN: undefined },
    { TREE_PASS_PR_NUMBER: '0' },
    { TREE_PASS_PR_NUMBER: undefined },
    { TREE_PASS_PR_NUMBER: '../1' },
    { GITHUB_REPOSITORY: '' },
    { GITHUB_REPOSITORY: 'no-slash' },
    { GITHUB_API_URL: 'http://api.github.com' },
    { GITHUB_API_URL: undefined },
  ]) {
    const temp = scratch(t, 'signed-head-config-')
    const env = stepEnvironment(temp, extra)
    await assert.rejects(
      runSignedHeadGate(env, {
        fetchImpl: () => assert.fail(`no request for ${JSON.stringify(extra)}`),
        log: quiet,
      }),
      SignedHeadConfigError,
      JSON.stringify(extra)
    )
    assert.equal(existsSync(join(temp, 'output')), false, JSON.stringify(extra))
  }
  // The decision alone reports the same errors.
  await assert.rejects(
    decideSignedHead({ GITHUB_EVENT_NAME: 'pull_request' }, { fetchImpl: () => assert.fail() }),
    SignedHeadConfigError
  )
})

// --- In a process of its own ---------------------------------------------

// The step in a process of its own, as a workflow step runs it, so no other
// test's timers keep its event loop alive. The label read answers; the
// commit read never does.
const CHILD = `
const { runSignedHeadGate } = await import(process.argv[1])
const mode = process.env.SIGNED_HEAD_TEST_FETCH
const labels = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ labels: [] }) }
const fetchImpl = (url, { signal }) => {
  if (url.endsWith('/pulls/42')) return Promise.resolve(labels)
  if (mode === 'hang') {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }
  return new Promise(() => {})
}
await runSignedHeadGate(process.env, { fetchImpl, budgetMs: 300 })
`

test('a commit read that never answers ends in a full run, in a process of its own', t => {
  for (const mode of ['hang', 'deaf']) {
    const temp = scratch(t, 'signed-head-child-')
    const started = Date.now()
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, pathToFileURL(script).href],
      {
        env: { PATH: process.env.PATH, ...stepEnvironment(temp), SIGNED_HEAD_TEST_FETCH: mode },
        encoding: 'utf8',
        timeout: 60_000,
      }
    )
    // Nothing but the request's own timer keeps the event loop alive: it
    // must, or Node ends the step with exit 13 and no answer.
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    assert.deepEqual(outputs(join(temp, 'output')), { wait: 'false' }, mode)
    assert.match(
      result.stdout,
      /^::notice title=Signed head::G3 does not wait for a signed head: the head commit could not be read \(GET \S+ timed out after \d+ ms\)$/m,
      mode
    )
    assert.ok(Date.now() - started < 10_000, `${mode}: ${Date.now() - started} ms`)
  }
})

function cli(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
}

test('the command line writes wait and fails closed', t => {
  const temp = scratch(t, 'signed-head-cli-')
  const env = stepEnvironment(temp)

  // A push asks nothing.
  let result = cli([], { ...env, GITHUB_EVENT_NAME: 'push' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'wait=false\n')

  // An API that cannot be reached runs in full, and the step stays green.
  rmSync(env.GITHUB_OUTPUT)
  result = cli([], { ...env, GITHUB_API_URL: 'https://127.0.0.1:9' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'wait=false\n')
  assert.match(
    result.stdout,
    /^::notice title=Signed head::G3 does not wait for a signed head: the pull request labels could not be read/m
  )
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /- Waits for a signed head: no \(/)

  for (const [args, extra] of [
    [['extra'], {}],
    [[], { GITHUB_OUTPUT: '' }],
    [[], { TREE_PASS_FORCE_LABEL: '' }],
    [[], { TREE_PASS_HEAD_SHA: 'abc' }],
    [[], { TREE_PASS_MARKER_SKIP: '' }],
    [[], { GH_TOKEN: '' }],
  ]) {
    rmSync(env.GITHUB_OUTPUT, { force: true })
    result = cli(args, { ...env, ...extra })
    assert.equal(result.status, 1, JSON.stringify([args, extra]))
    assert.match(result.stdout, /^::error title=Signed head::/m, JSON.stringify([args, extra]))
    assert.equal(existsSync(env.GITHUB_OUTPUT), false, JSON.stringify([args, extra]))
  }
})

// The step runs on the runner image's Node, without setup-node or an install,
// like the marker script it imports.
test('the script loads only Node built-in modules and the marker script', t => {
  const source = readFileSync(script, 'utf8')
  const specifiers = [
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
  ].map(([, specifier]) => specifier)
  assert.ok(specifiers.length >= 4, specifiers.join(', '))
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:[a-z_/]+|\.\/tree-pass-marker\.mjs)$/, specifier)
  }
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|createRequire/)

  // What Node itself resolves: copies in a folder with no node_modules above
  // it, as on the runner, load every module they name.
  const dir = scratch(t, 'signed-head-builtins-')
  for (let up = dir; ; up = dirname(up)) {
    assert.ok(!existsSync(join(up, 'node_modules')), `${up} has node_modules`)
    if (dirname(up) === up) break
  }
  writeFileSync(join(dir, 'signed-head-gate.mjs'), source)
  writeFileSync(
    join(dir, 'tree-pass-marker.mjs'),
    readFileSync(join(repoRoot, 'scripts/security/tree-pass-marker.mjs'), 'utf8')
  )
  const copy = pathToFileURL(join(dir, 'signed-head-gate.mjs')).href
  const loaded = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(copy)})`],
    { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' }
  )
  assert.equal(loaded.status, 0, loaded.stderr)
})
