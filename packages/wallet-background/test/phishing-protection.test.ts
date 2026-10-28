import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUNDLED_PHISHING_DENYLIST,
  dnrHostPermissions,
  partitionDnrDomains,
  PhishingService,
} from '@qbit/phishing-detect'
import {
  PhishingMessageType,
  type PhishingNetworkRuleHealth,
  type PhishingProtectionHealth,
} from '@qbit/wallet-shared'

type Rule = chrome.declarativeNetRequest.Rule
type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean
type SiteAccess = 'on all sites' | 'on click' | 'on specific sites'

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`
const [BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as [string]
const REDIRECT_RULE_ID = 1_000_000

const walletPage: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  origin: EXTENSION_ORIGIN,
  tab: { id: 7 } as chrome.tabs.Tab,
  url: `${EXTENSION_ORIGIN}/index.html#/settings`,
}

/**
 * The host permissions of the Chrome Web Store build (`build:chrome:mv3`,
 * channel `store`), merged from the raw manifests by the same function the
 * build uses.
 */
function storeHostPermissions(): string[] {
  const extensionDir = join(fileURLToPath(new URL('.', import.meta.url)), '../../../apps/extension')
  const require = createRequire(join(extensionDir, 'package.json'))
  const { mergeExtensionManifest } = require('./scripts/manifest-build-flavors.js') as {
    mergeExtensionManifest(options: {
      baseManifest: unknown
      browserManifest: unknown
      version: string
      channel: string
    }): { host_permissions: string[] }
  }
  const raw = (name: string) =>
    JSON.parse(readFileSync(join(extensionDir, 'build/_raw/manifest', name), 'utf8'))
  return mergeExtensionManifest({
    baseManifest: raw('_base_v3.json'),
    browserManifest: raw('chrome.json'),
    version: '1.0.7',
    channel: 'store',
  }).host_permissions
}

const STORE_HOST_PERMISSIONS = storeHostPermissions()
const DENYLIST_PATTERNS = dnrHostPermissions(partitionDnrDomains(BUNDLED_PHISHING_DENYLIST).domains)

function applyRuleUpdate(
  rules: Rule[],
  { removeRuleIds = [], addRules = [] }: chrome.declarativeNetRequest.UpdateRuleOptions
): Rule[] {
  const next = rules.filter(rule => !removeRuleIds.includes(rule.id))
  for (const rule of addRules) {
    if (next.some(existing => existing.id === rule.id)) {
      throw new Error(`Rule with id ${rule.id} already exists`)
    }
    next.push(structuredClone(rule))
  }
  return next
}

/**
 * A stand-in for the extension API, with the store build's host access: the
 * browser grants the manifest's host permissions unless the user withholds
 * them in the site access settings, and `permissions.contains` answers for
 * exactly the patterns it is asked about.
 */
function createBrowser() {
  const state = {
    dynamicRules: [] as Rule[],
    sessionRules: [] as Rule[],
    listener: undefined as MessageListener | undefined,
    granted: new Set(STORE_HOST_PERMISSIONS),
    permissionListeners: { added: [] as (() => void)[], removed: [] as (() => void)[] },
  }
  const declarativeNetRequest = {
    RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow' },
    ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame' },
    getDynamicRules: vi.fn(async () => structuredClone(state.dynamicRules)),
    updateDynamicRules: vi.fn(async (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
      state.dynamicRules = applyRuleUpdate(state.dynamicRules, options)
    }),
    getSessionRules: vi.fn(async () => structuredClone(state.sessionRules)),
    updateSessionRules: vi.fn(async (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
      state.sessionRules = applyRuleUpdate(state.sessionRules, options)
    }),
  }
  const permissions = {
    contains: vi.fn(async ({ origins = [] }: chrome.permissions.Permissions) =>
      origins.every(origin => state.granted.has(origin))
    ),
    onAdded: {
      addListener: (listener: () => void) => state.permissionListeners.added.push(listener),
    },
    onRemoved: {
      addListener: (listener: () => void) => state.permissionListeners.removed.push(listener),
    },
  }
  const chromeStub = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
      onMessage: {
        addListener: (listener: MessageListener) => {
          state.listener = listener
        },
      },
      onStartup: { addListener: () => undefined },
    },
    declarativeNetRequest,
    permissions,
    tabs: { get: vi.fn(async () => ({ id: 7 })), update: vi.fn(async () => ({ id: 7 })) },
  }
  return { state, chrome: chromeStub, declarativeNetRequest, permissions }
}

