import {
  type WebsiteSafetyResult,
  type WebsiteUnverifiedReason,
  createBlockedWebsiteResult,
  createClearWebsiteResult,
  createUnverifiedWebsiteResult,
} from '@qbit/wallet-shared'
import { EventEmitter } from 'eventemitter3'

import { classifyWebsiteOrigin, normalizeHostname } from './origin'
import {
  BUNDLED_PHISHING_DENYLIST,
  BUNDLED_PHISHING_POLICY_METADATA,
} from './static-policy'
import type {
  PhishingAdapter,
  PhishingCheckResult,
  PhishingConfig,
  PhishingServiceConfig,
  PhishingServiceEvents,
} from './types'
import { DISALLOWED_REMOTE_POLICY_KEYS } from './utils/fetch'

const USER_WHITELIST_KEY = 'phishing_user_whitelist'
const POLICY_SCHEMA_VERSION = 3

const BUNDLED_POLICY_WARNING =
  'This website matches Qbit Wallet’s bundled malicious-site denylist. Reject this request.'

const WEBSITE_SAFETY_WARNINGS: Record<WebsiteUnverifiedReason, string> = {
  'malformed-origin':
    'Qbit Wallet could not validate this website origin. Continue only if you recognize and trust it.',
  'unsupported-protocol':
    'This website uses a protocol outside Qbit Wallet’s local safety policy. Continue only if you recognize and trust it.',
  'insecure-protocol':
    'This website uses an insecure HTTP connection. Continue only if you understand and accept the interception risk.',
  localhost:
    'Localhost websites are outside Qbit Wallet’s bundled reputation policy. Continue only if you trust the local application.',
  'private-network':
    'Private-network websites are outside Qbit Wallet’s bundled reputation policy. Continue only if you trust the device and network.',
  'detector-failure':
    'The local website-safety check failed. Retry, reject, or continue only if you independently trust this site.',
  timeout:
    'The local website-safety check timed out. Retry, reject, or continue only if you independently trust this site.',
}

export function getWebsiteSafetyWarning(reason: WebsiteUnverifiedReason): string {
  return WEBSITE_SAFETY_WARNINGS[reason]!
}

function createBundledConfig(userWhitelist: Iterable<string> = []): PhishingConfig {
  return {
    version: POLICY_SCHEMA_VERSION,
    policyVersion: BUNDLED_PHISHING_POLICY_METADATA.policyVersion,
    sourceRevision: BUNDLED_PHISHING_POLICY_METADATA.sourceRevision,
    tolerance: 0,
    fuzzylist: [],
    whitelist: [...userWhitelist],
    blacklist: [...BUNDLED_PHISHING_DENYLIST],
    lastFetchTime: 0,
    cacheExpireTime: 0,
  }
}

export class PhishingService extends EventEmitter<PhishingServiceEvents> {
  private adapter: PhishingAdapter | undefined
  private logger: any = console
  private initialized = false
  private readonly temporaryWhitelist = new Set<string>()
  private readonly permanentWhitelist = new Set<string>()
  private readonly denylist = new Set(BUNDLED_PHISHING_DENYLIST)

  async init(config: PhishingServiceConfig): Promise<void> {
    this.adapter = config.adapter
    this.logger = config.logger || console

    if (this.initialized) return

    await this.loadUserWhitelist()
    await this.clearRemotePolicyState()
    this.initialized = true
  }

  destroy(): void {
    this.removeAllListeners()
    this.initialized = false
  }

  /**
   * Navigation-oriented check. An explicit local navigation bypass can take
   * precedence here, but never in checkWebsite(), which protects approvals.
   */
  checkPhishing(hostname: string): PhishingCheckResult {
    if (!hostname || typeof hostname !== 'string') {
      return { isPhishing: false, reason: 'Invalid hostname' }
    }

    const normalized = normalizeHostname(hostname)
    if (this.isTemporarilyWhitelisted(normalized)) {
      return { isPhishing: false, reason: 'Temporary whitelist' }
    }
    if (this.permanentWhitelist.has(normalized)) {
      return { isPhishing: false, reason: 'Permanent whitelist' }
    }

    return this.checkBundledDenylist(normalized, hostname)
  }

  /** Strict approval check using only the bundled release policy. */
  checkWebsite(origin: string): WebsiteSafetyResult {
    const classification = classifyWebsiteOrigin(origin)
    // A denylisted host in an http(s) origin is blocked whatever else is wrong
    // with the origin: HTTP, a path or a label outside DNS syntax
    // (`a_b.<entry>`) must not soften the verdict to a warning the user can
    // acknowledge.
    const { hostname } = classification
    const match = hostname ? this.findDenylistMatch(hostname) : undefined
    if (hostname && match) {
      return createBlockedWebsiteResult(hostname, match, BUNDLED_POLICY_WARNING)
    }

    if (classification.kind === 'unverified') {
      return createUnverifiedWebsiteResult(
        classification.reason,
        getWebsiteSafetyWarning(classification.reason),
        classification.hostname
      )
    }

    return createClearWebsiteResult(classification.hostname)
  }

