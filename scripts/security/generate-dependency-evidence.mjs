import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import YAML from 'yaml'

import { writeGeneratedEvidence } from './dependency-evidence-artifacts.mjs'
import {
  exceptionCoversPath,
  fallbackReachability,
  normalizeResolvedVersion,
  packageIdentityFromReference,
  resolvedPackageKey,
} from './dependency-evidence-identity.mjs'

const repoRoot = process.cwd()
const AUDIT_FILE = 'docs/security/dependency-audit.json'
const INVENTORY_FILE = 'docs/security/dependency-inventory.json'
const DIRECT_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]
const TEST_PACKAGE =
  /(?:^|[/@-])(?:jest|vitest|playwright|testing-library|test-utils|jsdom|happy-dom|sinon|chai|mock)(?:$|[/@-])/i
const EXTENSION_BUILD_PACKAGE =
  /^(?:@babel\/|@pmmmwh\/react-refresh-webpack-plugin$|@svgr\/webpack$|@types\/|antd-dayjs-webpack-plugin$|babel-(?:loader|plugin|preset)|bfj$|browserify$|browserslist$|case-sensitive-paths-webpack-plugin$|cross-env$|css-(?:loader|minimizer-webpack-plugin)$|dotenv(?:-expand)?$|eslint-webpack-plugin$|file-loader$|fs-extra$|html-webpack-plugin$|mini-css-extract-plugin$|postcss(?:$|-)|prompts$|react-dev-utils$|react-refresh$|redux-devtools$|resolve$|resolve-url-loader$|source-map-loader$|style-(?:loader|resources-loader)$|tailwindcss$|terser-webpack-plugin$|ts-(?:import-plugin|loader)$|tsconfig-paths-webpack-plugin$|typescript(?:$|-)|webpack(?:$|-)|workbox-webpack-plugin$)/
const DEVELOPMENT_QUALITY_PACKAGE =
  /^(?:@notionhq\/client$|@trivago\/prettier-plugin-sort-imports$|@typescript-eslint\/|eslint(?:$|-)|prettier$)/
const SECURITY_ADJACENCY = {
  crypto:
    /(?:crypto|cipher|hash|sha\d*|md5|ripemd|secp|elliptic|noble|bip\d*|bitcoin|bitcore|hdkey|scrypt|pbkdf|aes|hmac|randombytes|tweetnacl|forge|sigstore|jose|ecdsa|slh|pqc|password|keyring|vault|encrypt|decrypt|mnemonic|signature)/i,
  serialization:
    /(?:protobuf|serializ|protocol|psbt|json|yaml|cbor|msgpack|borsh|rlp|bs58|bech32|varint|varuint|base-x|base64|querystring|(?:^|\/)qs$|xml|utf8|buffer)/i,
  networking:
    /(?:axios|fetch|http|websocket|(?:^|\/)ws$|sockjs|proxy|dns|(?:^|\/)ip$|(?:^|\/)url$|(?:^|\/)api$|rpc|sentry|esplora|electrum|undici|cookie|pac-|tunnel|connect)/i,
  archive:
    /(?:^|[-/])(?:tar|zip|unzip|gzip|zlib|archiver|compress|decompress|minizlib|yazl|yauzl)(?:[-/]|$)/i,
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount
}

function securityAdjacency(packageName) {
  return Object.entries(SECURITY_ADJACENCY)
    .filter(([, pattern]) => pattern.test(packageName))
    .map(([category]) => category)
    .sort()
}

function deliveryFor(workspace, section, packageName) {
  if (section === 'peerDependencies') return 'workspace-contract'
  if (TEST_PACKAGE.test(packageName)) return 'test-only-tooling'
  if (
    workspace === 'apps/extension' &&
    (EXTENSION_BUILD_PACKAGE.test(packageName) ||
      (section === 'devDependencies' && !DEVELOPMENT_QUALITY_PACKAGE.test(packageName)))
  ) {
    return 'extension-build-packaging'
  }
  if (section === 'devDependencies') return 'development-quality-tooling'
  return 'shipped-runtime'
}

function lockPackageIdentity(lockKey) {
  const identity = packageIdentityFromReference(lockKey.slice(1))
  return identity.version ? identity : null
}

