import { describe, expect, it } from 'vitest'

import {
  WebsiteVerdictStatus,
  createBlockedWebsiteResult,
  createClearWebsiteResult,
  createTrustedWebsiteResult,
  createUnverifiedWebsiteResult,
  isTrustedWebsiteResult,
} from '../src/types/website-safety'

describe('website safety verdicts', () => {
  it('creates a blocked verdict that cannot authorize quick multi-signing', () => {
    expect(
      createBlockedWebsiteResult(
        'login.bad.example',
        'bad.example',
        'This website is blocked.'
      )
    ).toEqual({
      verdict: {
        status: WebsiteVerdictStatus.BLOCKED,
        reason: 'denylist',
        hostname: 'login.bad.example',
        matchedDomain: 'bad.example',
        warning: 'This website is blocked.',
      },
      allowQuickMultiSign: false,
    })
  })

  it('keeps an unverified verdict distinct from clear', () => {
    const result = createUnverifiedWebsiteResult(
      'private-network',
      'Private-network origins are unverified.',
      '100.85.190.90'
    )

    expect(result.verdict.status).toBe(WebsiteVerdictStatus.UNVERIFIED)
    expect(result).toEqual({
      verdict: {
        status: WebsiteVerdictStatus.UNVERIFIED,
        reason: 'private-network',
        hostname: '100.85.190.90',
        warning: 'Private-network origins are unverified.',
      },
      allowQuickMultiSign: false,
    })
  })

  it('defines clear as a negative denylist lookup with no warning', () => {
    expect(createClearWebsiteResult('example.com')).toEqual({
      verdict: {
        status: WebsiteVerdictStatus.CLEAR,
        reason: 'not-listed',
        hostname: 'example.com',
        warning: '',
      },
      allowQuickMultiSign: false,
    })
  })

  it('defines trusted as a clear verdict for the official website that allows quick multi-signing', () => {
    const result = createTrustedWebsiteResult('qbit.org')

    expect(result).toEqual({
      verdict: {
        status: WebsiteVerdictStatus.CLEAR,
        reason: 'trusted',
        hostname: 'qbit.org',
        warning: '',
      },
      allowQuickMultiSign: true,
    })
    expect(isTrustedWebsiteResult(result)).toBe(true)
  })

  it('trusts no other verdict', () => {
    expect(isTrustedWebsiteResult(undefined)).toBe(false)
    expect(isTrustedWebsiteResult(createClearWebsiteResult('example.com'))).toBe(false)
    expect(
      isTrustedWebsiteResult(createBlockedWebsiteResult('qbit.io', 'qbit.io', 'Blocked.'))
    ).toBe(false)
    expect(
      isTrustedWebsiteResult(createUnverifiedWebsiteResult('timeout', 'Timed out.'))
    ).toBe(false)
  })
})
