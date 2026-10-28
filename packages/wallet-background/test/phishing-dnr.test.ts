import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUNDLED_PHISHING_DENYLIST, PhishingService } from '@qbit/phishing-detect'
import { PhishingMessageType, type PhishingNetworkRuleHealth } from '@qbit/wallet-shared'

type Rule = chrome.declarativeNetRequest.Rule
type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`
const [BLOCKED_HOST, OTHER_BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as [string, string]

const warningPage: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  origin: EXTENSION_ORIGIN,
  tab: { id: 7 } as chrome.tabs.Tab,
  url: `${EXTENSION_ORIGIN}/index.html#/phishing?hostname=${BLOCKED_HOST}`,
}

const contentScript: chrome.runtime.MessageSender = {
  frameId: 0,
  id: EXTENSION_ID,
  origin: `https://${BLOCKED_HOST}`,
  tab: { id: 7 } as chrome.tabs.Tab,
  url: `https://${BLOCKED_HOST}/claim?ref=1`,
}

function applyRuleUpdate(
  rules: Rule[],
  { removeRuleIds = [], addRules = [] }: chrome.declarativeNetRequest.UpdateRuleOptions
): Rule[] {
  const next = rules.filter(rule => !removeRuleIds.includes(rule.id))
  for (const rule of addRules) {
    // Chrome rejects the whole update when a rule id is already in use, or
    // when a rule names no domain or one that is not ASCII.
    if (next.some(existing => existing.id === rule.id)) {
      throw new Error(`Rule with id ${rule.id} already exists`)
    }
    const domains = rule.condition.requestDomains
    // eslint-disable-next-line no-control-regex -- the ASCII range is the check
    if (domains && (!domains.length || domains.some(domain => !/^[\x00-\x7f]+$/.test(domain)))) {
      throw new Error(`Rule with id ${rule.id} has an invalid "requestDomains" value`)
    }
    next.push(structuredClone(rule))
  }
  return next
}

/**
 * A stand-in for the parts of the extension API the controller uses. Host
 * access to the denylist is off unless a test grants it, as when the user has
 * withheld it.
 */
function createBrowser(
  initial: { dynamicRules?: Rule[]; sessionRules?: Rule[]; hostAccess?: boolean } = {}
) {
  const state = {
    dynamicRules: [...(initial.dynamicRules ?? [])],
    sessionRules: [...(initial.sessionRules ?? [])],
    listener: undefined as MessageListener | undefined,
    hostAccess: initial.hostAccess ?? false,
    permissionListeners: { added: [] as (() => void)[], removed: [] as (() => void)[] },
    startupListeners: [] as (() => void)[],
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
  const tabs = {
    get: vi.fn(async () => ({ id: 7 })),
    update: vi.fn(async () => ({ id: 7 })),
  }
  const permissions = {
    contains: vi.fn(async (_permissions: chrome.permissions.Permissions) => state.hostAccess),
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
      onStartup: { addListener: (listener: () => void) => state.startupListeners.push(listener) },
    },
    declarativeNetRequest,
    permissions,
    tabs,
  }
  return { state, chrome: chromeStub, declarativeNetRequest, permissions, tabs }
}

/** Grants or withholds host access, as the browser's site access setting does. */
function setHostAccess(browser: Browser, granted: boolean) {
  browser.state.hostAccess = granted
  const listeners = browser.state.permissionListeners
  for (const listener of granted ? listeners.added : listeners.removed) listener()
}

type Browser = ReturnType<typeof createBrowser>

/**
 * Starts a fresh controller, as a service worker start would, and waits until
 * the startup install has updated the rules, or `settled` passes.
 */
async function startController(
  browser: Browser,
  service = new PhishingService(),
  settled = () => expect(browser.declarativeNetRequest.updateDynamicRules).toHaveBeenCalled()
) {
  vi.stubGlobal('chrome', browser.chrome)
  vi.resetModules()
  // The controller imports its services by the baseUrl path. A real detector
  // checks Proceed against the bundled denylist, and each start gets a fresh
  // one, as a restarted service worker would.
  vi.doMock('src/services', () => ({ phishingDetectService: service }))
  const { default: controller } = await import('../src/controllers/phishing')
  controller.init()
  // Let the startup rule installation settle.
  await vi.waitFor(settled)
  return controller
}

function send(browser: Browser, message: unknown, sender: chrome.runtime.MessageSender) {
  return new Promise(resolve => {
    browser.state.listener!(message, sender, resolve)
  })
}

