import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// A pull request's workflow runs again on every new commit, even when the
// commit only re-signs the same tree. This script decides, for one workflow
// run, whether the tree under test already passed the workflow's expensive
// jobs, using a marker kept in the GitHub Actions cache and GitHub's own
// record of the run that saved it. The workflow YAML only wires its three
// modes together; docs/ci-tree-pass-marker.md explains the design. Every doubt
// resolves to "run everything" and "save nothing".
//
//   key     whether this run may use markers, the marker key prefix and the
//           tree of the pull request head
//   decide  reads the cache lookup, checks the run the matched marker names
//           and that it can only be a run of this pull request,
//           and decides whether to skip and whether a full pass may save
//   record  re-checks that every covered job ran and passed and that the
//           force label is still off, then writes the marker file that the
//           save job uploads as an artifact and saves in the cache

export const KEY_PREFIX = 'tree-pass'
export const KEY_FORMAT = 'v1'
// The job that computes the key and looks it up. The save job reads its
// outputs and result from `needs`, so every workflow names it the same.
export const DECIDE_JOB = 'tree-pass'
// The job that records a pass, and the check name `decide` looks for in the
// run a marker names.
export const SAVE_JOB = 'tree-pass-save'
export const SAVE_JOB_NAME = 'Record tree pass'
export const MARKER_FILE = 'marker.json'
// The artifact the save job uploads binds a marker key to the run that saved
// it: only that run's own jobs can add an artifact to it.
export const ARTIFACT_PREFIX = 'tree-pass-'

const WORKFLOW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_WORKFLOW_ID_LENGTH = 40
const SALT = /^(?:0|[1-9][0-9]{0,8})$/
// SHA-1 or SHA-256 object names, as git prints them.
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PULL_REQUEST_NUMBER = /^[1-9][0-9]{0,9}$/
// At most 15 digits, so Number() keeps them exact when compared with the API.
const DATABASE_ID = /^[1-9][0-9]{0,14}$/
const RUN_ATTEMPT = /^[1-9][0-9]{0,4}$/
const HTTPS_URL = /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/
const SERVER_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/
const MARKER_PREFIX =
  /^tree-pass-v1-[a-z0-9]+(?:-[a-z0-9]+)*-salt(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})-(?:[0-9a-f]{40}|[0-9a-f]{64})-pr[1-9][0-9]{0,9}-$/
const RUN_SUFFIX = /^([1-9][0-9]{0,14})-([1-9][0-9]{0,4})$/
const API_TIMEOUT_MS = 15_000
// Every request `decide` makes shares this budget, so a slow API ends the
// decision as "run everything" well inside the job's 10 minutes, after
// checkout, the key and the 3-minute lookup.
const DECIDE_BUDGET_MS = 4 * 60_000
// GitHub's largest page. A listing is complete only when a page holds fewer
// entries and names no next page.
const PAGE_SIZE = 100
// A pull request's timeline and its issue events, 3,000 entries each at most.
const EVENT_PAGES = 30
// A filtered listing of workflow runs stops at 1,000 runs, so ten pages hold
// every run GitHub will list.
const RUN_PAGES = 10
// GitHub's timestamps, exactly: seconds, UTC.
const GITHUB_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
// Timeline events about the base a pull request merges into. GitHub's REST
// reference says the timeline does not return base_ref_changed or
// automatic_base_change_*, though it does, and does not list
// base_ref_force_pushed or base_ref_deleted, so the check goes by prefix, not
// by name. Seen in this organization's pull requests: base_ref_changed (a
// retarget by hand), automatic_base_change_succeeded (a retarget by GitHub
// after the base branch was merged and deleted), base_ref_force_pushed and
// base_ref_deleted. automatic_base_change_failed is a retarget GitHub could
// not make.
const BASE_CHANGE_EVENT = /^(?:base_ref_|automatic_base_change_)/
// Events that mean this pull request's head branch was deleted, and perhaps
// created again, while it existed: a run of another pull request from that
// branch, created after this one, may have the head this one has now. Exact
// names: head_ref_force_pushed is routine and does not count.
const HEAD_BRANCH_EVENTS = new Set(['head_ref_deleted', 'head_ref_restored'])

// The rules that bind the run a marker names to this pull request. Each
// refusal starts with its rule's name, so the step's log says which refused.
export const RULES = {
  onePull: 'one pull request per head branch',
  base: 'base unchanged',
  headBranch: 'head branch kept',
  created: 'run after the pull request',
  later: 'no later failure',
  attempts: 'both attempts',
}

function refusedBy(rule, detail) {
  return `[${rule}] ${detail}`
}

// A failed or incomplete read names the rule it was for.
async function readFor(rule, read) {
  try {
    return await read()
  } catch (error) {
    throw new Error(refusedBy(rule, error.message))
  }
}

// A GitHub timestamp as milliseconds, or null for anything else: another
// format, a date that does not exist, or not a string.
export function githubTime(value) {
  if (typeof value !== 'string' || !GITHUB_TIME.test(value)) return null
  const time = Date.parse(value)
  // Date.parse rolls 30 February over into March; GitHub never writes one.
  return Number.isFinite(time) && new Date(time).toISOString() === `${value.slice(0, -1)}.000Z`
    ? time
    : null
}

export class TreePassConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TreePassConfigError'
  }
}

function requireMatch(name, value, pattern, description) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TreePassConfigError(`${name} is missing or empty`)
  }
  if (!pattern.test(value)) {
    throw new TreePassConfigError(`${name} must be ${description}, found ${JSON.stringify(value)}`)
  }
  return value
}

