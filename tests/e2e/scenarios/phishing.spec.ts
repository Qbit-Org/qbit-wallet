import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { test as base, expect, type Page } from '@playwright/test'

import { BUNDLED_PHISHING_DENYLIST } from '../../../packages/phishing-detect/src/static-policy'
import { PHISHING_PAGE_PROBE } from '../../../packages/wallet-shared/src/types/phishing-message'
import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'

// Two bundled denylist entries. The browser resolves them, and their
// subdomains, to the loopback fixture server, so no request can reach the
// real hosts.
const [BLOCKED_HOST, OTHER_BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as [string, string]
const BLOCKED_URL = `http://${BLOCKED_HOST}/claim?ref=e2e`
// A link wrapper on another site, such as a search result or mail link
// redirector, that the browser also resolves to the fixture server.
const WRAPPER_HOST = 'links.wrapper-e2e.test'

interface RecordedRequest {
  host: string
  path: string
}

/** Serves a clear start page and a stand-in phishing page, recording every request. */
class PhishingFixtureServer {
  readonly requests: RecordedRequest[] = []
  private server: Server | undefined
  private portValue: number | undefined

  get port(): number {
    if (this.portValue === undefined) throw new Error('phishing fixture server has not started')
    return this.portValue
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  requestsTo(host: string): RecordedRequest[] {
    return this.requests.filter(request => request.host === host || request.host.endsWith(`.${host}`))
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const host = (request.headers.host ?? '').replace(/:\d+$/, '')
      const path = request.url ?? '/'
      this.requests.push({ host, path })

      // Redirectors, on this site and on the wrapper's: a 302 to `?to=`.
      const redirectTo = /^\/(?:out|wrap)\?/.test(path)
        ? new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('to')
        : null
      if (redirectTo) {
        response.writeHead(302, { location: redirectTo, 'cache-control': 'no-store' })
        response.end()
        return
      }

      const body =
        path === '/start'
          ? [
              `<a id="blocked-link" href="${BLOCKED_URL}">Claim</a>`,
              `<a id="redirect-link" href="/out?to=${encodeURIComponent(BLOCKED_URL)}">Claim via this site</a>`,
              `<a id="wrapped-link" href="http://${WRAPPER_HOST}/wrap?to=${encodeURIComponent(BLOCKED_URL)}">Claim via a link wrapper</a>`,
            ].join('')
          : `<h1>phishing fixture</h1><script>fetch('/beacon?stage=inline')</script>`
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.portValue = (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
}

// These scenarios need no regtest node, so they use their own fixtures rather
// than the shared ones, which start regtest for every test.
const test = base.extend<{ fixtureServer: PhishingFixtureServer; extension: ExtensionSession }>({
  fixtureServer: async ({}, use) => {
    const server = new PhishingFixtureServer()
    await server.start()
    try {
      await use(server)
    } finally {
      await server.close()
    }
  },
  extension: async ({ fixtureServer }, use, testInfo) => {
    assertRepositoryRoot()
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const target = `127.0.0.1:${fixtureServer.port}`
    const rules = [BLOCKED_HOST, OTHER_BLOCKED_HOST, WRAPPER_HOST].flatMap(host => [
      `MAP ${host} ${target}`,
      `MAP *.${host} ${target}`,
    ])
    const extension = new ExtensionSession(userDataDir, undefined, {
      // Without a proxy, the resolver rules decide where every request goes.
      browserArgs: ['--no-proxy-server', `--host-resolver-rules=${rules.join(', ')}`],
    })
    await extension.start()
    // Shows which branch the background took when a scenario fails.
    let failed = true
    try {
      // The background installs its phishing rules asynchronously at startup:
      // the block rule, and the redirect to the warning page above it.
      const worker = await extension.serviceWorker()
      await expect
        .poll(() =>
          worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)
        )
        .toBeGreaterThan(0)
      await expect.poll(() => hasWarningRedirect(extension)).toBe(true)
      await use(extension)
      failed = testInfo.status !== testInfo.expectedStatus
    } finally {
      try {
        if (failed) await extension.attachServiceWorkerLog(testInfo)
      } finally {
        await extension.close()
      }
    }
  },
})

function warningPagePattern(extensionId: string): RegExp {
  return new RegExp(`^chrome-extension://${extensionId}/index\\.html#/phishing\\?`)
}

/** Whether the background's session rule that redirects to the warning page is in place. */
async function hasWarningRedirect(extension: ExtensionSession): Promise<boolean> {
  const worker = await extension.serviceWorker()
  return worker.evaluate(async () =>
    (await chrome.declarativeNetRequest.getSessionRules()).some(
      rule => rule.action.type === 'redirect'
    )
  )
}

/**
 * Sets the wallet's site access as a user does in the browser's extension
 * settings: `ON_CLICK` withholds its host access, `ON_ALL_SITES` grants it.
 */
async function setSiteAccess(extension: ExtensionSession, hostAccess: 'ON_CLICK' | 'ON_ALL_SITES') {
  const settings = await extension.context.newPage()
  try {
    await settings.goto('chrome://extensions')
    await settings.evaluate(
      ({ extensionId, hostAccess }) =>
        (
          chrome as unknown as {
            developerPrivate: {
              updateExtensionConfiguration(update: {
                extensionId: string
                hostAccess: string
              }): Promise<void>
            }
          }
        ).developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess }),
      { extensionId: extension.extensionId, hostAccess }
    )
  } finally {
    await settings.close()
  }
}

/** Follows a navigation that the browser may replace with the warning page before it settles. */
async function navigate(page: Page, url: string): Promise<Error | null> {
  return page.goto(url).then(
    () => null,
    (error: Error) => error
  )
}

function warningParams(page: Page): URLSearchParams {
  const hash = new URL(page.url()).hash
  return new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
}

/**
 * Sends the background's probe to the page's top frame, which only a page the
 * content script runs on answers. The wallet opens a tab of its own at
 * install, so the page is brought to the front to find its tab.
 */
async function answersProbe(extension: ExtensionSession, page: Page): Promise<boolean> {
  await page.bringToFront()
  const worker = await extension.serviceWorker()
  return worker.evaluate(async type => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    try {
      const response = await chrome.tabs.sendMessage(tab!.id!, { type }, { frameId: 0 })
      return response?.present === true
    } catch {
      return false
    }
  }, PHISHING_PAGE_PROBE)
}

