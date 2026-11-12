import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'
import { SecurityPage } from './security-page'

/** The theme modes Settings → Appearance offers. */
export type ThemeMode = 'light' | 'dark' | 'system'

const ITEM_PREFIX = 'settings_'

export class SettingsPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get unlockPasswordInput(): Locator {
    return this.byTestId('unlock-password-input')
  }

  /** Settings, in any language: its rows have test IDs, its title does not. */
  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings')
    await expect(this.byTestId('settings_connectedSites')).toBeVisible()
    await expect(this.byTestId('settings_lockwallet')).toBeVisible()
  }

  /** The rows Settings shows, in order, by the names their test IDs give them. */
  async items(): Promise<string[]> {
    const testIds = await this.page
      .locator(`[data-testid^="${ITEM_PREFIX}"]`)
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-testid') ?? ''))
    return testIds.map(testId => testId.slice(ITEM_PREFIX.length))
  }

  item(name: string): Locator {
    return this.byTestId(`${ITEM_PREFIX}${name}`)
  }

  async openConnectedSites(): Promise<void> {
    await this.clickTestId('settings_connectedSites')
    await this.waitForHashRoute('/connected-sites')
  }

  async openAdvanced(): Promise<void> {
    await this.clickTestId('settings_advanced')
    await this.waitForHashRoute('/settings/advanced')
    await expect(this.page.getByText('Automatic Lock Time', { exact: true })).toBeVisible()
  }

  /** Settings → Security, where Change Password lives. */
  async openSecurity(): Promise<SecurityPage> {
    await this.clickTestId('settings_security')
    const security = new SecurityPage(this.page)
    await security.waitUntilReady()
    return security
  }

  /** Settings → Address Book. */
  async openAddressBook(): Promise<void> {
    await this.clickTestId('settings_addressBook')
    await this.waitForHashRoute('/settings/contacts')
  }

  /** Settings → Appearance, then one theme mode, which applies at once. */
  async chooseTheme(mode: ThemeMode): Promise<void> {
    await this.clickTestId('settings_appearance')
    await this.waitForHashRoute('/settings/appearance')
    await this.clickTestId(`appearance-option-${mode}`)
    if (mode !== 'system') await this.expectTheme(mode)
    await this.clickTestId('header-back-button')
    await this.waitUntilReady()
  }

  /** The theme the page is painted in. */
  async expectTheme(theme: 'light' | 'dark'): Promise<void> {
    await expect(this.page.locator('html')).toHaveAttribute('data-theme', theme)
  }

  /**
   * The language screen, which the globe in the Settings header opens, then
   * one language by the name the list gives it; the screen then goes back.
   */
  async chooseLanguage(languageName: string): Promise<void> {
    await this.waitUntilReady()
    await this.page.evaluate(() => {
      window.location.hash = '#/settings/language'
    })
    await this.waitForHashRoute('/settings/language')
    await this.page.getByText(languageName, { exact: true }).click()
    await this.waitUntilReady()
  }

  /**
   * Turns developer mode on from About, as a user does: ten taps on the
   * version, each within 500 ms of the last. The taps are raw clicks about
   * 120 ms apart, as locator clicks can be slower than that on a busy host. A
   * missed round is tapped again only once the label shows the mode is still
   * off, so the mode is never toggled twice.
   */
  async enableDeveloperMode(): Promise<void> {
    await this.page.evaluate(() => {
      window.location.hash = '#/settings/about-us'
    })
    await this.waitForHashRoute('/settings/about-us')
    const version = this.page.getByText(/^Version: /)
    await expect(async () => {
      if (!/\(Dev\)$/.test((await version.innerText()).trim())) {
        const box = await version.boundingBox()
        if (!box) throw new Error('the version label is not visible')
        for (let tap = 0; tap < 10; tap += 1) {
          await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          await this.page.waitForTimeout(120)
        }
      }
      await expect(version).toHaveText(/\(Dev\)$/, { timeout: 5_000 })
    }).toPass({ timeout: 60_000 })
  }

  async lockWallet(): Promise<void> {
    await this.waitUntilReady()
    await this.clickTestId('settings_lockwallet')
    await this.waitForUnlock()
  }

  async waitForUnlock(): Promise<void> {
    await this.waitForHashRoute('/account/unlock')
    await expect(this.unlockPasswordInput).toBeVisible()
  }

  /** `refusal` is what the wallet says, in the language it is in. */
  async submitWrongPassword(password: string, refusal = 'Password is incorrect'): Promise<void> {
    await this.waitForUnlock()
    await this.unlockPasswordInput.fill(password)
    await this.clickTestId('unlock-button')
    await expect(this.page.getByText(refusal, { exact: true })).toBeVisible()
    await expect(this.unlockPasswordInput).toBeVisible()
  }

  /**
   * Unlocks and waits for the route the unlock leads to: Home, unless a lock
   * took the page from a send form it showed unlocked, which comes back.
   */
  async unlock(password: string, route = '/main'): Promise<void> {
    await this.waitForUnlock()
    await this.unlockPasswordInput.fill(password)
    await this.clickTestId('unlock-button')
    await this.waitForHashRoute(route)
  }
}
