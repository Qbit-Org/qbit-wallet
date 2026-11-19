import { createECDH } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { ChainType } from '../../../packages/wallet-types/src'
import { CHAINS_MAP } from '../../../packages/wallet-shared/src/constants/common'
import { walletColorForSlot } from '../../../packages/wallet-shared/src/utils/wallet-identity'
import { expect, test } from '../fixtures/empty-regtest'
import {
  type AccountSwitcherSheet,
  OnboardingPage,
  RecoveryReportPage,
  SettingsPage,
  shortAddress,
  switcherAmount,
  switcherExactAmount,
  WalletHomePage,
  type WalletTag,
} from '../pages'
import type { EmptyRegtestExplorer } from '../support/empty-regtest-explorer'
import type { ExtensionSession } from '../support/extension-session'
import { extensionDist } from '../support/paths'
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

/** How much of an element's text its box cuts off: 0 when it shows whole. */
async function cutOff(locator: Locator): Promise<number> {
  return locator.evaluate(element => element.scrollWidth - element.clientWidth)
}

/**
 * The card's three lines: the wallet name, with `tag` after it on its line
 * and inside it, then the account name, then the address. The tile is
 * centred against them.
 */
async function expectCardLines(home: WalletHomePage, tag: WalletTag) {
  await expect(home.cardTag(tag)).toBeVisible()
  const walletBox = await box(home.cardWalletName)
  const tagBox = await box(home.cardTag(tag))
  const accountBox = await box(home.cardAccountName)
  const addressBox = await box(home.cardAddress)
  const centre = (bounds: { y: number; height: number }) => bounds.y + bounds.height / 2
  expect(tagBox.x).toBeGreaterThanOrEqual(walletBox.x + walletBox.width)
  expect(centre(tagBox)).toBeCloseTo(centre(walletBox), 0)
  // The account name spans the line, so it shows where the line ends.
  expect(walletBox.x).toBeCloseTo(accountBox.x, 0)
  expect(tagBox.x + tagBox.width).toBeLessThanOrEqual(accountBox.x + accountBox.width + 0.5)
  expect(Math.max(walletBox.y + walletBox.height, tagBox.y + tagBox.height)).toBeLessThanOrEqual(
    accountBox.y + 0.5
  )
  expect(accountBox.y + accountBox.height).toBeLessThanOrEqual(addressBox.y + 0.5)
  expect(centre(await box(home.cardWalletTile))).toBeCloseTo(centre(await box(home.accountCard)), 0)
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

  // The header has no wallet chip. The card names the wallet above the
  // account, its tile carries the wallet's color, and the wallet's tags sit
  // on the wallet name's line, after the name.
  await expect(page.getByTestId('wallet-management-entry')).toHaveCount(0)
  await home.expectCurrentAccount({ walletName: 'Wallet 2', accountName: 'Account 1' })
  await expect(home.cardWalletTile).toHaveAttribute(
    'data-color',
    walletColorForSlot(restored.index)
  )
  await expect.poll(() => home.cardTags()).toEqual(['recovered'])
  await expectCardLines(home, 'recovered')

  // In the 357 px popup, a 20-character account name, the longest a name can
  // be, shows whole on its own line. A 20-character wallet name is cut, and
  // the tag keeps its width on the wallet name's line. Then the names and the
  // width go back to what the rest of the test expects.
  const viewport = page.viewportSize()
  const restoredAddress = restored.accounts[0]!.address
  const longAccountName = 'Mortgage Overpayment'
  const longWalletName = 'W'.repeat(20)
  await page.setViewportSize({ width: 357, height: viewport?.height ?? 860 })
  const renaming = await home.openAccountSwitcher()
  await renaming.renameAccount(restoredAddress, longAccountName)
  await renaming.renameWallet(restored.key, longWalletName)
  await renaming.close()
  await home.expectCurrentAccount({ walletName: longWalletName, accountName: longAccountName })
  expect(await cutOff(home.cardAccountName)).toBe(0)
  expect(await cutOff(home.cardWalletName)).toBeGreaterThan(0)
  expect(await cutOff(home.cardTag('recovered'))).toBe(0)
  await expectCardLines(home, 'recovered')
  const renamingBack = await home.openAccountSwitcher()
  await renamingBack.renameAccount(restoredAddress, 'Account 1')
  await renamingBack.renameWallet(restored.key, 'Wallet 2')
  await renamingBack.close()
  if (viewport) await page.setViewportSize(viewport)
  await home.expectCurrentAccount({ walletName: 'Wallet 2', accountName: 'Account 1' })

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

  // Each Create's own "Account created" toast: none is on screen before it
  // (an earlier one, which lasts about 2 s, has gone), one after it. Then the
  // dialog and the sheet under it close over the home screen.
  const accountCreatedToast = page.getByText('Account created', { exact: true })
  const expectNoAccountCreatedToast = () => expect(accountCreatedToast).toHaveCount(0)
  const expectAccountCreated = async () => {
    await expect(accountCreatedToast).toBeVisible()
    await expect(sheet.newAccountDialog).toHaveCount(0)
    await sheet.waitUntilClosed()
  }

  // "+" on the wallet that is not current opens the New account dialog over
  // the open sheet; the dialog names that wallet.
  await sheet.addAccount(created.key)
  await sheet.expectNewAccountDialogOverSheet()
  await expect(sheet.newAccountWalletName).toHaveText('Wallet 1')
  await expect(sheet.newAccountWalletTile).toHaveAttribute(
    'data-color',
    walletColorForSlot(created.index)
  )

  // Cancel, and Escape, go back to the open sheet with focus on the "+", and
  // create nothing.
  const beforeAdding = [
    { name: 'Wallet 1', accounts: 1 },
    { name: 'Wallet 2', accounts: 1 },
  ]
  await sheet.newAccountCancelButton.click()
  await expect(sheet.newAccountDialog).toHaveCount(0)
  await expect(sheet.root).toBeVisible()
  await expect(sheet.addAccountButton(created.key)).toBeFocused()
  expect(await walletSummary(extension, page)).toEqual(beforeAdding)
  await sheet.addAccount(created.key)
  await sheet.expectNewAccountDialogOverSheet()
  await page.keyboard.press('Escape')
  await expect(sheet.newAccountDialog).toHaveCount(0)
  await expect(sheet.root).toBeVisible()
  await expect(sheet.addAccountButton(created.key)).toBeFocused()
  expect(await walletSummary(extension, page)).toEqual(beforeAdding)

  // Create derives the account there and selects it.
  await sheet.addAccount(created.key)
  await sheet.newAccountNameInput.fill('Savings')
  await expectNoAccountCreatedToast()
  await sheet.newAccountCreateButton.click()
  await expectAccountCreated()
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
  await sheet.expectNewAccountDialogOverSheet()
  await expect(sheet.newAccountWalletName).toHaveText('Wallet 2')
  await expectNoAccountCreatedToast()
  await sheet.newAccountCreateButton.click()
  await expectAccountCreated()
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

  // With the keyboard: Enter on "+" opens the New account dialog, whose name
  // field has focus by the time that key comes up, and nothing is created
  // until Enter is pressed in the field.
  sheet = await home.openAccountSwitcher()
  await expect(sheet.searchInput).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sheet.addAccountButton(created.key)).toBeFocused()
  await page.keyboard.press('Enter', { delay: 80 })
  await sheet.expectNewAccountDialogOverSheet()
  await expect(sheet.newAccountWalletName).toHaveText('Wallet 1')
  const nameField = sheet.newAccountNameInput
  await expect(nameField).toBeFocused()
  await expect(nameField).toHaveAttribute('placeholder', 'Account 3')
  expect(await walletSummary(extension, page)).toEqual([
    { name: 'Wallet 1', accounts: 2 },
    { name: 'Wallet 2', accounts: 2 },
  ])
  await nameField.fill('Travel')
  await expectNoAccountCreatedToast()
  await nameField.press('Enter', { delay: 80 })
  await expectAccountCreated()
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

  // Removing the last wallet would reset the wallet: the menu opens the Reset
  // Wallet dialog instead of the removal popover or a refusal, and Cancel
  // keeps the wallet. (The reset itself is covered by reset-wallet.spec.ts.)
  const reset = await sheet.chooseRemoveOnLastWallet(kept.key)
  await expect(
    page.getByText('Removing the last wallet is not allowed', { exact: true })
  ).toHaveCount(0)
  await reset.cancel()
  await expect(sheet.root).toBeVisible()
  await expect.poll(() => sheet.walletKeys()).toEqual([kept.key])
  expect(await walletSummary(extension, page)).toEqual([{ name: 'Wallet 2', accounts: 2 }])
})

