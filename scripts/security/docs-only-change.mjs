import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TreePassConfigError, readPullRequestLabels } from './tree-pass-marker.mjs'

// Decides, for one pull request run, whether the pull request changes only
// documentation that no skipped step reads, so that the expensive steps of
// `Typecheck, test, and build`'s lanes and the G3 shards can be skipped while
// their checks still report success. The lane
// `Typecheck, security checks and other unit tests` runs in full anyway: its
// security tooling tests read every tracked file, documentation included. The workflows read the
// `docs-only` output next to the tree pass marker's `skip`;
// docs/ci-docs-only.md explains the design and the allowlist. Every doubt,
// and every error, resolves to "run everything": the output is `true` only
// when every check below passed.

// The documentation files that no step a docs-only change skips reads. Each
// entry is a judgment, recorded in docs/ci-docs-only.md with the readers that
// were looked for; the tests also fail if a tracked file outside the
// allowlist starts naming one of them. Readers that walk every tracked file,
// such as former-owner.test.mjs, name none of them; they run in the lane that
// a docs-only change never skips, and in `Dependency policy`.
//
// - Markdown under docs/: no build, package, workflow or skipped test reads
//   it, except the files in DOCS_EXCLUDED. The JSON evidence in docs/security
//   is read by the dependency policy, and is not markdown.
// - README.md, CONTRIBUTING.md and SECURITY.md at the repository root: the
//   root package is private and never packed, and only the whole-tree
//   readers above read them.
//
// Everything else is excluded, including package READMEs and CHANGELOGs (in
// the published packages, and written by changesets), .changeset/ (read by
// changesets), LICENSE files, apps/ (the extension; pqc.yml also runs on any
// change there) and everything under .github/, which GitHub itself reads.
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*'
const DOCS_MARKDOWN = new RegExp(`^docs/(?:${SEGMENT}/)*${SEGMENT}\\.md$`)
const ROOT_DOCS = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md'])
export const DOCS_EXCLUDED = new Map([
  ['docs/pqc-derivation.md', 'pqc.yml runs on every change to it, as part of the PQC contract'],
])

// More changed files than this is not a documentation fix; it runs in full.
export const MAX_CHANGED_PATHS = 200
// Git's output for at most MAX_CHANGED_PATHS short paths is a few kilobytes.
// Anything that does not fit, or does not finish in time, fails the read.
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const GIT_TIMEOUT_MS = 60_000

// SHA-1 or SHA-256 object names, as git prints them with --no-abbrev.
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const RAW_HEADER =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])([0-9]{0,3})$/
const NUMSTAT_RECORD = /^([0-9]+|-)\t([0-9]+|-)\t([\s\S]+)$/
// A regular, non-executable file, and the mode of the side a file is absent on.
const REGULAR_FILE = '100644'
const ABSENT = '000000'
const STATUS = {
  A: 'was added',
  B: 'was rewritten',
  C: 'was copied',
  D: 'was deleted',
  M: 'was modified',
  R: 'was renamed',
  T: 'changed type',
  U: 'is unmerged',
  X: 'changed in a way git does not know',
}
const FORCE_LABEL = /^[^\s,][^,\r\n]*$/

export class DocsOnlyConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DocsOnlyConfigError'
  }
}

export function isAllowlisted(path) {
  if (typeof path !== 'string') return false
  if (ROOT_DOCS.has(path)) return true
  return DOCS_MARKDOWN.test(path) && !DOCS_EXCLUDED.has(path)
}

// `git diff --raw -z --no-abbrev`: for each file
// `:<old mode> <new mode> <old id> <new id> <status>[<score>]\0<path>\0`, with
// a second path after a rename or a copy. Anything else throws.
export function parseRawDiff(output) {
  if (typeof output !== 'string') throw new Error('git diff --raw gave no output')
  if (output === '') return []
  if (!output.endsWith('\0')) throw new Error('git diff --raw output does not end with NUL')
  const fields = output.slice(0, -1).split('\0')
  const entries = []
  for (let index = 0; index < fields.length; ) {
    const header = RAW_HEADER.exec(fields[index])
    if (!header) {
      throw new Error(`malformed git diff --raw record ${JSON.stringify(fields[index])}`)
    }
    const [, oldMode, newMode, , , status] = header
    const count = status === 'R' || status === 'C' ? 2 : 1
    const paths = fields.slice(index + 1, index + 1 + count)
    if (paths.length !== count || paths.some(path => path === '')) {
      throw new Error(`git diff --raw record ${JSON.stringify(fields[index])} has no path`)
    }
    entries.push({ oldMode, newMode, status, paths })
    index += 1 + count
  }
  return entries
}

