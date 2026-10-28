import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

const CONFIRMATION_INDEXES = [2, 7] as const

export interface RecoveryMigrationReview {
  /** Structure-preserving account mapping lines, one per reviewed plan. */
  destinations: string[]
  amount: string
  fee: string
  consequence: string
}

export class RecoveryMigrationPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  async waitUntilSeedBackup(): Promise<void> {
    await this.waitForHashRoute('/wallet/qbit-recovery-migration')
    await expect(this.mnemonicWord(0)).toHaveText(/^\S+$/)
  }

  async createAndConfirmFreshSeed(wordCount = 24): Promise<string[]> {
    await this.waitUntilSeedBackup()
    const words: string[] = []
    for (let index = 0; index < wordCount; index += 1) {
      const word = (await this.mnemonicWord(index).innerText()).trim()
      if (!/^\S+$/.test(word)) {
        throw new Error(`fresh migration mnemonic word ${index + 1} is invalid`)
      }
      words.push(word)
    }

    await this.checkboxInput('mnemonic-saved-checkbox').check()
    await this.clickTestId('mnemonic-continue-button')
    for (const index of CONFIRMATION_INDEXES) {
      const word = words[index]
      if (!word) throw new Error(`fresh migration mnemonic is missing word ${index + 1}`)
      await this.byTestId(`mnemonic-confirm-word-${index}`).fill(word)
    }
    await this.clickTestId('mnemonic-confirm-continue-button')
    await expect(this.reviewDestinationLine()).toBeVisible({ timeout: 60_000 })
    return words
  }

  async review(): Promise<RecoveryMigrationReview> {
    await expect(this.reviewDestinationLine()).toBeVisible()
    const mappingLines = await this.byTestId('qbit-recovery-account-mapping').allInnerTexts()
    const destinations =
      mappingLines.length > 0
        ? mappingLines.map(line => line.trim())
        : [(await this.byTestId('qbit-recovery-destination').innerText()).trim()]
    const review = {
      destinations,
      amount: (await this.byTestId('qbit-recovery-amount').innerText()).trim(),
      fee: (await this.byTestId('qbit-recovery-fee').innerText()).trim(),
      consequence: (await this.byTestId('qbit-recovery-consequence').innerText()).trim(),
    }
    for (const [field, value] of Object.entries(review)) {
      if (Array.isArray(value) ? value.some(entry => !entry) : !value) {
        throw new Error(`recovery migration review omitted ${field}`)
      }
    }
    return review
  }

  /** Opens the reveal dialog for the nth destination and returns the full address it shows. */
  async revealDestination(index = 0): Promise<string> {
    await this.byTestId('qbit-recovery-reveal-address').nth(index).click()
    return (await this.byTestId('qbit-recovery-full-address').innerText()).trim()
  }

  async closeRevealedDestination(): Promise<void> {
    await this.clickTestId('qbit-recovery-close-address-popover')
    await expect(this.byTestId('qbit-recovery-full-address')).toHaveCount(0)
  }

  async confirmAndSign(): Promise<void> {
    const signButton = this.byTestId('qbit-recovery-sign-button')
    await expect(signButton).toHaveCSS('cursor', 'not-allowed')
    await signButton.click()
    await expect(this.reviewDestinationLine()).toBeVisible()
    await this.checkboxInput('qbit-recovery-review-confirmation').check()
    await expect(signButton).toHaveCSS('cursor', 'pointer')
    await signButton.click()
    await expect(this.byTestId('qbit-recovery-check-status-button')).toBeVisible({
      timeout: 120_000,
    })
  }

  /**
   * Structure-preserving reviews list one mapping line per plan; version-1
   * consolidated plans keep the single fresh-destination line.
   */
  private reviewDestinationLine(): Locator {
    return this.byTestId('qbit-recovery-account-mapping')
      .first()
      .or(this.byTestId('qbit-recovery-destination'))
  }

  async checkStatus(): Promise<void> {
    await this.clickTestId('qbit-recovery-check-status-button')
  }

  async waitUntilComplete(): Promise<void> {
    await expect(this.byTestId('qbit-recovery-complete')).toBeVisible({ timeout: 60_000 })
  }

  async returnHome(): Promise<void> {
    await this.clickTestId('qbit-recovery-return-home-button')
    await this.waitForHashRoute('/main')
  }

  private checkboxInput(testId: string): Locator {
    return this.byTestId(`${testId}-input`)
  }

  private mnemonicWord(index: number): Locator {
    return this.byTestId(`mnemonic-word-${index}`).locator('span').last()
  }
}
