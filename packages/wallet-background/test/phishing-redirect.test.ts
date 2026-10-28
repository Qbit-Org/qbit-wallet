import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUNDLED_PHISHING_DENYLIST, PhishingService } from '@qbit/phishing-detect'
import { PHISHING_PAGE_PROBE, PhishingMessageType } from '@qbit/wallet-shared'

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean
type UpdatedListener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void
type RemovedListener = (tabId: number) => void
type TabStatus = 'loading' | 'complete'

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`
const WARNING_PAGE = `${EXTENSION_ORIGIN}/index.html#/phishing`
const TAB_ID = 7
const [BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as [string]
const BLOCKED_URL = `http://${BLOCKED_HOST}/claim?ref=1`

/** The clear page whose link to a denylisted host the user clicked. */
const startPage: chrome.runtime.MessageSender = {
  frameId: 0,
  id: EXTENSION_ID,
  origin: 'https://example.com',
  tab: { id: TAB_ID } as chrome.tabs.Tab,
  url: 'https://example.com/start',
}

/** A stand-in for the parts of the extension API the controller uses. */
function createBrowser() {
  const state = {
    listener: undefined as MessageListener | undefined,
    onUpdated: new Set<UpdatedListener>(),
    onRemoved: new Set<RemovedListener>(),
    status: 'complete' as TabStatus,
    closed: false,
    // The extension's own pages loaded in the tab.
    contexts: [] as { frameId: number; documentUrl: string }[],
    // Whether the tab's top frame shows a page the content script runs on.
    contentScriptPage: false,
  }
  const declarativeNetRequest = {
    RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow' },
    ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame' },
    getDynamicRules: vi.fn(async () => []),
    updateDynamicRules: vi.fn(async () => undefined),
    getSessionRules: vi.fn(async () => []),
    updateSessionRules: vi.fn(async () => undefined),
  }
  const tabs = {
    get: vi.fn(async (tabId: number) => {
      if (state.closed) throw new Error(`No tab with id: ${tabId}`)
      return { id: tabId, status: state.status }
    }),
    // Starting a navigation leaves the tab loading, and the previous page no
    // longer counts as loaded in it.
    update: vi.fn(async (tabId: number, _props: chrome.tabs.UpdateProperties) => {
      state.status = 'loading'
      state.contexts = []
      state.contentScriptPage = false
      return { id: tabId }
    }),
    // Only a content script in the top frame answers the probe.
    sendMessage: vi.fn(
      async (
        tabId: number,
        message: { type?: string },
        options?: chrome.tabs.MessageSendOptions
      ) => {
        if (
          state.contentScriptPage &&
          tabId === TAB_ID &&
          options?.frameId === 0 &&
          message.type === PHISHING_PAGE_PROBE
        ) {
          return { present: true }
        }
        throw new Error('Could not establish connection. Receiving end does not exist.')
      }
    ),
    onUpdated: {
      addListener: (listener: UpdatedListener) => state.onUpdated.add(listener),
      removeListener: (listener: UpdatedListener) => state.onUpdated.delete(listener),
    },
    onRemoved: {
      addListener: (listener: RemovedListener) => state.onRemoved.add(listener),
      removeListener: (listener: RemovedListener) => state.onRemoved.delete(listener),
    },
  }
  const runtime = {
    id: EXTENSION_ID,
    getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
    getContexts: vi.fn(async (filter: { contextTypes: string[]; tabIds: number[] }) =>
      filter.contextTypes.includes('TAB') && filter.tabIds.includes(TAB_ID)
        ? structuredClone(state.contexts)
        : []
    ),
    onMessage: {
      addListener: (listener: MessageListener) => {
        state.listener = listener
      },
    },
  }
  return { state, chrome: { runtime, declarativeNetRequest, tabs }, runtime, tabs }
}

type Browser = ReturnType<typeof createBrowser>

/** Starts a fresh controller, as a service worker start would. */
async function startController(browser: Browser) {
  vi.stubGlobal('chrome', browser.chrome)
  vi.resetModules()
  // The controller imports its services by the baseUrl path.
  vi.doMock('src/services', () => ({ phishingDetectService: new PhishingService() }))
  const { default: controller } = await import('../src/controllers/phishing')
  controller.init()
  return controller
}

function send(browser: Browser, message: unknown, sender: chrome.runtime.MessageSender) {
  return new Promise(resolve => {
    browser.state.listener!(message, sender, resolve)
  })
}

function clickBlockedLink(browser: Browser, sender = startPage) {
  return send(browser, { type: PhishingMessageType.CHECK_NAVIGATION, url: BLOCKED_URL }, sender)
}

function warningUrls(browser: Browser): string[] {
  return browser.tabs.update.mock.calls.map(([, props]) => props.url!)
}

/**
 * Finishes loading the tab: on the warning page, on Chrome's blocked page, or
 * on a web page the content script runs on.
 */
function finishLoading(browser: Browser, page: 'warning' | 'blocked' | 'web page') {
  const { state } = browser
  state.status = 'complete'
  state.contexts =
    page === 'warning' ? [{ frameId: 0, documentUrl: warningUrls(browser).at(-1)! }] : []
  state.contentScriptPage = page === 'web page'
  for (const listener of [...state.onUpdated]) listener(TAB_ID, { status: 'complete' })
}

/** Lets the worker finish what the last event started. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

function isWatching(browser: Browser) {
  return browser.state.onUpdated.size > 0 || browser.state.onRemoved.size > 0
}

describe('PhishingController warning page follow-up', () => {
  let logError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // loglevel binds the console once, so watch it rather than the console.
    logError = vi.spyOn(log, 'error').mockImplementation(() => undefined)
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends the tab to the warning page again when the blocked link navigation wins', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(clickBlockedLink(browser)).resolves.toEqual({ isPhishing: true, redirected: true })
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(true)

    finishLoading(browser, 'blocked')
    await vi.waitFor(() => expect(warningUrls(browser)).toHaveLength(2))

    // The same warning, with the blocked URL for Proceed, and only once more.
    const [first, second] = warningUrls(browser)
    expect(second).toBe(first)
    expect(new URLSearchParams(new URL(second!).hash.split('?')[1]).get('href')).toBe(BLOCKED_URL)
    // Without bringing the tab to the front again.
    expect(browser.tabs.update).toHaveBeenLastCalledWith(TAB_ID, { url: second })
    expect(logError).toHaveBeenCalledWith(
      '[Phishing] The warning page did not load; redirecting the tab again'
    )

    finishLoading(browser, 'blocked')
    await settle()
    expect(warningUrls(browser)).toHaveLength(2)
    expect(isWatching(browser)).toBe(false)
  })

  it('does the same for a warning the content script asked for on a phishing page', async () => {
    const browser = createBrowser()
    await startController(browser)

    await expect(
      send(
        browser,
        {
          type: PhishingMessageType.REDIRECT_TO_PHISHING_PAGE,
          hostname: BLOCKED_HOST,
          url: BLOCKED_URL,
        },
        { ...startPage, origin: `http://${BLOCKED_HOST}`, url: BLOCKED_URL }
      )
    ).resolves.toEqual({ success: true })

    finishLoading(browser, 'blocked')
    await vi.waitFor(() => expect(warningUrls(browser)).toHaveLength(2))
  })

  it('leaves the tab alone once the warning page has loaded', async () => {
    const browser = createBrowser()
    await startController(browser)
    await clickBlockedLink(browser)

    finishLoading(browser, 'warning')
    await settle()

    expect(browser.runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ['TAB'],
      tabIds: [TAB_ID],
    })
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)
  })

  it('does not send a tab that has moved on to another page back to the warning', async () => {
    const browser = createBrowser()
    await startController(browser)
    await clickBlockedLink(browser)

    // The user navigated elsewhere before the warning page loaded.
    finishLoading(browser, 'web page')
    await settle()

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      TAB_ID,
      { type: PHISHING_PAGE_PROBE },
      { frameId: 0 }
    )
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)
  })

  it('does not undo Back to the page with the link before the warning page loaded', async () => {
    const browser = createBrowser()
    await startController(browser)
    await clickBlockedLink(browser)

    // The warning page commits; before it finishes loading, Back restores
    // the start page from the back/forward cache, and that load completes.
    browser.state.contexts = [{ frameId: 0, documentUrl: warningUrls(browser)[0]! }]
    finishLoading(browser, 'web page')
    await settle()

    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)
  })

  it('does not send the tab back after the user proceeded to the host', async () => {
    const browser = createBrowser()
    await startController(browser)
    await clickBlockedLink(browser)

    // Proceed from a warning page in another tab lifts the host everywhere.
    await expect(
      send(
        browser,
        { type: PhishingMessageType.SKIP_PHISHING_PROTECTION, hostname: BLOCKED_HOST },
        {
          id: EXTENSION_ID,
          origin: EXTENSION_ORIGIN,
          tab: { id: TAB_ID + 1 } as chrome.tabs.Tab,
          url: `${WARNING_PAGE}?hostname=${BLOCKED_HOST}`,
        }
      )
    ).resolves.toEqual({ success: true })
    finishLoading(browser, 'blocked')
    await settle()

    expect(warningUrls(browser)).toHaveLength(1)
  })

  it('retries only the latest redirect of a tab when two finish out of order', async () => {
    const browser = createBrowser()
    await startController(browser)
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    let finishFirstUpdate!: () => void
    browser.tabs.update.mockImplementationOnce(
      (tabId: number) =>
        new Promise(resolve => {
          finishFirstUpdate = () => resolve({ id: tabId })
        })
    )

    // Two clicks: the first redirect is still starting when the second lands.
    const first = clickBlockedLink(browser)
    await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalledOnce())
    await expect(clickBlockedLink(browser)).resolves.toEqual({ isPhishing: true, redirected: true })
    finishFirstUpdate()
    await expect(first).resolves.toEqual({ isPhishing: true, redirected: true })

    const [, latest] = warningUrls(browser)
    finishLoading(browser, 'blocked')
    await settle()

    expect(warningUrls(browser)).toHaveLength(3)
    expect(warningUrls(browser)[2]).toBe(latest)
    expect(isWatching(browser)).toBe(false)
  })

  it('stops watching a tab that closes', async () => {
    const browser = createBrowser()
    await startController(browser)
    await clickBlockedLink(browser)

    browser.state.closed = true
    for (const listener of [...browser.state.onRemoved]) listener(TAB_ID)
    await settle()

    expect(isWatching(browser)).toBe(false)
    expect(browser.runtime.getContexts).not.toHaveBeenCalled()
    expect(warningUrls(browser)).toHaveLength(1)
  })

  it('confirms a complete event against the tab before checking it', async () => {
    const browser = createBrowser()
    await startController(browser)
    await clickBlockedLink(browser)

    // An event from before the redirect started: the tab is still loading.
    for (const listener of [...browser.state.onUpdated]) listener(TAB_ID, { status: 'complete' })
    await settle()
    expect(browser.runtime.getContexts).not.toHaveBeenCalled()
    expect(isWatching(browser)).toBe(true)

    finishLoading(browser, 'warning')
    await settle()
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)
  })

  it('catches a tab that settles before the redirect call returns', async () => {
    const browser = createBrowser()
    await startController(browser)
    // The blocked link navigation wins and its page loads at once.
    browser.tabs.update.mockImplementationOnce(async (tabId: number, props) => {
      browser.state.status = 'loading'
      browser.state.contexts = []
      finishLoading(browser, 'blocked')
      return { id: tabId, url: props.url }
    })

    await clickBlockedLink(browser)

    await vi.waitFor(() => expect(warningUrls(browser)).toHaveLength(2))
  })

  it('ignores a complete event of the previous page that arrives before the redirect starts', async () => {
    const browser = createBrowser()
    await startController(browser)
    // The start page finishes loading as the redirect is requested.
    browser.tabs.update.mockImplementationOnce(async (tabId: number) => {
      for (const listener of [...browser.state.onUpdated]) listener(TAB_ID, { status: 'complete' })
      await settle()
      browser.state.status = 'loading'
      browser.state.contexts = []
      return { id: tabId }
    })

    await clickBlockedLink(browser)
    await settle()

    expect(browser.runtime.getContexts).not.toHaveBeenCalled()
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(true)

    finishLoading(browser, 'warning')
    await settle()
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)
  })

  it('does not take the status read right after the redirect for its outcome', async () => {
    const browser = createBrowser()
    await startController(browser)
    // The read still returns the start page's status.
    browser.tabs.update.mockImplementationOnce(async (tabId: number) => ({ id: tabId }))

    await clickBlockedLink(browser)
    await settle()

    expect(browser.runtime.getContexts).not.toHaveBeenCalled()
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(true)

    finishLoading(browser, 'warning')
    await settle()
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)
  })

  it('gives up on a tab that is still loading when the wait runs out', async () => {
    const browser = createBrowser()
    await startController(browser)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await clickBlockedLink(browser)
    await vi.advanceTimersByTimeAsync(0)
    expect(isWatching(browser)).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(isWatching(browser)).toBe(false)
    expect(browser.runtime.getContexts).not.toHaveBeenCalled()
    expect(warningUrls(browser)).toHaveLength(1)
  })

  it('logs a failed check after the redirect and keeps the next one working', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.runtime.getContexts.mockRejectedValueOnce(new Error('getContexts failed'))

    await expect(clickBlockedLink(browser)).resolves.toEqual({ isPhishing: true, redirected: true })
    finishLoading(browser, 'blocked')
    await settle()

    expect(logError).toHaveBeenCalledWith(
      '[Phishing] Failed to confirm the warning page:',
      expect.objectContaining({ message: 'getContexts failed' })
    )
    expect(warningUrls(browser)).toHaveLength(1)
    expect(isWatching(browser)).toBe(false)

    // A later click is followed up as usual.
    await clickBlockedLink(browser)
    finishLoading(browser, 'blocked')
    await vi.waitFor(() => expect(warningUrls(browser)).toHaveLength(3))
  })

  it('logs a failed second redirect without failing the first', async () => {
    const browser = createBrowser()
    await startController(browser)
    await expect(clickBlockedLink(browser)).resolves.toEqual({ isPhishing: true, redirected: true })
    browser.tabs.update.mockRejectedValueOnce(new Error('No tab with id: 7'))

    finishLoading(browser, 'blocked')
    await settle()

    expect(browser.tabs.update).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledWith(
      '[Phishing] Failed to confirm the warning page:',
      expect.objectContaining({ message: 'No tab with id: 7' })
    )
    expect(isWatching(browser)).toBe(false)
  })

  it('does not follow up a redirect that failed to start', async () => {
    const browser = createBrowser()
    await startController(browser)
    browser.tabs.update.mockRejectedValueOnce(new Error('No tab with id: 7'))

    await expect(clickBlockedLink(browser)).resolves.toEqual({
      isPhishing: true,
      redirected: false,
      error: 'Error: No tab with id: 7',
    })
    expect(isWatching(browser)).toBe(false)
  })

  it('does not watch tabs where it cannot see its own pages', async () => {
    const browser = createBrowser()
    delete (browser.runtime as { getContexts?: unknown }).getContexts
    await startController(browser)

    await expect(clickBlockedLink(browser)).resolves.toEqual({ isPhishing: true, redirected: true })
    expect(isWatching(browser)).toBe(false)
  })
})
