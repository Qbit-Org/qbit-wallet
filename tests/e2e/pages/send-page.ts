import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

export interface PqcSignResult {
  durationMs: number
  transactionId: string
}

export class SendPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get recipientInput(): Locator {
    return this.byTestId('recipient-address-input')
  }

  get amountInput(): Locator {
    return this.byTestId('transfer-amount-input')
  }

  get createError(): Locator {
    return this.byTestId('tx-create-error')
  }

  get nextButton(): Locator {
    return this.byTestId('tx-next-button')
  }

  /** The fee bar's Custom rate input, which has no test ID of its own. */
  get customFeeRateInput(): Locator {
    return this.page.getByPlaceholder('bits/vB', { exact: true })
  }

  async waitForCreate(): Promise<void> {
    await this.waitForHashRoute('/wallet/tx/create')
    await expect(this.recipientInput).toBeVisible()
  }

  /** Taps the form's own Back arrow. */
  async back(): Promise<void> {
    await this.waitForCreate()
    await this.clickTestId('header-back-button')
  }

  async enterTransfer(recipient: string, amountQbt: string): Promise<void> {
    await this.waitForCreate()
    await this.recipientInput.fill(recipient)
    await this.amountInput.fill(amountQbt)
  }

  async chooseFeeRateOption(index: number): Promise<string> {
    const option = this.byTestId(`fee-rate-option-${index}`)
    await expect(option).toBeVisible()
    const label = (await option.innerText()).replace(/\s+/g, ' ').trim()
    if ((await option.getAttribute('data-selected')) !== 'true') await option.click()
    await expect(option).toHaveAttribute('data-selected', 'true')
    return label
  }

  /** Selects Custom and types a rate in bits/vB, which the input must keep as typed. */
  async enterCustomFeeRate(rate: string): Promise<void> {
    // Custom follows the Slow, Normal and Fast tiers.
    const custom = this.byTestId('fee-rate-option-3')
    await expect(custom).toBeVisible()
    if ((await custom.getAttribute('data-selected')) !== 'true') await custom.click()
    await expect(custom).toHaveAttribute('data-selected', 'true')
    await expect(this.customFeeRateInput).toBeVisible()
    await this.customFeeRateInput.fill(rate)
    await expect(this.customFeeRateInput).toHaveValue(rate)
  }

  async expectNextEnabled(): Promise<void> {
    await expect(this.nextButton).toBeVisible()
    await expect(this.nextButton).toHaveCSS('cursor', 'pointer')
  }

  /** Next shows its disabled style, and a click on it leaves the form in place. */
  async expectNextDisabled(): Promise<void> {
    await expect(this.nextButton).toBeVisible()
    await expect(this.nextButton).toHaveCSS('cursor', 'not-allowed')
    await this.nextButton.click()
    await this.waitForCreate()
  }

  async setRbf(enabled: boolean): Promise<void> {
    const input = this.byTestId('rbf-checkbox-input')
    await expect(input).toBeVisible()
    if ((await input.isChecked()) !== enabled) await input.click()
    await expect(input).toBeChecked({ checked: enabled })
  }

  async expandAdvancedMemo(memo: string): Promise<void> {
    const memoInput = this.byTestId('memo-input')
    if (!(await memoInput.isVisible())) await this.clickTestId('advanced-toggle')
    await expect(memoInput).toBeVisible()
    await memoInput.fill(memo)
  }

  async estimatedInputCount(): Promise<number> {
    const estimate = this.byTestId('tx-size-estimate')
    await expect(estimate).toBeVisible()
    const text = await estimate.innerText()
    const match = text.match(/(\d+)\s+input/i)
    if (!match?.[1]) throw new Error(`unable to parse estimated input count from: ${text}`)
    return Number(match[1])
  }

  /** The fee the form estimates, in bits, from the end of its size estimate. */
  async estimatedFeeBaseUnits(): Promise<number> {
    const estimate = this.byTestId('tx-size-estimate')
    await expect(estimate).toBeVisible()
    const text = (await estimate.innerText()).trim()
    // The fee is a whole number of bits, grouped for the UI language.
    const match = text.match(/([\d.,\s]+)bits$/i)
    const digits = match?.[1]?.replace(/\D/g, '')
    if (!digits) throw new Error(`unable to parse estimated fee from: ${text}`)
    return Number(digits)
  }

  async expectDustRejected(): Promise<string> {
    await expect(this.createError).toBeVisible()
    const message = (await this.createError.innerText()).trim()
    if (!/dust|minimum|too small|at least/i.test(message)) {
      throw new Error(`send was rejected for an unexpected reason: ${message}`)
    }
    return message
  }

  async continueToReview(): Promise<void> {
    await this.clickTestId('tx-next-button')
    await this.waitForHashRoute('/wallet/tx/confirm')
    await expect(this.byTestId('psbt-network-fee-base-units')).toBeVisible()
  }

  async exactFeeBaseUnits(): Promise<number> {
    const fee = this.byTestId('psbt-network-fee-base-units')
    await expect(fee).toBeVisible()
    const text = await fee.innerText()
    const match = text.match(/Exact fee:\s*(\d+)\s*bits/i)
    if (!match?.[1]) throw new Error(`unable to parse exact fee from: ${text}`)
    return Number(match[1])
  }

  async reviewedInputCount(): Promise<number> {
    return this.page.locator('[data-testid^="psbt-input-item-"]').count()
  }

  async signatureBudgetText(): Promise<string> {
    const budget = this.byTestId('psbt-signature-budget')
    await expect(budget).toBeVisible()
    return (await budget.innerText()).replace(/\s+/g, ' ').trim()
  }

  async signAndBroadcast(): Promise<PqcSignResult> {
    const signButton = this.byTestId('sign-psbt-button')
    await expect(signButton).toBeVisible()
    const startedAt = performance.now()
    await signButton.click()

    const riskInput = this.byTestId('risk-confirmation-input')
    const successTxid = this.byTestId('tx-success-txid')
    await expect(riskInput.or(successTxid)).toBeAttached({ timeout: 120_000 })
    if (await riskInput.isVisible()) {
      await riskInput.fill('CONFIRM')
      const riskConfirm = this.byTestId('risk-confirm-button')
      await expect(riskConfirm).toHaveAttribute('aria-disabled', 'false')
      await riskConfirm.click()
    }

    await expect(successTxid).toBeAttached({ timeout: 120_000 })
    const transactionId = await this.requiredAttribute(successTxid, 'data-txid')
    if (!/^[0-9a-f]{64}$/i.test(transactionId)) {
      throw new Error(`transaction success screen exposed an invalid txid: ${transactionId}`)
    }
    return { durationMs: performance.now() - startedAt, transactionId }
  }

  async finishSuccess(): Promise<void> {
    await this.clickTestId('tx-success-done-button')
    await this.waitForHashRoute('/main')
  }
}
