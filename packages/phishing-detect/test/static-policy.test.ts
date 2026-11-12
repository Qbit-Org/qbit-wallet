import { describe, expect, it } from 'vitest'

import {
  BUNDLED_PHISHING_DENYLIST,
  findBundledPolicyMatch,
  findQbitLookalikeDomain,
  TRUSTED_WEBSITE_ORIGIN,
} from '../src/static-policy'

describe('findQbitLookalikeDomain', () => {
  it.each([
    ['qbit.io', 'qbit.io'],
    ['qbit.me', 'qbit.me'],
    ['www.qbit.com', 'qbit.com'],
    ['a.b.qbit.ca', 'qbit.ca'],
    [' QBIT.Net. ', 'qbit.net'],
    ['qbit.finance', 'qbit.finance'],
    ['qbit.xn--p1ai', 'qbit.xn--p1ai'],
    ['a_b.qbit.xyz', 'qbit.xyz'],
  ])('matches %s as %s', (hostname, domain) => {
    expect(findQbitLookalikeDomain(hostname)).toBe(domain)
  })

  it.each([
    // The official website and its subdomains.
    'qbit.org',
    'QBIT.ORG.',
    'www.qbit.org',
    'mempool.qbit.org',
    // Other names: `qbit` must be the label right before the top-level
    // domain, so a second-level registry such as co.uk and a site that names
    // a subdomain `qbit` under its own domain are not covered.
    'qbit',
    '.qbit',
    'qbitinfo.org',
    'qbit-org.com',
    'xqbit.io',
    'qbitx.io',
    'qbit.co.uk',
    'qbit.robertclarke.com',
    'qbit.miller.nz',
    // Special-use names nobody can register.
    'qbit.localhost',
    'app.qbit.localhost',
    'qbit.test',
    'qbit.local',
    'qbit.internal',
    'qbit.onion',
    '',
    '   ',
  ])('does not match %s', hostname => {
    expect(findQbitLookalikeDomain(hostname)).toBeUndefined()
  })

  it('ignores a value that is not a string', () => {
    expect(findQbitLookalikeDomain(undefined as unknown as string)).toBeUndefined()
    expect(findQbitLookalikeDomain(7 as unknown as string)).toBeUndefined()
  })
})

describe('findBundledPolicyMatch', () => {
  it('names the denylist entry for a host on the denylist', () => {
    for (const entry of BUNDLED_PHISHING_DENYLIST) {
      expect(findBundledPolicyMatch(entry)).toBe(entry)
      expect(findBundledPolicyMatch(`login.${entry.toUpperCase()}.`)).toBe(entry)
    }
  })

  it('names the lookalike domain for a qbit.<tld> host outside the denylist', () => {
    expect(findBundledPolicyMatch('qbit.net')).toBe('qbit.net')
    expect(findBundledPolicyMatch('app.qbit.xyz')).toBe('qbit.xyz')
  })

  it('lists only qbit.<tld> lookalikes, so the network rules never name another site', () => {
    for (const entry of BUNDLED_PHISHING_DENYLIST) {
      expect(findQbitLookalikeDomain(entry)).toBe(entry)
    }
  })

  it('never covers the trusted origin', () => {
    expect(findBundledPolicyMatch(new URL(TRUSTED_WEBSITE_ORIGIN).hostname)).toBeUndefined()
  })

  it('covers nothing else', () => {
    for (const hostname of ['example.com', 'qbit.org', 'mempool.qbit.org', 'qbit.co.uk', '', '  ']) {
      expect(findBundledPolicyMatch(hostname)).toBeUndefined()
    }
    expect(findBundledPolicyMatch(null as unknown as string)).toBeUndefined()
  })
})