type Browser = ReturnType<typeof createBrowser>

/**
 * Sets the wallet's site access as the browser's extension settings do.
 * `notify: false` leaves out the permission event, as when the worker missed it.
 */
function setSiteAccess(browser: Browser, access: SiteAccess, { notify = true } = {}) {
  const granted =
    access === 'on all sites'
      ? STORE_HOST_PERMISSIONS
      : access === 'on specific sites'
        ? // The user lets the wallet run on one of the denylisted sites only.
          STORE_HOST_PERMISSIONS.filter(pattern => pattern === DENYLIST_PATTERNS[0])
        : []
  browser.state.granted = new Set(granted)
  if (!notify) return
  const listeners = browser.state.permissionListeners
  for (const listener of access === 'on all sites' ? listeners.added : listeners.removed) listener()
}

async function startController(
  browser: Browser,
  service = new PhishingService(),
  installed = () => expect(browser.declarativeNetRequest.updateDynamicRules).toHaveBeenCalled()
) {
  vi.stubGlobal('chrome', browser.chrome)
  vi.resetModules()
  vi.doMock('src/services', () => ({ phishingDetectService: service }))
  const { default: controller } = await import('../src/controllers/phishing')
  controller.init()
  await vi.waitFor(() => {
    installed()
    expect(browser.declarativeNetRequest.getSessionRules).toHaveBeenCalledTimes(2)
  })
  await vi.advanceTimersByTimeAsync(0)
  return controller
}

async function phishingStats(browser: Browser) {
  const response = await new Promise(resolve => {
    browser.state.listener!({ type: PhishingMessageType.GET_PHISHING_STATS }, walletPage, resolve)
  })
  return response as {
    stats?: unknown
    error?: string
    networkRules: PhishingNetworkRuleHealth
    protection?: PhishingProtectionHealth
  }
}

async function protection(browser: Browser) {
  return (await phishingStats(browser)).protection
}

/** The next attempt is scheduled, at most `delay` from now. */
function expectRetryWithin({ warningRedirect }: PhishingProtectionHealth, delay: number) {
  expect(warningRedirect.nextRetryAt).toBeGreaterThan(Date.now())
  expect(warningRedirect.nextRetryAt).toBeLessThanOrEqual(Date.now() + delay)
}

function redirectRules(browser: Browser): Rule[] {
  return browser.state.sessionRules.filter(rule => rule.id === REDIRECT_RULE_ID)
}

