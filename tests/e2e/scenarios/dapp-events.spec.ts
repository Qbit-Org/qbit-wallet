import type { Page } from '@playwright/test'

import { ApprovalsPage, SettingsPage } from '../pages'
import { expect, test } from '../fixtures/test'
import { DappServer } from '../support/dapp-server'
import { E2E_PASSWORD, provisionDeterministicRegtestWallet } from '../support/wallet-setup'

type ProviderEvent = [string, unknown]

interface BrowserQbitProvider {
  requestAccounts(): Promise<string[]>
  getAccounts(): Promise<string[]>
  on(event: string, handler: (data: unknown) => void): void
}

interface WindowWithQbit extends Window {
  qbit?: BrowserQbitProvider
  qbitE2eEvents?: ProviderEvent[]
}

const PROVIDER_EVENTS = ['accountsChanged', 'networkChanged', 'chainChanged', 'disconnect']

async function connectRecordingSite(
  extension: Parameters<typeof provisionDeterministicRegtestWallet>[0],
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

  const connectResult = page.evaluate(() => {
    const provider = (window as WindowWithQbit).qbit
    if (!provider) throw new Error('window.qbit is unavailable')
    return provider.requestAccounts()
  })
  const approval = await ApprovalsPage.waitForNext(extension.context)
  expect(await approval.contextText()).toContain(origin)
  await approval.approveConnection()
  const [address] = await connectResult
  // requestAccounts announces the account to its own page; start from a clean log.
  await expect
    .poll(() => recordedEvents(page))
    .toContainEqual(['accountsChanged', [address]])
  await page.evaluate(() => {
    ;(window as WindowWithQbit).qbitE2eEvents = []
  })
  return page
}

function recordedEvents(page: Page): Promise<ProviderEvent[]> {
  return page.evaluate(() => (window as WindowWithQbit).qbitE2eEvents ?? [])
}

function readAccounts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const provider = (window as WindowWithQbit).qbit
    if (!provider) throw new Error('window.qbit is unavailable')
    return provider.getAccounts()
  })
}

test('G3 dapp events: a site setting, a lock and a revocation reach only the sites they concern', async ({
  extension,
  networkAudit,
}) => {
  test.setTimeout(5 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)

  const servers = [new DappServer(), new DappServer()]
  try {
    const [originA, originB] = await Promise.all(servers.map(server => server.start()))
    networkAudit.allowFixtureOrigin(originA!)
    networkAudit.allowFixtureOrigin(originB!)
    const siteA = await connectRecordingSite(extension, originA!)
    const siteB = await connectRecordingSite(extension, originB!)

    // Trusting site A for quick multi-sign changes neither the network nor
    // what any site can read.
    await extension.requestWalletController<void>(setup.page, 'updateConnectSite', [
      originA,
      { allowQuickMultiSign: true },
    ])

    // Locking keeps both grants and is not a revocation.
    await setup.home.openSettings()
    const settings = new SettingsPage(setup.page)
    await settings.lockWallet()
    await settings.unlock(E2E_PASSWORD)
    await setup.home.waitUntilReady()
    expect(await readAccounts(siteA)).toEqual([setup.address])
    expect(await readAccounts(siteB)).toEqual([setup.address])

    // Revoking site A is announced to site A only. Its disconnect event also
    // marks that every earlier event has been delivered.
    await extension.requestWalletController<void>(setup.page, 'removeConnectedSite', [originA])
    await expect
      .poll(() => recordedEvents(siteA).then(events => events.map(([event]) => event)))
      .toContain('disconnect')

    expect(await recordedEvents(siteA)).toEqual([
      ['accountsChanged', []],
      ['disconnect', expect.objectContaining({ code: 4900 })],
    ])
    expect(await recordedEvents(siteB)).toEqual([])
    expect(await readAccounts(siteA)).toEqual([])
    expect(await readAccounts(siteB)).toEqual([setup.address])
  } finally {
    await Promise.all(servers.map(server => server.close()))
  }
})
