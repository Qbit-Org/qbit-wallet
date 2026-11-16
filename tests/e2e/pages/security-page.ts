import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'
import { ChangePasswordPage } from './change-password-page'
import { RecoveryPhrasePage } from './recovery-phrase-page'
import { ResetWalletDialog } from './reset-wallet-dialog'

/** What Settings → Security lists, top to bottom, by name. */
export type SecurityItem =
  | 'changePassword'
  | 'touchId'
  | 'showSeedPhrase'
  | 'autoLockTime'
  | 'lockOnComputerLock'
  | 'lockOnWindowsClosed'
  | 'phishingProtection'
  | 'resetWallet'

/**
 * Each entry's test ID. Touch ID, the two lock switches and the phishing card
 * keep the IDs they had when Advanced Settings listed them.
 */
const ITEM_TEST_IDS: Record<SecurityItem, string> = {
  changePassword: 'security_changePassword',
  touchId: 'touch-id-settings-row',
  showSeedPhrase: 'security_showSeedPhrase',
  autoLockTime: 'security_autoLockTime',
  lockOnComputerLock: 'lock-on-computer-lock-row',
  lockOnWindowsClosed: 'lock-on-windows-closed-row',
  phishingProtection: 'phishing-protection-card',
  resetWallet: 'security_resetWallet',
}

/** Settings → Security. */
export class SecurityPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  item(name: SecurityItem): Locator {
    return this.byTestId(ITEM_TEST_IDS[name])
  }

  /** The state the phishing card reports, such as "Fully on". */
  get phishingProtectionState(): Locator {
    return this.byTestId('phishing-protection-state')
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings/security')
    await expect(this.item('changePassword')).toBeVisible()
    await expect(this.item('resetWallet')).toBeVisible()
  }

  /**
   * Everything the screen lists, in order: each child of its one list, by
   * name, so a row this page object does not know shows up as well.
   */
  async items(): Promise<string[]> {
    const testIds = await this.item('changePassword')
      .locator('xpath=..')
      .locator(':scope > *')
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-testid') ?? ''))
    const names = new Map(Object.entries(ITEM_TEST_IDS).map(([name, testId]) => [testId, name]))
    return testIds.map(testId => names.get(testId) ?? `unlisted entry "${testId}"`)
  }

  async openChangePassword(): Promise<ChangePasswordPage> {
    await this.clickTestId(ITEM_TEST_IDS.changePassword)
    const screen = new ChangePasswordPage(this.page)
    await screen.waitUntilReady()
    return screen
  }

  async openRecoveryPhrase(): Promise<RecoveryPhrasePage> {
    await this.clickTestId(ITEM_TEST_IDS.showSeedPhrase)
    const screen = new RecoveryPhrasePage(this.page)
    await screen.waitUntilReady()
    return screen
  }

  /** The Touch ID Unlock screen, which the row opens where the browser can do Touch ID. */
  async openTouchId(): Promise<void> {
    await this.clickTestId(ITEM_TEST_IDS.touchId)
    await this.waitForHashRoute('/settings/biometric')
  }

  /** The Automatic Lock Time screen. */
  async openLockTime(): Promise<void> {
    await this.clickTestId(ITEM_TEST_IDS.autoLockTime)
    await this.waitForHashRoute('/settings/lock-time')
  }

  async openResetWallet(): Promise<ResetWalletDialog> {
    await this.clickTestId(ITEM_TEST_IDS.resetWallet)
    const dialog = new ResetWalletDialog(this.page)
    await dialog.waitUntilOpen()
    return dialog
  }
}
