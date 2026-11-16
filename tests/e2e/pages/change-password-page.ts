import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/** Change Password, which Settings → Security opens. */
export class ChangePasswordPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get currentPasswordInput(): Locator {
    return this.byTestId('current-password-input')
  }

  get newPasswordInput(): Locator {
    return this.byTestId('new-password-input')
  }

  get confirmPasswordInput(): Locator {
    return this.byTestId('confirm-password-input')
  }

  get confirmButton(): Locator {
    return this.byTestId('change-password-confirm-button')
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings/password')
    await expect(this.currentPasswordInput).toBeVisible()
  }

  /** The header's Back. */
  async back(): Promise<void> {
    await this.clickTestId('header-back-button')
  }

  /** Changes the password; the screen then opens the home screen. */
  async change(currentPassword: string, newPassword: string): Promise<void> {
    await this.currentPasswordInput.fill(currentPassword)
    await this.newPasswordInput.fill(newPassword)
    await this.confirmPasswordInput.fill(newPassword)
    // A disabled button ignores clicks; it shows the not-allowed cursor.
    await expect(this.confirmButton).not.toHaveCSS('cursor', 'not-allowed')
    await this.confirmButton.click()
    await this.waitForHashRoute('/main')
  }
}
