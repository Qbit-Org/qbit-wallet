import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  DOCS_EXCLUDED,
  DocsOnlyConfigError,
  MAX_CHANGED_PATHS,
  classify,
  classifyPullRequest,
  isAllowlisted,
  parseNumstat,
  parseRawDiff,
  readChanges,
  runDocsOnly,
} from './docs-only-change.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(repoRoot, 'scripts/security/docs-only-change.mjs')
const FORCE_LABEL = 'ci:full-run'

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

// --- The allowlist ---------------------------------------------------------

test('the allowlist holds markdown under docs and three root documents, and nothing else', () => {
  for (const path of [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/README.md',
    'docs/privacy.md',
    'docs/ci-tree-pass-marker.md',
    'docs/api/sign-message.md',
    'docs/releases/release-notes.md',
    'docs/security/accepted-risks.md',
    'docs/new-page.v2.md',
  ]) {
    assert.equal(isAllowlisted(path), true, path)
  }
  for (const path of [
    // Read by something: pqc.yml, changesets, package publishing, the
    // dependency policy, the extension package, GitHub.
    'docs/pqc-derivation.md',
    '.changeset/some-change.md',
    '.changeset/README.md',
    'packages/contact-book/.changeset/few-chicken-tie.md',
    'packages/wallet-core/README.md',
    'packages/wallet-core/CHANGELOG.md',
    'apps/extension/README.md',
    'apps/extension/CHANGELOG.md',
    'apps/extension/LICENSE',
    'LICENSE',
    'NOTICE',
    'docs/security/dependency-audit.json',
    'docs/security/dependency-inventory.json',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/rulesets/README.md',
    // Not under docs/, or not markdown, or not a plain name.
    'tests/fixtures/release-storage/README.md',
    'experiments/pqc-wasm/README.md',
    'packages/wallet-background/INTEGRATION.md',
    'docs/diagram.svg',
    'docs/notes.txt',
    'docs/page.MD',
    'docs/page.markdown',
    'Docs/page.md',
    'docs/.hidden.md',
    'docs/.github/workflow.md',
    'docs/../package.json',
    'docs/./page.md',
    'docs//page.md',
    'docs/a page.md',
    'docs/page.md/',
    '/docs/page.md',
    'docs/page.md\n',
    'docs\\page.md',
    'docs/',
    'docs',
    'readme.md',
    'src/README.md',
    'README.md.js',
    '',
    undefined,
    null,
  ]) {
    assert.equal(isAllowlisted(path), false, JSON.stringify(path))
  }
  for (const [path, reason] of DOCS_EXCLUDED) {
    assert.match(path, /^docs\/.+\.md$/, path)
    assert.ok(reason.length > 0, path)
  }
})

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

test('every tracked file the allowlist matches is a regular text file', () => {
  const staged = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(line => /^([0-7]{6}) [0-9a-f]+ [0-3]\t(.+)$/.exec(line))
  const allowlisted = staged.filter(match => isAllowlisted(match?.[2]))
  assert.ok(allowlisted.length >= 30, `${allowlisted.length} allowlisted files`)
  for (const [, mode, path] of allowlisted) {
    assert.equal(mode, '100644', path)
    assert.ok(!readFileSync(join(repoRoot, path)).includes(0), `${path} is binary`)
  }
  for (const path of DOCS_EXCLUDED.keys()) {
    assert.ok(
      staged.some(match => match?.[2] === path),
      `${path} is excluded but not tracked`
    )
  }
})

