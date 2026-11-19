import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VERSION_FILES, isHigher, versionParts } from './docs-only-change.mjs'
import { API_TIMEOUT_MS, githubJson } from './tree-pass-marker.mjs'

// The `Package versions applied` check. A release is prepared by setting the
// extension version and applying the pending changesets in the same pull
// request (`corepack pnpm release:prepare <x.y.z>`), so a commit that changes
// the extension version must leave no changeset pending.
//
// It compares the commit under test with its first parent: on a pull request,
// GitHub's merge of the head into the base against the base branch's tip, and
// on a push, the pushed commit against the one before it. So it judges what
// the base branch would hold after the merge, whichever branch that is: the
// pull request that sets the version on a release branch, and the release
// pull request that brings that version to the default branch, with any
// changeset that landed in between.
//
// A change that leaves the version alone passes whatever `.changeset/` holds.
// So does one that only lowers it, as a revert of a release's preparation
// does: that prepares no release, and it brings the changesets back. And so
// does one that brings a branch other than the default branch to the version
// the default branch already has, as a back-merge into a release branch that
// is not prepared yet does: that version's release has landed, and the
// changesets the branch holds belong to the next one. Only for that question
// does the check ask GitHub, for the default branch's version files, and only
// when the change would otherwise fail. The
// check reads only the commit, never the working tree, and needs the
// commit's first parent in the checkout (a depth of 2). Whatever it cannot
// read fails it: it never passes a change it could not judge.

const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const CHANGESET_DIR = '.changeset'
const TITLE = 'Package versions applied'
// The summary and the error name at most this many pending changesets.
const LISTED = 20

export class PackageVersionsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackageVersionsError'
  }
}

