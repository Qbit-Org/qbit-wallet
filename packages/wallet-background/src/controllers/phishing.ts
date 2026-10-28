import log from 'loglevel'

import { normalizeHostname, parseDnrDomain } from '@qbit/phishing-detect'
import {
  PHISHING_PAGE_PROBE,
  PhishingMessageType,
  type PhishingNetworkRuleHealth,
  type PhishingProtectionHealth,
  type PhishingProtectionReason,
  type PhishingStatsResponse,
  type PhishingWarningRedirectHealth,
  PlatformEnv,
} from '@qbit/wallet-shared'
import { phishingDetectService as phishingService } from 'src/services'

import { initialNetworkRuleHealth, PhishingBlockRule } from './phishing-block-rule'
import {
  PHISHING_WARNING_REDIRECT_PRIORITY,
  PhishingWarningRedirect,
} from './phishing-warning-redirect'
import { isExtensionPageSender } from './ui-access'

// Messages that lift, reload or report on protection. Only the wallet's own
// pages may send them; a content script must not whitelist the page it runs
// in, or learn whether the network layer is down. The ADD_TO_WHITELIST and
// FORCE_RELOAD_PHISHING_LISTS names have no handler yet and are listed so that
// adding one cannot skip this check.
const EXTENSION_PAGE_MESSAGES: ReadonlySet<string> = new Set([
  PhishingMessageType.SKIP_PHISHING_PROTECTION,
  PhishingMessageType.ADD_TO_WHITELIST,
  PhishingMessageType.FORCE_UPDATE_PHISHING_LIST,
  PhishingMessageType.FORCE_RELOAD_PHISHING_LISTS,
  PhishingMessageType.GET_PHISHING_STATS,
])

// MV3 enforces the denylist with one dynamic DNR `block` rule, which needs no
// host permission. Above it, a session `redirect` rule sends top-level pages,
// however the tab got there, to the warning page; it fires only with host
// access to the blocked hosts, so it is in place only while the user has not
// withheld that access (PhishingWarningRedirect). Proceed adds a session
// `allow` rule for one host's top-level pages that outranks both until the
// browser session ends. Frames from that host stay blocked, so other sites
// cannot embed it once the user has proceeded.
const PHISHING_PROCEED_RULE_PRIORITY = PHISHING_WARNING_REDIRECT_PRIORITY + 1

// How long a tab sent to the warning page has to finish loading before the
// worker stops watching it.
const WARNING_PAGE_SETTLE_TIMEOUT_MS = 5_000

/** A redirect to the warning page whose outcome the worker still checks. */
interface WarningRedirect {
  readonly redirectUrl: string
}

// runtime.getContexts (Chrome 116) is newer than the typings.
type ExtensionContext = { frameId: number }
type RuntimeWithContexts = typeof chrome.runtime & {
  getContexts(filter: { contextTypes: string[]; tabIds: number[] }): Promise<ExtensionContext[]>
}

function hasGetContexts(runtime: typeof chrome.runtime): runtime is RuntimeWithContexts {
  return typeof (runtime as Partial<RuntimeWithContexts>).getContexts === 'function'
}

function createProceedRule(id: number, hostname: string): chrome.declarativeNetRequest.Rule {
  const { ResourceType, RuleActionType } = chrome.declarativeNetRequest
  return {
    id,
    priority: PHISHING_PROCEED_RULE_PRIORITY,
    action: { type: RuleActionType.ALLOW },
    condition: { requestDomains: [hostname], resourceTypes: [ResourceType.MAIN_FRAME] },
  }
}

/** The host a Proceed session rule allows, or undefined for any other rule. */
function proceedRuleHostname(rule: chrome.declarativeNetRequest.Rule): string | undefined {
  const domains = rule.condition.requestDomains
  if (
    rule.action.type !== chrome.declarativeNetRequest.RuleActionType.ALLOW ||
    rule.priority !== PHISHING_PROCEED_RULE_PRIORITY ||
    domains?.length !== 1
  ) {
    return undefined
  }
  return domains[0]
}

/**
 * Returns a denylisted host in the form a DNR rule may name it: a well-formed
 * public hostname covered by the bundled denylist. DNR rejects a rule whose
 * domains are not canonical hostnames, so only these get lifted by Proceed.
 * The block rule needs only the form check, as its domains are the denylist
 * entries themselves; a Proceed hostname comes from a message. Never use it
 * to decide whether a page is denylisted: that is
 * `phishingService.isDenylisted`, which also covers names such as `a_b.<entry>`
 * (#335).
 */
