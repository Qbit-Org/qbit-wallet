import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

const CREATE_CONFIRMATION_INDEXES = [2, 7] as const

export class OnboardingPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get createPasswordInput(): Locator {
    return this.byTestId('create-password-input')
  }

  get confirmPasswordInput(): Locator {
    return this.byTestId('create-password-confirm-input')
  }

  get passphraseInput(): Locator {
    return this.byTestId('passphrase-input')
  }

  async waitForWelcome(): Promise<void> {
    await this.waitForHashRoute('/welcome')
    await expect(this.page.getByText('Create new wallet', { exact: true })).toBeVisible()
  }

  async chooseCreateWallet(): Promise<void> {
    await this.waitForWelcome()
    await this.clickTestId('create-new-wallet-button')
    await expect(this.createPasswordInput).toBeVisible()
  }

  async chooseRestoreWallet(): Promise<void> {
    await this.waitForWelcome()
    await this.clickTestId('import-wallet-button')
    await expect(this.createPasswordInput).toBeVisible()
  }

  async createPassword(
    password: string,
    touchIdStep: 'auto-skip' | 'enable' = 'auto-skip'
  ): Promise<void> {
    await this.createPasswordInput.fill(password)
    await this.confirmPasswordInput.fill(password)
    await this.clickTestId('create-password-continue-button')

    if (touchIdStep === 'enable') {
      // The extension auto-opens its own tab on install; the WebAuthn ceremony
      // requires this page to be the active tab or Chrome rejects it with a
      // focus error.
      await this.page.bringToFront()
      await this.clickTestId('enable-touch-id-button')
      return
    }

    // The optional "Enable Touch ID" step appears only where the environment
    // reports a user-verifying platform authenticator (macOS, or a CDP
    // virtual authenticator); skip it when present so onboarding continues.
    const skipButton = this.byTestId('skip-touch-id-button')
    try {
      await skipButton.waitFor({ state: 'visible', timeout: 3_000 })
      await skipButton.click()
    } catch {
      // Step not shown: nothing to skip.
    }
  }

  async readGeneratedMnemonic(wordCount = 24): Promise<string[]> {
    const firstWord = this.mnemonicWord(0)
    await expect(firstWord).toHaveText(/^\S+$/)

    const words: string[] = []
    for (let index = 0; index < wordCount; index += 1) {
      const word = (await this.mnemonicWord(index).innerText()).trim()
      if (!/^\S+$/.test(word))
        throw new Error(`generated mnemonic word ${index + 1} is invalid: ${word}`)
      words.push(word)
    }
    return words
  }

  async acceptGeneratedMnemonic(words: readonly string[]): Promise<void> {
    await this.openGeneratedMnemonicVerification()

    for (const index of CREATE_CONFIRMATION_INDEXES) {
      const word = words[index]
      if (!word) throw new Error(`mnemonic does not contain confirmation word ${index + 1}`)
      await this.byTestId(`mnemonic-confirm-word-${index}`).fill(word)
    }
    await this.clickTestId('mnemonic-confirm-continue-button')
    await expect(this.byTestId('address-type-title')).toBeVisible()
  }

  async openGeneratedMnemonicVerification(): Promise<void> {
    await this.byTestId('mnemonic-saved-checkbox-input').check()
    await this.clickTestId('mnemonic-continue-button')
    await expect(this.page.getByText('Verify Recovery Phrase', { exact: true })).toBeVisible()
  }

  async returnToGeneratedMnemonic(): Promise<void> {
    await this.page.getByText('STEP 1', { exact: true }).click()
    await expect(this.byTestId('mnemonic-title')).toBeVisible()
  }

  async enterRestoreMnemonic(words: readonly string[]): Promise<void> {
    if (words.length !== 12 && words.length !== 24) {
      throw new Error(`restore mnemonic must contain 12 or 24 words, got ${words.length}`)
    }

    await expect(this.byTestId('mnemonic-import-word-0')).toBeVisible()
    await this.page.getByText(`${words.length} words`, { exact: true }).click()
    await expect(this.byTestId(`mnemonic-import-word-${words.length - 1}`)).toBeVisible()
    for (let index = 0; index < words.length; index += 1) {
      await this.byTestId(`mnemonic-import-word-${index}`).fill(words[index] ?? '')
    }
    await this.clickTestId('mnemonic-import-continue-button')
    await expect(this.byTestId('address-type-title')).toBeVisible()
  }

  async submitAddressType(passphrase = ''): Promise<void> {
    const p2mrCard = this.byTestId('address-type-card-0')
    await expect(p2mrCard).toBeVisible()
    await p2mrCard.click()
    if (passphrase) await this.passphraseInput.fill(passphrase)
    await this.clickTestId('address-type-continue-button')
  }

  async createNewWallet(
    password: string,
    passphrase = '',
    touchIdStep: 'auto-skip' | 'enable' = 'auto-skip'
  ): Promise<string[]> {
    await this.chooseCreateWallet()
    await this.createPassword(password, touchIdStep)
    const words = await this.readGeneratedMnemonic()
    await this.acceptGeneratedMnemonic(words)
    await this.submitAddressType(passphrase)
    return words
  }

  async restoreWallet(password: string, words: readonly string[], passphrase = ''): Promise<void> {
    await this.chooseRestoreWallet()
    await this.createPassword(password)
    await this.enterRestoreMnemonic(words)
    await this.submitAddressType(passphrase)
  }

  async restoreAdditionalWallet(words: readonly string[], passphrase = ''): Promise<void> {
    await this.waitForHashRoute('/account/add-keyring')
    await this.clickTestId('restore-from-mnemonics-option')
    await this.waitForHashRoute('/account/create-hd-wallet')
    await this.enterRestoreMnemonic(words)
    await this.submitAddressType(passphrase)
  }

  private mnemonicWord(index: number): Locator {
    return this.byTestId(`mnemonic-word-${index}`).locator('span').last()
  }
}
