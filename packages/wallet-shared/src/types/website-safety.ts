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

export type WebsiteClearReason = 'not-listed'

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
 * `clear` means only that the normalized hostname is absent from the bundled
 * denylist in this extension release. It is not a positive guarantee that the
 * website is trustworthy.
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
