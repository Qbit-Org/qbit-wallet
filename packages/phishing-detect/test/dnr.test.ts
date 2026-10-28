import { describe, expect, it } from 'vitest'

import { dnrHostPermissions, parseDnrDomain, partitionDnrDomains } from '../src/dnr'
import { BUNDLED_PHISHING_DENYLIST } from '../src/static-policy'

describe('parseDnrDomain', () => {
  it('accepts every bundled denylist entry as it is', () => {
    for (const entry of BUNDLED_PHISHING_DENYLIST) {
      expect(parseDnrDomain(entry)).toEqual({ ok: true, domain: entry })
    }
  })

  it.each([
    ['upper case and a trailing dot', ' Phish.EXAMPLE. ', 'phish.example'],
    ['a punycode name', 'xn--phsh-6pa.example', 'xn--phsh-6pa.example'],
    ['a public IPv4 address', '203.0.112.7', '203.0.112.7'],
  ])('normalizes %s', (_label, entry, domain) => {
    expect(parseDnrDomain(entry)).toEqual({ ok: true, domain })
  })

  it.each([
    ['a number', 42, 'not-a-string'],
    ['null', null, 'not-a-string'],
    ['an empty string', '', 'empty'],
    ['blanks', '  ', 'empty'],
    ['a name that is not ASCII', 'phïsh.example', 'non-ascii'],
    ['a path', 'phish.example/claim', 'not-a-public-hostname'],
    ['a port', 'phish.example:8443', 'not-a-public-hostname'],
    ['a scheme', 'https://phish.example', 'not-a-public-hostname'],
    ['credentials', 'user@phish.example', 'not-a-public-hostname'],
    ['a wildcard', '*.phish.example', 'not-a-public-hostname'],
    ['an inner space', 'uni sat.be', 'not-a-public-hostname'],
    ['a label outside DNS syntax', 'a_b.phish.example', 'not-a-public-hostname'],
    ['a single label', 'localhost', 'not-a-public-hostname'],
    ['a private address', '192.168.1.1', 'not-a-public-hostname'],
  ])('rejects %s', (_label, entry, reason) => {
    expect(parseDnrDomain(entry)).toEqual({ ok: false, reason })
  })
})

describe('partitionDnrDomains', () => {
  it('keeps the distinct valid domains in order and names each rejected entry', () => {
    expect(
      partitionDnrDomains(['phish.example', 'phïsh.example', 'PHISH.example', 'scam.example', '', 7, null, { a: 1 }])
    ).toEqual({
      domains: ['phish.example', 'scam.example'],
      rejected: [
        { entry: 'phïsh.example', reason: 'non-ascii' },
        { entry: '', reason: 'empty' },
        { entry: '7', reason: 'not-a-string' },
        { entry: 'null', reason: 'not-a-string' },
        { entry: '{"a":1}', reason: 'not-a-string' },
      ],
    })
  })
})

describe('dnrHostPermissions', () => {
  it('covers each domain and its subdomains over any scheme', () => {
    expect(dnrHostPermissions(['phish.example', 'a.scam.example'])).toEqual([
      '*://*.phish.example/*',
      '*://*.a.scam.example/*',
    ])
  })

  it('names an IP address exactly, as a match pattern has no subdomains for one', () => {
    const { domains } = partitionDnrDomains(['203.0.112.7'])
    expect(dnrHostPermissions(domains)).toEqual(['*://203.0.112.7/*'])
  })
})