  isPhishing(hostname: string): boolean {
    return this.checkPhishing(hostname).isPhishing
  }

  /**
   * Whether the bundled denylist covers a hostname, ignoring every navigation
   * bypass and DNS label syntax, so an odd but resolvable name such as
   * `a_b.<entry>` still counts.
   */
  isDenylisted(hostname: string): boolean {
    if (!hostname || typeof hostname !== 'string') return false
    const normalized = normalizeHostname(hostname)
    return !!normalized && this.findDenylistMatch(normalized) !== undefined
  }

  /**
   * Lifts the navigation warning for a host and its subdomains until the
   * service is recreated. The extension pairs this with a DNR session rule
   * that matches the same hosts, so a redirect to a subdomain such as `www.`
   * is not sent back to the warning page.
   */
  addToWhitelist(hostname: string): void {
    const normalized = normalizeHostname(hostname)
    if (normalized) this.temporaryWhitelist.add(normalized)
  }

  async addToPermanentWhitelist(hostname: string): Promise<void> {
    const normalized = normalizeHostname(hostname)
    if (!normalized || this.permanentWhitelist.has(normalized)) return

    this.permanentWhitelist.add(normalized)
    await this.saveUserWhitelist()
  }

  async removeFromWhitelist(hostname: string): Promise<void> {
    const normalized = normalizeHostname(hostname)
    this.temporaryWhitelist.delete(normalized)
    if (this.permanentWhitelist.delete(normalized)) {
      await this.saveUserWhitelist()
    }
  }

  /** Re-applies the bundled policy and normalizes disallowed remote policy state. */
  async forceUpdate(): Promise<void> {
    await this.clearRemotePolicyState()
    this.emit('phishing:updated', this.getConfig())
  }

  getConfig(): PhishingConfig {
    return createBundledConfig(this.permanentWhitelist)
  }

  getStats() {
    return {
      policyVersion: BUNDLED_PHISHING_POLICY_METADATA.policyVersion,
      blacklistSize: this.denylist.size,
      whitelistSize: this.permanentWhitelist.size,
      fuzzylistSize: 0,
      temporaryWhitelistSize: this.temporaryWhitelist.size,
      isUpdating: false,
    }
  }

  private isTemporarilyWhitelisted(hostname: string): boolean {
    for (const allowed of this.temporaryWhitelist) {
      if (hostname === allowed || hostname.endsWith(`.${allowed}`)) return true
    }
    return false
  }

  private findDenylistMatch(hostname: string): string | undefined {
    for (const domain of this.denylist) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return domain
    }
    return undefined
  }

  private checkBundledDenylist(normalized: string, original: string): PhishingCheckResult {
    const matchedPattern = this.findDenylistMatch(normalized)
    if (!matchedPattern) return { isPhishing: false }

    this.emit('phishing:detected', original, 'Bundled denylist match')
    return {
      isPhishing: true,
      reason: 'Bundled denylist match',
      matchedPattern,
    }
  }

  private async loadUserWhitelist(): Promise<void> {
    if (!this.adapter) return

    try {
      const stored = await this.adapter.get(USER_WHITELIST_KEY)
      if (!Array.isArray(stored)) return

      for (const hostname of stored) {
        if (typeof hostname === 'string' && normalizeHostname(hostname)) {
          this.permanentWhitelist.add(normalizeHostname(hostname))
        }
      }
    } catch (error) {
      this.reportStorageError('Failed to load local phishing bypasses', error)
    }
  }

  private async saveUserWhitelist(): Promise<void> {
    if (!this.adapter) return

    try {
      await this.adapter.set(USER_WHITELIST_KEY, [...this.permanentWhitelist])
    } catch (error) {
      this.reportStorageError('Failed to save local phishing bypasses', error)
    }
  }

  private async clearRemotePolicyState(): Promise<void> {
    if (!this.adapter) return

    for (const key of DISALLOWED_REMOTE_POLICY_KEYS) {
      try {
        await this.adapter.set(key, null)
      } catch (error) {
        this.reportStorageError(`Failed to clear remote policy state ${key}`, error)
      }
    }
  }

  private reportStorageError(message: string, error: unknown): void {
    this.logger.error(message, error)
    this.emit('phishing:error', error as Error)
  }
}