// What a tracked file says that could name an allowlisted file. Workflows are
// read as YAML, comments left out, and split into words; other text files by
// their quoted and template strings. A string counts when it holds a `docs`
// path segment anywhere (`'docs'`, `'../../docs/x.md'`, `${root}/docs/x.md`),
// unless it names one file that the allowlist does not hold, such as
// `docs/security/dependency-audit.json`; when it ends in a root document's
// name (`'../../README.md'`); or when it names markdown in general (`'.md'`,
// `'**/*.md'`).
const DOCS_SEGMENT = /(?:^|\/)(docs(?:\/.*)?)$/
const ROOT_DOCUMENT = /(?:^|\/)(?:README|CONTRIBUTING|SECURITY)\.md$/
const ANY_MARKDOWN = /^(?:\*\*\/)?\*?\.md$/
const GLOB = /[*?[{]/

export function mentions(text, { workflow = false } = {}) {
  let strings
  if (workflow) {
    strings = []
    const visit = value => {
      if (typeof value === 'string') strings.push(...value.split(/[\s'"`()=,;|&<>]+/))
      else if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    visit(YAML.parse(text))
  } else {
    // Each string, and each word of a string that holds several, so that a
    // path inside a command (`'markdownlint docs/**/*.md'`) counts too.
    strings = [...text.matchAll(/(['"`])([^'"`\r\n]*)\1/g)].flatMap(([, , value]) => {
      const words = value.split(/[\s()=,;|&<>]+/).filter(Boolean)
      return words.length > 1 ? [value, ...words] : [value]
    })
  }
  return strings.filter(value => {
    const docs = value
      .split(/(?=\/docs(?:\/|$))/)
      .map(part => DOCS_SEGMENT.exec(part.replace(/^\.?\.?\//, ''))?.[1])
      .find(Boolean)
    if (docs !== undefined) {
      const last = docs.split('/').at(-1)
      const namesOneFile = !GLOB.test(docs) && /\.[A-Za-z0-9]+$/.test(last)
      if (!namesOneFile || isAllowlisted(docs)) return true
    }
    return ROOT_DOCUMENT.test(value) || ANY_MARKDOWN.test(value)
  })
}

// Every string mentions() finds in a tracked file outside the allowlist was
// reviewed, and none of them reads an allowlisted file. Each entry names the
// file, the string and why.
const REVIEWED_MENTIONS = [
  {
    file: /^packages\/[^/]+\/package\.json$/,
    value: 'README.md',
    reason: "the package's own README in its `files`, which the allowlist excludes",
  },
  {
    file: 'apps/extension/scripts/package-artifact-validation.test.js',
    value: 'README.md',
    reason: 'a made-up packaged entry name for the build-host path scan; the extension packs none',
  },
  {
    file: 'scripts/security/release-readiness.test.mjs',
    value: 'README.md',
    reason: 'a file it writes into a temporary fixture repository',
  },
  {
    file: 'scripts/security/dependency-evidence-artifacts.test.mjs',
    value: /^docs\/(?:security|security\/nested|missing)$/,
    reason: 'directories in a temporary root it makes',
  },
  {
    file: 'scripts/security/dependency-policy.mjs',
    value: 'docs',
    reason: "pnpm's `docs` command, in its list of pnpm commands",
  },
  {
    file: 'scripts/security/dependency-policy.mjs',
    value: '.md',
    reason:
      'its reachability guard treats markdown as never executed; it runs in `Dependency policy`',
  },
  {
    file: 'scripts/security/dependency-policy.test.mjs',
    value: /^(?:docs\/dependency-note\.md|tools\/my-action\/README\.md)$/,
    reason: 'paths in temporary fixture repositories',
  },
  {
    file: 'tests/fixtures/release-storage/capture/capture.spec.ts',
    value: /^(?:\$\{name\} is not set; see )?tests\/fixtures\/release-storage\/README\.md$/,
    reason: "an error message naming the fixture's own README, which the allowlist excludes",
  },
]

const matches = (pattern, value) =>
  typeof pattern === 'string' ? pattern === value : pattern.test(value)

test('mentions() finds the forms a reader of an allowlisted file takes', () => {
  for (const [text, found] of [
    ["new URL('../../docs/privacy.md', import.meta.url)", ['../../docs/privacy.md']],
    ['readFileSync(`${root}/docs/privacy.md`)', ['${root}/docs/privacy.md']],
    ["join(root, 'docs', 'privacy.md')", ['docs']],
    ["readdirSync(join(repoRoot, 'docs/api'))", ['docs/api']],
    ["glob('docs/**/*.md')", ['docs/**/*.md']],
    ["{ from: '../../README.md', to: 'README.md' }", ['../../README.md', 'README.md']],
    ['copy(\'CONTRIBUTING.md\'), copy("./SECURITY.md")', ['CONTRIBUTING.md', './SECURITY.md']],
    ["file.endsWith('.md') || match('**/*.md')", ['.md', '**/*.md']],
    // A path inside a command string counts by its word.
    ["execSync('markdownlint docs/**/*.md')", ['docs/**/*.md']],
    ["execSync('cat docs/privacy.md | wc -l')", ['docs/privacy.md']],
    // Files the allowlist does not hold, and words that are not paths.
    ["readFileSync('docs/security/dependency-audit.json')", []],
    ["'../docs/pqc-derivation.md'", []],
    ["'documentation', 'mydocs/x.md', 'docs-only', 'README.txt', 'NOT-README.md.js'", []],
  ]) {
    assert.deepEqual(mentions(text), found, text)
  }
  assert.deepEqual(
    mentions('on:\n  pull_request:\n    paths: [docs/**]\n# docs/privacy.md\n', { workflow: true }),
    ['docs/**']
  )
  assert.deepEqual(
    mentions('jobs:\n  a:\n    steps:\n      - run: cat ./docs/privacy.md README.md\n', {
      workflow: true,
    }),
    ['./docs/privacy.md', 'README.md']
  )
})

// A tripwire for the judgment the allowlist records: a file outside it that
// starts naming the docs directory, an allowlisted file, a root document or
// markdown in general may have started reading them, and must be reviewed. A
// reader that walks every tracked file names none of them: that is why the
// lane that runs the security tooling tests never skips on a docs-only change.
test('no tracked file outside the allowlist names the docs directory or an allowlisted file', () => {
  const ownFiles = [
    'scripts/security/docs-only-change.mjs',
    'scripts/security/docs-only-change.test.mjs',
  ]
  const found = []
  for (const file of trackedFiles()) {
    if (file.endsWith('.md') || ownFiles.includes(file)) continue
    const bytes = readFileSync(join(repoRoot, file))
    if (bytes.subarray(0, 8000).includes(0)) continue
    const workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)
    for (const value of mentions(bytes.toString('utf8'), { workflow })) found.push({ file, value })
  }
  const unreviewed = found.filter(
    mention =>
      !REVIEWED_MENTIONS.some(
        entry => matches(entry.file, mention.file) && matches(entry.value, mention.value)
      )
  )
  assert.deepEqual(
    unreviewed.map(({ file, value }) => `${file}: ${JSON.stringify(value)}`),
    [],
    'review each reader; take what it reads out of the allowlist in docs-only-change.mjs and docs/ci-docs-only.md, or add it to REVIEWED_MENTIONS with the reason'
  )
  for (const entry of REVIEWED_MENTIONS) {
    assert.ok(entry.reason.length > 0, String(entry.file))
    assert.ok(
      found.some(
        mention => matches(entry.file, mention.file) && matches(entry.value, mention.value)
      ),
      `${entry.file} ${entry.value} no longer needs a review`
    )
  }
})

// --- Reading git's listings --------------------------------------------------

const ID_A = 'a'.repeat(40)
const ID_B = 'b'.repeat(40)

test("git's listings are read exactly, and anything else throws", () => {
  assert.deepEqual(parseRawDiff(''), [])
  assert.deepEqual(
    parseRawDiff(
      `:100644 100644 ${ID_A} ${ID_B} M\0docs/a.md\0` +
        `:000000 100644 ${'0'.repeat(40)} ${ID_B} A\0docs/tab\there.md\0` +
        `:100644 100644 ${ID_A} ${ID_A} R100\0docs/old.md\0docs/new.md\0` +
        `:100644 100644 ${ID_A} ${ID_B} C075\0docs/a.md\0docs/c.md\0`
    ),
    [
      { oldMode: '100644', newMode: '100644', status: 'M', paths: ['docs/a.md'] },
      { oldMode: '000000', newMode: '100644', status: 'A', paths: ['docs/tab\there.md'] },
      { oldMode: '100644', newMode: '100644', status: 'R', paths: ['docs/old.md', 'docs/new.md'] },
      { oldMode: '100644', newMode: '100644', status: 'C', paths: ['docs/a.md', 'docs/c.md'] },
    ]
  )
  for (const output of [
    undefined,
    `:100644 100644 ${ID_A} ${ID_B} M\0docs/a.md`,
    `:100644 100644 ${ID_A} ${ID_B} M\0`,
    `:100644 100644 ${ID_A} ${ID_B} M\0\0`,
    `:100644 100644 aaaaaaa bbbbbbb M\0docs/a.md\0`,
    `:100644 100644 ${ID_A} ${ID_B} m\0docs/a.md\0`,
    `:100644 ${ID_A} ${ID_B} M\0docs/a.md\0`,
    `:100644 100644 ${ID_A} ${ID_B} R100\0docs/old.md\0`,
    `100644 100644 ${ID_A} ${ID_B} M\0docs/a.md\0`,
    'docs/a.md\0',
    '\0',
  ]) {
    assert.throws(() => parseRawDiff(output), /git diff --raw|malformed/, JSON.stringify(output))
  }

  assert.deepEqual(parseNumstat(''), [])
  assert.deepEqual(parseNumstat('3\t1\tdocs/a.md\0-\t-\tdocs/b.md\0'), [
    { binary: false, path: 'docs/a.md' },
    { binary: true, path: 'docs/b.md' },
  ])
  for (const output of [undefined, '3\t1\tdocs/a.md', '3\t1\t\0', 'x\t1\tdocs/a.md\0', '\0']) {
    assert.throws(
      () => parseNumstat(output),
      /git diff --numstat|malformed/,
      JSON.stringify(output)
    )
  }
})

test('the verdict needs added or modified regular text files in the allowlist, and some', () => {
  const entry = (path, status = 'M', oldMode = '100644', newMode = '100644') => ({
    oldMode,
    newMode,
    status,
    paths: [path],
  })
  const text = path => ({ binary: false, path })
  assert.deepEqual(
    classify({
      entries: [entry('docs/a.md'), entry('README.md', 'A', '000000')],
      numstat: [text('README.md'), text('docs/a.md')],
    }),
    {
      docsOnly: true,
      reason: '2 files changed, all documentation that no skipped step reads',
      paths: ['docs/a.md', 'README.md'],
    }
  )
  for (const [changes, reason] of [
    [{ entries: [], numstat: [] }, /changes no file/],
    [{ entries: undefined, numstat: [] }, /could not be read/],
    [{ entries: [entry('src/a.ts')], numstat: [text('src/a.ts')] }, /not in the docs-only/],
    [{ entries: [entry('docs/a.md', 'D')], numstat: [text('docs/a.md')] }, /was deleted/],
    [{ entries: [entry('docs/a.md', 'T')], numstat: [text('docs/a.md')] }, /changed type/],
    [{ entries: [entry('docs/a.md', 'U')], numstat: [text('docs/a.md')] }, /is unmerged/],
    [{ entries: [entry('docs/a.md', 'X')], numstat: [text('docs/a.md')] }, /git does not know/],
    [{ entries: [entry('docs/a.md', 'Z')], numstat: [text('docs/a.md')] }, /status Z/],
    [
      { entries: [{ ...entry('docs/b.md', 'R'), paths: ['docs/a.md', 'docs/b.md'] }], numstat: [] },
      /docs\/b\.md was renamed from docs\/a\.md/,
    ],
    [
      { entries: [{ ...entry('docs/b.md', 'C'), paths: ['docs/a.md', 'docs/b.md'] }], numstat: [] },
      /docs\/b\.md was copied from docs\/a\.md/,
    ],
    [
      { entries: [entry('docs/a.md', 'M', '100644', '100755')], numstat: [text('docs/a.md')] },
      /mode 100644 to 100755/,
    ],
    [
      { entries: [entry('docs/a.md', 'A', '100644')], numstat: [text('docs/a.md')] },
      /mode 100644 to 100644/,
    ],
    [
      { entries: [entry('docs/a.md', 'A', '000000', '120000')], numstat: [text('docs/a.md')] },
      /mode 000000 to 120000/,
    ],
    [
      { entries: [entry('docs/a.md', 'A', '000000', '160000')], numstat: [text('docs/a.md')] },
      /mode 000000 to 160000/,
    ],
    [{ entries: [entry('docs/a.md')], numstat: [] }, /different files/],
    [{ entries: [entry('docs/a.md')], numstat: [text('docs/b.md')] }, /different files/],
    [
      {
        entries: [entry('docs/a.md'), entry('docs/a.md')],
        numstat: [text('docs/a.md'), text('docs/a.md')],
      },
      /different files/,
    ],
    [
      { entries: [entry('docs/a.md')], numstat: [{ binary: true, path: 'docs/a.md' }] },
      /docs\/a\.md is binary/,
    ],
  ]) {
    const verdict = classify(changes)
    assert.equal(verdict.docsOnly, false, JSON.stringify(changes))
    assert.match(verdict.reason, reason, JSON.stringify(changes))
  }
})

// --- Real pull requests ------------------------------------------------------

// A throwaway repository. Its git commands read no user or system
// configuration, so they behave the same on every machine.
function gitFixture(t) {
  const dir = scratch(t, 'docs-only-git-')
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Docs Only Test',
    GIT_AUTHOR_EMAIL: 'docs-only@example.invalid',
    GIT_COMMITTER_NAME: 'Docs Only Test',
    GIT_COMMITTER_EMAIL: 'docs-only@example.invalid',
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
  const commit = (message, { add = true } = {}) => {
    if (add) git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  return { dir, git, write, commit }
}

const BASE_FILES = {
  'README.md': '# Project\n',
  'docs/a.md': '# A\n\nThe first page, with enough text to compare.\n',
  'docs/b.md': '# B\n',
  'docs/pqc-derivation.md': '# Derivation\n',
  'src/index.js': 'export const answer = 42\n',
}

// A head on a branch that `change` makes, a base that moved on since with a
// change of its own to code, and GitHub's merge of the head into the base.
function pullRequest(t, change, { add = true } = {}) {
  const repo = gitFixture(t)
  for (const [file, content] of Object.entries(BASE_FILES)) repo.write(file, content)
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  change(repo)
  const head = repo.commit('change', { add })
  repo.git('checkout', '-q', 'main')
  repo.write('src/later.js', 'export const later = true\n')
  const base = repo.commit('base moves')
  repo.git('checkout', '-q', '--detach', base)
  repo.git('merge', '-q', '--no-ff', '--no-edit', head)
  const merge = repo.git('rev-parse', 'HEAD')
  return { ...repo, base, head, merge }
}

function verdictOf(pr) {
  return classify(readChanges({ mergeSha: pr.merge, headSha: pr.head, cwd: pr.dir }))
}

test('a pull request that changes only allowlisted documentation is docs-only', t => {
  const pr = pullRequest(t, repo => {
    repo.write('docs/a.md', '# A\n\nThe first page, corrected.\n')
    repo.write('docs/api/new-page.md', '# New\n')
    repo.write('README.md', '# Project\n\nMore.\n')
  })
  const changes = readChanges({ mergeSha: pr.merge, headSha: pr.head, cwd: pr.dir })
  // Against the base it merged into, so the base's own change is not counted.
  assert.equal(changes.base, pr.base)
  const verdict = classify(changes)
  assert.equal(verdict.docsOnly, true, verdict.reason)
  assert.deepEqual([...verdict.paths].sort(), ['README.md', 'docs/a.md', 'docs/api/new-page.md'])
})

test('code, a mixed change, an excluded document and an empty change run in full', t => {
  for (const [label, change, reason] of [
    [
      'code',
      repo => repo.write('src/index.js', 'export const answer = 43\n'),
      /src\/index\.js is not/,
    ],
    [
      'mixed',
      repo => {
        repo.write('docs/a.md', '# A, changed\n')
        repo.write('src/index.js', 'export const answer = 43\n')
      },
      /src\/index\.js is not/,
    ],
    [
      'a changeset',
      repo => repo.write('.changeset/fix.md', "---\n'pkg': patch\n---\n\nFix.\n"),
      /\.changeset\/fix\.md is not/,
    ],
    [
      'an excluded document',
      repo => repo.write('docs/pqc-derivation.md', '# Derivation, changed\n'),
      /docs\/pqc-derivation\.md is not/,
    ],
    ['an empty change', () => {}, /changes no file against its base/],
  ]) {
    const verdict = verdictOf(pullRequest(t, change))
    assert.equal(verdict.docsOnly, false, label)
    assert.match(verdict.reason, reason, label)
  }
})

test('renames, copies, deletions, mode changes, symlinks, submodules and binary files run in full', t => {
  for (const [label, change, reason, options] of [
    [
      'a rename',
      repo => repo.git('mv', 'docs/a.md', 'docs/c.md'),
      /docs\/c\.md was renamed from docs\/a\.md/,
    ],
    [
      'a copy',
      repo => {
        repo.write('docs/copy.md', BASE_FILES['docs/a.md'])
        repo.write('docs/a.md', `${BASE_FILES['docs/a.md']}More.\n`)
      },
      /docs\/copy\.md was copied from docs\/a\.md/,
    ],
    ['a deletion', repo => repo.git('rm', '-q', 'docs/b.md'), /docs\/b\.md was deleted/],
    [
      'an executable file',
      repo => chmodSync(join(repo.dir, 'docs/b.md'), 0o755),
      /docs\/b\.md has mode 100644 to 100755/,
    ],
    [
      'a symlink',
      repo => symlinkSync('a.md', join(repo.dir, 'docs/link.md')),
      /docs\/link\.md has mode 000000 to 120000/,
    ],
    [
      'a file that becomes a symlink',
      repo => {
        rmSync(join(repo.dir, 'docs/b.md'))
        symlinkSync('a.md', join(repo.dir, 'docs/b.md'))
      },
      /docs\/b\.md changed type/,
    ],
    [
      'a submodule',
      repo =>
        repo.git(
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${repo.git('rev-parse', 'HEAD')},docs/module.md`
        ),
      /docs\/module\.md has mode 000000 to 160000/,
      { add: false },
    ],
    [
      'a binary file',
      repo => repo.write('docs/blob.md', Buffer.from([0x23, 0x00, 0x01, 0x02, 0x0a])),
      /docs\/blob\.md is binary/,
    ],
  ]) {
    const verdict = verdictOf(pullRequest(t, change, options))
    assert.equal(verdict.docsOnly, false, label)
    assert.match(verdict.reason, reason, label)
  }
})

test('at most MAX_CHANGED_PATHS files make a docs-only change', t => {
  const write = count => repo => {
    for (let index = 0; index < count; index += 1) repo.write(`docs/many/${index}.md`, `${index}\n`)
  }
  assert.equal(verdictOf(pullRequest(t, write(MAX_CHANGED_PATHS))).docsOnly, true)
  const over = verdictOf(pullRequest(t, write(MAX_CHANGED_PATHS + 1)))
  assert.equal(over.docsOnly, false)
  assert.match(over.reason, new RegExp(`${MAX_CHANGED_PATHS + 1} files changed, more than`))
})

test('the commit under test must be a merge of the head into a base', t => {
  const pr = pullRequest(t, repo => repo.write('docs/a.md', '# A, changed\n'))
  // The head itself, the base given as the head, and a commit git does not have.
  for (const [mergeSha, headSha] of [
    [pr.head, pr.head],
    [pr.merge, pr.base],
    [pr.base, pr.head],
    ['c'.repeat(40), pr.head],
  ]) {
    assert.throws(() => readChanges({ mergeSha, headSha, cwd: pr.dir }), Error)
  }
  for (const [mergeSha, headSha] of [
    [undefined, pr.head],
    [pr.merge, ''],
    [pr.merge.slice(0, 12), pr.head],
    [pr.merge.toUpperCase(), pr.head],
    [`--output=${pr.merge}`, pr.head],
  ]) {
    assert.throws(
      () => readChanges({ mergeSha, headSha, cwd: pr.dir }),
      DocsOnlyConfigError,
      JSON.stringify([mergeSha, headSha])
    )
  }
  // The checkout must hold the merge's parents: a clone of the merge alone
  // cannot be read, and runs in full. Two levels, as the workflows fetch,
  // can.
  pr.git('branch', 'merged', pr.merge)
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
  for (const depth of ['1', '2']) {
    const clone = scratch(t, `docs-only-depth-${depth}-`)
    execFileSync(
      'git',
      ['clone', '-q', '--depth', depth, '--branch', 'merged', `file://${pr.dir}`, clone],
      { env: gitEnv }
    )
    const read = () => readChanges({ mergeSha: pr.merge, headSha: pr.head, cwd: clone })
    if (depth === '1') assert.throws(read, /is not a merge of the pull request head/)
    else assert.equal(classify(read()).docsOnly, true)
  }
})

// --- The step --------------------------------------------------------------

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  }
}

const labelsFetch = names => async url => {
  assert.equal(url, 'https://api.github.com/repos/Qbit-Org/qbit-wallet/pulls/42')
  return fakeResponse(200, { labels: names.map(name => ({ name })) })
}

function stepEnvironment(pr, temp, extra = {}) {
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_REPOSITORY: 'Qbit-Org/qbit-wallet',
    GH_TOKEN: 'token',
    TREE_PASS_PR_NUMBER: '42',
    TREE_PASS_FORCE_LABEL: FORCE_LABEL,
    GITHUB_SHA: pr.merge,
    TREE_PASS_HEAD_SHA: pr.head,
    GITHUB_OUTPUT: join(temp, 'output'),
    GITHUB_STEP_SUMMARY: join(temp, 'summary'),
    ...extra,
  }
}

const quiet = { log() {} }

test('the step says docs-only only for a labelled-off pull request it could read in full', async t => {
  const pr = pullRequest(t, repo => repo.write('docs/a.md', '# A, changed\n'))
  const code = pullRequest(t, repo => repo.write('src/index.js', 'export const answer = 43\n'))
  let index = 0
  const run = async (target, extra, fetchImpl) => {
    const temp = scratch(t, `docs-only-step-${(index += 1)}-`)
    const env = stepEnvironment(target, temp, extra)
    const lines = []
    const verdict = await runDocsOnly(env, {
      cwd: target.dir,
      fetchImpl,
      log: { log: line => lines.push(line) },
    })
    return {
      verdict,
      outputs: outputs(env.GITHUB_OUTPUT),
      summary: existsSync(env.GITHUB_STEP_SUMMARY)
        ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
        : '',
      lines,
    }
  }

  const docs = await run(pr, {}, labelsFetch(['documentation']))
  assert.deepEqual(docs.outputs, { 'docs-only': 'true' })
  assert.match(
    docs.summary,
    /Docs-only: yes, the steps that read no documentation are skipped \(1 file changed/
  )
  assert.match(docs.summary, /`docs\/a\.md`/)
  assert.match(docs.summary, /Add the `ci:full-run` label and re-run all jobs to run everything\./)
  assert.match(docs.lines.join('\n'), /^::notice title=Docs-only change::Docs-only change/m)

  for (const [label, target, extra, fetchImpl, reason] of [
    ['code', code, {}, labelsFetch([]), /src\/index\.js is not in the docs-only allowlist/],
    ['the label', pr, {}, labelsFetch(['CI:Full-Run']), /the ci:full-run label forces a full run/],
    [
      'another force label',
      pr,
      { TREE_PASS_FORCE_LABEL: 'run everything' },
      labelsFetch(['run everything']),
      /the run everything label forces a full run/,
    ],
    ['a push', pr, { GITHUB_EVENT_NAME: 'push' }, undefined, /push event always runs in full/],
    [
      'a dispatch',
      pr,
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
      undefined,
      /workflow_dispatch event always runs in full/,
    ],
    ['no event', pr, { GITHUB_EVENT_NAME: '' }, undefined, /an unknown event always runs in full/],
    [
      'an API error',
      pr,
      {},
      async () => fakeResponse(502, {}),
      /labels could not be read \(GET .* returned HTTP 502\)/,
    ],
    [
      'unreadable labels',
      pr,
      {},
      async () => fakeResponse(200, { labels: [{ name: '' }] }),
      /labels could not be read/,
    ],
    [
      'a network failure',
      pr,
      {},
      async () => {
        throw new Error('connection reset')
      },
      /labels could not be read \(connection reset\)/,
    ],
    [
      'not the merge of the head',
      pr,
      { TREE_PASS_HEAD_SHA: pr.base },
      labelsFetch([]),
      /the changed files could not be read \(.* is not a merge of the pull request head/,
    ],
    [
      'a commit git does not have',
      pr,
      { GITHUB_SHA: 'c'.repeat(40) },
      labelsFetch([]),
      /the changed files could not be read/,
    ],
  ]) {
    const result = await run(target, extra, fetchImpl)
    assert.deepEqual(result.outputs, { 'docs-only': 'false' }, label)
    assert.equal(result.verdict.docsOnly, false, label)
    assert.match(result.verdict.reason, reason, label)
    assert.match(result.summary, /- Docs-only: no \(/, label)
    assert.doesNotMatch(result.summary, /re-run all jobs/, label)
    // Every line of the summary is a heading, a list entry or blank: a reason
    // that spans lines, as git's errors do, is put on one.
    for (const line of result.summary.split('\n')) {
      assert.match(line, /^(?:###? .+| {0,2}- .+|)$/, `${label}: ${JSON.stringify(line)}`)
    }
    if (label === 'a commit git does not have') {
      assert.match(result.verdict.reason, /\n/, 'git gave a reason over several lines')
      assert.match(
        result.summary,
        /- Docs-only: no \(the changed files could not be read \(Command failed: git rev-list .*fatal: .*\)\)\n/
      )
    }
    assert.match(
      result.lines.join('\n'),
      /^::notice title=Docs-only change::Not a docs-only change, so every step runs: /m,
      label
    )
  }

  // A push reads no labels and no git.
  const push = await classifyPullRequest(
    { GITHUB_EVENT_NAME: 'push' },
    {
      cwd: devNull,
      fetchImpl: () => assert.fail('no request'),
    }
  )
  assert.equal(push.docsOnly, false)

  // Wiring errors fail the step, which then fails `Tree pass marker`, and
  // every job runs in full. That includes the settings the label read needs,
  // which the marker script reports as its own configuration errors.
  for (const extra of [
    { TREE_PASS_FORCE_LABEL: '' },
    { TREE_PASS_FORCE_LABEL: undefined },
    { TREE_PASS_FORCE_LABEL: 'a,b' },
    { GITHUB_OUTPUT: '' },
    { GITHUB_SHA: '' },
    { TREE_PASS_HEAD_SHA: undefined },
    { GH_TOKEN: '' },
    { TREE_PASS_PR_NUMBER: '0' },
    { TREE_PASS_PR_NUMBER: undefined },
    { GITHUB_REPOSITORY: '' },
    { GITHUB_REPOSITORY: 'no-slash' },
    { GITHUB_API_URL: 'http://api.github.com' },
  ]) {
    const temp = scratch(t, 'docs-only-config-')
    await assert.rejects(
      runDocsOnly(stepEnvironment(pr, temp, extra), {
        cwd: pr.dir,
        fetchImpl: labelsFetch([]),
        log: quiet,
      }),
      DocsOnlyConfigError,
      JSON.stringify(extra)
    )
  }
})

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  })
}

test('the command line writes docs-only and fails closed', t => {
  const pr = pullRequest(t, repo => repo.write('docs/a.md', '# A, changed\n'))
  const temp = scratch(t, 'docs-only-cli-')
  const env = stepEnvironment(pr, temp)

  // A push never reads anything.
  let result = cli([], { ...env, GITHUB_EVENT_NAME: 'push' }, pr.dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(outputs(env.GITHUB_OUTPUT), { 'docs-only': 'false' })

  // An API that cannot be reached runs in full, and the step stays green.
  rmSync(env.GITHUB_OUTPUT)
  result = cli([], { ...env, GITHUB_API_URL: 'https://127.0.0.1:9' }, pr.dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(outputs(env.GITHUB_OUTPUT), { 'docs-only': 'false' })
  assert.match(result.stdout, /^::notice title=Docs-only change::Not a docs-only change/m)

  for (const [args, extra] of [
    [['extra'], {}],
    [[], { GITHUB_OUTPUT: '' }],
    [[], { TREE_PASS_FORCE_LABEL: '' }],
  ]) {
    result = cli(args, { ...env, ...extra }, pr.dir)
    assert.equal(result.status, 1, JSON.stringify([args, extra]))
    assert.match(result.stdout, /^::error title=Docs-only change::/m)
  }
})

// The step runs on the runner image's Node, without setup-node or an install,
// like the marker script it imports.
test('the script loads only Node built-in modules and the marker script', () => {
  const source = readFileSync(script, 'utf8')
  const specifiers = [
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
  ].map(([, specifier]) => specifier)
  assert.ok(specifiers.length >= 5, specifiers.join(', '))
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:[a-z_/]+|\.\/tree-pass-marker\.mjs)$/, specifier)
  }
})
