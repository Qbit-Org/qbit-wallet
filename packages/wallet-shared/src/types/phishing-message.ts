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
   *
   * Response:
   * - isPhishing: boolean - Whether the URL is considered a phishing site
   * - redirected: boolean - Whether a redirect was initiated
   * - skipped?: boolean - Whether the check was skipped (e.g., for extension pages)
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
 * Sent by the background to a tab's top frame, where the content script
 * answers `{ present: true }`. It tells a page the content script runs on
 * from Chrome's error pages, where it never runs.
 */
export const PHISHING_PAGE_PROBE = 'PHISHING_PAGE_PROBE'
