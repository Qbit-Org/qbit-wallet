import { mkdir } from 'node:fs/promises'

import { test as base, expect, type Page } from '@playwright/test'

import {
  RELEASES,
  readReleaseStorage,
  type ReleaseStorage,
} from '../../fixtures/release-storage/release-storage'
import { SettingsPage, WalletHomePage } from '../pages'
import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'
import {
  OFFLINE_BROWSER_ARGS,
  readLocalStorage,
  seedReleaseStorage,
} from '../support/release-storage'

interface AccountProbe {
  address: string
  alianName: string
}

interface KeyringProbe {
  type: string
  alianName: string
  addressType: number
  accounts: AccountProbe[]
}

interface ContactProbe {
  name: string
  address: string
  chain: string
  isContact: boolean
}

interface SiteProbe {
  origin: string
  chain: string
  isConnected: boolean
}

// Needs no regtest node: the stored data comes from a release, and the
// browser reaches nothing but loopback.
const test = base.extend<{ extension: ExtensionSession }>({
  extension: async ({}, use, testInfo) => {
    assertRepositoryRoot()
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir, undefined, {
      browserArgs: OFFLINE_BROWSER_ARGS,
    })
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        await extension.attachServiceWorkerLog(testInfo)
      } finally {
        await extension.close()
      }
    }
  },
})

async function unlock(extension: ExtensionSession, dump: ReleaseStorage) {
  const page = await extension.openWallet('/main')
  await new SettingsPage(page).unlock(dump.wallet.password)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  return { page, home }
}

/** The wallets as the release listed them, from what this build lists. */
async function expectWallets(extension: ExtensionSession, page: Page, dump: ReleaseStorage) {
  const keyrings = await extension.requestWalletController<KeyringProbe[]>(page, 'getKeyrings')
  expect(
    keyrings.map(keyring => ({
      type: keyring.type,
      alianName: keyring.alianName,
      addressType: keyring.addressType,
      accounts: keyring.accounts.map(({ address, alianName }) => ({ address, alianName })),
    }))
  ).toEqual(
    dump.wallet.keyrings.map(keyring => ({
      type: keyring.type,
      alianName: keyring.alianName,
      addressType: keyring.addressType,
      accounts: keyring.accounts.map(({ address, alianName }) => ({ address, alianName })),
    }))
  )
  const current = await extension.requestWalletController<AccountProbe>(page, 'getCurrentAccount')
  expect({ address: current.address, alianName: current.alianName }).toEqual(
    dump.wallet.currentAccount
  )
}

for (const release of RELEASES) {
  test(`upgrade from ${release}: the wallet unlocks with its accounts, settings, contacts and sites`, async ({
    extension,
  }) => {
    test.setTimeout(5 * 60_000)
    const dump = readReleaseStorage(release)
    const { settings } = dump.wallet
    const [contact] = dump.wallet.contacts
    const [site] = dump.wallet.connectedSites
    await seedReleaseStorage(extension, dump)

    const { page, home } = await unlock(extension, dump)
    await expectWallets(extension, page, dump)
    await expect(home.networkSwitcher).toContainText('Testnet4')
    await expect(
      page.getByText(dump.wallet.currentAccount.alianName, { exact: true })
    ).toBeVisible()

    expect(await extension.requestWalletController(page, 'getChainType')).toBe(settings.chainType)
    expect(await extension.requestWalletController(page, 'getLocale')).toBe(settings.locale)
    expect(await extension.requestWalletController(page, 'getThemeMode')).toBe(settings.themeMode)
    expect(await extension.requestWalletController(page, 'getAutoLockTimeId')).toBe(
      settings.autoLockTimeId
    )
    expect(await extension.requestWalletController(page, 'getDeveloperMode')).toBe(
      settings.developerMode
    )
    await expect(page.locator('html')).toHaveAttribute('data-theme', settings.themeMode)

    const contacts = await extension.requestWalletController<ContactProbe[]>(page, 'listContacts')
    expect(contacts).toContainEqual(expect.objectContaining({ ...contact, isContact: true }))
    await page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings/contacts`)
    await expect(page.getByText(contact!.name, { exact: true })).toBeVisible()

    const sites = await extension.requestWalletController<SiteProbe[]>(page, 'getConnectedSites')
    expect(sites).toEqual([expect.objectContaining({ ...site, isConnected: true })])
    await page.goto(`chrome-extension://${extension.extensionId}/index.html#/connected-sites`)
    await expect(
      page.locator('[data-testid^="connected-site-"]', { hasText: site!.origin })
    ).toHaveCount(1)

    // The saved UI state loads in full: what the release saved is kept, and
    // what it lacked is filled, so the send screen can take an address.
    const savedUi = JSON.parse(dump.localStorage['redux_localstorage_simple_ui']!)
    await expect
      .poll(async () => JSON.parse((await readLocalStorage(page))['redux_localstorage_simple_ui']!))
      .toMatchObject({
        ...savedUi,
        addressInput: expect.any(Object),
        amountInput: expect.any(Object),
      })
    await page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`)
    await home.waitUntilReady()
    await home.openSend()
    await page.getByTestId('recipient-address-input').fill(contact!.address)
    await expect(page.getByTestId('recipient-address-input')).toHaveValue(contact!.address)

    // What this build saved while it ran opens again.
    await extension.restart()
    const reopened = await unlock(extension, dump)
    await expectWallets(extension, reopened.page, dump)
    expect(
      await extension.requestWalletController<SiteProbe[]>(reopened.page, 'getConnectedSites')
    ).toEqual([expect.objectContaining({ ...site, isConnected: true })])
    expect(
      await extension.requestWalletController<ContactProbe[]>(reopened.page, 'listContacts')
    ).toContainEqual(expect.objectContaining({ ...contact, isContact: true }))
  })
}
