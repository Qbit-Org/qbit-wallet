import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

export type HistoryTransactionStatus = 'Pending' | 'Replaced' | 'Unconfirmed' | 'Confirmed'

export class HistoryPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/wallet/history')
    await expect(this.page.getByText('History', { exact: true })).toBeVisible()
  }

  transaction(txid: string): Locator {
    return this.byTestId(`history-item-${txid}`)
  }

  async transactionIds(): Promise<string[]> {
    const rows = this.page.locator('[data-testid^="history-item-"]')
    const ids: string[] = []
    for (let index = 0; index < (await rows.count()); index += 1) {
      const testId = await this.requiredAttribute(rows.nth(index), 'data-testid')
      const txid = testId.slice('history-item-'.length)
      if (!/^[0-9a-f]{64}$/i.test(txid))
        throw new Error(`history row has invalid txid test id: ${testId}`)
      ids.push(txid)
    }
    return ids
  }

  async waitForTransaction(txid: string): Promise<Locator> {
    const row = this.transaction(txid)
    await expect(row).toBeVisible({ timeout: 60_000 })
    return row
  }

  async openTransaction(txid: string): Promise<void> {
    const row = await this.waitForTransaction(txid)
    await row.click()
    await expect(this.page.getByText('Transaction Details', { exact: true })).toBeVisible()
    await expect(this.byTestId('history-detail-txid')).toHaveAttribute('data-txid', txid)
  }

  async rowStatus(txid: string): Promise<HistoryTransactionStatus> {
    const row = await this.waitForTransaction(txid)
    const status = await this.requiredAttribute(row, 'data-transaction-status')
    if (
      status !== 'Pending' &&
      status !== 'Replaced' &&
      status !== 'Unconfirmed' &&
      status !== 'Confirmed'
    )
      throw new Error(`history row has invalid transaction status: ${status}`)
    return status
  }

  async waitForStatus(
    txid: string,
    status: HistoryTransactionStatus,
    options: { reload?: boolean; timeout?: number } = {}
  ): Promise<void> {
    await expect
      .poll(
        async () => {
          if (options.reload) {
            await this.page.reload({ waitUntil: 'domcontentloaded' })
            await this.waitUntilReady()
          }
          return this.rowStatus(txid)
        },
        {
          timeout: options.timeout ?? 60_000,
          intervals: [250, 500, 1_000],
        }
      )
      .toBe(status)
  }

  async detailNetworkFeeQbt(): Promise<string> {
    const label = this.page.getByText('Network Fee', { exact: true })
    await expect(label).toBeVisible()
    const row = label.locator('../..')
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim()
    const match = text.match(/Network fee\s+([0-9.]+)\s+QBT/i)
    if (!match?.[1]) throw new Error(`unable to parse history network fee from: ${text}`)
    return match[1]
  }

  async expectTransactionIoCounts(inputCount: number, outputCount: number): Promise<void> {
    await expect(this.page.locator('[data-testid^="history-detail-input-"]')).toHaveCount(
      inputCount
    )
    await expect(this.page.locator('[data-testid^="history-detail-output-"]')).toHaveCount(
      outputCount
    )
  }

  async expectOutputAddressUnavailable(index: number): Promise<void> {
    const output = this.byTestId(`history-detail-output-${index}`)
    await expect(output).toBeVisible()
    await expect(output.getByText('Address unavailable', { exact: true })).toBeVisible()
  }

  async expectRawTransactionPreview(rawHex: string): Promise<void> {
    if (!/^(?:[0-9a-f]{2})+$/i.test(rawHex))
      throw new Error('expected an even-length hexadecimal raw transaction fixture')
    const preview = rawHex.length > 192 ? `${rawHex.slice(0, 192)}…` : rawHex
    await expect(this.byTestId('raw-transaction-error')).toHaveCount(0)
    await expect(this.byTestId('history-detail-raw-hex-preview')).toHaveText(preview, {
      timeout: 30_000,
    })
    await expect(this.byTestId('copy-raw-transaction')).toBeVisible()
  }

  async bumpFee(): Promise<void> {
    await this.clickTestId('bump-fee-button')
    await this.waitForHashRoute('/wallet/tx/confirm')
    await expect(this.byTestId('psbt-network-fee-base-units')).toBeVisible()
  }

  async expectBumpUnavailable(): Promise<void> {
    await expect(this.byTestId('bump-fee-button')).toHaveCount(0)
  }
}