function proceed(browser: Browser, hostname: unknown) {
  return send(browser, { type: PhishingMessageType.SKIP_PHISHING_PROTECTION, hostname }, warningPage)
}

function proceedRule(id: number, hostname: string): Rule {
  return {
    id,
    // Above the block rule (1) and the warning redirect (2).
    priority: 3,
    action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      requestDomains: [hostname],
      resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[],
    },
  }
}

function blockRule(domains: readonly string[]): Rule {
  return {
    id: 1,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      requestDomains: [...domains],
      resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
    },
  }
}

/** The per-domain redirect rules of 1.0.4 and earlier, which never fired. */
function earlierReleaseRules(): Rule[] {
  return BUNDLED_PHISHING_DENYLIST.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { url: `${EXTENSION_ORIGIN}/index.html#/phishing?hostname=${domain}` },
    },
    condition: {
      urlFilter: `||${domain}/`,
      resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[],
    },
  }))
}

async function networkRules(browser: Browser): Promise<PhishingNetworkRuleHealth> {
  const response = await send(browser, { type: PhishingMessageType.GET_PHISHING_STATS }, warningPage)
  return (response as { networkRules: PhishingNetworkRuleHealth }).networkRules
}

function checkHost(browser: Browser, hostname: string) {
  return send(browser, { type: PhishingMessageType.CHECK_PHISHING, hostname }, contentScript)
}

function warningUrlParams(browser: Browser): URLSearchParams {
  const [, update] = browser.tabs.update.mock.calls.at(-1) as unknown as [number, { url: string }]
  const hash = new URL(update.url).hash
  return new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
}