// Whether changesets reads an entry of `.changeset/` as a changeset, as
// `@changesets/read` decides it: a markdown file whose name has no leading
// dot and is not README.md in any case, or a directory, which it reads as a
// changeset in its first format and fails on when it is anything else.
export function isPendingChangeset({ type, name }) {
  if (type === 'tree') return true
  return (
    type === 'blob' && !name.startsWith('.') && name.endsWith('.md') && !/^README\.md$/i.test(name)
  )
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

function commitOf(revision, cwd, what) {
  try {
    return git(
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`],
      cwd
    ).trim()
  } catch {
    throw new PackageVersionsError(what)
  }
}

// The top-level `version` of each version file at a commit.
function versionsAt(commit, cwd) {
  return VERSION_FILES.map(file => {
    let text
    try {
      text = git(['show', `${commit}:${file}`], cwd)
    } catch {
      throw new PackageVersionsError(`${file} could not be read at ${commit.slice(0, 12)}`)
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new PackageVersionsError(`${file} at ${commit.slice(0, 12)} is not JSON`)
    }
    const version = json !== null && typeof json === 'object' ? json.version : undefined
    if (typeof version !== 'string' || version === '') {
      throw new PackageVersionsError(`${file} at ${commit.slice(0, 12)} has no version`)
    }
    return version
  })
}

// The entries directly inside `.changeset/` at a commit that changesets reads
// as changesets, by name. A commit without the directory has none.
export function pendingChangesets(commit, cwd) {
  let listed
  try {
    // --full-tree: the path is read from the repository's root, wherever in
    // the checkout the command runs.
    listed = git(['ls-tree', '-z', '--full-tree', commit, '--', `${CHANGESET_DIR}/`], cwd)
  } catch {
    throw new PackageVersionsError(
      `${CHANGESET_DIR}/ could not be listed at ${commit.slice(0, 12)}`
    )
  }
  return listed
    .split('\0')
    .filter(Boolean)
    .map(line => {
      // <mode> SP <type> SP <object> TAB <path>
      const tab = line.indexOf('\t')
      const type = tab === -1 ? undefined : line.slice(0, tab).split(' ')[1]
      const path = line.slice(tab + 1)
      if (!type || !path.startsWith(`${CHANGESET_DIR}/`)) {
        throw new PackageVersionsError(
          `git listed ${CHANGESET_DIR}/ in a form this check cannot read`
        )
      }
      return { type, name: path.slice(CHANGESET_DIR.length + 1) }
    })
    .filter(isPendingChangeset)
    .map(({ name }) => name)
    .sort()
}

// What the commit `revision` does: whether it changes the extension version
// against its first parent, and the changesets it leaves pending.
export function judge({ cwd = process.cwd(), revision = 'HEAD' } = {}) {
  const head = commitOf(revision, cwd, `${revision} is not a commit in this checkout`)
  const base = commitOf(
    `${head}^1`,
    cwd,
    `the commit under test, ${head.slice(0, 12)}, has no parent in this checkout, so there is nothing to compare its version with; check out with a depth of 2`
  )
  const before = versionsAt(base, cwd)
  const after = versionsAt(head, cwd)
  const moved = VERSION_FILES.map((file, index) => index).filter(
    index => after[index] !== before[index]
  )
  if (moved.length === 0) {
    return { ok: true, changed: false, version: after[0], pending: [] }
  }
  // Lowered only when both versions of every file that moved read as x.y.z
  // and the new one is the lower. Anything else is judged as a release.
  const lowered = moved.every(index => {
    const from = versionParts(before[index])
    const to = versionParts(after[index])
    return from !== undefined && to !== undefined && isHigher(from, to)
  })
  const [first] = moved
  const change = {
    changed: true,
    file: VERSION_FILES[first],
    from: before[first],
    to: after[first],
    moved: moved.map(index => ({
      file: VERSION_FILES[index],
      from: before[index],
      to: after[index],
    })),
  }
  if (lowered) return { ok: true, ...change, lowered: true, pending: [] }
  const pending = pendingChangesets(head, cwd)
  return { ok: pending.length === 0, ...change, lowered: false, pending }
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/

// Whether a change that fails only brings its branch to the version the
// default branch already has: every version file it moved now holds exactly
// the version that file has on the default branch. Then it prepares no
// release, and the changesets it leaves belong to the branch's own release.
//
// False, with no request, where that cannot be: when the run is for the
// default branch itself, a pull request into it or a push to it, and when the
// workflow gave no default branch, as in a local run. Otherwise the answer
// comes from GitHub, and a read that fails or cannot be understood throws: the
// check then fails as one that could not judge, and running it again asks
// again.
export async function adoptsDefaultBranchVersion(verdict, env, { fetchImpl } = {}) {
  const branch = env.PACKAGE_VERSIONS_DEFAULT_BRANCH
  const target = env.GITHUB_BASE_REF || env.GITHUB_REF_NAME
  if (!branch || !target || target === branch) return false
  if (!BRANCH.test(branch)) {
    throw new PackageVersionsError('PACKAGE_VERSIONS_DEFAULT_BRANCH is not a branch name')
  }
  if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new PackageVersionsError('GITHUB_REPOSITORY is not owner/name')
  }
  for (const { file, to } of verdict.moved) {
    let version
    try {
      const body = await githubJson({
        apiUrl: env.GITHUB_API_URL,
        path: `/repos/${env.GITHUB_REPOSITORY}/contents/${file}?ref=${encodeURIComponent(branch)}`,
        token: env.GH_TOKEN,
        fetchImpl,
        timeoutMs: API_TIMEOUT_MS,
      })
      if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
        throw new Error('GitHub did not answer with the file')
      }
      version = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))?.version
      if (typeof version !== 'string' || version === '') throw new Error('it has no version')
    } catch (error) {
      throw new PackageVersionsError(
        `${file} on ${branch} could not be read (${oneLine(error.message)}); run this check again`
      )
    }
    if (version !== to) return false
  }
  return true
}

// A value on one line: a file name can hold a newline, which would break the
// summary's list.
function oneLine(text) {
  return String(text)
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
}

// Workflow-command data must not carry a raw newline.
function annotation(level, text) {
  const data = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  return `::${level} title=${TITLE}::${data}`
}

function summary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

export function report(verdict) {
  if (!verdict.changed) {
    return `The extension version is unchanged (${oneLine(verdict.version)}), so pending changesets are not checked.`
  }
  const change = `The extension version changes from ${oneLine(verdict.from)} to ${oneLine(verdict.to)}`
  if (verdict.lowered) {
    return `The extension version goes back from ${oneLine(verdict.from)} to ${oneLine(verdict.to)}, which prepares no release, so pending changesets are not checked.`
  }
  if (verdict.adopted) {
    return `${change}, the version \`${oneLine(verdict.adopted)}\` already has, so the change prepares no release and the changesets it leaves pending are not checked.`
  }
  if (verdict.ok) return `${change}, and no changeset is pending.`
  const count = verdict.pending.length
  const names = verdict.pending.slice(0, LISTED).map(oneLine).join(', ')
  const more = count > LISTED ? `, and ${count - LISTED} more` : ''
  return (
    `${change} and leaves ${count} pending ${count === 1 ? 'changeset' : 'changesets'} in ${CHANGESET_DIR}/ (${names}${more}). ` +
    `A release applies them in the pull request that sets its version: run \`corepack pnpm release:prepare ${versionParts(verdict.to) ? oneLine(verdict.to) : '<x.y.z>'}\` and commit what it changes. ` +
    'It can be run again for a changeset that landed after the version was set. ' +
    'If a file is still there afterwards, it names only a package that changesets ignores and is never applied: delete it.'
  )
}

export async function run(
  env = process.env,
  { cwd = process.cwd(), log = console, fetchImpl } = {}
) {
  let verdict = judge({ cwd })
  if (!verdict.ok && (await adoptsDefaultBranchVersion(verdict, env, { fetchImpl }))) {
    verdict = { ...verdict, ok: true, adopted: env.PACKAGE_VERSIONS_DEFAULT_BRANCH }
  }
  const text = report(verdict)
  log.log(annotation(verdict.ok ? 'notice' : 'error', text))
  summary(env, [`### ${TITLE}`, '', `- ${verdict.ok ? 'Passed' : 'Failed'}: ${text}`])
  return verdict
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length > 0) throw new PackageVersionsError(`unexpected arguments: ${argv.join(' ')}`)
  return run(env)
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) {
  try {
    if (!(await main()).ok) process.exitCode = 1
  } catch (error) {
    console.log(annotation('error', `This check could not judge the change: ${error.message}`))
    process.exitCode = 1
  }
}
