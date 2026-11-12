import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/**
 * The Reset Wallet dialog: Settings → Security → Reset Wallet, and Remove
 * Wallet on the last wallet in the account switcher. Nothing is sent to the
 * background before its Reset Wallet button is pressed.
 */
export class ResetWalletDialog extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get root(): Locator {
    return this.byTestId('reset-wallet-dialog')
  }

  get passwordInput(): Locator {
    return this.byTestId('reset-wallet-password-input')
  }

  get confirmButton(): Locator {
    return this.byTestId('reset-wallet-confirm-button')
  }

  get cancelButton(): Locator {
    return this.byTestId('reset-wallet-cancel-button')
  }

  /** The refusal shown under the password, such as a wrong password. */
  get error(): Locator {
    return this.byTestId('reset-wallet-error')
  }

  /** The line the account switcher adds when the wallet to remove is the last one. */
  get lastWalletNote(): Locator {
    return this.byTestId('reset-wallet-last-wallet')
  }

  async waitUntilOpen(): Promise<void> {
    await expect(this.root).toBeVisible()
    await expect(this.passwordInput).toBeVisible()
  }

  async waitUntilClosed(): Promise<void> {
    await expect(this.root).toHaveCount(0)
  }

  async enterPassword(password: string): Promise<void> {
    await this.passwordInput.fill(password)
    await expect(this.passwordInput).toHaveValue(password)
  }

  /** Types `password` in place of what is there and presses Reset Wallet. */
  async submit(password: string): Promise<void> {
    await this.enterPassword(password)
    await expect(this.confirmButton).toBeEnabled()
    await this.confirmButton.click()
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click()
    await this.waitUntilClosed()
  }
}
