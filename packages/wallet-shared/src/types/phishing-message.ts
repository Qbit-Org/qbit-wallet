/**
 * Message types for phishing protection
 * These constants are used for communication between different parts of the extension
 * related to phishing detection and protection features.
 */
export enum PhishingMessageType {
  /**
   * Check if a hostname is in the phishing blacklist
   *
   * Expected parameters:
   * - hostname: string - The hostname to check
   *
   * Response:
   * - isPhishing: boolean - Whether the hostname is in the blacklist
   */
  CHECK_PHISHING = 'CHECK_PHISHING',

  /**
   * Request to redirect the current tab to the phishing warning page
   *
   * Expected parameters:
   * - hostname: string - The hostname that triggered the detection
   * - url: string - The original URL that was blocked
   *
   * Response:
   * - success: boolean - Whether the redirect was successful
   * - error?: string - Error message if the redirect failed
   */
  REDIRECT_TO_PHISHING_PAGE = 'REDIRECT_TO_PHISHING_PAGE',

  /**
   * Add a hostname to the phishing whitelist to skip protection
   * This is used when a user chooses to proceed to a site despite the warning
   *
   * Expected parameters:
   * - hostname: string - The hostname to whitelist
   *
   * Response:
   * - success: boolean - Whether the hostname was added to the whitelist
   * - error?: string - Why not; `PHISHING_PROCEED_REFUSED_ERROR` for a
   *   hostname the background does not lift
   */
  SKIP_PHISHING_PROTECTION = 'SKIP_PHISHING_PROTECTION',

  /**
   * Alternative name for SKIP_PHISHING_PROTECTION
   * Adds a domain to the whitelist
   *
   * Expected parameters:
   * - domain: string - The domain to whitelist
   *
   * Response:
   * - success: boolean - Whether the domain was added to the whitelist
   */
  ADD_TO_WHITELIST = 'ADD_TO_WHITELIST',

  /**
   * Check if a navigation should be blocked due to phishing protection
   * This is used during navigation events to determine if a redirect is needed
   *
   * Expected parameters:
   * - url: string - The URL being navigated to
   * - newTab?: boolean - The link opens in a new tab or window rather than in
   *   the sender's tab; missing counts as false
   *
   * Response:
   * - isPhishing: boolean - Whether the URL is considered a phishing site
   * - redirected: boolean - Whether a redirect was initiated
   * - skipped?: boolean - Whether the check was skipped (e.g., for extension pages)
   * - leftToRedirectRule?: boolean - For a `newTab` link, whether the sender's
   *   tab was left alone because the warning redirect rule is in place for the
   *   host and shows the warning in the new tab
   */
  CHECK_NAVIGATION = 'CHECK_NAVIGATION',

  /**
   * Force an immediate update of the phishing lists from remote source
   * In MV3 it also installs the DNR block rule again.
   *
   * Expected parameters: none
   *
   * Response:
   * - success: boolean - Whether the update was successful
   * - error?: string - Error message if the update failed
   */
  FORCE_UPDATE_PHISHING_LIST = 'FORCE_UPDATE_PHISHING_LIST',

  /**
   * Alternative name for FORCE_UPDATE_PHISHING_LIST
   * Forces a reload of the phishing lists
   *
   * Expected parameters: none
   *
   * Response:
   * - success: boolean - Whether the reload was successful
   * - message: string - Status message
   */
  FORCE_RELOAD_PHISHING_LISTS = 'FORCE_RELOAD_PHISHING_LISTS',

  /**
   * Get statistics about the phishing protection
   * Returns information about blacklist and whitelist sizes
   *
   * Expected parameters: none
   *
   * Response:
   * - stats: object - Object containing phishing configuration and statistics
   * - networkRules: PhishingNetworkRuleHealth - Whether the DNR block rule is
   *   in place, as last read back from the browser
   * - protection?: PhishingProtectionHealth - Whether the network layer as a
   *   whole stops denylisted pages, with the warning redirect rule's state;
   *   only with DNR (MV3)
   */
  GET_PHISHING_STATS = 'GET_PHISHING_STATS',
}

/**
 * The state of the MV3 network layer of phishing protection, the DNR block
 * rule for the bundled denylist:
 * - `installing`: an attempt to install it is in progress;
 * - `installed`: the browser holds the rule for every domain that can go in it;
 * - `retrying`: the rule is not in place, as an attempt failed or a read found
 *   it missing, and another attempt is scheduled;
 * - `failed`: the attempts ran out, or no denylist entry can go in the rule,
 *   and no attempt is scheduled;
 * - `unknown`: the installed rules could not be read back;
 * - `unsupported`: there is no DNR, as in MV2, and the content script is the
 *   only layer.
 */
export type PhishingNetworkRuleStatus =
  | 'installing'
  | 'installed'
  | 'retrying'
  | 'failed'
  | 'unknown'
  | 'unsupported'