// `git diff --numstat -z --no-renames`: `<added>\t<deleted>\t<path>\0` for each
// file, with `-` for both counts when git sees a binary file.
export function parseNumstat(output) {
  if (typeof output !== 'string') throw new Error('git diff --numstat gave no output')
  if (output === '') return []
  if (!output.endsWith('\0')) throw new Error('git diff --numstat output does not end with NUL')
  return output
    .slice(0, -1)
    .split('\0')
    .map(record => {
      const match = NUMSTAT_RECORD.exec(record)
      if (!match) throw new Error(`malformed git diff --numstat record ${JSON.stringify(record)}`)
      return { binary: match[1] === '-' || match[2] === '-', path: match[3] }
    })
}

function describe(entry) {
  const what = STATUS[entry.status] ?? `has status ${entry.status}`
  return entry.paths.length === 2
    ? `${entry.paths[1]} ${what} from ${entry.paths[0]}`
    : `${entry.paths[0]} ${what}`
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// The verdict for the files a pull request changes. Only added or modified
// regular files in the allowlist, with text content, make a docs-only change.
export function classify({ entries, numstat }) {
  if (!Array.isArray(entries) || !Array.isArray(numstat)) {
    return { docsOnly: false, reason: 'the changed files could not be read' }
  }
  if (entries.length === 0) {
    return { docsOnly: false, reason: 'the pull request changes no file against its base' }
  }
  if (entries.length > MAX_CHANGED_PATHS) {
    return {
      docsOnly: false,
      reason: `${plural(entries.length, 'file')} changed, more than ${MAX_CHANGED_PATHS}`,
    }
  }
  const paths = []
  for (const entry of entries) {
    if (entry.status !== 'A' && entry.status !== 'M') {
      return { docsOnly: false, reason: describe(entry) }
    }
    const [path] = entry.paths
    const wantedOld = entry.status === 'A' ? ABSENT : REGULAR_FILE
    if (entry.oldMode !== wantedOld || entry.newMode !== REGULAR_FILE) {
      return {
        docsOnly: false,
        reason: `${path} has mode ${entry.oldMode} to ${entry.newMode}, not a regular file`,
      }
    }
    if (!isAllowlisted(path)) {
      return { docsOnly: false, reason: `${path} is not in the docs-only allowlist` }
    }
    paths.push(path)
  }
  // Both listings must name the same files, once each.
  const listed = numstat.map(record => record.path)
  if (
    new Set(paths).size !== paths.length ||
    listed.length !== paths.length ||
    [...listed].sort().join('\0') !== [...paths].sort().join('\0')
  ) {
    return { docsOnly: false, reason: 'git listed different files in its two listings' }
  }
  const binary = numstat.find(record => record.binary)
  if (binary) return { docsOnly: false, reason: `${binary.path} is binary` }
  return {
    docsOnly: true,
    reason: `${plural(paths.length, 'file')} changed, all documentation that no skipped step reads`,
    paths,
  }
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// The files the pull request changes: GitHub's merge of the head into the base
// (GITHUB_SHA) against its first parent, the base it merged into. That is the
// tree the run tests, against the tree the base already has. The merge must
// have exactly two parents, the second the pull request head, so the checkout
// needs a depth of 2. Renames and copies are looked for so that they can be
// refused by name; submodules are never ignored.
export function readChanges({ mergeSha, headSha, cwd = process.cwd() }) {
  for (const [name, value] of [
    ['GITHUB_SHA', mergeSha],
    ['TREE_PASS_HEAD_SHA', headSha],
  ]) {
    if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
      throw new DocsOnlyConfigError(`${name} must be a full lowercase git object ID`)
    }
  }
  const parents = git(['rev-list', '--parents', '-n', '1', '--end-of-options', mergeSha], cwd)
    .trim()
    .split(' ')
    .slice(1)
  if (
    parents.length !== 2 ||
    parents[1] !== headSha ||
    parents[0] === headSha ||
    !OBJECT_ID.test(parents[0])
  ) {
    throw new Error(`${mergeSha} is not a merge of the pull request head ${headSha} into a base`)
  }
  const [base] = parents
  const common = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-z']
  const raw = git(
    [
      'diff',
      '--raw',
      '--no-abbrev',
      '--find-renames',
      '--find-copies',
      ...common,
      '--end-of-options',
      base,
      mergeSha,
    ],
    cwd
  )
  const numstat = git(
    ['diff', '--numstat', '--no-renames', ...common, '--end-of-options', base, mergeSha],
    cwd
  )
  return { base, entries: parseRawDiff(raw), numstat: parseNumstat(numstat) }
}

function hasLabel(labels, wanted) {
  return labels.some(label => label.toLowerCase() === wanted.toLowerCase())
}

// The verdict for this run. Errors from the label read and from git become a
// full run with the error as the reason. A wiring error in this step (no force
// label, a missing or malformed setting for the label read, or a commit that
// is not an object ID) throws, as the marker's do.
export async function classifyPullRequest(env, { cwd = process.cwd(), fetchImpl } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    return {
      docsOnly: false,
      reason: `${env.GITHUB_EVENT_NAME || 'an unknown'} event always runs in full`,
    }
  }
  const forceLabel = env.TREE_PASS_FORCE_LABEL
  if (typeof forceLabel !== 'string' || !FORCE_LABEL.test(forceLabel)) {
    throw new DocsOnlyConfigError('TREE_PASS_FORCE_LABEL must be a label name')
  }
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
    })
  } catch (error) {
    // A missing or malformed setting (the token, the API URL, the
    // repository, the pull request number) is a wiring error, not a doubt.
    if (error instanceof TreePassConfigError) throw new DocsOnlyConfigError(error.message)
    return {
      docsOnly: false,
      reason: `the pull request labels could not be read (${error.message})`,
    }
  }
  if (hasLabel(labels, forceLabel)) {
    return { docsOnly: false, reason: `the ${forceLabel} label forces a full run` }
  }
  let changes
  try {
    changes = readChanges({ mergeSha: env.GITHUB_SHA, headSha: env.TREE_PASS_HEAD_SHA, cwd })
  } catch (error) {
    if (error instanceof DocsOnlyConfigError) throw error
    return {
      docsOnly: false,
      reason: `the changed files could not be read (${String(error.message).trim()})`,
    }
  }
  return classify(changes)
}