export function validateWorkflowId(value) {
  requireMatch('TREE_PASS_WORKFLOW', value, WORKFLOW_ID, 'lowercase words joined by hyphens')
  if (value.length > MAX_WORKFLOW_ID_LENGTH) {
    throw new TreePassConfigError(
      `TREE_PASS_WORKFLOW must be at most ${MAX_WORKFLOW_ID_LENGTH} characters`
    )
  }
  return value
}

export function validateSalt(name, value) {
  return requireMatch(name, value, SALT, 'a whole number without leading zeros')
}

// The repository salt is the TREE_PASS_SALT repository variable. Workflows
// read it as `vars.TREE_PASS_SALT`, which is an empty string when the variable
// is not set, so empty means the default 0. Anything else must be a number.
export function repositorySalt(value) {
  if (value === undefined || value === '') return '0'
  return validateSalt('TREE_PASS_REPOSITORY_SALT', value)
}

// The lookup key: the workflow, both salts, the tree under test and the pull
// request, never a commit, because a re-signed commit has a new commit ID and
// the same tree. A marker's full key adds the run ID and attempt that saved it
// (markerKey), so the lookup matches it by prefix and `decide` reads the run to
// check from the matched key alone. The marker is never restored: the cache
// action extracts an entry with `tar -P`, which honours absolute and `../`
// paths, and a cache entry is exactly what the run check distrusts.
export function markerPrefix({
  workflow,
  workflowSalt,
  repositorySalt: repoSalt,
  tree,
  pullRequest,
}) {
  validateWorkflowId(workflow)
  validateSalt('TREE_PASS_WORKFLOW_SALT', workflowSalt)
  validateSalt('TREE_PASS_REPOSITORY_SALT', repoSalt)
  requireMatch('tree', tree, OBJECT_ID, 'a full lowercase git object ID')
  requireMatch('TREE_PASS_PR_NUMBER', pullRequest, PULL_REQUEST_NUMBER, 'a pull request number')
  return `${KEY_PREFIX}-${KEY_FORMAT}-${workflow}-salt${workflowSalt}.${repoSalt}-${tree}-pr${pullRequest}-`
}

export function isMarkerPrefix(value) {
  return typeof value === 'string' && MARKER_PREFIX.test(value)
}

export function markerKey(prefix, runId, runAttempt) {
  if (!isMarkerPrefix(prefix)) {
    throw new TreePassConfigError(`the marker key prefix is malformed: ${JSON.stringify(prefix)}`)
  }
  requireMatch('GITHUB_RUN_ID', runId, DATABASE_ID, 'a run ID')
  requireMatch('GITHUB_RUN_ATTEMPT', runAttempt, RUN_ATTEMPT, 'a run attempt')
  return `${prefix}${runId}-${runAttempt}`
}

// The run ID and attempt a marker key names, or null when the key is not a
// marker for exactly this prefix.
export function parseMarkerKey(key, prefix) {
  if (!isMarkerPrefix(prefix) || typeof key !== 'string' || !key.startsWith(prefix)) return null
  const match = RUN_SUFFIX.exec(key.slice(prefix.length))
  return match ? { runId: match[1], runAttempt: match[2] } : null
}