export interface PhishingNetworkRuleHealth {
  status: PhishingNetworkRuleStatus
  /** Attempts made since the latest install started, counting one in progress. */
  attempts: number
  /**
   * How many domains the block rule in the browser names, as last read back.
   * After a failure this is what an earlier install left, 0 when there is no
   * rule, and null when the rules have not been or could not be read.
   */
  blockedDomains: number | null
  /** Denylist entries left out of the rule because DNR cannot name them. */
  skippedEntries: { entry: string; reason: string }[]
  /** The last failure, while the status is `retrying`, `failed` or `unknown`. */
  error?: string
  /** When the next attempt starts, in milliseconds since the epoch, while `retrying`. */
  nextRetryAt?: number
  /** When this state was measured, in milliseconds since the epoch. */
  updatedAt: number
}

/**
 * The state of the MV3 session DNR `redirect` rule that sends top-level pages
 * on the denylist to the warning page. It outranks the block rule and fires
 * only with host access to the page, so it must not be in place without that
 * access:
 * - `installed`: the extension has host access to every denylisted domain,
 *   and the browser holds the rule as wanted;
 * - `not-wanted`: the rule must not be in place, as host access is withheld,
 *   not known, or there is no domain to name, and the browser holds none; the
 *   block rule decides alone;
 * - `missing`: host access is granted, but the browser does not hold the rule
 *   as wanted, and adding or replacing it is pending or failed; the block rule
 *   still stops what the rule would redirect;
 * - `removing`: host access is withheld and the browser still holds a rule,
 *   which does not fire, while its removal is pending;
 * - `removal-failed`: as `removing`, after the latest attempt to remove it
 *   failed; it is retried;
 * - `unknown`: the session rules could not be read, or a rule is in place and
 *   whether the extension has host access could not be read.
 */
export type PhishingWarningRedirectStatus =
  | 'installed'
  | 'not-wanted'
  | 'missing'
  | 'removing'
  | 'removal-failed'
  | 'unknown'

/**
 * Whether the extension has host access to every denylisted domain, as the
 * browser's permission check reported it at a read: `false` only when the
 * check ran and said so. `unknown` when the browser has no permission check
 * or it failed, and `no-domains` when no denylist entry can be named in a DNR
 * rule, so there is nothing to check.
 */
export type PhishingWarningRedirectHostAccess = boolean | 'unknown' | 'no-domains'

export interface PhishingWarningRedirectHealth {
  status: PhishingWarningRedirectStatus
  hostAccess: PhishingWarningRedirectHostAccess
  /** The last failure, while the rule is not as wanted or could not be read. */
  error?: string
  /** When the next attempt starts, in milliseconds since the epoch, while one is scheduled. */
  nextRetryAt?: number
  /** When this state was measured, in milliseconds since the epoch. */
  updatedAt: number
}

/**
 * Why the network layer does not stop every denylisted page it names:
 * - `block-rule-not-installed`: the block rule is not confirmed in place
 *   (`installing`, `retrying` or `failed`);
 * - `block-rule-unknown`: the block rule could not be read back;
 * - `redirect-rule-without-host-access`: a redirect rule that does not fire
 *   may still outrank the block rule, so denylisted pages load;
 * - `redirect-rule-unknown`: the redirect rule's state could not be read, or
 *   did not arrive in time;
 * - `site-access-withheld`: with the block rule not in place, the browser
 *   reports site access withheld on some denylisted domains, where the
 *   content script's hold does not run either;
 * - `site-access-unknown`: with the block rule not in place, whether site
 *   access is withheld, and so whether the hold runs, could not be read.
 */
export type PhishingProtectionReason =
  | 'block-rule-not-installed'
  | 'block-rule-unknown'
  | 'redirect-rule-without-host-access'
  | 'redirect-rule-unknown'
  | 'site-access-withheld'
  | 'site-access-unknown'

/**
 * Whether the MV3 network layer stops every denylisted page it names:
 * - `full`: the block rule is installed, and no redirect rule without host
 *   access can outrank it;
 * - `degraded`: the block rule is not installed, or a redirect rule without
 *   host access may still be in place; `reasons` says which;
 * - `unknown`: neither is known to be degraded, but a part could not be read.
 */
export type PhishingProtectionStatus = 'full' | 'degraded' | 'unknown'

export interface PhishingProtectionHealth {
  status: PhishingProtectionStatus
  /** Every reason for a `degraded` or `unknown` status; empty when `full`. */
  reasons: PhishingProtectionReason[]
  warningRedirect: PhishingWarningRedirectHealth
}

/** The answer to `GET_PHISHING_STATS`. */
export interface PhishingStatsResponse {
  /** The phishing configuration and its list sizes. */
  stats: unknown
  networkRules: PhishingNetworkRuleHealth
  /** Only with DNR (MV3); without it the content script is the only layer. */
  protection?: PhishingProtectionHealth
}

/**
 * The error `SKIP_PHISHING_PROTECTION` answers for a hostname the background
 * does not lift: one a DNR rule cannot name, or one the bundled denylist does
 * not cover.
 */
export const PHISHING_PROCEED_REFUSED_ERROR = 'Invalid hostname parameter'

/**
 * Sent by the background to a tab's top frame, where the content script
 * answers `{ present: true }`. It tells a page the content script runs on
 * from Chrome's error pages, where it never runs.
 */
export const PHISHING_PAGE_PROBE = 'PHISHING_PAGE_PROBE'