function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) throw new DocsOnlyConfigError('GITHUB_OUTPUT is missing or empty')
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

// A reason on one line: git's errors span several, which would break the
// summary's list.
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
  return `::${level} title=Docs-only change::${data}`
}

// The summary names at most this many of the files a docs-only change has.
const LISTED_PATHS = 20

// Sets `docs-only` to `true` or `false`. Any error other than a configuration
// error leaves `false`, so the step stays green and the run runs in full.
export async function runDocsOnly(env, { cwd = process.cwd(), fetchImpl, log = console } = {}) {
  let verdict
  try {
    verdict = await classifyPullRequest(env, { cwd, fetchImpl })
  } catch (error) {
    if (error instanceof DocsOnlyConfigError) throw error
    verdict = { docsOnly: false, reason: `the change could not be classified (${error.message})` }
  }
  setOutput(env, 'docs-only', verdict.docsOnly ? 'true' : 'false')
  log.log(
    annotation(
      'notice',
      verdict.docsOnly
        ? `Docs-only change, so the steps that read no documentation are skipped: ${verdict.reason}`
        : `Not a docs-only change, so every step runs: ${verdict.reason}`
    )
  )
  const paths = verdict.docsOnly ? verdict.paths : []
  summary(env, [
    '### Docs-only change',
    '',
    `- Docs-only: ${verdict.docsOnly ? 'yes, the steps that read no documentation are skipped' : 'no'} (${oneLine(verdict.reason)})`,
    ...paths.slice(0, LISTED_PATHS).map(path => `  - \`${path}\``),
    ...(paths.length > LISTED_PATHS ? [`  - and ${paths.length - LISTED_PATHS} more`] : []),
    ...(verdict.docsOnly
      ? [`- Add the \`${env.TREE_PASS_FORCE_LABEL}\` label and re-run all jobs to run everything.`]
      : []),
  ])
  return verdict
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length > 0) throw new DocsOnlyConfigError(`unexpected arguments: ${argv.join(' ')}`)
  return runDocsOnly(env)
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