describe('PhishingController DNR enforcement', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('blocks the denylist with one rule that needs no host permission', async () => {
    const browser = createBrowser()
    await startController(browser)

    expect(browser.state.dynamicRules).toEqual([
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: {
          requestDomains: [...BUNDLED_PHISHING_DENYLIST],
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      },
    ])
  })

  it('swaps out the redirect rules of earlier releases in one update', async () => {
    const browser = createBrowser({ dynamicRules: earlierReleaseRules() })
    await startController(browser)

    // A single call, so there is no moment with neither rule set installed.
    expect(browser.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledOnce()
    expect(browser.state.dynamicRules).toHaveLength(1)
    expect(browser.state.dynamicRules[0]!.action.type).toBe('block')
  })

  it('lets Proceed through the block rule with a higher-priority session allow rule', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(proceed(browser, BLOCKED_HOST)).resolves.toEqual({ success: true })

    expect(browser.state.sessionRules).toEqual([proceedRule(1, BLOCKED_HOST)])
    const [blockRule] = browser.state.dynamicRules
    expect(browser.state.sessionRules[0]!.priority).toBeGreaterThan(blockRule!.priority!)
    // Only top-level pages are allowed; other sites still cannot frame the host.
    expect(blockRule!.condition.resourceTypes).toContain('sub_frame')
    expect(browser.state.sessionRules[0]!.condition.resourceTypes).toEqual(['main_frame'])
    // The content-script verdict agrees with the network layer, for the host
    // and for a subdomain it redirects to, while still marking it denylisted
    // so that the page gets no wallet provider.
    // That includes subdomains whose label is outside DNS syntax: Chrome
    // loads them under the allow rule too (#335).
    for (const hostname of [
      BLOCKED_HOST,
      `www.${BLOCKED_HOST}`,
      `a_b.${BLOCKED_HOST}`,
      `x-.${BLOCKED_HOST}`,
      `-x.${BLOCKED_HOST}`,
      `WWW.${BLOCKED_HOST.toUpperCase()}.`,
    ]) {
      await expect(checkHost(browser, hostname)).resolves.toEqual({
        isPhishing: false,
        isDenylisted: true,
      })
    }
    // Other denylisted hosts stay blocked.
    await expect(checkHost(browser, OTHER_BLOCKED_HOST)).resolves.toEqual({
      isPhishing: true,
      isDenylisted: true,
    })
    await expect(checkHost(browser, 'example.com')).resolves.toEqual({
      isPhishing: false,
      isDenylisted: false,
    })
  })

  it('answers Proceed only after the allow rule is installed', async () => {
    const browser = createBrowser()
    await startController(browser)
    let finishUpdate!: () => void
    browser.declarativeNetRequest.updateSessionRules.mockImplementationOnce(
      options =>
        new Promise<void>(resolve => {
          finishUpdate = () => {
            browser.state.sessionRules = applyRuleUpdate(browser.state.sessionRules, options)
            resolve()
          }
        })
    )

    const response = vi.fn()
    browser.state.listener!(
      { type: PhishingMessageType.SKIP_PHISHING_PROTECTION, hostname: BLOCKED_HOST },
      warningPage,
      response
    )
    await vi.waitFor(() => expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalled())
    expect(response).not.toHaveBeenCalled()

    finishUpdate()
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ success: true }))
  })

  it('keeps one allow rule per host and gives concurrent hosts distinct ids', async () => {
    const browser = createBrowser()
    await startController(browser)

    await Promise.all([
      proceed(browser, BLOCKED_HOST),
      proceed(browser, OTHER_BLOCKED_HOST),
      proceed(browser, BLOCKED_HOST),
    ])

    expect(browser.state.sessionRules).toEqual([
      proceedRule(1, BLOCKED_HOST),
      proceedRule(2, OTHER_BLOCKED_HOST),
    ])
  })

  it.each([
    ['a host outside the denylist', 'example.com'],
    ['a host with a port', `${BLOCKED_HOST}:8443`],
    ['a host with a path', `${BLOCKED_HOST}/claim`],
    ['a host with credentials', `user@${BLOCKED_HOST}`],
    ['a host with a space', `a b.${BLOCKED_HOST}`],
    ['a subdomain outside DNS syntax', `a_b.${BLOCKED_HOST}`],
    ['a non-string hostname', [BLOCKED_HOST]],
  ])('refuses to Proceed for %s', async (_label, hostname) => {
    const browser = createBrowser()
    await startController(browser)

    await expect(proceed(browser, hostname)).resolves.toEqual({ error: 'Invalid hostname parameter' })
    expect(browser.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled()
  })

  it('reports a failed Proceed and leaves the host blocked', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValueOnce(new Error('quota'))

    await expect(proceed(browser, BLOCKED_HOST)).resolves.toEqual({ error: 'Error: quota' })
    await expect(checkHost(browser, BLOCKED_HOST)).resolves.toMatchObject({ isPhishing: true })

    // The queue recovers for the next attempt.
    await expect(proceed(browser, BLOCKED_HOST)).resolves.toEqual({ success: true })
  })

  it('honours a Proceed from before a service-worker restart', async () => {
    const browser = createBrowser({ sessionRules: [proceedRule(4, BLOCKED_HOST)] })
    let finishRestore!: () => void
    browser.declarativeNetRequest.getSessionRules.mockImplementationOnce(
      () =>
        new Promise<Rule[]>(resolve => {
          finishRestore = () => resolve(structuredClone(browser.state.sessionRules))
        })
    )
    await startController(browser)

    // The verdict waits for the restored bypasses rather than answering early.
    const verdict = checkHost(browser, BLOCKED_HOST)
    finishRestore()
    await expect(verdict).resolves.toMatchObject({ isPhishing: false })
    // A new Proceed rule takes the next free id.
    await expect(proceed(browser, OTHER_BLOCKED_HOST)).resolves.toEqual({ success: true })
    expect(browser.state.sessionRules.map(rule => rule.id)).toEqual([4, 5])
  })

  it('carries the blocked URL to the warning page from the content-script check', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(
      send(
        browser,
        {
          type: PhishingMessageType.REDIRECT_TO_PHISHING_PAGE,
          hostname: BLOCKED_HOST,
          url: `https://${BLOCKED_HOST}/claim?ref=1`,
        },
        contentScript
      )
    ).resolves.toEqual({ success: true })

    const params = warningUrlParams(browser)
    expect(params.get('hostname')).toBe(BLOCKED_HOST)
    expect(params.get('href')).toBe(`https://${BLOCKED_HOST}/claim?ref=1`)
  })

  it('carries the blocked URL to the warning page from a link check', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(
      send(
        browser,
        { type: PhishingMessageType.CHECK_NAVIGATION, url: `http://www.${BLOCKED_HOST}/a?b=1` },
        { ...contentScript, url: 'https://example.com/' }
      )
    ).resolves.toEqual({ isPhishing: true, redirected: true })

    const params = warningUrlParams(browser)
    expect(params.get('hostname')).toBe(`www.${BLOCKED_HOST}`)
    expect(params.get('href')).toBe(`http://www.${BLOCKED_HOST}/a?b=1`)
  })

  it.each([
    ['another host', 'https://example.com/claim'],
    // eslint-disable-next-line no-script-url -- the input under test
    ['a script URL', 'javascript:alert(1)'],
    ['a malformed URL', 'not a url'],
  ])('drops a blocked URL on %s', async (_label, url) => {
    const browser = createBrowser()
    await startController(browser)

    await send(
      browser,
      { type: PhishingMessageType.REDIRECT_TO_PHISHING_PAGE, hostname: BLOCKED_HOST, url },
      contentScript
    )

    expect(warningUrlParams(browser).get('href')).toBe('')
  })
})