test('switch account: a read-only wallet shows Read Only, offers no Add Account and reads no total', async ({
  extension,
  explorer,
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

  // Its account's address is no P2MR address of the network, so the switcher
  // asks the explorer nothing for it and shows "--", as does the wallet's
  // total. With another account current, the home screen does not read it
  // either.
  const readonlyAddress = readonly.accounts[0]!.address
  await home.switchAccount(created.accounts[0]!.address)
  const before = explorer.statisticsRequests(readonlyAddress)
  const totals = await home.openAccountSwitcher()
  await expect(totals.pendingTotals).toHaveCount(0)
  await expect(totals.accountBalance(readonlyAddress)).toHaveText('--')
  await expect(totals.walletTotal(readonly.key)).toHaveText('--')
  await expect(totals.accountBalance(created.accounts[0]!.address)).toHaveText(shown(0))
  expect(explorer.statisticsRequests(readonlyAddress)).toBe(before)
  await totals.close()
})

/** The unit the switcher shows after each total on Regtest, in every locale. */
const REGTEST_UNIT = CHAINS_MAP[ChainType.QBIT_REGTEST]!.unit

/** A total as the switcher shows it on Regtest. */
const shown = (sats: number | bigint) => switcherAmount(sats, REGTEST_UNIT)

/** The totals a switcher listing these accounts and wallets shows, keyed as `totalTexts` keys them. */
function expectedTotals(
  accounts: Record<string, string>,
  wallets: Record<string, string>
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(accounts).map(([address, text]) => [`account-balance-${address}`, text])
    ),
    ...Object.fromEntries(
      Object.entries(wallets).map(([key, text]) => [`wallet-total-${key}`, text])
    ),
  }
}

