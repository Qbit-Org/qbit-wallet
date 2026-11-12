import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/**
 * Show Secret Recovery Phrase: the password step, then the phrase of the
 * wallet the screen was opened for.
 */
export class RecoveryPhrasePage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get passwordInput(): Locator {
    return this.page.locator('input[type="password"]')
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings/export-mnemonics')
    await expect(this.passwordInput).toBeVisible()
  }

  /**
   * The words the screen shows, in order. Each is a single untranslated
   * lowercase word; the derivation path, the only other untranslated text
   * shown with them, has spaces and digits.
   */
  async words(): Promise<string[]> {
    return this.page
      .locator('span[translate="no"]')
      .evaluateAll(spans =>
        spans.map(span => (span.textContent ?? '').trim()).filter(text => /^[a-z]+$/.test(text))
      )
  }

  /** Enters the password; Enter in the field shows the phrase. */
  async reveal(password: string, wordCount: number): Promise<string[]> {
    await this.passwordInput.fill(password)
    await this.passwordInput.press('Enter')
    await expect.poll(async () => (await this.words()).length).toBe(wordCount)
    return this.words()
  }
}