describe('PhishingController DNR rule health', () => {
  let logError: ReturnType<typeof vi.spyOn>

  /** Install attempts: the updates that add a rule. */
  function installAttempts(browser: Browser): number {
    return browser.declarativeNetRequest.updateDynamicRules.mock.calls.filter(
      ([options]) => !!options.addRules?.length
    ).length
  }

  /** Makes every install attempt fail, while removing rules still works. */
  function failInstalls(browser: Browser, message: string) {
    browser.declarativeNetRequest.updateDynamicRules.mockImplementation(async options => {
      if (options.addRules?.length) throw new Error(message)
      browser.state.dynamicRules = applyRuleUpdate(browser.state.dynamicRules, options)
    })
  }

  beforeEach(() => {
    // Retries wait on timers, which no test leaves running for the next one.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // loglevel binds the console once, so watch it rather than the console.
    logError = vi.spyOn(log, 'error').mockImplementation(() => undefined)
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports the installed rule with the domains the browser holds', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(networkRules(browser)).resolves.toEqual({
      status: 'installed',
      attempts: 1,
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
      skippedEntries: [],
      updatedAt: Date.now(),
    })
  })

  it('leaves a block rule that is already in place as it is', async () => {
    const browser = createBrowser({ dynamicRules: [blockRule(BUNDLED_PHISHING_DENYLIST)] })
    await startController(browser, undefined, () =>
      expect(browser.declarativeNetRequest.getDynamicRules).toHaveBeenCalled()
    )

    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'installed',
      attempts: 1,
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
    })
    expect(browser.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled()
  })

  it('reports a failed startup install, removes the rules of earlier releases and retries', async () => {
    const browser = createBrowser({ dynamicRules: earlierReleaseRules() })
    browser.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(new Error('Internal error'))
    await startController(browser)

    const failed = await networkRules(browser)
    expect(failed).toMatchObject({ status: 'retrying', attempts: 1, error: 'Internal error' })
    expect(failed.nextRetryAt! - failed.updatedAt).toBe(1_000)
    expect(logError).toHaveBeenCalledWith(
      '[Phishing] Failed to install the block rule (attempt 1):',
      expect.objectContaining({ message: 'Internal error' })
    )
    // The inert redirect rules do not linger while the block rule is missing,
    // and the health says that no domain is blocked.
    expect(browser.state.dynamicRules).toEqual([])
    expect(failed.blockedDomains).toBe(0)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'installed',
      attempts: 2,
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
    })
    expect(await networkRules(browser)).not.toHaveProperty('error')
  })

  it('retries with a backoff capped at a minute', async () => {
    const browser = createBrowser({ dynamicRules: earlierReleaseRules() })
    failInstalls(browser, 'Internal error')
    await startController(browser)

    for (const [attempts, delay] of [
      [1, 1_000],
      [2, 4_000],
      [3, 15_000],
      [4, 60_000],
      [5, 60_000],
    ] as const) {
      const health = await networkRules(browser)
      expect(health).toMatchObject({ status: 'retrying', attempts, blockedDomains: 0 })
      expect(health.nextRetryAt! - health.updatedAt).toBe(delay)
      await vi.advanceTimersByTimeAsync(health.nextRetryAt! - Date.now() - 1)
      expect(installAttempts(browser)).toBe(attempts)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(logError).toHaveBeenLastCalledWith(
      '[Phishing] Failed to install the block rule (attempt 6):',
      expect.objectContaining({ message: 'Internal error' })
    )
    expect(browser.state.dynamicRules).toEqual([])

    // A later retry succeeds once the browser takes the rule.
    browser.declarativeNetRequest.updateDynamicRules.mockImplementation(async options => {
      browser.state.dynamicRules = applyRuleUpdate(browser.state.dynamicRules, options)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'installed',
      attempts: 7,
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
    })
    // And then no more attempts follow.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(installAttempts(browser)).toBe(7)
  })

  it('gives up after ten attempts', async () => {
    const browser = createBrowser()
    failInstalls(browser, 'Internal error')
    await startController(browser)

    await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 15_000 + 6 * 60_000)
    expect(installAttempts(browser)).toBe(10)
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'failed',
      attempts: 10,
      error: 'Internal error',
    })
    expect(await networkRules(browser)).not.toHaveProperty('nextRetryAt')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(installAttempts(browser)).toBe(10)
  })

  it('replaces a block rule that a further condition narrows', async () => {
    const narrowed = blockRule(BUNDLED_PHISHING_DENYLIST)
    narrowed.condition.domainType = 'thirdParty' as chrome.declarativeNetRequest.DomainType
    const browser = createBrowser({ dynamicRules: [narrowed] })
    await startController(browser)

    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed' })
  })

  it('keeps the block rule of an earlier install while a new one fails', async () => {
    const [redirectRule] = earlierReleaseRules()
    const browser = createBrowser({
      dynamicRules: [blockRule([BLOCKED_HOST]), { ...redirectRule!, id: 2 }],
    })
    failInstalls(browser, 'Internal error')
    await startController(browser)

    expect(browser.state.dynamicRules).toEqual([blockRule([BLOCKED_HOST])])
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'retrying',
      blockedDomains: 1,
    })
  })

  it('counts an update the browser does not hold as a failure', async () => {
    const browser = createBrowser()
    browser.declarativeNetRequest.updateDynamicRules.mockResolvedValueOnce(undefined)
    await startController(browser)

    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'retrying',
      blockedDomains: 0,
      error: 'The block rule is missing after the update',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed' })
  })

  it('leaves out list entries DNR would reject instead of failing the whole rule', async () => {
    const browser = createBrowser()
    const service = new PhishingService()
    vi.spyOn(service, 'getConfig').mockReturnValue({
      ...service.getConfig(),
      blacklist: [
        BLOCKED_HOST,
        'phïsh.example',
        '',
        `${BLOCKED_HOST}/claim`,
        `*.${BLOCKED_HOST}`,
        ` ${OTHER_BLOCKED_HOST.toUpperCase()}. `,
        42 as unknown as string,
      ],
    })
    await startController(browser, service)

    expect(browser.state.dynamicRules).toEqual([blockRule([BLOCKED_HOST, OTHER_BLOCKED_HOST])])
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'installed',
      blockedDomains: 2,
      skippedEntries: [
        { entry: 'phïsh.example', reason: 'non-ascii' },
        { entry: '', reason: 'empty' },
        { entry: `${BLOCKED_HOST}/claim`, reason: 'not-a-public-hostname' },
        { entry: `*.${BLOCKED_HOST}`, reason: 'not-a-public-hostname' },
        { entry: '42', reason: 'not-a-string' },
      ],
    })
    expect(log.warn).toHaveBeenCalledWith(
      '[Phishing] Denylist entries left out of the block rule:',
      expect.arrayContaining([{ entry: 'phïsh.example', reason: 'non-ascii' }])
    )
  })

  it('fails without retrying when no list entry can go in the rule', async () => {
    const browser = createBrowser({ dynamicRules: [blockRule([BLOCKED_HOST])] })
    const service = new PhishingService()
    vi.spyOn(service, 'getConfig').mockReturnValue({ ...service.getConfig(), blacklist: ['ü.example'] })
    await startController(browser, service, () =>
      expect(browser.declarativeNetRequest.getDynamicRules).toHaveBeenCalled()
    )

    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      blockedDomains: 1,
      error: 'No denylist entry can be named in a DNR rule',
    })
    // Reads do not start it over either.
    const rulesReads = browser.declarativeNetRequest.getDynamicRules.mock.calls.length
    await networkRules(browser)
    await networkRules(browser)
    expect(browser.declarativeNetRequest.getDynamicRules).toHaveBeenCalledTimes(rulesReads)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(installAttempts(browser)).toBe(0)
    // The earlier block rule still blocks its domain.
    expect(browser.state.dynamicRules).toEqual([blockRule([BLOCKED_HOST])])
  })

  it('reports a rule removed after the install instead of a stale success, and installs it again', async () => {
    const browser = createBrowser()
    await startController(browser)
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed' })

    browser.state.dynamicRules = []

    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'retrying',
      blockedDomains: 0,
      error: 'The block rule is no longer installed',
    })
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'installed',
      attempts: 1,
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
    })
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])
  })

  it('reports an unknown state while the rules cannot be read', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.declarativeNetRequest.getDynamicRules.mockRejectedValueOnce(new Error('read failed'))

    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'unknown',
      blockedDomains: null,
      error: 'read failed',
    })
    // The next read measures again.
    await expect(networkRules(browser)).resolves.toMatchObject({
      status: 'installed',
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
    })
  })

  it('lets a newer install supersede a failing one and its retries', async () => {
    const browser = createBrowser()
    let failFirst!: (error: Error) => void
    browser.declarativeNetRequest.updateDynamicRules.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (failFirst = reject))
    )
    const controller = await startController(browser)

    // The newer install waits for the attempt in flight, which then fails.
    const update = controller.forceUpdate()
    failFirst(new Error('stale failure'))
    await expect(update).resolves.toBeUndefined()

    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed', attempts: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(installAttempts(browser)).toBe(2)
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed' })
  })

  it('answers a superseded install with the outcome of the newer one', async () => {
    const browser = createBrowser()
    const controller = await startController(browser)
    // Taken away, so that each forced update has to install it.
    browser.state.dynamicRules = []
    let failFirst!: (error: Error) => void
    browser.declarativeNetRequest.updateDynamicRules.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (failFirst = reject))
    )

    const earlier = controller.forceUpdate()
    await vi.waitFor(() => expect(installAttempts(browser)).toBe(2))
    const later = controller.forceUpdate()
    failFirst(new Error('superseded failure'))

    // The earlier attempt failed, but the rule the later one installed is
    // what is in place now.
    await expect(earlier).resolves.toBeUndefined()
    await expect(later).resolves.toBeUndefined()
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed' })
  })

  it('installs the rule again on a forced list update from a wallet page', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.state.dynamicRules = []

    await expect(
      send(browser, { type: PhishingMessageType.FORCE_UPDATE_PHISHING_LIST }, warningPage)
    ).resolves.toEqual({ success: true })
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])

    browser.state.dynamicRules = []
    browser.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(new Error('quota'))
    await expect(
      send(browser, { type: PhishingMessageType.FORCE_UPDATE_PHISHING_LIST }, warningPage)
    ).resolves.toEqual({ error: 'Error: Phishing block rule not installed: quota' })
  })

  it('rejects a forced update whose rule is not installed and keeps retrying', async () => {
    const browser = createBrowser()
    const controller = await startController(browser)
    browser.state.dynamicRules = []
    browser.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(new Error('quota'))

    await expect(controller.forceUpdate()).rejects.toThrow('Phishing block rule not installed: quota')
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'retrying', attempts: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(networkRules(browser)).resolves.toMatchObject({ status: 'installed', attempts: 2 })
  })
})

