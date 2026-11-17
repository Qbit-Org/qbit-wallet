// CI runs the adversarial suite's test files only through each package's own
// `test` script, not through run-adversarial-tests.sh: ci.yml's lanes run
// qbit-extension's and @qbit/wallet-background's each in a lane of its own,
// and every other package's under `pnpm -r test` in verify-workspace. These
// tests fail if a file the script runs would not run there: the file is
// missing, or the package's test script would not pick it up. They also fail
// unless the lanes run every package's test script exactly once. What counts as
// picked up is what the tools report, not a copy of their rules: pnpm resolves
// the script's `--filter`, vitest lists the files its config collects, and the
// shell expands the `node --test` arguments as it does when pnpm runs the
// test script.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RUN_SCRIPT = 'scripts/security/run-adversarial-tests.sh'

// Each runner's command, as the run script and a package's test script both
// spell it.
const RUNNER_COMMANDS = { vitest: ['vitest', 'run'], node: ['node', '--test'] }
// The run script's other commands, which ci.yml's verify-workspace lane runs
// itself.
const OTHER_COMMANDS = new Set([
  'corepack pnpm run test:security-tooling',
  'corepack pnpm run sdk:packages:check',
])
const SUITE_LINE = /^corepack pnpm --filter (\S+) exec (.+)$/
// A test file the run script names: a plain relative path that no shell
// expands.
const LISTED_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/
// The words a package test script may use. Anything else (quotes, pipes, `;`,
// `||`, substitutions) is a shell form this check does not read, so it fails.
const SCRIPT_WORD = /^[\w./*@:=-]+$/

// The suites the run script runs, as { runner, filter, files }. Every line
// must be a suite, one of OTHER_COMMANDS, a comment or the preamble, so a
// command this check cannot read fails it instead of passing unchecked.
export function parseRunScript(text) {
  const suites = []
  for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ')
    if (line === '' || line.startsWith('#') || line === 'set -euo pipefail') continue
    if (OTHER_COMMANDS.has(line)) continue
    const match = SUITE_LINE.exec(line)
    const words = match?.[2].split(' ') ?? []
    const runner = Object.keys(RUNNER_COMMANDS).find(name =>
      RUNNER_COMMANDS[name].every((word, index) => words[index] === word)
    )
    const files = words.slice(2)
    if (!runner || files.length === 0 || !files.every(file => LISTED_FILE.test(file))) {
      throw new Error(`${RUN_SCRIPT}: cannot read \`${line}\``)
    }
    suites.push({ runner, filter: match[1], files })
  }
  if (suites.length === 0) throw new Error(`${RUN_SCRIPT}: no test suites found`)
  return suites
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} in ${cwd} exited ${result.status}:\n${result.stderr}`
    )
  }
  return result.stdout
}

// The one workspace package a `--filter` selects, which is where `pnpm exec`
// runs the suite.
function filteredPackage(filter, root) {
  const projects = JSON.parse(
    run('corepack', ['pnpm', '--filter', filter, 'ls', '--depth', '-1', '--json'], root)
  )
  if (projects.length !== 1) {
    throw new Error(`--filter ${filter} selects ${projects.length} packages, not one`)
  }
  return { name: projects[0].name, dir: projects[0].path }
}

// The arguments after the runner's command in a package's test script, or
// null when the script does not run it.
function testScriptArguments(script, runner) {
  const [program, mode] = RUNNER_COMMANDS[runner]
  for (const segment of script.split('&&')) {
    const words = segment.trim().split(/\s+/)
    if (!words.every(word => SCRIPT_WORD.test(word))) {
      throw new Error(`test script \`${script}\` is not a plain && chain of commands`)
    }
    if (words[0] === program && words[1] === mode) return words.slice(2)
  }
  return null
}

// The files vitest collects with the test script's own arguments.
function vitestFiles(packageDir, args) {
  const scratch = mkdtempSync(join(tmpdir(), 'adversarial-tests-'))
  try {
    const out = join(scratch, 'files.json')
    run(
      'corepack',
      ['pnpm', 'exec', 'vitest', 'list', '--filesOnly', `--json=${out}`, ...args],
      packageDir
    )
    return JSON.parse(readFileSync(out, 'utf8')).map(entry => entry.file)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// The files the shell hands `node --test`: its arguments, unquoted, so the
// shell splits and expands them as it does the test script. A directory or a
// pattern that matches nothing is not expanded here, so its files count as
// not run.
function nodeTestFiles(packageDir, args) {
  const paths = args.filter(word => !word.startsWith('-'))
  if (paths.length === 0) return []
  return run('sh', ['-c', 'printf "%s\\n" $@', 'sh', ...paths], packageDir)
    .split('\n')
    .filter(Boolean)
}

const included = new Map()

function includedFiles(packageDir, runner, args) {
  const key = `${packageDir}\0${runner}\0${args.join(' ')}`
  if (!included.has(key)) {
    const files =
      runner === 'vitest' ? vitestFiles(packageDir, args) : nodeTestFiles(packageDir, args)
    included.set(
      key,
      new Set(
        files
          .map(file => resolve(packageDir, file))
          .filter(file => existsSync(file) && statSync(file).isFile())
          .map(file => realpathSync(file))
      )
    )
  }
  return included.get(key)
}

// Every reason a suite's file would not run under its package's test script.
export function checkSuites(suites, root = repoRoot) {
  const problems = []
  for (const { runner, filter, files } of suites) {
    const { name, dir } = filteredPackage(filter, root)
    const script = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.test
    const args = typeof script === 'string' ? testScriptArguments(script, runner) : null
    if (args === null) {
      problems.push(`${name}'s test script does not run \`${RUNNER_COMMANDS[runner].join(' ')}\``)
      continue
    }
    const runs = includedFiles(dir, runner, args)
    for (const file of files) {
      const path = resolve(dir, file)
      if (!existsSync(path) || !statSync(path).isFile()) {
        problems.push(`${name}: ${file} does not exist`)
      } else if (!runs.has(realpathSync(path))) {
        problems.push(`${name}: ${file} is not run by its test script \`${script}\``)
      }
    }
  }
  return problems
}

test('every test file the adversarial run script names runs under its package test script', () => {
  const suites = parseRunScript(readFileSync(join(repoRoot, RUN_SCRIPT), 'utf8'))
  assert.deepEqual(checkSuites(suites), [])
})

test('a run script this check cannot read is rejected', () => {
  const suite =
    'corepack pnpm --filter @qbit/keyring-service exec vitest run \\\n  test/boot.test.ts'
  assert.deepEqual(parseRunScript(`#!/usr/bin/env bash\nset -euo pipefail\n\n${suite}\n`), [
    { runner: 'vitest', filter: '@qbit/keyring-service', files: ['test/boot.test.ts'] },
  ])
  for (const text of [
    '',
    '#!/usr/bin/env bash\nset -euo pipefail\ncorepack pnpm run test:security-tooling\n',
    `${suite}\ncorepack pnpm run test:other\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension test\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension exec jest src/a.test.ts\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension exec vitest run\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension exec vitest run --reporter=dot src/a.test.ts\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension exec vitest run "$files"\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension exec node --test scripts/*.test.js\n`,
    `${suite}\ncorepack pnpm --filter qbit-extension exec node --test ../a.test.js\n`,
    `${suite}\nfor file in a b; do echo "$file"; done\n`,
  ]) {
    assert.throws(() => parseRunScript(text), new RegExp(RUN_SCRIPT), text)
  }
})

test('a missing file, or one its package test script does not pick up, is reported', () => {
  const problems = checkSuites([
    {
      runner: 'vitest',
      filter: '@qbit/keyring-service',
      // Missing, and outside the vitest include.
      files: ['test/no-such-file.test.ts', 'vitest.config.ts'],
    },
    {
      runner: 'node',
      filter: 'qbit-extension',
      // Missing, and outside the `node --test` glob.
      files: ['scripts/no-such-file.test.js', 'package.json'],
    },
    // A package whose test script does not run this runner.
    { runner: 'node', filter: '@qbit/keyring-service', files: ['package.json'] },
  ])
  assert.deepEqual(problems, [
    '@qbit/keyring-service: test/no-such-file.test.ts does not exist',
    '@qbit/keyring-service: vitest.config.ts is not run by its test script `vitest run`',
    'qbit-extension: scripts/no-such-file.test.js does not exist',
    'qbit-extension: package.json is not run by its test script `node --test ./scripts/*.test.js && vitest run --config vitest.config.ts`',
    "@qbit/keyring-service's test script does not run `node --test`",
  ])
  assert.throws(
    () => checkSuites([{ runner: 'vitest', filter: 'no-such-package', files: ['a.test.ts'] }]),
    /selects 0 packages/
  )
})

// --- The lanes that run the packages' test scripts ---------------------------

const CI_WORKFLOW = '.github/workflows/ci.yml'
// The lanes of `Typecheck, test, and build` that each run one package's test
// script alone, and the lane that runs every other package's.
export const PACKAGE_LANES = {
  'verify-extension-tests': 'qbit-extension',
  'verify-wallet-background-tests': '@qbit/wallet-background',
}
const OTHER_PACKAGES_LANE = 'verify-workspace'
// A command that runs workspace packages' `test` scripts: `pnpm … test` or
// `pnpm … run test`, not a root script such as `test:security-tooling`.
const PACKAGE_TEST_COMMAND = /^corepack pnpm\b.*\s(?:run\s+)?test$/
const OTHER_PACKAGES_COMMAND = /^corepack pnpm -r --if-present((?: --filter '[^' ]+')+) test$/

function commandLines(job) {
  return (job?.steps ?? []).flatMap(step =>
    String(step.run ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => PACKAGE_TEST_COMMAND.test(line))
  )
}

// The workspace packages `pnpm -r` would run a command in, with these
// filters, by name: what pnpm itself selects, workspace root excluded as
// `pnpm -r run` excludes it.
function recursivePackages(filters, root) {
  return run(
    'corepack',
    ['pnpm', '-r', ...filters.flatMap(filter => ['--filter', filter]), 'exec', 'pwd'],
    root
  )
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('/') && existsSync(join(line, 'package.json')))
    .map(dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
}

const hasTest = manifest => typeof manifest.scripts?.test === 'string'

// Every reason ci.yml's lanes would not run each workspace package's test
// script exactly once.
export function laneProblems(jobs, root = repoRoot) {
  const problems = []
  const runs = []
  for (const [lane, name] of Object.entries(PACKAGE_LANES)) {
    const wanted = `corepack pnpm --filter ${name} run test`
    const lines = commandLines(jobs[lane])
    if (lines.length !== 1 || lines[0] !== wanted) {
      problems.push(`${lane} must run exactly \`${wanted}\`, found ${JSON.stringify(lines)}`)
      continue
    }
    const selected = filteredPackage(name, root)
    const manifest = JSON.parse(readFileSync(join(selected.dir, 'package.json'), 'utf8'))
    if (!hasTest(manifest)) problems.push(`${name} has no test script for ${lane} to run`)
    else runs.push(name)
  }
  const lines = commandLines(jobs[OTHER_PACKAGES_LANE])
  const match = lines.length === 1 ? OTHER_PACKAGES_COMMAND.exec(lines[0]) : null
  if (!match) {
    problems.push(
      `${OTHER_PACKAGES_LANE} must run one \`corepack pnpm -r --if-present --filter '!…' … test\`, found ${JSON.stringify(lines)}`
    )
  } else {
    const filters = [...match[1].matchAll(/--filter '([^']+)'/g)].map(([, filter]) => filter)
    const excluded = filters.map(filter => filter.replace(/^!/, ''))
    const wanted = Object.values(PACKAGE_LANES)
    if (
      !filters.every(filter => filter.startsWith('!')) ||
      [...excluded].sort().join(' ') !== [...wanted].sort().join(' ')
    ) {
      problems.push(
        `${OTHER_PACKAGES_LANE} must exclude exactly ${wanted.join(' and ')}, found ${filters.join(', ')}`
      )
    }
    runs.push(
      ...recursivePackages(filters, root)
        .filter(hasTest)
        .map(manifest => manifest.name)
    )
  }
  // Each lane that feeds the required check, and no other job, runs package
  // tests; together they run every package with a test script once.
  for (const [name, job] of Object.entries(jobs)) {
    if (name in PACKAGE_LANES || name === OTHER_PACKAGES_LANE) continue
    const extra = commandLines(job)
    if (extra.length > 0) problems.push(`${name} also runs package tests: ${extra.join('; ')}`)
  }
  const all = recursivePackages([], root)
    .filter(hasTest)
    .map(manifest => manifest.name)
  for (const name of new Set([...all, ...runs])) {
    const times = runs.filter(entry => entry === name).length
    if (times !== 1)
      problems.push(`${name}'s test script runs ${times} times in the lanes, not once`)
  }
  return problems
}

test("ci.yml's lanes run every workspace package's test script exactly once", () => {
  const { jobs } = YAML.parse(readFileSync(join(repoRoot, CI_WORKFLOW), 'utf8'))
  assert.deepEqual(laneProblems(jobs), [])
  for (const lane of [...Object.keys(PACKAGE_LANES), OTHER_PACKAGES_LANE]) {
    assert.deepEqual(jobs.verify.needs.includes(lane), true, `${lane} feeds the required check`)
  }
})

test('a lane that skips a package, runs one twice or runs another is reported', () => {
  const { jobs } = YAML.parse(readFileSync(join(repoRoot, CI_WORKFLOW), 'utf8'))
  const withRun = (lane, from, to) => ({
    ...jobs,
    [lane]: {
      ...jobs[lane],
      steps: jobs[lane].steps.map(step =>
        typeof step.run === 'string' ? { ...step, run: step.run.replace(from, to) } : step
      ),
    },
  })
  const others = "--filter '!qbit-extension' --filter '!@qbit/wallet-background'"
  // keyring-service excluded too: it would run nowhere.
  assert.deepEqual(
    laneProblems(
      withRun(OTHER_PACKAGES_LANE, others, `${others} --filter '!@qbit/keyring-service'`)
    ),
    [
      'verify-workspace must exclude exactly qbit-extension and @qbit/wallet-background, found !qbit-extension, !@qbit/wallet-background, !@qbit/keyring-service',
      "@qbit/keyring-service's test script runs 0 times in the lanes, not once",
    ]
  )
  // wallet-background left in the others: it would run twice.
  assert.deepEqual(
    laneProblems(withRun(OTHER_PACKAGES_LANE, others, "--filter '!qbit-extension'")),
    [
      'verify-workspace must exclude exactly qbit-extension and @qbit/wallet-background, found !qbit-extension',
      "@qbit/wallet-background's test script runs 2 times in the lanes, not once",
    ]
  )
  // A lane that runs another package.
  assert.deepEqual(
    laneProblems(
      withRun(
        'verify-extension-tests',
        '--filter qbit-extension run test',
        '--filter @qbit/wallet-core run test'
      )
    ),
    [
      'verify-extension-tests must run exactly `corepack pnpm --filter qbit-extension run test`, found ["corepack pnpm --filter @qbit/wallet-core run test"]',
      "qbit-extension's test script runs 0 times in the lanes, not once",
    ]
  )
  // Another job that runs package tests.
  assert.deepEqual(
    laneProblems({
      ...jobs,
      extra: { steps: [{ run: 'corepack pnpm -r --if-present test' }] },
    }),
    ['extra also runs package tests: corepack pnpm -r --if-present test']
  )
})
