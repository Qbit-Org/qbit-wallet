import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { devNull, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { VERSION_FILES } from './docs-only-change.mjs'
import {
  PackageVersionsError,
  isPendingChangeset,
  judge,
  pendingChangesets,
  report,
} from './package-versions-applied.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(repoRoot, 'scripts/security/package-versions-applied.mjs')
const CHECK = 'Package versions applied'
const [PACKAGE_JSON, MANIFEST] = VERSION_FILES

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A throwaway repository. Its git commands read no user or system
// configuration, so they behave the same on every machine.
function gitFixture(t) {
  const dir = scratch(t, 'package-versions-git-')
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Package Versions Test',
    GIT_AUTHOR_EMAIL: 'package-versions@example.invalid',
    GIT_COMMITTER_NAME: 'Package Versions Test',
    GIT_COMMITTER_EMAIL: 'package-versions@example.invalid',
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
  const write = (file, content) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  const remove = file => rmSync(join(dir, file), { recursive: true })
  const commit = message => {
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const setVersion = (version, files = VERSION_FILES) => {
    for (const file of files) write(file, `${JSON.stringify({ name: 'x', version }, null, 2)}\n`)
  }
  return { dir, git, write, remove, commit, setVersion }
}

const CHANGESET = "---\n'@qbit/wallet-shared': patch\n---\n\nA change.\n"

// A repository at 1.0.11 with the files `.changeset/` always holds and one
// pending changeset.
function released(t) {
  const repo = gitFixture(t)
  repo.setVersion('1.0.11')
  repo.write('.changeset/README.md', '# Changesets\n')
  repo.write('.changeset/config.json', '{}\n')
  repo.write('.changeset/first.md', CHANGESET)
  repo.commit('1.0.11')
  return repo
}

// --- Which files are changesets ---------------------------------------------

// `@changesets/read` is the reader `changeset version` uses. It is a
// dependency of the CLI, so it is resolved from there.
const requireFromCli = createRequire(
  createRequire(import.meta.url).resolve('@changesets/cli/package.json')
)
const readChangesets = requireFromCli('@changesets/read').default

test('a file is pending exactly when changesets reads it as a changeset', async t => {
  const dir = scratch(t, 'package-versions-read-')
  mkdirSync(join(dir, '.changeset'))
  const names = [
    'first.md',
    'second-change.md',
    'UPPER.MD',
    'notes.markdown',
    'README.md',
    'readme.md',
    'Readme.MD',
    'README.md.md',
    'config.json',
    '.hidden.md',
    '.gitkeep',
    'md',
    'x.md.txt',
  ]
  for (const name of names) writeFileSync(join(dir, '.changeset', name), '---\n---\n')
  const read = (await readChangesets(dir)).map(({ id }) => `${id}.md`).sort()
  const pending = names.filter(name => isPendingChangeset({ type: 'blob', name })).sort()
  assert.deepEqual(pending, read)
  assert.deepEqual(pending, ['README.md.md', 'first.md', 'second-change.md'])
})

test('a directory in .changeset is pending, as changesets reads or fails on it', async t => {
  const dir = scratch(t, 'package-versions-dir-')
  mkdirSync(join(dir, '.changeset/old-format'), { recursive: true })
  await assert.rejects(readChangesets(dir))
  assert.equal(isPendingChangeset({ type: 'tree', name: 'old-format' }), true)
  // Anything else git can list there is not a changeset.
  assert.equal(isPendingChangeset({ type: 'commit', name: 'submodule.md' }), false)
})

// --- The verdict --------------------------------------------------------------

test('a change that leaves the version alone passes whatever is pending', t => {
  const repo = released(t)
  repo.write('.changeset/second.md', CHANGESET)
  repo.write('src/index.js', 'export {}\n')
  repo.commit('a fix with a changeset')
  assert.deepEqual(judge({ cwd: repo.dir }), {
    ok: true,
    changed: false,
    version: '1.0.11',
    pending: [],
  })
})

test('a version change with every changeset applied passes', t => {
  const repo = released(t)
  repo.setVersion('1.0.12')
  repo.remove('.changeset/first.md')
  repo.commit('prepare 1.0.12')
  assert.deepEqual(judge({ cwd: repo.dir }), {
    ok: true,
    changed: true,
    file: PACKAGE_JSON,
    from: '1.0.11',
    to: '1.0.12',
    lowered: false,
    pending: [],
  })
  // Nor does it need the directory.
  repo.setVersion('1.0.13')
  repo.remove('.changeset')
  repo.commit('prepare 1.0.13')
  assert.equal(judge({ cwd: repo.dir }).ok, true)
})

test('a version change that leaves changesets pending fails and names them', t => {
  const repo = released(t)
  repo.setVersion('1.0.12')
  repo.write('.changeset/zeta.md', CHANGESET)
  repo.write('.changeset/.hidden.md', CHANGESET)
  repo.write('.changeset/old-format/changes.md', 'Old.\n')
  repo.write('.changeset/nested/deeper/file.md', CHANGESET)
  repo.commit('set the version only')
  const verdict = judge({ cwd: repo.dir })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.changed, true)
  assert.deepEqual(verdict.pending, ['first.md', 'nested', 'old-format', 'zeta.md'])
  const text = report(verdict)
  assert.match(text, /from 1\.0\.11 to 1\.0\.12 and leaves 4 pending changesets/)
  assert.match(text, /first\.md, nested, old-format, zeta\.md/)
  assert.match(text, /corepack pnpm release:prepare 1\.0\.12/)
})

test('either version file changing counts as a version change', t => {
  for (const file of VERSION_FILES) {
    const repo = released(t)
    repo.setVersion('1.0.12', [file])
    repo.commit(`set ${file} only`)
    const verdict = judge({ cwd: repo.dir })
    assert.equal(verdict.ok, false, file)
    assert.equal(verdict.file, file)
    assert.deepEqual(verdict.pending, ['first.md'])
  }
  assert.equal(MANIFEST, 'apps/extension/build/_raw/manifest/_base_v3.json')
})

test('a change that only lowers the version passes, as a revert of a preparation does', t => {
  const repo = released(t)
  repo.setVersion('1.0.12')
  repo.remove('.changeset/first.md')
  repo.commit('prepare 1.0.12')
  // The revert brings the version back down and the changeset back.
  repo.setVersion('1.0.11')
  repo.write('.changeset/first.md', CHANGESET)
  repo.commit('revert the preparation')
  const verdict = judge({ cwd: repo.dir })
  assert.deepEqual(verdict, {
    ok: true,
    changed: true,
    file: PACKAGE_JSON,
    from: '1.0.12',
    to: '1.0.11',
    lowered: true,
    pending: [],
  })
  assert.match(report(verdict), /goes back from 1\.0\.12 to 1\.0\.11, which prepares no release/)
})

test('a version change that is not plainly a lowering is judged as a release', t => {
  const cases = [
    // One file up and one down.
    repo => {
      repo.setVersion('1.0.12', [PACKAGE_JSON])
      repo.setVersion('1.0.10', [MANIFEST])
    },
    // To or from something that is no x.y.z version.
    repo => repo.setVersion('next'),
    repo => repo.setVersion('1.0'),
    repo => repo.setVersion('01.0.10'),
    repo => repo.setVersion('1.0.10-rc.1'),
  ]
  for (const change of cases) {
    const repo = released(t)
    change(repo)
    repo.commit('change the version')
    const verdict = judge({ cwd: repo.dir })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.lowered, false)
    assert.deepEqual(verdict.pending, ['first.md'])
  }
  const odd = released(t)
  odd.setVersion('next')
  odd.commit('an odd version')
  odd.setVersion('1.0.10')
  odd.commit('from an odd version')
  assert.equal(judge({ cwd: odd.dir }).ok, false)
})

