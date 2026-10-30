import log from 'loglevel'

import { partitionDnrDomains } from '@qbit/phishing-detect'
import type { PhishingNetworkRuleHealth } from '@qbit/wallet-shared'

type Rule = chrome.declarativeNetRequest.Rule
type HealthUpdate = Omit<PhishingNetworkRuleHealth, 'updatedAt'>

const PHISHING_BLOCK_RULE_ID = 1
export const PHISHING_BLOCK_RULE_PRIORITY = 1

/**
 * How long to wait before each retry of a failed install, and then before
 * each later one, up to the last attempt. The first ones fall within the
 * service worker's idle lifetime; the later ones run while something keeps
 * the worker alive. A worker that stops before a retry starts over at its
 * next start.
 */
const BLOCK_RULE_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000]
const BLOCK_RULE_LATER_RETRY_DELAY_MS = 60_000
const BLOCK_RULE_MAX_ATTEMPTS = 10

/** A health state before anything has been measured. */
export function initialNetworkRuleHealth(
  status: 'installing' | 'unsupported'
): PhishingNetworkRuleHealth {
  return { status, attempts: 0, blockedDomains: null, skippedEntries: [], updatedAt: Date.now() }
}

function blockRuleResourceTypes(): chrome.declarativeNetRequest.ResourceType[] {
  const { ResourceType } = chrome.declarativeNetRequest
  return [ResourceType.MAIN_FRAME, ResourceType.SUB_FRAME]
}

function createBlockRule(domains: string[]): Rule {
  return {
    id: PHISHING_BLOCK_RULE_ID,
    priority: PHISHING_BLOCK_RULE_PRIORITY,
    action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
    condition: { requestDomains: domains, resourceTypes: blockRuleResourceTypes() },
  }
}

function isBlockRule(rule: Rule): boolean {
  return (
    rule.id === PHISHING_BLOCK_RULE_ID &&
    rule.action.type === chrome.declarativeNetRequest.RuleActionType.BLOCK
  )
}

export function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

export function sameMembers(
  actual: readonly string[] | undefined,
  expected: readonly string[]
): boolean {
  const members = new Set(actual)
  return members.size === new Set(expected).size && expected.every(value => members.has(value))
}

/**
 * Whether the rules hold the block rule for exactly these domains, with no
 * other condition that would narrow it.
 */
function holdsBlockRule(rules: Rule[], domains: string[]): boolean {
  const rule = rules.find(isBlockRule)
  return (
    !!rule &&
    rule.priority === PHISHING_BLOCK_RULE_PRIORITY &&
    hasOnlyKeys(rule.action, ['type']) &&
    hasOnlyKeys(rule.condition, ['requestDomains', 'resourceTypes']) &&
    sameMembers(rule.condition.requestDomains, domains) &&
    sameMembers(rule.condition.resourceTypes, blockRuleResourceTypes())
  )
}

