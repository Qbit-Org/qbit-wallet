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
