export enum WebsiteVerdictStatus {
  BLOCKED = 'blocked',
  UNVERIFIED = 'unverified',
  CLEAR = 'clear',
}

export type WebsiteBlockedReason = 'denylist'

export type WebsiteUnverifiedReason =
  | 'malformed-origin'
  | 'unsupported-protocol'
  | 'insecure-protocol'
  | 'localhost'
  | 'private-network'
  | 'detector-failure'
  | 'timeout'

/**
 * `trusted` is the official Qbit website's exact origin, https://qbit.org;
 * `not-listed` is any other site the bundled policy does not cover.
 */
export type WebsiteClearReason = 'not-listed' | 'trusted'

export interface BlockedWebsiteVerdict {
  status: WebsiteVerdictStatus.BLOCKED
  reason: WebsiteBlockedReason
  hostname: string
  matchedDomain: string
  warning: string
}

export interface UnverifiedWebsiteVerdict {
  status: WebsiteVerdictStatus.UNVERIFIED
  reason: WebsiteUnverifiedReason
  hostname?: string
  warning: string
}

export interface ClearWebsiteVerdict {
  status: WebsiteVerdictStatus.CLEAR
  reason: WebsiteClearReason
  hostname: string
  warning: ''
}

/**
 * A local website-policy decision.
 *
 * `clear` with reason `not-listed` means only that the bundled policy in this
 * extension release does not cover the normalized hostname. It is not a
 * positive guarantee that the website is trustworthy. Only reason `trusted`,
 * for the official website's exact origin, is one.
 */
export type WebsiteVerdict =
  | BlockedWebsiteVerdict
  | UnverifiedWebsiteVerdict
  | ClearWebsiteVerdict

export interface WebsiteSafetyResult {
  verdict: WebsiteVerdict
  allowQuickMultiSign: boolean
}

export function createBlockedWebsiteResult(
  hostname: string,
  matchedDomain: string,
  warning: string
): WebsiteSafetyResult {
  return {
    verdict: {
      status: WebsiteVerdictStatus.BLOCKED,
      reason: 'denylist',
      hostname,
      matchedDomain,
      warning,
    },
    allowQuickMultiSign: false,
  }
}

export function createUnverifiedWebsiteResult(
  reason: WebsiteUnverifiedReason,
  warning: string,
  hostname?: string
): WebsiteSafetyResult {
  return {
    verdict: {
      status: WebsiteVerdictStatus.UNVERIFIED,
      reason,
      ...(hostname ? { hostname } : {}),
      warning,
    },
    allowQuickMultiSign: false,
  }
}

/**
 * The official website's verdict. It also allows signing a batch at once
 * without the per-site opt-in, as a user who trusts a site can choose for it.
 */
export function createTrustedWebsiteResult(hostname: string): WebsiteSafetyResult {
  return {
    verdict: {
      status: WebsiteVerdictStatus.CLEAR,
      reason: 'trusted',
      hostname,
      warning: '',
    },
    allowQuickMultiSign: true,
  }
}

/** Whether a result is the trusted verdict of the official website. */
export function isTrustedWebsiteResult(result: WebsiteSafetyResult | undefined): boolean {
  return (
    result?.verdict.status === WebsiteVerdictStatus.CLEAR && result.verdict.reason === 'trusted'
  )
}

export function createClearWebsiteResult(hostname: string): WebsiteSafetyResult {
  return {
    verdict: {
      status: WebsiteVerdictStatus.CLEAR,
      reason: 'not-listed',
      hostname,
      warning: '',
    },
    allowQuickMultiSign: false,
  }
}
