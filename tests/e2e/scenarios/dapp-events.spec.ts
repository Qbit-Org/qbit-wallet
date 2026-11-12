import { SettingsPage } from '../pages'
import { expect, test } from '../fixtures/test'
import { connectRecordingSite, readAccounts, recordedEvents } from '../support/dapp-provider'
import { DappServer } from '../support/dapp-server'
import { E2E_PASSWORD, provisionDeterministicRegtestWallet } from '../support/wallet-setup'

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
