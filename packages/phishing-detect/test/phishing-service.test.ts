import { WebsiteVerdictStatus } from '@qbit/wallet-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PhishingService } from '../src/phishing-service'
import {
  BUNDLED_PHISHING_DENYLIST,
  BUNDLED_PHISHING_POLICY_METADATA,
} from '../src/static-policy'
import type { PhishingAdapter } from '../src/types'

const BLOCKED_DOMAIN = BUNDLED_PHISHING_DENYLIST[0]!

function createAdapter(initial: Record<string, unknown> = {}): PhishingAdapter & {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  values: Map<string, unknown>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
  }
}

describe('PhishingService', () => {
  const services: PhishingService[] = []

  afterEach(() => {
    for (const service of services.splice(0)) service.destroy()
  })

  async function setup(adapter = createAdapter()) {
    const service = new PhishingService()
    services.push(service)
    await service.init({ adapter })
    return { service, adapter }
  }

  it('blocks bundled malicious hostnames and their subdomains', async () => {
    const { service } = await setup()

    expect(service.checkWebsite(`https://${BLOCKED_DOMAIN}`).verdict).toMatchObject({
      status: WebsiteVerdictStatus.BLOCKED,
      reason: 'denylist',
      hostname: BLOCKED_DOMAIN,
      matchedDomain: BLOCKED_DOMAIN,
    })
    expect(service.checkWebsite(`https://login.${BLOCKED_DOMAIN}`).verdict.status).toBe(
      WebsiteVerdictStatus.BLOCKED
    )
  })

  it.each([
    ['a subdomain with an underscore', `https://a_b.${BLOCKED_DOMAIN}`, `a_b.${BLOCKED_DOMAIN}`],
    ['a subdomain ending in a hyphen', `https://x-.${BLOCKED_DOMAIN}`, `x-.${BLOCKED_DOMAIN}`],
    ['a subdomain starting with a hyphen', `https://-x.${BLOCKED_DOMAIN}`, `-x.${BLOCKED_DOMAIN}`],
    ['an HTTP origin', `http://${BLOCKED_DOMAIN}`, BLOCKED_DOMAIN],
    ['an origin with a path', `https://${BLOCKED_DOMAIN}/claim`, BLOCKED_DOMAIN],
  ])('blocks a denylisted host behind %s instead of only warning', async (_label, origin, hostname) => {
    const { service } = await setup()

    expect(service.checkWebsite(origin).verdict).toMatchObject({
      status: WebsiteVerdictStatus.BLOCKED,
      reason: 'denylist',
      hostname,
      matchedDomain: BLOCKED_DOMAIN,
    })
  })

  it('reports denylist coverage for any hostname spelling, ignoring navigation bypasses', async () => {
    const { service } = await setup()
    service.addToWhitelist(BLOCKED_DOMAIN)

    for (const hostname of [
      BLOCKED_DOMAIN,
      `www.${BLOCKED_DOMAIN}`,
      `a_b.${BLOCKED_DOMAIN}`,
      `-x.${BLOCKED_DOMAIN}`,
      ` ${BLOCKED_DOMAIN.toUpperCase()}. `,
    ]) {
      expect(service.isDenylisted(hostname)).toBe(true)
    }
    for (const hostname of ['', '   ', 'example.com', `x${BLOCKED_DOMAIN}`, `${BLOCKED_DOMAIN}.example`]) {
      expect(service.isDenylisted(hostname)).toBe(false)
    }
    expect(service.isDenylisted(undefined as unknown as string)).toBe(false)
  })

  it('returns clear only for a valid public HTTPS origin absent from the policy', async () => {
    const { service } = await setup()

    expect(service.checkWebsite('https://example.com')).toEqual({
      verdict: {
        status: WebsiteVerdictStatus.CLEAR,
        reason: 'not-listed',
        hostname: 'example.com',
        warning: '',
      },
      allowQuickMultiSign: false,
    })
  })

  it.each([
    ['', 'malformed-origin'],
    ['example.com', 'malformed-origin'],
    ['https://user:secret@example.com', 'malformed-origin'],
    ['https://example.com/path', 'malformed-origin'],
    ['https://-invalid.example', 'malformed-origin'],
    ['https://example..com', 'malformed-origin'],
    ['chrome-extension://wallet/index.html', 'unsupported-protocol'],
    ['http://example.com', 'insecure-protocol'],
    ['http://localhost:3000', 'localhost'],
    ['https://app.local', 'private-network'],
    ['https://app.test', 'private-network'],
    ['https://router.home.arpa', 'private-network'],
    ['http://10.0.0.8:3000', 'private-network'],
    ['http://100.85.190.90:3000', 'private-network'],
    ['https://[::1]', 'localhost'],
    ['https://[fd00::1]', 'private-network'],
    ['https://[::ffff:192.168.1.5]', 'private-network'],
  ])('classifies %s as unverified (%s)', async (origin, reason) => {
    const { service } = await setup()
    expect(service.checkWebsite(origin).verdict).toMatchObject({
      status: WebsiteVerdictStatus.UNVERIFIED,
      reason,
    })
  })

  it('ignores and clears stale remote policy caches', async () => {
    const adapter = createAdapter({
      phishing: {
        version: 2,
        blacklist: ['example.com'],
        whitelist: [BLOCKED_DOMAIN],
      },
      phishing_list_fallback: {
        blacklist: ['example.com'],
      },
    })
    const { service } = await setup(adapter)

    expect(service.checkWebsite('https://example.com').verdict.status).toBe(
      WebsiteVerdictStatus.CLEAR
    )
    expect(service.checkWebsite(`https://${BLOCKED_DOMAIN}`).verdict.status).toBe(
      WebsiteVerdictStatus.BLOCKED
    )
    expect(adapter.values.get('phishing')).toBeNull()
    expect(adapter.values.get('phishing_list_fallback')).toBeNull()
  })

  it('does not let a navigation bypass override approval protection', async () => {
    const { service } = await setup()

    service.addToWhitelist(BLOCKED_DOMAIN)
    expect(service.checkPhishing(BLOCKED_DOMAIN)).toEqual({
      isPhishing: false,
      reason: 'Temporary whitelist',
    })
    expect(service.checkWebsite(`https://${BLOCKED_DOMAIN}`).verdict.status).toBe(
      WebsiteVerdictStatus.BLOCKED
    )
  })

  it('lets a session navigation bypass cover the host and its subdomains only', async () => {
    const { service } = await setup()

    service.addToWhitelist(`WWW.${BLOCKED_DOMAIN}.`)
    expect(service.checkPhishing(`www.${BLOCKED_DOMAIN}`).isPhishing).toBe(false)
    // A redirect to a subdomain must not bounce back to the warning page.
    expect(service.checkPhishing(`login.www.${BLOCKED_DOMAIN}`)).toEqual({
      isPhishing: false,
      reason: 'Temporary whitelist',
    })
    // The parent and sibling hosts stay blocked, as does a lookalike suffix.
    expect(service.checkPhishing(BLOCKED_DOMAIN).isPhishing).toBe(true)
    expect(service.checkPhishing(`api.${BLOCKED_DOMAIN}`).isPhishing).toBe(true)
    expect(service.checkPhishing(`evilwww.${BLOCKED_DOMAIN}`).isPhishing).toBe(true)
    expect(service.checkWebsite(`https://login.www.${BLOCKED_DOMAIN}`).verdict.status).toBe(
      WebsiteVerdictStatus.BLOCKED
    )
  })

  it('lists no denylist entry beneath another', () => {
    // A session bypass covers subdomains, so a nested entry would be lifted
    // together with its parent.
    const nested = BUNDLED_PHISHING_DENYLIST.filter(entry =>
      BUNDLED_PHISHING_DENYLIST.some(other => other !== entry && entry.endsWith(`.${other}`))
    )
    expect(nested).toEqual([])
  })

  it('ignores an empty session navigation bypass', async () => {
    const { service } = await setup()

    service.addToWhitelist('  ')
    expect(service.getStats().temporaryWhitelistSize).toBe(0)
    expect(service.checkPhishing(BLOCKED_DOMAIN).isPhishing).toBe(true)
  })

  it('persists explicit navigation bypasses separately from policy caches', async () => {
    const { service, adapter } = await setup()

    await service.addToPermanentWhitelist(`WWW.${BLOCKED_DOMAIN}`)
    expect(adapter.values.get('phishing_user_whitelist')).toEqual([`www.${BLOCKED_DOMAIN}`])
    expect(service.checkPhishing(`www.${BLOCKED_DOMAIN}`).reason).toBe('Permanent whitelist')
    expect(service.checkWebsite(`https://www.${BLOCKED_DOMAIN}`).verdict.status).toBe(
      WebsiteVerdictStatus.BLOCKED
    )
  })

  it('keeps the bundled detector active when storage migration fails', async () => {
    const storageError = new Error('storage unavailable')
    const adapter = createAdapter()
    adapter.get.mockRejectedValue(storageError)
    adapter.set.mockRejectedValue(storageError)
    const logger = { error: vi.fn() }
    const service = new PhishingService()
    services.push(service)
    const onError = vi.fn()
    service.on('phishing:error', onError)

    await expect(service.init({ adapter, logger })).resolves.toBeUndefined()
    expect(service.checkWebsite(`https://${BLOCKED_DOMAIN}`).verdict.status).toBe(
      WebsiteVerdictStatus.BLOCKED
    )
    expect(onError).toHaveBeenCalledWith(storageError)
    expect(logger.error).toHaveBeenCalled()
  })

  it('reports immutable bundled policy provenance', async () => {
    const { service } = await setup()
    const config = service.getConfig()

    expect(config.policyVersion).toBe(BUNDLED_PHISHING_POLICY_METADATA.policyVersion)
    expect(config.sourceRevision).toBe(BUNDLED_PHISHING_POLICY_METADATA.sourceRevision)
    expect(config.blacklist).toHaveLength(29)
    expect(config.fuzzylist).toEqual([])
    expect(config.lastFetchTime).toBe(0)
    expect(config.cacheExpireTime).toBe(0)
  })
})
