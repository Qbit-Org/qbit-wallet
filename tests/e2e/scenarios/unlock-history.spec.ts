import type { Page } from '@playwright/test'

import { SendPage, SettingsPage, WalletHomePage } from '../pages'
import { expect, test } from '../fixtures/test'
import type { ExtensionSession } from '../support/extension-session'
import { E2E_PASSWORD, onboardNewRegtestWallet } from '../support/wallet-setup'

const UNLOCK_ROUTE = /#\/account\/unlock(?:$|\?)/
const SETTINGS_ROUTE = /#\/settings(?:$|\?)/
// The page a tab showed before the wallet was opened in it.
const BEFORE_WALLET = 'data:text/html,<title>Before the wallet</title>'
// The issue's reproduction pressed Back four times, 1.5 s apart: long enough
// for a screen reached by Back to send the page on again.
const BACK_PRESSES = 4
const BACK_INTERVAL_MS = 1_500

/** Every address the tab's main frame commits from now on, same-document steps included. */
function recordAddresses(page: Page): string[] {
  const addresses: string[] = []
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) addresses.push(frame.url())
  })
  return addresses
}

const historyLength = (page: Page) => page.evaluate(() => window.history.length)

/**
 * Opens `index.html` in a new tab on top of another page, as the issue does,
 * and returns the tab with its history length once the wallet's entry is in.
 * The wallet exists when the page loads, so the page knows of the vault from
 * its first render, as a user's tab does, and Layout sends it to the unlock
 * screen on a lock.
 */
async function openWalletTab(extension: ExtensionSession) {
  const page = await extension.context.newPage()
  await page.goto(BEFORE_WALLET)
  await page.goto(`chrome-extension://${extension.extensionId}/index.html`, {
    waitUntil: 'domcontentloaded',
  })
  return { page, openedLength: await historyLength(page) }
}

/**
 * Presses Back the issue's way from Home, the wallet's only entry in the tab:
 * the first press shows the page before the wallet, and no press shows a
 * wallet screen again, neither the unlock screen nor Home.
 */
async function expectBackLeavesTheWallet(page: Page): Promise<void> {
  const shown = recordAddresses(page)
  for (let press = 0; press < BACK_PRESSES; press += 1) {
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForTimeout(BACK_INTERVAL_MS)
  }
  expect(shown[0]).toBe(BEFORE_WALLET)
  expect(shown.filter(address => address.startsWith('chrome-extension://'))).toEqual([])
}

test('G3 unlock history: an unlock in a tab opened locked leaves Home alone in the history, and Back leaves the wallet', async ({
  extension,
}) => {
  const setup = await onboardNewRegtestWallet(extension)
  await extension.requestWalletController<void>(setup.page, 'lockWallet')

  const { page, openedLength } = await openWalletTab(extension)
  const settings = new SettingsPage(page)
  await settings.unlock(E2E_PASSWORD)
  await new WalletHomePage(page).waitUntilReady()
  // The start screen, then the unlock screen, each gave its entry to the next.
  // Soft, so that a failure also shows what Back does.
  expect.soft(await historyLength(page)).toBe(openedLength)

  await expectBackLeavesTheWallet(page)
})

test('G3 unlock history: Back from Home in a tab opened unlocked leaves the wallet', async ({
  extension,
}) => {
  await onboardNewRegtestWallet(extension)

  const { page, openedLength } = await openWalletTab(extension)
  await new WalletHomePage(page).waitUntilReady()
  expect.soft(await historyLength(page)).toBe(openedLength)

  await expectBackLeavesTheWallet(page)
})