const trackedStatus = requireSuccess(
  run('git', [
    'status',
    '--porcelain',
    '--untracked-files=no',
    '--',
    '.',
    `:(exclude)${AUDIT_FILE}`,
    `:(exclude)${INVENTORY_FILE}`,
  ]),
  'git status'
)
if (trackedStatus) {
  throw new Error(
    `tracked source worktree must be clean before evidence generation:\n${trackedStatus}`
  )
}

const auditedCommit = requireSuccess(run('git', ['rev-parse', 'HEAD']), 'git rev-parse')
const lockfileText = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
const lockfileSha256 = sha256(lockfileText)
const lockfile = YAML.parse(lockfileText)

const auditResult = run('corepack', ['pnpm', 'audit', '--json'])
if (![0, 1].includes(auditResult.status)) {
  throw new Error(`pnpm audit failed (${auditResult.status}): ${auditResult.stderr}`)
}
const auditReport = JSON.parse(auditResult.stdout)
if (auditReport.error || !auditReport.metadata?.vulnerabilities) {
  throw new Error(`pnpm audit failed closed: ${JSON.stringify(auditReport.error || auditReport)}`)
}
const auditOutput = `${JSON.stringify(auditReport, null, 2)}\n`
const auditSha256 = sha256(auditOutput)

const directDependencies = []
for (const [workspace, importer] of Object.entries(lockfile.importers)) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, workspace, 'package.json'), 'utf8'))
  for (const section of DIRECT_SECTIONS) {
    for (const [packageName, requested] of Object.entries(manifest[section] || {})) {
      const resolution = importer[section]?.[packageName]
      directDependencies.push({
        workspace,
        workspacePackage: manifest.name,
        package: packageName,
        section,
        requested,
        resolved: resolution?.version || null,
        delivery: deliveryFor(workspace, section, packageName),
        securityAdjacency: securityAdjacency(packageName),
      })
    }
  }
}
directDependencies.sort((left, right) =>
  [left.delivery, left.workspace, left.package, left.section]
    .join('\0')
    .localeCompare([right.delivery, right.workspace, right.package, right.section].join('\0'), 'en')
)

const deliveryLookup = new Map()
const unresolvedDeliveryLookup = new Map()
const directByPackage = new Map()
const directByResolvedPackage = new Map()
for (const dependency of directDependencies) {
  const declaration = {
    workspace: dependency.workspace,
    section: dependency.section,
    delivery: dependency.delivery,
    requested: dependency.requested,
    resolved: dependency.resolved,
  }
  const packageEntries = directByPackage.get(dependency.package) || []
  packageEntries.push(declaration)
  directByPackage.set(dependency.package, packageEntries)

  const resolvedKey = resolvedPackageKey(dependency.package, dependency.resolved)
  if (!resolvedKey) {
    unresolvedDeliveryLookup.set(
      `${dependency.workspace}\0${dependency.package}`,
      dependency.delivery
    )
    continue
  }
  const resolvedEntries = directByResolvedPackage.get(resolvedKey) || []
  resolvedEntries.push(declaration)
  directByResolvedPackage.set(resolvedKey, resolvedEntries)
  deliveryLookup.set(`${dependency.workspace}\0${resolvedKey}`, dependency.delivery)
}

const resolvedGroups = new Map()
for (const [lockKey, snapshot] of Object.entries(lockfile.packages || {})) {
  const identity = lockPackageIdentity(lockKey)
  if (!identity) continue
  const key = resolvedPackageKey(identity.package, identity.version)
  const group = resolvedGroups.get(key) || {
    ...identity,
    peerVariants: 0,
    integrity: snapshot.resolution?.integrity || null,
    closures: new Set(),
  }
  group.peerVariants += 1
  group.closures.add(snapshot.dev === true ? 'development-only' : 'production-closure')
  resolvedGroups.set(key, group)
}

const securityAdjacentResolved = [...resolvedGroups.values()]
  .map(group => ({
    package: group.package,
    version: group.version,
    categories: securityAdjacency(group.package),
    closures: [...group.closures].sort(),
    peerVariants: group.peerVariants,
    integrity: group.integrity,
    directDeclarations:
      directByResolvedPackage.get(resolvedPackageKey(group.package, group.version)) || [],
  }))
  .filter(group => group.categories.length > 0)
  .sort((left, right) =>
    `${left.package}@${left.version}`.localeCompare(`${right.package}@${right.version}`, 'en')
  )
