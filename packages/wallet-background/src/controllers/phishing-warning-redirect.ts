import log from 'loglevel'

import { dnrHostPermissions, parseDnrDomain, partitionDnrDomains } from '@qbit/phishing-detect'
import type {
  PhishingWarningRedirectHealth,
  PhishingWarningRedirectHostAccess,
  PhishingWarningRedirectStatus,
} from '@qbit/wallet-shared'

import { hasOnlyKeys, PHISHING_BLOCK_RULE_PRIORITY, sameMembers } from './phishing-block-rule'

type Rule = chrome.declarativeNetRequest.Rule

/** What a health read found; `stranded` when a rule is in place without confirmed host access. */
interface HealthRead {
  readonly health: PhishingWarningRedirectHealth
  readonly stranded: boolean
}

/** The latest run's last failed update, until an outcome of the latest run replaces it. */
interface RedirectFailure {
  readonly error: string
  /** Whether the update had to remove a rule that may still be in place. */
  readonly removal: boolean
  readonly nextRetryAt?: number
}

/**
 * Outranks the block rule for top-level pages, and is outranked by the allow
 * rules Proceed adds.
 */
export const PHISHING_WARNING_REDIRECT_PRIORITY = PHISHING_BLOCK_RULE_PRIORITY + 1

/**
 * A fixed session rule id. Proceed takes one more than the highest id in use,
 * so it never picks this one: its ids stay far below it while this rule is
 * absent, and go above it once the rule is in place.
 */
export const PHISHING_WARNING_REDIRECT_RULE_ID = 1_000_000

/** The web-accessible page that hands the blocked URL on to the warning screen. */
export const PHISHING_WARNING_PAGE = 'phishing-warning.html'

/**
 * How long to wait before each retry of a failed update, and then before each
 * later one, up to the last attempt, as for the block rule. A removal is
 * retried every minute for as long as it fails while the worker runs: the
 * rule it leaves outranks the block rule without firing, so denylisted pages
 * would load.
 */
const REDIRECT_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000]
const REDIRECT_LATER_RETRY_DELAY_MS = 60_000
const REDIRECT_MAX_ATTEMPTS = 10

function createRedirectRule(domains: string[]): Rule {
  const { ResourceType, RuleActionType } = chrome.declarativeNetRequest
  return {
    id: PHISHING_WARNING_REDIRECT_RULE_ID,
    priority: PHISHING_WARNING_REDIRECT_PRIORITY,
    action: {
      type: RuleActionType.REDIRECT,
      // The whole blocked URL goes in the fragment, which no request carries.
      redirect: { regexSubstitution: `${chrome.runtime.getURL(PHISHING_WARNING_PAGE)}#\\0` },
    },
    condition: {
      regexFilter: '^https?://.*',
      requestDomains: domains,
      resourceTypes: [ResourceType.MAIN_FRAME],
    },
  }
}

/** Whether the rule the browser holds is exactly the wanted one, with nothing that would widen or narrow it. */
function isWantedRule(rule: Rule, wanted: Rule): boolean {
  return (
    rule.priority === wanted.priority &&
    rule.action.type === wanted.action.type &&
    hasOnlyKeys(rule.action, ['type', 'redirect']) &&
    rule.action.redirect?.regexSubstitution === wanted.action.redirect?.regexSubstitution &&
    hasOnlyKeys(rule.action.redirect ?? {}, ['regexSubstitution']) &&
    hasOnlyKeys(rule.condition, ['regexFilter', 'requestDomains', 'resourceTypes']) &&
    rule.condition.regexFilter === wanted.condition.regexFilter &&
    sameMembers(rule.condition.requestDomains, wanted.condition.requestDomains ?? []) &&
    sameMembers(rule.condition.resourceTypes, wanted.condition.resourceTypes ?? [])
  )
}

/**
 * Whether the extension may act on every denylisted domain, or `unknown` when
 * the browser could not say. Without that access, a redirect rule does not
 * fire, and it still outranks the block rule, so the page would load.
 */
async function hasHostAccess(domains: readonly string[]): Promise<boolean | 'unknown'> {
  if (typeof chrome.permissions?.contains !== 'function') return false
  try {
    // The patterns the manifest declares for the denylist.
    return await chrome.permissions.contains({ origins: dnrHostPermissions(domains) })
  } catch (error) {
    log.error('[Phishing] Failed to check host access to the denylist:', error)
    return 'unknown'
  }
}

