import { mkdir } from 'node:fs/promises'

import { test as base, expect, type Page } from '@playwright/test'

import { walletColorForSlot } from '../../../packages/wallet-shared/src/utils/wallet-identity'
import {
  CAPTURE_SEND_AMOUNT,
  RELEASES,
  readReleaseStorage,
  releaseSavedUi,
  savedWholeUi,
  type ReleaseStorage,
} from '../../fixtures/release-storage/release-storage'
import { SendPage, SettingsPage, WalletHomePage } from '../pages'
import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'
import {
  OFFLINE_BROWSER_ARGS,
  readLocalStorage,
  seedReleaseStorage,
} from '../support/release-storage'
import { SAVED_UI_KEY, savedUi, stringsInLocalStorage } from '../support/saved-ui'

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
    // The capture typed the contact's address and 0.0001 on the send form
    // without sending. Releases before 1.0.9 saved that draft with their
    // display preferences; from 1.0.9 a release saves the two preferences
    // alone (savedWholeUi tells which, from the version).
    const releaseUi = releaseSavedUi(release, dump.localStorage, contact!.address)
    expect(releaseUi.sendForm).toEqual(
      savedWholeUi(release) ? { address: contact!.address, amount: CAPTURE_SEND_AMOUNT } : null
    )
    expect(releaseUi.preferences.isBalanceHidden).toBe(true)
    const releasePreferences = releaseUi.preferences
    const draft = [contact!.address, CAPTURE_SEND_AMOUNT]
    await seedReleaseStorage(extension, dump)

    // Once the first wallet page of this build has loaded, before an unlock
    // or any change, the saved UI state holds the release's two preferences
    // and nothing of the draft: replaced with them, or, when the release
    // saved them alone, left as it is.
    const page = await extension.openWallet('/main')
    const unlockScreen = new SettingsPage(page)
    await unlockScreen.waitForUnlock()
    await expect.poll(() => savedUi(page)).toEqual(releasePreferences)
    expect(await stringsInLocalStorage(page, draft)).toEqual([])
    expect((await readLocalStorage(page))[SAVED_UI_KEY]).toBe(
      savedWholeUi(release) ? JSON.stringify(releasePreferences) : releaseUi.stored
    )
    await unlockScreen.unlock(dump.wallet.password)
    const home = new WalletHomePage(page)
    await home.waitUntilReady()
    expect(await home.balancesHidden()).toBe(true)
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

    // Showing balances again saves the two preferences, and nothing else.
    await page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`)
    await home.waitUntilReady()
    await home.setBalancesHidden(false)
    await expect.poll(async () => (await savedUi(page))?.isBalanceHidden).toBe(false)
    expect(await savedUi(page)).toEqual({ ...releasePreferences, isBalanceHidden: false })
    expect(await stringsInLocalStorage(page, draft)).toEqual([])

    // A wallet page opened on the send form's route shows none of the draft.
    const formPage = await extension.openWallet('/wallet/tx/create')
    await new SendPage(formPage).expectEmpty()
    await formPage.close()

    // The send screen takes an address with that state loaded.
    await home.openSend()
    await page.getByTestId('recipient-address-input').fill(contact!.address)
    await expect(page.getByTestId('recipient-address-input')).toHaveValue(contact!.address)

    // What this build saved while it ran opens again.
    await extension.restart()
    const reopened = await unlock(extension, dump)
    expect(await reopened.home.balancesHidden()).toBe(false)
    expect(await savedUi(reopened.page)).toEqual({ ...releasePreferences, isBalanceHidden: false })
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
