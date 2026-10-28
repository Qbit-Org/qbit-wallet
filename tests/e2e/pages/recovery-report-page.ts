import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

export interface RecoveryReportSummary {
  accountsRestored: number
  network: string
}

export class RecoveryReportPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get pageRoot(): Locator {
    return this.byTestId('restore-report-page')
  }

  async waitUntilReady(timeout = 10 * 60_000): Promise<void> {
    await expect(this.pageRoot).toBeVisible({ timeout })
    await expect(this.byTestId('restore-report')).toBeVisible()
  }

  async summary(timeout?: number): Promise<RecoveryReportSummary> {
    await this.waitUntilReady(timeout)
    const accountsText = (await this.byTestId('restore-report-accounts').innerText()).trim()
    const accountsRestored = Number(accountsText)
    if (!Number.isSafeInteger(accountsRestored) || accountsRestored < 1) {
      throw new Error(`restore report exposed an invalid account count: ${accountsText}`)
    }

    const network = (await this.byTestId('restore-report-network').innerText()).trim()
    if (!network) throw new Error('restore report did not identify its network')
    return { accountsRestored, network }
  }

  async expectCounterMinimumWarning(): Promise<void> {
    await expect(this.byTestId('restore-report-warning-counters')).toBeVisible()
  }

  async expectNoConcurrentInstanceWarning(): Promise<void> {
    await expect(this.byTestId('restore-report-warning-concurrent')).toHaveCount(0)
  }

  async isDiscoveryTruncated(): Promise<boolean> {
    return this.byTestId('restore-report-truncated').isVisible()
  }

  async hasNoActivityHint(): Promise<boolean> {
    return this.byTestId('restore-report-no-activity').isVisible()
  }

  async expectFloorsCompleted(): Promise<void> {
    await expect(this.byTestId('restore-report-floors-incomplete')).toHaveCount(0)
    await expect(this.byTestId('restore-retry-button')).toHaveCount(0)
  }

  async retryFloorScan(): Promise<void> {
    await this.clickTestId('restore-retry-button')
    await this.expectFloorsCompleted()
  }

  async continueToWallet(): Promise<void> {
    await this.clickTestId('restore-report-continue')
    await this.waitForHashRoute('/main')
  }
}
