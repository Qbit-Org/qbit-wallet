import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  API_TIMEOUT_MS,
  TreePassConfigError,
  githubJson,
  readPullRequestLabels,
} from './tree-pass-marker.mjs'

// Decides, for one pull request run of the browser release gate, whether G3
// waits for a signed head. A pull request lands as one signed commit, so a
// G3 run on a head commit that GitHub has not verified as signed tests a
// commit that never lands. While a run waits, the workflow skips the shard
// matrix whole, reports the required job under another name, so the waiting
// run reports no check under the required name, and saves no marker. The
// rules, in order, the first that applies settling it:
//
//   1. Any event but pull_request runs in full.
//   2. The force label (TREE_PASS_FORCE_LABEL) on the pull request runs in
//      full; labels that cannot be read run in full too.
//   3. A tree pass marker hit (the decide step's skip) does not wait.
//   4. A docs-only change (the docs-only step's docs-only), which for G3
//      includes a version bump, does not wait.
//   5. GitHub's answer for the head commit, read from this repository by the
//      pull request's head SHA, a fork's head included: it waits only when
//      that answer is well formed, is for exactly that commit and says the
//      signature is not verified, for a reason that says for certain that
//      the commit is not validly signed (NOT_VALIDLY_SIGNED).
//
// The step looks at the earlier steps' verdicts (3 and 4) first and sends no
// request at all when either holds; only then does it read the labels, and
// then the commit. That changes no outcome: the decide and docs-only steps
// never say true while the label is on, as of their own reads.
//
// Every doubt and every error resolves to "do not wait", a full run: the
// output is `true` only when every check above passed. A wiring error in this
// step throws, as the marker's and the docs-only step's do, which fails the
// marker job and so also runs G3 in full. docs/playwright-release-gate.md
// explains the design.

// GitHub's verification reasons, as its REST documentation of
// `verification.reason` lists them, that say for certain that a commit is not
// validly signed. Only these wait. Every other reason is a doubt and runs in
// full: those that say GitHub could not check (gpgverify_error,
// gpgverify_unavailable, and S/MIME's ocsp_pending and ocsp_error), valid,
// and any reason GitHub adds later.
export const NOT_VALIDLY_SIGNED = new Set([
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
])
// Both requests this step makes share this budget, and each also keeps the
// marker script's own cap (API_TIMEOUT_MS): the label read and the commit read
// together end within it, so the step never waits unbounded.
export const SIGNED_HEAD_BUDGET_MS = 30_000

// SHA-1 or SHA-256 object names, as the pull request event gives them.
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FORCE_LABEL = /^[^\s,][^,\r\n]*$/
// What the decide and docs-only steps write; anything else is a wiring error.
const STEP_VERDICTS = new Set(['true', 'false'])
const HOW_TO_RUN =
  'To run G3, sign the head commit and push it, or add the {label} label and re-run all jobs.'

export class SignedHeadConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SignedHeadConfigError'
  }
}