/** How many statistics reads of each address the stand-in explorer has answered or holds. */
function statisticsReads(explorer: EmptyRegtestExplorer, addresses: readonly string[]): number[] {
  return addresses.map(address => explorer.statisticsRequests(address))
}

/**
 * Locks the wallet and unlocks it in a new page, which forgets every total
 * the background kept. Each account the home screen showed while it was
 * current had its total measured then, fresh for a minute, so without this
 * the switcher would show that total and read nothing.
 */
async function forgetKeptTotals(extension: ExtensionSession, page: Page): Promise<WalletHomePage> {
  await extension.requestWalletController(page, 'lockWallet')
  const unlocking = await extension.openWallet('/main')
  await page.close()
  await new SettingsPage(unlocking).unlock(E2E_PASSWORD)
  const home = new WalletHomePage(unlocking)
  await home.waitUntilReady()
  return home
}

/**
 * The sheet shows `expected`, and gives each total in `exact` (keyed the
 * same way) that exact amount on hover: a total shown to five decimals, such
 * as `<0.00001`, is then also checked to the satoshi.
 */
async function expectTotals(
  sheet: AccountSwitcherSheet,
  expected: Record<string, string>,
  exact: Record<string, string> = {}
) {
  await expect.poll(() => sheet.totalTexts()).toEqual(expected)
  await expect(sheet.pendingTotals).toHaveCount(0)
  await expect.poll(() => sheet.totalExactAmounts()).toMatchObject(exact)
}

test('switch account balances: on an empty chain every row and every wallet total shows 0', async ({
  extension,
}) => {
  const { home, created, restored } = await setUpTwoWallets(extension)
  const sheet = await home.openAccountSwitcher()
  await expectTotals(
    sheet,
    expectedTotals(
      { [created.accounts[0]!.address]: shown(0), [restored.accounts[0]!.address]: shown(0) },
      { [created.key]: shown(0), [restored.key]: shown(0) }
    )
  )
  // The amount follows the account count on the header's count line.
  await expect(sheet.walletHeader(restored.key)).toContainText(shown(0))
  await sheet.close()
})

