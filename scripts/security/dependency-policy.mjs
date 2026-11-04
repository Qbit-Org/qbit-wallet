import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'
import YAML from 'yaml'

import { parseAuditPath } from './dependency-evidence-identity.mjs'
import { auditWorkflowPermissions, WORKFLOW_FILE } from './workflow-permissions.mjs'

const LICENSE_BASELINE_FILE = 'scripts/security/dependency-license-baseline.json'
const RISK_EXCEPTIONS_FILE = 'scripts/security/dependency-risk-exceptions.json'
const DEPENDENCY_AUDIT_FILE = 'docs/security/dependency-audit.json'
const DEPENDENCY_INVENTORY_FILE = 'docs/security/dependency-inventory.json'
const DEPENDENCY_INVENTORY_SCHEMA_VERSION = 1
const DEPENDENCY_AUDIT_COMMAND = 'corepack pnpm audit --json'
const LICENSE_COMMAND = 'corepack pnpm licenses list --json --long'
const LOCKFILE_LICENSE_SOURCE =
  'reviewed package metadata for every sha512-bound pnpm-lock.yaml name@version identity'
// Marker written by --write-license-baseline for identities nobody has reviewed
// yet. The policy fails closed on it until a reviewer replaces the whole value
// with the verified license expression.
const PENDING_LICENSE_REVIEW = 'pending-review'
const MAX_EXCEPTION_DAYS = 180
const RISK_EXCEPTION_SCHEMA_VERSION = 2
const TRACKED_SOURCE_ABSENCE_GUARD = 'tracked-source-absence'
const FIXED_NON_EXECUTABLE_REACHABILITY_FILES = new Set([
  'pnpm-lock.yaml',
  LICENSE_BASELINE_FILE,
  RISK_EXCEPTIONS_FILE,
  DEPENDENCY_AUDIT_FILE,
  DEPENDENCY_INVENTORY_FILE,
])

const APPROVED_LICENSE_EXPRESSIONS = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Public Domain',
  'Python-2.0',
  'Unlicense',
  '(AFL-2.1 OR BSD-3-Clause)',
  '(Apache-2.0 AND BSD-3-Clause)',
  '(Apache-2.0 OR MPL-1.1)',
  '(BSD-3-Clause OR GPL-2.0)',
  '(CC-BY-4.0 AND MIT)',
  '(MIT AND BSD-3-Clause)',
  '(MIT AND Zlib)',
  '(MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)',
  '(Unlicense OR Apache-2.0)',
])

const UNKNOWN_LICENSE_EVIDENCE = new Map([
  [
    'bigi@1.4.2',
    {
      disposition: 'permissive license text verified in LICENSE.md',
      sha256: '2ec211b33474976515790a5d980db86edbb5fdb6f754e9b52fc51a3207aaf1f2',
    },
  ],
  [
    'buffer-compare@1.1.1',
    {
      disposition: 'MIT license text verified in LICENSE',
      sha256: '7e13db436c0a802ef58d0096cc07323e53ad64ab9a5f3260c53e003e6dcd77d6',
    },
  ],
  [
    'react-cache@2.0.0-alpha.1',
    {
      disposition: 'MIT license text verified in LICENSE',
      sha256: '52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85',
    },
  ],
  [
    'spawndamnit@3.0.1',
    {
      disposition: 'MIT license text verified in LICENSE',
      sha256: 'aac99045d4e36ab3b1e2914337620963b56cbac53de280c94f29261a22ab5b0f',
    },
  ],
])

// Tracked package-manager configuration is read by every install and audit
// before the policy job runs, so only the root pnpm-workspace.yaml with
// reviewed settings is permitted, and any other manager configuration file
// (which can redirect registries or rewrite resolutions) is rejected outright.
// pnpm 11 reads only auth and registry settings from .npmrc, which the
// repository never commits, so a tracked .npmrc may hold comments only.
// Corepack loads `.corepack.env` beside each package.json it inspects before
// it downloads a manager, so a tracked copy can redirect that download or
// disable its integrity checks.
export const PACKAGE_MANAGER_CONFIG_FILE =
  /(?:^|\/)(?:\.npmrc|\.yarnrc|\.yarnrc\.ya?ml|bunfig\.toml|\.pnpmfile\.[cm]?js|pnpmfile\.js|\.corepack\.env|pnpm-workspace\.ya?ml)$/
const WORKSPACE_CONFIG_FILE = 'pnpm-workspace.yaml'
// pnpm 11 ignores kebab-case keys in pnpm-workspace.yaml, so an unlisted key is
// either an unreviewed setting or one that silently does nothing.
const REVIEWED_WORKSPACE_KEYS = new Set([
  'packages',
  'nodeLinker',
  'linkWorkspacePackages',
  'verifyDepsBeforeRun',
  'overrides',
  'patchedDependencies',
  'allowBuilds',
])
// The extension's webpack ProvidePlugin resolves `buffer` from each module's
// nearest node_modules, so the shipped bundle depends on the hoisted layout.
// pnpm 8 linked a dependency on a workspace package by default; pnpm 11 must
// be told to, or a non-workspace range on a workspace name resolves from the
// registry. pnpm 11 also installs before `pnpm run` and `pnpm exec` when
// node_modules is out of date (verifyDepsBeforeRun defaults to `install`),
// which pnpm 8 never did; `false` keeps every install an explicit command.
const REQUIRED_WORKSPACE_SETTINGS = new Map([
  ['nodeLinker', 'hoisted'],
  ['linkWorkspacePackages', true],
  ['verifyDepsBeforeRun', false],
])
// Dependency lifecycle scripts run only for packages listed `true` in
// allowBuilds. None of the installed scripts is needed: secp256k1 ships
// prebuilt binaries, esbuild's JavaScript API finds its platform package
// without the postinstall copy, and the rest print banners or do nothing here.
const REVIEWED_BUILD_DEPENDENCIES = new Set()
// A workflow may reference a local action with `uses: ./path`, whose tracked
// action.yml can itself invoke mutable external actions or run commands, so
// every tracked action definition is audited regardless of its directory.
const ACTION_DEFINITION_FILE = /^action\.ya?ml$/
// A composite action's implementation is the `uses` references and `run` bodies
// in its own definition, which this policy already audits. Every other runtime
// executes an entrypoint the policy never reads: a JavaScript action runs the
// `runs.main` file beside the definition, a Docker action runs a Dockerfile or
// a published image. Reading those well enough to find an unpinned installer
// would take static analysis that still misses whatever the entrypoint
// assembles at run time, so an unaudited runtime is rejected outright rather
// than partly inspected.
const COMPOSITE_ACTION_RUNTIME = 'composite'
// Corepack resolves a plain `corepack pnpm` from the nearest manifest that
// declares packageManager, so a nested workspace or submodule manifest could
// redirect installs to a mutable manager such as pnpm@latest. The root
// manifest must pin the reviewed manager; nested manifests may omit the field
// but must not declare anything else. The sha512 suffix makes Corepack verify
// the pnpm tarball it downloads.
export const REQUIRED_PACKAGE_MANAGER =
  'pnpm@11.28.9+sha512.35421cea2720eca3f5ad722b67e8ef18f4d3cd4745ed2fcfeb0dc288d4e9437fad3870d91ee6e83f268f0f6f7e0f62723317b19617bb45ee4333172ef51159f8'
const PINNED_PNPM_SPEC = REQUIRED_PACKAGE_MANAGER.slice('pnpm@'.length)
// pnpm reaches a command only through Corepack, which checks it against the
// pin. pnpm itself, its standalone build, and Corepack are therefore never
// fetched or installed as packages, at any version: either would put a binary
// on PATH or in node_modules/.bin that no hash check covers.
const PACKAGE_MANAGER_PACKAGES = new Set(['@pnpm/exe', 'corepack', 'pnpm'])

// Whether a package name is a package manager that must come from Corepack:
// pnpm, its standalone build, Corepack, or any `@pnpm/*` package. pnpm ships
// its platform binary as `@pnpm/<platform>` (for example `@pnpm/linux-x64`),
// and its CLI as `@pnpm/exe`, so allowing the `@pnpm` scope in the lockfile or
// as a fetched package would put an unaudited pnpm on PATH or in
// node_modules/.bin.
function isPackageManagerPackage(name) {
  return name !== null && (PACKAGE_MANAGER_PACKAGES.has(name) || name.startsWith('@pnpm/'))
}

// The package a reference names, or null when it names none.
function referencedPackageName(reference) {
  const match = /^((?:@[^\s/@]+\/)?[^\s/@]+)(?:@|$)/.exec(reference)
  return match === null ? null : match[1]
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]
const BLOCKING_SEVERITIES = new Set(['critical', 'high'])
const REACHABILITY_VALUES = new Set([
  'reachable',
  'conditionally-reachable',
  'demonstrably-unreachable',
])

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'))
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSha256Digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isRegistryVersionSpecifier(specifier) {
  if (specifier === 'workspace:*') return true
  const comparator = /^(?:[~^]|[<>]=?)?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  return specifier.split(/\s*\|\|\s*/).every(part => part.length > 0 && comparator.test(part))
}

function exactPackageVersion(reference) {
  return /^(?:@[A-Za-z0-9_.~-]+\/)?[A-Za-z0-9_.~-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    reference
  )
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function hasExactObjectKeys(value, expectedKeys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    arraysEqual(sortedUnique(Object.keys(value)), sortedUnique(expectedKeys))
  )
}

function validRepoRelativePath(value) {
  return (
    isNonEmptyString(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
  )
}

export function auditLockfile(lockfileText) {
  const errors = []
  let lockfile
  try {
    lockfile = YAML.parse(lockfileText)
  } catch (error) {
    return {
      errors: [`pnpm-lock.yaml cannot be parsed unambiguously: ${error.message.split('\n')[0]}`],
      packageCount: 0,
    }
  }
  if (lockfile?.lockfileVersion !== '9.0') {
    errors.push('pnpm-lock.yaml must use reviewed lockfileVersion 9.0')
  }
  if (lockfile?.settings?.excludeLinksFromLockfile !== false) {
    errors.push('pnpm-lock.yaml must retain workspace link provenance')
  }

  if (
    !lockfile?.packages ||
    typeof lockfile.packages !== 'object' ||
    Array.isArray(lockfile.packages)
  ) {
    errors.push('pnpm-lock.yaml is missing its packages section')
    return { errors, packageCount: 0 }
  }

  let packageCount = 0
  for (const [packageKey, snapshot] of Object.entries(lockfile.packages)) {
    packageCount += 1
    // Lockfile v9 keys a registry package by name@version. Any other reference,
    // such as a URL, a git commit, or a file or link path, is not a registry
    // resolution.
    if (!exactPackageVersion(packageKey)) {
      errors.push(`${packageKey} is a forbidden non-registry package resolution`)
    }
    if (isPackageManagerPackage(packageKey.slice(0, packageKey.lastIndexOf('@')))) {
      errors.push(
        `${packageKey} is a package manager; pnpm must come from Corepack's packageManager pin`
      )
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(snapshot?.resolution?.integrity || '')) {
      errors.push(`${packageKey} is not bound to a sha512 registry integrity value`)
    }
    if (Object.hasOwn(snapshot?.resolution ?? {}, 'tarball')) {
      errors.push(`${packageKey} uses a forbidden tarball resolution override`)
    }
  }
  if (packageCount === 0) {
    errors.push('pnpm-lock.yaml contains no registry package resolutions')
  }
  return { errors, packageCount }
}

export function auditDependencySpecifiers(manifests) {
  const errors = []
  let specifierCount = 0
  for (const { file, manifest } of manifests) {
    const sections = DEPENDENCY_SECTIONS.map(section => [section, manifest[section] || {}])
    sections.push(['resolutions', manifest.resolutions || {}])
    // pnpm 11 ignores the pnpm field of package.json, so settings left there
    // would look reviewed while doing nothing. Overrides are audited in
    // pnpm-workspace.yaml, where pnpm reads them.
    if (Object.hasOwn(manifest, 'pnpm')) {
      errors.push(
        `${file}: pnpm settings belong in ${WORKSPACE_CONFIG_FILE}; pnpm 11 ignores the pnpm field`
      )
    }

    for (const [section, dependencies] of sections) {
      for (const [name, specifier] of Object.entries(dependencies)) {
        specifierCount += 1
        if (typeof specifier !== 'string') {
          errors.push(`${file}: ${section}.${name} must be a string`)
          continue
        }
        if (isRegistryVersionSpecifier(specifier)) continue
        errors.push(`${file}: ${section}.${name} uses forbidden unpinned specifier ${specifier}`)
      }
    }
  }
  return { errors, specifierCount }
}

function workspaceSettingMapping(settings, key, errors) {
  const value = settings[key]
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${WORKSPACE_CONFIG_FILE}: ${key} must be a mapping`)
    return {}
  }
  return value
}

export function auditWorkspaceSettings(source) {
  let settings
  try {
    settings = YAML.parse(source)
  } catch (error) {
    return [
      `${WORKSPACE_CONFIG_FILE} cannot be parsed unambiguously: ${error.message.split('\n')[0]}`,
    ]
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return [`${WORKSPACE_CONFIG_FILE} must be a mapping`]
  }

  const errors = []
  for (const key of Object.keys(settings)) {
    if (!REVIEWED_WORKSPACE_KEYS.has(key)) {
      errors.push(`${WORKSPACE_CONFIG_FILE}: unreviewed pnpm setting: ${key}`)
    }
  }
  for (const [key, required] of REQUIRED_WORKSPACE_SETTINGS) {
    if (settings[key] !== required) {
      errors.push(
        `${WORKSPACE_CONFIG_FILE}: ${key} must be ${JSON.stringify(required)}, found ${JSON.stringify(settings[key])}`
      )
    }
  }
  for (const [name, specifier] of Object.entries(
    workspaceSettingMapping(settings, 'overrides', errors)
  )) {
    if (typeof specifier !== 'string') {
      errors.push(`${WORKSPACE_CONFIG_FILE}: overrides.${name} must be a string`)
    } else if (!isRegistryVersionSpecifier(specifier)) {
      errors.push(
        `${WORKSPACE_CONFIG_FILE}: overrides.${name} uses forbidden unpinned specifier ${specifier}`
      )
    }
  }
  for (const [name, patchFile] of Object.entries(
    workspaceSettingMapping(settings, 'patchedDependencies', errors)
  )) {
    if (!validRepoRelativePath(patchFile) || !patchFile.startsWith('patches/')) {
      errors.push(
        `${WORKSPACE_CONFIG_FILE}: patchedDependencies.${name} must name a file under patches/`
      )
    }
  }
  for (const [name, allowed] of Object.entries(
    workspaceSettingMapping(settings, 'allowBuilds', errors)
  )) {
    if (typeof allowed !== 'boolean') {
      errors.push(`${WORKSPACE_CONFIG_FILE}: allowBuilds.${name} must be true or false`)
    } else if (allowed && !REVIEWED_BUILD_DEPENDENCIES.has(name)) {
      errors.push(
        `${WORKSPACE_CONFIG_FILE}: allowBuilds.${name} runs an unreviewed dependency lifecycle script`
      )
    }
  }
  return errors
}

export function auditPackageManagerConfigs(configFiles) {
  const errors = []
  let configCount = 0
  let workspaceConfigured = false
  for (const { file, source } of configFiles) {
    configCount += 1
    const npmrc = /(?:^|\/)\.npmrc$/.test(file)
    if (!npmrc && file !== WORKSPACE_CONFIG_FILE) {
      errors.push(`${file}: unreviewed package-manager configuration file`)
      continue
    }
    if (typeof source !== 'string') {
      errors.push(`${file}: package-manager configuration must be text`)
      continue
    }
    if (!npmrc) {
      workspaceConfigured = true
      errors.push(...auditWorkspaceSettings(source))
      continue
    }
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
      const separator = line.indexOf('=')
      const key = (separator < 0 ? line : line.slice(0, separator)).trim()
      errors.push(`${file}: unreviewed package-manager configuration key: ${key}`)
    }
  }
  if (!workspaceConfigured) {
    errors.push(`${WORKSPACE_CONFIG_FILE}: the reviewed workspace configuration is missing`)
  }
  return { configCount, errors }
}

export function isAuditedActionFile(file) {
  return (
    ((file.startsWith('.github/') || file.startsWith('apps/extension/.github/')) &&
      /\.(?:ya?ml)$/.test(file)) ||
    ACTION_DEFINITION_FILE.test(basename(file))
  )
}

export function auditWorkspacePackageManagers(manifests) {
  const errors = []
  let manifestCount = 0
  let rootDeclared = false
  for (const { file, manifest } of manifests) {
    manifestCount += 1
    // pnpm 11 prefers devEngines.packageManager to packageManager, and pnpm
    // downloads the Node.js a runtime field names, so either field would
    // bypass the reviewed pin.
    for (const [section, field] of [
      ['devEngines', 'packageManager'],
      ['devEngines', 'runtime'],
      ['engines', 'runtime'],
    ]) {
      if (manifest[section] && Object.hasOwn(manifest[section], field)) {
        errors.push(`${file}: ${section}.${field} is not permitted; packageManager pins pnpm`)
      }
    }
    if (!Object.hasOwn(manifest, 'packageManager')) continue
    if (file === 'package.json') rootDeclared = true
    const declared = manifest.packageManager
    if (declared === REQUIRED_PACKAGE_MANAGER) continue
    errors.push(
      `${file}: packageManager must be exactly ${REQUIRED_PACKAGE_MANAGER}, found ${JSON.stringify(declared)}`
    )
  }
  if (!rootDeclared) {
    errors.push(`package.json: packageManager must remain pinned to ${REQUIRED_PACKAGE_MANAGER}`)
  }
  return { errors, manifestCount }
}

// Rejects a tracked action definition whose implementation this policy cannot
// read. Only action.yml/action.yaml reaches here; an ordinary workflow declares
// `jobs` rather than `runs` and is audited as workflow YAML instead.
function auditActionRuntime(file, definition) {
  const runs =
    definition !== null && typeof definition === 'object' && !Array.isArray(definition)
      ? definition.runs
      : undefined
  if (!runs || typeof runs !== 'object' || Array.isArray(runs)) {
    return [`${file}: local action definition must declare a runs section`]
  }
  if (typeof runs.using !== 'string' || runs.using.length === 0) {
    return [`${file}: local action definition must declare a string runs.using runtime`]
  }
  if (runs.using === COMPOSITE_ACTION_RUNTIME) return []
  return [
    `${file}: local action runtime ${JSON.stringify(runs.using)} is rejected because its executable implementation is not audited; only ${COMPOSITE_ACTION_RUNTIME} actions are accepted`,
  ]
}

// pnpm/action-setup installs the packageManager version from the registry
// without checking its sha512 hash, and setup-node's `cache: pnpm` runs the
// pnpm first on PATH (`pnpm store path`) before the Corepack step can put its
// shim there. Either one runs a pnpm Corepack never checked, so both are
// rejected; a job caches the store with actions/cache after the Corepack step
// instead. Owner and repository names are case-insensitive in `uses`.
const PNPM_SETUP_ACTION = /^pnpm\/action-setup(?:[/@]|$)/i

export function auditActionReferences(actionFiles) {
  const errors = []
  let actionCount = 0
  for (const { file, source } of actionFiles) {
    let workflow
    try {
      workflow = YAML.parse(source)
    } catch (error) {
      errors.push(`${file}: workflow YAML cannot be parsed: ${error.message.split('\n')[0]}`)
      continue
    }

    if (ACTION_DEFINITION_FILE.test(basename(file))) {
      errors.push(...auditActionRuntime(file, workflow))
    }

    const visited = new WeakSet()
    const inspect = value => {
      if (!value || typeof value !== 'object') return
      if (visited.has(value)) return
      visited.add(value)
      if (Array.isArray(value)) {
        for (const entry of value) inspect(entry)
        return
      }
      for (const [key, nestedValue] of Object.entries(value)) {
        if (key === 'uses') {
          actionCount += 1
          if (typeof nestedValue !== 'string' || nestedValue.length === 0) {
            errors.push(`${file}: action reference must be a non-empty string`)
          } else if (
            !nestedValue.startsWith('./') &&
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(nestedValue)
          ) {
            errors.push(`${file}: action is not pinned to a full commit: ${nestedValue}`)
          }
          if (typeof nestedValue === 'string' && PNPM_SETUP_ACTION.test(nestedValue)) {
            errors.push(
              `${file}: pnpm/action-setup installs pnpm without checking the packageManager hash; run pnpm through Corepack: ${nestedValue}`
            )
          }
        }
        if (
          key === 'cache' &&
          typeof nestedValue === 'string' &&
          nestedValue.trim().toLowerCase() === 'pnpm'
        ) {
          errors.push(
            `${file}: setup-node's cache: pnpm runs pnpm before Corepack; cache the store with actions/cache after the Corepack step`
          )
        }
        inspect(nestedValue)
      }
    }
    inspect(workflow)
  }
  return { actionCount, errors }
}

function shellCommandSegment(command, startIndex) {
  let quote = null
  let escaped = false
  for (let index = startIndex; index < command.length; index += 1) {
    const character = command[index]
    // A line continuation joins the next line into this command, so the
    // newline it carries never ends the segment. Single quotes keep the pair
    // literally, and a newline inside them is not a separator either.
    if (!escaped && quote !== "'") {
      const continuation = lineContinuationLength(command, index)
      if (continuation > 0) {
        index += continuation - 1
        continue
      }
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '\n' || character === ';' || character === '&' || character === '|') {
      return command.slice(startIndex, index)
    }
  }
  return command.slice(startIndex)
}

// A backslash-newline pair is a line continuation the shell deletes before it
// splits words, so `np\` + newline + `x` runs `npx`. It is removed unquoted
// and inside double quotes; single quotes keep the pair literally. A CRLF
// source is folded the same way, which fails closed: the raw span still
// carries the original spelling for the obfuscated-manager check.
function lineContinuationLength(command, index) {
  if (command[index] !== '\\') return 0
  if (command[index + 1] === '\n') return 2
  if (command[index + 1] === '\r' && command[index + 2] === '\n') return 3
  return 0
}

// Splits a command into shell words and remembers the raw span each word
// came from, so a nested shell body can be located in the original text.
// Empty quoted words are kept: `npm exec -c ''` means "no call".
function shellWordSpans(command) {
  const spans = []
  let word = ''
  let start = -1
  let end = -1
  let quoted = false
  let quote = null
  let escaped = false
  const flush = () => {
    if (word.length > 0 || quoted) spans.push({ word, start, end })
    word = ''
    start = -1
    end = -1
    quoted = false
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    // Single quotes keep a continuation literally, so the pair stays in the
    // word. A `--call` body carried that way is folded when the shell running
    // it parses it, which is what the recursive audit of the body does.
    if (!escaped && quote !== "'") {
      const continuation = lineContinuationLength(command, index)
      if (continuation > 0) {
        index += continuation - 1
        continue
      }
    }
    if (!escaped && !quote && /\s/.test(character)) {
      flush()
      continue
    }
    // The raw span ends at the last character the word actually consumed, so a
    // continuation that trails a word is never reported as part of it.
    end = index + 1
    if (escaped) {
      word += character
      escaped = false
      continue
    }
    // A backslash is literal inside single quotes, so it neither escapes the
    // next character nor closes the quote.
    if (quote === "'") {
      if (character === "'") quote = null
      else word += character
      continue
    }
    if (character === '\\') {
      if (start < 0) start = index
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else word += character
      continue
    }
    if (start < 0) start = index
    if (character === '"' || character === "'") {
      quoted = true
      quote = character
    } else {
      word += character
    }
  }
  if (escaped) word += '\\'
  flush()
  return spans
}

