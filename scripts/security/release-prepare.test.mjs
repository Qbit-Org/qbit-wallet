import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { VERSION_FILES } from './docs-only-change.mjs'
import {
  RELEASE_NOTES,
  ReleasePrepareError,
  pendingInWorkingTree,
  prepare,
  versionArgument,
  withNotesHeading,
  withVersion,
} from './release-prepare.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(repoRoot, 'scripts/security/release-prepare.mjs')
const [PACKAGE_JSON, MANIFEST] = VERSION_FILES

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// --- The argument -------------------------------------------------------------

test('the command takes exactly one x.y.z version', () => {
  assert.equal(versionArgument(['1.0.12']), '1.0.12')
  assert.equal(versionArgument(['--', '1.0.12']), '1.0.12')
  assert.equal(versionArgument(['0.0.0']), '0.0.0')
  assert.equal(versionArgument(['65535.65535.65535']), '65535.65535.65535')
  for (const argv of [[], ['--'], ['1.0.12', '1.0.13'], ['--', '1.0.12', 'extra']]) {
    assert.throws(() => versionArgument(argv), /^ReleasePrepareError: Usage: /, argv.join(' '))
  }
  for (const version of [
    '',
    '1.0',
    '1.0.12.1',
    'v1.0.12',
    '1.0.12-beta',
    '01.0.12',
    '1.0.012',
    '1.0.65536',
    '1.0.-1',
    '1.0.x',
    ' 1.0.12',
    '1.0.12\n',
    'Infinity',
    '1e3.0.0',
  ]) {
    assert.throws(
      () => versionArgument([version]),
      /is not a version the extension can have/,
      JSON.stringify(version)
    )
  }
})

// --- The version files --------------------------------------------------------

const MANIFEST_TEXT = [
  '{',
  '  "manifest_version": 3,',
  '  "name": "__MSG_appName__",',
  '  "version": "1.0.11",',
  '',
  '  "default_locale": "en"',
  '}',
  '',
].join('\n')

test('the version is set in place, and nothing else in the file changes', () => {
  const { text, from } = withVersion(MANIFEST_TEXT, '1.0.12', MANIFEST)
  assert.equal(from, '1.0.11')
  assert.equal(text, MANIFEST_TEXT.replace('"version": "1.0.11"', '"version": "1.0.12"'))

  // Only the top-level key, wherever another `version` at the same value is.
  const nested = [
    '{',
    '  "engines": { "version": "1.0.11" },',
    '  "version":"1.0.11",',
    '  "tool": { "version": "1.0.11" }',
    '}',
  ].join('\n')
  assert.equal(
    withVersion(nested, '2.0.0', 'x.json').text,
    nested.replace('"version":"1.0.11"', '"version":"2.0.0"')
  )

  // The same version changes nothing, so the command can be run again.
  assert.deepEqual(withVersion(MANIFEST_TEXT, '1.0.11', MANIFEST), {
    text: MANIFEST_TEXT,
    from: '1.0.11',
  })
})

test('a version file that cannot take the version is refused', () => {
  assert.throws(
    () => withVersion(MANIFEST_TEXT, '1.0.10', MANIFEST),
    /_base_v3\.json is already at 1\.0\.11, which is higher than 1\.0\.10/
  )
  assert.throws(() => withVersion(MANIFEST_TEXT, '0.9.99', MANIFEST), /which is higher than/)
  for (const [content, expected] of [
    ['{ not json', /is not JSON/],
    ['[]', /is not a JSON object/],
    ['null', /is not a JSON object/],
    ['{"name":"x"}', /has no x\.y\.z version to replace/],
    ['{"version":"latest"}', /has no x\.y\.z version to replace/],
    ['{"version":10011}', /has no x\.y\.z version to replace/],
  ]) {
    assert.throws(() => withVersion(content, '1.0.12', 'x.json'), expected, content)
  }
  // A version written in a way the text search cannot find is refused, not
  // rewritten some other way.
  assert.throws(
    () => withVersion('{"\\u0076ersion":"1.0.11"}', '1.0.12', 'x.json'),
    /its top-level version could not be set to 1\.0\.12/
  )
})

test('the repository’s own version files take a new version as a one-line change', () => {
  for (const file of VERSION_FILES) {
    const before = readFileSync(join(repoRoot, file), 'utf8')
    const current = JSON.parse(before).version
    const { text, from } = withVersion(before, '65535.0.0', file)
    assert.equal(from, current, file)
    assert.equal(JSON.parse(text).version, '65535.0.0', file)
    const changed = before.split('\n').filter((line, index) => line !== text.split('\n')[index])
    assert.equal(changed.length, 1, file)
    assert.equal(text.length - before.length, '65535.0.0'.length - current.length, file)
  }
})

