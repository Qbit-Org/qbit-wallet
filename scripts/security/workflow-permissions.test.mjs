import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { auditWorkflowPermissions, WORKFLOW_FILE } from './workflow-permissions.mjs'

const CHECKOUT = `actions/checkout@${'a'.repeat(40)}`
const CHANGESETS = `changesets/action@${'b'.repeat(40)}`

function audit(file, lines) {
  return auditWorkflowPermissions([{ file, source: lines.join('\n') }])
}

test('workflow permissions audit accepts a top-level or a per-job declaration', () => {
  const topLevel = audit('.github/workflows/top.yml', [
    'on: push',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: true',
    '  publish:',
    '    permissions:',
    '      contents: read',
    '      packages: write',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: true',
  ])
  assert.deepEqual(topLevel, { checkoutCount: 0, errors: [], workflowCount: 1 })

  const perJob = audit('.github/workflows/per-job.yml', [
    'on: push',
    'jobs:',
    '  build:',
    '    permissions: {}',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: true',
    '  reusable:',
    '    permissions: read-all',
    '    uses: ./.github/workflows/top.yml',
  ])
  assert.deepEqual(perJob.errors, [])
})

test('workflow permissions audit rejects a job left on the repository default token', () => {
  // The pqc.yml shape this policy was added for: no permissions key anywhere.
  const missing = audit('.github/workflows/pqc.yml', [
    'on: pull_request',
    'jobs:',
    '  pqc:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${CHECKOUT}`,
    '        with:',
    '          persist-credentials: false',
    '      - run: pnpm install --frozen-lockfile',
  ])
  assert.deepEqual(missing.errors, [
    '.github/workflows/pqc.yml: job pqc declares no permissions and neither does the workflow, so its GITHUB_TOKEN gets the repository default',
  ])

  const partial = audit('.github/workflows/partial.yml', [
    'on: push',
    'jobs:',
    '  scoped:',
    '    permissions:',
    '      contents: read',
    '    runs-on: ubuntu-latest',
    '    steps: [{ run: "true" }]',
    '  unscoped:',
    '    runs-on: ubuntu-latest',
    '    steps: [{ run: "true" }]',
  ])
  assert.deepEqual(partial.errors, [
    '.github/workflows/partial.yml: job unscoped declares no permissions and neither does the workflow, so its GITHUB_TOKEN gets the repository default',
  ])
})

test('workflow permissions audit rejects write-all and malformed declarations', () => {
  const result = audit('.github/workflows/broad.yml', [
    'on: push',
    'permissions: write-all',
    'jobs:',
    '  empty:',
    '    permissions:',
    '    runs-on: ubuntu-latest',
    '  named:',
    '    permissions: read',
    '    runs-on: ubuntu-latest',
    '  broad:',
    '    permissions: write-all',
    '    runs-on: ubuntu-latest',
  ])
  assert.deepEqual(result.errors, [
    '.github/workflows/broad.yml: permissions: write-all grants every scope; list only the scopes it needs',
    '.github/workflows/broad.yml: job empty: permissions must be a mapping of scopes or read-all, found null',
    '.github/workflows/broad.yml: job named: permissions must be a mapping of scopes or read-all, found "read"',
    '.github/workflows/broad.yml: job broad: permissions: write-all grants every scope; list only the scopes it needs',
  ])
})

test('workflow permissions audit fails closed on YAML it cannot read', () => {
  const result = auditWorkflowPermissions([
    { file: '.github/workflows/broken.yml', source: 'jobs: [unterminated' },
    { file: '.github/workflows/no-jobs.yml', source: 'on: push\npermissions: {}\n' },
    { file: '.github/workflows/scalar-job.yml', source: 'permissions: {}\njobs:\n  build: true\n' },
    {
      file: '.github/workflows/scalar-steps.yml',
      source: 'permissions: {}\njobs:\n  build:\n    steps: run\n',
    },
  ])
  assert.equal(result.workflowCount, 4)
  assert.equal(result.errors.length, 4)
  assert.match(
    result.errors[0],
    /^\.github\/workflows\/broken\.yml: workflow YAML cannot be parsed: /
  )
  assert.deepEqual(result.errors.slice(1), [
    '.github/workflows/no-jobs.yml: workflow must declare a non-empty jobs mapping',
    '.github/workflows/scalar-job.yml: job build must be a mapping',
    '.github/workflows/scalar-steps.yml: job build: steps must be a list',
  ])
})