const resolvedClosuresByPackage = new Map()
const resolvedClosuresByResolvedPackage = new Map()
for (const group of resolvedGroups.values()) {
  const closures = resolvedClosuresByPackage.get(group.package) || new Set()
  for (const closure of group.closures) closures.add(closure)
  resolvedClosuresByPackage.set(group.package, closures)
  resolvedClosuresByResolvedPackage.set(
    resolvedPackageKey(group.package, group.version),
    group.closures
  )
}

const exceptionDocument = JSON.parse(
  readFileSync(join(repoRoot, 'scripts/security/dependency-risk-exceptions.json'), 'utf8')
)
const exceptions = new Map(
  exceptionDocument.exceptions.map(exception => [
    `${exception.advisory}|${exception.package}`,
    exception,
  ])
)

const advisories = Object.values(auditReport.advisories || {})
  .map(advisory => {
    const advisoryId = /\/(GHSA-[0-9a-z-]+)$/.exec(advisory.url || '')?.[1] || String(advisory.id)
    const findingPaths = advisory.findings
      .flatMap(finding =>
        (finding.paths || []).map(path => ({
          path,
          vulnerableVersion: normalizeResolvedVersion(finding.version),
        }))
      )
      .sort((left, right) =>
        [left.path, left.vulnerableVersion]
          .join('\0')
          .localeCompare([right.path, right.vulnerableVersion].join('\0'), 'en')
      )
    const vulnerableVersions = [
      ...new Set(
        advisory.findings
          .map(finding => normalizeResolvedVersion(finding.version))
          .filter(Boolean)
      ),
    ].sort()
    const exception = exceptions.get(`${advisoryId}|${advisory.module_name}`)
    const pathReviews = findingPaths.map(({ path, vulnerableVersion }) => {
      const segments = path.split(' > ')
      const workspace = segments[0]
      const directIdentity = segments[1]
        ? packageIdentityFromReference(segments[1])
        : { package: null, version: null }
      const directPackage = directIdentity.package
      const directVersion = directIdentity.version
      const directKey = directPackage
        ? resolvedPackageKey(directPackage, directVersion)
        : null
      const directDelivery = directPackage
        ? (directKey ? deliveryLookup.get(`${workspace}\0${directKey}`) : null) ||
          unresolvedDeliveryLookup.get(`${workspace}\0${directPackage}`) ||
          'undetermined'
        : 'undetermined'
      let reachability
      if (exceptionCoversPath(exception, path)) reachability = exception.reachability
      else if (directDelivery === 'shipped-runtime') reachability = 'reachable'
      else if (directDelivery === 'workspace-contract') reachability = 'reachable'
      else if (directDelivery === 'extension-build-packaging') reachability = 'extension-build-path'
      else if (directDelivery === 'test-only-tooling') reachability = 'test-only-path'
      else if (directDelivery === 'development-quality-tooling')
        reachability = 'development-tooling-path'
      else {
        reachability = fallbackReachability({
          packageName: directPackage || advisory.module_name,
          version:
            directVersion ||
            (!directPackage || directPackage === advisory.module_name
              ? vulnerableVersion
              : null),
          directByPackage,
          directByResolvedPackage,
          closuresByPackage: resolvedClosuresByPackage,
          closuresByResolvedPackage: resolvedClosuresByResolvedPackage,
        })
      }
      return {
        path,
        workspace,
        vulnerableVersion,
        directPackage,
        directVersion,
        directDelivery,
        reachability,
      }
    })
    const directness = directDependencies.some(
      dependency =>
        dependency.package === advisory.module_name &&
        vulnerableVersions.includes(normalizeResolvedVersion(dependency.resolved))
    )
      ? 'direct'
      : 'transitive'
    const contextMap = new Map()
    for (const review of pathReviews) {
      const contextKey = [
        review.workspace,
        review.vulnerableVersion,
        review.directPackage,
        review.directVersion,
        review.directDelivery,
        review.reachability,
      ].join('\0')
      const context = contextMap.get(contextKey) || {
        workspace: review.workspace,
        vulnerableVersion: review.vulnerableVersion,
        directPackage: review.directPackage,
        directVersion: review.directVersion,
        directDelivery: review.directDelivery,
        reachability: review.reachability,
        pathCount: 0,
      }
      context.pathCount += 1
      contextMap.set(contextKey, context)
    }
    return {
      advisory: advisoryId,
      package: advisory.module_name,
      title: advisory.title,
      severity: advisory.severity,
      url: advisory.url,
      vulnerableVersions,
      directness,
      reachability: [...new Set(pathReviews.map(review => review.reachability))].sort(),
      acceptedException: exception
        ? {
            owner: exception.owner,
            expiresOn: exception.expiresOn,
            trackingIssue: exception.trackingIssue,
          }
        : null,
      findingPathCount: findingPaths.length,
      pathContexts: [...contextMap.values()].sort((left, right) =>
        [
          left.workspace,
          left.vulnerableVersion,
          left.directPackage,
          left.directVersion,
          left.reachability,
        ]
          .join('\0')
          .localeCompare(
            [
              right.workspace,
              right.vulnerableVersion,
              right.directPackage,
              right.directVersion,
              right.reachability,
            ].join('\0'),
            'en'
          )
      ),
    }
  })
  .sort((left, right) =>
    [left.severity, left.package, left.advisory]
      .join('\0')
      .localeCompare([right.severity, right.package, right.advisory].join('\0'), 'en')
  )