export function artifactName(key) {
  return `${ARTIFACT_PREFIX}${createHash('sha256').update(key, 'utf8').digest('hex')}`
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

// The tree of the commit the workflow tests. For `pull_request` that commit is
// GITHUB_SHA, GitHub's merge of the head into the base, so a different head
// tree or a moved base gives a different tree.
export function treeOf(sha, { cwd = process.cwd() } = {}) {
  requireMatch('GITHUB_SHA', sha, OBJECT_ID, 'a full lowercase git object ID')
  const tree = git(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`], cwd)
  return requireMatch('tree', tree, OBJECT_ID, 'a full lowercase git object ID')
}

// The tree of the pull request head, which GitHub's record of a run reports
// as head_commit.tree_id. The head must be a parent of the merge under test,
// so the checkout needs a depth of 2.
export function headTreeOf(mergeSha, headSha, { cwd = process.cwd() } = {}) {
  requireMatch('GITHUB_SHA', mergeSha, OBJECT_ID, 'a full lowercase git object ID')
  requireMatch('TREE_PASS_HEAD_SHA', headSha, OBJECT_ID, 'a full lowercase git object ID')
  const parents = git(['rev-list', '--parents', '-n', '1', '--end-of-options', mergeSha], cwd)
    .split(' ')
    .slice(1)
  if (parents.length !== 2 || !parents.includes(headSha)) {
    throw new TreePassConfigError(
      `the commit under test ${mergeSha} is not a merge of the pull request head ${headSha}`
    )
  }
  return treeOf(headSha, { cwd })
}

// `<owner>/<repo>/.github/workflows/<file>@<ref>` to `.github/workflows/<file>`.
export function workflowPathFromRef(workflowRef, repository) {
  requireMatch('GITHUB_REPOSITORY', repository, REPOSITORY, 'owner/name')
  if (typeof workflowRef !== 'string' || !workflowRef.startsWith(`${repository}/`)) {
    throw new TreePassConfigError(
      `GITHUB_WORKFLOW_REF ${JSON.stringify(workflowRef)} is not a workflow of ${repository}`
    )
  }
  const rest = workflowRef.slice(repository.length + 1)
  const at = rest.indexOf('@')
  const path = at > 0 && at < rest.length - 1 ? rest.slice(0, at) : ''
  return requireMatch('the workflow path', path, WORKFLOW_PATH, 'a file in .github/workflows')
}

// Markers are used only for pull requests from this repository, without the
// force label. The repository is compared by its ID, which a rename or a
// transfer does not change. `labels` is null when they could not be read,
// which counts as "maybe forced".
export function eligibility({ eventName, repositoryId, headRepositoryId, labels, forceLabel }) {
  if (eventName !== 'pull_request') {
    return { eligible: false, reason: `${eventName || 'an unknown'} event always runs in full` }
  }
  if (
    typeof repositoryId !== 'string' ||
    !DATABASE_ID.test(repositoryId) ||
    headRepositoryId !== repositoryId
  ) {
    return {
      eligible: false,
      reason: 'a pull request from another repository always runs in full',
    }
  }
  if (!Array.isArray(labels)) {
    return {
      eligible: false,
      reason: 'the pull request labels could not be read, so it runs in full',
    }
  }
  if (hasLabel(labels, forceLabel)) {
    return { eligible: false, reason: `the ${forceLabel} label forces a full run` }
  }
  return { eligible: true, reason: 'a pull request from this repository' }
}

function hasLabel(labels, wanted) {
  return labels.some(label => label.toLowerCase() === wanted.toLowerCase())
}

// One GET from GitHub's REST API: the body and the Link header. Throws on any
// doubt.
async function githubGet({
  apiUrl,
  path,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = API_TIMEOUT_MS,
  deadline,
}) {
  requireMatch('GITHUB_API_URL', apiUrl, HTTPS_URL, 'an https URL')
  if (typeof token !== 'string' || token.length === 0) {
    throw new TreePassConfigError('GH_TOKEN is missing or empty')
  }
  // A shared deadline shortens each request's own timeout, and once it has
  // passed nothing more is asked.
  const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now())
  if (!(remaining > 0))
    throw new Error(`GET ${path} was not sent: the time for the decision ran out`)
  // The timeout is a timer of this request's own, not AbortSignal.timeout(),
  // whose timer does not keep the event loop alive: a request left waiting on
  // nothing else would let the loop drain first, and Node would end the step
  // with exit 13 and no answer. This timer keeps the loop alive until the
  // request settles or the time is up, and the race settles it then even if
  // fetch ignores the signal.
  const controller = new AbortController()
  const timedOut = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    })
  })
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`GET ${path} timed out after ${remaining} ms`, 'TimeoutError')
    )
  }, remaining)
  const request = async () => {
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'tree-pass-marker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`)
    if (typeof response.headers?.get !== 'function') {
      throw new Error(`GET ${path} returned no readable headers`)
    }
    return { body: await response.json(), link: response.headers.get('link') ?? '' }
  }
  try {
    return await Promise.race([request(), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export async function githubJson(request) {
  return (await githubGet(request)).body
}

// Every entry of a paginated listing, page by page. A page that is not a
// list, holds too many entries, or is short but names a next page, a failed
// page, and more than `maxPages` pages all throw: an incomplete listing is
// never read as a complete one. With `field`, each page is an object whose
// `field` holds the entries and whose `total_count` counts them all; that
// count must be the same on every page and match the entries read.
export async function githubList({ path, maxPages, field, ...request }) {
  const entries = []
  let total
  const separator = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= maxPages; page += 1) {
    const pagePath = `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`
    const { body, link } = await githubGet({ ...request, path: pagePath })
    const list = field === undefined ? body : body?.[field]
    if (!Array.isArray(list) || list.length > PAGE_SIZE) {
      throw new Error(`GET ${pagePath} did not return a list of at most ${PAGE_SIZE} entries`)
    }
    if (field !== undefined) {
      if (!Number.isSafeInteger(body.total_count) || (page > 1 && body.total_count !== total)) {
        throw new Error(`GET ${pagePath} returned total_count ${body.total_count}, not ${total}`)
      }
      total = body.total_count
    }
    entries.push(...list)
    if (list.length < PAGE_SIZE) {
      if (/\brel="next"/.test(link)) {
        throw new Error(`GET ${pagePath} returned a short page that names a next page`)
      }
      if (field !== undefined && entries.length !== total) {
        throw new Error(`GET ${path} listed ${entries.length} of ${total} entries`)
      }
      return entries
    }
  }
  throw new Error(`GET ${path} has more than ${maxPages} pages`)
}

// Reads the pull request's current labels, so a label added after the run
// started counts when the run, or one of its jobs, is re-run.
export async function readPullRequestLabels({
  apiUrl,
  repository,
  number,
  token,
  fetchImpl,
  timeoutMs,
}) {
  requireMatch('GITHUB_REPOSITORY', repository, REPOSITORY, 'owner/name')
  requireMatch('TREE_PASS_PR_NUMBER', number, PULL_REQUEST_NUMBER, 'a pull request number')
  const body = await githubJson({
    apiUrl,
    path: `/repos/${repository}/pulls/${number}`,
    token,
    fetchImpl,
    timeoutMs,
  })
  if (
    !body ||
    !Array.isArray(body.labels) ||
    !body.labels.every(label => typeof label?.name === 'string' && label.name.length > 0)
  ) {
    throw new Error(`pull request ${number} has no readable labels list`)
  }
  return body.labels.map(label => label.name)
}

// --- What GitHub must say about the run a marker names ------------------

function mismatch(what, observed, wanted) {
  return `${what} is ${JSON.stringify(observed ?? null)}, not ${JSON.stringify(wanted)}`
}

// GET /repos/{repo}/actions/runs/{id} describes the run's latest attempt, which
// must be the attempt that saved the marker: a later attempt, such as a re-run
// with the force label that failed, invalidates it. The run must be a pull request
// run of this workflow, from this pull request's head branch, whose head commit
// has the tree of the head under test now.
export function runRecordProblem(run, expected) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return `run ${expected.runId}: the run record is not an object`
  }
  const checks = [
    ['ID', run.id, Number(expected.runId)],
    ['repository', run.repository?.full_name, expected.repository],
    ['workflow', run.path, expected.workflowPath],
    ['event', run.event, 'pull_request'],
    ['head repository', run.head_repository?.id, Number(expected.headRepositoryId)],
    ['head branch', run.head_branch, expected.headBranch],
    ['head tree', run.head_commit?.tree_id, expected.headTree],
  ]
  for (const [what, observed, wanted] of checks) {
    // A JSON true or a numeric string must not stand in for a number.
    if (typeof observed !== typeof wanted || observed !== wanted) {
      return `run ${expected.runId}: ${mismatch(what, observed, wanted)}`
    }
  }
  // Both attempts: the saving attempt must be the latest one, so the jobs
  // that jobsProblem reads in it are the latest attempt's too. A later
  // attempt refuses even if it passed.
  if (typeof run.run_attempt !== 'number' || run.run_attempt !== Number(expected.runAttempt)) {
    return refusedBy(
      RULES.attempts,
      `run ${expected.runId}: ${mismatch('latest attempt', run.run_attempt, Number(expected.runAttempt))}`
    )
  }
  return null
}

// GET /repos/{repo}/actions/runs/{id}/attempts/{n}/jobs: in the attempt that
// saved the marker, every covered job and the save job itself completed with
// success. A run that tested nothing, or one a marker skipped, has a covered
// job or the save job skipped. A partial re-run lists the jobs it reused with
// their earlier results under the new attempt.
export function jobsProblem(body, { runId, runAttempt, jobNames }) {
  const where = `run ${runId} attempt ${runAttempt}`
  if (!body || !Array.isArray(body.jobs) || typeof body.total_count !== 'number') {
    return `${where}: the jobs list is unreadable`
  }
  if (body.total_count !== body.jobs.length) {
    return `${where}: the jobs list holds ${body.jobs.length} of ${body.total_count} jobs`
  }
  if (!Array.isArray(jobNames) || jobNames.length < 2) {
    return `${where}: no covered jobs to check`
  }
  for (const name of jobNames) {
    const matching = body.jobs.filter(job => job?.name === name)
    if (matching.length !== 1) {
      return `${where}: ${matching.length} jobs are named ${JSON.stringify(name)}, not 1`
    }
    const [job] = matching
    if (job.run_id !== Number(runId) || job.run_attempt !== Number(runAttempt)) {
      return `${where}: job ${JSON.stringify(name)} belongs to run ${job.run_id} attempt ${job.run_attempt}`
    }
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      return `${where}: job ${JSON.stringify(name)} is ${job.status}/${job.conclusion}, not completed/success`
    }
  }
  return null
}