/** The paths requested from the first denylisted host, other than the favicon. */
function pagePaths(server: PhishingFixtureServer): string[] {
  return server
    .requestsTo(BLOCKED_HOST)
    .map(request => request.path)
    .filter(path => path !== '/favicon.ico')
}

/** Asks the background for its phishing stats from one of the wallet's pages. */
async function phishingStats(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ networkRules?: { status?: string; blockedDomains?: number | null; error?: string } }>(
        resolve => chrome.runtime.sendMessage({ type: 'GET_PHISHING_STATS' }, resolve)
      )
  )
}

async function waitForProvider(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as Window & { qbit?: unknown }).qbit))
}

test.describe('MV3 phishing protection', () => {
  test('shows the warning for a direct navigation to a denylisted host before it reaches the network', async ({
    extension,
    fixtureServer,
  }) => {
    const page = await extension.context.newPage()
    await navigate(page, `http://${BLOCKED_HOST}/landing`)

    await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
    expect(warningParams(page).get('hostname')).toBe(BLOCKED_HOST)
    expect(warningParams(page).get('href')).toBe(`http://${BLOCKED_HOST}/landing`)
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])
  })

  for (const { kind, link } of [
    { kind: 'a redirect on the same site', link: '#redirect-link' },
    { kind: 'a link wrapper on another site', link: '#wrapped-link' },
  ]) {
    test(`shows the warning for ${kind} to a denylisted host, and Proceed loads the site`, async ({
      extension,
      fixtureServer,
    }) => {
      const page = await extension.context.newPage()
      await page.goto(`${fixtureServer.origin}/start`)
      await waitForProvider(page)

      // The link itself is not denylisted, so the content script lets it go;
      // the redirect it answers with is what the network layer stops.
      await page.click(link)
      await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
      const params = warningParams(page)
      expect(params.get('hostname')).toBe(BLOCKED_HOST)
      expect(params.get('href')).toBe(BLOCKED_URL)
      expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])

      await page
        .getByRole('button', { name: new RegExp(BLOCKED_HOST.replace(/\./g, '\\.')) })
        .click()

      await expect(page).toHaveURL(BLOCKED_URL)
      await expect(page.locator('h1')).toHaveText('phishing fixture')
      await page.waitForTimeout(2_000)
      await expect(page).toHaveURL(BLOCKED_URL)
      expect(await page.evaluate(() => 'qbit' in window)).toBe(false)

      // The history holds the warning once: the page the redirect opened
      // replaced itself with it.
      await page.goBack()
      await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
      await page.goBack()
      await expect(page).toHaveURL(`${fixtureServer.origin}/start`)
    })
  }

  test('falls back to the block rule while the user withholds site access, and warns again once it is granted', async ({
    extension,
    fixtureServer,
  }) => {
    // Without host access a redirect rule does not fire, and it would still
    // outrank the block rule, so the background removes it.
    await setSiteAccess(extension, 'ON_CLICK')
    await expect.poll(() => hasWarningRedirect(extension)).toBe(false)

    const page = await extension.context.newPage()
    const navigationError = await navigate(page, `http://${BLOCKED_HOST}/landing`)
    expect(navigationError?.message).toContain('net::ERR_BLOCKED_BY_CLIENT')
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])
    // The blocked page runs no content script, which the background's
    // follow-up relies on to tell it from a page the user went to.
    expect(await answersProbe(extension, page)).toBe(false)

    await setSiteAccess(extension, 'ON_ALL_SITES')
    await expect.poll(() => hasWarningRedirect(extension)).toBe(true)
    const again = await extension.context.newPage()
    await navigate(again, `http://${BLOCKED_HOST}/landing`)
    await expect(again).toHaveURL(warningPagePattern(extension.extensionId))
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])
  })

  test('warns on a link to a denylisted host and lets the user proceed once', async ({
    extension,
    fixtureServer,
  }) => {
    const page = await extension.context.newPage()
    await page.goto(`${fixtureServer.origin}/start`)
    // The provider is injected only after a clear verdict, by when the
    // content script is fully set up.
    await waitForProvider(page)

    await page.click('#blocked-link')
    await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
    const params = warningParams(page)
    expect(params.get('hostname')).toBe(BLOCKED_HOST)
    expect(params.get('href')).toBe(BLOCKED_URL)
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])

    await page.getByRole('button', { name: new RegExp(BLOCKED_HOST.replace(/\./g, '\\.')) }).click()

    await expect(page).toHaveURL(BLOCKED_URL)
    await expect(page.locator('h1')).toHaveText('phishing fixture')
    // The content script's check finishes within milliseconds of the page
    // starting; give it ample time, then confirm the tab was not sent back to
    // the warning page and the denylisted page got no wallet provider.
    await page.waitForTimeout(2_000)
    await expect(page).toHaveURL(BLOCKED_URL)
    expect(await page.evaluate(() => 'qbit' in window)).toBe(false)
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toContainEqual({
      host: BLOCKED_HOST,
      path: '/claim?ref=e2e',
    })

    // Proceeding lifts only this host for this browser session; other
    // denylisted hosts still get the warning.
    const other = await extension.context.newPage()
    await navigate(other, `http://${OTHER_BLOCKED_HOST}/`)
    await expect(other).toHaveURL(warningPagePattern(extension.extensionId))
    expect(warningParams(other).get('hostname')).toBe(OTHER_BLOCKED_HOST)
    expect(fixtureServer.requestsTo(OTHER_BLOCKED_HOST)).toEqual([])

    // The content script still cancels a later click on the link, then
    // follows it once the background reports the host as proceeded.
    const again = await extension.context.newPage()
    await again.goto(`${fixtureServer.origin}/start`)
    await waitForProvider(again)
    const earlierRequests = fixtureServer.requestsTo(BLOCKED_HOST).length
    await again.click('#blocked-link')
    await expect(again).toHaveURL(BLOCKED_URL)
    await expect(again.locator('h1')).toHaveText('phishing fixture')
    expect(fixtureServer.requestsTo(BLOCKED_HOST).length).toBeGreaterThan(earlierRequests)
  })

  test('warns on a link clicked while the service worker is already running', async ({
    extension,
    fixtureServer,
  }) => {
    const page = await extension.context.newPage()
    await page.goto(`${fixtureServer.origin}/start`)
    await waitForProvider(page)

    // A running worker redirects at once. That is when the link's own,
    // blocked navigation could start after the redirect and replace it (#320).
    const worker = await extension.serviceWorker()
    await worker.evaluate(() => chrome.runtime.getPlatformInfo())
    await page.click('#blocked-link')

    await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
    expect(warningParams(page).get('href')).toBe(BLOCKED_URL)
    // Nothing replaces the warning page afterwards.
    await page.waitForTimeout(1_000)
    await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])

    // Back returns to the page with the link, which stays put and answers
    // the background's probe.
    await page.goBack()
    await expect(page).toHaveURL(`${fixtureServer.origin}/start`)
    await page.waitForTimeout(1_000)
    await expect(page).toHaveURL(`${fixtureServer.origin}/start`)
    expect(fixtureServer.requestsTo(BLOCKED_HOST)).toEqual([])
    await expect.poll(() => answersProbe(extension, page)).toBe(true)
  })

  test('reports the installed block rule to the wallet pages', async ({ extension }) => {
    const page = await extension.context.newPage()
    await page.goto(`chrome-extension://${extension.extensionId}/index.html`)

    const { networkRules } = await phishingStats(page)
    expect(networkRules).toMatchObject({
      status: 'installed',
      blockedDomains: BUNDLED_PHISHING_DENYLIST.length,
    })
  })

  test('shows the warning before a denylisted page runs script while the block rule is missing', async ({
    extension,
    fixtureServer,
  }) => {
    // As after a failed install, while the warning redirect is also missing:
    // nothing stops the navigation in the network.
    const worker = await extension.serviceWorker()
    await worker.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules()
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(rule => rule.id) })
      const sessionRules = await chrome.declarativeNetRequest.getSessionRules()
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: sessionRules.map(rule => rule.id),
      })
    })

    const page = await extension.context.newPage()
    // The warning page can replace the page before its load event.
    await page.goto(BLOCKED_URL).catch(() => undefined)
    await expect(page).toHaveURL(warningPagePattern(extension.extensionId))
    expect(warningParams(page).get('href')).toBe(BLOCKED_URL)
    // The page was fetched, but the content script stopped it before its
    // inline script could send the beacon.
    await page.waitForTimeout(1_000)
    expect(pagePaths(fixtureServer)).toEqual(['/claim?ref=e2e'])

    // The health does not keep reporting the rule it installed at startup,
    // and the background installs it again once it finds it missing.
    const { networkRules } = await phishingStats(page)
    expect(networkRules).toMatchObject({ status: 'retrying', blockedDomains: 0 })
    await expect
      .poll(async () => (await phishingStats(page)).networkRules?.status)
      .toBe('installed')

    // Proceed releases the page in this tab: it reloads once and runs.
    await page.getByRole('button', { name: new RegExp(BLOCKED_HOST.replace(/\./g, '\\.')) }).click()
    await expect(page).toHaveURL(BLOCKED_URL)
    await expect(page.locator('h1')).toHaveText('phishing fixture')
    await page.waitForTimeout(1_000)
    await expect(page).toHaveURL(BLOCKED_URL)
    // The Proceed navigation, held, then its one reload, which ran the script.
    expect(pagePaths(fixtureServer)).toEqual([
      '/claim?ref=e2e',
      '/claim?ref=e2e',
      '/claim?ref=e2e',
      '/beacon?stage=inline',
    ])
    expect(await page.evaluate(() => 'qbit' in window)).toBe(false)
  })
})