test('switch account balances: reopened within a minute, the sheet reads no statistics and shows the amounts at once', async ({
  extension,
  explorer,
}) => {
  const { page, created, restored } = await setUpTwoWallets(extension)
  // A second account in each wallet; the last one derived is current. The
  // other three show what the explorer reports for them, which only the
  // switcher reads: the home screen reads the current account alone.
  await extension.requestWalletController(page, 'deriveNewAccountFromMnemonic', [
    created,
    'Savings',
  ])
  await extension.requestWalletController(page, 'deriveNewAccountFromMnemonic', [
    await walletKeyring(extension, page, restored.key),
    'Spending',
  ])
  const savings = (await walletKeyring(extension, page, created.key)).accounts[1]!
  const spending = (await walletKeyring(extension, page, restored.key)).accounts[1]!
  const first = created.accounts[0]!.address
  const restoredFirst = restored.accounts[0]!.address
  explorer.reportFunds(first, 150_000_000)
  explorer.reportFunds(savings.address, 25_000_000)
  explorer.reportFunds(restoredFirst, 1)
  const home = await forgetKeptTotals(extension, page)
  await home.expectCurrentAccount({ walletName: 'Wallet 2', address: spending.address })
  const others = [first, savings.address, restoredFirst]
  const expected = expectedTotals(
    {
      [first]: shown(150_000_000),
      [savings.address]: shown(25_000_000),
      [restoredFirst]: shown(1),
      [spending.address]: shown(0),
    },
    { [created.key]: shown(175_000_000), [restored.key]: shown(1) }
  )
  // `<0.00001` would read the same for 2 to 999 sats: the hover text says 1.
  const exact = expectedTotals(
    { [restoredFirst]: switcherExactAmount(1, REGTEST_UNIT) },
    { [restored.key]: switcherExactAmount(1, REGTEST_UNIT) }
  )

  // The first opening reads the statistics of each account once.
  const beforeFirst = statisticsReads(explorer, others)
  // Before the reads begin, so the time checked below is never less than
  // the time since their answers arrived.
  const openedAt = Date.now()
  let sheet = await home.openAccountSwitcher()
  await expectTotals(sheet, expected, exact)
  expect(statisticsReads(explorer, others)).toEqual(beforeFirst.map(count => count + 1))
  await sheet.close()

  // From here on no statistics read of those accounts would get an answer,
  // so an amount on screen is one the background kept. Opened again in the
  // same page, and in a new page, as reopening the popup does, whose store
  // starts empty: the amounts show, and no read reached the explorer.
  const releases = others.map(address => explorer.holdStatistics(address))
  try {
    sheet = await home.openAccountSwitcher()
    await expectTotals(sheet, expected, exact)
    await sheet.close()
    const reopened = await reopenWallet(extension, home.page)
    sheet = await reopened.openAccountSwitcher()
    await expectTotals(sheet, expected, exact)
    expect(Date.now() - openedAt).toBeLessThan(60_000)
    expect(statisticsReads(explorer, others)).toEqual(beforeFirst.map(count => count + 1))
    await sheet.close()
  } finally {
    for (const release of releases) release()
  }
})

test('switch account balances: with balances hidden every row and wallet total shows **** and nothing is read', async ({
  extension,
  explorer,
}) => {
  const { page, created, restored } = await setUpTwoWallets(extension)
  const other = created.accounts[0]!.address
  const current = restored.accounts[0]!.address
  const home = await forgetKeptTotals(extension, page)
  await home.setBalancesHidden(true)

  const before = explorer.statisticsRequests(other)
  let sheet = await home.openAccountSwitcher()
  await expectTotals(
    sheet,
    expectedTotals(
      { [other]: '****', [current]: '****' },
      { [created.key]: '****', [restored.key]: '****' }
    )
  )
  await sheet.close()
  expect(explorer.statisticsRequests(other)).toBe(before)

  // Shown again, the sheet reads the account, as the count would have shown above.
  await home.setBalancesHidden(false)
  sheet = await home.openAccountSwitcher()
  await expectTotals(
    sheet,
    expectedTotals(
      { [other]: shown(0), [current]: shown(0) },
      { [created.key]: shown(0), [restored.key]: shown(0) }
    )
  )
  expect(explorer.statisticsRequests(other)).toBe(before + 1)
  await sheet.close()
})

