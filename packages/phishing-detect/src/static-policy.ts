import { isSpecialUseHostname, normalizeHostname } from './origin'

export interface BundledPhishingPolicyMetadata {
  readonly policyVersion: string
  readonly reviewedAt: string
}

/**
 * Qbit-owned release policy. It targets sites that imitate the official Qbit
 * website, https://qbit.org: `qbit.<tld>` under any other top-level domain,
 * and its subdomains. Qbit matches only exact hostnames and their subdomains,
 * with no fuzzy or visual matching, and the policy changes only with an
 * extension release.
 */
export const BUNDLED_PHISHING_POLICY_METADATA: BundledPhishingPolicyMetadata = Object.freeze({
  policyVersion: 'qbit-static-v2',
  reviewedAt: '2026-11-09',
})

/**
 * The domains the browser's network rules name, each with its subdomains:
 * the DNR block rule, and the warning redirect rule, whose host permissions
 * the build generates from this list. A network rule cannot name a domain
 * under every top-level domain, so the list holds only the lookalikes stopped
 * before the browser contacts them; `findQbitLookalikeDomain` covers the
 * other top-level domains in the wallet's own checks.
 */
export const BUNDLED_PHISHING_DENYLIST: readonly string[] = Object.freeze([
  'qbit.ca',
  'qbit.com',
  'qbit.io',
  'qbit.me',
])

/** The official Qbit website, the one origin approvals mark as trusted. */
export const TRUSTED_WEBSITE_ORIGIN = 'https://qbit.org'

// The official website's domain: the `qbit` label under the `org` top-level domain.
const QBIT_LABEL = 'qbit'
const OFFICIAL_TOP_LEVEL_DOMAIN = 'org'

/**
 * The `qbit.<tld>` domain a hostname belongs to when it imitates the official
 * website under another top-level domain: `qbit.io` for `qbit.io` or
 * `www.qbit.io`. Undefined for qbit.org and its subdomains, for a host where
 * `qbit` is not the label right before the top-level domain
 * (`qbit.example.com`, `qbit.co.uk`, `qbit-org.com`), and for a special-use
 * name that nobody can register (`qbit.localhost`, `qbit.test`).
 */
export function findQbitLookalikeDomain(hostname: string): string | undefined {
  return typeof hostname === 'string' ? lookalikeOf(normalizeHostname(hostname)) : undefined
}

function lookalikeOf(normalized: string): string | undefined {
  const labels = normalized.split('.')
  const topLevelDomain = labels[labels.length - 1]
  if (
    labels.length < 2 ||
    labels[labels.length - 2] !== QBIT_LABEL ||
    !topLevelDomain ||
    topLevelDomain === OFFICIAL_TOP_LEVEL_DOMAIN ||
    isSpecialUseHostname(normalized)
  ) {
    return undefined
  }
  return `${QBIT_LABEL}.${topLevelDomain}`
}

/**
 * The bundled policy's match for a hostname: the denylist entry it equals or
 * sits under, or else the lookalike domain it belongs to. Matching ignores DNS
 * label syntax, so an odd but resolvable name such as `a_b.<entry>` matches
 * too.
 */
export function findBundledPolicyMatch(hostname: string): string | undefined {
  if (typeof hostname !== 'string') return undefined
  const normalized = normalizeHostname(hostname)
  if (!normalized) return undefined
  for (const domain of BUNDLED_PHISHING_DENYLIST) {
    if (normalized === domain || normalized.endsWith(`.${domain}`)) return domain
  }
  return lookalikeOf(normalized)
}