// GET /repos/{repo}/actions/runs/{id}/artifacts?name=…: exactly one artifact,
// named for the full marker key, unexpired, in that run. Only the save job of
// that run attempt uploads it, after its own checks passed, so a cache entry
// that another run planted under a key naming this run has no artifact here.
export function artifactProblem(body, { runId, name }) {
  const where = `run ${runId}`
  if (!body || !Array.isArray(body.artifacts) || typeof body.total_count !== 'number') {
    return `${where}: the artifact list is unreadable`
  }
  const matching = body.artifacts.filter(artifact => artifact?.name === name)
  if (body.total_count !== 1 || body.artifacts.length !== 1 || matching.length !== 1) {
    return `${where}: ${matching.length} artifacts are named ${name}, among ${body.total_count}; expected exactly 1`
  }
  const [artifact] = matching
  if (artifact.expired !== false) return `${where}: artifact ${name} has expired`
  if (artifact.workflow_run?.id !== Number(runId)) {
    return `${where}: artifact ${name} belongs to run ${artifact.workflow_run?.id}`
  }
  return null
}

// What this run knows about itself, for checking another run. Throws on any
// doubt, which `decide` turns into a full run.
export function runContext(env) {
  const repository = requireMatch(
    'GITHUB_REPOSITORY',
    env.GITHUB_REPOSITORY,
    REPOSITORY,
    'owner/name'
  )
  let jobNames
  try {
    jobNames = JSON.parse(env.TREE_PASS_COVERED_JOBS ?? '')
  } catch {
    jobNames = undefined
  }
  if (
    !Array.isArray(jobNames) ||
    jobNames.length === 0 ||
    !jobNames.every(name => typeof name === 'string' && name.length > 0 && name !== SAVE_JOB_NAME)
  ) {
    throw new TreePassConfigError('TREE_PASS_COVERED_JOBS must be a JSON list of job names')
  }
  const headBranch = env.TREE_PASS_HEAD_BRANCH
  if (typeof headBranch !== 'string' || headBranch.length === 0 || /[\r\n]/.test(headBranch)) {
    throw new TreePassConfigError('TREE_PASS_HEAD_BRANCH is missing or malformed')
  }
  return {
    repository,
    pullRequest: requireMatch(
      'TREE_PASS_PR_NUMBER',
      env.TREE_PASS_PR_NUMBER,
      PULL_REQUEST_NUMBER,
      'a pull request number'
    ),
    serverUrl: requireMatch(
      'GITHUB_SERVER_URL',
      env.GITHUB_SERVER_URL,
      SERVER_URL,
      'an https origin'
    ),
    workflowPath: workflowPathFromRef(env.GITHUB_WORKFLOW_REF, repository),
    headRepositoryId: requireMatch(
      'TREE_PASS_HEAD_REPOSITORY_ID',
      env.TREE_PASS_HEAD_REPOSITORY_ID,
      DATABASE_ID,
      'a repository ID'
    ),
    headBranch,
    headTree: requireMatch(
      'TREE_PASS_HEAD_TREE',
      env.TREE_PASS_HEAD_TREE,
      OBJECT_ID,
      'a full lowercase git object ID'
    ),
    jobNames: [...jobNames, SAVE_JOB_NAME],
    currentRunId: requireMatch('GITHUB_RUN_ID', env.GITHUB_RUN_ID, DATABASE_ID, 'a run ID'),
    currentRunAttempt: requireMatch(
      'GITHUB_RUN_ATTEMPT',
      env.GITHUB_RUN_ATTEMPT,
      RUN_ATTEMPT,
      'a run attempt'
    ),
  }
}