/**
 * Host access as a health read reports it: `no-domains` when there is no
 * domain to ask about, and `unknown` when the browser cannot be asked or
 * cannot say, so that `false` always means the browser reported it withheld.
 */
async function measureHostAccess(
  domains: readonly string[]
): Promise<PhishingWarningRedirectHostAccess> {
  if (!domains.length) return 'no-domains'
  if (typeof chrome.permissions?.contains !== 'function') return 'unknown'
  return hasHostAccess(domains)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readRedirectRule(): Promise<Rule | undefined> {
  return (await chrome.declarativeNetRequest.getSessionRules()).find(
    rule => rule.id === PHISHING_WARNING_REDIRECT_RULE_ID
  )
}

/**
 * Keeps a session DNR `redirect` rule that sends a top-level navigation to a
 * denylisted host, however it got there (a link, a typed URL or a redirect
 * chain), to the wallet's warning page instead of the browser's blocked page.
 *
 * The rule is in place only while the extension holds host access to every
 * denylisted domain, which the user can withhold in the browser's site access
 * settings. Without it the block rule decides alone, and the browser shows its
 * blocked page. Every change of the permissions brings the rule in line again.
 * Its health tells whether a rule that does not fire may still be in place,
 * outranking the block rule, while its removal is pending or failing.
 */
export class PhishingWarningRedirect {
  // Serializes updates, so each one reads the permissions and rules that the
  // previous one left.
  private queue: Promise<unknown> = Promise.resolve()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  // Each trigger starts a new run with its own attempts; only the latest run
  // schedules a retry.
  private latestRun = 0
  // Attempts queued and not yet finished, including one running.
  private queuedAttempts = 0
  private failure: RedirectFailure | undefined
  // The health read in flight, which later callers share.
  private healthRead: Promise<HealthRead> | undefined
  private started = false

  constructor(private readonly listEntries: () => Iterable<unknown>) {}

  /** Follows host access from now on, and brings the rule in line with it. */
  start(): void {
    if (this.started) return
    this.started = true
    // Withholding site access fires onRemoved, and granting it back onAdded.
    chrome.permissions?.onAdded?.addListener(() => void this.sync())
    chrome.permissions?.onRemoved?.addListener(() => void this.sync())
    // Session rules end with the browser session. Listening for the browser's
    // start has it start the worker, which installs the rule again, rather
    // than waiting for another event while restored tabs load.
    chrome.runtime.onStartup?.addListener(() => void this.sync())
    void this.sync()
  }

  /**
   * Adds the rule while the extension has host access to the whole denylist,
   * and removes it otherwise. Never rejects: a failure is logged and retried,
   * and a newer sync takes over from the retries of an earlier one.
   */
  sync(): Promise<void> {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    return this.attempt(++this.latestRun, 1)
  }

  /**
   * One attempt of a run. The latest run's outcome replaces the recorded
   * failure, or clears it on success; it settles within the queue, so that a
   * health read queued after it sees that outcome.
   */
  private attempt(run: number, attempt: number): Promise<void> {
    this.queuedAttempts++
    return this.enqueue(async () => {
      const outcome = { removing: false }
      try {
        await this.apply(outcome)
        if (run === this.latestRun) this.failure = undefined
      } catch (error) {
        log.error(
          `[Phishing] Failed to update the warning redirect rule (attempt ${attempt}):`,
          error
        )
        const delay =
          REDIRECT_RETRY_DELAYS_MS[attempt - 1] ??
          (attempt < REDIRECT_MAX_ATTEMPTS || outcome.removing
            ? REDIRECT_LATER_RETRY_DELAY_MS
            : undefined)
        if (run !== this.latestRun) return
        this.failure = {
          error: errorMessage(error),
          removal: outcome.removing,
          ...(delay !== undefined && { nextRetryAt: Date.now() + delay }),
        }
        if (delay === undefined) return
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined
          void this.attempt(run, attempt + 1)
        }, delay)
      } finally {
        this.queuedAttempts--
      }
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => undefined)
    return result
  }

  /**
   * Brings the rule in line. `outcome.removing` tells the caller whether a
   * rule that has to go may still be in place. Access the browser cannot
   * report counts as none, and fails the update afterwards so that it is
   * checked again.
   */
  private async apply(outcome: { removing: boolean }): Promise<void> {
    const { domains } = partitionDnrDomains(this.listEntries())
    const access = domains.length ? await hasHostAccess(domains) : false
    const wanted = access === true ? createRedirectRule(domains) : undefined
    // Until the rules are read, one may be in place.
    outcome.removing = !wanted

    const current = await readRedirectRule()
    outcome.removing = !wanted && !!current
    if (wanted ? !current || !isWantedRule(current, wanted) : current) {
      // One call swaps the rule, so a changed one never lapses in between.
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: current ? [current.id] : [],
        addRules: wanted ? [wanted] : [],
      })
      outcome.removing = false
      log.debug(
        wanted
          ? `[Phishing] Warning redirect rule installed for ${domains.length} domains`
          : '[Phishing] No host access to the denylist; the block rule alone applies'
      )
    }
    if (access === 'unknown') throw new Error('Host access to the denylist is unknown')
  }

  /**
   * The rule's state as a read finds it: whether a rule is in place, and
   * whether it may be, given host access now, with the failure and next
   * retry recorded when the read started. Callers share the read in flight.
   * When it finds a rule in place without confirmed access, while no attempt
   * is scheduled or queued, as after a permission change the worker missed,
   * a new run that removes it starts once the answer reaches a caller that
   * has not given up (`signal`). That run supersedes no attempt of an
   * earlier run, and the recorded failure stays until it replaces it.
   */
  async getHealth(signal?: AbortSignal): Promise<PhishingWarningRedirectHealth> {
    const { health, stranded } = await this.sharedHealthRead()
    if (
      stranded &&
      !signal?.aborted &&
      this.retryTimer === undefined &&
      this.queuedAttempts === 0
    ) {
      void this.attempt(++this.latestRun, 1)
    }
    return health
  }

  private sharedHealthRead(): Promise<HealthRead> {
    if (!this.healthRead) {
      const read = this.enqueue(() => this.readHealth())
      const done = (): void => {
        if (this.healthRead === read) this.healthRead = undefined
      }
      read.then(done, done)
      this.healthRead = read
    }
    return this.healthRead
  }

  private async readHealth(): Promise<HealthRead> {
    const failure = this.failure
    const { domains } = partitionDnrDomains(this.listEntries())
    const hostAccess = await measureHostAccess(domains)
    const measured = (
      status: PhishingWarningRedirectStatus,
      { error, nextRetryAt }: { error?: string; nextRetryAt?: number } = {},
      stranded = false
    ): HealthRead => ({
      health: {
        status,
        hostAccess,
        ...(error !== undefined && { error }),
        ...(nextRetryAt !== undefined && { nextRetryAt }),
        updatedAt: Date.now(),
      },
      stranded,
    })

    let current: Rule | undefined
    try {
      current = await readRedirectRule()
    } catch (error) {
      return measured('unknown', { error: errorMessage(error) })
    }
    if (hostAccess === true) {
      return current && isWantedRule(current, createRedirectRule(domains))
        ? measured('installed')
        : measured('missing', failure)
    }
    if (!current) return measured('not-wanted')

    // A rule without confirmed access may outrank the block rule.
    return hostAccess === 'unknown'
      ? measured('unknown', failure, true)
      : measured(failure?.removal ? 'removal-failed' : 'removing', failure, true)
  }

  /**
   * Whether the rule is in place, with host access, for this hostname, as
   * the browser holds it now: a canonical hostname that the rule names, or a
   * subdomain of one it names. A top-level navigation to it then ends on the
   * warning page in whichever tab it happens. It does not wait behind
   * updates: while one is queued or running, before or after the read, the
   * rule may be changing, and it is false. Anything not confirmed, including
   * a failed read, is false.
   */
  async covers(hostname: string): Promise<boolean> {
    if (this.queuedAttempts > 0) return false
    try {
      const parsed = parseDnrDomain(hostname)
      if (!parsed.ok || parsed.domain !== hostname) return false
      const { domains } = partitionDnrDomains(this.listEntries())
      if (!domains.length || (await hasHostAccess(domains)) !== true) return false
      const current = await readRedirectRule()
      if (!current || !isWantedRule(current, createRedirectRule(domains))) return false
      // An update that started meanwhile may be changing the rule.
      if (this.queuedAttempts > 0) return false
      return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
    } catch (error) {
      log.error('[Phishing] Failed to check the warning redirect rule:', error)
      return false
    }
  }
}
