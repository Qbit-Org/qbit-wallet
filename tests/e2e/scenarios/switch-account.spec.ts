import { createECDH } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import { test as base, expect, type Locator, type Page } from '@playwright/test'

import { walletColorForSlot } from '../../../packages/wallet-shared/src/utils/wallet-identity'
import { OnboardingPage, RecoveryReportPage, SettingsPage, WalletHomePage } from '../pages'
import { EmptyRegtestExplorer } from '../support/empty-regtest-explorer'
import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'
import { E2E_PASSWORD, FIXED_MNEMONIC } from '../support/wallet-setup'

interface AccountProbe {
  key: string
  address: string
  alianName: string
}

interface KeyringProbe {
  key: string
  index: number
  type: string
  alianName: string
  color: string
  accounts: AccountProbe[]
}

// Needs no regtest node: the wallets live on Regtest, whose indexer is a
// loopback stand-in for a chain on which no address has any activity.
const test = base.extend<{ explorer: EmptyRegtestExplorer; extension: ExtensionSession }>({
  // Playwright reads a fixture's dependencies from this pattern; this one has none.
  // eslint-disable-next-line no-empty-pattern
  explorer: async ({}, use, testInfo) => {
    const explorer = new EmptyRegtestExplorer()
    await explorer.start()
    try {
      await use(explorer)
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('empty-regtest-explorer.log', {
            body: explorer.log(),
            contentType: 'text/plain',
          })
        }
      } finally {
        await explorer.close()
      }
    }
  },
  extension: async ({ explorer }, use, testInfo) => {
    assertRepositoryRoot()
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir, undefined, {
      browserArgs: explorer.browserArgs,
    })
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await extension.attachServiceWorkerLog(testInfo)
        }
      } finally {
        await extension.close()
      }
    }
  },
})

async function walletKeyrings(extension: ExtensionSession, page: Page): Promise<KeyringProbe[]> {
  return extension.requestWalletController<KeyringProbe[]>(page, 'getKeyrings')
}

async function walletKeyring(
  extension: ExtensionSession,
  page: Page,
  key: string
): Promise<KeyringProbe> {
  const keyring = (await walletKeyrings(extension, page)).find(candidate => candidate.key === key)
  if (!keyring) throw new Error(`the background lists no wallet ${key}`)
  return keyring
}

async function currentAddress(extension: ExtensionSession, page: Page): Promise<string> {
  return (await extension.requestWalletController<AccountProbe>(page, 'getCurrentAccount')).address
}

/** The wallets' names and account counts, as the background lists them. */
async function walletSummary(extension: ExtensionSession, page: Page) {
  return (await walletKeyrings(extension, page)).map(keyring => ({
    name: keyring.alianName,
    accounts: keyring.accounts.length,
  }))
}

/**
 * Two wallets on Regtest: "Wallet 1", created at onboarding, and "Wallet 2",
 * restored from the public test phrase through Add or import wallet. The
 * restored one is current.
 */
async function setUpTwoWallets(extension: ExtensionSession) {
  const page = await extension.openWallet('/welcome')
  const onboarding = new OnboardingPage(page)
  await onboarding.createNewWallet(E2E_PASSWORD)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.switchToRegtest()
  await home.expectCurrentAccount({ walletName: 'Wallet 1', accountName: 'Account 1' })

  await home.openAddWallet()
  await onboarding.restoreAdditionalWallet(FIXED_MNEMONIC)
  const report = new RecoveryReportPage(page)
  expect(await report.summary()).toEqual({ accountsRestored: 1, network: 'Regtest' })
  await report.continueToWallet()
  await home.waitUntilReady()

  const [created, restored, ...others] = await walletKeyrings(extension, page)
  if (!created || !restored || others.length > 0) {
    throw new Error('expected one created and one restored wallet')
  }
  expect([created.alianName, restored.alianName]).toEqual(['Wallet 1', 'Wallet 2'])
  await home.expectCurrentAccount({
    walletName: 'Wallet 2',
    accountName: 'Account 1',
    address: restored.accounts[0]!.address,
  })
  return { page, home, onboarding, created, restored }
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox()
  if (!bounds) throw new Error(`${locator} is not visible`)
  return bounds
}