function shellWords(command) {
  return shellWordSpans(command).map(span => span.word)
}

function packageOptionReferences(args) {
  const references = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--package') {
      references.push(args[index + 1] || argument)
      index += 1
    } else if (argument.startsWith('--package=')) {
      references.push(argument.slice('--package='.length) || argument)
    }
  }
  return references
}

// The shell body an `npm exec` / `npx` `--call` option runs, with the index
// of the word carrying it. An empty body means no call, so positional
// arguments are packages again.
function callBodyReference(words, startIndex) {
  const delimiter = words.indexOf('--', startIndex)
  const end = delimiter >= 0 ? delimiter : words.length
  for (let index = startIndex; index < end; index += 1) {
    const argument = words[index]
    if (argument === '-c' || argument === '--call') {
      return index + 1 < end ? { body: words[index + 1], index: index + 1 } : null
    }
    if (argument.startsWith('--call=') || argument.startsWith('-c=')) {
      return { body: argument.slice(argument.indexOf('=') + 1), index }
    }
  }
  return null
}

function npmExecArgumentReferences(words, { leadingPackageReferences = [] } = {}) {
  const delimiter = words.indexOf('--')
  const npmArguments = delimiter >= 0 ? words.slice(0, delimiter) : words
  const explicitPackages = [
    ...leadingPackageReferences,
    ...packageOptionReferences(npmArguments),
  ]
  if (explicitPackages.length > 0) return explicitPackages
  // A non-empty call body is audited as a shell command by the caller and
  // makes positional arguments a usage error; an empty one leaves them as
  // packages that npm fetches.
  const call = callBodyReference(npmArguments, 0)
  if (call && call.body !== '') return []

  for (let index = 0; index < npmArguments.length; index += 1) {
    const argument = npmArguments[index]
    if (
      argument === '-w' ||
      argument === '--workspace' ||
      argument === '-c' ||
      argument === '--call'
    ) {
      index += 1
      continue
    }
    if (
      argument.startsWith('--workspace=') ||
      argument.startsWith('--call=') ||
      argument.startsWith('-c=') ||
      ['-ws', '--workspaces', '--include-workspace-root', '-y', '--yes', '-n', '--no'].includes(
        argument
      )
    ) {
      continue
    }
    return [argument]
  }
  return delimiter >= 0 && words[delimiter + 1] ? [words[delimiter + 1]] : []
}

function npxArgumentReferences(words) {
  return directRunnerArgumentReferences(words, 'npx')
}

function directInitializerArgumentReferences(words, manager) {
  const delimiter = words.indexOf('--')
  const runnerArguments = delimiter >= 0 ? words.slice(0, delimiter) : words
  const reference = runnerArguments[0] || (delimiter >= 0 ? words[delimiter + 1] : undefined)
  return reference ? [initializerPackageReference(reference, manager)] : []
}

const NPM_INITIALIZER_COMMANDS = new Set(['init', 'create', 'innit'])
const NPM_INITIALIZER_BOOLEAN_OPTIONS = new Set([
  '-f',
  '--force',
  '--include-workspace-root',
  '--init-private',
  '--no-include-workspace-root',
  '--no-init-private',
  '--no-workspaces',
  '--no-workspaces-update',
  '--workspaces',
  '--workspaces-update',
  '-y',
  '--yes',
])
const NPM_INITIALIZER_VALUE_OPTIONS = new Set([
  '--init-author-name',
  '--init-author-url',
  '--init-license',
  '--init-module',
  '--init-type',
  '--init-version',
  '--scope',
  '-w',
  '--workspace',
])
// Options accepted before an npm command word. Anything else, including
// working-directory and prefix selection that changes which .npmrc is read,
// is rejected so an exact package cannot be resolved through unreviewed config.
const NPM_PREFIX_BOOLEAN_OPTIONS = new Set([
  ...NPM_INITIALIZER_BOOLEAN_OPTIONS,
  '-s',
  '--silent',
])
const NPM_PREFIX_VALUE_OPTIONS = new Set([...NPM_INITIALIZER_VALUE_OPTIONS, '--loglevel'])
const RESOLUTION_OVERRIDE_OPTIONS = new Set([
  '-C',
  '--config-dir',
  '--cwd',
  '--dir',
  '--globalconfig',
  '--prefix',
  '--reg',
  '--registry',
  '--userconfig',
])
// Command words that fetch registry packages by name before installing them.
// npm accepts several install aliases and misspellings.
const PACKAGE_INSTALL_COMMANDS = new Map([
  [
    'npm',
    new Set([
      'add',
      'i',
      'in',
      'ins',
      'inst',
      'insta',
      'instal',
      'install',
      'install-test',
      'isnt',
      'isnta',
      'isntal',
      'isntall',
      'it',
      'link',
      'ln',
    ]),
  ],
  ['pnpm', new Set(['add', 'i', 'install'])],
  ['yarn', new Set(['add', 'install'])],
  ['bun', new Set(['add', 'i', 'install'])],
])
// Managers whose operand-less install is bound to a lockfile this repository
// tracks. Only pnpm is: `pnpm-lock.yaml` is the single lockfile here, every
// registry entry in it carries a sha512 integrity hash, and the dependency
// evidence binds its digest, so `pnpm install` resolves exactly what was
// audited (CI installs with `--frozen-lockfile`). npm, Yarn, and Bun read
// lockfiles this repository does not carry, so their bare install resolves the
// manifests' version ranges against the registry afresh and runs the fetched
// packages' lifecycle scripts.
const LOCKFILE_BOUND_INSTALL_MANAGERS = new Set(['pnpm'])
// Command words that re-resolve already-declared dependencies against the
// registry. They select newer versions and run the lifecycle scripts of every
// package they replace, so their operands are audited exactly like install
// operands. Alias spellings are the ones each manager documents: npm maps
// `u`, `up`, `upgrade`, and the `udpate` typo onto `update`, pnpm documents
// `up` and `upgrade`, Yarn spells the command `up` (Berry) or `upgrade`
// (classic) plus the interactive picker, and Bun documents only `update`
// (`bun upgrade` replaces Bun itself, not a dependency).
const PACKAGE_UPDATE_COMMANDS = new Map([
  ['npm', new Set(['u', 'udpate', 'up', 'update', 'upgrade'])],
  ['pnpm', new Set(['up', 'update', 'upgrade'])],
  ['yarn', new Set(['up', 'upgrade', 'upgrade-interactive'])],
  ['bun', new Set(['update'])],
])
// Command words after which later words are script or child arguments rather
// than an install command; scanning stops there. pnpm's command line is read by
// `pnpmInvocation` instead.
const COMMAND_STOP_WORDS = new Map([
  [
    'npm',
    new Set([
      'ci',
      'clean-install',
      'create',
      'exec',
      'init',
      'innit',
      'run',
      'run-script',
      'rum',
      'start',
      't',
      'test',
      'tst',
      'urn',
      'x',
    ]),
  ],
  ['yarn', new Set(['create', 'dlx', 'exec', 'run', 'start', 'test'])],
  ['bun', new Set(['create', 'run', 'start', 'test', 'x'])],
])
// Install options that consume the following word.
const INSTALL_VALUE_OPTIONS = new Map([
  [
    'npm',
    new Set([
      '--before',
      '--cache',
      '--include',
      '--install-strategy',
      '--loglevel',
      '--omit',
      '--script-shell',
      '--tag',
      '-w',
      '--workspace',
    ]),
  ],
  [
    'pnpm',
    new Set([
      '-F',
      '--filter',
      '--lockfile-dir',
      '--loglevel',
      '--modules-dir',
      '--reporter',
      '--store-dir',
      '--tag',
      '--virtual-store-dir',
      '--workspace-concurrency',
    ]),
  ],
  [
    'yarn',
    new Set([
      '--cache-folder',
      '--global-folder',
      '--https-proxy',
      '--link-folder',
      '--modules-folder',
      '--mutex',
      '--network-concurrency',
      '--network-timeout',
      '--otp',
      '--preferred-cache-folder',
      '--proxy',
      '--use-yarnrc',
    ]),
  ],
  ['bun', new Set(['--backend', '--concurrent-scripts', '-F', '--filter', '--network-concurrency'])],
])
// pnpm's runners are read by `pnpmInvocation` against the pnpm allowlist.
const DIRECT_RUNNER_BOOLEAN_OPTIONS = new Map([
  ['npx', new Set(['-y', '--yes', '-n', '--no'])],
  ['yarn', new Set(['-q', '--quiet'])],
  ['bun', new Set(['--bun', '--no-install', '--silent', '--verbose'])],
])
const DIRECT_RUNNER_VALUE_OPTIONS = new Map([
  ['npx', new Set(['-c', '--call'])],
  ['yarn', new Set()],
  ['bun', new Set()],
])

function reviewedNpmOption(arguments_, index, booleanOptions, valueOptions) {
  const argument = arguments_[index]
  if (booleanOptions.has(argument)) return { recognized: true, valid: true, nextIndex: index }
  if (valueOptions.has(argument)) {
    const value = arguments_[index + 1]
    return {
      recognized: true,
      valid: isNonEmptyString(value) && !value.startsWith('-'),
      nextIndex: index + 1,
    }
  }

  const separator = argument.indexOf('=')
  if (separator < 0) return { recognized: false, valid: false, nextIndex: index }
  const name = argument.slice(0, separator)
  const value = argument.slice(separator + 1)
  if (booleanOptions.has(name)) {
    return {
      recognized: true,
      valid: value === 'true' || value === 'false',
      nextIndex: index,
    }
  }
  if (valueOptions.has(name)) {
    return { recognized: true, valid: isNonEmptyString(value), nextIndex: index }
  }
  return { recognized: false, valid: false, nextIndex: index }
}

function directRunnerArgumentReferences(
  words,
  manager,
  { leadingPackageReferences = [] } = {}
) {
  const delimiter = words.indexOf('--')
  const runnerArguments = delimiter >= 0 ? words.slice(0, delimiter) : words
  const references = [...leadingPackageReferences]
  const booleanOptions = DIRECT_RUNNER_BOOLEAN_OPTIONS.get(manager) || new Set()
  const valueOptions = DIRECT_RUNNER_VALUE_OPTIONS.get(manager) || new Set()

  for (let index = 0; index < runnerArguments.length; index += 1) {
    const argument = runnerArguments[index]
    if (argument === '--package' || argument === '-p') {
      references.push(runnerArguments[index + 1] || argument)
      index += 1
      continue
    }
    if (argument.startsWith('--package=')) {
      references.push(argument.slice('--package='.length) || argument)
      continue
    }
    if (argument.startsWith('-p=')) {
      references.push(argument.slice('-p='.length) || argument)
      continue
    }

    const option = reviewedNpmOption(
      runnerArguments,
      index,
      booleanOptions,
      valueOptions
    )
    if (option.recognized) {
      if (!option.valid) return [...references, argument]
      index = option.nextIndex
      continue
    }
    if (argument.startsWith('-')) return [...references, argument]
    return references.length > 0 ? references : [argument]
  }

  if (references.length > 0) return references
  return delimiter >= 0 && words[delimiter + 1] ? [words[delimiter + 1]] : []
}

function npmPrefixOptionReferences(words, { packageOptions = false } = {}) {
  for (let index = 0; index < words.length; index += 1) {
    const argument = words[index]
    if (packageOptions && argument === '--package') {
      index += 1
      continue
    }
    if (packageOptions && argument.startsWith('--package=')) continue
    const option = reviewedNpmOption(
      words,
      index,
      NPM_PREFIX_BOOLEAN_OPTIONS,
      NPM_PREFIX_VALUE_OPTIONS
    )
    if (!option.recognized || !option.valid) return [argument]
    index = option.nextIndex
  }
  return []
}

function resolutionOverrideReferences(words) {
  const delimiter = words.indexOf('--')
  const managerArguments = delimiter >= 0 ? words.slice(0, delimiter) : words
  return managerArguments.filter(argument => {
    const separator = argument.indexOf('=')
    const name = separator < 0 ? argument : argument.slice(0, separator)
    return (
      RESOLUTION_OVERRIDE_OPTIONS.has(name) ||
      /^--@[A-Za-z0-9_.~-]+:registry$/.test(name) ||
      /^--config\.(?:registry|@[A-Za-z0-9_.~-]+:registry)$/.test(name)
    )
  })
}

// The pnpm options this repository's own commands use, and no others. pnpm 11
// reads every one of its settings from the command line, as `--<setting>` or
// as `--config.<key>` for any key, so a list of the dangerous ones could never
// be complete: any other option is rejected wherever pnpm itself reads it. A
// flag is accepted only as written here, since nopt takes a `true` or `false`
// after a flag as its value (`--frozen-lockfile false` turns the frozen
// lockfile off), and `--flag=value` is not the reviewed flag either.
const PNPM_FLAGS = new Set([
  '--frozen-lockfile',
  '--if-present',
  '--ignore-scripts',
  '--json',
  '--lockfile-only',
  '--no-bail',
  '-r',
  '--silent',
  '--version',
])
// The options that take a value, and the values accepted. pnpm 11.28.9's first
// pass reads the value of a space-separated `--workspace-concurrency` as the
// script name and then parses the words after the real script name as its own
// options, so that option is accepted only as `--workspace-concurrency=<n>`.
// `--filter <selector>` is read the same way in both spellings.
const PNPM_VALUE_OPTIONS = new Map([
  ['--filter', { separate: true, value: /./ }],
  ['--workspace-concurrency', { separate: false, value: /^\d+$/ }],
])

// pnpm 11.28.9's built-in command names and aliases (pnpm/lib/cmd). A command
// word that names none of them runs the package script of that name, or else
// the binary, and pnpm hands every word after it over unparsed. `test`,
// `start`, `t` and `tst` are scripts in pnpm 11, not built-ins.
const PNPM_BUILTIN_COMMANDS = new Set([
  'access',
  'add',
  'adduser',
  'approve-builds',
  'audit',
  'bin',
  'bugs',
  'c',
  'cache',
  'cat-file',
  'cat-index',
  'change',
  'ci',
  'clean',
  'clean-install',
  'completion',
  'completion-server',
  'config',
  'create',
  'dedupe',
  'deploy',
  'deprecate',
  'dislink',
  'dist-tag',
  'dist-tags',
  'dlx',
  'docs',
  'doctor',
  'edit',
  'env',
  'exec',
  'fetch',
  'find',
  'find-hash',
  'get',
  'help',
  'home',
  'i',
  'ic',
  'ignored-builds',
  'import',
  'info',
  'init',
  'install',
  'install-clean',
  'install-test',
  'issues',
  'it',
  'la',
  'lane',
  'licenses',
  'link',
  'list',
  'll',
  'ln',
  'login',
  'logout',
  'ls',
  'm',
  'multi',
  'outdated',
  'owner',
  'owners',
  'pack',
  'pack-app',
  'patch',
  'patch-commit',
  'patch-remove',
  'peers',
  'ping',
  'pkg',
  'prefix',
  'profile',
  'prune',
  'publish',
  'purge',
  'rb',
  'rebuild',
  'recursive',
  'remove',
  'repo',
  'restart',
  'rm',
  'root',
  'rt',
  'run',
  'run-script',
  'runtime',
  's',
  'sbom',
  'se',
  'search',
  'self-update',
  'set',
  'set-script',
  'setup',
  'show',
  'ss',
  'stage',
  'star',
  'stars',
  'store',
  'team',
  'token',
  'un',
  'undeprecate',
  'uni',
  'uninstall',
  'unlink',
  'unpublish',
  'unstar',
  'up',
  'update',
  'upgrade',
  'v',
  'version',
  'view',
  'whoami',
  'why',
  'with',
  'xmas',
])
// `pnpm recursive <command>` (or `multi`, `m`) runs the next command word.
const PNPM_RECURSIVE_COMMANDS = new Set(['m', 'multi', 'recursive'])
// Commands that change pnpm's settings, the reviewed manifests, or which pnpm
// or Node.js runs, rejected outright. `config` (alias `c`) and its `get` and
// `set` shorthands read and write settings, and `login` (alias `adduser`) and
// `logout` write registry auth; `approve-builds`, `patch-commit` and
// `patch-remove` rewrite allowBuilds and patchedDependencies; `link` adds an
// override and installs without the frozen lockfile; `pkg` and `set-script`
// edit package.json; `self-update`, `setup` and `with` change which pnpm runs;
// `env` and `runtime` change which Node.js runs.
const PNPM_SETTINGS_COMMANDS = new Set([
  'adduser',
  'approve-builds',
  'c',
  'config',
  'env',
  'get',
  'link',
  'ln',
  'login',
  'logout',
  'patch-commit',
  'patch-remove',
  'pkg',
  'rt',
  'runtime',
  'self-update',
  'set',
  'set-script',
  'setup',
  'ss',
  'with',
])

// A word the shell rewrites before pnpm reads it can become any option or any
// command, so the audit cannot tell what pnpm would run.
function shellRewritesWord(word) {
  return /[$`]/.test(word) || braceExpands(word)
}

// Reads the pnpm option at `index`: the index of the last word it consumes, or
// what to reject.
function pnpmOption(words, index) {
  const word = words[index]
  const separator = word.indexOf('=')
  const name = separator < 0 ? word : word.slice(0, separator)
  const valueOption = PNPM_VALUE_OPTIONS.get(name)
  if (valueOption !== undefined) {
    if (separator < 0 && !valueOption.separate) return { option: word }
    const value = separator < 0 ? words[index + 1] : word.slice(separator + 1)
    if (!isNonEmptyString(value) || value.startsWith('-')) return { option: word }
    if (shellRewritesWord(value)) return { expansion: value }
    if (!valueOption.value.test(value)) return { option: word }
    return { lastIndex: separator < 0 ? index + 1 : index }
  }
  if (!PNPM_FLAGS.has(word)) return { option: word }
  const next = words[index + 1]
  if (next === 'true' || next === 'false') return { option: `${word} ${next}` }
  return { lastIndex: index }
}

// Reads a pnpm command line the way pnpm 11.28.9 does (@pnpm/parse-cli-args
// over pnpm's own copy of nopt) and returns the command it runs, or the first
// word the audit rejects. pnpm parses its own options before the command word,
// and a built-in's options anywhere among its arguments up to `--`. It stops
// parsing at the script name of `pnpm <script>` and `pnpm run`, at the package
// `dlx` fetches, and at the `exec` or `create` word itself, and hands every
// later word to what it runs. Nothing after a rejected word has a known
// meaning, so the reading ends there.
function pnpmInvocation(words) {
  // pnpm pulls every `--config.<key>` word out of the whole command line for
  // `add` and for an install that `--` turns into one, past `--` and past the
  // package names, so one is rejected wherever it appears.
  const config = words.find(word => word.startsWith('--config.'))
  if (config !== undefined) return { option: config }
  // `pnpm pm <command>` runs the built-in even where a script has its name.
  let index = words[0] === 'pm' ? 1 : 0
  for (; index < words.length; index += 1) {
    const word = words[index]
    // pnpm still reads the next word as the command after a leading `--`.
    if (word === '--') continue
    if (shellRewritesWord(word)) return { expansion: word }
    if (word.startsWith('-')) {
      const option = pnpmOption(words, index)
      if (option.lastIndex === undefined) return option
      index = option.lastIndex
      continue
    }
    if (!PNPM_RECURSIVE_COMMANDS.has(word)) break
  }
  const command = words[index]
  if (command === undefined) return {}
  if (PNPM_SETTINGS_COMMANDS.has(command)) return { settings: command }
  const invocation = { command, commandIndex: index }
  if (command === 'exec') {
    // The word after `exec` names the binary it runs, which may be pnpm itself.
    const binary = words.slice(index + 1).find(word => word !== '--')
    return binary !== undefined && shellRewritesWord(binary) ? { expansion: binary } : invocation
  }
  if (!PNPM_BUILTIN_COMMANDS.has(command) || command === 'create') return invocation
  const operandRuns = command === 'dlx' || command === 'run' || command === 'run-script'
  for (let position = index + 1; position < words.length; position += 1) {
    const word = words[position]
    if (word === '--') {
      if (operandRuns) return { ...invocation, operandIndex: position + 1, delimited: true }
      // A built-in reads the words after `--` too: `install -- <word>` runs
      // `add <word>`, and a recursive install parses them as options.
      return position + 1 < words.length ? { afterDelimiter: command } : invocation
    }
    if (shellRewritesWord(word)) return { expansion: word }
    if (word.startsWith('-')) {
      const option = pnpmOption(words, position)
      if (option.lastIndex === undefined) return option
      position = option.lastIndex
      continue
    }
    if (operandRuns) return { ...invocation, operandIndex: position }
  }
  return invocation
}

// The rejection a pnpm reading ended with, if any.
function pnpmRejection(invocation) {
  if (invocation.option !== undefined) {
    return `pnpm option is not on the reviewed allowlist: ${invocation.option}`
  }
  if (invocation.expansion !== undefined) {
    return `pnpm argument uses shell expansion: ${invocation.expansion}`
  }
  if (invocation.settings !== undefined) {
    return `pnpm command that changes settings is rejected: pnpm ${invocation.settings}`
  }
  if (invocation.afterDelimiter !== undefined) {
    return `pnpm built-in command takes no words after --: ${invocation.afterDelimiter}`
  }
  return null
}

// The executable packages a pnpm command line fetches, or a rejection. `dlx`
// (and `pnpx`, `pnx`, which run it) fetches its first operand, and `create` its
// first word, mapped to the starter package; an install or update fetches its
// operands. Resolution options after the fetched package are pnpm's to pass
// on, but they stay rejected as before unless a `--` precedes the package.
function pnpmCommandReferences(words, rejections) {
  const invocation = pnpmInvocation(words)
  const rejection = pnpmRejection(invocation)
  if (rejection !== null) {
    rejections.add(rejection)
    return []
  }
  const { command, commandIndex, operandIndex, delimited } = invocation
  const operands = words.slice(commandIndex + 1)
  if (command === 'dlx') {
    const reference = words[operandIndex]
    if (reference === undefined) return []
    const after = delimited ? [] : resolutionOverrideReferences(words.slice(operandIndex + 1))
    return [reference, ...after]
  }
  if (command === 'create') {
    // pnpm 11 stops parsing at `create`, so even `--` or an option-shaped word
    // is the starter: `pnpm create -- starter@1.2.3` fetches `create---`.
    if (operands.length === 0) return []
    return [
      initializerPackageReference(operands[0], 'pnpm'),
      ...resolutionOverrideReferences(operands.slice(1)),
    ]
  }
  if (PACKAGE_INSTALL_COMMANDS.get('pnpm').has(command)) {
    return installCommandReferences(operands, 'pnpm', command)
  }
  if (PACKAGE_UPDATE_COMMANDS.get('pnpm').has(command)) {
    return updateArgumentReferences(operands, 'pnpm', command)
  }
  return []
}

// Corepack subcommands whose operands name package managers, so in
// `corepack prepare pnpm@<spec> --activate` the pnpm word is what Corepack
// installs, and the words after it are Corepack's, not a pnpm command line.
const COREPACK_MANAGER_OPERAND_COMMANDS = new Set([
  'disable',
  'enable',
  'hydrate',
  'install',
  'pack',
  'prepare',
  'up',
  'use',
])

function isCorepackOperand(command, index) {
  const start =
    Math.max(...['\n', ';', '&', '|'].map(separator => command.lastIndexOf(separator, index - 1))) +
    1
  const prefix = command.slice(start, index)
  // A substitution still open before the word runs it as a command of its own.
  if (scanShellBody(prefix, 0, false).spans.some(span => span.end >= prefix.length)) return false
  const words = shellWords(prefix)
  const corepack = words.findIndex(word => word.slice(word.lastIndexOf('/') + 1) === 'corepack')
  if (corepack < 0) return false
  const subcommand = words.slice(corepack + 1).find(word => !word.startsWith('-'))
  return COREPACK_MANAGER_OPERAND_COMMANDS.has(subcommand)
}

// Corepack may enable its shims and act on the project's own pin, and nothing
// else. `use` and `up` rewrite the packageManager pin; `install -g`,
// `prepare --activate` and `hydrate` install a release as the global default,
// hydrate from any tarball; `install` or `prepare` naming a release fetches
// one the pin does not name; and `disable` removes the shims, so another pnpm
// on PATH runs. Corepack 0.34's other commands, `enable`, `pack` and
// `cache clean`, change none of that.
const COREPACK_REJECTED_COMMANDS = new Set(['disable', 'hydrate', 'up', 'use'])
const COREPACK_PROJECT_COMMANDS = new Set(['install', 'prepare'])
const COREPACK_GLOBAL_OPTION = /^(?:-g|--global|--activate)(?:=|$)/

// The Corepack command its arguments run that the audit rejects, or null.
function corepackCommandRejection(words) {
  const command = words.find(word => !word.startsWith('-'))
  if (COREPACK_REJECTED_COMMANDS.has(command)) return command
  if (!COREPACK_PROJECT_COMMANDS.has(command)) return null
  const operands = words.slice(words.indexOf(command) + 1)
  const global = words.some(word => COREPACK_GLOBAL_OPTION.test(word))
  return global || operands.some(word => !word.startsWith('-')) ? command : null
}

// npm commands that write configuration pnpm 11 reads (the registry and auth
// keys of an npmrc) or the reviewed manifests: `config` (alias `c`) with its
// `get` and `set` shorthands, `login` (`adduser`, `add-user`), `logout` and
// `pkg`. npm runs any unique prefix of a command name and reads camelCase as
// kebab-case (`npm conf`, `npm addUser`), so a prefix of one of these is
// rejected too, apart from the commands npm 10 resolves it to outright: `add`
// installs, and `s` and `se` search.
const NPM_SETTINGS_COMMANDS = [
  'add-user',
  'adduser',
  'c',
  'config',
  'get',
  'login',
  'logout',
  'pkg',
  'set',
]
const NPM_COMMANDS_PREFIXING_SETTINGS = new Set(['add', 's', 'se'])

function npmChangesSettings(word) {
  const name = word.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
  if (name === '' || NPM_COMMANDS_PREFIXING_SETTINGS.has(name)) return false
  return NPM_SETTINGS_COMMANDS.some(command => command.startsWith(name))
}

// The words npm may take for its command: the first operand, and the word
// after an option written without `=`, which is that option's value or, after
// a flag, the command itself. npm's option types are not mirrored here, so both
// readings are kept.
function npmCommandCandidates(words) {
  const candidates = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (!word.startsWith('-')) {
      candidates.push(word)
      break
    }
    const next = words[index + 1]
    if (!word.includes('=') && next !== undefined && !next.startsWith('-')) {
      candidates.push(next)
      index += 1
    }
  }
  return candidates
}

// The text a pnpm or Corepack word's arguments come from: the rest of its
// command segment, cut at the `)` that closes a subshell or command
// substitution around it. A `)` or backtick right after the word ends the
// substitution or code span it closes, so `$(command -v pnpm)` and a comment
// quoting `pnpm` carry no arguments; a substitution opening inside the
// arguments stays whole.
function commandArgumentText(command, startIndex) {
  const segment = shellCommandSegment(command, startIndex)
  if (segment.startsWith(')') || segment.startsWith('`')) return ''
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = null
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    const span = shellSubstitutionSpan(segment, index, quote)
    if (span !== null) {
      index = span.end - 1
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(') {
      depth += 1
    } else if (character === ')') {
      if (depth === 0) return segment.slice(0, index)
      depth -= 1
    }
  }
  return segment
}