// --- The release notes --------------------------------------------------------

const NOTES = ['# Release notes', '', 'Intro.', '', '## 1.0.11', '', '- A change.', ''].join('\n')

test('the release notes get the heading only when they lack it', () => {
  assert.equal(withNotesHeading(NOTES, '1.0.11'), NOTES)
  assert.equal(
    withNotesHeading(NOTES, '1.0.12'),
    ['# Release notes', '', 'Intro.', '', '## 1.0.12', '', '## 1.0.11', '', '- A change.', ''].join(
      '\n'
    )
  )
  // 1.0.1 is not 1.0.11, and a deeper heading is not the release's.
  assert.notEqual(withNotesHeading(NOTES, '1.0.1'), NOTES)
  assert.notEqual(withNotesHeading(NOTES, '1.0'), NOTES)
  // A heading that says more after the version is that release's.
  for (const heading of ['## 1.0.11 (unreleased)', '## 1.0.11 - 2026-11-20', '## 1.0.11  ']) {
    const dated = NOTES.replace('## 1.0.11', heading)
    assert.equal(withNotesHeading(dated, '1.0.11'), dated, heading)
  }
  for (const heading of ['## 1.0.110', '## 1.0.11.1', '## v1.0.11']) {
    const other = NOTES.replace('## 1.0.11', heading)
    assert.notEqual(withNotesHeading(other, '1.0.11'), other, heading)
  }
  const deeper = NOTES.replace('## 1.0.11', '## 1.0.11\n\n### 1.0.12')
  assert.match(withNotesHeading(deeper, '1.0.12'), /Intro\.\n\n## 1\.0\.12\n\n## 1\.0\.11/)
  assert.throws(
    () => withNotesHeading('# Release notes\n', '1.0.12'),
    /has no release heading to put "## 1\.0\.12" before/
  )
})

// --- The whole command --------------------------------------------------------

function workspace(t, { version = '1.0.11', notes = NOTES } = {}) {
  const root = scratch(t, 'release-prepare-')
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  write(PACKAGE_JSON, `${JSON.stringify({ name: 'qbit-extension', version }, null, 2)}\n`)
  write(MANIFEST, MANIFEST_TEXT.replace('1.0.11', version))
  write(RELEASE_NOTES, notes)
  write('.changeset/README.md', '# Changesets\n')
  write('.changeset/config.json', '{}\n')
  write('.changeset/first.md', '---\n---\n')
  write('.changeset/second.md', '---\n---\n')
  const read = file => readFileSync(join(root, file), 'utf8')
  const snapshot = () => [PACKAGE_JSON, MANIFEST, RELEASE_NOTES].map(read)
  return { root, write, read, snapshot }
}

// Stands in for `version-packages`: applies every changeset but those named.
function applyChangesets(calls, { keep = [] } = {}) {
  return root => {
    calls.push(root)
    for (const name of pendingInWorkingTree(root)) {
      if (!keep.includes(name)) rmSync(join(root, '.changeset', name), { recursive: true })
    }
    return undefined
  }
}

const quiet = { log: { log() {} } }

test('it sets both version files, adds the heading and applies the changesets', t => {
  const { root, read } = workspace(t)
  const calls = []
  const logged = []
  const result = prepare('1.0.12', {
    root,
    versionPackages: applyChangesets(calls),
    log: { log: text => logged.push(text) },
  })
  assert.deepEqual(result, { version: '1.0.12', from: ['1.0.11', '1.0.11'] })
  assert.deepEqual(calls, [root])
  assert.equal(JSON.parse(read(PACKAGE_JSON)).version, '1.0.12')
  assert.equal(read(MANIFEST), MANIFEST_TEXT.replace('1.0.11', '1.0.12'))
  assert.match(read(RELEASE_NOTES), /## 1\.0\.12\n\n## 1\.0\.11/)
  assert.deepEqual(pendingInWorkingTree(root), [])
  assert.match(logged.join('\n'), /The extension version is 1\.0\.12 \(it was 1\.0\.11\)/)
  assert.match(
    logged.join('\n'),
    /commit everything as one change\. The package release document, section 5,/
  )
})

test('running it again applies later changesets and changes nothing else', t => {
  const { root, write, snapshot } = workspace(t)
  const calls = []
  prepare('1.0.12', { root, versionPackages: applyChangesets(calls), ...quiet })
  const after = snapshot()
  write('.changeset/late.md', '---\n---\n')
  const logged = []
  prepare('1.0.12', {
    root,
    versionPackages: applyChangesets(calls),
    log: { log: text => logged.push(text) },
  })
  assert.deepEqual(snapshot(), after)
  assert.deepEqual(pendingInWorkingTree(root), [])
  assert.equal(calls.length, 2)
  assert.match(logged.join('\n'), /The extension version was already 1\.0\.12\./)
})

test('a refusal leaves every file as it was and runs nothing', t => {
  const cases = [
    // The manifest, the second file read, is ahead of the wanted version.
    [{}, w => w.write(MANIFEST, MANIFEST_TEXT.replace('1.0.11', '1.0.13')), /which is higher than/],
    [{}, w => w.write(MANIFEST, '{ not json'), /_base_v3\.json is not JSON/],
    [{ notes: '# Release notes\n' }, () => {}, /has no release heading/],
    [
      {},
      w => rmSync(join(w.root, RELEASE_NOTES)),
      /release-notes\.md could not be read \(ENOENT\)/,
    ],
    [{}, w => rmSync(join(w.root, PACKAGE_JSON)), /package\.json could not be read \(ENOENT\)/],
  ]
  for (const [options, damage, expected] of cases) {
    const w = workspace(t, options)
    damage(w)
    const before = [PACKAGE_JSON, MANIFEST, RELEASE_NOTES].map(file => {
      try {
        return w.read(file)
      } catch {
        return undefined
      }
    })
    const calls = []
    assert.throws(
      () => prepare('1.0.12', { root: w.root, versionPackages: applyChangesets(calls), ...quiet }),
      expected
    )
    assert.deepEqual(calls, [])
    assert.deepEqual(
      [PACKAGE_JSON, MANIFEST, RELEASE_NOTES].map(file => {
        try {
          return w.read(file)
        } catch {
          return undefined
        }
      }),
      before
    )
    assert.deepEqual(pendingInWorkingTree(w.root), ['first.md', 'second.md'])
  }
})

test('a failed version run writes nothing, says so, and the command can be run again', t => {
  const { root, snapshot } = workspace(t)
  const before = snapshot()
  assert.throws(
    () => prepare('1.0.12', { root, versionPackages: () => 'it exited with 1', ...quiet }),
    error =>
      error instanceof ReleasePrepareError &&
      /`corepack pnpm run version-packages` did not finish: it exited with 1\./.test(
        error.message
      ) &&
      /This run wrote nothing to the version files or the release notes/.test(error.message) &&
      /run this command again/.test(error.message)
  )
  // Nothing was written, and the second run completes.
  assert.deepEqual(snapshot(), before)
  const calls = []
  prepare('1.0.12', { root, versionPackages: applyChangesets(calls), ...quiet })
  assert.deepEqual(pendingInWorkingTree(root), [])
})

test('what the version run writes into a version file is kept', t => {
  const { root, read, write } = workspace(t)
  const calls = []
  const apply = applyChangesets(calls)
  prepare('1.0.12', {
    root,
    versionPackages: at => {
      // As changesets does when it moves a dependency range of the extension.
      const json = JSON.parse(read(PACKAGE_JSON))
      write(PACKAGE_JSON, `${JSON.stringify({ ...json, dependencies: { a: '2.0.0' } }, null, 2)}\n`)
      return apply(at)
    },
    ...quiet,
  })
  assert.deepEqual(JSON.parse(read(PACKAGE_JSON)), {
    name: 'qbit-extension',
    version: '1.0.12',
    dependencies: { a: '2.0.0' },
  })
})

test('a changeset the version run leaves behind fails the command by name', t => {
  const { root } = workspace(t)
  assert.throws(
    () =>
      prepare('1.0.12', {
        root,
        versionPackages: applyChangesets([], { keep: ['second.md'] }),
        ...quiet,
      }),
    /\.changeset\/ still holds second\.md\. A changeset that names only a package changesets ignores is never applied: delete it/
  )
})

test('no .changeset directory means nothing is pending', t => {
  assert.deepEqual(pendingInWorkingTree(scratch(t, 'release-prepare-empty-')), [])
})

// --- The entry point ----------------------------------------------------------

test('the script refuses a bad argument before it reads or runs anything', () => {
  for (const args of [[], ['1.0'], ['1.0.12', '1.0.13']]) {
    const run = spawnSync(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    })
    assert.equal(run.status, 1, args.join(' '))
    assert.match(run.stderr, /Usage: corepack pnpm release:prepare <x\.y\.z>/)
    assert.equal(run.stdout, '')
  }
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['release:prepare'], 'node scripts/security/release-prepare.mjs')
  assert.equal(
    manifest.scripts['version-packages'],
    'changeset version && pnpm install --lockfile-only'
  )
})