/** Opens a new wallet page, as reopening the popup does, and closes the old one. */
async function reopenWallet(extension: ExtensionSession, page: Page): Promise<WalletHomePage> {
  const reopened = await extension.openWallet('/main')
  await page.close()
  const home = new WalletHomePage(reopened)
  await home.waitUntilReady()
  return home
}

test('switch account: the card names the wallet, two taps switch wallets, Add account and search', async ({
  extension,
}) => {
  const { page, home, created, restored } = await setUpTwoWallets(extension)

  // The header has no wallet chip; the card names the wallet above the account.
  await expect(page.getByTestId('wallet-management-entry')).toHaveCount(0)
  expect((await box(home.cardWalletName)).y).toBeLessThan((await box(home.cardAccountName)).y)
  await expect(home.cardWalletTile).toHaveAttribute(
    'data-color',
    walletColorForSlot(restored.index)
  )
  await expect.poll(() => home.cardTags()).toEqual(['recovered'])

  // Every account, grouped under its wallet in wallet order, the current one marked.
  let sheet = await home.openAccountSwitcher()
  await expect.poll(() => sheet.walletKeys()).toEqual([created.key, restored.key])
  await expect(sheet.walletName(created.key)).toHaveText('Wallet 1')
  await expect(sheet.walletName(restored.key)).toHaveText('Wallet 2')
  await expect(sheet.walletTile(created.key)).toHaveAttribute(
    'data-color',
    walletColorForSlot(created.index)
  )
  await expect(sheet.walletTile(restored.key)).toHaveAttribute(
    'data-color',
    walletColorForSlot(restored.index)
  )
  await expect.poll(() => sheet.walletTags(created.key)).toEqual([])
  await expect.poll(() => sheet.walletTags(restored.key)).toEqual(['recovered'])
  await expect(sheet.currentAccountRow).toHaveCount(1)
  await expect(sheet.currentAccountRow).toHaveAttribute(
    'data-testid',
    `account-row-${restored.accounts[0]!.address}`
  )

  // "+" on the wallet that is not current derives the account there and selects it.
  // The new account screen names that wallet.
  await sheet.addAccount(created.key)
  await expect(page.getByTestId('create-account-wallet-name')).toHaveText('Wallet 1')
  await expect(page.getByTestId('create-account-wallet-tile')).toHaveAttribute(
    'data-color',
    walletColorForSlot(created.index)
  )
  await page.getByTestId('create-account-name-input').fill('Savings')
  await page.getByTestId('create-account-confirm-button').click()
  await home.waitUntilReady()
  const savings = (await walletKeyring(extension, page, created.key)).accounts[1]
  expect(savings?.alianName).toBe('Savings')
  await home.expectCurrentAccount({
    walletName: 'Wallet 1',
    accountName: 'Savings',
    address: savings!.address,
  })
  expect(await currentAddress(extension, page)).toBe(savings!.address)
  expect(await walletSummary(extension, page)).toEqual([
    { name: 'Wallet 1', accounts: 2 },
    { name: 'Wallet 2', accounts: 1 },
  ])

  // The wallet menu's Add Account does the same for the restored wallet.
  sheet = await home.openAccountSwitcher()
  await sheet.chooseWalletMenuItem(restored.key, 'add-account')
  await expect(page).toHaveURL(/#\/account\/create(?:$|\?)/)
  await expect(page.getByTestId('create-account-wallet-name')).toHaveText('Wallet 2')
  await page.getByTestId('create-account-confirm-button').click()
  await home.waitUntilReady()
  const restoredSecond = (await walletKeyring(extension, page, restored.key)).accounts[1]
  expect(restoredSecond?.alianName).toBe('Account 2')
  await home.expectCurrentAccount({
    walletName: 'Wallet 2',
    accountName: 'Account 2',
    address: restoredSecond!.address,
  })
  expect(await walletSummary(extension, page)).toEqual([
    { name: 'Wallet 1', accounts: 2 },
    { name: 'Wallet 2', accounts: 2 },
  ])

  // Within a wallet, from one account to another.
  await home.switchAccount(restored.accounts[0]!.address)
  await home.expectCurrentAccount({ walletName: 'Wallet 2', accountName: 'Account 1' })
  expect(await currentAddress(extension, page)).toBe(restored.accounts[0]!.address)

  // The other wallet's second account is two taps away: the card, then the row.
  await home.accountCard.click()
  await page.getByTestId(`account-row-${savings!.address}`).click()
  await expect(page.getByTestId('switch-account-sheet')).toHaveCount(0)
  await home.expectCurrentAccount({
    walletName: 'Wallet 1',
    accountName: 'Savings',
    address: savings!.address,
  })
  expect(await currentAddress(extension, page)).toBe(savings!.address)

  // With the keyboard: Enter on "+" opens the new account screen, whose name
  // field has focus by the time that key comes up, and nothing is created
  // until Enter is pressed in the field.
  sheet = await home.openAccountSwitcher()
  await expect(sheet.searchInput).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sheet.addAccountButton(created.key)).toBeFocused()
  await page.keyboard.press('Enter', { delay: 80 })
  await expect(page).toHaveURL(/#\/account\/create(?:$|\?)/)
  await expect(page.getByTestId('create-account-wallet-name')).toHaveText('Wallet 1')
  const nameField = page.getByTestId('create-account-name-input')
  await expect(nameField).toBeFocused()
  await expect(nameField).toHaveAttribute('placeholder', 'Account 3')
  expect(await walletSummary(extension, page)).toEqual([
    { name: 'Wallet 1', accounts: 2 },
    { name: 'Wallet 2', accounts: 2 },
  ])
  await nameField.fill('Travel')
  await nameField.press('Enter', { delay: 80 })
  await home.waitUntilReady()
  const travel = (await walletKeyring(extension, page, created.key)).accounts[2]
  expect(travel?.alianName).toBe('Travel')
  await home.expectCurrentAccount({
    walletName: 'Wallet 1',
    accountName: 'Travel',
    address: travel!.address,
  })
  expect(await walletSummary(extension, page)).toEqual([
    { name: 'Wallet 1', accounts: 3 },
    { name: 'Wallet 2', accounts: 2 },
  ])

  // Search: an account by name and by address, a wallet by name, and nothing.
  sheet = await home.openAccountSwitcher()
  const everyAccount = [
    created.accounts[0]!.address,
    savings!.address,
    travel!.address,
    restored.accounts[0]!.address,
    restoredSecond!.address,
  ]
  await expect.poll(() => sheet.accountAddresses()).toEqual(everyAccount)
  await sheet.search('savings')
  await expect.poll(() => sheet.accountAddresses()).toEqual([savings!.address])
  expect(await sheet.walletKeys()).toEqual([created.key])
  await sheet.search(restoredSecond!.address)
  await expect.poll(() => sheet.accountAddresses()).toEqual([restoredSecond!.address])
  expect(await sheet.walletKeys()).toEqual([restored.key])
  await sheet.search('Wallet 2')
  await expect
    .poll(() => sheet.accountAddresses())
    .toEqual([restored.accounts[0]!.address, restoredSecond!.address])
  expect(await sheet.walletKeys()).toEqual([restored.key])
  await sheet.search('no such account')
  await expect(sheet.emptyResult).toBeVisible()
  expect(await sheet.walletKeys()).toEqual([])
  await sheet.search('')
  await expect.poll(() => sheet.accountAddresses()).toEqual(everyAccount)

  // Escape closes the sheet, even from the search field.
  await sheet.searchInput.press('Escape')
  await sheet.waitUntilClosed()
})

test('switch account: Rename Wallet, Edit Name and Change Color persist after the popup is reopened', async ({
  extension,
}) => {
  const { page, home, created, restored } = await setUpTwoWallets(extension)
  const restoredAddress = restored.accounts[0]!.address
  const newColor = 'pink'

  const sheet = await home.openAccountSwitcher()
  // A new wallet's tile starts in its slot's color.
  const slotColor = await sheet.walletColor(restored.key)
  expect(slotColor).toBe(walletColorForSlot(restored.index))
  expect(slotColor).not.toBe(newColor)
  await sheet.renameWallet(created.key, 'Long-term savings')
  await sheet.renameAccount(restoredAddress, 'Everyday')
  await sheet.changeWalletColor(restored.key, newColor)
  // The card under the sheet follows at once.
  await sheet.close()
  await home.expectCurrentAccount({ walletName: 'Wallet 2', accountName: 'Everyday' })
  await expect(home.cardWalletTile).toHaveAttribute('data-color', newColor)

  const expectSaved = async (reopened: WalletHomePage) => {
    await reopened.expectCurrentAccount({
      walletName: 'Wallet 2',
      accountName: 'Everyday',
      address: restoredAddress,
    })
    await expect(reopened.cardWalletTile).toHaveAttribute('data-color', newColor)
    const reopenedSheet = await reopened.openAccountSwitcher()
    await expect(reopenedSheet.walletName(created.key)).toHaveText('Long-term savings')
    await expect(reopenedSheet.walletName(restored.key)).toHaveText('Wallet 2')
    await expect(reopenedSheet.accountRow(restoredAddress)).toContainText('Everyday')
    await expect(reopenedSheet.walletTile(created.key)).toHaveAttribute(
      'data-color',
      walletColorForSlot(created.index)
    )
    await expect(reopenedSheet.walletTile(restored.key)).toHaveAttribute('data-color', newColor)
    await reopenedSheet.close()

    const keyrings = await walletKeyrings(extension, reopened.page)
    expect(
      keyrings.map(keyring => ({
        key: keyring.key,
        name: keyring.alianName,
        color: keyring.color,
        accounts: keyring.accounts.map(account => account.alianName),
      }))
    ).toEqual([
      {
        key: created.key,
        name: 'Long-term savings',
        color: walletColorForSlot(created.index),
        accounts: ['Account 1'],
      },
      { key: restored.key, name: 'Wallet 2', color: newColor, accounts: ['Everyday'] },
    ])
  }

  // A popup opened again shows what was saved.
  const reopened = await reopenWallet(extension, page)
  await expectSaved(reopened)

  // So does the wallet after a browser restart, which locks it.
  await extension.restart()
  const restartedPage = await extension.openWallet('/main')
  await new SettingsPage(restartedPage).unlock(E2E_PASSWORD)
  const restarted = new WalletHomePage(restartedPage)
  await restarted.waitUntilReady()
  await expectSaved(restarted)
})

test('switch account: Remove Wallet, new wallets named "Wallet N" and the last wallet kept', async ({
  extension,
}) => {
  const { page, home, onboarding, created, restored } = await setUpTwoWallets(extension)

  // Removing the current wallet leaves the other one selected.
  let sheet = await home.openAccountSwitcher()
  await sheet.removeWallet(restored.key)
  await expect.poll(() => sheet.walletKeys()).toEqual([created.key])
  await expect(sheet.currentAccountRow).toHaveAttribute(
    'data-testid',
    `account-row-${created.accounts[0]!.address}`
  )
  await sheet.close()
  await home.expectCurrentAccount({ walletName: 'Wallet 1', accountName: 'Account 1' })
  expect(await walletSummary(extension, page)).toEqual([{ name: 'Wallet 1', accounts: 1 }])

  // N is the number of wallets once the new one is added; the removed wallet
  // does not count, so its number is free again, although the new wallet
  // takes a new slot (and that slot's color).
  await home.openAddWallet()
  await onboarding.createAdditionalWallet()
  await home.waitUntilReady()
  const [, second] = await walletKeyrings(extension, page)
  expect(second?.alianName).toBe('Wallet 2')
  expect(second?.index).toBe(2)
  await home.expectCurrentAccount({ walletName: 'Wallet 2', accountName: 'Account 1' })
  await expect(home.cardWalletTile).toHaveAttribute('data-color', walletColorForSlot(2))

  // A second account on "Wallet 2" becomes current (adding an account from
  // the sheet is covered above).
  await extension.requestWalletController(page, 'deriveNewAccountFromMnemonic', [
    second,
    'Spending',
  ])
  const spending = (await walletKeyring(extension, page, second!.key)).accounts[1]!
  await home.expectCurrentAccount({
    walletName: 'Wallet 2',
    accountName: 'Spending',
    address: spending.address,
  })

  // Removing a wallet that is not current leaves the current wallet and
  // account as they were. With "Wallet 1" removed, two wallets once the next
  // is added: "Wallet 2" is taken, so the number goes up to the next free one.
  sheet = await home.openAccountSwitcher()
  await sheet.removeWallet(created.key)
  await expect.poll(() => sheet.walletKeys()).toEqual([second!.key])
  await expect(sheet.currentAccountRow).toHaveAttribute(
    'data-testid',
    `account-row-${spending.address}`
  )
  await sheet.close()
  await home.expectCurrentAccount({
    walletName: 'Wallet 2',
    accountName: 'Spending',
    address: spending.address,
  })
  expect(await currentAddress(extension, page)).toBe(spending.address)
  await home.openAddWallet()
  await onboarding.createAdditionalWallet()
  await home.waitUntilReady()
  await home.expectCurrentAccount({ walletName: 'Wallet 3', accountName: 'Account 1' })
  const remaining = await walletKeyrings(extension, page)
  expect(remaining.map(keyring => [keyring.alianName, keyring.index])).toEqual([
    ['Wallet 2', 2],
    ['Wallet 3', 3],
  ])
  const [kept, third] = remaining as [KeyringProbe, KeyringProbe]

  // Removing the current wallet makes the last wallet left current, on its
  // first account.
  sheet = await home.openAccountSwitcher()
  await sheet.removeWallet(third.key)
  await expect(sheet.currentAccountRow).toHaveAttribute(
    'data-testid',
    `account-row-${kept.accounts[0]!.address}`
  )
  expect(await currentAddress(extension, page)).toBe(kept.accounts[0]!.address)

  // The last wallet cannot be removed: the menu says so and opens no confirmation.
  await sheet.chooseWalletMenuItem(kept.key, 'remove')
  await expect(
    page.getByText('Removing the last wallet is not allowed', { exact: true }).first()
  ).toBeVisible()
  await expect(sheet.removalDialog).toHaveCount(0)
  await expect(sheet.menu).toHaveCount(0)
  await expect.poll(() => sheet.walletKeys()).toEqual([kept.key])
  expect(await walletSummary(extension, page)).toEqual([{ name: 'Wallet 2', accounts: 2 }])
})

test('switch account: a read-only wallet shows Read Only and offers no Add Account', async ({
  extension,
}) => {
  const { page, home, onboarding, created, restored } = await setUpTwoWallets(extension)

  // Developer mode offers the readonly wallet. Its public key is a fresh
  // secp256k1 key whose private half is dropped.
  await new SettingsPage(page).enableDeveloperMode()
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`)
  await home.waitUntilReady()
  await home.openAddWallet()
  await onboarding.addReadonlyWallet(createECDH('secp256k1').generateKeys('hex', 'compressed'))
  await home.waitUntilReady()
  const readonly = (await walletKeyrings(extension, page)).find(
    keyring => keyring.key !== created.key && keyring.key !== restored.key
  )
  if (!readonly) throw new Error('the readonly wallet was not added')
  expect(readonly.type).toBe('Readonly')
  await home.expectCurrentAccount({
    walletName: 'Wallet 3',
    address: readonly.accounts[0]!.address,
  })
  await expect.poll(() => home.cardTags()).toEqual(['read-only'])

  const sheet = await home.openAccountSwitcher()
  await expect.poll(() => sheet.walletTags(readonly.key)).toEqual(['read-only'])
  await expect(sheet.addAccountButton(readonly.key)).toHaveCount(0)
  await sheet.openWalletMenu(readonly.key)
  expect(await sheet.menuItems()).toEqual(['rename', 'change-color', 'remove'])
  // Escape closes the menu and leaves the sheet open.
  await page.keyboard.press('Escape')
  await expect(sheet.menu).toHaveCount(0)
  await expect(sheet.root).toBeVisible()
  await sheet.openAccountMenu(readonly.accounts[0]!.address)
  expect(await sheet.menuItems()).toEqual(['edit-name', 'copy-address'])
  await page.keyboard.press('Escape')
  await expect(sheet.menu).toHaveCount(0)

  // A wallet with a recovery phrase offers both, and its phrase is in the
  // wallet menu only, never in an account menu.
  await expect(sheet.addAccountButton(created.key)).toBeVisible()
  await sheet.openWalletMenu(created.key)
  expect(await sheet.menuItems()).toEqual([
    'add-account',
    'rename',
    'change-color',
    'show-phrase',
    'remove',
  ])
  await page.keyboard.press('Escape')
  await expect(sheet.menu).toHaveCount(0)
  await sheet.openAccountMenu(created.accounts[0]!.address)
  expect(await sheet.menuItems()).toEqual(['edit-name', 'copy-address'])
  await page.keyboard.press('Escape')
  await expect(sheet.menu).toHaveCount(0)
  await sheet.close()
})
