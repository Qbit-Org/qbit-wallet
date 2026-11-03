import { posix } from 'node:path'

export function normalizeResolvedVersion(version) {
  if (typeof version !== 'string' || version.length === 0) return null
  return version.split('(')[0] || null
}

export function resolvedPackageKey(packageName, version) {
  const normalizedVersion = normalizeResolvedVersion(version)
  return normalizedVersion ? `${packageName}\0${normalizedVersion}` : null
}

export function packageIdentityFromReference(reference) {
  const withoutPeers = normalizeResolvedVersion(reference)
  if (!withoutPeers) return { package: reference, version: null }

  const separator = withoutPeers.lastIndexOf('@')
  if (separator <= 0) return { package: withoutPeers, version: null }

  return {
    package: withoutPeers.slice(0, separator),
    version: withoutPeers.slice(separator + 1) || null,
  }
}

export function reachabilityForDeliveries(deliveries) {
  if (deliveries.includes('shipped-runtime') || deliveries.includes('workspace-contract')) {
    return 'reachable'
  }
  if (deliveries.includes('extension-build-packaging')) return 'extension-build-path'
  if (deliveries.includes('test-only-tooling')) return 'test-only-path'
  if (deliveries.includes('development-quality-tooling')) return 'development-tooling-path'
  return null
}

export function fallbackReachability({
  packageName,
  version,
  directByPackage,
  directByResolvedPackage,
  closuresByPackage,
  closuresByResolvedPackage,
}) {
  const exactKey = resolvedPackageKey(packageName, version)
  if (exactKey) {
    const directReachability = reachabilityForDeliveries(
      (directByResolvedPackage.get(exactKey) || []).map(entry => entry.delivery)
    )
    if (directReachability) return directReachability

    const closures = closuresByResolvedPackage.get(exactKey)
    if (closures) {
      return closures.has('production-closure') ? 'reachable' : 'development-tooling-path'
    }
  }

  // Without an exact identity, a production closure is the conservative classification.
  const closures = closuresByPackage.get(packageName) || new Set()
  if (closures.has('production-closure')) return 'reachable'
  const directReachability = reachabilityForDeliveries(
    (directByPackage.get(packageName) || []).map(entry => entry.delivery)
  )
  return directReachability || 'development-tooling-path'
}

// An accepted exception applies its reviewed reachability only to the exact
// audit paths it lists; a missing or malformed path list never matches.
export function exceptionCoversPath(exception, path) {
  return Array.isArray(exception?.paths) && exception.paths.includes(path)
}

// pnpm 11 writes an audit path as `<importer>>name>name...`, with the
// importer id's slashes replaced by `__` and no versions. A path that does not
// start with a lockfile importer fails closed.
export function parseAuditPath(path, importers) {
  const [prefix, ...packages] = path.split('>')
  const workspace = Object.keys(importers || {}).find(
    importer => importer.replaceAll('/', '__') === prefix
  )
  if (workspace === undefined) {
    throw new Error(`audit path ${path} does not start with a pnpm-lock.yaml importer`)
  }
  return { workspace, packages }
}

// The direct dependency's version is the one its importer resolved in the
// lockfile, since the audit path names no versions.
export function auditPathDirectDependency(path, importers) {
  const { workspace, packages } = parseAuditPath(path, importers)
  const directPackage = packages[0] || null
  const resolution = directPackage
    ? ['dependencies', 'devDependencies', 'optionalDependencies']
        .map(section => importers[workspace]?.[section]?.[directPackage]?.version)
        .find(version => typeof version === 'string')
    : null
  return { workspace, directPackage, directVersion: normalizeResolvedVersion(resolution) }
}

// The snapshot key an importer or snapshot dependency reference names, as pnpm
// reads it: a version, possibly with a peer suffix, belongs to the dependency's
// own name, while an npm alias names its target as `name@version`. A workspace
// link has no snapshot.
export function snapshotKeyFromReference(alias, reference) {
  if (typeof reference !== 'string' || reference.startsWith('link:')) return null
  if (reference.startsWith('@')) return reference
  const at = reference.indexOf('@')
  const colon = reference.indexOf(':')
  const peers = reference.indexOf('(')
  if (at > 0 && (colon === -1 || at < colon) && (peers === -1 || at < peers)) return reference
  return `${alias}@${reference}`
}

