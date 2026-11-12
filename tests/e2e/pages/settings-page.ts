import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

export class SettingsPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get unlockPasswordInput(): Locator {
    return this.byTestId('unlock-password-input')
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings')
    await expect(this.page.getByText('Settings', { exact: true }).first()).toBeVisible()
    await expect(this.byTestId('settings_connectedSites')).toBeVisible()
  }

  async openConnectedSites(): Promise<void> {
    await this.clickTestId('settings_connectedSites')
    await this.waitForHashRoute('/connected-sites')
  }

  async openAdvanced(): Promise<void> {
    await this.clickTestId('settings_advanced')
    await this.waitForHashRoute('/settings/advanced')
    await expect(this.page.getByText('Change Password', { exact: true })).toBeVisible()
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

  async submitWrongPassword(password: string): Promise<void> {
    await this.waitForUnlock()
    await this.unlockPasswordInput.fill(password)
    await this.clickTestId('unlock-button')
    await expect(this.page.getByText('Password is incorrect', { exact: true })).toBeVisible()
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