// GitHub's merge of a pull request's head into its base: the commit a pull
// request run tests. Its first parent is the base branch's tip.
function merged(repo, base, head) {
  repo.git('checkout', '-q', '--detach', base)
  repo.git('merge', '-q', '--no-ff', '--no-edit', head)
  return repo.git('rev-parse', 'HEAD')
}

test('a changeset that reached the base after the version was set fails the merge', t => {
  const repo = released(t)
  repo.git('checkout', '-q', '-b', 'prepare')
  repo.setVersion('1.0.12')
  repo.remove('.changeset/first.md')
  const head = repo.commit('prepare 1.0.12')
  // On its own the head is complete.
  assert.equal(judge({ cwd: repo.dir }).ok, true)
  repo.git('checkout', '-q', 'main')
  repo.write('.changeset/late.md', CHANGESET)
  const base = repo.commit('a late fix')
  merged(repo, base, head)
  const verdict = judge({ cwd: repo.dir })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.pending, ['late.md'])
})

test('a merge that brings pending changesets into a base already at the version passes', t => {
  // A back-merge: the release branch has its version, and the default branch
  // brings an older version's files with changesets of its own.
  const repo = released(t)
  repo.git('checkout', '-q', '-b', 'release')
  repo.setVersion('1.0.12')
  repo.remove('.changeset/first.md')
  const base = repo.commit('prepare 1.0.12')
  repo.git('checkout', '-q', 'main')
  repo.write('.changeset/from-main.md', CHANGESET)
  repo.write('src/later.js', 'export const later = true\n')
  const head = repo.commit('a change on the default branch')
  merged(repo, base, head)
  assert.deepEqual(judge({ cwd: repo.dir }), {
    ok: true,
    changed: false,
    version: '1.0.12',
    pending: [],
  })
})

