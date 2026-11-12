import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/** The tags a wallet can show next to its name, as their test IDs spell them. */
export type WalletTag = 'read-only' | 'recovered' | 'archived' | 'cold'

export const WALLET_TAGS: readonly WalletTag[] = ['read-only', 'recovered', 'archived', 'cold']

export type WalletMenuItem = 'add-account' | 'rename' | 'change-color' | 'show-phrase' | 'remove'

export type AccountMenuItem = 'edit-name' | 'copy-address' | 'export-key'

/** The short address the switcher shows for an account. */
export function shortAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}...${address.slice(-8)}`
}

/**
 * The Switch Account sheet the home screen's account card opens: every
 * account grouped under its wallet, keyed by `keyring.key` and by address.
 */
export class AccountSwitcherSheet extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get root(): Locator {
    return this.byTestId('switch-account-sheet')
  }

  get searchInput(): Locator {
    return this.byTestId('switch-account-search')
  }

  get emptyResult(): Locator {
    return this.byTestId('switch-account-empty')
  }

  get addWalletButton(): Locator {
    return this.byTestId('add-wallet-button')
  }

  /** The open wallet or account menu. */
  get menu(): Locator {
    return this.page.getByRole('menu')
  }

  get nameDialog(): Locator {
    return this.byTestId('name-edit-dialog')
  }

  get colorPicker(): Locator {
    return this.byTestId('wallet-color-picker')
  }

  /** The New account dialog "+" and Add Account open over the sheet. */
  get newAccountDialog(): Locator {
    return this.byTestId('new-account-dialog')
  }

  get newAccountWalletName(): Locator {
    return this.byTestId('create-account-wallet-name')
  }

  get newAccountWalletTile(): Locator {
    return this.byTestId('create-account-wallet-tile')
  }

  get newAccountNameInput(): Locator {
    return this.byTestId('create-account-name-input')
  }

  get newAccountCreateButton(): Locator {
    return this.byTestId('create-account-confirm-button')
  }

  get newAccountCancelButton(): Locator {
    return this.byTestId('create-account-cancel-button')
  }

  get newAccountCloseButton(): Locator {
    return this.byTestId('create-account-close-button')
  }

  walletGroup(keyringKey: string): Locator {
    return this.byTestId(`wallet-group-${keyringKey}`)
  }

  walletName(keyringKey: string): Locator {
    return this.byTestId(`wallet-name-${keyringKey}`)
  }

  walletTile(keyringKey: string): Locator {
    return this.byTestId(`wallet-tile-${keyringKey}`)
  }

  walletTag(keyringKey: string, tag: WalletTag): Locator {
    return this.byTestId(`wallet-tag-${tag}-${keyringKey}`)
  }

  addAccountButton(keyringKey: string): Locator {
    return this.byTestId(`wallet-add-account-${keyringKey}`)
  }

  walletMenuButton(keyringKey: string): Locator {
    return this.byTestId(`wallet-menu-${keyringKey}`)
  }

  accountRow(address: string): Locator {
    return this.byTestId(`account-row-${address}`)
  }

  accountMenuButton(address: string): Locator {
    return this.byTestId(`account-menu-${address}`)
  }

  /** The highlighted row of the current account. */
  get currentAccountRow(): Locator {
    return this.root.locator('[data-testid^="account-row-"][aria-current="true"]')
  }

  async waitUntilOpen(): Promise<void> {
    await expect(this.root).toBeVisible()
    await expect(this.searchInput).toBeVisible()
  }

  async waitUntilClosed(): Promise<void> {
    await expect(this.root).toHaveCount(0)
  }

  async close(): Promise<void> {
    await this.clickTestId('switch-account-close')
    await this.waitUntilClosed()
  }

  /** The wallets' keys, in the order the sheet lists their groups. */
  async walletKeys(): Promise<string[]> {
    const testIds = await this.root
      .locator('[data-testid^="wallet-group-"]')
      .evaluateAll(groups => groups.map(group => group.getAttribute('data-testid') ?? ''))
    return testIds.map(testId => testId.slice('wallet-group-'.length))
  }

  /** The addresses of the account rows the sheet shows, in order, for one wallet or all. */
  async accountAddresses(keyringKey?: string): Promise<string[]> {
    const scope = keyringKey ? this.walletGroup(keyringKey) : this.root
    const testIds = await scope
      .locator('[data-testid^="account-row-"]')
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-testid') ?? ''))
    return testIds.map(testId => testId.slice('account-row-'.length))
  }

  /** The tags a wallet's group header shows. */
  async walletTags(keyringKey: string): Promise<WalletTag[]> {
    const tags: WalletTag[] = []
    for (const tag of WALLET_TAGS) {
      if ((await this.walletTag(keyringKey, tag).count()) > 0) tags.push(tag)
    }
    return tags
  }

  /** The palette key of a wallet's tile. */
  async walletColor(keyringKey: string): Promise<string> {
    return this.requiredAttribute(this.walletTile(keyringKey), 'data-color')
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query)
    await expect(this.searchInput).toHaveValue(query)
  }

  /** One tap on an account's row, which switches wallet and account and closes the sheet. */
  async selectAccount(address: string): Promise<void> {
    const row = this.accountRow(address)
    await expect(row).toBeVisible()
    await row.click()
    await this.waitUntilClosed()
  }

  async openWalletMenu(keyringKey: string): Promise<void> {
    await this.walletMenuButton(keyringKey).click()
    await expect(this.menu).toBeVisible()
    await expect(this.walletMenuButton(keyringKey)).toHaveAttribute('aria-expanded', 'true')
  }

  async openAccountMenu(address: string): Promise<void> {
    await this.accountMenuButton(address).click()
    await expect(this.menu).toBeVisible()
    await expect(this.accountMenuButton(address)).toHaveAttribute('aria-expanded', 'true')
  }

  /** The items of the open menu, by the name their test IDs give them. */
  async menuItems(): Promise<string[]> {
    const testIds = await this.menu
      .getByRole('menuitem')
      .evaluateAll(items => items.map(item => item.getAttribute('data-testid') ?? ''))
    return testIds.map(testId => testId.replace(/^(?:wallet|account)-menu-/, ''))
  }

  async chooseWalletMenuItem(keyringKey: string, item: WalletMenuItem): Promise<void> {
    await this.openWalletMenu(keyringKey)
    await this.menu.getByTestId(`wallet-menu-${item}`).click()
  }

  async chooseAccountMenuItem(address: string, item: AccountMenuItem): Promise<void> {
    await this.openAccountMenu(address)
    await this.menu.getByTestId(`account-menu-${item}`).click()
  }

  async renameWallet(keyringKey: string, name: string): Promise<void> {
    await this.chooseWalletMenuItem(keyringKey, 'rename')
    await this.saveName(name)
    await expect(this.walletName(keyringKey)).toHaveText(name)
  }

  async renameAccount(address: string, name: string): Promise<void> {
    await this.chooseAccountMenuItem(address, 'edit-name')
    await this.saveName(name)
    await expect(this.accountRow(address)).toContainText(name)
  }

  /** Change Color, then one tap on a swatch, which saves the color and closes the picker. */
  async changeWalletColor(keyringKey: string, color: string): Promise<void> {
    await this.chooseWalletMenuItem(keyringKey, 'change-color')
    await expect(this.colorPicker).toBeVisible()
    await this.colorPicker.getByTestId(`wallet-color-swatch-${color}`).click()
    await expect(this.colorPicker).toHaveCount(0)
    await expect(this.walletTile(keyringKey)).toHaveAttribute('data-color', color)
  }

  /**
   * The "+" on a wallet's group, which opens the New account dialog for that
   * wallet over the sheet: ready once its name field shows, the field the
   * release storage capture fills in.
   */
  async addAccount(keyringKey: string): Promise<void> {
    await this.addAccountButton(keyringKey).click()
    await expect(this.newAccountNameInput).toBeVisible()
  }

  /** The New account dialog is open over the sheet, which stays open under it. */
  async expectNewAccountDialogOverSheet(): Promise<void> {
    await expect(this.newAccountDialog).toBeVisible()
    await expect(this.root).toBeVisible()
    await expect(this.newAccountNameInput).toBeFocused()
  }

  /** Remove Wallet, confirmed in the removal popover; the wallet's group leaves the open sheet. */
  async removeWallet(keyringKey: string): Promise<void> {
    await this.chooseWalletMenuItem(keyringKey, 'remove')
    const confirm = this.removalDialog.getByText('Remove', { exact: true })
    await expect(confirm).toBeVisible()
    await confirm.click()
    await expect(this.walletGroup(keyringKey)).toHaveCount(0, { timeout: 30_000 })
    await expect(this.removalDialog).toHaveCount(0)
  }

  /** Add or import wallet, at the bottom of the sheet. */
  async addOrImportWallet(): Promise<void> {
    await expect(this.addWalletButton).toBeVisible()
    await this.addWalletButton.click()
    await this.waitForHashRoute('/account/add-keyring')
  }

  /** The removal popover, a dialog named after the action. */
  get removalDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Remove Wallet', exact: true })
  }

  private async saveName(name: string): Promise<void> {
    await expect(this.nameDialog).toBeVisible()
    await this.byTestId('name-edit-input').fill(name)
    await this.clickTestId('name-edit-save')
    await expect(this.nameDialog).toHaveCount(0)
  }
}