// Lockfile v9 records no per-package dev flag, so each snapshot's closure is
// rebuilt from the importers, as the v6 flag was: anything reachable from an
// importer's dependencies or optionalDependencies is production-closure, and
// anything reachable only from devDependencies is development-only. A snapshot
// no importer reaches, or a reference to a missing one, fails closed.
export function lockfileSnapshotClosures(lockfile) {
  const snapshots = lockfile?.snapshots || {}
  const reach = sections => {
    const pending = []
    for (const importer of Object.values(lockfile?.importers || {})) {
      for (const section of sections) {
        for (const [alias, dependency] of Object.entries(importer?.[section] || {})) {
          pending.push([
            `importer ${section}.${alias}`,
            snapshotKeyFromReference(alias, dependency?.version),
          ])
        }
      }
    }
    const reached = new Set()
    while (pending.length > 0) {
      const [from, key] = pending.pop()
      if (key === null || reached.has(key)) continue
      if (!Object.hasOwn(snapshots, key)) {
        throw new Error(`${from} names snapshot ${key}, which pnpm-lock.yaml does not contain`)
      }
      reached.add(key)
      for (const section of ['dependencies', 'optionalDependencies']) {
        for (const [alias, reference] of Object.entries(snapshots[key]?.[section] || {})) {
          pending.push([key, snapshotKeyFromReference(alias, reference)])
        }
      }
    }
    return reached
  }
  const production = reach(['dependencies', 'optionalDependencies'])
  const development = reach(['devDependencies'])
  const closures = new Map()
  for (const key of Object.keys(snapshots)) {
    if (production.has(key)) closures.set(key, 'production-closure')
    else if (development.has(key)) closures.set(key, 'development-only')
    else throw new Error(`snapshot ${key} is not reachable from any importer`)
  }
  return closures
}

const PRODUCTION_SECTIONS = ['dependencies', 'optionalDependencies']

// One shortest production path to each name@version in a production closure,
// written `importer > name@version > ...`. The walk starts from every importer
// that no other importer links to in a production section and follows
// workspace links, so a workspace package's dependency is shown through the
// extension that ships it. An importer that only a cycle of links reaches
// starts its own walk, so the set of name@version is the production closure.
export function lockfileProductionPaths(lockfile) {
  const importers = lockfile?.importers || {}
  const snapshots = lockfile?.snapshots || {}
  const sortedEntries = mapping =>
    Object.entries(mapping || {}).sort(([left], [right]) => left.localeCompare(right, 'en'))
  const linkTarget = (importer, reference) =>
    typeof reference === 'string' && reference.startsWith('link:')
      ? posix.join(importer, reference.slice('link:'.length))
      : null
  const linked = new Set()
  for (const [importer, sections] of Object.entries(importers)) {
    for (const section of PRODUCTION_SECTIONS) {
      for (const dependency of Object.values(sections?.[section] || {})) {
        const target = linkTarget(importer, dependency?.version)
        if (target !== null) linked.add(target)
      }
    }
  }

  const paths = new Map()
  const queue = []
  const visit = (node, path) => {
    if (paths.has(node)) return
    paths.set(node, path)
    queue.push(node)
  }
  const walk = () => {
    while (queue.length > 0) {
      const node = queue.shift()
      const path = paths.get(node)
      const importer = node.startsWith('importer:') ? node.slice('importer:'.length) : null
      const dependencies =
        importer === null
          ? PRODUCTION_SECTIONS.flatMap(section => sortedEntries(snapshots[node]?.[section]))
          : PRODUCTION_SECTIONS.flatMap(section =>
              sortedEntries(importers[importer]?.[section]).map(([alias, dependency]) => [
                alias,
                dependency?.version,
              ])
            )
      for (const [alias, reference] of dependencies) {
        const target = importer === null ? null : linkTarget(importer, reference)
        if (target !== null) {
          visit(`importer:${target}`, `${path} > ${alias}`)
          continue
        }
        const key = snapshotKeyFromReference(alias, reference)
        if (key === null) continue
        if (!Object.hasOwn(snapshots, key)) {
          throw new Error(`${path} names snapshot ${key}, which pnpm-lock.yaml does not contain`)
        }
        const identity = packageIdentityFromReference(key)
        visit(key, `${path} > ${identity.package}@${identity.version}`)
      }
    }
  }
  const sortedImporters = Object.keys(importers).sort((left, right) =>
    left.localeCompare(right, 'en')
  )
  for (const importer of sortedImporters) {
    if (!linked.has(importer)) visit(`importer:${importer}`, importer)
  }
  walk()
  for (const importer of sortedImporters) {
    visit(`importer:${importer}`, importer)
    walk()
  }

  const productionPaths = new Map()
  for (const [node, path] of paths) {
    if (node.startsWith('importer:')) continue
    const identity = packageIdentityFromReference(node)
    const key = `${identity.package}@${identity.version}`
    if (!productionPaths.has(key)) productionPaths.set(key, path)
  }
  return productionPaths
}