test('G3 unlock history: after a lock from Settings, the unlock puts Home in the unlock screen’s place', async ({
  extension,
}) => {
  await onboardNewRegtestWallet(extension)

  const { page } = await openWalletTab(extension)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.openSettings()
  const settings = new SettingsPage(page)
  await settings.waitUntilReady()
  const settingsLength = await historyLength(page)

  await settings.lockWallet()
  await settings.unlock(E2E_PASSWORD)
  await home.waitUntilReady()
  // Settings, then Home in place of the unlock screen.
  expect.soft(await historyLength(page)).toBe(settingsLength + 1)

  const shown = recordAddresses(page)
  await page.goBack({ waitUntil: 'commit' })
  await expect(page).toHaveURL(SETTINGS_ROUTE)
  await settings.waitUntilReady()
  // The issue's window for a screen reached by Back to send the page on.
  await page.waitForTimeout(BACK_INTERVAL_MS)
  await expect(page).toHaveURL(SETTINGS_ROUTE)
  expect(shown.filter(address => UNLOCK_ROUTE.test(address))).toEqual([])
})

test('G3 unlock history: Home’s lock button leaves one unlock entry, and the unlock puts Home back', async ({
  extension,
}) => {
  await onboardNewRegtestWallet(extension)

  const { page, openedLength } = await openWalletTab(extension)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  const settings = new SettingsPage(page)
  await page.getByTestId('lock-wallet-button').click()
  await settings.waitForUnlock()
  // The unlock screen took Home's place. Soft, so that a failure also shows
  // what the unlock and Back do.
  expect.soft(await historyLength(page)).toBe(openedLength)

  await settings.unlock(E2E_PASSWORD)
  await home.waitUntilReady()
  // Home is back where it was, and Back does what it did before the lock.
  expect.soft(await historyLength(page)).toBe(openedLength)
  await expectBackLeavesTheWallet(page)
})

test('G3 unlock history: a lock that reaches Home leaves one unlock entry, and the unlock puts Home back', async ({
  extension,
}) => {
  await onboardNewRegtestWallet(extension)

  const { page, openedLength } = await openWalletTab(extension)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  const settings = new SettingsPage(page)
  // Locked from outside the page, as the auto-lock or another window does.
  await extension.requestWalletController<void>(page, 'lockWallet')
  await settings.waitForUnlock()
  expect.soft(await historyLength(page)).toBe(openedLength)

  await settings.unlock(E2E_PASSWORD)
  await home.waitUntilReady()
  expect.soft(await historyLength(page)).toBe(openedLength)
  await expectBackLeavesTheWallet(page)
})

test('G3 unlock history: after a lock on the send form, the unlock shows the form as it was, and Back never shows the unlock screen', async ({
  extension,
}) => {
  const SEND_FORM_ROUTE = /#\/wallet\/tx\/create(?:$|\?)/
  const HOME_ROUTE = /#\/main(?:$|\?)/
  const setup = await onboardNewRegtestWallet(extension)

  const { page } = await openWalletTab(extension)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.openSend()
  const send = new SendPage(page)
  await send.enterTransfer(setup.address, '0.001')
  await send.expandAdvancedMemo('rent')
  const formLength = await historyLength(page)

  // Locked from outside the page, as the auto-lock or another window does.
  await extension.requestWalletController<void>(page, 'lockWallet')
  const settings = new SettingsPage(page)
  await settings.waitForUnlock()
  // The unlock screen came after the form.
  expect.soft(await historyLength(page)).toBe(formLength + 1)

  await settings.unlockPasswordInput.fill(E2E_PASSWORD)
  await page.getByTestId('unlock-button').click()
  await expect(page).toHaveURL(SEND_FORM_ROUTE)
  await expect(send.recipientInput).toHaveValue(setup.address)
  await expect(send.amountInput).toHaveValue('0.001')
  await expect(page.getByTestId('memo-input')).toHaveValue('rent')
  // The form's own entry again, with the unlock screen's after it.
  expect.soft(await historyLength(page)).toBe(formLength + 1)

  const shown = recordAddresses(page)
  await page.goBack({ waitUntil: 'commit' })
  await expect(page).toHaveURL(HOME_ROUTE)
  await home.waitUntilReady()
  // The issue's window for a screen reached by Back to send the page on.
  await page.waitForTimeout(BACK_INTERVAL_MS)
  await expect(page).toHaveURL(HOME_ROUTE)
  expect(shown.filter(address => UNLOCK_ROUTE.test(address))).toEqual([])
})