// npm reads `<prefix>/etc/npmrc` as its global configuration, so a prefix
// supplied through the environment (`npm_config_prefix`, or the `PREFIX`
// variable npm derives its global prefix from) redirects resolution to
// unreviewed configuration exactly like the rejected `--prefix` option.
// pnpm 11 still falls back to `npm_config_userconfig` for its auth file and to
// `npm_config_workspace_dir` to find the workspace root, which picks the
// pnpm-workspace.yaml its settings come from. pnpm_config_*, COREPACK_* and the
// variables that move configuration files are rejected wherever they appear
// (REJECTED_VARIABLES).
function environmentResolutionOverrideReferences(commandPrefix) {
  const references = []
  const patterns = [
    /(?:^|[^A-Za-z0-9_])(npm_config_(?:(?:[A-Za-z0-9_.@~:-]+_)*registry|@[A-Za-z0-9_.~-]+:registry|userconfig|globalconfig|config_dir|prefix|workspace_dir))\s*(?==|:)/gi,
    /(?:^|[^A-Za-z0-9_])(PREFIX)\s*(?==|:)/g,
  ]
  for (const pattern of patterns) {
    for (const match of commandPrefix.matchAll(pattern)) references.push(match[1])
  }
  return references
}

// Variables the audit rejects, in any case. pnpm 11 reads a setting from any
// pnpm_config_<name> or PNPM_CONFIG_<NAME> variable, and its auth and
// scoped-registry lookups read names that are not snake case
// (`pnpm_config_//host/:_authToken`). Corepack's own variables can make it
// ignore the packageManager pin (COREPACK_ENABLE_PROJECT_SPEC), fetch from
// another registry or cache, drop its signature keys, or load more variables
// from a file (COREPACK_ENV_FILE); a COREPACK_ name is an identifier, so a path
// such as `corepack_check.sh` is not one. npm_config_userconfig and
// npm_config_globalconfig name the npmrc files pnpm still reads for auth. The
// repository sets none of these, and each is rejected wherever it is named.
// HOME and XDG_CONFIG_HOME pick the npmrc and `pnpm/config.yaml` pnpm reads,
// which can set a registry, an auth tokenHelper or dangerouslyAllowAllBuilds,
// and PNPM_HOME picks where pnpm's global binaries live. Scripts read those, so
// they are rejected only where something sets them.
//
// The whole text is searched, not only what precedes a pnpm word, because an
// exported variable or a workflow `env` entry reaches every later command,
// including a pnpm another script or step runs. Shell quoting can split a name
// (`pnpm_con"fig"_x`), so shell words are read too, and so are the parsed keys
// of workflow YAML, where an escape can spell one.
const REJECTED_VARIABLES = [
  {
    name: 'pnpm_config_[^\\s\'"=]*',
    problem: 'pnpm_config_ variable overrides a reviewed pnpm setting',
  },
  {
    name: 'COREPACK_[A-Za-z0-9_]*(?![A-Za-z0-9_./@-])',
    problem: 'COREPACK_ variable changes how Corepack picks or checks pnpm',
  },
  {
    name: 'npm_config_(?:userconfig|globalconfig|workspace_dir)(?![A-Za-z0-9_])',
    problem: 'variable moves the configuration files pnpm, npm or Corepack reads',
  },
  {
    // HOME and the XDG base directories pick the npmrc and `pnpm/config.yaml`
    // pnpm reads and the Corepack install cache it reuses without a hash check
    // (XDG_CACHE_HOME), and XDG_DATA_HOME moves pnpm's store. These are real
    // environment variable names, which the shell matches case-sensitively, so
    // a lowercase `home=$(pwd)` is a different, harmless variable.
    name: '(?:HOME|PNPM_HOME|XDG_(?:CONFIG|CACHE|DATA|STATE)_HOME)(?![A-Za-z0-9_])',
    problem: 'variable moves the configuration files pnpm, npm or Corepack reads',
    setOnly: true,
    caseSensitive: true,
  },
].map(variable => ({
  ...variable,
  // Only a `setOnly` variable is case-sensitive, and it has no `anywhere`
  // search, so the non-setOnly names here are all matched case-insensitively,
  // as pnpm and npm lowercase them.
  anywhere: variable.setOnly ? null : new RegExp(`(?<![A-Za-z0-9_])(${variable.name})`, 'gi'),
}))
// Shell commands that set a variable they are handed by name.
const SHELL_VARIABLE_SETTERS = new Set([
  'declare',
  'export',
  'getopts',
  'local',
  'mapfile',
  'printf',
  'read',
  'readarray',
  'readonly',
  'typeset',
])

// The keys of every `env` mapping in a workflow or action.
function yamlEnvironmentKeys(source) {
  let document
  try {
    document = YAML.parse(source)
  } catch {
    // The action audit already fails closed on YAML it cannot parse.
    return []
  }
  const keys = []
  const visited = new WeakSet()
  const inspect = (value, environment) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry, false)
      return
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      if (environment) keys.push(key)
      inspect(nestedValue, key === 'env')
    }
  }
  inspect(document, false)
  return keys
}

function yamlMappingKeys(source) {
  let document
  try {
    document = YAML.parse(source)
  } catch {
    return []
  }
  const keys = []
  const visited = new WeakSet()
  const inspect = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry)
      return
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      keys.push(key)
      inspect(nestedValue)
    }
  }
  inspect(document)
  return keys
}

// The rejected variables a command or workflow names, or for a `setOnly`
// variable, sets: a `NAME=` assignment anywhere in the text, `${NAME:=...}`,
// a shell word that assigns it or that a setter such as `export` or `read`
// takes, or a workflow `env` key.
function rejectedVariables(command, variable, { workflowFile = false } = {}) {
  const names = new Set()
  // A YAML mapping key ends at its `:`.
  const add = name => names.add(name.replace(/:$/, ''))
  const flags = variable.caseSensitive ? '' : 'i'
  const word = new RegExp(`^(${variable.name})${variable.setOnly ? '\\+?=' : ''}`, flags)
  const exact = new RegExp(`^(?:${variable.name})$`, flags)
  if (variable.setOnly) {
    // Every way a value reaches the variable without naming a command:
    // `NAME=`, `${NAME:=…}`, a GitHub Actions multiline write `NAME<<EOF`, and
    // a `for NAME in …` loop that assigns it each pass.
    const assignments = [
      new RegExp(`(?<![A-Za-z0-9_$.{-])(${variable.name})\\s*\\+?=(?!=)`, `g${flags}`),
      new RegExp(`\\$\\{(${variable.name}):?=`, `g${flags}`),
      new RegExp(`(?<![A-Za-z0-9_$.{-])(${variable.name})<<`, `g${flags}`),
      new RegExp(`\\bfor\\s+(${variable.name})\\s+in\\b`, `g${flags}`),
    ]
    for (const pattern of assignments) {
      for (const match of command.matchAll(pattern)) add(match[1])
    }
  } else {
    for (const match of command.matchAll(variable.anywhere)) add(match[1])
  }
  for (const text of workflowFile ? workflowRunCommands(command) : [command]) {
    for (const segment of shellCommandSegments(text)) {
      const words = shellWords(segment)
      const commandWord = words[commandWordIndex(words)]
      const setter = SHELL_VARIABLE_SETTERS.has(commandWord)
      // `declare -n ref=NAME` (also `local -n`, `typeset -n`) makes `ref` an
      // alias, so a later `ref=…` sets NAME. The nameref target is read here.
      if (
        variable.setOnly &&
        /^(?:declare|local|typeset)$/.test(commandWord) &&
        words.includes('-n')
      ) {
        for (const shellWord of words) {
          const nameref = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(shellWord)
          if (nameref && exact.test(nameref[1])) add(nameref[1])
        }
      }
      for (const shellWord of words) {
        const match = word.exec(shellWord)
        if (match) add(match[1])
        else if (variable.setOnly && setter && exact.test(shellWord)) add(shellWord)
      }
    }
  }
  if (workflowFile) {
    const keys = variable.setOnly ? yamlEnvironmentKeys(command) : yamlMappingKeys(command)
    for (const key of keys) {
      if (variable.setOnly ? exact.test(key) : word.test(key)) names.add(key)
    }
  }
  return [...names]
}

// Corepack runs `<manager>@<spec>`, so a quoted or escaped spec hides the
// runner and the package it fetches from the textual audit exactly like a
// quoted bare manager name does.
function obfuscatedManagerReferences(command) {
  const references = []
  const normalizedManager =
    /^(?:(?:\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+)?(?:npm|npx|pnpm|pnpx|pnx|pn|yarnpkg|yarn|bunx|bun)(?:@\S*)?$/
  for (const segment of shellCommandSegments(command)) {
    for (const { word, start, end } of shellWordSpans(segment)) {
      const rawWord = segment.slice(start, end)
      if (normalizedManager.test(word) && word !== rawWord) references.push(rawWord)
    }
  }
  return references
}

function registryInitializerParts(reference) {
  let match = /^(@[A-Za-z0-9_.~-]+)\/([A-Za-z0-9_.~-]+)(?:@(.+))?$/.exec(reference)
  if (match) return { scope: match[1], name: match[2], specifier: match[3] }

  match = /^(@[A-Za-z0-9_.~-]+)(?:@(.+))?$/.exec(reference)
  if (match) return { scope: match[1], name: null, specifier: match[2] }

  match = /^([A-Za-z0-9_.~-]+)(?:@(.+))?$/.exec(reference)
  if (match) return { scope: null, name: match[1], specifier: match[2] }
  return null
}

function initializerPackageReference(initializer, manager) {
  const parsed = registryInitializerParts(initializer)
  if (!parsed) return initializer
  const suffix = parsed.specifier === undefined ? '' : `@${parsed.specifier}`
  if (parsed.name === null) {
    // pnpm 8.6 accepts a bare scope, but not a version attached to that scope.
    if (manager === 'pnpm' && parsed.specifier !== undefined) return initializer
    return `${parsed.scope}/create${suffix}`
  }

  const packageName =
    manager === 'pnpm' && parsed.name.startsWith('create-') ? parsed.name : `create-${parsed.name}`
  return `${parsed.scope ? `${parsed.scope}/` : ''}${packageName}${suffix}`
}

function npmInitializerArgumentReferences(words) {
  const delimiter = words.indexOf('--')
  const npmArguments = delimiter >= 0 ? words.slice(0, delimiter) : words
  for (let index = 0; index < npmArguments.length; index += 1) {
    const argument = npmArguments[index]
    const option = reviewedNpmOption(
      npmArguments,
      index,
      NPM_PREFIX_BOOLEAN_OPTIONS,
      NPM_PREFIX_VALUE_OPTIONS
    )
    if (option.recognized) {
      if (!option.valid) return [argument]
      index = option.nextIndex
      continue
    }
    if (argument.startsWith('-')) return [argument]
    return [initializerPackageReference(argument, 'npm')]
  }
  const postDelimiter = delimiter >= 0 ? words[delimiter + 1] : undefined
  return postDelimiter ? [initializerPackageReference(postDelimiter, 'npm')] : []
}

function installArgumentReferences(args, manager) {
  const references = []
  const valueOptions = INSTALL_VALUE_OPTIONS.get(manager) || new Set()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (valueOptions.has(argument) || RESOLUTION_OVERRIDE_OPTIONS.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('-')) continue
    references.push(argument)
  }
  return references
}

// An install without operands installs whatever the manifests declare. For a
// manager that honours no lockfile here that is a fresh resolution of every
// declared range, exactly as mutable as a bare update, so the command word
// itself is reported in its canonical `<manager> <command>` form and fails the
// exact-version check. A bare pnpm install is bound to the audited lockfile and
// passes.
function installCommandReferences(args, manager, command) {
  const references = installArgumentReferences(args, manager)
  if (references.length > 0) return references
  if (LOCKFILE_BOUND_INSTALL_MANAGERS.has(manager)) return references
  return [`${manager} ${command}`]
}

// An update without operands re-resolves every declared dependency, so there
// is no exact identity to audit and the command word itself is reported.
function updateArgumentReferences(args, manager, command) {
  const references = installArgumentReferences(args, manager)
  return references.length > 0 ? references : [`${manager} ${command}`]
}

// Returns the package references of an install-style or update-style command,
// or null when the words do not select one. Option values are skipped only when
// they are a known command word, so `--filter <name>` cannot hide a later
// install.
function packageInstallReferences(words, manager) {
  const installCommands = PACKAGE_INSTALL_COMMANDS.get(manager)
  const updateCommands = PACKAGE_UPDATE_COMMANDS.get(manager)
  const stopWords = COMMAND_STOP_WORDS.get(manager)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word.startsWith('-')) continue
    if (manager === 'yarn' && word === 'global') {
      // Yarn classic scopes both `add` and `upgrade` under `global`.
      const subcommand = words[index + 1]
      if (installCommands.has(subcommand)) {
        return installCommandReferences(words.slice(index + 2), manager, subcommand)
      }
      if (updateCommands.has(subcommand)) {
        return updateArgumentReferences(words.slice(index + 2), manager, subcommand)
      }
      return null
    }
    if (installCommands.has(word)) {
      return installCommandReferences(words.slice(index + 1), manager, word)
    }
    if (updateCommands.has(word)) {
      return updateArgumentReferences(words.slice(index + 1), manager, word)
    }
    if (stopWords.has(word)) return null
  }
  // Yarn installs when it is given no command word at all, so `yarn` and
  // `yarn --immutable` are bare installs even though nothing here spells
  // `install`. Options are dropped the same way an install's are, which keeps
  // `yarn <script>` a script run rather than an install. Lockfile flags do not
  // rescue the command: this repository ships no lockfile Yarn reads, so they
  // either fail or pass through depending on which Yarn runs, and the audit
  // does not reason about that.
  if (manager === 'yarn' && installArgumentReferences(words, manager).length === 0) {
    return ['yarn install']
  }
  return null
}

// npm, Yarn, and Bun end option parsing at `--` and still treat the next word
// as the command, so `npm -- exec tool@latest` runs `exec`. Drop such a
// delimiter when no command word precedes it so the command is still audited.
// pnpm does the same, and `pnpmInvocation` reads it that way.
function withoutLeadingDelimiter(words, manager) {
  const delimiter = words.indexOf('--')
  if (delimiter < 0) return words
  const installCommands = PACKAGE_INSTALL_COMMANDS.get(manager)
  const updateCommands = PACKAGE_UPDATE_COMMANDS.get(manager)
  const stopWords = COMMAND_STOP_WORDS.get(manager)
  const commandPrecedesDelimiter = words
    .slice(0, delimiter)
    .some(
      word =>
        installCommands.has(word) ||
        updateCommands.has(word) ||
        stopWords.has(word) ||
        (manager === 'yarn' && word === 'global')
    )
  if (commandPrecedesDelimiter) return words
  return [...words.slice(0, delimiter), ...words.slice(delimiter + 1)]
}

// Bash performs brace expansion by default (`help set` lists it under `-B`),
// so a word carrying a group is rewritten before the command runs. A group
// only expands when it holds an alternation comma or a `..` range, which is
// why `{}` and `{word}` stay literal and a lone `{` or `}` group keyword never
// matches. A `${...}` is a parameter expansion, not a group, so it is removed
// before the test: `${X,Y}` and the `${...args}` a JavaScript spread is
// rendered as are dynamic words the other audits judge, while a group that
// merely contains one (`{x,${Y}}`) still expands.
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/
const PARAMETER_EXPANSION = /\$\{[^{}]*\}/g
function braceExpands(word) {
  return BRACE_EXPANSION.test(word.replace(PARAMETER_EXPANSION, ''))
}

// A brace group one word after the manager synthesizes its command word the
// same way it synthesizes a program name: `npm {x,}` runs `npm x` and
// `yarn dl{x,}` runs `yarn dlx`, both of which fetch the next word. Guessing
// which alternative the shell picks would mean expanding the group here, so
// every runner word that carries one and precedes the recognized command is
// reported instead, as `<manager> <word>` cannot be an exact version. pnpm
// rejects a group anywhere it reads its own arguments (`pnpmInvocation`).
function braceCommandWordReferences(words, manager) {
  const installCommands = PACKAGE_INSTALL_COMMANDS.get(manager)
  const updateCommands = PACKAGE_UPDATE_COMMANDS.get(manager)
  const stopWords = COMMAND_STOP_WORDS.get(manager)
  const references = []
  for (const word of words) {
    if (
      installCommands.has(word) ||
      updateCommands.has(word) ||
      stopWords.has(word) ||
      (manager === 'yarn' && word === 'global')
    ) {
      break
    }
    if (braceExpands(word)) references.push(`${manager} ${word}`)
  }
  return references
}

