import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

export type SignatureBudgetState = 'normal' | 'warning' | 'critical' | 'exhausted'
export type SignatureCounterProvenance = 'local' | 'restored-floor'

export class ReceivePage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get currentAddressButton(): Locator {
    return this.page.locator('.receive-address-button')
  }

  get amountInput(): Locator {
    return this.page.locator('#qbit-receive-amount')
  }

  get labelInput(): Locator {
    return this.page.locator('#qbit-receive-label')
  }

  async waitUntilReady(timeout?: number): Promise<void> {
    await this.waitForHashRoute('/wallet/receive')
    await expect(this.currentAddressButton).toBeVisible(
      timeout === undefined ? undefined : { timeout }
    )
    await expect(this.byTestId('receive-qr')).toBeVisible()
  }

  async currentAddress(timeout?: number): Promise<string> {
    await this.waitUntilReady(timeout)
    const address = await this.requiredAttribute(this.currentAddressButton, 'data-qbit-address')
    if (!/^qb(?:rt)?1[0-9a-z]+$/i.test(address)) {
      throw new Error(`receive page exposed an invalid Qbit address: ${address}`)
    }
    return address
  }

  async setPaymentDetails(amount: string, label: string): Promise<void> {
    await this.amountInput.fill(amount)
    await this.labelInput.fill(label)
    await expect(this.byTestId('receive-qr-invalid')).toHaveCount(0)
  }

  /**
   * Press New Address and wait for the address it selects. `timeout` covers
   * the wait for the new address, which on a mnemonic-restored wallet
   * includes an on-chain floor scan.
   */
  async rotateAddress(timeout?: number): Promise<{ previous: string; current: string }> {
    const previous = await this.currentAddress()
    await this.clickTestId('new-address')
    await expect(this.currentAddressButton).not.toHaveAttribute(
      'data-qbit-address',
      previous,
      timeout === undefined ? undefined : { timeout }
    )
    const current = await this.currentAddress(timeout)
    return { previous, current }
  }

  async previousAddresses(timeout?: number): Promise<string[]> {
    await this.waitUntilReady(timeout)
    const cards = this.page.locator('.receive-address-card[data-qbit-address]')
    const addresses: string[] = []
    for (let index = 0; index < (await cards.count()); index += 1) {
      addresses.push(await this.requiredAttribute(cards.nth(index), 'data-qbit-address'))
    }
    return addresses
  }

  async expectBudgetState(state: SignatureBudgetState): Promise<void> {
    await expect(this.byTestId(`budget-state-${state}`).first()).toBeVisible()
  }

  async expectCounterProvenance(provenance: SignatureCounterProvenance): Promise<void> {
    await expect(this.byTestId(`counter-provenance-${provenance}`).first()).toBeVisible()
  }

  async expectCurrentAddressUsed(): Promise<void> {
    await expect(this.page.locator('.receive-hero .receive-badge.used')).toBeVisible()
    await expect(this.byTestId('current-address-used-warning')).toBeVisible()
  }

  async expectPreviousAddressUsed(address: string): Promise<void> {
    const card = this.page.locator(`.receive-address-card[data-qbit-address="${address}"]`)
    await expect(card.locator('.receive-badge.used')).toBeVisible()
  }

  async expectNoSafetyWarnings(): Promise<void> {
    await expect(this.byTestId('activity-cached-warning')).toHaveCount(0)
    await expect(this.byTestId('floors-pending-warning')).toHaveCount(0)
    await expect(this.byTestId('concurrent-instance-warning')).toHaveCount(0)
    await expect(this.byTestId('gap-limit-warning')).toHaveCount(0)
  }
}
