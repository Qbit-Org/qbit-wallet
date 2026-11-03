import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { test as base, expect, type Frame, type Page } from '@playwright/test'

import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'

interface RecordedEvent {
  type: string
  installed: boolean
  sameProvider: boolean | null
  frozen: boolean | null
  info: { uuid: string; name: string; icon: string; rdns: string } | null
}

interface WindowWithEvents extends Window {
  qbit?: unknown
  qbitReadyEvents?: RecordedEvent[]
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Runs before any other script on the page, long before the wallet's checks
// of the page let it install window.qbit.
const RECORDER = `<script>
  window.qbitReadyEvents = []
  for (const type of ['qbit#initialized', 'qbit:announceProvider']) {
    window.addEventListener(type, event => {
      const detail = event.detail
      window.qbitReadyEvents.push({
        type,
        installed: Boolean(window.qbit),
        sameProvider: detail ? detail.provider === window.qbit : null,
        frozen: detail ? Object.isFrozen(detail) && Object.isFrozen(detail.info) : null,
        info: detail ? { ...detail.info, icon: detail.info.icon.slice(0, 22) } : null,
      })
    })
  }
</script>`

/** Serves a page that listens early and, for a frame, the same page on its own. */
class ReadyFixtureServer {
  private server: Server | undefined
  private originValue: string | undefined

  get origin(): string {
    if (!this.originValue) throw new Error('provider-ready fixture server has not started')
    return this.originValue
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      const frame = url.searchParams.get('frame')
      const body =
        url.pathname === '/early'
          ? [
              '<h1>listens early</h1>',
              frame ? `<iframe id="widget" src="${frame}"></iframe>` : '',
              frame
                ? `<iframe id="sandboxed" sandbox="allow-scripts" src="${frame}"></iframe>`
                : '',
            ].join('')
          : url.pathname === '/frame'
            ? '<h1>embedded widget</h1>'
            : null
      if (body === null) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8">${RECORDER}</head><body>${body}</body></html>`
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.originValue = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

// Detection needs no wallet and no regtest node, so these scenarios use their
// own fixtures rather than the shared ones, which start regtest for every test.
const test = base.extend<{
  servers: [ReadyFixtureServer, ReadyFixtureServer]
  extension: ExtensionSession
}>({
  servers: async ({}, use) => {
    const servers: [ReadyFixtureServer, ReadyFixtureServer] = [
      new ReadyFixtureServer(),
      new ReadyFixtureServer(),
    ]
    try {
      await Promise.all(servers.map(server => server.start()))
      await use(servers)
    } finally {
      await Promise.all(servers.map(server => server.close()))
    }
  },
  extension: async ({}, use, testInfo) => {
    assertRepositoryRoot()
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir)
    await extension.start()
    let failed = true
    try {
      // A page gets a provider only once the background can answer its
      // phishing check, which it does after installing its rules.
      const worker = await extension.serviceWorker()
      await expect
        .poll(() =>
          worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)
        )
        .toBeGreaterThan(0)
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

function recordedEvents(target: Page | Frame): Promise<RecordedEvent[]> {
  return target.evaluate(() => (window as WindowWithEvents).qbitReadyEvents ?? [])
}

/** Asks for the announcement as a script that starts listening late does. */
function requestAnnouncement(
  target: Page | Frame
): Promise<{ uuid: string; sameProvider: boolean }[]> {
  return target.evaluate(() => {
    const answers: { uuid: string; sameProvider: boolean }[] = []
    const listener = (event: Event) => {
      const { info, provider } = (
        event as CustomEvent<{ info: { uuid: string }; provider: unknown }>
      ).detail
      answers.push({
        uuid: info.uuid,
        sameProvider: provider === (window as WindowWithEvents).qbit,
      })
    }
    window.addEventListener('qbit:announceProvider', listener)
    window.dispatchEvent(new Event('qbit:requestProvider'))
    window.removeEventListener('qbit:announceProvider', listener)
    return answers
  })
}

async function loadedFrame(page: Page, selector: string): Promise<Frame> {
  await expect(page.frameLocator(selector).locator('h1')).toHaveText('embedded widget')
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame()
  if (!frame) throw new Error(`the ${selector} frame did not load`)
  return frame
}

function expectReadyEvents(events: RecordedEvent[]): string {
  expect(events).toEqual([
    { type: 'qbit#initialized', installed: true, sameProvider: null, frozen: null, info: null },
    {
      type: 'qbit:announceProvider',
      installed: true,
      sameProvider: true,
      frozen: true,
      info: {
        uuid: expect.stringMatching(UUID_V4),
        name: 'Qbit Wallet',
        icon: 'data:image/png;base64,',
        rdns: 'org.qbit.wallet',
      },
    },
  ])
  return events[1]!.info!.uuid
}

test.describe('provider ready event', () => {
  test('a page that listens before the wallet loads hears it is ready, and a late listener can ask', async ({
    extension,
    servers: [site],
  }) => {
    const page = await extension.context.newPage()
    await page.goto(`${site.origin}/early`)

    await expect.poll(() => recordedEvents(page).then(events => events.length)).toBe(2)
    const uuid = expectReadyEvents(await recordedEvents(page))

    expect(await requestAnnouncement(page)).toEqual([{ uuid, sameProvider: true }])
    // Asking again announces again, but qbit#initialized stays a one-off.
    expect(await requestAnnouncement(page)).toEqual([{ uuid, sameProvider: true }])
    expect((await recordedEvents(page)).map(({ type }) => type)).toEqual([
      'qbit#initialized',
      'qbit:announceProvider',
      'qbit:announceProvider',
      'qbit:announceProvider',
    ])
  })

  test('a frame of another origin gets its own event and announcement, and a sandboxed frame gets neither', async ({
    extension,
    servers: [site, widget],
  }) => {
    const page = await extension.context.newPage()
    await page.goto(`${site.origin}/early?frame=${encodeURIComponent(`${widget.origin}/frame`)}`)
    const widgetFrame = await loadedFrame(page, '#widget')
    const sandboxed = await loadedFrame(page, '#sandboxed')

    await expect.poll(() => recordedEvents(page).then(events => events.length)).toBe(2)
    await expect.poll(() => recordedEvents(widgetFrame).then(events => events.length)).toBe(2)
    const pageUuid = expectReadyEvents(await recordedEvents(page))
    const widgetUuid = expectReadyEvents(await recordedEvents(widgetFrame))
    expect(widgetUuid).not.toBe(pageUuid)
    expect(await requestAnnouncement(widgetFrame)).toEqual([
      { uuid: widgetUuid, sameProvider: true },
    ])

    // The wallet refuses a document with an opaque origin, so its frame has
    // neither a provider nor an announcement to answer with.
    expect(await recordedEvents(sandboxed)).toEqual([])
    expect(await requestAnnouncement(sandboxed)).toEqual([])
    expect(await sandboxed.evaluate(() => 'qbit' in window)).toBe(false)
  })
})
