import type { Page } from '@playwright/test'

import { OnboardingPage, SettingsPage, WalletHomePage } from '../pages'
import { expect, test } from '../fixtures/test'
import { attachVirtualTouchId } from '../support/webauthn'
import { E2E_PASSWORD } from '../support/wallet-setup'

const NEW_PASSWORD = 'Qbit-E2E-Changed!42'
const MAIN_ROUTE = /#\/main(?:$|\?)/

async function gotoHashRoute(page: Page, route: string): Promise<void> {
  await page.goto(page.url().replace(/#.*$/, '') + `#${route}`, {
    waitUntil: 'domcontentloaded',
  })
}

/**
 * The extension auto-opens its own welcome tab a few seconds after install.
 * A background tab activation mid-ceremony makes Chrome reject WebAuthn with
 * a focus error, so wait it out and close every page except the test's own.
 */
async function closeAutoOpenedTabs(
  extension: { context: import('@playwright/test').BrowserContext },
  keep: Page
): Promise<void> {
  await keep.waitForTimeout(5_000)
  for (const page of extension.context.pages()) {
    if (page !== keep) await page.close().catch(() => {})
  }
  await keep.bringToFront()
}

async function openAdvancedSettings(page: Page): Promise<void> {
  await gotoHashRoute(page, '/settings/advanced')
  await expect(page.getByText('Change Password', { exact: true })).toBeVisible()
}

test('B1 biometric: onboarding enrollment, TouchID unlock, and password-change re-wrap', async ({
  extension,
}) => {
  test.setTimeout(240_000)

  // The virtual authenticator must exist before the onboarding Touch ID step
  // renders, and every ceremony must run on this same page target.
  const page = await extension.openWallet('/welcome')
  await attachVirtualTouchId(page)
  await closeAutoOpenedTabs(extension, page)

  const onboarding = new OnboardingPage(page)
  await onboarding.createNewWallet(E2E_PASSWORD, '', 'enable')
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.switchToRegtest()

  // Settings → Security reflects the enrollment made during onboarding.
  await openAdvancedSettings(page)
  await expect(page.getByTestId('touch-id-settings-row')).toContainText('On')

  // Manual lock must not auto-prompt (navToLock passes autoUnlockByFace:
  // false), but the TouchID button is offered.
  await gotoHashRoute(page, '/main')
  await home.waitUntilReady()
  await home.openSettings()
  const settings = new SettingsPage(page)
  await settings.lockWallet()
  const touchIdButton = page.getByTestId('unlock-touch-id-button')
  await expect(touchIdButton).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(page.getByTestId('unlock-password-input')).toBeVisible()

  // Explicit TouchID unlock. The ceremony requires the active tab.
  await page.bringToFront()
  await touchIdButton.click()
  await expect(page).toHaveURL(MAIN_ROUTE)
  await home.waitUntilReady()

  // The popup-open path (root route → BoostScreen) redirects to the unlock
  // screen with autoUnlockByFace: true, which auto-prompts TouchID and
  // unlocks hands-free.
  await home.openSettings()
  await settings.lockWallet()
  // Activate the tab before navigating so the auto-prompt ceremony fires
  // with the tab already active.
  await page.bringToFront()
  await gotoHashRoute(page, '/')
  await expect(page.getByTestId('receive-button')).toBeVisible({ timeout: 30_000 })
  await home.waitUntilReady()

  // Password change invalidates the old wrapped record inside the keyring
  // mutex and immediately re-wraps the new password under the same passkey.
  await gotoHashRoute(page, '/settings/password')
  await page.getByTestId('current-password-input').fill(E2E_PASSWORD)
  await page.getByTestId('new-password-input').fill(NEW_PASSWORD)
  await page.getByTestId('confirm-password-input').fill(NEW_PASSWORD)
  await page.getByTestId('change-password-confirm-button').click()
  await expect(page).toHaveURL(MAIN_ROUTE, { timeout: 20_000 })
  await home.waitUntilReady()

  // TouchID unlock works against the re-wrapped record (i.e. the new
  // password), proving the old blob did not survive the change.
  await home.openSettings()
  await settings.lockWallet()
  await page.bringToFront()
  await page.getByTestId('unlock-touch-id-button').click()
  await expect(page).toHaveURL(MAIN_ROUTE)
  await home.waitUntilReady()
})