function toDnrDomain(value: unknown): string | undefined {
  const result = parseDnrDomain(value)
  return result.ok && phishingService.isDenylisted(result.domain) ? result.domain : undefined
}

/** The blocked page's URL, kept for Proceed only when it is http(s) on the warned host. */
function blockedPageHref(url: unknown, hostname: string): string {
  if (typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return isWeb && normalizeHostname(parsed.hostname) === normalizeHostname(hostname)
      ? parsed.href
      : ''
  } catch {
    return ''
  }
}

/**
 * Whether the network layer stops every denylisted page it names, from the
 * health of both rules. A part that could not be read makes it `unknown`,
 * never `full`.
 */
function summarizeProtection(
  networkRules: PhishingNetworkRuleHealth,
  warningRedirect: PhishingWarningRedirectHealth
): PhishingProtectionHealth {
  const degraded: PhishingProtectionReason[] = []
  const unknown: PhishingProtectionReason[] = []
  if (networkRules.status === 'unknown') unknown.push('block-rule-unknown')
  else if (networkRules.status !== 'installed') degraded.push('block-rule-not-installed')

  // A redirect rule that does not fire still outranks the block rule.
  if (warningRedirect.status === 'removing' || warningRedirect.status === 'removal-failed') {
    degraded.push('redirect-rule-without-host-access')
  } else if (warningRedirect.status === 'unknown') {
    unknown.push('redirect-rule-unknown')
  }
  // Nor does the content script's hold run where site access is withheld.
  if (degraded.includes('block-rule-not-installed') && warningRedirect.hostAccess === false) {
    degraded.push('site-access-withheld')
  }

  return {
    status: degraded.length ? 'degraded' : unknown.length ? 'unknown' : 'full',
    reasons: [...degraded, ...unknown],
    warningRedirect,
  }
}

/** How a watched tab ended up: loaded, closed, still loading at the timeout, or no longer watched. */
type TabSettleOutcome = 'complete' | 'removed' | 'timeout' | 'stopped'

interface TabSettleWatch {
  readonly outcome: Promise<TabSettleOutcome>
  /** Tells the watch that the navigation has started. */
  started(): void
  /** Stops watching and removes the listeners. */
  stop(): void
}

/**
 * Watches the tab until it stops loading after a navigation the caller is
 * about to start. Listening from before the start means no event of that
 * navigation is missed, and a `complete` event counts only once a fresh read
 * after the start confirms it, as one from the previous page can arrive in
 * between.
 */
function watchTabToSettle(tabId: number, timeoutMs: number): TabSettleWatch {
  let hasStarted = false
  let completedBeforeStart = false
  let check!: () => void
  let stop!: () => void
  const outcome = new Promise<TabSettleOutcome>(resolve => {
    let done = false
    const finish = (result: TabSettleOutcome): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      resolve(result)
    }
    check = (): void => {
      chrome.tabs.get(tabId).then(
        tab => {
          if (tab.status === 'complete') finish('complete')
        },
        () => finish('removed')
      )
    }
    const onUpdated = (id: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (id !== tabId || changeInfo.status !== 'complete') return
      if (hasStarted) check()
      else completedBeforeStart = true
    }
    const onRemoved = (id: number): void => {
      if (id === tabId) finish('removed')
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    stop = (): void => finish('stopped')
  })
  return {
    outcome,
    started: (): void => {
      hasStarted = true
      if (completedBeforeStart) check()
    },
    stop,
  }
}

/**
 * PhishingController class for handling all phishing protection related functionality
 */
class PhishingController {
  // Proceed rules outlive the service worker, but the service's in-memory
  // bypass list does not. Verdicts wait for it to be restored so a restarted
  // worker does not send an allowed tab back to the warning page.
  private sessionBypassesRestored: Promise<void> = Promise.resolve()
  // Serializes Proceed rule updates so concurrent requests cannot pick one id.
  private sessionRuleUpdates: Promise<unknown> = Promise.resolve()
  // The latest redirect to the warning page per tab, until its outcome is checked.
  private readonly warningRedirects = new Map<number, WarningRedirect>()
  private readonly blockRule = new PhishingBlockRule(
    () => phishingService.getConfig().blacklist ?? []
  )
  private readonly warningRedirect = new PhishingWarningRedirect(
    () => phishingService.getConfig().blacklist ?? []
  )