test('switch account balances: at the popup width a long name and a large amount fit on a row and a wallet header', async ({
  extension,
  explorer,
}) => {
  const { home: setUpHome, created, restored } = await setUpTwoWallets(extension)
  const largeAccount = restored.accounts[0]!.address
  const smallAccount = created.accounts[0]!.address
  // The restored wallet carries the "recovered" tag. With the other wallet
  // current, the explorer's report is all the switcher reads of its account:
  // the largest supply a total can hold, 20,999,999.99999999 coins, which it
  // shows as 20,999,999.99999.
  await setUpHome.switchAccount(smallAccount)
  const largeSats = 2_099_999_999_999_999
  explorer.reportFunds(largeAccount, largeSats)
  const home = await forgetKeptTotals(extension, setUpHome.page)
  const page = home.page

  const viewport = page.viewportSize()
  await page.setViewportSize({ width: 357, height: 600 })
  try {
    const sheet = await home.openAccountSwitcher()
    // The longest names there can be: 20 characters each.
    await sheet.renameWallet(restored.key, 'Emergency Fund Vault')
    await sheet.renameAccount(largeAccount, 'Mortgage Overpayment')
    await expectTotals(
      sheet,
      expectedTotals(
        { [largeAccount]: shown(largeSats), [smallAccount]: shown(0) },
        { [created.key]: shown(0), [restored.key]: shown(largeSats) }
      )
    )
    await sheet.accountRow(largeAccount).scrollIntoViewIfNeeded()

    // The row: the name, then the amount, whole, then the "..." button,
    // none over another, on a row at least 52 px high.
    const amount = sheet.accountBalance(largeAccount)
    expect(await cutOff(amount)).toBe(0)
    const amountBox = await box(amount)
    const nameBox = await box(sheet.accountName(largeAccount))
    const rowMenuBox = await box(sheet.accountMenuButton(largeAccount))
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(amountBox.x + 0.5)
    expect(amountBox.x + amountBox.width).toBeLessThanOrEqual(rowMenuBox.x + 0.5)
    expect((await box(sheet.accountRow(largeAccount))).height).toBeGreaterThanOrEqual(52)

    // The header: the name and its tag, the count line with the total,
    // whole, and the "+" and "..." buttons after them, 48 px high.
    const total = sheet.walletTotal(restored.key)
    expect(await cutOff(total)).toBe(0)
    const totalBox = await box(total)
    const tagBox = await box(sheet.walletTag(restored.key, 'recovered'))
    const walletNameBox = await box(sheet.walletName(restored.key))
    const actionsLeft = (await box(sheet.addAccountButton(restored.key))).x
    expect(walletNameBox.x + walletNameBox.width).toBeLessThanOrEqual(tagBox.x + 0.5)
    expect(tagBox.x + tagBox.width).toBeLessThanOrEqual(actionsLeft + 0.5)
    expect(totalBox.x + totalBox.width).toBeLessThanOrEqual(actionsLeft + 0.5)
    expect(totalBox.y).toBeGreaterThanOrEqual(walletNameBox.y + walletNameBox.height - 0.5)
    expect((await box(sheet.walletHeader(restored.key))).height).toBeCloseTo(48, 0)
    expect((await box(sheet.walletHeader(created.key))).height).toBeCloseTo(48, 0)
    await sheet.close()
  } finally {
    if (viewport) await page.setViewportSize(viewport)
  }
})