// A shell comment runs from an unquoted `#` that starts a word to the end of
// its line, at any substitution depth; a `#` inside `${...}` is part of the
// expansion. A `#` begins a word only after an ASCII space, tab or newline, or
// after an operator that starts a new command (`;`, `&`, `|`, a subshell `(`).
// bash and dash treat no other character as a word break, so a `#` after the
// `)` that closes `$(`, `$((`, `<(` or `>(`, or after a vertical tab or NBSP,
// is part of the surrounding word, not a comment. This scan skips every such
// substitution whole, so the character it reads before a `#` is never that
// closing `)`. Blanking a comment hides its text from every later reading, so
// it is done only while this scan tracks quoting exactly as the shell does: up
// to the first heredoc operator, whose body is data the shell never tokenizes.
// Comments after one are read as text, which can only reject more. Blanked
// text keeps its length, so every index still lines up with the original.
const SHELL_COMMENT_START = /[ \t\n;&|(]/

function withoutShellComments(command) {
  const characters = command.split('')
  let trusted = true
  const scan = (start, end) => {
    let quote = null
    let escaped = false
    let braces = 0
    for (let index = start; index < end && trusted; index += 1) {
      const character = command[index]
      if (!escaped && quote !== "'") {
        const continuation = lineContinuationLength(command, index)
        if (continuation > 0) {
          index += continuation - 1
          continue
        }
      }
      if (escaped) {
        escaped = false
        continue
      }
      if (quote === "'") {
        if (character === "'") quote = null
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (quote === null && command.startsWith("$'", index)) {
        index = shellExpansionEnd(command, index, null) - 1
        continue
      }
      const span = shellSubstitutionSpan(command, index, quote)
      if (span !== null) {
        if (span.kind === 'command' || span.kind === 'process') scan(span.bodyStart, span.bodyEnd)
        index = span.end - 1
        continue
      }
      if (quote) {
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
      } else if (command.startsWith('<<', index) && !command.startsWith('<<<', index)) {
        trusted = false
      } else if (command.startsWith('${', index)) {
        braces += 1
        index += 1
      } else if (character === '}' && braces > 0) {
        braces -= 1
      } else if (
        character === '#' &&
        braces === 0 &&
        (index === start || SHELL_COMMENT_START.test(command[index - 1]))
      ) {
        let stop = command.indexOf('\n', index)
        if (stop < 0 || stop > end) stop = end
        for (let position = index; position < stop; position += 1) characters[position] = ' '
        index = stop - 1
      }
    }
  }
  scan(0, command.length)
  return characters.join('')
}

// The YAML source with its comments blanked, exactly as the YAML lexer finds
// them, and the shell comments in each block scalar blanked as above, as they
// are in the parsed `run` body. An action input is read unblanked from the
// parsed document, since an action need not run it through a shell. The lexer
// emits a few control tokens that are not in the source.
const YAML_CONTROL_TOKENS = new Set(['\x02', '\x18', '\x1f'])

function withoutYamlComments(source) {
  let text = ''
  let blockScalar = false
  let blockLine = false
  try {
    for (const token of new YAML.Lexer().lex(source)) {
      if (YAML_CONTROL_TOKENS.has(token)) continue
      const type = YAML.CST.tokenType(token)
      if (type === 'comment') {
        text += ' '.repeat(token.length)
        continue
      }
      if (blockLine && type !== 'newline') {
        text += withoutShellComments(token)
        blockScalar = false
        blockLine = false
        continue
      }
      if (type === 'block-scalar-header') blockScalar = true
      else if (blockScalar && type === 'newline') blockLine = true
      text += token
    }
  } catch {
    return source
  }
  return text.length === source.length ? text : source
}

// A shell word as the audit reads it: its raw text, the text it stands for with
// quotes removed and every expansion replaced by EXPANSION, and what the shell
// may still do to it. A word is `plain` when the shell hands it on exactly as
// written: unquoted letters, digits and `_@%+=:,./^-`, a `#` inside a word,
// single-quoted text, and double-quoted text without `$`, a backtick or a
// backslash. Substitutions stay whole inside the word that carries them.
const EXPANSION = '\u0000'
const PLAIN_UNQUOTED = /[A-Za-z0-9_@%+=:,./^-]/

function shellExpansionEnd(text, index, quote) {
  const span = shellSubstitutionSpan(text, index, quote)
  if (span !== null) return span.end
  if (text[index] !== '$') return index + 1
  const next = text[index + 1]
  if (next === '{') {
    let depth = 0
    for (let position = index + 1; position < text.length; position += 1) {
      if (text[position] === '{') depth += 1
      else if (text[position] === '}' && --depth === 0) return position + 1
    }
    return text.length
  }
  if (next === "'" && quote === null) {
    for (let position = index + 2; position < text.length; position += 1) {
      if (text[position] === '\\') position += 1
      else if (text[position] === "'") return position + 1
    }
    return text.length
  }
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(index + 1))
  return index + 1 + (name === null ? 0 : name[0].length)
}

function shellWordDetails(segment) {
  const words = []
  let word = null
  const flush = () => {
    if (word !== null) words.push({ ...word, raw: segment.slice(word.start, word.end) })
    word = null
  }
  const expansion = (index, quote) => {
    word.text += EXPANSION
    word.plain = false
    return shellExpansionEnd(segment, index, quote) - 1
  }
  for (let index = 0; index < segment.length; index += 1) {
    const continuation = lineContinuationLength(segment, index)
    if (continuation > 0) {
      index += continuation - 1
      continue
    }
    const character = segment[index]
    if (/\s/.test(character)) {
      flush()
      continue
    }
    if (word === null) {
      word = { start: index, text: '', plain: true, glob: false, redirection: false }
    }
    if (character === "'") {
      const close = segment.indexOf("'", index + 1)
      if (close < 0) word.plain = false
      const stop = close < 0 ? segment.length : close
      word.text += segment.slice(index + 1, stop)
      index = stop
    } else if (character === '"') {
      let position = index + 1
      for (; position < segment.length && segment[position] !== '"'; position += 1) {
        if (segment[position] === '\\') {
          word.plain = false
          position += 1
          word.text += segment[position] ?? ''
        } else if (segment[position] === '$' || segment[position] === '`') {
          position = expansion(position, '"')
        } else {
          word.text += segment[position]
        }
      }
      if (position >= segment.length) word.plain = false
      index = position
    } else if (
      character === '$' ||
      character === '`' ||
      shellSubstitutionSpan(segment, index, null) !== null
    ) {
      index = expansion(index, null)
    } else if (character === '\\') {
      word.plain = false
      index += 1
      word.text += segment[index] ?? ''
    } else if (character === '(' && /[@?*+!]$/.test(word.text) && word.text !== '!') {
      // An extglob `@( … )`, `?( … )`, `*( … )` or `+( … )` is a glob pattern,
      // one word, not a subshell, so its parentheses do not break the word; the
      // whole balanced group is kept and the word is a glob. A bare `!(…)` is
      // not treated as one: with extglob off, the default, bash runs it as a
      // negated subshell, so the `(` must break the word.
      let depth = 0
      let end = index
      for (; end < segment.length; end += 1) {
        if (segment[end] === '(') depth += 1
        else if (segment[end] === ')' && (depth -= 1) === 0) break
      }
      word.text += segment.slice(index, Math.min(end + 1, segment.length))
      word.glob = true
      index = end
    } else if (character === '(' || character === ')') {
      // The shell reads an unquoted `(` or `)` as an operator that breaks the
      // word, so a subshell `(pnpm …)` runs pnpm as its own command word. The
      // paren is kept as a word of its own so the following word is a clean
      // manager name, not `(pnpm`. A paren that begins a word leaves no empty
      // word in front of it.
      if (word.text === '' && word.start === index) word = null
      else flush()
      words.push({
        text: character,
        plain: false,
        glob: false,
        redirection: false,
        start: index,
        end: index + 1,
        raw: character,
      })
      continue
    } else {
      if (!PLAIN_UNQUOTED.test(character) && !(character === '#' && index > word.start)) {
        word.plain = false
      }
      if ('*?['.includes(character)) word.glob = true
      if ('<>'.includes(character)) word.redirection = true
      word.text += character
    }
    word.end = Math.min(index + 1, segment.length)
  }
  flush()
  return words
}

// The names the design rule covers, longest first so `pnpm` is tried before
// its prefix `pn`.
const MANAGER_NAMES = ['pnpm', 'pnpx', 'pnx', 'pn', 'npm', 'npx', 'corepack']
// Words the shell reads as keywords or operators although they are not made of
// plain characters: a group or negation, an empty brace pair, and the subshell
// parentheses `shellWordDetails` emits as words of their own.
const SHELL_KEYWORD_WORDS = new Set(['!', '{', '}', '{}', '(', ')'])
const PNPM_FAMILY = new Set(['pnpm', 'pnpx', 'pnx', 'pn'])

// The name a word runs as a package manager, or null. A shell word is one
// program invocation, so the manager name must be the word's basename (the
// text after its last `/`) and must run to the end of the word, be followed by
// `@<spec>`, or be followed by an expansion marker that concatenates onto it: a
// literal character after the name (`pnpm version: x`, read from a quoted
// sentence) means the word is data, not an invocation. The basename rule finds
// a manager behind any path prefix (`node_modules/@pnpm/linux-x64/pnpm`,
// `./bin@/pnpm`), which the textual reader's character class misses, and the
// expansion rule still catches `pnpm` + a dynamic suffix (`pnpm`echo …``). A
// word whose basename is a manager names one however the path reads, so a URL
// (`https://host/npx`) fails closed as a manager line rather than being
// exempted — the basename of `./a://b/pnpm` is still `pnpm` that bash runs.
function managerName(text) {
  const basename = text.slice(text.lastIndexOf('/') + 1)
  for (const name of MANAGER_NAMES) {
    if (!basename.startsWith(name)) continue
    const after = basename[name.length]
    if (after === undefined || after === '@' || after === EXPANSION) return name
  }
  return null
}

function managerWordName(word) {
  return managerName(word.text)
}

// Whether the command that a package script's trailing argument words bind to
// runs a package manager. pnpm and npm append `run <script> -- <words>` (and
// pnpm appends a bare `pnpm <script> <words>`) to the end of the script's
// command string, so the words reach the last command of the last segment the
// shell runs, after the leading assignments, keywords and transparent prefixes
// such as `corepack`.
function scriptTerminalRunsManager(body) {
  const segments = shellCommandSegments(withoutHeredocBodies(body))
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const words = shellWords(segments[index])
    if (words.length === 0) continue
    const commandWord = words[commandWordIndex(words)]
    return commandWord !== undefined && managerName(commandWord) !== null
  }
  return false
}

// The scripts whose body runs a package manager at the position trailing words
// would reach, for every manager invocation in `command` that runs a script
// and passes it words. pnpm hands a script every word after it (after a `--`
// for a built-in `run`), and npm hands it the words after `--`; both append
// them to the script's command string, so a script ending in `pnpm install`
// would run that install with attacker-supplied options. The words cannot be
// audited as the inner command's, because the shell concatenates them onto a
// command the audit resolves separately, so passing any is rejected.
function passThroughScriptRejections(command, scriptCommands) {
  const rejections = new Set()
  for (const segment of shellCommandSegments(withoutHeredocBodies(command))) {
    const words = shellWordDetails(segment)
    const managerIndex = words.findIndex(word => managerWordName(word) !== null)
    if (managerIndex < 0) continue
    let index = managerIndex
    if (managerWordName(words[index]) === 'corepack') {
      const next = words[index + 1]
      if (
        next !== undefined &&
        (PNPM_FAMILY.has(managerWordName(next)) || managerWordName(next) === 'npm')
      ) {
        index += 1
      }
    }
    const name = managerWordName(words[index])
    const values = words.slice(index + 1).map(word => (word.plain ? word.text : word.raw))
    let scriptName
    let passThrough = []
    if (PNPM_FAMILY.has(name) && name !== 'pnpx' && name !== 'pnx') {
      const invocation = pnpmInvocation(values)
      if (pnpmRejection(invocation) !== null) continue
      const { command: pnpmCommand, commandIndex, operandIndex } = invocation
      if (pnpmCommand === 'run' || pnpmCommand === 'run-script') {
        if (operandIndex === undefined) continue
        scriptName = values[operandIndex]
        passThrough = values.slice(operandIndex + 1)
      } else if (
        pnpmCommand !== undefined &&
        !PNPM_BUILTIN_COMMANDS.has(pnpmCommand) &&
        !PNPM_SETTINGS_COMMANDS.has(pnpmCommand)
      ) {
        scriptName = pnpmCommand
        passThrough = values.slice(commandIndex + 1)
      }
    } else if (name === 'npm') {
      const runIndex = values.findIndex(value => value === 'run' || value === 'run-script')
      const delimiter = values.indexOf('--')
      if (runIndex >= 0 && delimiter > runIndex) {
        scriptName = values.slice(runIndex + 1, delimiter).find(value => !value.startsWith('-'))
        passThrough = values.slice(delimiter + 1)
      }
    }
    if (scriptName === undefined) continue
    // A `--` delimiter and the `)` or `}` that closes a subshell or group
    // around the command are not words passed to the script.
    if (!passThrough.some(word => word !== '--' && !SHELL_KEYWORD_WORDS.has(word))) continue
    if (scriptCommands(scriptName).some(scriptTerminalRunsManager)) {
      rejections.add(
        `words passed to the \`${scriptName}\` script reach a package manager it runs; pass none`
      )
    }
  }
  return rejections
}

// How many of `values` pnpm reads itself. It hands the rest to the script,
// binary or package it runs without parsing them (pnpm 11.28.9's parse-cli-args
// over nopt, checked against the real parser for every form the repository
// uses).
function pnpmReadCount(values) {
  const invocation = pnpmInvocation(values)
  const { command, commandIndex, operandIndex } = invocation
  if (pnpmRejection(invocation) !== null || command === undefined) return values.length
  if (command === 'exec') {
    const binary = values.findIndex((value, position) => position > commandIndex && value !== '--')
    return binary < 0 ? values.length : binary + 1
  }
  if (command === 'create') return Math.min(values.length, commandIndex + 2)
  if (!PNPM_BUILTIN_COMMANDS.has(command)) return commandIndex + 1
  if (command === 'dlx' || command === 'run' || command === 'run-script') {
    return operandIndex === undefined ? values.length : operandIndex + 1
  }
  return values.length
}

// The rejections for one shell command text under the design rule: every line
// that runs pnpm, pnpx, pnx, pn, npm, npx or Corepack is made of words the
// audit reads as they will run. Nothing in such a line is a redirection, a
// glob, xargs or a GitHub expression, and the manager's own path and name,
// every word in front of it, and every word the manager reads are plain
// literals. Only words pnpm hands to a script, binary or package unparsed may
// be computed, as the repository's own commands pass paths and versions that
// way. Substitution and inline shell bodies are lines of their own, and so is
// each line of a heredoc body, which `bash <<EOF` runs.
function managerLineRejections(command, { references = new Set(), depth = 0 } = {}) {
  const rejections = new Set()
  if (depth > 8) {
    rejections.add(`nested shell command is deeper than the audit follows: ${command.trim()}`)
    return rejections
  }
  const shellCommand = command
  for (const segment of shellCommandSegments(shellCommand)) {
    const words = shellWordDetails(segment)
    // A segment that names a manager word anywhere is a manager line: there is
    // no list of programs assumed to treat it as data, since a program by that
    // name can be shadowed (`echo() { "$@"; }; echo pnpm …`). A URL names no
    // manager (`managerName`), so `echo https://host/npx …` is not one.
    const managerIndex = words.findIndex(word => managerWordName(word) !== null)
    if (managerIndex >= 0) {
      for (const word of words) {
        if (word.redirection) {
          rejections.add(`package manager command line uses a shell redirection: ${word.raw}`)
        } else if (word.glob) {
          rejections.add(`package manager command line uses a shell glob: ${word.raw}`)
        }
        if (word.plain && word.text.slice(word.text.lastIndexOf('/') + 1) === 'xargs') {
          rejections.add(`package manager command line takes arguments through xargs: ${word.raw}`)
        }
        if (word.raw.includes('${{')) {
          rejections.add(
            `package manager command line holds a GitHub expression, which is substituted into the text before the shell reads it: ${word.raw}`
          )
        }
        if (word.raw.includes("$'")) {
          rejections.add(
            `ANSI-C quoting is rejected because it hides the text the shell runs: ${word.raw}`
          )
        }
      }
      let index = managerIndex
      let readEnd = words.length
      const after = position =>
        words.slice(position + 1).map(word => (word.plain ? word.text : word.raw))
      if (managerWordName(words[index]) === 'corepack') {
        const next = words[index + 1]
        if (next !== undefined && PNPM_FAMILY.has(managerWordName(next))) index += 1
      }
      const name = managerWordName(words[index])
      if (PNPM_FAMILY.has(name)) {
        const values = after(index)
        const invocationWords = name === 'pnpx' || name === 'pnx' ? ['dlx', ...values] : values
        // The line reader is authoritative for pnpm options and settings
        // commands, because the textual reader's manager regex never matches a
        // path-qualified pnpm (`node_modules/@pnpm/.../pnpm`), so its option
        // and settings checks would miss one.
        const rejection = pnpmRejection(pnpmInvocation(invocationWords))
        if (rejection !== null) rejections.add(rejection)
        readEnd =
          name === 'pnpx' || name === 'pnx'
            ? index + pnpmReadCount(['dlx', ...values])
            : index + 1 + pnpmReadCount(values)
      } else {
        // npm, npx and Corepack are read here too, from the manager's basename
        // onward, because the textual reader's manager regex also misses a
        // path-qualified `./v%/npx` or `./x@/npm`, so its settings, option and
        // pinning checks would miss one. The reconstructed command drops only
        // the directory prefix the shell would have run the binary from.
        // Built from the parsed words, not sliced from the raw segment, so a
        // quoted path (`"./x@/npm"`) leaves no stray quote to merge the
        // following words into one.
        const base = words[index].text.slice(words[index].text.lastIndexOf('/') + 1)
        const clean = [base, ...after(index)].join(' ')
        for (const reference of executablePackageReferences(clean, { rejections })) {
          references.add(reference)
        }
      }
      words.slice(0, readEnd).forEach((word, position) => {
        if (word.plain || word.redirection || word.glob || SHELL_KEYWORD_WORDS.has(word.raw)) return
        if (position < managerIndex && SHELL_ASSIGNMENT.test(word.raw)) return
        rejections.add(
          managerWordName(word) === null
            ? `package manager command line word is not a plain literal: ${word.raw}`
            : `package manager path or name is not a plain literal: ${word.raw}`
        )
      })
    }
    for (const body of inlineShellBodies(shellWords(segment))) {
      for (const rejection of managerLineRejections(body, { references, depth: depth + 1 })) {
        rejections.add(rejection)
      }
    }
  }
  for (const body of nestedShellBodies(shellCommand)) {
    for (const rejection of managerLineRejections(body, { references, depth: depth + 1 })) {
      rejections.add(rejection)
    }
  }
  return rejections
}

// ANSI-C quoting (`$'...'`) spells any character as an escape. It is rejected
// where it hides a package manager or its arguments (a manager segment, by
// `managerLineRejections`), and the decoded text is scanned for a guarded
// variable (`decodeAnsiCQuoting`), but a plain value such as `IFS=$'\n'` on a
// line with no manager runs nothing the audit must read.
const ANSI_C_QUOTING = /\$'(?:[^'\\]|\\[^])*'?/g
const ANSI_C_ESCAPE = /\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|.)/g
const ANSI_C_LETTERS = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['E', '\x1b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
])

function decodeAnsiCEscape(escape) {
  const lead = escape[0]
  if (lead === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16))
  if (lead === 'u' || lead === 'U') return String.fromCodePoint(parseInt(escape.slice(1), 16))
  if (lead >= '0' && lead <= '7') return String.fromCharCode(parseInt(escape, 8) & 0xff)
  return ANSI_C_LETTERS.get(lead) ?? lead
}

// The command with every `$'...'` replaced by the literal bytes it stands for,
// so a guarded variable or a manager spelled through ANSI-C escapes is read as
// the shell runs it (`$'pnpm\x5fconfig_registry=…'` becomes
// `pnpm_config_registry=…`). A malformed `$'` without a close is left as is.
function decodeAnsiCQuoting(command) {
  return command.replace(ANSI_C_QUOTING, match => {
    if (!match.endsWith("'") || match.length < 3) return match
    return match.slice(2, -1).replace(ANSI_C_ESCAPE, (_, escape) => decodeAnsiCEscape(escape))
  })
}

