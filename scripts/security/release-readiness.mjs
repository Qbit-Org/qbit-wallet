import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Owner check for the wallet's own Git remotes only.
export const EXPECTED_OWNER = 'Qbit-Org'
export const EXPECTED_REPOSITORY = 'Qbit-Org/qbit-wallet'
// Exact repositories that conformance/regtest builds may fetch executable Core
// and electrs inputs from. Not an owner-wide allowlist: any other Qbit-Org
// repository is external.
export const ALLOWED_EXECUTABLE_SOURCE_REPOSITORIES = Object.freeze([
  'Qbit-Org/qbit',
  'Qbit-Org/qbit-electrs',
])
export const PROTECTED_BRANCH = 'main'

export function parseGitHubRepository(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) return null
  const withoutCredentials = remoteUrl.replace(
    /^(https?:\/\/)[^/@]+@github\.com\//i,
    '$1github.com/'
  )
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      withoutCredentials
    )
  return match ? `${match[1]}/${match[2]}` : null
}

// The ownership audits parse this redacted value, so it must never turn a URL
// into a different repository: it strips only a user part that contains no
// `/` or `@`. A greedy redaction such as redactUrlCredentials would make
// `https://evil.example/x@github.com/Qbit-Org/qbit-wallet.git` pass.
export function redactRemoteUrl(remoteUrl) {
  const repository = parseGitHubRepository(remoteUrl)
  if (repository) return `https://github.com/${repository}.git`
  return remoteUrl.replace(/^(https?:\/\/)[^/@]+@/i, '$1[redacted]@')
}

export function auditRemoteRecords(records, expectedOwner = EXPECTED_OWNER) {
  const errors = []
  for (const record of records) {
    const repository = parseGitHubRepository(record.url)
    if (!repository) {
      errors.push(`${record.scope}:${record.remote}:${record.direction} is not a GitHub repository`)
      continue
    }
    const owner = repository.split('/')[0]
    if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
      errors.push(
        `${record.scope}:${record.remote}:${record.direction} targets ${repository}, not ${expectedOwner}`
      )
    }
  }
  return { errors, records }
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function remoteRecords(repoRoot, scope) {
  const records = []
  const names = git(repoRoot, ['remote']).split('\n').filter(Boolean)
  for (const remote of names) {
    for (const direction of ['fetch', 'push']) {
      const args = ['remote', 'get-url', '--all']
      if (direction === 'push') args.push('--push')
      args.push(remote)
      const urls = git(repoRoot, args).split('\n').filter(Boolean)
      for (const url of urls) {
        records.push({ scope, remote, direction, url: redactRemoteUrl(url) })
      }
    }
  }
  return records
}

// Audits the remotes of the root and of every submodule git reports as
// initialized, recursively. Each top-level submodule declared in the root
// `.gitmodules` must be among them. Only git-reported checkouts are entered,
// so a declared path is never joined to the repository root as written.
export function collectConfiguredRemotes(
  repoRoot,
  topLevelDeclarations = readSubmoduleDeclarations(repoRoot),
  checkouts = initializedSubmoduleCheckouts(repoRoot)
) {
  const records = remoteRecords(repoRoot, '.')
  for (const { path } of topLevelDeclarations) {
    if (path && !checkouts.includes(path)) {
      throw new Error(`submodule ${path} is not initialized`)
    }
  }
  for (const checkout of checkouts) {
    records.push(...remoteRecords(join(repoRoot, checkout), checkout))
  }
  return records
}

// git's own list of populated submodule checkouts, recursively, as
// root-relative paths (`$displaypath`, expanded by the shell that foreach
// runs). Asking git, rather than walking `.gitmodules` paths, leaves path
// validation (`..`, symlinks, nesting) to git.
export function initializedSubmoduleCheckouts(repoRoot) {
  let output
  try {
    output = git(repoRoot, ['submodule', 'foreach', '--quiet', '--recursive', 'echo "$displaypath"'])
  } catch (error) {
    throw new Error(`git cannot list the submodules: ${`${error.stderr || error.message}`.trim()}`)
  }
  const checkouts = output.split('\n').filter(Boolean)
  const outside = checkouts.find(path => path === '..' || path.startsWith('../') || path.startsWith('/'))
  if (outside) throw new Error(`git reported a submodule outside the repository: ${outside}`)
  return checkouts
}