describe('PhishingController protection health', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(log, 'error').mockImplementation(() => undefined)
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('takes the denylist host access from the store build', () => {
    expect(DENYLIST_PATTERNS.length).toBeGreaterThan(0)
    expect(STORE_HOST_PERMISSIONS).toEqual(expect.arrayContaining(DENYLIST_PATTERNS))
  })

  it('reports full protection with the block and redirect rules in place', async () => {
    const browser = createBrowser()
    await startController(browser)
    expect(redirectRules(browser)).toHaveLength(1)

    const stats = await phishingStats(browser)
    // The block rule's health keeps its shape.
    expect(stats.networkRules).toEqual({
      status: 'installed',
      attempts: 1,
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
      skippedEntries: [],
      updatedAt: Date.now(),
    })
    expect(stats.protection).toEqual({
      status: 'full',
      reasons: [],
      warningRedirect: { status: 'installed', hostAccess: true, updatedAt: Date.now() },
    })
  })

  it.each(['on click', 'on specific sites'] as const)(
    'reports the block rule alone as full protection once the redirect rule is gone with site access %s',
    async access => {
      const browser = createBrowser()
      await startController(browser)

      setSiteAccess(browser, access)
      await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))

      await expect(protection(browser)).resolves.toEqual({
        status: 'full',
        reasons: [],
        warningRedirect: { status: 'not-wanted', hostAccess: false, updatedAt: Date.now() },
      })
    }
  )

  it('reports degraded protection while the removal of a redirect rule without host access fails', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValueOnce(new Error('quota'))

    setSiteAccess(browser, 'on click')
    await vi.waitFor(() =>
      expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(2)
    )
    expect(redirectRules(browser)).toHaveLength(1)

    const stats = await phishingStats(browser)
    // The block rule is in place, but the redirect rule that does not fire
    // outranks it.
    expect(stats.networkRules).toMatchObject({ status: 'installed' })
    expect(stats.protection).toEqual({
      status: 'degraded',
      reasons: ['redirect-rule-without-host-access'],
      warningRedirect: {
        status: 'removal-failed',
        hostAccess: false,
        error: 'quota',
        nextRetryAt: expect.any(Number),
        updatedAt: Date.now(),
      },
    })
    expectRetryWithin(stats.protection!, 1_000)

    // The retry removes it.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(redirectRules(browser)).toEqual([])
    await expect(protection(browser)).resolves.toMatchObject({
      status: 'full',
      warningRedirect: { status: 'not-wanted', hostAccess: false },
    })
  })

  it('keeps reporting degraded protection for as long as the removal keeps failing', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValue(new Error('quota'))

    setSiteAccess(browser, 'on specific sites')
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    await expect(protection(browser)).resolves.toMatchObject({
      status: 'degraded',
      reasons: ['redirect-rule-without-host-access'],
      warningRedirect: { status: 'removal-failed', hostAccess: false, error: 'quota' },
    })
  })

  it('reports a pending removal as degraded, and removes a rule the worker missed', async () => {
    const browser = createBrowser()
    await startController(browser)

    // Access is withheld while the worker misses the permission event.
    setSiteAccess(browser, 'on click', { notify: false })

    await expect(protection(browser)).resolves.toEqual({
      status: 'degraded',
      reasons: ['redirect-rule-without-host-access'],
      warningRedirect: { status: 'removing', hostAccess: false, updatedAt: Date.now() },
    })
    await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))
    await expect(protection(browser)).resolves.toMatchObject({
      status: 'full',
      warningRedirect: { status: 'not-wanted' },
    })
  })

  it('reports a block rule that is not installed as degraded, and site access withheld with it', async () => {
    const browser = createBrowser()
    browser.declarativeNetRequest.updateDynamicRules.mockRejectedValue(new Error('Internal error'))
    await startController(browser)

    await expect(phishingStats(browser)).resolves.toMatchObject({
      networkRules: { status: 'retrying' },
      protection: {
        status: 'degraded',
        reasons: ['block-rule-not-installed'],
        warningRedirect: { status: 'installed', hostAccess: true },
      },
    })

    // Neither the network layer nor the content script's hold stops a page
    // on a site the wallet may not access.
    setSiteAccess(browser, 'on click')
    await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))
    await expect(protection(browser)).resolves.toMatchObject({
      status: 'degraded',
      reasons: ['block-rule-not-installed', 'site-access-withheld'],
      warningRedirect: { status: 'not-wanted', hostAccess: false },
    })

    // Once the block rule is installed, the block rule alone is full protection.
    browser.declarativeNetRequest.updateDynamicRules.mockImplementation(async options => {
      browser.state.dynamicRules = applyRuleUpdate(browser.state.dynamicRules, options)
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(phishingStats(browser)).resolves.toMatchObject({
      networkRules: { status: 'installed' },
      protection: { status: 'full', reasons: [] },
    })
  })

  it('reports a block rule that gave up as degraded', async () => {
    const browser = createBrowser()
    browser.declarativeNetRequest.updateDynamicRules.mockRejectedValue(new Error('Internal error'))
    await startController(browser)

    await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 15_000 + 6 * 60_000)
    await expect(phishingStats(browser)).resolves.toMatchObject({
      networkRules: { status: 'failed' },
      protection: { status: 'degraded', reasons: ['block-rule-not-installed'] },
    })
  })

  it('reports the block rule found missing at a read as degraded', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.state.dynamicRules = []

    await expect(phishingStats(browser)).resolves.toMatchObject({
      networkRules: { status: 'retrying' },
      protection: { status: 'degraded', reasons: ['block-rule-not-installed'] },
    })
  })

  it('reports unknown, never full, while the block rule cannot be read back', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.getDynamicRules.mockRejectedValueOnce(new Error('read failed'))

    await expect(protection(browser)).resolves.toMatchObject({
      status: 'unknown',
      reasons: ['block-rule-unknown'],
      warningRedirect: { status: 'installed' },
    })
    await expect(protection(browser)).resolves.toMatchObject({ status: 'full' })
  })

  it('reports unknown, never full, while the redirect rule cannot be read', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.getSessionRules.mockRejectedValueOnce(
      new Error('rules unavailable')
    )

    await expect(protection(browser)).resolves.toEqual({
      status: 'unknown',
      reasons: ['redirect-rule-unknown'],
      warningRedirect: {
        status: 'unknown',
        hostAccess: true,
        error: 'rules unavailable',
        updatedAt: Date.now(),
      },
    })
    await expect(protection(browser)).resolves.toMatchObject({ status: 'full' })
  })

  it('reports unknown, never full, while a rule is in place and host access cannot be read', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.permissions.contains.mockRejectedValueOnce(new Error('permissions unavailable'))

    await expect(protection(browser)).resolves.toMatchObject({
      status: 'unknown',
      reasons: ['redirect-rule-unknown'],
      warningRedirect: { status: 'unknown', hostAccess: 'unknown' },
    })
    // Checked again at once; access is there, and the rule stays.
    await expect(protection(browser)).resolves.toMatchObject({
      status: 'full',
      warningRedirect: { status: 'installed', hostAccess: true },
    })
    expect(redirectRules(browser)).toHaveLength(1)
  })

  it('reports degraded over unknown when both apply', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.state.dynamicRules = []
    browser.declarativeNetRequest.getSessionRules.mockRejectedValueOnce(
      new Error('rules unavailable')
    )

    await expect(protection(browser)).resolves.toMatchObject({
      status: 'degraded',
      reasons: ['block-rule-not-installed', 'redirect-rule-unknown'],
    })
  })

  it('reports a failed removal as found, without erasing it or superseding the retry queued behind the read', async () => {
    const browser = createBrowser()
    await startController(browser)
    const updates = browser.declarativeNetRequest.updateSessionRules
    updates.mockRejectedValue(new Error('quota'))
    setSiteAccess(browser, 'on click')
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(2))
    const failed = (await protection(browser))!.warningRedirect
    expect(failed).toMatchObject({ status: 'removal-failed', error: 'quota' })

    // The next read waits on the browser's permission check while the
    // retry's timer fires and queues the retry behind the read.
    let answer: ((granted: boolean) => void) | undefined
    browser.permissions.contains.mockImplementationOnce(
      () => new Promise<boolean>(resolve => (answer = resolve))
    )
    const read = protection(browser)
    await vi.waitFor(() => expect(answer).toBeDefined())
    await vi.advanceTimersByTimeAsync(failed.nextRetryAt! - Date.now())
    answer!(false)

    await expect(read).resolves.toMatchObject({
      status: 'degraded',
      reasons: ['redirect-rule-without-host-access'],
      warningRedirect: {
        status: 'removal-failed',
        error: 'quota',
        nextRetryAt: failed.nextRetryAt,
      },
    })
    // The queued retry is the second attempt of the same run, and its
    // failure is recorded with that attempt's backoff; the read started no
    // run of its own.
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(3))
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveBeenCalledTimes(3)
    expect(log.error).toHaveBeenLastCalledWith(
      '[Phishing] Failed to update the warning redirect rule (attempt 2):',
      expect.objectContaining({ message: 'quota' })
    )
    const retried = (await protection(browser))!.warningRedirect
    expect(retried).toMatchObject({ status: 'removal-failed', error: 'quota' })
    expect(retried.nextRetryAt! - Date.now()).toBeGreaterThan(1_000)
    expect(retried.nextRetryAt! - Date.now()).toBeLessThanOrEqual(4_000)
  })

  it('answers the stats with the block rule health when the redirect rule health fails', async () => {
    const browser = createBrowser()
    await startController(browser)
    // The controller's own module instance.
    const { PhishingWarningRedirect } = await import('../src/controllers/phishing-warning-redirect')
    vi.spyOn(PhishingWarningRedirect.prototype, 'getHealth').mockRejectedValueOnce(
      new Error('health failed')
    )

    const stats = await phishingStats(browser)
    expect(stats).not.toHaveProperty('error')
    expect(stats.stats).toMatchObject({ blacklist: expect.any(Array) })
    expect(stats.networkRules).toMatchObject({ status: 'installed' })
    expect(stats.protection).toEqual({
      status: 'unknown',
      reasons: ['redirect-rule-unknown'],
      warningRedirect: {
        status: 'unknown',
        hostAccess: 'unknown',
        error: 'health failed',
        updatedAt: Date.now(),
      },
    })
  })

  it('answers the stats within a short wait while the redirect rule health is held up', async () => {
    const browser = createBrowser()
    await startController(browser)
    // A removal the browser never finishes holds up the redirect rule's queue.
    const updates = browser.declarativeNetRequest.updateSessionRules
    updates.mockImplementationOnce(() => new Promise<void>(() => undefined))
    setSiteAccess(browser, 'on click')
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(2))

    const respond = vi.fn()
    browser.state.listener!({ type: PhishingMessageType.GET_PHISHING_STATS }, walletPage, respond)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(respond).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(respond).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith({
      stats: expect.objectContaining({ blacklist: expect.any(Array) }),
      networkRules: expect.objectContaining({ status: 'installed' }),
      // The rule that has to go may still be in place: not full.
      protection: {
        status: 'unknown',
        reasons: ['redirect-rule-unknown'],
        warningRedirect: {
          status: 'unknown',
          hostAccess: 'unknown',
          error: 'No answer within 2000 ms',
          updatedAt: Date.now(),
        },
      },
    })
  })

  it('shares one health read among stats requests while it is in flight', async () => {
    const browser = createBrowser()
    await startController(browser)
    const contains = browser.permissions.contains
    let answer: ((granted: boolean) => void) | undefined
    contains.mockImplementationOnce(() => new Promise<boolean>(resolve => (answer = resolve)))

    const polls = [phishingStats(browser), phishingStats(browser), phishingStats(browser)]
    await vi.waitFor(() => expect(answer).toBeDefined())
    const checks = contains.mock.calls.length
    answer!(true)

    for (const stats of await Promise.all(polls)) {
      expect(stats.protection).toMatchObject({
        status: 'full',
        warningRedirect: { status: 'installed', hostAccess: true },
      })
    }
    // One read answered all three; none waits in the queue behind it.
    await vi.advanceTimersByTimeAsync(0)
    expect(contains).toHaveBeenCalledTimes(checks)
    // A later poll reads afresh.
    await protection(browser)
    expect(contains).toHaveBeenCalledTimes(checks + 1)
  })

  it('does not start a removal for a health read whose caller gave up', async () => {
    const browser = createBrowser()
    await startController(browser)
    const updates = browser.declarativeNetRequest.updateSessionRules
    // Access is withheld while the worker misses the permission event.
    setSiteAccess(browser, 'on click', { notify: false })
    let answer: ((granted: boolean) => void) | undefined
    browser.permissions.contains.mockImplementationOnce(
      () => new Promise<boolean>(resolve => (answer = resolve))
    )

    const stats = phishingStats(browser)
    await vi.waitFor(() => expect(answer).toBeDefined())
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(stats).resolves.toMatchObject({ protection: { status: 'unknown' } })
    const updatesBefore = updates.mock.calls.length

    // The read finds the rule in place without access only after the stats gave up.
    answer!(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveBeenCalledTimes(updatesBefore)
    expect(redirectRules(browser)).toHaveLength(1)

    // A read answered in time starts the removal.
    await expect(protection(browser)).resolves.toMatchObject({
      status: 'degraded',
      warningRedirect: { status: 'removing' },
    })
    await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))
  })

  it('reports site access as unknown, not withheld, when the browser has no permission check', async () => {
    const browser = createBrowser()
    delete (browser.chrome as { permissions?: unknown }).permissions
    browser.declarativeNetRequest.updateDynamicRules.mockRejectedValue(new Error('Internal error'))
    await startController(browser)

    await expect(protection(browser)).resolves.toEqual({
      status: 'degraded',
      reasons: ['block-rule-not-installed', 'site-access-unknown'],
      warningRedirect: { status: 'not-wanted', hostAccess: 'unknown', updatedAt: Date.now() },
    })
  })

  it('reports no site access reason when no denylist entry can be named in a rule', async () => {
    const browser = createBrowser()
    const service = new PhishingService()
    vi.spyOn(service, 'getConfig').mockReturnValue({
      ...service.getConfig(),
      blacklist: ['ü.example'],
    })
    await startController(browser, service, () =>
      expect(browser.declarativeNetRequest.getDynamicRules).toHaveBeenCalled()
    )

    await expect(phishingStats(browser)).resolves.toMatchObject({
      networkRules: { status: 'failed' },
      protection: {
        status: 'degraded',
        reasons: ['block-rule-not-installed'],
        warningRedirect: { status: 'not-wanted', hostAccess: 'no-domains' },
      },
    })
    expect(browser.permissions.contains).not.toHaveBeenCalled()
  })

  it('reports a redirect rule that cannot be added as missing, which the block rule covers', async () => {
    const browser = createBrowser()
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValue(new Error('quota'))
    await startController(browser)

    const health = await protection(browser)
    expect(health).toEqual({
      status: 'full',
      reasons: [],
      warningRedirect: {
        status: 'missing',
        hostAccess: true,
        error: 'quota',
        nextRetryAt: expect.any(Number),
        updatedAt: Date.now(),
      },
    })
    expectRetryWithin(health!, 1_000)
  })
})