function blockedDomainCount(rules: Rule[]): number {
  return rules.find(isBlockRule)?.condition.requestDomains?.length ?? 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Installs the dynamic DNR `block` rule for the denylist and keeps a health
 * state that reflects what the browser reports. A failed install is retried
 * with a backoff capped at a minute, up to ten attempts, and the redirect
 * rules of earlier releases are removed even when the block rule cannot be
 * installed.
 */
export class PhishingBlockRule {
  private health = initialNetworkRuleHealth('installing')
  // The domains of the rule the latest successful attempt installed.
  private installedDomains: string[] = []
  // Each install supersedes earlier ones: only the latest run publishes its
  // outcome or schedules a retry.
  private latestRun = 0
  // The outcome of the latest run's first attempt.
  private latestOutcome = Promise.resolve(this.health)
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  // Serializes attempts and health reads, so that neither sees the other's
  // rules update half done.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly listEntries: () => Iterable<unknown>) {}

  /**
   * Starts a new install, superseding any earlier one and its pending retry.
   * Resolves with the health after its first attempt, or after that of a
   * newer install that superseded it; on a failure, further attempts follow
   * in the background.
   */
  install(): Promise<PhishingNetworkRuleHealth> {
    const run = ++this.latestRun
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const outcome = this.enqueue(() => this.attempt(run, 1))
    this.latestOutcome = outcome
    return this.outcomeOf(run, outcome)
  }

  private async outcomeOf(
    run: number,
    outcome: Promise<PhishingNetworkRuleHealth>
  ): Promise<PhishingNetworkRuleHealth> {
    const health = await outcome
    return run === this.latestRun ? health : this.outcomeOf(this.latestRun, this.latestOutcome)
  }

  /**
   * The current health. An `installed` state is checked against the rules
   * the browser holds first, so it is never a stale one; a rule found missing
   * is reported as `retrying` and installed again at once.
   */
  getHealth(): Promise<PhishingNetworkRuleHealth> {
    return this.enqueue(async () => {
      const run = this.latestRun
      if (this.health.status !== 'installed') return this.health

      let rules: Rule[]
      try {
        rules = await chrome.declarativeNetRequest.getDynamicRules()
      } catch (error) {
        // Not kept: the next read measures again.
        return {
          ...this.health,
          status: 'unknown',
          blockedDomains: null,
          error: errorMessage(error),
          updatedAt: Date.now(),
        }
      }
      const blockedDomains = blockedDomainCount(rules)
      if (holdsBlockRule(rules, this.installedDomains)) {
        return this.publish(run, { ...this.health, blockedDomains })
      }
      log.error('[Phishing] The block rule is no longer installed; installing it again')
      const missing = this.publish(run, {
        ...this.health,
        status: 'retrying',
        blockedDomains,
        error: 'The block rule is no longer installed',
        nextRetryAt: Date.now(),
      })
      // Runs after this read, unless a newer install has started meanwhile.
      if (run === this.latestRun) void this.install()
      return missing
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private publish(run: number, update: HealthUpdate): PhishingNetworkRuleHealth {
    const health = { ...update, updatedAt: Date.now() }
    if (run === this.latestRun) this.health = health
    return health
  }

  private async attempt(run: number, attempt: number): Promise<PhishingNetworkRuleHealth> {
    if (run !== this.latestRun) return this.health
    const { blockedDomains, skippedEntries: lastSkipped } = this.health
    this.publish(run, {
      status: 'installing',
      attempts: attempt,
      blockedDomains,
      skippedEntries: lastSkipped,
    })

    let skippedEntries = lastSkipped
    let canRetry = true
    try {
      // Read the list afresh each time, and leave out the entries DNR would
      // reject, as one of them would reject the whole update.
      const { domains, rejected } = partitionDnrDomains(this.listEntries())
      skippedEntries = rejected
      if (rejected.length) {
        log.warn('[Phishing] Denylist entries left out of the block rule:', skippedEntries)
      }
      if (!domains.length) {
        // Retrying cannot change this. An earlier block rule still blocks its
        // domains, so it stays.
        canRetry = false
        throw new Error('No denylist entry can be named in a DNR rule')
      }

      // After most worker starts the rule is already in place, alone.
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules()
      if (existingRules.length !== 1 || !holdsBlockRule(existingRules, domains)) {
        // One call swaps out every earlier rule, including the redirect rules
        // older releases installed, so protection never lapses in between. It
        // is safe to repeat after an outcome that is not known.
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existingRules.map(rule => rule.id),
          addRules: [createBlockRule(domains)],
        })
        if (!holdsBlockRule(await chrome.declarativeNetRequest.getDynamicRules(), domains)) {
          throw new Error('The block rule is missing after the update')
        }
      }

      if (run === this.latestRun) this.installedDomains = domains
      log.debug(`[Phishing] Updated MV3 block rule for ${domains.length} domains`)
      return this.publish(run, {
        status: 'installed',
        attempts: attempt,
        blockedDomains: domains.length,
        skippedEntries,
      })
    } catch (error) {
      log.error(`[Phishing] Failed to install the block rule (attempt ${attempt}):`, error)
      const failure = {
        attempts: attempt,
        blockedDomains: await this.removeEarlierRules(),
        skippedEntries,
        error: errorMessage(error),
      }
      const delay =
        BLOCK_RULE_RETRY_DELAYS_MS[attempt - 1] ??
        (attempt < BLOCK_RULE_MAX_ATTEMPTS ? BLOCK_RULE_LATER_RETRY_DELAY_MS : undefined)
      if (!canRetry || delay === undefined || run !== this.latestRun) {
        return this.publish(run, { ...failure, status: 'failed' })
      }

      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.enqueue(() => this.attempt(run, attempt + 1))
      }, delay)
      return this.publish(run, { ...failure, status: 'retrying', nextRetryAt: Date.now() + delay })
    }
  }

  /**
   * Removes every dynamic rule but a block rule, such as the redirect rules
   * of 1.0.4 and earlier, which never fired, so they do not linger while the
   * block rule cannot be installed. A block rule an earlier install left still
   * blocks its domains, so it stays. Returns how many domains it names, or
   * null when the rules could not be read.
   */
  private async removeEarlierRules(): Promise<number | null> {
    let rules: Rule[]
    try {
      rules = await chrome.declarativeNetRequest.getDynamicRules()
    } catch (error) {
      log.error('[Phishing] Failed to read the dynamic rules:', error)
      return null
    }

    const earlierRuleIds = rules.filter(rule => !isBlockRule(rule)).map(rule => rule.id)
    if (earlierRuleIds.length) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: earlierRuleIds })
      } catch (error) {
        log.error('[Phishing] Failed to remove the rules of earlier releases:', error)
      }
    }
    return blockedDomainCount(rules)
  }
}
