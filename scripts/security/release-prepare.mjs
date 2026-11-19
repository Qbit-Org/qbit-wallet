import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VERSION_FILES, isHigher, versionParts } from './docs-only-change.mjs'
import { isPendingChangeset } from './package-versions-applied.mjs'

// `corepack pnpm release:prepare <x.y.z>` makes the changes of the pull
// request that prepares a release, in the working tree:
//
//   1. sets the extension version in both version files;
//   2. gives the release notes a `## <x.y.z>` heading when they have none;
//   3. runs `version-packages`, which applies every pending changeset to the
//      package versions and changelogs and deletes it.
//
// The `Package versions applied` check (package-versions-applied.mjs) fails a
// change that sets the version and leaves a changeset pending, so this is the
// way a release is prepared, whoever prepares it.
//
// It commits nothing. The version files and the release notes are read and
// checked before anything runs, and written only after `version-packages`
// has finished, so a refusal before the version run, or a failed version run,
// leaves them as they were. A changeset the version run leaves behind is
// reported after they are written. Running it again with the same version is safe: the version files
// are left as they are, and `version-packages` applies whatever changesets
// have landed since. That is also how a changeset that lands after the
// version was set is applied.

export const RELEASE_NOTES = 'docs/releases/release-notes.md'
const CHANGESET_DIR = '.changeset'
const VERSION_COMMAND = ['corepack', 'pnpm', 'run', 'version-packages']
const USAGE = 'Usage: corepack pnpm release:prepare <x.y.z>'

export class ReleasePrepareError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleasePrepareError'
  }
}

// The one version the command was given. pnpm hands a script a leading `--`
// when the caller wrote one.
export function versionArgument(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length !== 1) throw new ReleasePrepareError(USAGE)
  const [version] = args
  if (!versionParts(version)) {
    throw new ReleasePrepareError(
      `"${version}" is not a version the extension can have: three numbers from 0 to 65535 with no leading zero, such as 1.0.12. ${USAGE}`
    )
  }
  return version
}

function parseObject(text, file) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new ReleasePrepareError(`${file} is not JSON`)
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ReleasePrepareError(`${file} is not a JSON object`)
  }
  return json
}

// A version file's text with its top-level `version` set, and nothing else
// changed: not the layout, and no other key named `version`. Each place the
// text writes the current version is tried in turn, and the one that changes
// the top-level key and only that is taken.
export function withVersion(text, version, file) {
  const json = parseObject(text, file)
  const current = json.version
  if (typeof current !== 'string' || !versionParts(current)) {
    throw new ReleasePrepareError(`${file} has no x.y.z version to replace`)
  }
  const wanted = versionParts(version)
  if (isHigher(versionParts(current), wanted)) {
    throw new ReleasePrepareError(
      `${file} is already at ${current}, which is higher than ${version}`
    )
  }
  if (current === version) return { text, from: current }
  const expected = JSON.stringify({ ...json, version })
  const written = new RegExp(`("version"\\s*:\\s*")${current.replaceAll('.', '\\.')}(")`, 'g')
  for (const match of text.matchAll(written)) {
    const candidate =
      text.slice(0, match.index) +
      match[1] +
      version +
      match[2] +
      text.slice(match.index + match[0].length)
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (JSON.stringify(parsed) === expected) return { text: candidate, from: current }
  }
  throw new ReleasePrepareError(`${file}: its top-level version could not be set to ${version}`)
}

// The release notes with a `## <version>` heading: as they are when a heading
// starts with one, and otherwise with an empty section before the newest
// release's.
export function withNotesHeading(text, version) {
  const lines = text.split('\n')
  // A heading may say more after the version, such as a date.
  const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}(?![0-9.])`)
  if (lines.some(line => heading.test(line))) return text
  const first = lines.findIndex(line => line.startsWith('## '))
  if (first === -1) {
    throw new ReleasePrepareError(
      `${RELEASE_NOTES} has no release heading to put "## ${version}" before`
    )
  }
  return [...lines.slice(0, first), `## ${version}`, '', ...lines.slice(first)].join('\n')
}

// The changesets in the working tree that changesets would still read.
export function pendingInWorkingTree(root) {
  let entries
  try {
    entries = readdirSync(join(root, CHANGESET_DIR), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .map(entry => ({ type: entry.isDirectory() ? 'tree' : 'blob', name: entry.name }))
    .filter(isPendingChangeset)
    .map(({ name }) => name)
    .sort()
}

function runVersionPackages(root) {
  const [command, ...args] = VERSION_COMMAND
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) return `it could not be started (${result.error.message})`
  if (result.signal) return `it was stopped by ${result.signal}`
  if (result.status !== 0) return `it exited with ${result.status}`
  return undefined
}

function read(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch (error) {
    throw new ReleasePrepareError(`${file} could not be read (${error.code ?? error.message})`)
  }
}

// `versionPackages(root)` runs the version command and returns why it failed,
// or undefined.
export function prepare(
  version,
  { root, versionPackages = runVersionPackages, log = console } = {}
) {
  // Read and check everything first, so a refusal leaves the tree untouched.
  const planned = () => ({
    files: VERSION_FILES.map(file => {
      const before = read(root, file)
      return { file, before, ...withVersion(before, version, file) }
    }),
    notesBefore: read(root, RELEASE_NOTES),
  })
  withNotesHeading(planned().notesBefore, version)

  const failure = versionPackages(root)
  if (failure) {
    throw new ReleasePrepareError(
      `\`${VERSION_COMMAND.join(' ')}\` did not finish: ${failure}. This run wrote nothing to the version files or the release notes; fix what it reports and run this command again.`
    )
  }

  // Read again: the version run may have rewritten a file read above.
  const { files, notesBefore } = planned()
  const notesAfter = withNotesHeading(notesBefore, version)
  for (const { file, before, text } of files) {
    if (text !== before) writeFileSync(join(root, file), text)
  }
  if (notesAfter !== notesBefore) writeFileSync(join(root, RELEASE_NOTES), notesAfter)

  const pending = pendingInWorkingTree(root)
  if (pending.length > 0) {
    throw new ReleasePrepareError(
      `${CHANGESET_DIR}/ still holds ${pending.join(', ')}. A changeset that names only a package changesets ignores is never applied: delete it, and say what it described in the release notes.`
    )
  }

  const from = [...new Set(files.map(entry => entry.from))].join(' and ')
  log.log(
    [
      '',
      from === version
        ? `The extension version was already ${version}.`
        : `The extension version is ${version} (it was ${from}).`,
      'Every pending changeset is applied to the package versions and changelogs.',
      `Next: read \`git diff\`, complete the ${version} section of ${RELEASE_NOTES}, and commit everything as one change. The package release document, section 5, says which pull request it goes into.`,
    ].join('\n')
  )
  return { version, from: files.map(entry => entry.from) }
}

export function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  return prepare(versionArgument(argv), { root })
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) {
  try {
    main()
  } catch (error) {
    if (!(error instanceof ReleasePrepareError)) throw error
    console.error(error.message)
    process.exitCode = 1
  }
}