function hasLabel(labels, wanted) {
  return labels.some(label => label.toLowerCase() === wanted.toLowerCase())
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function howToRun(forceLabel) {
  // A function, so that `$&` and the like in a label stay as they are.
  return HOW_TO_RUN.replace('{label}', () => forceLabel)
}

// The verdict on GitHub's answer to GET /repos/{repo}/commits/{sha}, already
// known to be HTTP 200 with a JSON body. Only an answer for exactly the head
// commit whose verification is an object with `verified` exactly false and a
// reason in NOT_VALIDLY_SIGNED waits.
export function verificationVerdict(body, headSha) {
  if (!isObject(body)) {
    return { wait: false, reason: "GitHub's answer for the head commit is not an object" }
  }
  if (body.sha !== headSha) {
    return {
      wait: false,
      reason: `GitHub answered for commit ${JSON.stringify(body.sha ?? null)}, not ${headSha}`,
    }
  }
  const verification = isObject(body.commit) ? body.commit.verification : undefined
  if (!isObject(verification)) {
    return { wait: false, reason: `GitHub's answer for ${headSha} has no verification object` }
  }
  if (verification.verified === true) {
    return { wait: false, reason: `GitHub verified the signature of the head commit ${headSha}` }
  }
  if (verification.verified !== false) {
    return {
      wait: false,
      reason: `GitHub's verified flag for ${headSha} is ${JSON.stringify(verification.verified ?? null)}, not a boolean`,
    }
  }
  const { reason } = verification
  if (typeof reason !== 'string' || reason === '') {
    return { wait: false, reason: `GitHub gave no reason why ${headSha} is not verified` }
  }
  if (!NOT_VALIDLY_SIGNED.has(reason)) {
    return {
      wait: false,
      reason: `GitHub's reason ${JSON.stringify(reason)} does not say for certain that ${headSha} is not validly signed`,
    }
  }
  return {
    wait: true,
    reason: `GitHub has not verified the signature of the head commit ${headSha} (${reason})`,
  }
}

// The settings this step needs, checked before it asks GitHub anything. The
// label read checks its own (the token, the API URL, the repository and the
// pull request number) when it is made, and reports them as configuration
// errors; a marker hit or a docs-only change makes no request and needs none.
function settingsOf(env) {
  const forceLabel = env.TREE_PASS_FORCE_LABEL
  if (typeof forceLabel !== 'string' || !FORCE_LABEL.test(forceLabel)) {
    throw new SignedHeadConfigError('TREE_PASS_FORCE_LABEL must be a label name')
  }
  const headSha = env.TREE_PASS_HEAD_SHA
  if (typeof headSha !== 'string' || !OBJECT_ID.test(headSha)) {
    throw new SignedHeadConfigError('TREE_PASS_HEAD_SHA must be a full lowercase git object ID')
  }
  for (const name of ['TREE_PASS_MARKER_SKIP', 'TREE_PASS_DOCS_ONLY']) {
    if (!STEP_VERDICTS.has(env[name])) {
      throw new SignedHeadConfigError(`${name} must be true or false, as the earlier step sets it`)
    }
  }
  return { forceLabel, headSha }
}

// The verdict for this run. Every doubt returns `wait: false`; a wiring error
// throws a SignedHeadConfigError. `budgetMs` and `requestTimeoutMs` are for
// tests; the command line uses the defaults.
export async function decideSignedHead(
  env,
  { fetchImpl, budgetMs = SIGNED_HEAD_BUDGET_MS, requestTimeoutMs = API_TIMEOUT_MS } = {}
) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    return {
      wait: false,
      reason: `${env.GITHUB_EVENT_NAME || 'an unknown'} event always runs in full`,
    }
  }
  const { forceLabel, headSha } = settingsOf(env)
  // The earlier steps' verdicts first: either settles it with no request.
  if (env.TREE_PASS_MARKER_SKIP === 'true') {
    return { wait: false, reason: 'a tree pass marker already vouches for this tree' }
  }
  if (env.TREE_PASS_DOCS_ONLY === 'true') {
    return {
      wait: false,
      reason:
        'the pull request changes only documentation that no skipped step reads, or only that and the extension version',
    }
  }
  // One deadline for the whole decision, carried through both requests, each
  // of which also keeps its own cap.
  const deadline = Date.now() + budgetMs
  let labels
  try {
    // Read when the job runs, as the marker does, so a label added later
    // counts when the run is re-run.
    labels = await readPullRequestLabels({
      apiUrl: env.GITHUB_API_URL,
      repository: env.GITHUB_REPOSITORY,
      number: env.TREE_PASS_PR_NUMBER,
      token: env.GH_TOKEN,
      fetchImpl,
      timeoutMs: Math.min(requestTimeoutMs, deadline - Date.now()),
    })
  } catch (error) {
    if (error instanceof TreePassConfigError) throw new SignedHeadConfigError(error.message)
    return {
      wait: false,
      reason: `the pull request labels could not be read (${error.message})`,
    }
  }
  if (hasLabel(labels, forceLabel)) {
    return { wait: false, reason: `the ${forceLabel} label forces a full run` }
  }
  // The pull request's commits are in this repository too, a fork's
  // included, so the read needs only this run's token.
  const path = `/repos/${env.GITHUB_REPOSITORY}/commits/${headSha}`
  const send = fetchImpl ?? globalThis.fetch
  let status
  let body
  try {
    body = await githubJson({
      apiUrl: env.GITHUB_API_URL,
      path,
      token: env.GH_TOKEN,
      fetchImpl: async (url, options) => {
        const response = await send(url, options)
        status = response?.status
        return response
      },
      timeoutMs: requestTimeoutMs,
      deadline,
    })
  } catch (error) {
    if (error instanceof TreePassConfigError) throw new SignedHeadConfigError(error.message)
    return { wait: false, reason: `the head commit could not be read (${error.message})` }
  }
  if (status !== 200) {
    return { wait: false, reason: `GET ${path} returned HTTP ${status}, not 200` }
  }
  return verificationVerdict(body, headSha)
}

function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) throw new SignedHeadConfigError('GITHUB_OUTPUT is missing or empty')
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

// A reason on one line, so the summary's list stays a list.
function oneLine(text) {
  return String(text)
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
}

function summary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

// Workflow-command data must not carry a raw newline.
function annotation(level, text) {
  const data = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  return `::${level} title=Signed head::${data}`
}

// Sets `wait` to `true` or `false`. Any error other than a configuration
// error leaves `false`, so the step stays green and G3 runs in full.
export async function runSignedHeadGate(
  env,
  { fetchImpl, log = console, budgetMs, requestTimeoutMs } = {}
) {
  if (!env.GITHUB_OUTPUT) throw new SignedHeadConfigError('GITHUB_OUTPUT is missing or empty')
  let verdict
  try {
    // Unset options take decideSignedHead's defaults.
    verdict = await decideSignedHead(env, { fetchImpl, budgetMs, requestTimeoutMs })
  } catch (error) {
    if (error instanceof SignedHeadConfigError) throw error
    verdict = { wait: false, reason: `the decision could not be made (${error.message})` }
  }
  const wait = verdict.wait === true
  const reason = oneLine(verdict.reason)
  setOutput(env, 'wait', wait ? 'true' : 'false')
  log.log(
    annotation(
      'notice',
      wait
        ? `G3 waits for a signed head, so no shard starts: ${reason}`
        : `G3 does not wait for a signed head: ${reason}`
    )
  )
  summary(env, [
    '### Signed head',
    '',
    `- Waits for a signed head: ${wait ? 'yes, no G3 shard starts' : 'no'} (${reason})`,
    ...(wait ? [`- ${howToRun(env.TREE_PASS_FORCE_LABEL)}`] : []),
  ])
  return { ...verdict, wait }
}

// The command line passes no options, so the defaults apply; tests pass a
// fake fetch.
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (argv.length > 0) throw new SignedHeadConfigError(`unexpected arguments: ${argv.join(' ')}`)
  return runSignedHeadGate(env, options)
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) {
  try {
    await main()
  } catch (error) {
    console.log(annotation('error', error.message))
    process.exitCode = 1
  }
}