const directDeclarationsByDelivery = {}
for (const dependency of directDependencies)
  increment(directDeclarationsByDelivery, dependency.delivery)
const securityAdjacentByCategory = {}
for (const dependency of securityAdjacentResolved) {
  for (const category of dependency.categories) increment(securityAdjacentByCategory, category)
}
const advisoryRecordsBySeverity = {}
const advisoryRecordsByDirectness = {}
const advisoryPathsByReachability = {}
for (const advisory of advisories) {
  increment(advisoryRecordsBySeverity, advisory.severity)
  increment(advisoryRecordsByDirectness, advisory.directness)
  for (const context of advisory.pathContexts) {
    increment(advisoryPathsByReachability, context.reachability, context.pathCount)
  }
}

const inventory = {
  schemaVersion: 1,
  auditedCommit,
  lockfileSha256,
  auditOutput: {
    file: AUDIT_FILE,
    sha256: auditSha256,
    command: 'corepack pnpm audit --json',
  },
  classificationMethod: {
    directDependencies:
      'Every declaration in every pnpm importer is classified by manifest section plus an explicit extension build/test tool pattern. Shipped-runtime means a direct product dependency, not proof that every transitive byte is bundled.',
    resolvedSecurityAdjacency:
      'Every registry lock entry whose package name matches a reviewed crypto, serialization, networking, or archive adjacency rule is included; production-closure is pnpm closure metadata, not reachability proof.',
    advisoryReachability:
      'Each pnpm audit path is joined to its direct declaration by exact resolved package version. Exact accepted exception paths use their reviewed reachability; other paths inherit shipped runtime, extension build, test, or development-tooling context.',
  },
  summary: {
    workspaces: Object.keys(lockfile.importers).length,
    registryLockEntries: Object.keys(lockfile.packages || {}).length,
    directDeclarations: directDependencies.length,
    directDeclarationsByDelivery,
    securityAdjacentResolvedPackages: securityAdjacentResolved.length,
    securityAdjacentByCategory,
    auditVulnerableOccurrences: auditReport.metadata.vulnerabilities,
    advisoryRecords: advisories.length,
    advisoryRecordsBySeverity,
    advisoryRecordsByDirectness,
    advisoryPathsByReachability,
  },
  directDependencies,
  securityAdjacentResolved,
  advisories,
}
const inventoryOutput = `${JSON.stringify(inventory, null, 2)}\n`
// Both outputs are computed before either is written so a failure above cannot
// leave a partially regenerated evidence pair.
writeGeneratedEvidence(repoRoot, [
  { file: AUDIT_FILE, content: auditOutput },
  { file: INVENTORY_FILE, content: inventoryOutput },
])

console.log(
  JSON.stringify(
    {
      auditedCommit,
      lockfileSha256,
      auditSha256,
      inventorySha256: sha256(inventoryOutput),
      summary: inventory.summary,
    },
    null,
    2
  )
)