// The executable packages a command fetches, each of which must be pinned
// exactly. A pnpm command line the audit rejects outright, for an unreviewed
// option, a shell-rewritten argument, or a settings command, is added to
// `rejections` instead.
function executablePackageReferences(
  command,
  { fullEnvironment = false, depth = 0, rejections = new Set() } = {}
) {
  // A call body is always shorter than its command, so recursion terminates;
  // the cap only bounds pathological input and fails closed.
  if (depth > 8) return [command]
  const references = [...obfuscatedManagerReferences(command)]
  // Raw spans of `--call` bodies that were audited recursively. Manager
  // tokens inside them are skipped so the same text is not read again with
  // the outer command's quoting context.
  const auditedBodies = []
  const auditCallBody = (spans, segmentStart, call) => {
    if (!call || call.body === '') return
    const span = spans[call.index]
    auditedBodies.push([segmentStart + span.start, segmentStart + span.end])
    references.push(
      ...executablePackageReferences(call.body, { fullEnvironment, depth: depth + 1, rejections })
    )
  }
  // `pn` is pnpm 11's own short name for `pnpm`, as `pnx` is for `pnpx`.
  const managerPattern =
    /(?<![A-Za-z0-9_@./-])(?:(?:\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+)?(npm|npx|pnpm|pnpx|pnx|pn|yarnpkg|yarn|bunx|bun)(?![A-Za-z0-9_.-])/g
  for (const match of command.matchAll(managerPattern)) {
    if (auditedBodies.some(([start, end]) => match.index >= start && match.index < end)) {
      continue
    }
    const matchedManager = match[1]
    const manager =
      matchedManager === 'yarnpkg' ? 'yarn' : matchedManager === 'pn' ? 'pnpm' : matchedManager
    references.push(
      ...environmentResolutionOverrideReferences(
        fullEnvironment ? command : command.slice(0, match.index)
      )
    )
    let segmentStart = match.index + match[0].length
    const pnpmFamily = manager === 'pnpm' || manager === 'pnpx' || manager === 'pnx'
    // Corepack downloads `<manager>@<spec>` before running it, so the manager
    // itself is an executable package that must be pinned exactly. For pnpm it
    // runs that release in place of the pinned one, so the only pnpm spec
    // accepted is the packageManager pin itself, hash and all.
    const managerSpec = /^@[^\s;&|'"\\]*/.exec(command.slice(segmentStart))
    if (managerSpec) {
      const reference = `${matchedManager}${managerSpec[0]}`
      if (!pnpmFamily) {
        references.push(reference)
      } else if (managerSpec[0].slice(1) !== PINNED_PNPM_SPEC) {
        rejections.add(`pnpm release is not the reviewed packageManager pin: ${reference}`)
      }
      segmentStart += managerSpec[0].length
    }
    if (pnpmFamily) {
      if (isCorepackOperand(command, match.index)) continue
      // pnpx and pnx run `pnpm dlx` with their own arguments.
      const pnpmWords = shellWords(commandArgumentText(command, segmentStart))
      references.push(
        ...pnpmCommandReferences(manager === 'pnpm' ? pnpmWords : ['dlx', ...pnpmWords], rejections)
      )
      continue
    }
    const runnerSpans = shellWordSpans(shellCommandSegment(command, segmentStart))
    const runnerWords = runnerSpans.map(span => span.word)
    if (manager === 'npx') {
      references.push(...resolutionOverrideReferences(runnerWords))
      references.push(...npxArgumentReferences(runnerWords))
      auditCallBody(runnerSpans, segmentStart, callBodyReference(runnerWords, 0))
      continue
    }
    if (manager === 'bunx') {
      references.push(...resolutionOverrideReferences(runnerWords))
      references.push(...directRunnerArgumentReferences(runnerWords, 'bun'))
      continue
    }
    const words = withoutLeadingDelimiter(runnerWords, manager)
    const delimiter = words.indexOf('--')
    const commandWords = delimiter >= 0 ? words.slice(0, delimiter) : words
    references.push(...braceCommandWordReferences(commandWords, manager))
    if (manager === 'npm') {
      const settings = npmCommandCandidates(commandWords).find(npmChangesSettings)
      if (settings !== undefined) {
        rejections.add(`npm command that changes settings is rejected: npm ${settings}`)
        continue
      }
      const commandIndex = commandWords.findIndex(
        word => word === 'exec' || word === 'x' || NPM_INITIALIZER_COMMANDS.has(word)
      )
      if (commandWords[commandIndex] === 'exec' || commandWords[commandIndex] === 'x') {
        const prefixWords = commandWords.slice(0, commandIndex)
        references.push(...resolutionOverrideReferences(words))
        references.push(...npmPrefixOptionReferences(prefixWords, { packageOptions: true }))
        references.push(
          ...npmExecArgumentReferences(words.slice(commandIndex + 1), {
            leadingPackageReferences: packageOptionReferences(prefixWords),
          })
        )
        const execIndex = runnerWords.findIndex(word => word === 'exec' || word === 'x')
        auditCallBody(runnerSpans, segmentStart, callBodyReference(runnerWords, execIndex + 1))
      } else if (NPM_INITIALIZER_COMMANDS.has(commandWords[commandIndex])) {
        references.push(...resolutionOverrideReferences(words))
        references.push(...npmPrefixOptionReferences(commandWords.slice(0, commandIndex)))
        references.push(...npmInitializerArgumentReferences(words.slice(commandIndex + 1)))
      }
      references.push(...installReferences(words, 'npm'))
      continue
    }
    if (manager === 'yarn') {
      const commandIndex = commandWords.findIndex(word => word === 'dlx' || word === 'create')
      if (commandWords[commandIndex] === 'dlx') {
        references.push(...resolutionOverrideReferences(words))
        references.push(
          ...directRunnerArgumentReferences(words.slice(commandIndex + 1), 'yarn')
        )
      } else if (commandWords[commandIndex] === 'create') {
        references.push(...resolutionOverrideReferences(words))
        references.push(
          ...directInitializerArgumentReferences(words.slice(commandIndex + 1), 'yarn')
        )
      }
      references.push(...installReferences(words, 'yarn'))
      continue
    }
    if (manager === 'bun') {
      const commandIndex = commandWords.findIndex(word => word === 'x' || word === 'create')
      if (commandWords[commandIndex] === 'x') {
        references.push(...resolutionOverrideReferences(words))
        references.push(...directRunnerArgumentReferences(words.slice(commandIndex + 1), 'bun'))
      } else if (commandWords[commandIndex] === 'create') {
        references.push(...resolutionOverrideReferences(words))
        references.push(
          ...directInitializerArgumentReferences(words.slice(commandIndex + 1), 'bun')
        )
      }
      references.push(...installReferences(words, 'bun'))
    }
  }
  const corepackPattern =
    /(?<![A-Za-z0-9_@./-])(?:(?:\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+)?corepack(?![A-Za-z0-9_.-])/g
  for (const match of command.matchAll(corepackPattern)) {
    const words = shellWords(commandArgumentText(command, match.index + match[0].length))
    const rejected = corepackCommandRejection(words)
    if (rejected !== null) {
      rejections.add(
        `corepack command that changes which pnpm runs is rejected: corepack ${rejected}`
      )
    }
  }
  return [...new Set(references)]
}

function installReferences(words, manager) {
  const packages = packageInstallReferences(words, manager)
  if (packages === null) return []
  return [...resolutionOverrideReferences(words), ...packages]
}

// Shell words that precede the executable without being it.
const SHELL_COMMAND_KEYWORDS = new Set(['!', '(', '{', 'do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while'])
const TRANSPARENT_COMMAND_PREFIXES = new Set([
  'builtin',
  'command',
  'corepack',
  'env',
  'exec',
  'nice',
  'nohup',
  'sudo',
  'timeout',
  'xargs',
  'xvfb-run',
])
const ENV_VALUE_OPTIONS = new Set(['-C', '--chdir', '-S', '--split-string', '-u', '--unset'])
const SHELL_INTERPRETERS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh'])
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Heredoc bodies are data for the command that opened them, not commands.
function withoutHeredocBodies(command) {
  const lines = command.split('\n')
  const kept = []
  const terminators = []
  for (const line of lines) {
    if (terminators.length > 0) {
      if (line.trim() === terminators[0]) terminators.shift()
      continue
    }
    kept.push(line)
    for (const match of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      terminators.push(match[2])
    }
  }
  return kept.join('\n')
}

// Where a nested shell context opens, in the order the shell claims them:
// `$((` is arithmetic before `$(` is a command substitution. A command
// substitution runs inside double quotes too, but a process substitution is
// literal text there, and nothing opens inside single quotes.
const SHELL_SUBSTITUTION_OPENERS = [
  { opener: '$((', kind: 'arithmetic', quoted: true },
  { opener: '$(', kind: 'command', quoted: true },
  { opener: '`', kind: 'backtick', quoted: true },
  { opener: '<(', kind: 'process', quoted: false },
  { opener: '>(', kind: 'process', quoted: false },
]

function shellSubstitutionOpener(command, index, quote) {
  for (const substitution of SHELL_SUBSTITUTION_OPENERS) {
    if (!command.startsWith(substitution.opener, index)) continue
    return quote === '"' && !substitution.quoted ? null : substitution
  }
  return null
}

// Scans a shell body from `start` for the nested contexts that open at its
// own level, stopping at the `)` that closes the body when `closing` is set.
// The shell parses the body as a fresh command: a parenthesis inside quotes
// is data, a context nested inside closes before the enclosing one can, and
// a backslash outside single quotes escapes the next character. Line
// continuations are folded as everywhere else. `end` is the index of the
// closing `)`, or -1 when the scan ran to the end of the command instead.
function scanShellBody(command, start, closing) {
  const spans = []
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = start; index < command.length; index += 1) {
    const character = command[index]
    if (!escaped && quote !== "'") {
      const continuation = lineContinuationLength(command, index)
      if (continuation > 0) {
        index += continuation - 1
        continue
      }
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = null
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    const span = shellSubstitutionSpan(command, index, quote)
    if (span !== null) {
      spans.push(span)
      index = span.end - 1
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (!closing) continue
    if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) return { spans, end: index }
      depth -= 1
    }
  }
  return { spans, end: -1 }
}

// The nested shell context opening at `index` in the given quoting state, or
// null when none opens there. `bodyStart` and `bodyEnd` bound what the
// context runs; `end` is where the enclosing text resumes. Inside backticks
// the first backtick not escaped by a backslash closes the substitution
// whatever quotes surround it, which is what the shell does. An unterminated
// context is malformed shell: its body runs to the end of the command rather
// than being dropped, so the audit still reads everything it could have run.
function shellSubstitutionSpan(command, index, quote) {
  const substitution = shellSubstitutionOpener(command, index, quote)
  if (substitution === null) return null
  let { kind } = substitution
  let bodyStart = index + substitution.opener.length
  if (kind === 'backtick') {
    for (let position = bodyStart; position < command.length; position += 1) {
      if (command[position] === '\\') position += 1
      else if (command[position] === '`') {
        return { kind, bodyStart, bodyEnd: position, end: position + 1 }
      }
    }
    return { kind, bodyStart, bodyEnd: command.length, end: command.length }
  }
  let bodyEnd = scanShellBody(command, bodyStart, true).end
  if (kind === 'arithmetic') {
    if (bodyEnd >= 0 && command[bodyEnd + 1] === ')') {
      return { kind, bodyStart, bodyEnd, end: bodyEnd + 2 }
    }
    // Without a closing `))` the shell reads `$( (` as a command substitution
    // that opens a subshell, so the body is a command after all.
    kind = 'command'
    bodyStart = index + '$('.length
    bodyEnd = scanShellBody(command, bodyStart, true).end
  }
  if (bodyEnd < 0) return { kind, bodyStart, bodyEnd: command.length, end: command.length }
  return { kind, bodyStart, bodyEnd, end: bodyEnd + 1 }
}

// The bodies of every nested shell context in a command, outermost first:
// what its `$( ... )`, backtick, `<( ... )`, and `>( ... )` substitutions
// run, plus any command substitution an arithmetic expansion carries. Each
// body is returned as the shell that runs it would read it, so the caller
// parses it as a command of its own and finds the contexts nested in turn.
// Heredoc bodies are data and are removed by `withoutHeredocBodies` before a
// command is scanned.
export function nestedShellBodies(command) {
  const bodies = []
  for (const span of scanShellBody(command, 0, false).spans) {
    const body = command.slice(span.bodyStart, span.bodyEnd)
    if (span.kind === 'arithmetic') {
      bodies.push(...nestedShellBodies(body))
    } else if (span.kind === 'backtick') {
      // The shell drops the backslash that escapes `$`, a backtick, or another
      // backslash inside backticks, which is how a backtick body nests one
      // more substitution.
      bodies.push(body.replace(/\\([$`\\])/g, '$1'))
    } else {
      bodies.push(body)
    }
  }
  return bodies
}

export function shellCommandSegments(command) {
  const segments = []
  let start = 0
  let quote = null
  let escaped = false
  let conditional = false
  const boundaryBefore = index => index === 0 || /\s/.test(command[index - 1])
  // `[[` and `]]` are words, so a shell operator (`;`, `&`, `|`, `)`) ends them
  // as a blank does: `]]; then` and `[[ … ]]|| …` both close the conditional.
  const boundaryAfter = index =>
    index >= command.length || /\s/.test(command[index]) || ';&|)'.includes(command[index])
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    // A line continuation joins the next line into this command, so the
    // newline it carries never separates two commands. Single quotes keep the
    // pair literally, and a newline inside them is not a separator either.
    if (!escaped && quote !== "'") {
      const continuation = lineContinuationLength(command, index)
      if (continuation > 0) {
        index += continuation - 1
        continue
      }
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    // A substitution runs commands of its own, so a separator inside it ends
    // one of those, never the command carrying it; inside arithmetic it is
    // an operator. Single quotes keep all of it literal. Skipping the whole
    // span keeps `echo $(a; b)` one segment and `$(a; b) | c` two.
    if (quote !== "'") {
      const span = shellSubstitutionSpan(command, index, quote)
      if (span !== null) {
        index = span.end - 1
        continue
      }
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    // `||` and `&&` inside `[[ ... ]]` are test operators, not separators.
    if (command.startsWith('[[', index) && boundaryBefore(index) && boundaryAfter(index + 2)) {
      conditional = true
      index += 1
      continue
    }
    if (command.startsWith(']]', index) && boundaryBefore(index) && boundaryAfter(index + 2)) {
      conditional = false
      index += 1
      continue
    }
    if (conditional && (character === '&' || character === '|')) continue
    if (character === '\n' || character === ';' || character === '&' || character === '|') {
      segments.push(command.slice(start, index))
      start = index + 1
    }
  }
  segments.push(command.slice(start))
  return segments
}

// Index of the word that names the program a command segment runs, skipping
// the assignments, keywords, and transparent prefixes that precede it.
function commandWordIndex(words) {
  let index = 0
  let prefix = null
  while (index < words.length) {
    const word = words[index]
    if (SHELL_ASSIGNMENT.test(word) || (prefix === 'env' && word.includes('='))) {
      index += 1
      // `name=(...)` array assignments span words until the closing paren.
      if (/=\(/.test(word) && !word.endsWith(')')) {
        while (index < words.length && !words[index].endsWith(')')) index += 1
        index += 1
      }
      continue
    }
    if (SHELL_COMMAND_KEYWORDS.has(word)) {
      index += 1
      continue
    }
    if (TRANSPARENT_COMMAND_PREFIXES.has(word)) {
      prefix = word
      index += 1
      if (word === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(words[index] || '')) index += 1
      continue
    }
    if (prefix === 'env' && ENV_VALUE_OPTIONS.has(word)) {
      index += 2
      continue
    }
    if (prefix !== null && word.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  return index
}

// A parameter expansion, command substitution, or brace expansion in the
// executable's own name (`np${X}x`, `$RUNNER`, `$(printf npx)`, `np{x..x}`)
// can synthesize a package manager the textual audit never sees. Expansions
// inside a leading directory are permitted because the literal basename is
// still audited as a path-qualified runner.
function shellExpansionExecutableReferences(command, depth = 0) {
  const references = []
  if (depth > 8) return references
  const shellCommand = withoutHeredocBodies(command)
  for (const segment of shellCommandSegments(shellCommand)) {
    const words = shellWords(segment)
    const index = commandWordIndex(words)
    const executable = words[index]
    if (executable === undefined) continue
    const name = executable.slice(executable.lastIndexOf('/') + 1)
    // `shellWords` has already stripped quotes, so a quoted `"np{x..x}"` is
    // indistinguishable from the unquoted spelling that really expands. A
    // quoted brace group in a program name is nonsense nobody writes, so
    // failing closed on both costs nothing.
    if (/[$`]/.test(name) || braceExpands(name)) {
      references.push(executable)
      continue
    }
    // `eval`, `sh -c`, `npm exec -c`, and `npx -c` hand a body to a shell.
    for (const body of inlineShellBodies(words)) {
      references.push(...shellExpansionExecutableReferences(body, depth + 1))
    }
  }
  // A substitution runs its body as a command of its own, and the segment
  // carrying it only ever exposes its own command word (`echo` in
  // `echo "$(np${X}x tool)"`), so every nested body is examined in turn.
  for (const body of nestedShellBodies(shellCommand)) {
    references.push(...shellExpansionExecutableReferences(body, depth + 1))
  }
  return references
}

export function workflowRunCommands(source) {
  let workflow
  try {
    workflow = YAML.parse(source)
  } catch {
    return [source]
  }
  const commands = []
  const visited = new WeakSet()
  const inspect = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry)
      return
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === 'run' && typeof nestedValue === 'string') commands.push(nestedValue)
      inspect(nestedValue)
    }
  }
  inspect(workflow)
  return commands
}

// The values a workflow or action hands an action or a job's shell as
// commands, other than `run` bodies: every `with` input of a step that `uses`
// an action, since changesets/action runs its `version` and `publish` inputs
// and any action may run an input, and every `shell` template. Each is read as
// YAML has folded and unescaped it.
export function workflowActionInputs(source) {
  let workflow
  try {
    workflow = YAML.parse(source)
  } catch {
    return []
  }
  const inputs = []
  const visited = new WeakSet()
  const inspect = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry)
      return
    }
    if (typeof value.uses === 'string' && value.with && typeof value.with === 'object') {
      for (const [key, input] of Object.entries(value.with)) {
        if (typeof input === 'string') inputs.push({ key, value: input })
      }
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === 'shell' && typeof nestedValue === 'string')
        inputs.push({ key, value: nestedValue })
      inspect(nestedValue)
    }
  }
  inspect(workflow)
  return inputs
}

// An action input is a plain word list only if a shell and a split on
// whitespace read it alike: one line of unquoted plain words.
const PLAIN_INPUT = /^[A-Za-z0-9_@%+=:,./ -]*$/

// Tracked scripts a manifest script or a workflow/action `run` body hands off
// to, and whatever those scripts hand off to in turn. A command that names a
// repository script moves the work out of the audited manifest or YAML and
// into a file the audit never opened, so the script is audited with it.
const SHELL_SCRIPT_SUFFIX = /\.(?:bash|ksh|sh|zsh)$/
const SHELL_SOURCE_COMMANDS = new Set(['.', 'source'])
const SHELL_SHEBANG = /^#![^\n]*\b(?:bash|dash|ksh|sh|zsh)\b/
// `$(dirname "$0")` and `$(dirname "${BASH_SOURCE[0]}")` name the delegating
// script's own directory, so a delegation anchored to them still resolves to
// exactly one repository path. Quotes are already stripped by `shellWords`.
const SCRIPT_OWN_DIRECTORY = /^\$\(dirname(?:\s+--)?\s+(?:\$0|\$\{BASH_SOURCE\[0\]\})\)/

function repositoryDirectory(file) {
  const separator = file.lastIndexOf('/')
  return separator < 0 ? '' : file.slice(0, separator)
}

// Normalizes a repository-relative path, returning the empty string for the
// repository root and null for a path that climbs above it.
function normalizeRepositoryPath(base, reference) {
  const segments = []
  for (const segment of `${base === '' ? '' : `${base}/`}${reference}`.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') {
      segments.push(segment)
      continue
    }
    if (segments.length === 0) return null
    segments.pop()
  }
  return segments.join('/')
}

// Rewrites a delegated path into the repository path it names. The only
// expansion resolved is the delegating script's own directory, which stands for
// a single literal path; anything else still carrying an expansion is a target
// the audit cannot pin down and must fail closed on.
function repositoryPathExpression(reference, ownDirectory) {
  const own = SCRIPT_OWN_DIRECTORY.exec(reference)
  const path = own ? `${ownDirectory}${reference.slice(own[0].length)}` : reference
  if (/[$`]/.test(path)) return null
  return { path, anchored: Boolean(own) }
}

// The script argument an interpreter runs, or null when the interpreter is
// handed an inline body (`bash -c`) or nothing at all. An inline body is
// already audited as text by the caller's own command for the packages it
// runs, but a script it names is a delegation like any other, so the walk
// follows the body separately through `inlineShellBodies`.
function interpreterScriptArgument(words, startIndex) {
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index]
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return null
    if (word.startsWith('-')) continue
    return word
  }
  return null
}

// The bodies a command segment hands to another shell as text: `eval` runs
// its arguments, an interpreter's `-c` runs its next argument, and an
// `npm exec` / `npx` `--call` runs its body like `sh -c`. Each is parsed by
// the shell that receives it, so each is walked as a command of its own.
// Quotes are already stripped by `shellWords`, which is what that shell sees.
function inlineShellBodies(words) {
  const index = commandWordIndex(words)
  const executable = words[index]
  if (executable === undefined) return []
  const name = executable.slice(executable.lastIndexOf('/') + 1)
  if (name === 'eval') return index + 1 < words.length ? [words.slice(index + 1).join(' ')] : []
  if (SHELL_INTERPRETERS.has(name)) {
    const scriptIndex = words.findIndex(
      (word, position) => position > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(word)
    )
    return scriptIndex >= 0 && words[scriptIndex + 1] !== undefined ? [words[scriptIndex + 1]] : []
  }
  if (/^(?:npm|npx)(?:@|$)/.test(name)) {
    const call = callBodyReference(words, index + 1)
    return call && call.body !== '' ? [call.body] : []
  }
  return []
}

// A JavaScript interpreter runs the script operand it is handed, so
// `node scripts/x.mjs` moves a manifest's or workflow's commands into that
// file exactly as `bash scripts/x.sh` does, and the file has to be audited
// with it. `tsx` and `ts-node` take the same operand shape.
const JAVASCRIPT_INTERPRETERS = new Set(['node', 'nodejs', 'ts-node', 'tsx'])
// Interpreter options that consume the following word as their value. An
// option missing from this set is read as a flag, so its value is taken for
// the script operand and fails closed as a path that does not resolve; the
// fix is to add the option here. The reverse mistake would be worse: skipping
// an unknown option's next word blindly could swallow the real script.
const JAVASCRIPT_INTERPRETER_VALUE_OPTIONS = new Set([
  '-C',
  '-r',
  '--conditions',
  '--cpu-prof-dir',
  '--cpu-prof-name',
  '--diagnostic-dir',
  '--disable-warning',
  '--dns-result-order',
  '--env-file',
  '--env-file-if-exists',
  '--eval',
  '--experimental-default-type',
  '--experimental-loader',
  '--heap-prof-dir',
  '--heap-prof-name',
  '--heapsnapshot-signal',
  '--icu-data-dir',
  '--import',
  '--input-type',
  '--loader',
  '--localstorage-file',
  '--max-http-header-size',
  '--max-old-space-size',
  '--openssl-config',
  '--print',
  '--redirect-warnings',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  '--require',
  '--run',
  '--secure-heap',
  '--snapshot-blob',
  '--stack-trace-limit',
  '--test-concurrency',
  '--test-coverage-exclude',
  '--test-coverage-include',
  '--test-isolation',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
  '--title',
  '--tls-cipher-list',
  '--unhandled-rejections',
  '--watch-path',
  // ts-node and tsx
  '-I',
  '-O',
  '-P',
  '--compiler-options',
  '--cwd',
  '--ignore',
  '--project',
  '--tsconfig',
])
// Options whose value is a module the interpreter runs before the script.
const JAVASCRIPT_PRELOAD_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
])
// `-e` and `-p`, alone or clustered (`-pe`), evaluate the next word as the
// program; the long spellings take their value the same way.
const JAVASCRIPT_INLINE_SHORT_OPTION = /^-[A-Za-z]*[ep][A-Za-z]*$/
const JAVASCRIPT_INLINE_OPTIONS = new Set(['--eval', '--print'])
// A shell redirection word: an optional descriptor, the operator, and the
// target when it is attached (`2>&1`, `<<'EOF'` once unquoted, `>out`). A
// detached target is the next word.
const SHELL_REDIRECTION = /^(?:\d+|&)?(<<<|<<-?|<>|>>|>\||<|>)(.*)$/

// The scripts a JavaScript interpreter invocation runs. Interpreter options
// end at the first operand (or at `--`); everything after the script is the
// script's own argv. `--test` changes the shape: every operand is a test file,
// and with none named the runner discovers tests by its own rules, which the
// audit cannot enumerate and so fails closed on. An inline program (`-e`,
// `-p`, `-` for stdin, a heredoc) is the caller's own text and is already
// audited there, like `bash -c`. A preload the interpreter runs from a
// relative path is followed too; a bare preload specifier names an installed
// package, which the lockfile audit covers.
function javascriptInterpreterDelegation(words, index) {
  const preloads = []
  const operands = []
  let testRunner = false
  let optionsEnded = false
  let inline = false
  let stdinFile = null
  for (let position = index + 1; position < words.length; position += 1) {
    const word = words[position]
    // Redirections belong to the shell, not to the interpreter's argv. A file
    // redirected into stdin is the program when no operand names one.
    const redirection = SHELL_REDIRECTION.exec(word)
    if (redirection !== null) {
      const [, operator, attached] = redirection
      if (attached === '') position += 1
      const target = attached === '' ? words[position] : attached
      if (operator === '<' && target !== undefined) stdinFile = target
      continue
    }
    if (!optionsEnded && word === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && word.startsWith('-') && word !== '-') {
      const separator = word.startsWith('--') ? word.indexOf('=') : -1
      const option = separator < 0 ? word : word.slice(0, separator)
      let value = separator < 0 ? undefined : word.slice(separator + 1)
      const consumesValue =
        JAVASCRIPT_INTERPRETER_VALUE_OPTIONS.has(option) ||
        JAVASCRIPT_INLINE_SHORT_OPTION.test(option)
      if (separator < 0 && consumesValue) {
        position += 1
        value = words[position]
      }
      if (JAVASCRIPT_INLINE_OPTIONS.has(option) || JAVASCRIPT_INLINE_SHORT_OPTION.test(option)) {
        inline = true
      }
      if (option === '--test') testRunner = true
      if (JAVASCRIPT_PRELOAD_OPTIONS.has(option) && /^\.\.?\//.test(value || '')) {
        preloads.push(value)
      }
      continue
    }
    operands.push(word)
    if (!testRunner) optionsEnded = true
  }
  const references = [...preloads]
  if (testRunner) {
    if (operands.length === 0) {
      return { failure: 'discovery', reference: words.slice(index).join(' ') }
    }
    references.push(...operands)
  } else if (!inline) {
    const script = operands[0]
    if (script !== undefined && script !== '-') references.push(script)
    else if (stdinFile !== null) references.push(stdinFile)
  }
  return references.length === 0 ? null : { references, required: true }
}

// The scripts a command segment delegates to, if any. `required` marks a
// reference whose syntax can only be meant to resolve a repository script, so
// failing to resolve it must fail closed rather than drop the script silently.
// A `failure` is a delegation the audit can tell exists but cannot resolve at
// all; the walk reports it under `DELEGATED_SCRIPT_FAILURES`.
function segmentDelegation(words) {
  const index = commandWordIndex(words)
  const executable = words[index]
  if (executable === undefined) return null
  const name = executable.slice(executable.lastIndexOf('/') + 1)
  if (SHELL_INTERPRETERS.has(name)) {
    const target = interpreterScriptArgument(words, index + 1)
    return target === null ? null : { references: [target], required: true }
  }
  if (JAVASCRIPT_INTERPRETERS.has(name)) return javascriptInterpreterDelegation(words, index)
  if (SHELL_SOURCE_COMMANDS.has(executable)) {
    const target = words[index + 1]
    return target === undefined ? null : { references: [target], required: true }
  }
  // A dynamic name in executable position is already rejected outright by the
  // shell-expansion audit, so only literal paths are followed here. An
  // absolute path names a host tool, and a bare word without a script suffix
  // is resolved through PATH; neither is a repository script reference.
  if (/[$`]/.test(executable) || executable.startsWith('/')) return null
  if (!executable.includes('/') && !SHELL_SCRIPT_SUFFIX.test(executable)) return null
  return { references: [executable], required: SHELL_SCRIPT_SUFFIX.test(executable) }
}