// GET /repos/{repo}/pulls?head=<owner>:<branch>&state=all&per_page=2: the
// pull requests ever opened from the head branch, open, closed or merged; a
// branch deleted and created again still lists the closed ones. One page of
// two is enough: it must hold exactly this one. A `pull_request` run takes its
// workflow from its merge commit, so a run of another pull request from the
// same branch, into a base its author chose, could have run a different
// workflow on the same head.
export function headPullsProblem(pulls, { pullRequest, headBranch, headRepositoryId }) {
  if (!Array.isArray(pulls)) return 'the pull requests from the head branch are unreadable'
  if (pulls.length !== 1) {
    return `${pulls.length} pull requests come from head branch ${JSON.stringify(headBranch)}, not just #${pullRequest}`
  }
  const [pull] = pulls
  if (pull?.number !== Number(pullRequest)) {
    return `the pull request from head branch ${JSON.stringify(headBranch)} is #${pull?.number}, not #${pullRequest}`
  }
  if (pull.head?.ref !== headBranch || pull.head?.repo?.id !== Number(headRepositoryId)) {
    return `pull request #${pullRequest} is listed with another head`
  }
  return null
}

// The run record's created_at, which stays the run's first creation through
// every re-run, must be strictly after this pull request's: a run created
// before the pull request existed, or in the same second, cannot be its run.
export function creationProblem(run, pull, { runId, pullRequest }) {
  const runCreated = githubTime(run?.created_at)
  if (runCreated === null) {
    return refusedBy(
      RULES.created,
      `run ${runId} has no readable created_at (${JSON.stringify(run?.created_at ?? null)})`
    )
  }
  const pullCreated = githubTime(pull?.created_at)
  if (pullCreated === null) {
    return refusedBy(
      RULES.created,
      `pull request #${pullRequest} has no readable created_at (${JSON.stringify(pull?.created_at ?? null)})`
    )
  }
  if (runCreated <= pullCreated) {
    return refusedBy(
      RULES.created,
      `run ${runId} was created at ${run.created_at}, not after pull request #${pullRequest} (${pull.created_at})`
    )
  }
  return null
}

function describeEvent(entry) {
  return Number.isSafeInteger(entry.id) ? `${entry.event} (event ${entry.id})` : entry.event
}

// GET /repos/{repo}/issues/{n}/timeline and GET /repos/{repo}/issues/{n}/events:
// no event about this pull request's base, so it was not retargeted, by hand
// or by GitHub, and its base branch was not force-pushed or deleted while
// GitHub recorded it; and no deletion or restoring of its head branch.
// Ordinary pushes to the base leave no event, so this does not show that the
// base's content never changed.
export function eventsProblem(events, { pullRequest }, listing = 'timeline') {
  const rules = `${RULES.base}, ${RULES.headBranch}`
  const where = `pull request #${pullRequest}'s ${listing}`
  if (!Array.isArray(events)) return refusedBy(rules, `${where} cannot be read`)
  for (const entry of events) {
    if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string') {
      return refusedBy(rules, `an entry in ${where} has no event name`)
    }
    if (BASE_CHANGE_EVENT.test(entry.event)) {
      return refusedBy(RULES.base, `${describeEvent(entry)} is in ${where}`)
    }
    if (HEAD_BRANCH_EVENTS.has(entry.event)) {
      return refusedBy(RULES.headBranch, `${describeEvent(entry)} is in ${where}`)
    }
  }
  return null
}

// A re-run of this run never skips: its earlier attempts ran this tree after
// the run a marker names, and their results are not read.
export function rerunProblem({ currentRunId, currentRunAttempt }) {
  if (currentRunAttempt !== '1') {
    return refusedBy(
      RULES.later,
      `this is attempt ${currentRunAttempt} of run ${currentRunId}, whose earlier attempts are not read`
    )
  }
  return null
}