test('what cannot be read is an error, never a pass', t => {
  const rootOnly = gitFixture(t)
  rootOnly.setVersion('1.0.11')
  rootOnly.commit('root')
  assert.throws(() => judge({ cwd: rootOnly.dir }), /has no parent in this checkout/)
  assert.throws(
    () => judge({ cwd: rootOnly.dir, revision: 'missing' }),
    /missing is not a commit in this checkout/
  )

  // A checkout of depth 1 has the commit and not its parent.
  const full = released(t)
  full.setVersion('1.0.12')
  full.commit('set the version only')
  const shallow = scratch(t, 'package-versions-shallow-')
  full.git('clone', '-q', '--depth', '1', `file://${full.dir}`, shallow)
  assert.throws(() => judge({ cwd: shallow }), PackageVersionsError)
  assert.equal(judge({ cwd: full.dir }).ok, false)

  const broken = [
    ['{ not json', /is not JSON/],
    ['{"name":"x"}', /has no version/],
    ['{"version":""}', /has no version/],
    ['{"version":10012}', /has no version/],
    ['null', /has no version/],
  ]
  for (const [content, expected] of broken) {
    // Unreadable at the head, and then at the base.
    const repo = released(t)
    repo.write(PACKAGE_JSON, content)
    repo.commit('break the version file')
    assert.throws(() => judge({ cwd: repo.dir }), expected, content)
    repo.setVersion('1.0.12')
    repo.remove('.changeset/first.md')
    repo.commit('prepare 1.0.12')
    assert.throws(() => judge({ cwd: repo.dir }), expected, content)
  }
  const gone = released(t)
  gone.remove(MANIFEST)
  gone.commit('remove a version file')
  assert.throws(() => judge({ cwd: gone.dir }), /_base_v3\.json could not be read/)
})

test('the verdict is the same from any directory of the checkout', t => {
  const repo = released(t)
  repo.setVersion('1.0.12')
  repo.write('scripts/tool/run.js', 'export {}\n')
  repo.commit('set the version only')
  for (const cwd of [repo.dir, join(repo.dir, 'scripts'), join(repo.dir, 'scripts/tool')]) {
    const verdict = judge({ cwd })
    assert.equal(verdict.ok, false, cwd)
    assert.deepEqual(verdict.pending, ['first.md'], cwd)
  }
  assert.equal(runScript(join(repo.dir, 'scripts/tool'), t).status, 1)
})

test('the advice names the command with a version it accepts', () => {
  const advice = to =>
    report({ ok: false, changed: true, lowered: false, from: '1.0.11', to, pending: ['a.md'] })
  assert.match(advice('1.0.12'), /`corepack pnpm release:prepare 1\.0\.12`/)
  for (const to of ['next', '1.0.12-rc.1', '1.0', '01.0.12']) {
    assert.match(advice(to), /`corepack pnpm release:prepare <x\.y\.z>`/, to)
  }
})

test('pending changesets are read from the commit, not the working tree', t => {
  const repo = released(t)
  const commit = repo.git('rev-parse', 'HEAD')
  repo.write('.changeset/uncommitted.md', CHANGESET)
  repo.remove('.changeset/first.md')
  assert.deepEqual(pendingChangesets(commit, repo.dir), ['first.md'])
})

// --- The command --------------------------------------------------------------

