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

  async unlock(password: string): Promise<void> {
    await this.waitForUnlock()
    await this.unlockPasswordInput.fill(password)
    await this.clickTestId('unlock-button')
    await this.waitForHashRoute('/main')
  }
}
