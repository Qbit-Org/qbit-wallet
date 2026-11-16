import type { BrowserContext, Page } from '@playwright/test'

interface BroadcastGate {
  held: boolean
  queue: (() => void)[]
}

interface WindowWithBroadcastGate extends Window {
  __qbitE2eBroadcastGate?: BroadcastGate
}

/**
 * Lets a scenario hold back what the background broadcasts to one wallet page
 * (another window added a wallet, the wallet locked), standing in for a window
 * that has not handled it yet. The page's own requests and their answers pass
 * as usual, and the held broadcasts are delivered in order on release.
 *
 * Installed in every wallet page the context opens from now on: it wraps
 * chrome.runtime.connect before the page's code connects, and holds nothing
 * until holdBroadcasts.
 */
export async function installBroadcastGate(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (
      location.protocol !== 'chrome-extension:' ||
      typeof chrome?.runtime?.connect !== 'function'
    ) {
      return
    }
    const gate: BroadcastGate = { held: false, queue: [] }
    ;(window as WindowWithBroadcastGate).__qbitE2eBroadcastGate = gate
    const connect = chrome.runtime.connect.bind(chrome.runtime) as (
      ...args: unknown[]
    ) => chrome.runtime.Port
    Object.defineProperty(chrome.runtime, 'connect', {
      configurable: true,
      value: (...args: unknown[]) => {
        const port = connect(...args)
        const addListener = port.onMessage.addListener.bind(port.onMessage)
        Object.defineProperty(port.onMessage, 'addListener', {
          configurable: true,
          value: (listener: (message: unknown, port: chrome.runtime.Port) => void) =>
            addListener((message: unknown, sender: chrome.runtime.Port) => {
              const envelope = message as { _type_?: unknown; data?: { data?: { type?: unknown } } }
              const broadcast =
                envelope?._type_ === 'QBIT_WALLET_request' &&
                envelope.data?.data?.type === 'bg_broadcast'
              if (broadcast && gate.held) {
                gate.queue.push(() => listener(message, sender))
              } else {
                listener(message, sender)
              }
            }),
        })
        return port
      },
    })
  })
}

/** From now on `page` gets no broadcast until releaseBroadcasts. */
export async function holdBroadcasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (window as WindowWithBroadcastGate).__qbitE2eBroadcastGate
    if (!gate) throw new Error('this page has no broadcast gate; install it before the page opens')
    gate.held = true
  })
}

/** Delivers what `page` was not told meanwhile, in order; resolves with how many. */
export async function releaseBroadcasts(page: Page): Promise<number> {
  return page.evaluate(() => {
    const gate = (window as WindowWithBroadcastGate).__qbitE2eBroadcastGate
    if (!gate) throw new Error('this page has no broadcast gate')
    gate.held = false
    const held = gate.queue.splice(0)
    held.forEach(deliver => deliver())
    return held.length
  })
}
