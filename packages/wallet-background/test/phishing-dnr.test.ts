import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUNDLED_PHISHING_DENYLIST, PhishingService } from '@qbit/phishing-detect'
import { PhishingMessageType } from '@qbit/wallet-shared'

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
    // Chrome rejects the whole update when a rule id is already in use.
    if (next.some(existing => existing.id === rule.id)) {
      throw new Error(`Rule with id ${rule.id} already exists`)
    }
    next.push(structuredClone(rule))
  }
  return next
}

/** A stand-in for the parts of the extension API the controller uses. */
function createBrowser(initial: { dynamicRules?: Rule[]; sessionRules?: Rule[] } = {}) {
  const state = {
    dynamicRules: [...(initial.dynamicRules ?? [])],
    sessionRules: [...(initial.sessionRules ?? [])],
    listener: undefined as MessageListener | undefined,
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
  const chromeStub = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
      onMessage: {
        addListener: (listener: MessageListener) => {
          state.listener = listener
        },
      },
    },
    declarativeNetRequest,
    tabs,
  }
  return { state, chrome: chromeStub, declarativeNetRequest, tabs }
}

type Browser = ReturnType<typeof createBrowser>

/** Starts a fresh controller, as a service worker start would. */
async function startController(browser: Browser) {
  vi.stubGlobal('chrome', browser.chrome)
  vi.resetModules()
  // The controller imports its services by the baseUrl path. A real detector
  // checks Proceed against the bundled denylist, and each start gets a fresh
  // one, as a restarted service worker would.
  vi.doMock('src/services', () => ({ phishingDetectService: new PhishingService() }))
  const { default: controller } = await import('../src/controllers/phishing')
  controller.init()
  // Let the startup rule installation settle.
  await vi.waitFor(() => expect(browser.declarativeNetRequest.updateDynamicRules).toHaveBeenCalled())
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
    priority: 2,
    action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      requestDomains: [hostname],
      resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[],
    },
  }
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
    const earlierRules = BUNDLED_PHISHING_DENYLIST.map((domain, index) => ({
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
    const browser = createBrowser({ dynamicRules: earlierRules })
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