test('B2 biometric: settings enrollment with step-up, persistence across restart, and disable', async ({
  extension,
}) => {
  test.setTimeout(240_000)

  const page = await extension.openWallet('/welcome')
  await attachVirtualTouchId(page)
  await closeAutoOpenedTabs(extension, page)

  // Onboarding offers the step and it is skippable.
  const onboarding = new OnboardingPage(page)
  await onboarding.chooseCreateWallet()
  await onboarding.createPasswordInput.fill(E2E_PASSWORD)
  await onboarding.confirmPasswordInput.fill(E2E_PASSWORD)
  await page.getByTestId('create-password-continue-button').click()
  await expect(page.getByTestId('enable-touch-id-title')).toBeVisible()
  await page.getByTestId('skip-touch-id-button').click()
  const words = await onboarding.readGeneratedMnemonic()
  await onboarding.acceptGeneratedMnemonic(words)
  await onboarding.submitAddressType()
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.switchToRegtest()

  // Enroll from Settings → Security with the wallet password as step-up.
  await openAdvancedSettings(page)
  const settingsRow = page.getByTestId('touch-id-settings-row')
  await expect(settingsRow).toContainText('Off')
  await settingsRow.click()
  await expect(page.getByTestId('touch-id-password-input')).toBeVisible()
  await page.getByTestId('touch-id-password-input').fill(E2E_PASSWORD)
  await page.bringToFront()
  await page.getByTestId('enable-touch-id-button').click()
  await expect(page.getByTestId('touch-id-status')).toHaveText('On')

  // The wrapped record survives a full browser restart. The virtual
  // authenticator (and its credential) does not, so the auto-prompt fails
  // silently and unlock degrades gracefully to the password while still
  // offering the TouchID button.
  await extension.restart()
  const restartedPage = await extension.context.newPage()
  await attachVirtualTouchId(restartedPage)
  await restartedPage.goto(
    `chrome-extension://${extension.extensionId}/index.html#/main`,
    { waitUntil: 'domcontentloaded' }
  )
  const restartedSettings = new SettingsPage(restartedPage)
  await restartedSettings.waitForUnlock()
  await expect(restartedPage.getByTestId('unlock-touch-id-button')).toBeVisible()
  // Let the failed auto-prompt settle so its loading guard cannot swallow the
  // password unlock click.
  await restartedPage.waitForTimeout(1_500)
  await restartedSettings.unlock(E2E_PASSWORD)
  const restartedHome = new WalletHomePage(restartedPage)
  await restartedHome.waitUntilReady()

  // Disable from settings; the unlock screen stops offering TouchID.
  await openAdvancedSettings(restartedPage)
  await expect(restartedPage.getByTestId('touch-id-settings-row')).toContainText('On')
  await restartedPage.getByTestId('touch-id-settings-row').click()
  await restartedPage.getByTestId('disable-touch-id-button').click()
  await expect(restartedPage.getByTestId('touch-id-password-input')).toBeVisible()
  await openAdvancedSettings(restartedPage)
  await expect(restartedPage.getByTestId('touch-id-settings-row')).toContainText('Off')

  await gotoHashRoute(restartedPage, '/main')
  await restartedHome.waitUntilReady()
  await restartedHome.openSettings()
  await restartedSettings.lockWallet()
  await expect(restartedPage.getByTestId('unlock-password-input')).toBeVisible()
  await expect(restartedPage.getByTestId('unlock-touch-id-button')).toBeHidden()
})