// GET /repos/{repo}/actions/workflows/{file}/runs?event=pull_request&branch=…:
// since the run a marker names was created, no run of this workflow on this
// head branch whose head has this head's tree failed, was cancelled or ended
// any way but success, and none, at any time, is still going. A re-run moves
// a run's run_started_at, so a run created earlier but re-run since counts.
// The listing shows each run's latest attempt only, so a later run whose
// first attempt failed and whose re-run passed counts as a pass. The run a
// marker names must be listed, for this head tree, still at the attempt the
// marker names: its record was read at the start of the decision, and a
// re-run started since shows here at a later attempt. Its status and
// conclusion are not judged: its jobs were (both attempts), and the one job
// outside them, Dependency policy, runs again in this run. This run is still
// going.
export function laterRunsProblem(runs, { runId, runAttempt, since, context }) {
  const rule = RULES.later
  if (!Array.isArray(runs)) return refusedBy(rule, 'the runs of this workflow are unreadable')
  const { currentRunId, headBranch, headTree, workflowPath } = context
  let vouchingListed = false
  for (const run of runs) {
    if (!run || typeof run !== 'object' || !Number.isSafeInteger(run.id)) {
      return refusedBy(rule, 'the run listing has an entry without a run ID')
    }
    if (
      run.event !== 'pull_request' ||
      run.head_branch !== headBranch ||
      run.path !== workflowPath
    ) {
      return refusedBy(
        rule,
        `the run listing holds run ${run.id}, which is not a pull_request run of ${workflowPath} on this head branch`
      )
    }
    const tree = run.head_commit?.tree_id
    if (typeof tree !== 'string' || !OBJECT_ID.test(tree)) {
      return refusedBy(rule, `run ${run.id} has no readable head tree`)
    }
    if (run.id === Number(runId)) {
      if (tree !== headTree) {
        return refusedBy(rule, `run ${runId} is listed with head tree ${tree}, not ${headTree}`)
      }
      if (run.run_attempt !== Number(runAttempt)) {
        return refusedBy(
          rule,
          `run ${runId} is listed at attempt ${JSON.stringify(run.run_attempt ?? null)}, not attempt ${runAttempt}: it was re-run after its record was read`
        )
      }
      vouchingListed = true
      continue
    }
    if (tree !== headTree || run.id === Number(currentRunId)) continue
    if (run.status !== 'completed') {
      return refusedBy(
        rule,
        `run ${run.id} of this tree is ${JSON.stringify(run.status ?? null)}, not completed`
      )
    }
    if (run.conclusion === 'success') continue
    const created = githubTime(run.created_at)
    const started = githubTime(run.run_started_at)
    if (created === null || started === null) {
      return refusedBy(
        rule,
        `run ${run.id} of this tree ended ${JSON.stringify(run.conclusion ?? null)} at a time that is unreadable`
      )
    }
    if (created >= since || started >= since) {
      return refusedBy(
        rule,
        `run ${run.id} of this tree ended ${JSON.stringify(run.conclusion ?? null)} in an attempt started at ${run.run_started_at}, after run ${runId} was created`
      )
    }
  }
  if (!vouchingListed) return refusedBy(rule, `the run listing does not show run ${runId}`)
  return null
}

// The checks of the run a marker names, in order, then of this pull request.
// Returns the first problem, or null when GitHub vouches for the run.
export async function markerRunProblem({ runId, runAttempt, key, context, fetchJson, fetchList }) {
  const repo = `/repos/${context.repository}`
  const base = `${repo}/actions/runs/${runId}`
  const run = await fetchJson(base)
  const runProblem = runRecordProblem(run, { ...context, runId, runAttempt })
  if (runProblem) return runProblem
  const jobs = await readFor(RULES.attempts, () =>
    fetchJson(`${base}/attempts/${runAttempt}/jobs?per_page=100`)
  )
  const jobProblem = jobsProblem(jobs, { runId, runAttempt, jobNames: context.jobNames })
  if (jobProblem) return refusedBy(RULES.attempts, jobProblem)
  const name = artifactName(key)
  const artifacts = await fetchJson(`${base}/artifacts?name=${name}&per_page=100`)
  const artifactIssue = artifactProblem(artifacts, { runId, name })
  if (artifactIssue) return artifactIssue
  const [owner] = context.repository.split('/')
  const head = encodeURIComponent(`${owner}:${context.headBranch}`)
  const pulls = await readFor(RULES.onePull, () =>
    fetchJson(`${repo}/pulls?state=all&sort=created&direction=asc&head=${head}&per_page=2`)
  )
  const pullsIssue = headPullsProblem(pulls, context)
  if (pullsIssue) return refusedBy(RULES.onePull, pullsIssue)
  const createdIssue = creationProblem(run, pulls[0], { runId, pullRequest: context.pullRequest })
  if (createdIssue) return createdIssue
  const eventRules = `${RULES.base}, ${RULES.headBranch}`
  for (const listing of ['timeline', 'events']) {
    const events = await readFor(eventRules, () =>
      fetchList(`${repo}/issues/${context.pullRequest}/${listing}`, EVENT_PAGES)
    )
    const eventIssue = eventsProblem(
      events,
      context,
      listing === 'events' ? 'issue events' : listing
    )
    if (eventIssue) return eventIssue
  }
  const rerunIssue = rerunProblem(context)
  if (rerunIssue) return rerunIssue
  const workflowFile = context.workflowPath.slice(context.workflowPath.lastIndexOf('/') + 1)
  const runs = await readFor(RULES.later, () =>
    fetchList(
      `${repo}/actions/workflows/${workflowFile}/runs?event=pull_request&branch=${encodeURIComponent(context.headBranch)}`,
      RUN_PAGES,
      'workflow_runs'
    )
  )
  return laterRunsProblem(runs, {
    runId,
    runAttempt,
    since: githubTime(run.created_at),
    context,
  })
}

