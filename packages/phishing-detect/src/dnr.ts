import { classifyWebsiteOrigin, normalizeHostname } from './origin'

/** Why a denylist entry cannot be named in a DNR rule's `requestDomains`. */
export type DnrDomainRejection = 'not-a-string' | 'empty' | 'non-ascii' | 'not-a-public-hostname'

export type DnrDomainResult =
  | { readonly ok: true; readonly domain: string }
  | { readonly ok: false; readonly reason: DnrDomainRejection }

export interface RejectedDnrDomain {
  readonly entry: string
  readonly reason: DnrDomainRejection
}

// Chrome rejects a rule, and with it the whole rules update, when one of its
// `requestDomains` is not ASCII. The hostname check below rejects such an
// entry too; this one names the reason.
// eslint-disable-next-line no-control-regex -- the ASCII range is the check
const NON_ASCII = /[^\x00-\x7f]/

/**
 * Returns a hostname in the form a DNR rule's `requestDomains` may name it.
 * Chrome accepts any ASCII entry, but a rule matches only a canonical
 * hostname, so the entry must also be a well-formed public hostname that
 * normalizes to itself: no scheme, port, path, credentials or wildcard, and an
 * internationalized name only in punycode.
 */
export function parseDnrDomain(entry: unknown): DnrDomainResult {
  if (typeof entry !== 'string') return { ok: false, reason: 'not-a-string' }
  const hostname = normalizeHostname(entry)
  if (!hostname) return { ok: false, reason: 'empty' }
  if (NON_ASCII.test(hostname)) return { ok: false, reason: 'non-ascii' }

  const origin = classifyWebsiteOrigin(`https://${hostname}`)
  return origin.kind === 'public' && origin.hostname === hostname
    ? { ok: true, domain: hostname }
    : { ok: false, reason: 'not-a-public-hostname' }
}

/** An entry as a log or report can show it, also when it is not a string. */
function describeEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry
  try {
    return JSON.stringify(entry) ?? String(entry)
  } catch {
    return String(entry)
  }
}

/**
 * Splits denylist entries into the distinct domains a DNR rule can name and
 * the entries it cannot, so that one bad entry costs only itself rather than
 * the whole rule.
 */
export function partitionDnrDomains(entries: Iterable<unknown>): {
  domains: string[]
  rejected: RejectedDnrDomain[]
} {
  const domains = new Set<string>()
  const rejected: RejectedDnrDomain[] = []
  for (const entry of entries) {
    const result = parseDnrDomain(entry)
    if (result.ok) domains.add(result.domain)
    else rejected.push({ entry: describeEntry(entry), reason: result.reason })
  }
  return { domains: [...domains], rejected }
}

// A DNR domain that is an IP address, which a host permission names exactly:
// match patterns allow no subdomain wildcard before one.
const IP_ADDRESS = /^(?:\d+(?:\.\d+){3}|\[.*\])$/

/**
 * The host permission patterns that give access to each DNR domain and its
 * subdomains, as a `redirect` rule naming them needs; a `block` rule needs
 * none. The extension manifest declares these, and the background checks the
 * same ones before it relies on such a rule.
 */
export function dnrHostPermissions(domains: readonly string[]): string[] {
  return domains.map(domain => (IP_ADDRESS.test(domain) ? `*://${domain}/*` : `*://*.${domain}/*`))
}