function runScript(cwd, t, args = []) {
  const temp = scratch(t, 'package-versions-run-')
  const summaryFile = join(temp, 'summary')
  const run = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryFile },
    encoding: 'utf8',
  })
  let summary = ''
  try {
    summary = readFileSync(summaryFile, 'utf8')
  } catch {
    // No summary was written.
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, summary }
}

test('the command passes, fails and refuses with an annotation and a summary', t => {
  const repo = released(t)
  repo.write('src/index.js', 'export {}\n')
  repo.commit('a fix')
  const unchanged = runScript(repo.dir, t)
  assert.equal(unchanged.status, 0, unchanged.stderr)
  assert.match(
    unchanged.stdout,
    /^::notice title=Package versions applied::The extension version is unchanged \(1\.0\.11\)/
  )
  assert.match(unchanged.summary, /^### Package versions applied\n\n- Passed: /)

  repo.setVersion('1.0.12')
  repo.commit('set the version only')
  const failed = runScript(repo.dir, t)
  assert.equal(failed.status, 1)
  assert.match(
    failed.stdout,
    /^::error title=Package versions applied::.*leaves 1 pending changeset in \.changeset\/ \(first\.md\)/
  )
  assert.match(failed.summary, /- Failed: .*corepack pnpm release:prepare 1\.0\.12/)

  repo.remove('.changeset/first.md')
  repo.commit('apply the changeset')
  // The version no longer changes in this commit, so it passes as unchanged.
  assert.equal(runScript(repo.dir, t).status, 0)

  const rootOnly = gitFixture(t)
  rootOnly.setVersion('1.0.11')
  rootOnly.commit('root')
  const refused = runScript(rootOnly.dir, t)
  assert.equal(refused.status, 1)
  assert.match(
    refused.stdout,
    /^::error title=Package versions applied::This check could not judge the change: /
  )
  assert.equal(refused.summary, '')

  const extra = runScript(repo.dir, t, ['--force'])
  assert.equal(extra.status, 1)
  assert.match(extra.stdout, /unexpected arguments: --force/)
})

test('a changeset name with a newline stays on one annotation line', t => {
  const repo = released(t)
  repo.setVersion('1.0.12')
  repo.write('.changeset/two\nlines.md', CHANGESET)
  repo.commit('set the version only')
  const failed = runScript(repo.dir, t)
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout.trim().split('\n').length, 1)
  assert.match(failed.stdout, /two lines\.md/)
  assert.equal(failed.summary.trim().split('\n').length, 3)
})

// --- The wiring ---------------------------------------------------------------

test('ci.yml runs the check on every event, against the commit and its first parent', () => {
  const workflow = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'))
  const producers = Object.entries(workflow.jobs).filter(([, job]) => job.name === CHECK)
  assert.equal(producers.length, 1)
  const [[, job]] = producers
  // Nothing can skip it: it waits for no other job and has no condition, so
  // the tree pass marker and a docs-only change leave it running.
  assert.equal(job.needs, undefined)
  assert.equal(job.if, undefined)
  assert.equal(job.strategy, undefined)
  assert.ok(!Object.hasOwn(job, 'continue-on-error'))
  assert.equal(job.steps.length, 2)
  const [checkout, check] = job.steps
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/)
  assert.deepEqual(checkout.with, { 'persist-credentials': false, 'fetch-depth': 2 })
  assert.equal(check.run, 'node scripts/security/package-versions-applied.mjs')
  for (const step of job.steps) {
    assert.equal(step.if, undefined, step.name)
    assert.ok(!Object.hasOwn(step, 'continue-on-error'), step.name)
  }
  // Pull requests into the default branch and into release branches.
  assert.deepEqual(workflow.on.pull_request.branches, ['main', 'release/**'])
})

test('both ruleset files require the check from GitHub Actions', () => {
  for (const file of ['required-checks.json', 'required-checks-release.json']) {
    const ruleset = JSON.parse(readFileSync(join(repoRoot, '.github/rulesets', file), 'utf8'))
    const required = ruleset.rules
      .filter(rule => rule.type === 'required_status_checks')
      .flatMap(rule => rule.parameters.required_status_checks)
    assert.deepEqual(
      required.filter(check => check.context === CHECK),
      [{ context: CHECK, integration_id: 15368 }],
      file
    )
    assert.deepEqual(ruleset.bypass_actors, [], file)
  }
})