// Reads every submodule declared in `.gitmodules`, keeping one whose URL is
// missing so the audit can report it instead of skipping it.
export function readSubmoduleDeclarations(repoRoot) {
  if (!existsSync(join(repoRoot, '.gitmodules'))) return []
  const result = spawnSync(
    'git',
    ['config', '--file', '.gitmodules', '-z', '--get-regexp', '^submodule\\.'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  // git config exits 1 when nothing matches; anything else is unreadable.
  if (result.status === 1 && result.stdout === '') return []
  if (result.status !== 0) {
    throw new Error(`cannot read .gitmodules: ${(result.stderr || 'git config failed').trim()}`)
  }

  const declarations = new Map()
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n')
    const key = separator === -1 ? entry : entry.slice(0, separator)
    const value = separator === -1 ? '' : entry.slice(separator + 1)
    const match = /^submodule\.(.+)\.(path|url)$/.exec(key)
    if (!match) continue
    const declaration = declarations.get(match[1]) || { name: match[1], path: null, url: null }
    declaration[match[2]] = value
    declarations.set(match[1], declaration)
  }
  return [...declarations.values()]
}

// CI initializes submodules with --recursive, so the declarations in each
// initialized submodule's `.gitmodules` count too. `parent` is the checkout
// whose `.gitmodules` declared it (null at the top level), and `path` is the
// declared value, relative to that checkout.
export function collectSubmoduleDeclarations(
  repoRoot,
  checkouts = initializedSubmoduleCheckouts(repoRoot)
) {
  const declarations = readSubmoduleDeclarations(repoRoot).map(declaration => ({
    ...declaration,
    parent: null,
  }))
  for (const checkout of checkouts) {
    for (const declaration of readSubmoduleDeclarations(join(repoRoot, checkout))) {
      declarations.push({ ...declaration, parent: checkout })
    }
  }
  return declarations
}

// Keeps the URL's scheme and form, so an SSH or scp-style URL is not
// reported as the HTTPS URL it would normalize to. Everything before the last
// `@` is redacted, except the conventional SSH user `git`, and so is a query
// or fragment, which can carry a token. That can over-redact a path
// containing `@`; the record's name and path still identify it. An accepted
// submodule URL has no `@`, `?` or `#`, so this leaves it unchanged.
function redactUrlCredentials(url) {
  const redactUser = user => (user === 'git' ? user : '[redacted]')
  const withoutUser = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
    ? url.replace(
        /^([a-z][a-z0-9+.-]*:\/\/)(.*)@/is,
        (_, scheme, user) => `${scheme}${redactUser(user)}@`
      )
    : url.replace(/^(.*)@(?=[^@]*$)/s, (_, user) => `${redactUser(user)}@`)
  return withoutUser.replace(/([?#]).*$/s, '$1[redacted]')
}

// A submodule URL qualifies for the anonymous probe only as an absolute https
// URL without embedded credentials. SSH and scp-style URLs need a key, and
// relative, local and plain-http URLs are not a public fetch location.
export function submoduleUrlProblem(url) {
  if (typeof url !== 'string' || url.trim().length === 0) return 'missing URL'
  if (/^\.\.?\//.test(url)) return 'relative URL; use an absolute https URL'
  if (/^[^/:\s]+@[^/:\s]+:/.test(url)) return 'scp-style SSH URL requires credentials'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase()
  if (!scheme) return 'not an absolute URL'
  if (scheme === 'ssh' || scheme === 'git+ssh') return 'SSH URL requires credentials'
  if (scheme !== 'https') return `${scheme}: URL is not anonymous HTTPS`
  // The raw string is checked before WHATWG URL parses it: the parser drops
  // control characters and whitespace, reads `\\` as `/` and accepts
  // `https:host`, which git reads differently, and an `@`, `?` or `#` can
  // hide userinfo or a token.
  if (url.includes('@')) return 'URL embeds credentials'
  const controlOrSpace = [...url].some(character => character <= ' ' || character === '\x7f')
  if (controlOrSpace || !/^https:\/\/[^/\\?#][^\\?#]*$/i.test(url)) return 'malformed HTTPS URL'
  try {
    if (new URL(url).hostname) return null
  } catch {
    // Reported below.
  }
  return 'malformed HTTPS URL'
}

// No inherited variable reaches git: credentials can come from the GitHub
// token variables, GIT_CONFIG_COUNT/KEY/VALUE pairs (as the CI submodule step
// passes them), GIT_CONFIG_PARAMETERS, askpass programs or global, system and
// repository config. The probe runs outside any repository with only PATH.
// Proxy variables are dropped too, because proxy settings such as
// http.proxyAuthMethod live in the global config this skips; a machine that
// can reach GitHub only through a proxy fails closed with the connect error.
export function anonymousGitEnvironment(home, inheritedEnv = process.env) {
  return {
    PATH: inheritedEnv.PATH || '',
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'no-global-config'),
    GIT_CEILING_DIRECTORIES: dirname(home),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    LC_ALL: 'C',
  }
}

export function probeAnonymousFetch(
  url,
  { gitBinary = 'git', timeoutMs = 30_000, inheritedEnv = process.env } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'qbit-anonymous-git-'))
  try {
    const result = spawnSync(
      gitBinary,
      [
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        'ls-remote',
        '--',
        url,
        'HEAD',
      ],
      {
        cwd: home,
        env: anonymousGitEnvironment(home, inheritedEnv),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      }
    )
    if (result.error?.code === 'ETIMEDOUT') {
      return { fetchable: false, reason: `git ls-remote timed out after ${timeoutMs} ms` }
    }
    if (result.error) {
      return { fetchable: false, reason: `git ls-remote failed: ${result.error.message}` }
    }
    if (result.status === 0) return { fetchable: true }
    const detail = `${result.stderr || result.stdout || ''}`.trim().split('\n').pop()
    const exit = `git ls-remote exited ${result.status ?? result.signal}`
    return { fetchable: false, reason: detail ? `${exit}: ${detail.slice(0, 300)}` : exit }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// Outside contributors, and CI for their pull requests, clone the submodules
// with no token, so each one must be fetchable anonymously before the
// repository can be public.
export function auditSubmoduleFetchability(
  declarations,
  { offline = false, probe = probeAnonymousFetch } = {}
) {
  // The same URL declared twice is probed once.
  const probed = new Map()
  const probeOnce = url => {
    if (!probed.has(url)) probed.set(url, probe(url))
    return probed.get(url)
  }
  const submodules = declarations.map(({ name, path, parent, url }) => {
    const record = {
      name,
      path,
      ...(parent ? { parent } : {}),
      url: typeof url === 'string' ? redactUrlCredentials(url) : null,
    }
    const problem = submoduleUrlProblem(url)
    if (problem) return { ...record, fetchable: false, reason: problem }
    if (offline) return { ...record, fetchable: null, reason: 'offline check requested' }
    // Anything but an explicit success counts as not fetchable.
    const outcome = probeOnce(url)
    if (outcome?.fetchable === true) return { ...record, fetchable: true }
    return { ...record, fetchable: false, reason: outcome?.reason || 'probe gave no result' }
  })
  const notFetchable = submodules.filter(submodule => submodule.fetchable === false)
  const unknown = submodules.filter(submodule => submodule.fetchable === null)
  return {
    submodules,
    notFetchable,
    unknown,
    status: notFetchable.length > 0 ? 'human-gate' : unknown.length > 0 ? 'unknown' : 'pass',
  }
}

export function auditExpectedOrigin(records) {
  const rootOrigin = records.filter(record => record.scope === '.' && record.remote === 'origin')
  const directions = new Set(rootOrigin.map(record => record.direction))
  const errors = []
  if (!directions.has('fetch')) errors.push('root origin is missing a fetch URL')
  if (!directions.has('push')) errors.push('root origin is missing a push URL')
  for (const record of rootOrigin) {
    if (parseGitHubRepository(record.url)?.toLowerCase() !== EXPECTED_REPOSITORY.toLowerCase()) {
      errors.push(`root origin ${record.direction} must target ${EXPECTED_REPOSITORY}`)
    }
  }
  return errors
}

function parseWorkflowRepositorySource(line) {
  const assignment = /^\s*(?:QBIT_REPO|ELECTRS_QBIT_REPO):\s*(.*?)\s*$/.exec(line)
  if (!assignment) return null

  const value = assignment[1]
  const quotedRepository = /['"]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]/.exec(value)
  const literalRepository = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\s+#.*)?$/.exec(value)
  const dynamicSelectors = []
  for (const expression of value.matchAll(/\$\{\{(.*?)\}\}/g)) {
    for (const selector of expression[1].matchAll(/\bvars\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const name = `vars.${selector[1]}`
      if (!dynamicSelectors.includes(name)) dynamicSelectors.push(name)
    }
  }

  const repository = quotedRepository?.[1] || literalRepository?.[1] || null
  if (!repository && dynamicSelectors.length === 0) return null
  return {
    repository,
    ...(dynamicSelectors.length > 0 ? { dynamicSelectors } : {}),
  }
}

function parseComposeRepositorySource(line) {
  const assignment = /^\s*(?:QBIT_REPO|ELECTRS_QBIT_REPO):\s*(.*?)\s*$/.exec(line)
  if (!assignment) return null

  const value = assignment[1]
  const fallbackRepository =
    /\$\{[A-Za-z_][A-Za-z0-9_]*:-([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\}/.exec(value)
  const literalRepository =
    /^['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]?(?:\s+#.*)?$/.exec(value)
  const dynamicSelectors = []
  for (const selector of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)) {
    const name = `env.${selector[1]}`
    if (!dynamicSelectors.includes(name)) dynamicSelectors.push(name)
  }

  const repository = fallbackRepository?.[1] || literalRepository?.[1] || null
  if (!repository && dynamicSelectors.length === 0) return null
  return {
    repository,
    ...(dynamicSelectors.length > 0 ? { dynamicSelectors } : {}),
  }
}

export function collectExecutableSourceRepositories(repoRoot) {
  const sources = []
  const pinPath = join(repoRoot, 'scripts/conformance/core-pin.json')
  if (existsSync(pinPath)) {
    const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
    for (const key of ['sourceBaseline', 'runtimeRelease']) {
      if (pin[key]?.repository) {
        sources.push({
          source: `scripts/conformance/core-pin.json:${key}`,
          repository: pin[key].repository,
        })
      }
    }
  }

  for (const relativePath of [
    'docker/regtest/qbitd-release.Dockerfile',
    'docker/regtest/electrs-qbit-source.Dockerfile',
    '.github/workflows/build-regtest-images.yml',
    '.github/workflows/qbit-conformance.yml',
    'docker-compose.regtest.yml',
  ]) {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8')
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      let record
      if (relativePath.endsWith('Dockerfile')) {
        const match =
          /^\s*ARG (?:QBIT_REPO|ELECTRS_QBIT_REPO)=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*$/.exec(
            line
          )
        record = match ? { repository: match[1] } : null
      } else if (relativePath === 'docker-compose.regtest.yml') {
        record = parseComposeRepositorySource(line)
      } else {
        record = parseWorkflowRepositorySource(line)
      }
      if (record) {
        sources.push({
          source: `${relativePath}:${index + 1}`,
          ...record,
        })
      }
    }
  }
  return sources
}

export function auditExecutableSources(
  sources,
  allowedRepositories = ALLOWED_EXECUTABLE_SOURCE_REPOSITORIES
) {
  const allowed = new Set(allowedRepositories.map(repository => repository.toLowerCase()))
  const external = sources.filter(
    ({ repository }) => typeof repository === 'string' && !allowed.has(repository.toLowerCase())
  )
  const dynamic = sources.filter(({ dynamicSelectors }) => dynamicSelectors?.length > 0)
  return {
    sources,
    external,
    dynamic,
    status: external.length === 0 && dynamic.length === 0 ? 'pass' : 'human-gate',
  }
}

export function mapMainProtection(protection) {
  const requiredReviews = protection?.required_pull_request_reviews
  const approvingReviewCount = requiredReviews?.required_approving_review_count
  const requiredChecks = protection?.required_status_checks
  const hasNamedCheck =
    (Array.isArray(requiredChecks?.checks) &&
      requiredChecks.checks.some(
        check => typeof check?.context === 'string' && check.context.trim().length > 0
      )) ||
    (Array.isArray(requiredChecks?.contexts) &&
      requiredChecks.contexts.some(
        context => typeof context === 'string' && context.trim().length > 0
      ))

  return {
    status: 'present',
    requiredPullRequestReviews:
      Number.isSafeInteger(approvingReviewCount) && approvingReviewCount > 0,
    requiredStatusChecks: hasNamedCheck,
    enforceAdmins: Boolean(protection?.enforce_admins?.enabled),
    requiredCodeOwnerReviews: Boolean(requiredReviews?.require_code_owner_reviews),
  }
}

const PROTECTION_SETTINGS = [
  'requiredPullRequestReviews',
  'requiredStatusChecks',
  'requiredCodeOwnerReviews',
]

// Maps the active repository rules that apply to a branch
// (`GET repos/{repo}/rules/branches/{branch}`) onto the same settings as the
// classic protection API. `rulesetsById` holds `GET repos/{repo}/rulesets/{id}`
// responses. A setting binds administrators only when a ruleset that supplies
// it is readable and lists no bypass actors; `enforceAdmins` requires that for
// every supplied setting.
export function mapMainRulesets(rules, rulesetsById = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return { status: 'missing' }

  const providers = Object.fromEntries(PROTECTION_SETTINGS.map(setting => [setting, []]))
  for (const rule of rules) {
    if (rule?.type === 'pull_request') {
      const count = rule.parameters?.required_approving_review_count
      if (Number.isSafeInteger(count) && count > 0) {
        providers.requiredPullRequestReviews.push(rule.ruleset_id)
      }
      if (rule.parameters?.require_code_owner_review === true) {
        providers.requiredCodeOwnerReviews.push(rule.ruleset_id)
      }
    } else if (rule?.type === 'required_status_checks') {
      const checks = rule.parameters?.required_status_checks
      if (
        Array.isArray(checks) &&
        checks.some(check => typeof check?.context === 'string' && check.context.trim().length > 0)
      ) {
        providers.requiredStatusChecks.push(rule.ruleset_id)
      }
    }
  }

  const bindsAdmins = id => {
    const bypassActors = rulesetsById[id]?.bypass_actors
    return Array.isArray(bypassActors) && bypassActors.length === 0
  }
  const settings = {}
  const adminEnforcedSettings = {}
  for (const setting of PROTECTION_SETTINGS) {
    settings[setting] = providers[setting].length > 0
    adminEnforcedSettings[setting] = providers[setting].some(bindsAdmins)
  }

  return {
    status: 'present',
    source: 'ruleset',
    rulesetIds: [...new Set(rules.map(rule => rule.ruleset_id))].sort((a, b) => a - b),
    ...settings,
    enforceAdmins: allSuppliedSettingsBindAdmins(settings, adminEnforcedSettings),
    adminEnforcedSettings,
  }
}

function allSuppliedSettingsBindAdmins(settings, adminEnforcedSettings) {
  const supplied = PROTECTION_SETTINGS.filter(setting => settings[setting])
  return supplied.length > 0 && supplied.every(setting => adminEnforcedSettings[setting])
}

function adminEnforcedSettingsOf(protection) {
  if (protection.adminEnforcedSettings) return protection.adminEnforcedSettings
  return Object.fromEntries(
    PROTECTION_SETTINGS.map(setting => [
      setting,
      Boolean(protection[setting] && protection.enforceAdmins),
    ])
  )
}

// GitHub enforces classic branch protection and rulesets together, so the
// effective settings are their union. Rulesets and classic protection only add
// restrictions: one unreadable source cannot remove settings the other
// supplies, but the result is unknown when neither can be read.
export function mergeMainProtection(classic, ruleset) {
  const present = [classic, ruleset].filter(protection => protection?.status === 'present')
  if (present.length === 0) {
    const unknown = [classic, ruleset].filter(protection => protection?.status === 'unknown')
    if (unknown.length === 0) return { status: 'missing' }
    return {
      status: 'unknown',
      error: unknown.map(protection => protection.error).filter(Boolean).join('; '),
    }
  }

  const settings = {}
  const adminEnforcedSettings = {}
  for (const setting of PROTECTION_SETTINGS) {
    settings[setting] = present.some(protection => protection[setting])
    adminEnforcedSettings[setting] = present.some(
      protection => protection[setting] && adminEnforcedSettingsOf(protection)[setting]
    )
  }

  const merged = {
    status: 'present',
    source: present.map(protection => protection.source || 'classic').join('+'),
    ...(ruleset?.status === 'present' ? { rulesetIds: ruleset.rulesetIds } : {}),
    requiredPullRequestReviews: settings.requiredPullRequestReviews,
    requiredStatusChecks: settings.requiredStatusChecks,
    enforceAdmins: allSuppliedSettingsBindAdmins(settings, adminEnforcedSettings),
    requiredCodeOwnerReviews: settings.requiredCodeOwnerReviews,
  }
  const unreadable = [classic, ruleset].filter(protection => protection?.status === 'unknown')
  if (unreadable.length > 0) {
    merged.partialError = unreadable.map(protection => protection.error).filter(Boolean).join('; ')
  }
  return merged
}

function ghApi(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    notFound: /HTTP 404|Branch not protected|Not Found/i.test(`${result.stderr}\n${result.stdout}`),
    stdout: result.stdout,
    error: `${result.stderr || result.stdout || 'gh api failed'}`.trim().slice(0, 500),
  }
}

function readClassicProtection(repository, branch) {
  const classic = ghApi(`repos/${repository}/branches/${branch}/protection`)
  if (classic.ok) return mapMainProtection(JSON.parse(classic.stdout))
  if (classic.notFound) return { status: 'missing' }
  return { status: 'unknown', error: classic.error }
}

function readMainRulesets(repository, branch) {
  const rules = ghApi(`repos/${repository}/rules/branches/${branch}`)
  if (!rules.ok) return { status: 'unknown', error: rules.error }
  const parsedRules = JSON.parse(rules.stdout)
  const rulesetsById = {}
  for (const id of new Set(parsedRules.map(rule => rule?.ruleset_id))) {
    if (!Number.isSafeInteger(id)) continue
    const ruleset = ghApi(`repos/${repository}/rulesets/${id}`)
    // An unreadable ruleset leaves its bypass list unknown, which fails closed.
    if (ruleset.ok) rulesetsById[id] = JSON.parse(ruleset.stdout)
  }
  return mapMainRulesets(parsedRules, rulesetsById)
}

export function readMainProtection(repository = EXPECTED_REPOSITORY, branch = PROTECTED_BRANCH) {
  return mergeMainProtection(
    readClassicProtection(repository, branch),
    readMainRulesets(repository, branch)
  )
}

export function mainProtectionHumanGate(protection) {
  if (protection.status !== 'present') {
    return `main branch protection is ${protection.status}`
  }

  const missingSettings = []
  if (!protection.requiredPullRequestReviews) {
    missingSettings.push('required pull request reviews')
  }
  if (!protection.requiredStatusChecks) {
    missingSettings.push('required status checks')
  }
  if (!protection.enforceAdmins) {
    missingSettings.push('admin enforcement')
  }
  if (!protection.requiredCodeOwnerReviews) {
    missingSettings.push('required CODEOWNERS review')
  }

  return missingSettings.length > 0
    ? `main branch protection is missing ${missingSettings.join(', ')}`
    : null
}

// A nested path is relative to the checkout that declared it.
function submoduleLabel({ name, path, parent }) {
  const label = path || name
  return parent ? `${label} (in ${parent})` : label
}

export function buildReadinessReport(
  repoRoot,
  { offline = false, probeSubmoduleFetch = probeAnonymousFetch } = {}
) {
  const checkouts = initializedSubmoduleCheckouts(repoRoot)
  const declarations = collectSubmoduleDeclarations(repoRoot, checkouts)
  const records = collectConfiguredRemotes(
    repoRoot,
    declarations.filter(declaration => !declaration.parent),
    checkouts
  )
  const remoteAudit = auditRemoteRecords(records)
  remoteAudit.errors.push(...auditExpectedOrigin(records))
  remoteAudit.status = remoteAudit.errors.length === 0 ? 'pass' : 'fail'

  const executableSources = auditExecutableSources(
    collectExecutableSourceRepositories(repoRoot)
  )
  const mainBranchProtection = offline
    ? { status: 'unknown', error: 'offline check requested' }
    : readMainProtection()
  const submoduleFetchability = auditSubmoduleFetchability(declarations, {
    offline,
    probe: probeSubmoduleFetch,
  })

  const humanGates = []
  const mainProtectionGate = mainProtectionHumanGate(mainBranchProtection)
  if (mainProtectionGate) humanGates.push(mainProtectionGate)
  if (submoduleFetchability.notFetchable.length > 0) {
    humanGates.push(
      `${submoduleFetchability.notFetchable.length} submodule URL(s) cannot be fetched anonymously: ${submoduleFetchability.notFetchable
        .map(submodule => `${submoduleLabel(submodule)} (${submodule.reason})`)
        .join('; ')}`
    )
  }
  if (submoduleFetchability.unknown.length > 0) {
    humanGates.push(
      `anonymous fetch of ${submoduleFetchability.unknown.length} submodule URL(s) was not checked`
    )
  }
  if (executableSources.external.length > 0) {
    humanGates.push(
      `${executableSources.external.length} executable source reference(s) target a repository outside the allowlist (${ALLOWED_EXECUTABLE_SOURCE_REPOSITORIES.join(', ')})`
    )
  }
  if (executableSources.dynamic.length > 0) {
    const selectors = [
      ...new Set(executableSources.dynamic.flatMap(source => source.dynamicSelectors)),
    ].sort()
    humanGates.push(
      `${executableSources.dynamic.length} executable source reference(s) use owner-selectable repository variable(s): ${selectors.join(', ')}`
    )
  }

  return {
    schemaVersion: 1,
    repository: EXPECTED_REPOSITORY,
    protectedBranch: PROTECTED_BRANCH,
    remoteOwnership: remoteAudit,
    executableSources,
    mainBranchProtection,
    submoduleFetchability,
    humanGates,
    ready: remoteAudit.status === 'pass' && humanGates.length === 0,
    note: 'Read-only report; this command never changes GitHub settings.',
  }
}

// Workflow-command data must not carry a raw newline: report text includes
// paths from a pull request's .gitmodules, and a newline would start a new
// runner command.
function escapeWorkflowCommandData(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

// One stderr line per remote-ownership error (always an error) and per open
// human gate: a warning in report-only mode, which passes, and an error in
// strict mode, which exits 2. GitHub Actions shows them as annotations.
export function readinessMessages(report, { reportOnly = false, githubActions = false } = {}) {
  const gateLevel = reportOnly ? 'warning' : 'error'
  const messages = [
    ...report.remoteOwnership.errors.map(text => ['error', text]),
    ...report.humanGates.map(text => [gateLevel, text]),
  ]
  return messages.map(([level, text]) =>
    githubActions
      ? `::${level} title=Release readiness::${escapeWorkflowCommandData(text)}`
      : `${level}: ${text.replace(/[\r\n]+/g, ' ')}`
  )
}

function parseArgs(argv) {
  const options = { offline: false, reportOnly: false, output: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    else if (arg === '--offline') options.offline = true
    else if (arg === '--report-only') options.reportOnly = true
    else if (arg === '--output') options.output = argv[++index] || ''
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const scriptDirectory = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDirectory, '../..')
  const report = buildReadinessReport(repoRoot, options)
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) writeFileSync(resolve(repoRoot, options.output), serialized)
  process.stdout.write(serialized)

  for (const line of readinessMessages(report, {
    reportOnly: options.reportOnly,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
  })) {
    process.stderr.write(`${line}\n`)
  }
  if (report.remoteOwnership.status !== 'pass') process.exitCode = 1
  else if (!options.reportOnly && !report.ready) process.exitCode = 2
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) main()