// Only a marker for exactly this prefix, from a lookup that itself succeeded,
// naming another run that GitHub confirms passed this tree, skips. A miss, an
// error, a cancelled or skipped lookup, any other key and every failed check
// runs everything. `save` says whether a full pass may record a marker: every
// eligible run that does not skip, since each run saves under its own key.
export async function decide({
  eligible,
  prefix,
  lookupOutcome,
  matchedKey,
  currentRunId,
  verify,
}) {
  if (eligible !== 'true') {
    return { skip: false, save: false, reason: 'markers are not used for this run' }
  }
  if (!isMarkerPrefix(prefix)) {
    return { skip: false, save: false, reason: 'the marker key is missing or malformed' }
  }
  const full = reason => ({ skip: false, save: true, reason })
  if (lookupOutcome !== 'success') {
    return full(`the cache lookup did not succeed (${lookupOutcome || 'no outcome'})`)
  }
  if (!matchedKey) return full('no marker for this tree')
  const named = parseMarkerKey(matchedKey, prefix)
  if (!named)
    return full(`the cache matched ${JSON.stringify(matchedKey)}, not a marker for this tree`)
  if (typeof currentRunId !== 'string' || !DATABASE_ID.test(currentRunId)) {
    return full("this run's ID is unreadable")
  }
  if (named.runId === currentRunId) {
    return full(
      `the marker was recorded by this run (${currentRunId}); a re-run of it runs in full`
    )
  }
  let problem
  try {
    problem = await verify({ ...named, key: matchedKey })
  } catch (error) {
    problem = `GitHub's record of run ${named.runId} could not be checked: ${error.message}`
  }
  if (problem) return full(problem)
  return {
    skip: true,
    save: false,
    reason: `run ${named.runId} attempt ${named.runAttempt} already passed this tree`,
    ...named,
  }
}

// The save job's own check of its inputs, before anything else: the decide
// job asked for a save and named a well-formed key prefix, and every other job
// the save job needs ran its steps and succeeded. Any of these failing means
// the wiring is wrong, so the step fails.
export function recordErrors({ needs }) {
  const errors = []
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    return ['needs is not an object']
  }
  const decideJob = needs[DECIDE_JOB]
  if (!decideJob) {
    errors.push(`needs has no ${DECIDE_JOB} job`)
  } else {
    if (decideJob.result !== 'success') {
      errors.push(`${DECIDE_JOB} result is ${JSON.stringify(decideJob.result)}, not success`)
    }
    if (decideJob.outputs?.save !== 'true') errors.push(`${DECIDE_JOB} did not ask for a save`)
    if (decideJob.outputs?.skip !== 'false') errors.push(`${DECIDE_JOB} did not run in full`)
    if (!isMarkerPrefix(decideJob.outputs?.prefix)) {
      errors.push(`${DECIDE_JOB} key prefix is missing or malformed`)
    }
  }
  const covered = Object.entries(needs).filter(([name]) => name !== DECIDE_JOB)
  if (covered.length === 0) errors.push('the save job needs no covered job')
  for (const [name, job] of covered) {
    if (job?.result !== 'success') {
      errors.push(`${name} result is ${JSON.stringify(job?.result)}, not success`)
    }
    if (job?.outputs?.tested !== 'true') errors.push(`${name} did not run its steps`)
  }
  return errors
}

function setOutput(env, name, value) {
  const text = String(value)
  if (/[\r\n]/.test(text)) throw new Error(`output ${name} contains a newline`)
  if (!env.GITHUB_OUTPUT) throw new TreePassConfigError('GITHUB_OUTPUT is missing or empty')
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`)
}

function summary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

// Workflow-command data must not carry a raw newline.
function annotation(level, text) {
  const data = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  return `::${level} title=Tree pass marker::${data}`
}

function forceLabelOf(env) {
  return requireMatch(
    'TREE_PASS_FORCE_LABEL',
    env.TREE_PASS_FORCE_LABEL,
    /^[^\s,][^,\r\n]*$/,
    'a label name'
  )
}

function prefixFromEnvironment(env, cwd) {
  return markerPrefix({
    workflow: env.TREE_PASS_WORKFLOW,
    workflowSalt: env.TREE_PASS_WORKFLOW_SALT,
    repositorySalt: repositorySalt(env.TREE_PASS_REPOSITORY_SALT),
    tree: treeOf(env.GITHUB_SHA, { cwd }),
    pullRequest: env.TREE_PASS_PR_NUMBER,
  })
}

function labelsFromEnvironment(env, fetchImpl) {
  return readPullRequestLabels({
    apiUrl: env.GITHUB_API_URL,
    repository: env.GITHUB_REPOSITORY,
    number: env.TREE_PASS_PR_NUMBER,
    token: env.GH_TOKEN,
    fetchImpl,
  })
}

// Eligibility comes first: a run that does not use markers never validates
// the salts or the key, so a bad salt cannot fail it.
export async function runKey(env, { cwd = process.cwd(), fetchImpl, log = console } = {}) {
  const forceLabel = forceLabelOf(env)
  let labels = []
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      labels = await labelsFromEnvironment(env, fetchImpl)
    } catch (error) {
      labels = null
      log.log(annotation('warning', `Running in full: ${error.message}`))
    }
  }
  const verdict = eligibility({
    eventName: env.GITHUB_EVENT_NAME,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    headRepositoryId: env.TREE_PASS_HEAD_REPOSITORY_ID,
    labels,
    forceLabel,
  })
  if (!verdict.eligible) {
    setOutput(env, 'eligible', 'false')
    summary(env, ['### Tree pass marker', '', `- Markers used: no (${verdict.reason})`])
    return verdict
  }
  const prefix = prefixFromEnvironment(env, cwd)
  const headTree = headTreeOf(env.GITHUB_SHA, env.TREE_PASS_HEAD_SHA, { cwd })
  setOutput(env, 'prefix', prefix)
  setOutput(env, 'head-tree', headTree)
  setOutput(env, 'eligible', 'true')
  summary(env, [
    '### Tree pass marker',
    '',
    `- Key prefix: \`${prefix}\``,
    `- Markers used: yes (${verdict.reason})`,
  ])
  return { ...verdict, prefix, headTree }
}