describe('PhishingController warning redirect', () => {
  let logError: ReturnType<typeof vi.spyOn>

  /** The session rule that sends top-level pages on the denylist to the warning page. */
  function warningRedirectRule(domains: readonly string[] = BUNDLED_PHISHING_DENYLIST): Rule {
    return {
      id: 1_000_000,
      priority: 2,
      action: {
        type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
        redirect: { regexSubstitution: `${EXTENSION_ORIGIN}/phishing-warning.html#\\0` },
      },
      condition: {
        regexFilter: '^https?://.*',
        requestDomains: [...domains],
        resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[],
      },
    }
  }

  function redirectRules(browser: Browser): Rule[] {
    return browser.state.sessionRules.filter(rule => rule.action.type === 'redirect')
  }

  /** Starts the controller and waits until the startup sync has read the session rules. */
  async function startWithRedirect(browser: Browser) {
    const controller = await startController(browser)
    await vi.waitFor(() =>
      expect(browser.declarativeNetRequest.getSessionRules).toHaveBeenCalledTimes(2)
    )
    await vi.advanceTimersByTimeAsync(0)
    return controller
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    logError = vi.spyOn(log, 'error').mockImplementation(() => undefined)
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('redirects top-level pages on the denylist to the warning page while it has host access', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)

    expect(browser.permissions.contains).toHaveBeenCalledWith({
      origins: BUNDLED_PHISHING_DENYLIST.map(domain => `*://*.${domain}/*`),
    })
    expect(browser.state.sessionRules).toEqual([warningRedirectRule()])
    // The block rule stays, for frames and as the fallback for top-level pages.
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])

    // The redirect carries the whole blocked URL in the fragment.
    const [rule] = browser.state.sessionRules
    const blocked = `https://${BLOCKED_HOST}/claim?ref=1`
    const target = blocked.replace(
      new RegExp(rule!.condition.regexFilter!),
      // DNR's `\0` is the whole match, which is `$&` to String.replace.
      rule!.action.redirect!.regexSubstitution!.replace('\\0', () => '$&')
    )
    expect(target).toBe(`${EXTENSION_ORIGIN}/phishing-warning.html#${blocked}`)
  })

  it('ranks the redirect above the block rule and below Proceed, without taking its ids', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)

    await expect(proceed(browser, BLOCKED_HOST)).resolves.toEqual({ success: true })
    await expect(proceed(browser, OTHER_BLOCKED_HOST)).resolves.toEqual({ success: true })

    const [redirect, ...allowed] = browser.state.sessionRules
    expect(redirect).toEqual(warningRedirectRule())
    expect(allowed).toEqual([
      proceedRule(1_000_001, BLOCKED_HOST),
      proceedRule(1_000_002, OTHER_BLOCKED_HOST),
    ])
    expect(redirect!.priority).toBeGreaterThan(browser.state.dynamicRules[0]!.priority!)
    expect(allowed[0]!.priority).toBeGreaterThan(redirect!.priority!)
  })

  it('restores only Proceed bypasses from the session rules after a restart', async () => {
    const browser = createBrowser({
      hostAccess: true,
      sessionRules: [warningRedirectRule(), proceedRule(1_000_001, BLOCKED_HOST)],
    })
    await startWithRedirect(browser)

    // The rule already in place is left as it is.
    expect(browser.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled()
    await expect(checkHost(browser, BLOCKED_HOST)).resolves.toMatchObject({ isPhishing: false })
    await expect(checkHost(browser, OTHER_BLOCKED_HOST)).resolves.toMatchObject({
      isPhishing: true,
    })
  })

  it('leaves the block rule alone to decide while host access is withheld', async () => {
    const browser = createBrowser({ hostAccess: false })
    await startWithRedirect(browser)

    expect(browser.state.sessionRules).toEqual([])
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])
  })

  it('removes the redirect when host access is withheld and adds it back when it is granted', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)
    await proceed(browser, BLOCKED_HOST)

    setHostAccess(browser, false)
    await vi.waitFor(() => expect(redirectRules(browser)).toEqual([]))
    // Proceed and the block rule are untouched.
    expect(browser.state.sessionRules).toEqual([proceedRule(1_000_001, BLOCKED_HOST)])
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])

    setHostAccess(browser, true)
    await vi.waitFor(() => expect(redirectRules(browser)).toEqual([warningRedirectRule()]))
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])
  })

  it('ends without the redirect when access is withheld while it is being added', async () => {
    const browser = createBrowser({ hostAccess: true })
    let finishAdd!: () => void
    browser.declarativeNetRequest.updateSessionRules.mockImplementationOnce(
      options =>
        new Promise<void>(resolve => {
          finishAdd = () => {
            browser.state.sessionRules = applyRuleUpdate(browser.state.sessionRules, options)
            resolve()
          }
        })
    )
    await startController(browser)
    await vi.waitFor(() => expect(finishAdd).toBeDefined())

    setHostAccess(browser, false)
    finishAdd()

    await vi.waitFor(() =>
      expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenLastCalledWith({
        removeRuleIds: [1_000_000],
        addRules: [],
      })
    )
    expect(browser.state.sessionRules).toEqual([])
  })

  it('treats a failed access check as no access, and checks again', async () => {
    const browser = createBrowser({ hostAccess: true, sessionRules: [warningRedirectRule()] })
    browser.permissions.contains.mockRejectedValueOnce(new Error('permissions unavailable'))
    await startWithRedirect(browser)

    expect(browser.state.sessionRules).toEqual([])
    expect(logError).toHaveBeenCalledWith(
      '[Phishing] Failed to check host access to the denylist:',
      expect.objectContaining({ message: 'permissions unavailable' })
    )
    // The next check answers, and the redirect comes back.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(browser.state.sessionRules).toEqual([warningRedirectRule()])
  })

  it('keeps retrying a removal whose rules cannot be read', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)
    const getSessionRules = browser.declarativeNetRequest.getSessionRules
    getSessionRules.mockRejectedValue(new Error('rules unavailable'))

    setHostAccess(browser, false)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(getSessionRules.mock.calls.length).toBeGreaterThan(2 + 50)
    expect(redirectRules(browser)).toEqual([warningRedirectRule()])

    getSessionRules.mockImplementation(async () => structuredClone(browser.state.sessionRules))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(browser.state.sessionRules).toEqual([])
  })

  it('retries a removal that fails, so that the redirect cannot outlast host access', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)
    browser.declarativeNetRequest.updateSessionRules.mockRejectedValueOnce(new Error('quota'))

    setHostAccess(browser, false)
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        '[Phishing] Failed to update the warning redirect rule (attempt 1):',
        expect.objectContaining({ message: 'quota' })
      )
    )
    expect(redirectRules(browser)).toEqual([warningRedirectRule()])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(browser.state.sessionRules).toEqual([])
  })

  it('retries a failing update with a backoff, up to ten attempts, keeping the block rule', async () => {
    const browser = createBrowser({ hostAccess: true })
    const updates = browser.declarativeNetRequest.updateSessionRules
    let failedAt = 0
    updates.mockImplementation(async () => {
      failedAt = Date.now()
      throw new Error('quota')
    })
    await startWithRedirect(browser)

    for (const [attempts, delay] of [
      [1, 1_000],
      [2, 4_000],
      [3, 15_000],
      [4, 60_000],
    ] as const) {
      expect(updates).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(failedAt + delay - 1 - Date.now())
      expect(updates).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
    }
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(updates).toHaveBeenCalledTimes(10)
    expect(logError).toHaveBeenLastCalledWith(
      '[Phishing] Failed to update the warning redirect rule (attempt 10):',
      expect.objectContaining({ message: 'quota' })
    )
    expect(browser.state.sessionRules).toEqual([])
    expect(browser.state.dynamicRules).toEqual([blockRule(BUNDLED_PHISHING_DENYLIST)])
  })

  it('keeps retrying a failing removal, so that the redirect cannot outlast host access', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)
    const updates = browser.declarativeNetRequest.updateSessionRules
    updates.mockRejectedValue(new Error('quota'))

    setHostAccess(browser, false)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    // Far past the ten attempts an add gets, and still trying every minute.
    expect(updates.mock.calls.length).toBeGreaterThan(1 + 50)
    expect(redirectRules(browser)).toEqual([warningRedirectRule()])

    updates.mockImplementation(async options => {
      browser.state.sessionRules = applyRuleUpdate(browser.state.sessionRules, options)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(browser.state.sessionRules).toEqual([])
  })

  it('gives a later trigger its own attempts after earlier ones gave up', async () => {
    const browser = createBrowser({ hostAccess: true })
    const updates = browser.declarativeNetRequest.updateSessionRules
    updates.mockRejectedValue(new Error('quota'))
    const controller = await startWithRedirect(browser)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(updates).toHaveBeenCalledTimes(10)

    // A forced list update tries again, and retries its own failure.
    void controller.forceUpdate().catch(() => undefined)
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(11))
    updates.mockImplementation(async options => {
      browser.state.sessionRules = applyRuleUpdate(browser.state.sessionRules, options)
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(browser.state.sessionRules).toEqual([warningRedirectRule()])
  })

  it('follows the permissions once, however often the rules are set up', async () => {
    const browser = createBrowser({ hostAccess: true })
    const controller = await startWithRedirect(browser)

    controller.setupDeclarativeRules()
    expect(browser.state.permissionListeners.added).toHaveLength(1)
    expect(browser.state.permissionListeners.removed).toHaveLength(1)
    expect(browser.state.startupListeners).toHaveLength(1)
  })

  it('installs the redirect again when the browser starts', async () => {
    const browser = createBrowser({ hostAccess: true })
    await startWithRedirect(browser)
    // Session rules end with the browser session.
    browser.state.sessionRules = []

    for (const listener of browser.state.startupListeners) listener()
    await vi.waitFor(() => expect(browser.state.sessionRules).toEqual([warningRedirectRule()]))
  })

  it.each([
    ['other domains', { ...warningRedirectRule(['example.com']) }],
    [
      'a narrowing condition',
      (() => {
        const rule = warningRedirectRule()
        rule.condition.initiatorDomains = ['example.com']
        return rule
      })(),
    ],
    [
      'another target',
      (() => {
        const rule = warningRedirectRule()
        rule.action.redirect = { regexSubstitution: 'https://example.com/#\\0' }
        return rule
      })(),
    ],
  ])('replaces a redirect rule with %s', async (_label, stale) => {
    const browser = createBrowser({ hostAccess: true, sessionRules: [stale] })
    await startWithRedirect(browser)

    expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [1_000_000],
      addRules: [warningRedirectRule()],
    })
    expect(browser.state.sessionRules).toEqual([warningRedirectRule()])
  })

  it('checks host access again on a forced list update', async () => {
    const browser = createBrowser({ hostAccess: true })
    const controller = await startWithRedirect(browser)
    // As if the permission event was missed while the worker was stopped.
    browser.state.hostAccess = false

    await controller.forceUpdate()
    expect(browser.state.sessionRules).toEqual([])
  })
})
