import { expect, type Locator, type Page } from '@playwright/test'

import {
  AccountSwitcherSheet,
  shortAddress,
  WALLET_TAGS,
  type WalletTag,
} from './account-switcher-sheet'
import { ExtensionPageObject } from './base-page'

export class WalletHomePage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get balanceCard(): Locator {
    return this.byTestId('wallet-balance-card')
  }

  get networkSwitcher(): Locator {
    return this.byTestId('switch-network-bar')
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/main')
    await expect(this.byTestId('receive-button')).toBeVisible()
    await expect(this.balanceCard).toBeVisible()
  }

  async switchToRegtest(): Promise<void> {
    await this.waitUntilReady()
    if ((await this.networkSwitcher.innerText()).includes('Regtest')) return

    await this.networkSwitcher.click()
    await this.clickTestId('chain-item-QBIT_REGTEST')
    await expect(this.networkSwitcher).toContainText('Regtest')
    await expect(this.byTestId('receive-button')).toBeVisible()
  }

  async networkLabel(): Promise<string> {
    return (await this.networkSwitcher.innerText()).trim()
  }

  async balanceText(): Promise<string> {
    await expect(this.balanceCard).toBeVisible()
    return (await this.balanceCard.innerText()).replace(/\s+/g, ' ').trim()
  }

  async openReceive(): Promise<void> {
    await this.clickTestId('receive-button')
    await this.waitForHashRoute('/wallet/receive')
  }

  async openSend(): Promise<void> {
    await this.clickTestId('send-button')
    await this.waitForHashRoute('/wallet/tx/create')
  }

  async openHistory(): Promise<void> {
    await this.clickTestId('history-button')
    await this.waitForHashRoute('/wallet/history')
  }

  /** The account card: which wallet and account are open. A tap opens the account switcher. */
  get accountCard(): Locator {
    return this.byTestId('account-select')
  }

  get cardWalletName(): Locator {
    return this.byTestId('account-select-wallet-name')
  }

  get cardAccountName(): Locator {
    return this.byTestId('account-select-account-name')
  }

  /** The card's short address, which copies the address when tapped. */
  get cardAddress(): Locator {
    return this.byTestId('account-select-copy')
  }

  get cardWalletTile(): Locator {
    return this.byTestId('account-select-wallet-tile')
  }

  cardTag(tag: WalletTag): Locator {
    return this.byTestId(`account-select-tag-${tag}`)
  }

  /** The tags the card shows next to the wallet name. */
  async cardTags(): Promise<WalletTag[]> {
    const tags: WalletTag[] = []
    for (const tag of WALLET_TAGS) {
      if ((await this.cardTag(tag).count()) > 0) tags.push(tag)
    }
    return tags
  }

  /** Waits until the card shows this wallet, account and address. */
  async expectCurrentAccount(expected: {
    walletName?: string
    accountName?: string
    address?: string
  }): Promise<void> {
    if (expected.walletName !== undefined) {
      await expect(this.cardWalletName).toHaveText(expected.walletName)
    }
    if (expected.accountName !== undefined) {
      await expect(this.cardAccountName).toHaveText(expected.accountName)
    }
    if (expected.address !== undefined) {
      await expect(this.cardAddress).toHaveText(shortAddress(expected.address))
    }
  }

  /** Taps the account card, which opens the Switch Account sheet. */
  async openAccountSwitcher(): Promise<AccountSwitcherSheet> {
    await expect(this.accountCard).toBeVisible()
    await this.accountCard.click()
    const sheet = new AccountSwitcherSheet(this.page)
    await sheet.waitUntilOpen()
    return sheet
  }

  /** Selects the account at `address`, in any wallet: the card, then the account's row. */
  async switchAccount(address: string): Promise<void> {
    const sheet = await this.openAccountSwitcher()
    await sheet.selectAccount(address)
    await this.waitUntilReady()
    await this.expectCurrentAccount({ address })
  }

  /** "Add or import wallet" in the account switcher, which opens the new wallet screen. */
  async openAddWallet(): Promise<void> {
    const sheet = await this.openAccountSwitcher()
    await sheet.addOrImportWallet()
  }

  async openSettings(): Promise<void> {
    await this.clickTestId('tab-settings')
    await this.waitForHashRoute('/settings')
  }

  async expectSeedOnlyRecoveryWarning(): Promise<void> {
    const warning = this.byTestId('qbit-recovery-warning')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('Recovered Qbit wallet needs attention')
    await expect(warning).toContainText('strongly recommended to move funds to a fresh wallet')
    await expect(this.byTestId('qbit-recovery-move-funds-button')).toBeVisible()
    await expect(this.byTestId('qbit-recovery-continued-use-checkbox')).toBeVisible()
  }

  async acceptContinuedRecoveryUse(): Promise<void> {
    await this.byTestId('qbit-recovery-continued-use-checkbox-input').check()
    await expect(this.byTestId('qbit-recovery-acknowledge-button')).toBeEnabled()
    await this.clickTestId('qbit-recovery-acknowledge-button')
    await expect(this.byTestId('qbit-recovery-continued-use-checkbox')).toHaveCount(0)
    // Acknowledged wallets keep a collapsed residual banner; the full
    // guidance stays reachable behind the expand toggle.
    const warning = this.byTestId('qbit-recovery-warning')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('Warning: this is a recovered wallet')
    await expect(this.byTestId('qbit-recovery-warning-toggle')).toBeVisible()
    await expect(this.byTestId('qbit-recovery-move-funds-button')).toHaveCount(0)
  }

  async openRecoveryMigration(): Promise<void> {
    const moveFunds = this.byTestId('qbit-recovery-move-funds-button')
    // After acknowledgement the warning collapses; expand it to reach the
    // move-funds action.
    if (!(await moveFunds.isVisible())) {
      await this.clickTestId('qbit-recovery-warning-toggle')
      await expect(moveFunds).toBeVisible()
    }
    await moveFunds.click()
    await this.waitForHashRoute('/wallet/qbit-recovery-migration')
  }

  async dismissRecoveryWarningPermanently(): Promise<void> {
    const moveFunds = this.byTestId('qbit-recovery-move-funds-button')
    if (!(await moveFunds.isVisible())) {
      await this.clickTestId('qbit-recovery-warning-toggle')
    }
    await this.clickTestId('qbit-recovery-dismiss-button')
    await expect(this.byTestId('qbit-recovery-warning')).toHaveCount(0)
  }

  async expectArchivedRecoveryWarning(): Promise<void> {
    await this.waitForHashRoute('/main')
    await expect(this.balanceCard).toBeVisible()
    await expect(this.byTestId('qbit-recovery-archived')).toBeVisible()
    await expect(this.byTestId('qbit-recovery-resume-button')).toBeVisible()
    // Archived wallets stay read-only for receiving but keep the send and
    // history actions so stranded or newly detected funds can be moved out.
    await expect(this.byTestId('receive-button')).toHaveCount(0)
    await expect(this.byTestId('send-button')).toBeVisible()
    await expect(this.byTestId('history-button')).toBeVisible()
  }
}
