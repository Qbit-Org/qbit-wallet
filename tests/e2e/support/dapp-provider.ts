import { expect, type Page } from '@playwright/test'

import { ApprovalsPage } from '../pages'
import type { ExtensionSession } from './extension-session'

/** One provider event as a site's listener received it: its name and data. */
export type ProviderEvent = [string, unknown]

interface BrowserQbitProvider {
  requestAccounts(): Promise<string[]>
  getAccounts(): Promise<string[]>
  on(event: string, handler: (data: unknown) => void): void
}

interface WindowWithQbit extends Window {
  qbit?: BrowserQbitProvider
  qbitE2eEvents?: ProviderEvent[]
}

/** The events a recording site listens to. */
export const PROVIDER_EVENTS = ['accountsChanged', 'networkChanged', 'chainChanged', 'disconnect']

/**
 * Opens `origin` in a new tab, records the provider events it receives, and
 * connects it to the current account through the approval window. The record
 * starts empty once the connection itself has been announced.
 */
export async function connectRecordingSite(
  extension: ExtensionSession,
  origin: string
): Promise<Page> {
  const page = await extension.context.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean((window as WindowWithQbit).qbit))
  await page.evaluate(events => {
    const target = window as WindowWithQbit
    const provider = target.qbit
    if (!provider) throw new Error('window.qbit is unavailable')
    target.qbitE2eEvents = []
    for (const event of events) {
      provider.on(event, data => target.qbitE2eEvents?.push([event, data]))
    }
  }, PROVIDER_EVENTS)

  const connectResult = requestAccounts(page)
  const approval = await ApprovalsPage.waitForNext(extension.context)
  expect(await approval.contextText()).toContain(origin)
  await approval.approveConnection()
  const [address] = await connectResult
  // requestAccounts announces the account to its own page; start from a clean log.
  await expect.poll(() => recordedEvents(page)).toContainEqual(['accountsChanged', [address]])
  await page.evaluate(() => {
    ;(window as WindowWithQbit).qbitE2eEvents = []
  })
  return page
}

export function recordedEvents(page: Page): Promise<ProviderEvent[]> {
  return page.evaluate(() => (window as WindowWithQbit).qbitE2eEvents ?? [])
}

/** The site's getAccounts(): what it may read without asking. */
export function readAccounts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const provider = (window as WindowWithQbit).qbit
    if (!provider) throw new Error('window.qbit is unavailable')
    return provider.getAccounts()
  })
}

/** The site's requestAccounts(), which settles once the wallet answers it. */
export function requestAccounts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const provider = (window as WindowWithQbit).qbit
    if (!provider) throw new Error('window.qbit is unavailable')
    return provider.requestAccounts()
  })
}