const DELEGATED_SCRIPT_FAILURES = new Map([
  ['discovery', 'delegated test files are discovered at run time and cannot be enumerated'],
  ['dynamic', 'delegated script path is not a literal repository path'],
  ['escaping', 'delegated script path escapes the repository root'],
  ['untracked', 'delegated script is not a tracked repository file'],
])

// Dynamic references that a reviewer has read in place and resolved by hand.
// Each record binds one repository path to the exact tokens reviewed there and
// to the SHA-256 of the whole script as reviewed, so any edit to that script
// invalidates the record and restores the error. A record with a `target` is a
// delegation whose script the reviewer identified: the walk audits that target
// instead of dropping the edge, and fails closed if it stops being tracked. A
// record without one is an executable name that never resolves to a package
// manager. There is no rule here that generalizes: an unreviewed dynamic
// reference, or a reviewed one in a script that has since changed, is rejected
// exactly as before.
const REVIEWED_DYNAMIC_SCRIPT_REFERENCES = new Map([
  [
    'scripts/regtest/env.sh',
    {
      sha256: '184ced4473c1604f42d409e57deef97fa4be6435d9e7152788cf08491dbb5412',
      references: new Map([
        [
          '$QBIT_CLI_BIN',
          {
            disposition:
              'local qbit-cli path the operator supplies through QBIT_REGTEST_CLI, defaulted to empty; the repository never assigns it',
          },
        ],
      ]),
    },
  ],
  [
    'scripts/regtest/fund',
    {
      sha256: 'ee5a81d36c75467790518f11d5e72df543edd7c821f123c66e808c774e5b5864',
      references: new Map([
        [
          '$REGTEST_DIR/mine',
          {
            target: 'scripts/regtest/mine',
            disposition:
              'sibling regtest wrapper; scripts/regtest/env.sh binds REGTEST_DIR to this repository checkout',
          },
        ],
      ]),
    },
  ],
])

// The reviewed record covering `reference` in `file`, or undefined when there
// is none or the script no longer matches the source that was reviewed.
function reviewedDynamicReference(file, reference, source) {
  const record = REVIEWED_DYNAMIC_SCRIPT_REFERENCES.get(file)
  const reviewed = record?.references.get(reference)
  if (reviewed === undefined) return undefined
  return createHash('sha256').update(source).digest('hex') === record.sha256 ? reviewed : undefined
}

const GLOB_CHARACTERS = /[*?]/

// The pattern a glob operand stands for. The shell expands
// `node --test ./scripts/*.test.js` before the interpreter runs, and node's
// test runner expands a quoted glob itself, so either way the operand names
// every tracked file it matches. `*` and `?` stay inside one path segment;
// `**` crosses segments.
function globPattern(path) {
  let source = ''
  for (let index = 0; index < path.length; index += 1) {
    const character = path[index]
    if (character === '*' && path[index + 1] === '*') {
      index += 1
      if (path[index + 1] === '/') {
        index += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

// The tracked files a normalized repository path names: the file itself, or
// every match of a glob. A glob that matches nothing is as unresolved as a
// missing file, so the caller fails closed on it the same way.
function trackedScriptMatches(candidate, trackedScripts) {
  if (!GLOB_CHARACTERS.test(candidate)) return trackedScripts.has(candidate) ? [candidate] : []
  const pattern = globPattern(candidate)
  return [...trackedScripts].filter(tracked => pattern.test(tracked)).sort()
}

function resolveDelegatedScript(reference, file, trackedScripts) {
  const expression = repositoryPathExpression(reference, repositoryDirectory(file))
  if (expression === null) return { status: 'dynamic' }
  // An anchored path is already repository-relative; a bare relative path is
  // resolved against the directories a caller could plausibly run from — the
  // delegating file's own directory and every ancestor up to the repository
  // root. Widening the candidates only ever adds scripts to the audit; a path
  // that resolves under none of them fails closed.
  const bases = expression.anchored ? [''] : repositoryBaseDirectories(file)
  let escaping = true
  for (const base of bases) {
    const candidate = normalizeRepositoryPath(base, expression.path)
    if (candidate === null) continue
    escaping = false
    const files = trackedScriptMatches(candidate, trackedScripts)
    if (files.length > 0) return { status: 'tracked', files }
  }
  return { status: escaping ? 'escaping' : 'untracked' }
}

function repositoryBaseDirectories(file) {
  const bases = []
  let directory = repositoryDirectory(file)
  while (directory !== '') {
    bases.push(directory)
    directory = repositoryDirectory(directory)
  }
  bases.push('')
  return bases
}

const JAVASCRIPT_SCRIPT_SUFFIX = /\.(?:cjs|cts|js|mjs|mts|ts)$/
const TYPESCRIPT_SCRIPT_SUFFIX = /\.(?:cts|mts|ts)$/
const JAVASCRIPT_SHEBANG = /^#![^\n]*\b(?:node|nodejs|ts-node|tsx)\b/
// Child-process entry points whose arguments carry command text: Node's own
// child_process API and the execa and zx spellings. A callee is matched by
// its last name, so a bare imported `execSync`, `child_process.execSync`, and
// `cp.spawnSync` all count. What a textual audit cannot see is a call through
// another name: `promisify(exec)` bound to a local, a `run(command, args)`
// wrapper of the repository's own, or a module the script imports. Those are
// outside this audit in the same way a computed argument is, and closing
// them needs data flow, not more names here.
const CHILD_PROCESS_CALLEES = new Set([
  '$',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'execa',
  'execaSync',
  'execaCommand',
  'execaCommandSync',
  'spawn',
  'spawnSync',
])

// The name a call is made through, or null for a callee shape that carries
// no name. A property access on a regular-expression literal is
// `RegExp.prototype.exec`, never a child process.
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (
    ts.isPropertyAccessExpression(expression) &&
    !ts.isRegularExpressionLiteral(expression.expression)
  ) {
    return expression.name.text
  }
  return null
}

function isTextLiteral(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  )
}

function containsTextLiteral(node) {
  return isTextLiteral(node) || ts.forEachChild(node, containsTextLiteral) === true
}

// The source of a computed value, spelled as a single shell word.
function computedValueText(node, tree) {
  return node.getText(tree).replace(/\s+/g, '')
}

// The words one child-process argument contributes, in source order. A string
// literal is its text; a template with substitutions keeps its raw source
// between the backticks, so a `${runner}` in executable position is rejected
// by the shell-expansion audit exactly like `$RUNNER` in shell text. Object
// property values, nested parentheses, and any other expression are descended
// for the literal text inside them, so `join(root, 'scripts/x.sh')` and
// `root + '/scripts/x.sh'` still name the script they build. An array element
// or call argument is a positional slot: one with no literal text at all
// (`cli` in `['bash', cli, 'info']`) is rendered as the expansion `${cli}` so
// the literal after it is never read in its place, and reads as computed
// wherever it lands, exactly as a computed argument is outside the shell
// audits.
function argumentTexts(node, tree) {
  const texts = []
  const literal = child => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
      texts.push(child.text)
    } else if (ts.isTemplateExpression(child)) {
      texts.push(tree.text.slice(child.getStart(tree) + 1, child.getEnd() - 1))
    } else if (ts.isArrayLiteralExpression(child)) {
      child.elements.forEach(slot)
    } else if (ts.isPropertyAssignment(child)) {
      literal(child.initializer)
    } else {
      ts.forEachChild(child, literal)
    }
  }
  const slot = child => {
    if (
      ts.isArrayLiteralExpression(child) ||
      ts.isObjectLiteralExpression(child) ||
      containsTextLiteral(child)
    ) {
      literal(child)
    } else {
      texts.push(`\${${computedValueText(child, tree)}}`)
    }
  }
  slot(node)
  return texts
}

// The stand-in for a computed program name (`spawn(chromePath, [...])`): the
// expression's identifier characters behind a `computed:` marker, so that the
// word is read as a program the audit cannot name rather than as a shell
// keyword or prefix (`command`, `env`), an expansion, or a repository path.
// `process.execPath` is the running node, so a script it is handed is
// followed exactly like `node`'s.
function computedCommandWord(node, tree) {
  const text = computedValueText(node, tree)
  if (text === 'process.execPath') return 'node'
  return `computed:${text.replace(/[^A-Za-z0-9_]/g, '_')}`
}

// The `const` object literals a script declares once, by name. One is read
// like the literal it holds only while nothing can change it: no property of
// it, however deep, is written, `Object.assign`, `Object.defineProperty` and
// `Reflect.set` never take it, and it never escapes into another binding, a
// return value, an array or a call other than a child-process call, where a
// write could follow. Any other value is one the audit cannot read.
const OBJECT_WRITERS = new Set(['Object.assign', 'Object.defineProperty', 'Reflect.set'])

function rootIdentifier(expression) {
  let node = expression
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    node = node.expression
  }
  return ts.isIdentifier(node) ? node.text : null
}

function isAssignment(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
}

// The identifier names used as property values anywhere inside an object
// literal, so a const that stores one object inside another records which
// identifiers that container holds.
function objectMemberIdentifiers(node, names = []) {
  for (const property of node.properties ?? []) {
    if (ts.isPropertyAssignment(property)) {
      const value = property.initializer
      if (ts.isIdentifier(value)) names.push(value.text)
      else if (ts.isObjectLiteralExpression(value)) objectMemberIdentifiers(value, names)
    } else if (ts.isShorthandPropertyAssignment(property)) {
      names.push(property.name.text)
    } else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      names.push(property.expression.text)
    }
  }
  return names
}

function constantObjects(tree) {
  const declared = new Map()
  const members = new Map()
  const changed = new Set()
  const visit = node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const name = node.name.text
      const literal =
        declared.has(name) || !node.initializer || !ts.isObjectLiteralExpression(node.initializer)
          ? null
          : node.initializer
      declared.set(name, literal)
      if (literal !== null) members.set(name, objectMemberIdentifiers(literal))
    }
    if (isAssignment(node)) {
      const root = rootIdentifier(node.left)
      if (root !== null) changed.add(root)
    }
    if (ts.isCallExpression(node) && OBJECT_WRITERS.has(node.expression.getText(tree))) {
      const root = node.arguments[0] === undefined ? null : rootIdentifier(node.arguments[0])
      if (root !== null) changed.add(root)
    }
    if (ts.isIdentifier(node) && node.parent !== undefined) {
      const { parent } = node
      // An object a const holds as a property value is read like the literal it
      // is, so an identifier is unreadable only where it escapes somewhere a
      // write could reach it that the audit does not follow: a new binding, an
      // assignment, a return, an arrow body, an array, a new-expression, a
      // conditional or binary operand, or a call that is not a child-process
      // sink. Where it enters another object literal, that container carries
      // it, and the container's own mutations propagate to it below.
      const escapes =
        (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
        (isAssignment(parent) && parent.right === node) ||
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) && parent.body === node) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isNewExpression(parent) ||
        ts.isConditionalExpression(parent) ||
        ts.isBinaryExpression(parent) ||
        (ts.isCallExpression(parent) &&
          parent.arguments.includes(node) &&
          !CHILD_PROCESS_CALLEES.has(calleeName(parent.expression)))
      if (escapes) changed.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  // A changed container cannot be trusted to still hold the literals it was
  // declared with, so every object it holds is changed too, to a fixpoint.
  for (let growing = true; growing; ) {
    growing = false
    for (const [container, held] of members) {
      if (!changed.has(container)) continue
      for (const name of held) {
        if (!changed.has(name)) {
          changed.add(name)
          growing = true
        }
      }
    }
  }
  return name => (changed.has(name) ? null : (declared.get(name) ?? null))
}

// The object literal an options or environment expression stands for: the
// literal itself, or a constant holding one; null when the audit cannot read it.
function objectLiteralOf(node, constant) {
  if (ts.isObjectLiteralExpression(node)) return node
  if (ts.isIdentifier(node)) return constant(node.text)
  return null
}

// An options object (`{ encoding: 'utf8', stdio: 'inherit' }`) never carries
// command text, and read as trailing words its strings would be taken for
// operands, which under `node --test` are test paths. Only its `env` entries
// reach the child, and they reach it as environment assignments, so those are
// rendered as the `NAME=value` prefix words the shell audits already read:
// `{ env: { npm_config_registry: url } }` becomes `npm_config_registry=${url}`
// in front of the command, which the resolution-override audit reports
// exactly like the shell spelling. An options object or environment held in a
// constant is read the same way. `unreadable` is the first part the audit
// cannot read: an environment built by a call or held in a variable it cannot
// follow, a computed key, or a spread of anything but `process.env`.
function optionsEnvironment(node, tree, constant) {
  const texts = []
  const options = objectLiteralOf(node, constant)
  if (options === null) return { texts, unreadable: computedValueText(node, tree) }
  let unreadable = null
  const environment = (value, seen) => {
    if (value.getText(tree) === 'process.env') return
    const literal = objectLiteralOf(value, constant)
    if (literal === null || seen.has(literal)) {
      unreadable ??= computedValueText(value, tree)
      return
    }
    seen.add(literal)
    for (const entry of literal.properties) {
      if (ts.isSpreadAssignment(entry)) {
        environment(entry.expression, seen)
        continue
      }
      const name = entry.name === undefined ? null : propertyNameText(entry.name)
      if (name === null) {
        unreadable ??= computedValueText(entry.name ?? entry, tree)
        continue
      }
      if (ts.isShorthandPropertyAssignment(entry)) {
        texts.push(`${name}=\${${name}}`)
      } else if (ts.isPropertyAssignment(entry)) {
        const [value = ''] = argumentTexts(entry.initializer, tree)
        texts.push(`${name}=${value}`)
      } else {
        unreadable ??= computedValueText(entry, tree)
      }
    }
  }
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      unreadable ??= computedValueText(property.expression, tree)
      continue
    }
    if (property.name === undefined || propertyNameText(property.name) !== 'env') continue
    if (ts.isShorthandPropertyAssignment(property)) environment(property.name, new Set())
    else if (ts.isPropertyAssignment(property)) environment(property.initializer, new Set())
    else unreadable ??= computedValueText(property, tree)
  }
  return { texts, unreadable }
}

function propertyNameText(name) {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text
  }
  if (
    ts.isComputedPropertyName(name) &&
    isTextLiteral(name.expression) &&
    !ts.isTemplateExpression(name.expression)
  ) {
    return name.expression.text
  }
  return null
}

// Child-process calls whose first argument is a whole shell command; the rest
// take a program and then its argument array.
const COMMAND_STRING_CALLEES = new Set(['exec', 'execSync', 'execaCommand', 'execaCommandSync'])

// The command text one child-process call hands over, joined into a single
// shell-like command the existing audits read unchanged, or null when the
// call carries no literal text at all: literal text is what a textual audit
// can see, and `spawnSync(command, args)` shows it nothing. Only the argument
// array is read as words; every later argument is options or a callback.
function childProcessCommandText(call, tree, constant) {
  const [command, ...rest] = call.arguments
  const argumentCount = COMMAND_STRING_CALLEES.has(calleeName(call.expression)) ? 0 : 1
  const environment = []
  const arguments_ = []
  let unreadable = null
  rest.forEach((argument, position) => {
    if (ts.isFunctionLike(argument)) return
    const options =
      position >= argumentCount ||
      ts.isObjectLiteralExpression(argument) ||
      (ts.isIdentifier(argument) && constant(argument.text) !== null)
    if (!options) {
      arguments_.push(argument)
      return
    }
    const read = optionsEnvironment(argument, tree, constant)
    environment.push(...read.texts)
    unreadable ??= read.unreadable
  })
  if (command === undefined || ![command, ...arguments_].some(containsTextLiteral)) return null
  const words = containsTextLiteral(command)
    ? argumentTexts(command, tree)
    : [computedCommandWord(command, tree)]
  const text = [...words, ...arguments_.flatMap(argument => argumentTexts(argument, tree))].join(
    ' '
  )
  return { text: [...environment, text].join(' '), unreadable }
}

// Whether a rendered command runs a package manager or hands work to a script,
// either of which reads the environment it is given.
function commandReadsEnvironment(command) {
  return shellCommandSegments(command).some(segment => {
    const words = shellWordDetails(segment)
    return (
      words.some(word => managerWordName(word) !== null) ||
      segmentDelegation(shellWords(segment)) !== null
    )
  })
}

// Delegated scripts that name every variable the audit rejects because they
// are the audit: the policy and its tests. Their child-process commands and
// environment writes are still audited.
const AUDIT_VOCABULARY_SCRIPTS = new Set([
  'scripts/security/dependency-policy.mjs',
  'scripts/security/dependency-policy.test.mjs',
])