/** A message of the built extension in the browser's language (en), with `$1`... filled in. */
function message(key: string, substitutions: string[] = []): string {
  const messages = JSON.parse(
    readFileSync(resolve(extensionDist, '_locales/en/messages.json'), 'utf8')
  ) as Record<string, { message: string }>
  const text = messages[key]?.message
  if (text === undefined) throw new Error(`the extension has no message ${key}`)
  return text.replace(/\$(\d)/g, (_, index: string) => substitutions[Number(index) - 1] ?? '')
}

test('switch account balances: statistics reads that fail with nothing measured before show -- on the row and the wallet total', async ({
  extension,
  explorer,
}) => {
  const { page, created, restored } = await setUpTwoWallets(extension)
  const other = created.accounts[0]!.address
  const current = restored.accounts[0]!.address
  explorer.failStatistics(other)
  // A new page, whose store holds nothing, and a background that forgot what
  // it measured: nothing was measured before the failing reads.
  const home = await forgetKeptTotals(extension, page)
  const before = explorer.statisticsRequests(other)
  const sheet = await home.openAccountSwitcher()
  await expectTotals(
    sheet,
    expectedTotals(
      { [other]: '--', [current]: shown(0) },
      { [created.key]: '--', [restored.key]: shown(0) }
    )
  )
  // The read reached the explorer and failed; nothing stale is shown.
  expect(explorer.statisticsRequests(other)).toBeGreaterThan(before)
  await expect(sheet.root.locator('[data-stale="true"]')).toHaveCount(0)
  await expect(sheet.walletTotalStaleNote(created.key)).toHaveCount(0)
  await sheet.close()
})

test('switch account balances: reads that fail after an earlier total show it dimmed, said to be out of date', async ({
  extension,
  explorer,
}) => {
  const { page, created, restored } = await setUpTwoWallets(extension)
  const other = created.accounts[0]!.address
  const current = restored.accounts[0]!.address
  explorer.reportFunds(other, 150_000_000)
  let home = await forgetKeptTotals(extension, page)
  let sheet = await home.openAccountSwitcher()
  await expectTotals(
    sheet,
    expectedTotals(
      { [other]: shown(150_000_000), [current]: shown(0) },
      { [created.key]: shown(150_000_000), [restored.key]: shown(0) }
    )
  )
  // The row's name says the exact amount, which the row shows to five decimals.
  const label = (stale: boolean) =>
    message(
      stale
        ? 'account_switcher_account_balance_stale_label'
        : 'account_switcher_account_balance_label',
      ['Account 1', 'Wallet 1', shortAddress(other), switcherExactAmount(150_000_000, REGTEST_UNIT)]
    )
  await expect(sheet.accountRow(other)).toHaveAccessibleName(label(false))
  await sheet.close()

  // A lock in this page: the background forgets the total and reads it again
  // at the next opening, and that read fails; the page keeps what it showed.
  explorer.failStatistics(other)
  await extension.requestWalletController(home.page, 'lockWallet')
  await new SettingsPage(home.page).unlock(E2E_PASSWORD)
  home = new WalletHomePage(home.page)
  await home.waitUntilReady()
  const before = explorer.statisticsRequests(other)
  sheet = await home.openAccountSwitcher()
  await expect(sheet.accountBalance(other)).toHaveAttribute('data-stale', 'true')
  await expect(sheet.accountBalance(other)).toHaveText(shown(150_000_000))
  await expect(sheet.walletTotal(created.key)).toHaveAttribute('data-stale', 'true')
  await expect(sheet.walletTotal(created.key)).toHaveText(shown(150_000_000))
  await expect(sheet.walletTotalStaleNote(created.key)).toHaveText(
    message('account_switcher_total_stale_note')
  )
  await expect(sheet.accountRow(other)).toHaveAccessibleName(label(true))
  expect(explorer.statisticsRequests(other)).toBeGreaterThan(before)
  // The accounts that read well are not dimmed.
  await expect(sheet.accountBalance(current)).not.toHaveAttribute('data-stale', 'true')
  await expect(sheet.walletTotal(restored.key)).not.toHaveAttribute('data-stale', 'true')
  await expect(sheet.walletTotalStaleNote(restored.key)).toHaveCount(0)
  await sheet.close()
})