describe('PhishingController links that open a new tab', () => {
  const TAB_ID = 7
  const BLOCKED_URL = `http://${BLOCKED_HOST}/claim?ref=1`
  /** The clear page whose link to a denylisted host the user clicked. */
  const startPage: chrome.runtime.MessageSender = {
    frameId: 0,
    id: EXTENSION_ID,
    origin: 'https://example.com',
    tab: { id: TAB_ID } as chrome.tabs.Tab,
    url: 'https://example.com/start',
  }

  function clickLink(browser: Browser, message: Record<string, unknown>) {
    return new Promise(resolve => {
      browser.state.listener!(
        { type: PhishingMessageType.CHECK_NAVIGATION, url: BLOCKED_URL, ...message },
        startPage,
        resolve
      )
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(log, 'error').mockImplementation(() => undefined)
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    ['the host', BLOCKED_URL],
    ['a subdomain', `https://www.${BLOCKED_HOST}/claim`],
  ])(
    'leaves the source tab alone for %s while the redirect rule shows the warning in the new tab',
    async (_label, url) => {
      const browser = createBrowser()
      await startController(browser)

      await expect(clickLink(browser, { url, newTab: true })).resolves.toEqual({
        isPhishing: true,
        redirected: false,
        leftToRedirectRule: true,
      })
      expect(browser.chrome.tabs.update).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['without the flag', {}],
    ['with a flag that is not true', { newTab: 'true' }],
  ])('still sends the source tab to the warning page for a link %s', async (_label, message) => {
    const browser = createBrowser()
    await startController(browser)

    await expect(clickLink(browser, message)).resolves.toEqual({
      isPhishing: true,
      redirected: true,
    })
    expect(browser.chrome.tabs.update).toHaveBeenCalledWith(TAB_ID, {
      url: expect.stringContaining(`${EXTENSION_ORIGIN}/index.html#/phishing?`),
      active: true,
    })
  })

  it.each(['on click', 'on specific sites'] as const)(
    'sends the source tab to the warning page once the redirect rule is gone with site access %s',
    async access => {
      const browser = createBrowser()
      await startController(browser)
      setSiteAccess(browser, access)
      await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))

      await expect(clickLink(browser, { newTab: true })).resolves.toEqual({
        isPhishing: true,
        redirected: true,
      })
      expect(browser.chrome.tabs.update).toHaveBeenCalledOnce()
    }
  )

  it('sends the source tab to the warning page while a redirect rule without host access is still in place', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValue(new Error('quota'))
    setSiteAccess(browser, 'on click')
    await vi.waitFor(() =>
      expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(2)
    )
    expect(redirectRules(browser)).toHaveLength(1)

    await expect(clickLink(browser, { newTab: true })).resolves.toEqual({
      isPhishing: true,
      redirected: true,
    })
    expect(browser.chrome.tabs.update).toHaveBeenCalledOnce()
  })

  it('sends the source tab to the warning page while the redirect rule could not be added', async () => {
    const browser = createBrowser()
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValue(new Error('quota'))
    await startController(browser)
    expect(redirectRules(browser)).toEqual([])

    await expect(clickLink(browser, { newTab: true })).resolves.toEqual({
      isPhishing: true,
      redirected: true,
    })
  })

  it('sends the source tab to the warning page for a link clicked while the redirect rule is being installed', async () => {
    const browser = createBrowser()
    await startController(browser)
    setSiteAccess(browser, 'on click')
    await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))
    // Access returns, and the install that follows has not finished at the
    // click: the new tab gets the block rule's page, not the warning.
    let finishInstall: (() => void) | undefined
    browser.declarativeNetRequest.updateSessionRules.mockImplementationOnce(
      options =>
        new Promise<void>(resolve => {
          finishInstall = () => {
            browser.state.sessionRules = applyRuleUpdate(browser.state.sessionRules, options)
            resolve()
          }
        })
    )
    setSiteAccess(browser, 'on all sites')
    await vi.waitFor(() => expect(finishInstall).toBeDefined())

    const click = clickLink(browser, { newTab: true })
    finishInstall!()

    await expect(click).resolves.toEqual({ isPhishing: true, redirected: true })
    expect(browser.chrome.tabs.update).toHaveBeenCalledOnce()
    // Once the rule is in place, a later click leaves the source tab alone.
    expect(redirectRules(browser)).toHaveLength(1)
    await expect(clickLink(browser, { newTab: true })).resolves.toMatchObject({
      leftToRedirectRule: true,
    })
  })

  it('sends the source tab to the warning page when the redirect rule check does not answer in time', async () => {
    const browser = createBrowser()
    await startController(browser)
    // A browser call that never returns.
    browser.permissions.contains.mockImplementationOnce(() => new Promise<boolean>(() => undefined))

    const respond = vi.fn()
    browser.state.listener!(
      { type: PhishingMessageType.CHECK_NAVIGATION, url: BLOCKED_URL, newTab: true },
      startPage,
      respond
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(respond).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ isPhishing: true, redirected: true })
    )
    expect(browser.chrome.tabs.update).toHaveBeenCalledOnce()
  })

  it('sends the source tab to the warning page when the redirect rule cannot be read', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.getSessionRules.mockRejectedValueOnce(
      new Error('rules unavailable')
    )

    await expect(clickLink(browser, { newTab: true })).resolves.toEqual({
      isPhishing: true,
      redirected: true,
    })
  })

  it('sends the source tab to the warning page for a denylisted name outside DNS syntax', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(
      clickLink(browser, { url: `https://a_b.${BLOCKED_HOST}/claim`, newTab: true })
    ).resolves.toEqual({ isPhishing: true, redirected: true })
  })

  it('leaves a link to a clear host to the browser', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(
      clickLink(browser, { url: 'https://example.com/claim', newTab: true })
    ).resolves.toEqual({ isPhishing: false, redirected: false })
    expect(browser.chrome.tabs.update).not.toHaveBeenCalled()
  })
})