// What a JavaScript script does to the environment that the audit can see
// without running it: a rejected variable named in any string, template or
// property name, a rejected variable written to an object, and a write to
// `process.env` through a computed key or `Object.assign`.
function javascriptEnvironmentErrors(file, tree) {
  const errors = new Set()
  const mention = !AUDIT_VOCABULARY_SCRIPTS.has(file)
  const named = text => {
    for (const variable of REJECTED_VARIABLES) {
      if (!variable.anywhere) continue
      for (const match of text.matchAll(variable.anywhere))
        errors.add(`${variable.problem}: ${match[1]}`)
    }
  }
  // A key of `process.env` is matched in any case, as Windows reads it; a key
  // of another object, which may become an environment, as written.
  const written = (name, environment) => {
    for (const variable of REJECTED_VARIABLES) {
      if (new RegExp(`^(?:${variable.name})$`, environment ? 'i' : '').test(name)) {
        errors.add(`${variable.problem}: ${name}`)
      }
    }
  }
  const visit = node => {
    if (
      mention &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isIdentifier(node))
    ) {
      named(node.text)
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = node.left
      const environment =
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        target.expression.getText(tree) === 'process.env'
      if (ts.isPropertyAccessExpression(target)) written(target.name.text, environment)
      if (ts.isElementAccessExpression(target)) {
        const key = target.argumentExpression
        if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
          written(key.text, environment)
        else if (environment) {
          errors.add(
            `delegated JavaScript writes process.env through a key the audit cannot read: ${computedValueText(target, tree)}`
          )
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ['Object.assign', 'Object.defineProperty', 'Reflect.set'].includes(
        node.expression.getText(tree)
      ) &&
      node.arguments[0]?.getText(tree) === 'process.env'
    ) {
      errors.add(
        `delegated JavaScript writes process.env through a key the audit cannot read: ${computedValueText(node, tree)}`
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return [...errors]
}

// The literal command text a JavaScript script hands to child processes, one
// entry per call, or an error when the script does not parse. A partial tree
// from a script with syntax errors could drop the very call that matters, so
// the file fails closed instead. A `.ts` family suffix selects the TypeScript
// grammar; everything else is parsed as JavaScript.
function javascriptChildProcessCommands(file, source) {
  const kind = TYPESCRIPT_SCRIPT_SUFFIX.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  if (tree.parseDiagnostics.length > 0) {
    const diagnostic = tree.parseDiagnostics[0]
    const { line } = tree.getLineAndCharacterOfPosition(diagnostic.start)
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    return { error: `delegated JavaScript script cannot be parsed: line ${line + 1}: ${message}` }
  }
  const constant = constantObjects(tree)
  const commands = []
  const errors = javascriptEnvironmentErrors(file, tree)
  const visit = node => {
    if (ts.isCallExpression(node) && CHILD_PROCESS_CALLEES.has(calleeName(node.expression))) {
      const command = childProcessCommandText(node, tree, constant)
      if (command !== null) {
        commands.push(command.text)
        if (command.unreadable !== null && commandReadsEnvironment(command.text)) {
          errors.push(
            `delegated JavaScript hands a package manager or script an environment the audit cannot read: ${command.unreadable}`
          )
        }
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      // zx and execa run `$\`...\`` and `$({ options })\`...\`` alike.
      const tag = ts.isCallExpression(node.tag) ? node.tag.expression : node.tag
      if (calleeName(tag) === '$') commands.push(argumentTexts(node.template, tree).join(' '))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { commands, errors, javascript: true }
}

// The command text a reached script contributes to the audit: a shell script
// is audited whole, a JavaScript script through the literal command text it
// hands to child processes, and anything else is data a command merely names.
// Requiring a suffix or shebang keeps data files out of the audit without
// losing extensionless scripts.
function delegatedScriptCommands(file, source) {
  if (SHELL_SCRIPT_SUFFIX.test(file) || SHELL_SHEBANG.test(source)) {
    return { commands: [source], javascript: false }
  }
  if (JAVASCRIPT_SCRIPT_SUFFIX.test(file) || JAVASCRIPT_SHEBANG.test(source)) {
    return javascriptChildProcessCommands(file, source)
  }
  return null
}

// Walks manifest scripts and workflow or action `run` bodies into the tracked
// scripts they run, and on into whatever those scripts run in turn. Each file
// is walked once, which both terminates delegation cycles and keeps a script
// that several steps share from being audited more than once.
export function collectDelegatedScripts(entries, { trackedFiles: tracked, readTrackedFile }) {
  const trackedScripts = new Set(tracked)
  const errors = new Set()
  const scripts = []
  const walked = new Set()

  const walk = (file, commands, { source, javascript = false } = {}) => {
    if (walked.has(file)) return
    walked.add(file)
    for (const command of commands) {
      // A nested body is always shorter than the text carrying it, so the
      // walk terminates; the cap only bounds pathological input and fails
      // closed, since a body it never reads could name anything.
      const pending = [{ body: command, depth: 0 }]
      while (pending.length > 0) {
        const { body, depth } = pending.shift()
        if (depth > 8) {
          errors.add(
            `${file}: nested shell command is deeper than the audit follows: ${body.trim()}`
          )
          continue
        }
        const shellCommand = withoutHeredocBodies(body)
        for (const nested of nestedShellBodies(shellCommand)) {
          pending.push({ body: nested, depth: depth + 1 })
        }
        for (const segment of shellCommandSegments(shellCommand)) {
          const words = shellWords(segment)
          for (const nested of inlineShellBodies(words)) {
            pending.push({ body: nested, depth: depth + 1 })
          }
          const delegation = segmentDelegation(words)
          if (delegation === null) continue
          if (delegation.failure !== undefined) {
            errors.add(
              `${file}: ${DELEGATED_SCRIPT_FAILURES.get(delegation.failure)}: ${delegation.reference}`
            )
            continue
          }
          for (const reference of delegation.references) {
            const resolved = resolveDelegatedScript(reference, file, trackedScripts)
            // A reviewed record binds to the digest of the whole delegating
            // script (the command itself for a root entry), however deeply the
            // reference sits inside it.
            const reviewed = reviewedDynamicReference(file, reference, source ?? command)
            let targets = resolved.status === 'tracked' ? resolved.files : []
            // A reviewed delegation names the script it resolves to, so the walk
            // audits that script rather than dropping the edge. The record only
            // stands while the named target is still tracked.
            if (targets.length === 0 && reviewed?.target !== undefined) {
              if (!trackedScripts.has(reviewed.target)) {
                errors.add(
                  `${file}: reviewed delegated script target is not a tracked repository file: ${reviewed.target}`
                )
                continue
              }
              targets = [reviewed.target]
            }
            if (targets.length === 0) {
              // A computed operand in JavaScript (`spawnSync('bash', [cli])`) is
              // rendered as an expansion and is outside the textual audit like
              // every other computed argument there. An expansion in shell text
              // is a path the audit could never bind, so it still fails closed.
              const computed = javascript && resolved.status === 'dynamic'
              if (delegation.required && !computed) {
                errors.add(`${file}: ${DELEGATED_SCRIPT_FAILURES.get(resolved.status)}: ${reference}`)
              }
              continue
            }
            for (const target of targets) {
              if (walked.has(target)) continue
              const targetSource = readTrackedFile(target)
              const reached = delegatedScriptCommands(target, targetSource)
              if (reached === null) continue
              if (reached.error !== undefined) {
                walked.add(target)
                errors.add(`${target}: ${reached.error}`)
                continue
              }
              for (const error of reached.errors ?? []) errors.add(`${target}: ${error}`)
              scripts.push({
                file: target,
                commands: reached.commands,
                javascript: reached.javascript,
              })
              walk(target, reached.commands, {
                source: targetSource,
                javascript: reached.javascript,
              })
            }
          }
        }
      }
    }
  }

  for (const entry of entries) walk(entry.file, entry.commands)
  return { errors: [...errors], scripts }
}

export function auditExecutableDependencyCommands(
  commandFiles,
  { scriptCommands = () => [] } = {}
) {
  const errors = []
  let commandCount = 0
  for (const { file, commands, javascript = false } of commandFiles) {
    const workflowFile = /\.ya?ml$/.test(file)
    for (const command of commands) {
      commandCount += 1
      // Comments are not commands: YAML comments in a workflow, and shell
      // comments wherever a shell reads the text. JavaScript hands its words
      // to the child without a shell, so a `#` there is an argument.
      const text = workflowFile
        ? withoutYamlComments(command)
        : javascript
          ? command
          : withoutShellComments(command)
      const shellCommands = workflowFile
        ? workflowRunCommands(command).map(withoutShellComments)
        : [text]
      const inputs = workflowFile ? workflowActionInputs(command) : []
      const inputTexts = inputs.map(input => input.value)
      const rejections = new Set()
      const references = new Set()
      // A YAML block scalar drops the indentation its `run` body is written
      // with, so a line continuation only joins in the parsed body: `np\` +
      // newline + indent + `x` is two words in the raw source and `npx` in the
      // shell that runs it. Both spellings are audited, and a reference either
      // one exposes is reported once. ANSI-C quoting (`$'…'`) can spell a
      // manager, an option or a package through escapes the audit would read
      // literally, so every text is read again with that quoting decoded; a
      // decoded copy only ever reveals more.
      const referenceTexts = workflowFile ? [text, ...shellCommands, ...inputTexts] : [text]
      for (const referenceText of [...referenceTexts, ...referenceTexts.map(decodeAnsiCQuoting)]) {
        for (const reference of executablePackageReferences(referenceText, {
          fullEnvironment: workflowFile,
          rejections,
        })) {
          references.add(reference)
        }
      }
      // The line reader and the pass-through check run on the original texts
      // and on their ANSI-C decoding, so a manager, option or settings command
      // spelled through `$'…'` is read as the shell runs it. `IFS=$'\n'` stays
      // accepted: decoded it names no manager. A reference the reconstructed
      // manager line exposes is pinned with the rest.
      const lineTexts = [...shellCommands, ...inputTexts]
      for (const shellCommand of [...lineTexts, ...lineTexts.map(decodeAnsiCQuoting)]) {
        for (const rejection of managerLineRejections(shellCommand, { references })) {
          rejections.add(rejection)
        }
        for (const rejection of passThroughScriptRejections(shellCommand, scriptCommands)) {
          rejections.add(rejection)
        }
      }
      for (const input of inputs) {
        if (!managerLineRejections(input.value).size && !runsPackageManager(input.value)) continue
        if (!PLAIN_INPUT.test(input.value)) {
          rejections.add(
            `action input runs a package manager command that is not one line of plain words: ${input.key}`
          )
        }
      }
      for (const reference of references) {
        if (isPackageManagerPackage(referencedPackageName(reference))) {
          errors.push(
            `${file}: package manager must come from Corepack's packageManager pin: ${reference}`
          )
        } else if (!exactPackageVersion(reference)) {
          errors.push(`${file}: executable package is not pinned to an exact version: ${reference}`)
        }
      }
      for (const rejection of rejections) errors.push(`${file}: ${rejection}`)
      // A guarded variable is searched for in the command and in its ANSI-C
      // decoding, so `export $'pnpm\x5fconfig_registry=…'`, which sets one with
      // no manager on the line, is caught by the decoded spelling.
      const variableTexts = new Set([command, decodeAnsiCQuoting(command)])
      for (const variable of REJECTED_VARIABLES) {
        const names = new Set()
        for (const variableText of variableTexts) {
          for (const name of rejectedVariables(variableText, variable, { workflowFile })) {
            names.add(name)
          }
        }
        for (const name of names) errors.push(`${file}: ${variable.problem}: ${name}`)
      }
      for (const shellCommand of shellCommands) {
        for (const executable of shellExpansionExecutableReferences(shellCommand)) {
          // Only a record without a delegation target speaks to an executable
          // name; a reviewed delegation says nothing about what may run.
          const reviewed = reviewedDynamicReference(file, executable, command)
          if (reviewed !== undefined && reviewed.target === undefined) continue
          errors.push(`${file}: executable command name uses shell expansion: ${executable}`)
        }
      }
      const browserAlias = /\b(?:chrome|chromium|firefox)@(stable|latest|beta|canary)\b/g
      for (const match of command.matchAll(browserAlias)) {
        errors.push(`${file}: browser toolchain target is a mutable tag: ${match[0]}`)
      }
    }
  }
  return { commandCount, errors }
}

// Whether a text names a package manager the design rule covers as a word.
function runsPackageManager(command) {
  return shellCommandSegments(command).some(segment =>
    shellWordDetails(segment).some(word => managerWordName(word) !== null)
  )
}

function buildLicenseSnapshot(report) {
  const errors = []
  const packages = new Map()
  for (const [license, dependencies] of Object.entries(report)) {
    if (!Array.isArray(dependencies)) {
      errors.push(`license report group ${license} is not an array`)
      continue
    }
    for (const dependency of dependencies) {
      const key = `${dependency.name}@${dependency.version}`
      const previous = packages.get(key)
      if (previous && previous !== license) {
        errors.push(`${key} appears under conflicting licenses: ${previous} and ${license}`)
      }
      packages.set(key, license)
    }
  }
  return { errors, packages }
}

export function auditLicenseReport(report, verifyUnknownLicense = () => false) {
  const snapshot = buildLicenseSnapshot(report)
  const errors = [...snapshot.errors]
  for (const [key, license] of snapshot.packages) {
    if (APPROVED_LICENSE_EXPRESSIONS.has(license)) continue
    const evidence = UNKNOWN_LICENSE_EVIDENCE.get(key)
    if (license !== 'Unknown' || !evidence) {
      errors.push(`${key} has unapproved license expression: ${license}`)
      continue
    }
    const [name, ...versionParts] = key.split('@')
    const version = versionParts.pop()
    const dependencyName = name || `@${versionParts.join('@')}`
    if (!verifyUnknownLicense({ name: dependencyName, version }, evidence)) {
      errors.push(`${key} unknown-license evidence does not match the reviewed file`)
    }
  }
  if (snapshot.packages.size === 0) {
    errors.push('dependency license report contains no packages')
  }
  return { errors, packageCount: snapshot.packages.size, packages: snapshot.packages }
}

export function auditLicenseBaseline(report, baseline, verifyUnknownLicense = () => false) {
  const reportAudit = auditLicenseReport(report, verifyUnknownLicense)
  const errors = [...reportAudit.errors]
  if (baseline?.schemaVersion !== 1) {
    errors.push('license baseline must use schemaVersion 1')
  }
  if (baseline?.command !== LICENSE_COMMAND) {
    errors.push(`license baseline command must be ${LICENSE_COMMAND}`)
  }
  if (
    !baseline?.packages ||
    typeof baseline.packages !== 'object' ||
    Array.isArray(baseline.packages)
  ) {
    errors.push('license baseline packages must be an object')
    return { errors, packageCount: reportAudit.packageCount }
  }

  const baselineEntries = Object.entries(baseline.packages)
  if (baseline.packageCount !== baselineEntries.length) {
    errors.push('license baseline packageCount does not match its package records')
  }
  const baselineKeys = baselineEntries.map(([key]) => key)
  if (!arraysEqual(baselineKeys, sortedUnique(baselineKeys))) {
    errors.push('license baseline package records must be sorted and unique')
  }

  const baselinePackages = new Map(baselineEntries)
  for (const [key, license] of reportAudit.packages) {
    if (!baselinePackages.has(key)) {
      errors.push(`new license record requires review: ${key} -> ${license}`)
    } else if (baselinePackages.get(key) !== license) {
      errors.push(
        `license change requires review: ${key} ${baselinePackages.get(key)} -> ${license}`
      )
    }
  }
  for (const [key, license] of baselinePackages) {
    if (!reportAudit.packages.has(key)) {
      errors.push(`removed license record requires review: ${key} (${license})`)
    }
  }
  return { errors, packageCount: reportAudit.packageCount }
}

function lockPackageIdentity(lockKey) {
  const withoutPeers = lockKey.split('(')[0]
  const separator = withoutPeers.lastIndexOf('@')
  if (separator <= 0) return null
  return `${withoutPeers.slice(0, separator)}@${withoutPeers.slice(separator + 1)}`
}

function isPendingLicenseReview(license) {
  return typeof license === 'string' && /^pending-review(?::|$)/.test(license)
}

function splitPackageIdentity(identity) {
  const separator = identity.lastIndexOf('@')
  if (separator <= 0) return null
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  }
}

function lockfileLicenseIdentities(lockfileText) {
  const errors = []
  const identities = new Set()
  let lockfile
  try {
    lockfile = YAML.parse(lockfileText)
  } catch (error) {
    return {
      errors: [`cannot parse lockfile license identities: ${error.message.split('\n')[0]}`],
      identities,
    }
  }
  for (const lockKey of Object.keys(lockfile?.packages || {})) {
    const identity = lockPackageIdentity(lockKey)
    if (!identity) {
      errors.push(`cannot derive a package identity from lockfile key ${lockKey}`)
      continue
    }
    identities.add(identity)
  }
  if (identities.size === 0) {
    errors.push('pnpm-lock.yaml contains no package identities for license review')
  }
  return { errors, identities }
}

export function auditLockfileLicenseBaseline(
  lockfileText,
  baseline,
  verifyUnknownLicense = () => false,
  { allowPendingReview = false } = {}
) {
  const snapshot = lockfileLicenseIdentities(lockfileText)
  const errors = [...snapshot.errors]
  const pendingReview = []
  const lockfileSha256 = createHash('sha256').update(lockfileText).digest('hex')

  if (baseline?.schemaVersion !== 2) {
    errors.push('lockfile license baseline must use schemaVersion 2')
  }
  if (baseline?.source !== LOCKFILE_LICENSE_SOURCE) {
    errors.push(`lockfile license baseline source must be ${LOCKFILE_LICENSE_SOURCE}`)
  }
  if (baseline?.lockfileSha256 !== lockfileSha256) {
    errors.push(
      `license review is not bound to this lockfile: expected ${lockfileSha256}, found ${
        baseline?.lockfileSha256 || '(missing)'
      }`
    )
  }
  if (
    !baseline?.packages ||
    typeof baseline.packages !== 'object' ||
    Array.isArray(baseline.packages)
  ) {
    errors.push('lockfile license baseline packages must be an object')
    return { errors, packageCount: snapshot.identities.size, pendingReview }
  }

  const baselineEntries = Object.entries(baseline.packages)
  if (baseline.packageCount !== baselineEntries.length) {
    errors.push('lockfile license baseline packageCount does not match its package records')
  }
  const baselineKeys = baselineEntries.map(([key]) => key)
  if (!arraysEqual(baselineKeys, sortedUnique(baselineKeys))) {
    errors.push('lockfile license baseline package records must be sorted and unique')
  }

  const baselinePackages = new Map(baselineEntries)
  for (const identity of snapshot.identities) {
    if (!baselinePackages.has(identity)) {
      errors.push(`new lockfile license record requires review: ${identity}`)
    }
  }
  for (const [identity, license] of baselinePackages) {
    if (!snapshot.identities.has(identity)) {
      errors.push(`removed lockfile license record requires review: ${identity} (${license})`)
      continue
    }
    if (typeof license !== 'string' || !isNonEmptyString(license)) {
      errors.push(`${identity} has an invalid reviewed license expression`)
      continue
    }
    if (isPendingLicenseReview(license)) {
      pendingReview.push(identity)
      if (!allowPendingReview) {
        errors.push(`${identity} license record is pending review: ${license}`)
      }
      continue
    }
    if (APPROVED_LICENSE_EXPRESSIONS.has(license)) continue
    const evidence = UNKNOWN_LICENSE_EVIDENCE.get(identity)
    if (license !== 'Unknown' || !evidence) {
      errors.push(`${identity} has unapproved license expression: ${license}`)
      continue
    }
    const dependency = splitPackageIdentity(identity)
    if (!dependency || !verifyUnknownLicense(dependency, evidence)) {
      errors.push(`${identity} unknown-license evidence does not match the reviewed file`)
    }
  }

  return { errors, packageCount: snapshot.identities.size, pendingReview }
}

// Rebuilds the baseline for the current lockfile: reviewed records are kept,
// identities the lockfile no longer contains are dropped, and every new
// identity is persisted as pending review with the license expression observed
// in its installed manifest. Nothing is approved here; the policy fails closed
// until a reviewer replaces each pending marker.
export function buildLockfileLicenseBaseline(
  lockfileText,
  currentBaseline,
  observeLicense = () => null
) {
  const snapshot = lockfileLicenseIdentities(lockfileText)
  if (snapshot.errors.length > 0) {
    throw new Error(
      `cannot build lockfile license baseline:\n- ${snapshot.errors.join('\n- ')}`
    )
  }
  const reviewed = new Map(Object.entries(currentBaseline?.packages || {}))
  const packages = {}
  const added = []
  for (const identity of sortedUnique([...snapshot.identities])) {
    if (reviewed.has(identity)) {
      packages[identity] = reviewed.get(identity)
      continue
    }
    const observed = observeLicense(splitPackageIdentity(identity))
    packages[identity] = `${PENDING_LICENSE_REVIEW}: ${
      isNonEmptyString(observed) ? observed : 'license metadata unavailable'
    }`
    added.push(identity)
  }
  const removed = sortedUnique(
    [...reviewed.keys()].filter(identity => !snapshot.identities.has(identity))
  )
  return {
    baseline: {
      schemaVersion: 2,
      source: LOCKFILE_LICENSE_SOURCE,
      lockfileSha256: createHash('sha256').update(lockfileText).digest('hex'),
      packageCount: Object.keys(packages).length,
      packages,
    },
    added,
    removed,
  }
}

function normalizeAuditAdvisories(report) {
  const advisories = new Map()
  for (const advisory of Object.values(report.advisories || {})) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue
    const advisoryMatch = /\/(GHSA-[0-9a-z-]+)$/.exec(advisory.url || '')
    const advisoryId = advisoryMatch?.[1] || String(advisory.id || '')
    const key = `${advisoryId}|${advisory.module_name}`
    const previous = advisories.get(key) || {
      advisory: advisoryId,
      package: advisory.module_name,
      severity: advisory.severity,
      versions: [],
      paths: [],
    }
    previous.versions.push(...(advisory.findings || []).map(finding => finding.version))
    previous.paths.push(...(advisory.findings || []).flatMap(finding => finding.paths || []))
    previous.versions = sortedUnique(previous.versions)
    previous.paths = sortedUnique(previous.paths)
    advisories.set(key, previous)
  }
  return advisories
}

function validateRiskException(exception, now, errors) {
  const label = `${exception?.advisory || '(missing advisory)'} ${exception?.package || ''}`.trim()
  for (const field of [
    'advisory',
    'package',
    'severity',
    'reachability',
    'reachabilityAnalysis',
    'owner',
    'expiresOn',
    'removalPlan',
    'trackingIssue',
  ]) {
    if (!isNonEmptyString(exception?.[field])) {
      errors.push(`${label}: risk exception ${field} must be a non-empty string`)
    }
  }
  if (!/^GHSA-[0-9a-z-]+$/.test(exception?.advisory || '')) {
    errors.push(`${label}: risk exception advisory must be a GHSA identifier`)
  }
  if (!BLOCKING_SEVERITIES.has(exception?.severity)) {
    errors.push(`${label}: risk exception severity must be critical or high`)
  }
  if (!REACHABILITY_VALUES.has(exception?.reachability)) {
    errors.push(`${label}: risk exception reachability is invalid`)
  }
  if (!/^@[A-Za-z0-9-]+$/.test(exception?.owner || '')) {
    errors.push(`${label}: risk exception owner must be one accountable GitHub login`)
  }
  if (
    !/^https:\/\/github\.com\/Qbit-Org\/qbit-wallet\/issues\/\d+$/.test(
      exception?.trackingIssue || ''
    )
  ) {
    errors.push(`${label}: risk exception trackingIssue must be in Qbit-Org/qbit-wallet`)
  }

  for (const field of ['versions', 'paths', 'compensatingControls']) {
    const values = exception?.[field]
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some(value => !isNonEmptyString(value))
    ) {
      errors.push(`${label}: risk exception ${field} must be a non-empty string array`)
      continue
    }
    if (!arraysEqual(values, sortedUnique(values))) {
      errors.push(`${label}: risk exception ${field} must be sorted and unique`)
    }
  }

  if (!validDateOnly(exception?.expiresOn || '')) {
    errors.push(`${label}: risk exception expiresOn must be a valid YYYY-MM-DD date`)
  } else {
    const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
    const expiry = Date.parse(`${exception.expiresOn}T00:00:00.000Z`)
    if (expiry < today) {
      errors.push(`${label}: risk exception expired on ${exception.expiresOn}`)
    }
    if (expiry - today > MAX_EXCEPTION_DAYS * 24 * 60 * 60 * 1000) {
      errors.push(`${label}: risk exception expires more than ${MAX_EXCEPTION_DAYS} days away`)
    }
  }
}

function isFixedNonExecutableReachabilityFile(file) {
  return FIXED_NON_EXECUTABLE_REACHABILITY_FILES.has(file) || file.endsWith('.md')
}

function auditTrackedSourceAbsenceGuard(exception, context, errors) {
  const label = `${exception?.advisory || '(missing advisory)'} ${exception?.package || ''}`.trim()
  if (exception?.reachability !== 'demonstrably-unreachable') return true

  const guard = exception.reachabilityGuard
  let valid = true
  const fail = message => {
    valid = false
    errors.push(`${label}: ${message}`)
  }

  if (
    !hasExactObjectKeys(guard, ['type', 'references', 'allowedDependencyDeclaration']) ||
    guard?.type !== TRACKED_SOURCE_ABSENCE_GUARD
  ) {
    fail(
      `demonstrably-unreachable exceptions require an exact ${TRACKED_SOURCE_ABSENCE_GUARD} reachabilityGuard schema`
    )
    return false
  }

  const references = guard.references
  if (
    !Array.isArray(references) ||
    references.length === 0 ||
    references.some(reference => !isNonEmptyString(reference)) ||
    !arraysEqual(references, sortedUnique(references))
  ) {
    fail('reachabilityGuard references must be a sorted, unique, non-empty string array')
  }

  const declaration = guard.allowedDependencyDeclaration
  if (!hasExactObjectKeys(declaration, ['file', 'section', 'name', 'specifier'])) {
    fail('reachabilityGuard allowedDependencyDeclaration schema is malformed')
  } else {
    if (
      !validRepoRelativePath(declaration.file) ||
      basename(declaration.file) !== 'package.json' ||
      isFixedNonExecutableReachabilityFile(declaration.file)
    ) {
      fail('reachabilityGuard allowed dependency file must be a tracked package.json manifest')
    }
    if (!DEPENDENCY_SECTIONS.includes(declaration.section)) {
      fail('reachabilityGuard allowed dependency section is invalid')
    }
    if (!isNonEmptyString(declaration.name) || !isNonEmptyString(declaration.specifier)) {
      fail('reachabilityGuard allowed dependency name and specifier must be non-empty strings')
    }
    if (Array.isArray(references) && !references.includes(declaration.name)) {
      fail('reachabilityGuard references must include the allowed dependency name')
    }
  }

  if (
    !hasExactObjectKeys(context, ['files']) ||
    !Array.isArray(context?.files) ||
    context.files.length === 0
  ) {
    fail('reachabilityGuard requires a non-empty tracked-source context')
    return false
  }

  const sourceFiles = new Map()
  for (const record of context.files) {
    if (
      !hasExactObjectKeys(record, ['file', 'source']) ||
      !validRepoRelativePath(record?.file) ||
      typeof record?.source !== 'string'
    ) {
      fail('reachabilityGuard tracked-source context is malformed')
      continue
    }
    if (sourceFiles.has(record.file)) {
      fail(`reachabilityGuard tracked-source context has duplicate file: ${record.file}`)
      continue
    }
    sourceFiles.set(record.file, record.source)
  }

  // Exception paths are compared verbatim with pnpm audit's, so they are read
  // in pnpm 11's `<importer>>name>name` form with the evidence generator's
  // parser, against the importers of the tracked lockfile.
  if (
    Array.isArray(references) &&
    Array.isArray(exception?.paths) &&
    hasExactObjectKeys(declaration, ['file', 'section', 'name', 'specifier'])
  ) {
    let importers
    try {
      importers = YAML.parse(sourceFiles.get('pnpm-lock.yaml') ?? '')?.importers
    } catch {
      importers = undefined
    }
    if (!importers || typeof importers !== 'object' || Array.isArray(importers)) {
      fail('reachabilityGuard tracked-source context has no pnpm-lock.yaml importers')
    } else {
      const activationReferences = [declaration.name]
      for (const path of exception.paths) {
        let packages
        try {
          packages = parseAuditPath(path, importers).packages
        } catch (error) {
          fail(`reachabilityGuard ${error.message}`)
          continue
        }
        const declarationIndex = packages.indexOf(declaration.name)
        const invokedPackage = packages[declarationIndex + 1]
        if (declarationIndex < 0 || !invokedPackage) {
          fail(`reachabilityGuard allowed dependency is stale or incomplete for path: ${path}`)
          continue
        }
        activationReferences.push(invokedPackage)
      }
      if (!arraysEqual(references, sortedUnique(activationReferences))) {
        fail(
          'reachabilityGuard references must exactly cover the allowed dependency and its direct path activations'
        )
      }
    }
  }

  if (!hasExactObjectKeys(declaration, ['file', 'section', 'name', 'specifier'])) return false
  const manifestSource = sourceFiles.get(declaration.file)
  if (typeof manifestSource !== 'string') {
    fail(`reachabilityGuard allowed dependency manifest is not tracked: ${declaration.file}`)
    return false
  }

  let manifest
  try {
    JSON.parse(manifestSource)
    manifest = YAML.parse(manifestSource)
  } catch (error) {
    fail(
      `reachabilityGuard allowed dependency manifest cannot be parsed unambiguously: ${error.message.split('\n')[0]}`
    )
    return false
  }
  if (manifest?.[declaration.section]?.[declaration.name] !== declaration.specifier) {
    fail(
      `reachabilityGuard allowed dependency declaration is stale: ${declaration.file} ${declaration.section}.${declaration.name}`
    )
  }

  const containsGuardedReference = value =>
    typeof value === 'string' &&
    Array.isArray(references) &&
    references.some(reference => value.includes(reference))
  const forbiddenLocations = new Set()
  const inspectManifest = (value, path = []) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspectManifest(entry, [...path, String(index)]))
      return
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      const nextPath = [...path, key]
      const isAllowedDeclaration =
        nextPath.length === 2 &&
        nextPath[0] === declaration.section &&
        key === declaration.name &&
        nestedValue === declaration.specifier
      if (!isAllowedDeclaration && containsGuardedReference(key)) {
        forbiddenLocations.add(`${declaration.file}:${nextPath.join('.')}`)
      }
      if (!isAllowedDeclaration && containsGuardedReference(nestedValue)) {
        forbiddenLocations.add(`${declaration.file}:${nextPath.join('.')}`)
      }
      inspectManifest(nestedValue, nextPath)
    }
  }
  inspectManifest(manifest)

  for (const [file, source] of sourceFiles) {
    if (file === declaration.file || isFixedNonExecutableReachabilityFile(file)) continue
    if (containsGuardedReference(source)) forbiddenLocations.add(file)
  }
  for (const location of [...forbiddenLocations].sort((left, right) =>
    left.localeCompare(right, 'en')
  )) {
    fail(`reachabilityGuard found a forbidden tracked-source reference in ${location}`)
  }
  return valid
}

export function auditVulnerabilityReport(
  report,
  exceptionDocument,
  now = new Date(),
  trackedSourceContext
) {
  const errors = []
  if (!report || typeof report.advisories !== 'object' || !report.metadata?.vulnerabilities) {
    return {
      errors: ['pnpm audit output is missing advisories or vulnerability metadata'],
      acceptedCount: 0,
      blockingCount: 0,
    }
  }
  if (
    exceptionDocument?.schemaVersion !== RISK_EXCEPTION_SCHEMA_VERSION ||
    !Array.isArray(exceptionDocument.exceptions)
  ) {
    return {
      errors: [
        `dependency risk exceptions must use schemaVersion ${RISK_EXCEPTION_SCHEMA_VERSION} and an exceptions array`,
      ],
      acceptedCount: 0,
      blockingCount: 0,
    }
  }

  const declaredBlockingOccurrences = new Map()
  for (const severity of BLOCKING_SEVERITIES) {
    const count = report.metadata.vulnerabilities[severity]
    if (!Number.isInteger(count) || count < 0) {
      errors.push(`pnpm audit ${severity} vulnerability count must be a non-negative integer`)
    } else {
      declaredBlockingOccurrences.set(severity, count)
    }
  }

  const exceptionMap = new Map()
  const exceptionValidationResults = new Map()
  for (const exception of exceptionDocument.exceptions) {
    const previousErrorCount = errors.length
    validateRiskException(exception, now, errors)
    const key = `${exception?.advisory}|${exception?.package}`
    const guardPassed = auditTrackedSourceAbsenceGuard(exception, trackedSourceContext, errors)
    const exceptionValid = guardPassed && errors.length === previousErrorCount
    if (exceptionMap.has(key)) {
      errors.push(`${key}: duplicate dependency risk exception`)
      exceptionValidationResults.set(key, false)
    } else {
      exceptionValidationResults.set(key, exceptionValid)
    }
    exceptionMap.set(key, exception)
  }

  const advisories = normalizeAuditAdvisories(report)
  const observedBlockingOccurrences = new Map(
    [...BLOCKING_SEVERITIES].map(severity => [severity, 0])
  )
  for (const advisory of Object.values(report.advisories)) {
    if (!BLOCKING_SEVERITIES.has(advisory?.severity)) continue
    if (!Array.isArray(advisory.findings)) {
      errors.push(`pnpm audit ${advisory.severity} advisory is missing its findings array`)
      continue
    }
    observedBlockingOccurrences.set(
      advisory.severity,
      observedBlockingOccurrences.get(advisory.severity) + advisory.findings.length
    )
  }
  for (const [severity, declaredCount] of declaredBlockingOccurrences) {
    const observedCount = observedBlockingOccurrences.get(severity)
    if (declaredCount !== observedCount) {
      errors.push(
        `pnpm audit ${severity} metadata reports ${declaredCount} occurrences but advisory findings report ${observedCount}`
      )
    }
  }
  const declaredBlockingTotal = [...declaredBlockingOccurrences.values()].reduce(
    (total, count) => total + count,
    0
  )
  if (declaredBlockingTotal > 0 && advisories.size === 0) {
    errors.push('pnpm audit reports critical/high occurrences without advisory records')
  } else if (declaredBlockingTotal === 0 && advisories.size > 0) {
    errors.push('pnpm audit advisory records contradict zero critical/high occurrences')
  }
  let acceptedCount = 0
  for (const [key, advisory] of advisories) {
    const exception = exceptionMap.get(key)
    if (!exception) {
      errors.push(
        `unaccepted ${advisory.severity} advisory: ${advisory.advisory} ${advisory.package}`
      )
      continue
    }
    const matches =
      exception.severity === advisory.severity &&
      arraysEqual(exception.versions || [], advisory.versions) &&
      arraysEqual(exception.paths || [], advisory.paths)
    if (!matches) {
      errors.push(
        `${key}: advisory severity, versions, or paths changed from the accepted exception`
      )
      continue
    }
    if (!exceptionValidationResults.get(key)) continue
    acceptedCount += 1
  }
  for (const key of exceptionMap.keys()) {
    if (!advisories.has(key)) {
      errors.push(`${key}: stale dependency risk exception is no longer present in pnpm audit`)
    }
  }
  return { errors, acceptedCount, blockingCount: advisories.size }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function installedLicense(dependency, repoRoot) {
  const manifestPath = join(repoRoot, 'node_modules', dependency.name, 'package.json')
  if (!existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (manifest?.version !== dependency.version) return null
  if (isNonEmptyString(manifest.license)) return manifest.license
  if (isNonEmptyString(manifest.license?.type)) return manifest.license.type
  return null
}

function verifyUnknownLicense(dependency, evidence, repoRoot) {
  const packagePaths = [dependency.path, join(repoRoot, 'node_modules', dependency.name)].filter(
    packagePath => packagePath && existsSync(packagePath)
  )
  return packagePaths.some(packagePath => {
    const installedManifest = join(packagePath, 'package.json')
    if (
      !existsSync(installedManifest) ||
      JSON.parse(readFileSync(installedManifest, 'utf8')).version !== dependency.version
    ) {
      return false
    }
    return readdirSync(packagePath)
      .filter(name => /^(?:licen[cs]e|copying)/i.test(name))
      .some(name => sha256File(join(packagePath, name)) === evidence.sha256)
  })
}

// The committed inventory is reviewed evidence about one exact lockfile and
// one exact raw audit output, but nothing else in this policy reads it, so a
// dependency change that refreshes the license baseline can leave the
// inventory describing an older lockfile while the gate still reports PASS.
// Binding the digests it already records to the bytes actually committed is
// what makes the evidence self-checking. `auditedCommit` is deliberately not
// bound to HEAD: evidence is regenerated and committed after the source commit
// it audits, so it always names an earlier commit.
export function auditDependencyEvidence(inventoryText, lockfileText, auditText) {
  let inventory
  try {
    inventory = JSON.parse(inventoryText)
  } catch (error) {
    return {
      errors: [`${DEPENDENCY_INVENTORY_FILE} is not valid JSON: ${error.message}`],
      boundFiles: 0,
    }
  }
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return { errors: [`${DEPENDENCY_INVENTORY_FILE} must be a JSON object`], boundFiles: 0 }
  }

  const errors = []
  let boundFiles = 0
  if (inventory.schemaVersion !== DEPENDENCY_INVENTORY_SCHEMA_VERSION) {
    errors.push(
      `${DEPENDENCY_INVENTORY_FILE} must use schemaVersion ${DEPENDENCY_INVENTORY_SCHEMA_VERSION}`
    )
  }

  const lockfileSha256 = createHash('sha256').update(lockfileText).digest('hex')
  if (!isSha256Digest(inventory.lockfileSha256)) {
    errors.push(`${DEPENDENCY_INVENTORY_FILE} lockfileSha256 must be a sha256 hex digest`)
  } else if (inventory.lockfileSha256 !== lockfileSha256) {
    errors.push(
      `${DEPENDENCY_INVENTORY_FILE} is not bound to this pnpm-lock.yaml: expected ${lockfileSha256}, found ${inventory.lockfileSha256}`
    )
  } else {
    boundFiles += 1
  }

  const auditOutput = inventory.auditOutput
  if (!hasExactObjectKeys(auditOutput, ['file', 'sha256', 'command'])) {
    errors.push(
      `${DEPENDENCY_INVENTORY_FILE} auditOutput must record exactly file, sha256, and command`
    )
    return { errors, boundFiles }
  }
  if (auditOutput.file !== DEPENDENCY_AUDIT_FILE) {
    errors.push(
      `${DEPENDENCY_INVENTORY_FILE} auditOutput.file must be ${DEPENDENCY_AUDIT_FILE}, found ${JSON.stringify(auditOutput.file)}`
    )
  }
  if (auditOutput.command !== DEPENDENCY_AUDIT_COMMAND) {
    errors.push(
      `${DEPENDENCY_INVENTORY_FILE} auditOutput.command must be ${DEPENDENCY_AUDIT_COMMAND}, found ${JSON.stringify(auditOutput.command)}`
    )
  }
  const auditSha256 = createHash('sha256').update(auditText).digest('hex')
  if (!isSha256Digest(auditOutput.sha256)) {
    errors.push(`${DEPENDENCY_INVENTORY_FILE} auditOutput.sha256 must be a sha256 hex digest`)
  } else if (auditOutput.sha256 !== auditSha256) {
    errors.push(
      `${DEPENDENCY_INVENTORY_FILE} is not bound to this ${DEPENDENCY_AUDIT_FILE}: expected ${auditSha256}, found ${auditOutput.sha256}`
    )
  } else {
    boundFiles += 1
  }

  return { errors, boundFiles }
}

export function auditSubmoduleStatus(statusOutput) {
  const errors = []
  let submoduleCount = 0
  for (const line of statusOutput.replace(/\r\n?/g, '\n').split('\n').filter(Boolean)) {
    submoduleCount += 1
    const path = line.trim().split(/\s+/)[1] || '(unknown submodule)'
    if (line.startsWith('-')) {
      errors.push(`${path} submodule is not initialized`)
    } else if (line.startsWith('+')) {
      errors.push(`${path} submodule checkout does not match the recorded gitlink`)
    } else if (line.startsWith('U')) {
      errors.push(`${path} submodule has unresolved merge conflicts`)
    } else if (!line.startsWith(' ')) {
      errors.push(`${path} submodule has an unrecognized git status`)
    }
  }
  return { errors, submoduleCount }
}

export function trackedFiles(repoRoot) {
  const submoduleAudit = auditSubmoduleStatus(
    execFileSync('git', ['submodule', 'status', '--recursive'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
  )
  if (submoduleAudit.errors.length > 0) {
    throw new Error(
      `dependency policy cannot audit submodules:\n- ${submoduleAudit.errors.join('\n- ')}`
    )
  }
  return execFileSync('git', ['ls-files', '--cached', '--recurse-submodules', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
}

function runPnpmAudit(repoRoot) {
  const result = spawnSync('corepack', ['pnpm', 'audit', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`pnpm audit did not return valid JSON: ${error.message}`)
  }
  if (result.signal || ![0, 1].includes(result.status) || report.error) {
    throw new Error(
      `pnpm audit failed closed (status ${result.status ?? 'none'}): ${
        report.error?.summary || result.stderr.trim() || 'unknown error'
      }`
    )
  }
  return report
}

function writeLicenseBaseline(repoRoot) {
  const lockfileText = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const current = JSON.parse(readFileSync(join(repoRoot, LICENSE_BASELINE_FILE), 'utf8'))
  const { baseline, added, removed } = buildLockfileLicenseBaseline(
    lockfileText,
    current,
    dependency => installedLicense(dependency, repoRoot)
  )
  const audit = auditLockfileLicenseBaseline(
    lockfileText,
    baseline,
    (dependency, evidence) => verifyUnknownLicense(dependency, evidence, repoRoot),
    { allowPendingReview: true }
  )
  if (audit.errors.length > 0) {
    throw new Error(
      `cannot write incomplete or unreviewed lockfile license baseline:\n- ${audit.errors.join('\n- ')}`
    )
  }
  const output = join(repoRoot, LICENSE_BASELINE_FILE)
  writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`Wrote ${baseline.packageCount} license records to ${LICENSE_BASELINE_FILE}`)
  for (const identity of removed) {
    console.log(`Removed identity no longer in pnpm-lock.yaml: ${identity}`)
  }
  for (const identity of added) {
    console.log(`Added identity pending review: ${identity} (${baseline.packages[identity]})`)
  }
  if (audit.pendingReview.length > 0) {
    console.log(
      `${audit.pendingReview.length} license record(s) are pending review. Verify each package's license, replace the "${PENDING_LICENSE_REVIEW}: ..." value with the reviewed expression, and rerun the dependency policy; it fails closed until then.`
    )
  }
}

// The commands the repository runs, as the command audit reads them: every
// manifest's scripts, every workflow and action definition whole, and every
// tracked script those hand off to.
export function repositoryCommands(repoRoot, files = trackedFiles(repoRoot)) {
  const read = file => readFileSync(join(repoRoot, file), 'utf8')
  const manifests = files
    .filter(file => basename(file) === 'package.json')
    .map(file => ({ file, manifest: JSON.parse(read(file)) }))
  const actionFiles = files.filter(isAuditedActionFile).map(file => ({ file, source: read(file) }))
  const manifestCommands = manifests.map(({ file, manifest }) => ({
    file,
    commands: Object.values(manifest.scripts || {}).filter(command => typeof command === 'string'),
  }))
  // A manifest script and a `run:` body are both shell text the repository
  // executes, so a command in either that names a tracked script is followed
  // into that script. The whole YAML is still audited as text separately.
  const delegated = collectDelegatedScripts(
    [
      ...manifestCommands,
      ...actionFiles.map(({ file, source }) => ({ file, commands: workflowRunCommands(source) })),
    ],
    { trackedFiles: files, readTrackedFile: read }
  )
  const commandFiles = [
    ...manifestCommands,
    ...actionFiles.map(({ file, source }) => ({ file, commands: [source] })),
    ...delegated.scripts,
  ]
  // Every manifest's scripts by name, so a `run <script>` that passes words can
  // be resolved to the body those words reach (`passThroughScriptRejections`).
  const scriptBodies = new Map()
  for (const { manifest } of manifests) {
    for (const [name, body] of Object.entries(manifest.scripts || {})) {
      if (typeof body !== 'string') continue
      scriptBodies.set(name, (scriptBodies.get(name) ?? []).concat(body))
    }
  }
  const scriptCommands = name => scriptBodies.get(name) ?? []
  return { manifests, actionFiles, delegated, commandFiles, scriptCommands }
}

export function runDependencyPolicy(repoRoot) {
  const files = trackedFiles(repoRoot)
  const { manifests, actionFiles, delegated, commandFiles, scriptCommands } = repositoryCommands(
    repoRoot,
    files
  )
  const configFiles = files
    .filter(file => PACKAGE_MANAGER_CONFIG_FILE.test(file))
    .map(file => ({ file, source: readFileSync(join(repoRoot, file), 'utf8') }))

  const lockfileText = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const lockAudit = auditLockfile(lockfileText)
  const packageManagerAudit = auditWorkspacePackageManagers(manifests)
  const specifierAudit = auditDependencySpecifiers(manifests)
  const actionAudit = auditActionReferences(actionFiles)
  const workflowPermissionsAudit = auditWorkflowPermissions(
    actionFiles.filter(({ file }) => WORKFLOW_FILE.test(file))
  )
  const configAudit = auditPackageManagerConfigs(configFiles)
  const commandAudit = auditExecutableDependencyCommands(commandFiles, { scriptCommands })
  const licenseBaseline = JSON.parse(readFileSync(join(repoRoot, LICENSE_BASELINE_FILE), 'utf8'))
  const licenseAudit = auditLockfileLicenseBaseline(
    lockfileText,
    licenseBaseline,
    (dependency, evidence) => verifyUnknownLicense(dependency, evidence, repoRoot)
  )
  const evidenceAudit = auditDependencyEvidence(
    readFileSync(join(repoRoot, DEPENDENCY_INVENTORY_FILE), 'utf8'),
    lockfileText,
    readFileSync(join(repoRoot, DEPENDENCY_AUDIT_FILE), 'utf8')
  )
  const vulnerabilityReport = runPnpmAudit(repoRoot)
  const trackedSourceContext = {
    files: files.map(file => ({
      file,
      source: readFileSync(join(repoRoot, file), 'utf8'),
    })),
  }
  const vulnerabilityAudit = auditVulnerabilityReport(
    vulnerabilityReport,
    JSON.parse(readFileSync(join(repoRoot, RISK_EXCEPTIONS_FILE), 'utf8')),
    new Date(),
    trackedSourceContext
  )
  const errors = [
    ...lockAudit.errors,
    ...packageManagerAudit.errors,
    ...specifierAudit.errors,
    ...actionAudit.errors,
    ...workflowPermissionsAudit.errors,
    ...configAudit.errors,
    ...delegated.errors,
    ...commandAudit.errors,
    ...licenseAudit.errors,
    ...evidenceAudit.errors,
    ...vulnerabilityAudit.errors,
  ]

  if (errors.length > 0) {
    throw new Error(`dependency policy failed:\n- ${errors.join('\n- ')}`)
  }
  console.log(`Registry packages with sha512 integrity: ${lockAudit.packageCount}`)
  console.log(`Reviewed workspace package managers: ${packageManagerAudit.manifestCount}`)
  console.log(`Reviewed dependency specifiers: ${specifierAudit.specifierCount}`)
  console.log(`Commit-pinned GitHub Action references: ${actionAudit.actionCount}`)
  console.log(
    `Workflows with declared token permissions: ${workflowPermissionsAudit.workflowCount}`
  )
  console.log(
    `Checkout steps reviewed for persisted credentials: ${workflowPermissionsAudit.checkoutCount}`
  )
  console.log(`Reviewed package-manager configuration files: ${configAudit.configCount}`)
  console.log(`Reviewed executable dependency commands: ${commandAudit.commandCount}`)
  console.log(`Audited delegated scripts: ${delegated.scripts.length}`)
  console.log(`Exact dependency license records: ${licenseAudit.packageCount}`)
  console.log(`Dependency evidence files bound to reviewed digests: ${evidenceAudit.boundFiles}`)
  console.log(
    `Critical/high advisories: ${vulnerabilityAudit.blockingCount} (${vulnerabilityAudit.acceptedCount} accepted, 0 unaccepted)`
  )
  console.log('Dependency and license policy: PASS')
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDirectory, '../..')
  // pnpm forwards the `--` separator to scripts; npm strips it.
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  if (arraysEqual(args, ['--write-license-baseline'])) {
    writeLicenseBaseline(repoRoot)
  } else if (args.length === 0) {
    runDependencyPolicy(repoRoot)
  } else {
    throw new Error(`unsupported arguments: ${args.join(' ')}`)
  }
}