test('checkout audit requires persist-credentials: false on every checkout', () => {
  // The release.yml shape from #262: the PAT stayed in .git/config while
  // `pnpm install` ran dependency lifecycle scripts.
  const persisted = audit('.github/workflows/release.yml', [
    'on: push',
    'permissions:',
    '  contents: write',
    'jobs:',
    '  version:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    `        uses: ${CHECKOUT} # v4`,
    '        with:',
    '          fetch-depth: 0',
    '          token: ${{ secrets.RELEASE_PAT || github.token }}',
    '      - run: pnpm install --frozen-lockfile',
    `      - uses: ${CHANGESETS}`,
    '        env:',
    '          GITHUB_TOKEN: ${{ secrets.RELEASE_PAT }}',
    `      - uses: ${CHECKOUT}`,
    '        with:',
    '          ssh-key: ${{ secrets.DEPLOY_KEY }}',
    '          persist-credentials: true',
    `      - uses: Actions/Checkout@${'c'.repeat(40)}`,
    '        with:',
    '          token: ${{ steps.app-token.outputs.token }}',
    '          persist-credentials: ${{ inputs.persist }}',
    // Without token or ssh-key, checkout persists the job's github.token, which
    // can carry write scopes.
    `      - uses: ${CHECKOUT}`,
    `      - uses: ${CHECKOUT}`,
    '        with:',
    '          fetch-depth: 0',
  ])
  assert.equal(persisted.checkoutCount, 5)
  assert.deepEqual(persisted.errors, [
    '.github/workflows/release.yml: job version, Checkout: actions/checkout must set persist-credentials: false so its credentials are not left in .git/config',
    '.github/workflows/release.yml: job version, step 4: actions/checkout must set persist-credentials: false so its credentials are not left in .git/config',
    '.github/workflows/release.yml: job version, step 5: actions/checkout must set persist-credentials: false so its credentials are not left in .git/config',
    '.github/workflows/release.yml: job version, step 6: actions/checkout must set persist-credentials: false so its credentials are not left in .git/config',
    '.github/workflows/release.yml: job version, step 7: actions/checkout must set persist-credentials: false so its credentials are not left in .git/config',
  ])

  const scrubbed = audit('.github/workflows/release.yml', [
    'on: push',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  version:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${CHECKOUT}`,
    '        with:',
    '          token: ${{ secrets.RELEASE_PAT }}',
    '          persist-credentials: false',
    `      - uses: ${CHECKOUT}`,
    '        with:',
    '          token: ${{ secrets.RELEASE_PAT }}',
    "          persist-credentials: 'False'",
    `      - uses: ${CHECKOUT}`,
    '        with:',
    '          fetch-depth: 0',
    '          persist-credentials: false',
  ])
  assert.deepEqual(scrubbed, { checkoutCount: 3, errors: [], workflowCount: 1 })
})

test('every tracked workflow declares its token permissions and scrubs checkout credentials', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const workflows = readdirSync(join(repoRoot, '.github/workflows'))
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => {
      const file = `.github/workflows/${name}`
      return { file, source: readFileSync(join(repoRoot, file), 'utf8') }
    })
  assert.ok(workflows.length >= 6, 'expected the repository workflows to be found')
  for (const { file } of workflows) assert.match(file, WORKFLOW_FILE)
  assert.ok(!WORKFLOW_FILE.test('.github/workflows/nested/ignored.yml'))
  assert.ok(!WORKFLOW_FILE.test('external/qbit-js/.github/workflows/ci.yml'))

  const result = auditWorkflowPermissions(workflows)
  assert.deepEqual(result.errors, [])
  assert.equal(result.workflowCount, workflows.length)
  // The audit finds release.yml's checkout, the one #262 was about.
  const release = workflows.find(({ file }) => file === '.github/workflows/release.yml')
  assert.ok(auditWorkflowPermissions([release]).checkoutCount >= 1)
})
