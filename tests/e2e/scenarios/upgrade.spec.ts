import { mkdir } from 'node:fs/promises'

import { test as base, expect, type Page } from '@playwright/test'

import { walletColorForSlot } from '../../../packages/wallet-shared/src/utils/wallet-identity'
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
  key: string
  index: number
  type: string
  alianName: string
  color: string
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

// Where redux-localstorage-simple keeps the persisted `ui` slice.
const SAVED_UI_KEY = 'redux_localstorage_simple_ui'

async function savedUi(page: Page) {
  return JSON.parse((await readLocalStorage(page))[SAVED_UI_KEY]!)
}

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

/**
 * The release's wallets as the account card and the account switcher show
 * them: their names as the release stored them, never renamed to "Wallet N",
 * and, as the release stored no colors, each in its slot's color. Showing
 * them stores no color.
 */
async function expectWalletIdentity(
  extension: ExtensionSession,
  home: WalletHomePage,
  dump: ReleaseStorage
) {
  const keyrings = await extension.requestWalletController<KeyringProbe[]>(home.page, 'getKeyrings')
  const currentAddress = dump.wallet.currentAccount.address
  const current = keyrings.find(keyring =>
    keyring.accounts.some(account => account.address === currentAddress)
  )
  expect(current).toBeDefined()
  for (const keyring of keyrings) {
    expect(keyring.color).toBe(walletColorForSlot(keyring.index))
  }
  await home.expectCurrentAccount({
    walletName: current!.alianName,
    accountName: dump.wallet.currentAccount.alianName,
    address: currentAddress,
  })
  await expect(home.cardWalletTile).toHaveAttribute(
    'data-color',
    walletColorForSlot(current!.index)
  )

  const sheet = await home.openAccountSwitcher()
  await expect.poll(() => sheet.walletKeys()).toEqual(keyrings.map(keyring => keyring.key))
  for (const [position, keyring] of keyrings.entries()) {
    await expect(sheet.walletName(keyring.key)).toHaveText(
      dump.wallet.keyrings[position]!.alianName
    )
    await expect(sheet.walletTile(keyring.key)).toHaveAttribute(
      'data-color',
      walletColorForSlot(keyring.index)
    )
    await expect
      .poll(() => sheet.walletTags(keyring.key))
      .toEqual(keyring.type === 'Readonly' ? ['read-only'] : [])
    expect(await sheet.accountAddresses(keyring.key)).toEqual(
      dump.wallet.keyrings[position]!.accounts.map(account => account.address)
    )
  }
  await expect(sheet.currentAccountRow).toHaveAttribute(
    'data-testid',
    `account-row-${currentAddress}`
  )
  await sheet.close()

  const stored = await home.page.evaluate(() => chrome.storage.local.get('preference'))
  expect(stored['preference']?.keyringColors ?? {}).toEqual({})
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
    await expectWalletIdentity(extension, home, dump)

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

    // Showing balances again is a change only this build saves. Once the
    // saved UI state holds it, the rest of that state is what this build kept
    // of the release's, with the fee bar's source, which 1.0.5 and 1.0.6 did
    // not save, filled in.
    const releaseUi = JSON.parse(dump.localStorage[SAVED_UI_KEY]!)
    expect(releaseUi.isBalanceHidden).toBe(true)
    await page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`)
    await home.waitUntilReady()
    await home.balanceCard
      .locator('[src*="balance-eyes-closed"], [style*="balance-eyes-closed"]')
      .click()
    await expect.poll(async () => (await savedUi(page)).isBalanceHidden).toBe(false)
    expect(await savedUi(page)).toEqual({
      ...releaseUi,
      isBalanceHidden: false,
      feeRateBar: { ...releaseUi.feeRateBar, feeRateSource: null },
    })

    // The send screen takes an address with that state loaded.
    await home.openSend()
    await page.getByTestId('recipient-address-input').fill(contact!.address)
    await expect(page.getByTestId('recipient-address-input')).toHaveValue(contact!.address)

    // What this build saved while it ran opens again.
    await extension.restart()
    const reopened = await unlock(extension, dump)
    await expectWallets(extension, reopened.page, dump)
    await expectWalletIdentity(extension, reopened.home, dump)
    expect(
      await extension.requestWalletController<SiteProbe[]>(reopened.page, 'getConnectedSites')
    ).toEqual([expect.objectContaining({ ...site, isConnected: true })])
    expect(
      await extension.requestWalletController<ContactProbe[]>(reopened.page, 'listContacts')
    ).toContainEqual(expect.objectContaining({ ...contact, isContact: true }))
  })
}