  /**
   * Initialize phishing protection features
   */
  public init(): void {
    // Register message listener for phishing-related messages
    this.registerMessageListener()

    this.sessionBypassesRestored = this.restoreSessionBypasses()

    // Setup declarative rules for MV3
    this.setupDeclarativeRules()
  }

  private hasDeclarativeNetRequest(): boolean {
    return PlatformEnv.MANIFEST_VERSION === 'mv3' && !!chrome.declarativeNetRequest
  }

  /** Re-applies the in-memory bypass for every Proceed rule left in this browser session. */
  private async restoreSessionBypasses(): Promise<void> {
    if (!this.hasDeclarativeNetRequest()) return

    try {
      for (const rule of await chrome.declarativeNetRequest.getSessionRules()) {
        const hostname = proceedRuleHostname(rule)
        if (hostname) phishingService.addToWhitelist(hostname)
      }
    } catch (error) {
      log.error('[Phishing] Failed to restore session bypasses:', error)
    }
  }

  /** Answers once session bypasses are restored, so the verdict reflects them. */
  private respondAfterRestore(
    sendResponse: (response?: unknown) => void,
    respond: () => unknown
  ): true {
    this.sessionBypassesRestored
      .then(respond)
      .then(sendResponse, () => sendResponse({ error: 'Internal error processing request' }))
    return true
  }

  /**
   * Lets the host through the block rule for the rest of this browser session.
   * Without DNR (MV2), the content-script warning is the only layer and the
   * in-memory bypass is enough.
   */
  private allowForSession(hostname: string): Promise<void> {
    if (!this.hasDeclarativeNetRequest()) return Promise.resolve()

    const update = this.sessionRuleUpdates.then(() => this.addProceedRule(hostname))
    this.sessionRuleUpdates = update.catch(() => undefined)
    return update
  }