export async function runDecide(
  env,
  { fetchImpl, log = console, budgetMs = DECIDE_BUDGET_MS } = {}
) {
  const deadline = Date.now() + budgetMs
  const verdict = await decide({
    eligible: env.TREE_PASS_ELIGIBLE,
    prefix: env.TREE_PASS_PREFIX,
    lookupOutcome: env.TREE_PASS_LOOKUP_OUTCOME,
    matchedKey: env.TREE_PASS_MATCHED_KEY,
    currentRunId: env.GITHUB_RUN_ID,
    verify: named =>
      markerRunProblem({
        ...named,
        context: runContext(env),
        fetchJson: path =>
          githubJson({
            apiUrl: env.GITHUB_API_URL,
            path,
            token: env.GH_TOKEN,
            fetchImpl,
            deadline,
          }),
        fetchList: (path, maxPages, field) =>
          githubList({
            apiUrl: env.GITHUB_API_URL,
            path,
            maxPages,
            field,
            token: env.GH_TOKEN,
            fetchImpl,
            deadline,
          }),
      }),
  })
  // A skip happens only after runContext(env) validated the server URL.
  const runUrl = verdict.skip
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${verdict.runId}/attempts/${verdict.runAttempt}`
    : ''
  setOutput(env, 'skip', String(verdict.skip))
  setOutput(env, 'save', String(verdict.save))
  setOutput(env, 'run-url', runUrl)
  log.log(
    annotation(
      'notice',
      `${verdict.skip ? 'Skipping the covered jobs' : 'Running every job'}: ${verdict.reason}`
    )
  )
  summary(env, [
    `- Decision: ${verdict.skip ? 'skip the covered jobs' : 'run every job'} (${verdict.reason})`,
    ...(verdict.skip ? [`- Passing run: ${runUrl}`] : []),
  ])
  return { ...verdict, runUrl }
}

// Records a pass. Wiring errors fail the step. Doubts that can arise in a
// correct run (a salt changed during the run, the force label was added, the
// labels cannot be read) leave a warning and `ok=false`, so the run stays
// green and the next run simply runs in full.
export async function runRecord(env, { cwd = process.cwd(), fetchImpl, log = console } = {}) {
  let needs
  try {
    needs = JSON.parse(env.TREE_PASS_NEEDS ?? '')
  } catch {
    needs = undefined
  }
  const errors = recordErrors({ needs })
  if (errors.length > 0) {
    throw new Error(`refusing to record a tree pass:\n- ${errors.join('\n- ')}`)
  }
  const { prefix } = needs[DECIDE_JOB].outputs
  const directory = env.TREE_PASS_MARKER_DIR
  if (typeof directory !== 'string' || !directory.startsWith('/')) {
    throw new TreePassConfigError('TREE_PASS_MARKER_DIR must be an absolute path')
  }
  if (existsSync(directory)) {
    throw new Error(`TREE_PASS_MARKER_DIR ${directory} already exists`)
  }
  const forceLabel = forceLabelOf(env)
  const key = markerKey(prefix, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT)

  const decline = reason => {
    log.log(annotation('warning', `Not recording a tree pass: ${reason}`))
    setOutput(env, 'ok', 'false')
    summary(env, ['### Tree pass marker', '', `- Not recorded: ${reason}`])
    return { ok: false, reason }
  }
  let recomputed
  try {
    recomputed = prefixFromEnvironment(env, cwd)
  } catch (error) {
    return decline(`this run's marker key cannot be computed (${error.message})`)
  }
  if (recomputed !== prefix) {
    return decline(
      `the key ${prefix} is not this run's ${recomputed}; a salt changed during the run`
    )
  }
  let labels
  try {
    labels = await labelsFromEnvironment(env, fetchImpl)
  } catch (error) {
    return decline(`the pull request labels could not be read (${error.message})`)
  }
  if (hasLabel(labels, forceLabel)) {
    return decline(`the ${forceLabel} label is on the pull request`)
  }

  mkdirSync(directory, { recursive: true })
  const marker = {
    format: `${KEY_PREFIX}-${KEY_FORMAT}`,
    key,
    repository: env.GITHUB_REPOSITORY,
    pullRequest: env.TREE_PASS_PR_NUMBER,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    covered: Object.keys(needs)
      .filter(name => name !== DECIDE_JOB)
      .sort(),
  }
  writeFileSync(join(directory, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`)
  const artifact = artifactName(key)
  setOutput(env, 'ok', 'true')
  setOutput(env, 'key', key)
  setOutput(env, 'artifact', artifact)
  summary(env, [
    '### Tree pass marker',
    '',
    `- Recorded \`${key}\` for ${marker.covered.join(', ')}`,
    `- Artifact: \`${artifact}\``,
  ])
  return { ok: true, key, artifact, marker }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [mode, ...rest] = argv
  if (rest.length > 0) throw new TreePassConfigError(`unexpected arguments: ${rest.join(' ')}`)
  if (mode === 'key') return runKey(env)
  if (mode === 'decide') return runDecide(env)
  if (mode === 'record') return runRecord(env)
  throw new TreePassConfigError('usage: tree-pass-marker.mjs key|decide|record')
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
