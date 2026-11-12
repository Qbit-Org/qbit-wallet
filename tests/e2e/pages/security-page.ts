import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'
import { ChangePasswordPage } from './change-password-page'
import { RecoveryPhrasePage } from './recovery-phrase-page'
import { ResetWalletDialog } from './reset-wallet-dialog'

/** The rows of Settings → Security, by the names their test IDs give them. */
export type SecurityItem = 'changePassword' | 'showSeedPhrase' | 'resetWallet'

const ITEM_PREFIX = 'security_'

/** Settings → Security. */
export class SecurityPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  item(name: SecurityItem): Locator {
    return this.byTestId(`${ITEM_PREFIX}${name}`)
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings/security')
    await expect(this.item('changePassword')).toBeVisible()
    await expect(this.item('resetWallet')).toBeVisible()
  }

  /** The rows the screen shows, in order. */
  async items(): Promise<string[]> {
    const testIds = await this.page
      .locator(`[data-testid^="${ITEM_PREFIX}"]`)
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-testid') ?? ''))
    return testIds.map(testId => testId.slice(ITEM_PREFIX.length))
  }

  async openChangePassword(): Promise<ChangePasswordPage> {
    await this.clickTestId(`${ITEM_PREFIX}changePassword`)
    const screen = new ChangePasswordPage(this.page)
    await screen.waitUntilReady()
    return screen
  }

  async openRecoveryPhrase(): Promise<RecoveryPhrasePage> {
    await this.clickTestId(`${ITEM_PREFIX}showSeedPhrase`)
    const screen = new RecoveryPhrasePage(this.page)
    await screen.waitUntilReady()
    return screen
  }

  async openResetWallet(): Promise<ResetWalletDialog> {
    await this.clickTestId(`${ITEM_PREFIX}resetWallet`)
    const dialog = new ResetWalletDialog(this.page)
    await dialog.waitUntilOpen()
    return dialog
  }
}