  private async addProceedRule(hostname: string): Promise<void> {
    const rules = await chrome.declarativeNetRequest.getSessionRules()
    if (rules.some(rule => proceedRuleHostname(rule) === hostname)) return

    const id = rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [createProceedRule(id, hostname)],
    })
  }

  /**
   * Register message listener for phishing-related messages
   */
  private registerMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Handle phishing-related messages
      if (Object.values(PhishingMessageType).includes(message.type)) {
        return this.handleMessage(message, sender, sendResponse)
      }

      return false
    })
  }

  /**
   * Handle phishing-related messages
   * @param message Message object
   * @param sender Sender information
   * @param sendResponse Response callback
   * @returns True if handled asynchronously
   */
  private handleMessage(
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ): boolean {
    if (EXTENSION_PAGE_MESSAGES.has(message.type) && !isExtensionPageSender(sender)) {
      sendResponse({ error: 'Unauthorized sender' })
      return false
    }

    try {
      switch (message.type) {
        case PhishingMessageType.CHECK_PHISHING: {
          if (!message.hostname) {
            sendResponse({ error: 'Missing hostname parameter' })
            return false
          }

          return this.respondAfterRestore(sendResponse, () => ({
            isPhishing: phishingService.checkPhishing(message.hostname).isPhishing,
            // Ignores Proceed, so a page the user proceeded to still gets no
            // wallet provider. Not limited to canonical hostnames: after
            // Proceed, `a_b.<entry>` loads too and must not get one either.
            isDenylisted: phishingService.isDenylisted(message.hostname),
          }))
        }

        case PhishingMessageType.REDIRECT_TO_PHISHING_PAGE: {
          const tabId = sender.tab?.id
          if (!tabId || !message.hostname) {
            sendResponse({ error: 'Invalid parameters or sender' })
            return false
          }

          return this.respondAfterRestore(sendResponse, async () => {
            // Verify the domain is still in the blacklist before redirecting
            if (!phishingService.checkPhishing(message.hostname).isPhishing) {
              return { success: false, skipped: true }
            }

            try {
              const href = blockedPageHref(message.url, message.hostname)
              await this.redirectToPhishingPage(tabId, href, message.hostname)
              return { success: true }
            } catch (error) {
              return { error: String(error) }
            }
          })
        }

        case PhishingMessageType.SKIP_PHISHING_PROTECTION: {
          if (!message.hostname) {
            sendResponse({ error: 'Missing hostname parameter' })
            return false
          }

          const hostname = toDnrDomain(message.hostname)
          if (!hostname) {
            sendResponse({ error: 'Invalid hostname parameter' })
            return false
          }

          // Answer only once the allow rule is in place: the warning page
          // navigates on success, and the block rule would stop it otherwise.
          this.allowForSession(hostname)
            .then(() => {
              phishingService.addToWhitelist(hostname)
              sendResponse({ success: true })
            })
            .catch(error => sendResponse({ error: String(error) }))
          return true
        }

        case PhishingMessageType.FORCE_UPDATE_PHISHING_LIST: {
          // Also installs the block rule again, and fails while it is not in place.
          this.forceUpdate()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ error: String(error) }))
          return true
        }

        case PhishingMessageType.GET_PHISHING_STATS: {
          this.getNetworkRuleHealth()
            .then(async networkRules => {
              const protection = await this.getProtectionHealth(networkRules)
              const response: PhishingStatsResponse = {
                stats: phishingService.getConfig(),
                networkRules,
                ...(protection && { protection }),
              }
              return response
            })
            .then(sendResponse, () => sendResponse({ error: 'Internal error processing request' }))
          return true
        }

        case PhishingMessageType.CHECK_NAVIGATION: {
          if (!message.url) {
            sendResponse({ error: 'Missing URL parameter' })
            return false
          }

          let url: URL
          try {
            url = new URL(message.url)
          } catch (error) {
            sendResponse({ isPhishing: false, error: String(error) })
            return false
          }

          // Skip checks for phishing warning page URL
          if (message.url.includes(chrome.runtime.getURL('index.html#/phishing'))) {
            sendResponse({ isPhishing: false, skipped: true })
            return false
          }

          const tabId = sender.tab?.id
          const newTab = message.newTab === true
          return this.respondAfterRestore(sendResponse, async () => {
            const isPhishing = phishingService.checkPhishing(url.hostname).isPhishing
            if (!isPhishing || !tabId) return { isPhishing, redirected: false }
            // The link opens a new tab or window. Where the redirect rule
            // shows the warning there, the sender's tab keeps its page.
            if (newTab && (await this.isCoveredByWarningRedirect(url.hostname))) {
              return { isPhishing, redirected: false, leftToRedirectRule: true }
            }

            try {
              const href = blockedPageHref(message.url, url.hostname)
              await this.redirectToPhishingPage(tabId, href, url.hostname)
              return { isPhishing, redirected: true }
            } catch (error) {
              return { isPhishing, redirected: false, error: String(error) }
            }
          })
        }
      }
    } catch (error) {
      sendResponse({ error: 'Internal error processing request' })
    }

    return false
  }

  /**
   * Redirect a tab to the phishing warning page
   * @param tabId Tab ID to redirect
   * @param url Original URL that was blocked
   * @param hostname Hostname that triggered the phishing detection
   */
  public async redirectToPhishingPage(tabId: number, url: string, hostname: string): Promise<void> {
    try {
      // Check if current URL is already the warning page to avoid repeated redirects
      const tab = await chrome.tabs.get(tabId)
      const currentUrl = tab.url || ''

      // If already on warning page, don't redirect again
      if (currentUrl.includes('index.html#/phishing')) {
        return
      }

      const params = new URLSearchParams({
        hostname,
        href: url,
        timestamp: Date.now().toString(), // Add timestamp to prevent caching
      })

      const redirectUrl = chrome.runtime.getURL(`index.html#/phishing?${params}`)
      const redirect: WarningRedirect = { redirectUrl }
      const runtime = this.runtimeForWarningCheck()
      const watch = runtime ? watchTabToSettle(tabId, WARNING_PAGE_SETTLE_TIMEOUT_MS) : undefined
      if (watch) this.warningRedirects.set(tabId, redirect)
      try {
        await chrome.tabs.update(tabId, { url: redirectUrl, active: true })
      } catch (error) {
        watch?.stop()
        this.endWarningRedirect(tabId, redirect)
        throw error
      }
      if (runtime && watch) {
        watch.started()
        void this.confirmWarningPage(runtime, tabId, redirect, hostname, watch)
      }
    } catch (error) {
      log.error('[Phishing] Failed to redirect tab:', error)
      throw error // Re-throw to allow proper error handling by caller
    }
  }

  private isCurrentWarningRedirect(tabId: number, redirect: WarningRedirect): boolean {
    return this.warningRedirects.get(tabId) === redirect
  }

  private endWarningRedirect(tabId: number, redirect: WarningRedirect): void {
    if (this.isCurrentWarningRedirect(tabId, redirect)) this.warningRedirects.delete(tabId)
  }

  /**
   * The runtime, when the outcome of a redirect to the warning page is worth
   * checking and can be. Only the DNR block rule stops the link navigation;
   * without it the content script on the phishing page asks for the warning
   * itself. The check also needs to see the extension's own pages in a tab.
   */
  private runtimeForWarningCheck(): RuntimeWithContexts | undefined {
    const runtime = chrome.runtime
    return this.hasDeclarativeNetRequest() && hasGetContexts(runtime) ? runtime : undefined
  }

  /** Whether the redirect should still be repeated, checked before and after each look at the tab. */
  private shouldRepeatWarningRedirect(
    tabId: number,
    redirect: WarningRedirect,
    hostname: string
  ): boolean {
    return (
      this.isCurrentWarningRedirect(tabId, redirect) &&
      phishingService.checkPhishing(hostname).isPhishing
    )
  }

  /**
   * Whether the tab's top frame shows a page the content script runs on. It
   * does not run on Chrome's error pages, so such a page is one the user went
   * back or on to, or one whose navigation never left.
   */
  private async isContentScriptPageInTab(tabId: number): Promise<boolean> {
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: PHISHING_PAGE_PROBE },
        { frameId: 0 }
      )
      return response?.present === true
    } catch {
      // No content script answered.
      return false
    }
  }

  /**
   * The link navigation the redirect replaces can still commit after it and
   * leave the tab on Chrome's blocked page, for example when the content
   * script could not cancel the click (#320). Once the tab settles, redirects
   * once more if the tab is still on that navigation: neither one of the
   * extension's pages nor one the content script runs on is in it, and the
   * user has not proceeded to the host. The tab's URL is hidden without the
   * `tabs` permission, so these are the signals the worker has.
   */
  private async confirmWarningPage(
    runtime: RuntimeWithContexts,
    tabId: number,
    redirect: WarningRedirect,
    hostname: string,
    watch: TabSettleWatch
  ): Promise<void> {
    try {
      const outcome = await watch.outcome
      if (outcome === 'timeout') {
        log.warn('[Phishing] The tab was still loading; not checking for the warning page')
      }
      if (outcome !== 'complete' || !this.shouldRepeatWarningRedirect(tabId, redirect, hostname)) {
        return
      }

      const contexts = await runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tabId] })
      if (contexts.some(context => context.frameId === 0)) return
      if (await this.isContentScriptPageInTab(tabId)) return
      // A newer redirect or a Proceed may have arrived during those checks.
      if (!this.shouldRepeatWarningRedirect(tabId, redirect, hostname)) return

      // An error, so that the default log level shows that the first
      // redirect lost to the blocked navigation. The first redirect brought
      // the tab to the front; the user may have moved on to another since.
      log.error('[Phishing] The warning page did not load; redirecting the tab again')
      await chrome.tabs.update(tabId, { url: redirect.redirectUrl })
    } catch (error) {
      log.error('[Phishing] Failed to confirm the warning page:', error)
    } finally {
      watch.stop()
      this.endWarningRedirect(tabId, redirect)
    }
  }

  /**
   * Setup phishing protection using declarative rules
   * Initializes rules from the policy bundled with this extension release.
   */
  public setupDeclarativeRules(): void {
    if (!this.hasDeclarativeNetRequest()) {
      return
    }

    // Initialize declarative rules when extension loads
    this.warningRedirect.start()
    void this.initDeclarativeRules()
  }

  /**
   * Initialize declarative network request rules for phishing protection
   * Creates initial rule set based on current phishing list. A failure is
   * retried in the background and shows in getNetworkRuleHealth().
   */
  public async initDeclarativeRules(): Promise<void> {
    if (!this.hasDeclarativeNetRequest()) return
    await this.blockRule.install()
  }

  /**
   * Replace the dynamic rules with one block rule for the bundled denylist
   * Only applicable for MV3 extensions. Rejects when the rule is not in place
   * after the first attempt; retries continue in the background.
   */
  public async updateDeclarativeRules(): Promise<void> {
    if (!this.hasDeclarativeNetRequest()) {
      log.warn('[Phishing] Declarative rules are only available in MV3')
      return
    }

    const health = await this.blockRule.install()
    if (health.status !== 'installed') {
      throw new Error(`Phishing block rule not installed: ${health.error ?? health.status}`)
    }
  }

  /**
   * Whether the DNR block rule is in place, for diagnostics. Without DNR the
   * content script is the only layer, and the status is `unsupported`.
   */
  public async getNetworkRuleHealth(): Promise<PhishingNetworkRuleHealth> {
    if (!this.hasDeclarativeNetRequest()) {
      return initialNetworkRuleHealth('unsupported')
    }
    return this.blockRule.getHealth()
  }

  /**
   * Whether the network layer as a whole stops denylisted pages, given the
   * block rule's health, with the warning redirect rule's state read back
   * from the browser. Undefined without DNR, where the content script is the
   * only layer.
   */
  public async getProtectionHealth(
    networkRules: PhishingNetworkRuleHealth
  ): Promise<PhishingProtectionHealth | undefined> {
    if (!this.hasDeclarativeNetRequest()) return undefined
    return summarizeProtection(networkRules, await this.warningRedirect.getHealth())
  }

  /**
   * Whether the warning redirect rule is in place, with host access, for the
   * host, so that a top-level navigation to it shows the warning in whichever
   * tab it happens. False when that is not confirmed.
   */
  private async isCoveredByWarningRedirect(hostname: string): Promise<boolean> {
    return this.hasDeclarativeNetRequest() && this.warningRedirect.covers(hostname)
  }

  /**
   * Force update of phishing list and rules
   */
  public async forceUpdate(): Promise<void> {
    try {
      await phishingService.forceUpdate()

      if (this.hasDeclarativeNetRequest()) {
        // Never rejects; the block rule's outcome decides this one.
        const redirectSynced = this.warningRedirect.sync()
        try {
          await this.updateDeclarativeRules()
        } finally {
          await redirectSynced
        }
      }

      log.debug('[Phishing] Bundled rules reapplied successfully')
    } catch (error) {
      log.error('[Phishing] Force update failed:', error)
      throw error
    }
  }

  /**
   * Reapply the phishing policy bundled with this extension release.
   */
  public async forceReload(): Promise<void> {
    log.debug('[PhishingController] Reapplying bundled phishing policy')
    try {
      await phishingService.forceUpdate()
      log.debug('[PhishingController] Bundled phishing policy reapplied successfully')

      // Get updated statistics
      const stats = phishingService.getConfig()
      log.debug(
        `[PhishingController] Updated stats: blacklist size: ${stats.blacklist?.length || 0}, whitelist size: ${
          stats.whitelist?.length || 0
        }`
      )

      return Promise.resolve()
    } catch (error) {
      log.error('[PhishingController] Failed to reload phishing lists:', error)
      return Promise.reject(error)
    }
  }

  /**
   * Check if a hostname is in the phishing blacklist
   * @param hostname Hostname to check
   * @returns True if hostname is in blacklist
   */
  public checkPhishing(hostname: string): boolean {
    // Basic validation
    if (!hostname || typeof hostname !== 'string') {
      log.warn(`[PhishingController] Invalid hostname: ${hostname}`)
      return false
    }

    // Get phishing service stats
    const stats = phishingService.getConfig()
    const blacklistSize = stats.blacklist?.length || 0
    const whitelistSize = stats.whitelist?.length || 0

    // If blacklist is empty but whitelist exists, might be an initialization issue
    if (blacklistSize === 0 && whitelistSize > 0) {
      return false
    }

    // Call service to check
    return phishingService.checkPhishing(hostname).isPhishing
  }

  /**
   * Add a hostname to the phishing whitelist
   * @param hostname Hostname to whitelist
   */
  public addToWhitelist(hostname: string): void {
    phishingService.addToWhitelist(hostname)
  }

  /**
   * Get phishing configuration and stats
   * @returns Phishing configuration object
   */
  public getStats(): any {
    return phishingService.getConfig()
  }
}

export default new PhishingController()
