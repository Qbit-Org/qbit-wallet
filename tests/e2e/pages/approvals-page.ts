import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

export interface ApprovalSignResult {
  durationMs: number
  signatureBudget: string
}

export type UnverifiedApprovalSurface = 'connect' | 'message' | 'psbt'

const SURFACE_TEST_ID_PREFIX: Record<UnverifiedApprovalSurface, string> = {
  connect: '',
  message: 'message-',
  psbt: 'psbt-',
}

const SURFACE_PRIMARY_ACTION: Record<UnverifiedApprovalSurface, string> = {
  connect: 'website-check-connect-button',
  message: 'sign-message-button',
  psbt: 'sign-psbt-button',
}

const SURFACE_REJECT_LABEL: Record<UnverifiedApprovalSurface, string> = {
  connect: 'Cancel',
  message: 'Reject',
  psbt: 'Reject',
}

function measureHorizontalExtent(element: Element): { scrollWidth: number; clientWidth: number } {
  return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
}

export class ApprovalsPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  static async waitForNext(context: BrowserContext): Promise<ApprovalsPage> {
    const existing = context.pages().find(page => /#\/approval(?:$|\?)/.test(page.url()))
    const page = existing ?? (await context.waitForEvent('page', { timeout: 30_000 }))
    await page.waitForURL(/#\/approval(?:$|\?)/, { timeout: 30_000 })
    return new ApprovalsPage(page)
  }

  get providerContext(): Locator {
    return this.byTestId('qbit-provider-context')
  }

  async contextText(): Promise<string> {
    await expect(this.providerContext).toBeVisible()
    return (await this.providerContext.innerText()).replace(/\s+/g, ' ').trim()
  }

  async approveConnection(): Promise<void> {
    const connect = this.byTestId('website-check-connect-button')
    await expect(connect).toBeVisible({ timeout: 60_000 })
    await this.acknowledgeUnverified('unverified-website-confirmation')
    await this.clickAndWaitForClose(connect)
  }

  async cancelConnection(): Promise<void> {
    const cancel = this.byTestId('website-check-cancel-button')
    await expect(cancel).toBeVisible({ timeout: 60_000 })
    await this.clickAndWaitForClose(cancel)
  }

  async approveMessage(expectedMessage: string): Promise<ApprovalSignResult> {
    const message = this.byTestId('p2mr-message-text')
    await expect(message).toHaveText(expectedMessage, { timeout: 60_000 })
    const signatureBudget = await this.visibleText('p2mr-message-signature-budget')
    await this.acknowledgeUnverified('message-unverified-website-confirmation')

    const sign = this.byTestId('sign-message-button')
    const startedAt = performance.now()
    await this.clickAndWaitForClose(sign, 120_000)
    return { durationMs: performance.now() - startedAt, signatureBudget }
  }

  async approvePsbt(expectedInputCount?: number): Promise<ApprovalSignResult> {
    await expect(this.byTestId('psbt-network-fee-base-units')).toBeVisible({ timeout: 60_000 })
    if (expectedInputCount !== undefined) {
      await expect(this.page.locator('[data-testid^="psbt-input-item-"]')).toHaveCount(
        expectedInputCount
      )
    }
    const signatureBudget = await this.visibleText('psbt-signature-budget')
    await this.acknowledgeUnverified('psbt-unverified-website-confirmation')

    const sign = this.byTestId('sign-psbt-button')
    await expect(sign).toBeVisible()
    const startedAt = performance.now()
    const closed = this.page
      .waitForEvent('close', { timeout: 120_000 })
      .then(() => 'closed' as const)
    await sign.click()

    const riskInput = this.byTestId('risk-confirmation-input')
    const risk = riskInput
      .waitFor({ state: 'visible', timeout: 120_000 })
      .then(() => 'risk' as const)
      .catch(() => new Promise<never>(() => undefined))
    const outcome = await Promise.race([closed, risk])
    if (outcome === 'risk') {
      await riskInput.fill('CONFIRM')
      const riskConfirm = this.byTestId('risk-confirm-button')
      await expect(riskConfirm).toHaveAttribute('aria-disabled', 'false')
      await riskConfirm.click()
      await closed
    }
    return { durationMs: performance.now() - startedAt, signatureBudget }
  }

  async waitForConnectedSites(): Promise<void> {
    await this.waitForHashRoute('/connected-sites')
    await expect(this.page.getByText('Connected Sites', { exact: true })).toBeVisible()
  }

  async connectedSiteOrigins(): Promise<string[]> {
    const cards = this.page.locator('[data-testid^="connected-site-"]')
    const origins: string[] = []
    for (let index = 0; index < (await cards.count()); index += 1) {
      const text = (await cards.nth(index).innerText()).trim()
      const origin = text.split(/\s+/).find(value => /^https?:\/\//.test(value))
      if (!origin) throw new Error(`connected site row does not contain an origin: ${text}`)
      origins.push(origin)
    }
    return origins
  }

  async revokeSite(origin: string): Promise<void> {
    const card = this.page.locator('[data-testid^="connected-site-"]', { hasText: origin })
    await expect(card).toHaveCount(1)
    await card.locator('[data-testid^="revoke-site-"]').click()
    await expect(card).toHaveCount(0)
  }

  get actionOverview(): Locator {
    return this.byTestId('psbt-action-overview')
  }

  get actionTitle(): Locator {
    return this.byTestId('psbt-action-title')
  }

  get actionDetails(): Locator {
    return this.byTestId('psbt-action-detail')
  }

  /** The action-overview detail rows whose label reads exactly `label`. */
  actionDetail(label: string): Locator {
    return this.actionDetails.filter({ has: this.page.getByText(label, { exact: true }) })
  }

  get messageText(): Locator {
    return this.byTestId('p2mr-message-text')
  }

  get connectAccount(): Locator {
    return this.byTestId('connect-account-item')
  }

  websiteCheckWarning(surface: UnverifiedApprovalSurface): Locator {
    return this.byTestId(`${SURFACE_TEST_ID_PREFIX[surface]}website-check-warning`)
  }

  websiteCheckRetry(surface: UnverifiedApprovalSurface): Locator {
    return this.byTestId(`${SURFACE_TEST_ID_PREFIX[surface]}website-check-retry-button`)
  }

  unverifiedConfirmation(surface: UnverifiedApprovalSurface): Locator {
    return this.byTestId(`${SURFACE_TEST_ID_PREFIX[surface]}unverified-website-confirmation-input`)
  }

  primaryAction(surface: UnverifiedApprovalSurface): Locator {
    return this.byTestId(SURFACE_PRIMARY_ACTION[surface])
  }

  async expectTheme(theme: 'light' | 'dark'): Promise<void> {
    await expect(this.page.locator('html')).toHaveAttribute('data-theme', theme)
  }

  /**
   * Asserts the surface renders without horizontal overflow at the current
   * viewport. The layout root hides overflow-x, so a scroll range wider than
   * its client width means content is being clipped; each given element must
   * also lie inside the viewport width with its own content unclipped. Half a
   * pixel of tolerance absorbs sub-pixel layout rounding only.
   */
  async expectNoHorizontalOverflow(...elements: Locator[]): Promise<void> {
    const viewport = this.page.viewportSize()
    if (!viewport) throw new Error('approval page has no emulated viewport size')
    const layout = this.page.locator('.layout').first()
    await expect(layout).toBeVisible()
    const root = await layout.evaluate(measureHorizontalExtent)
    expect(root.scrollWidth, 'layout root exposes no horizontal overflow').toBeLessThanOrEqual(
      root.clientWidth
    )
    for (const element of elements) {
      await expect(element).toBeVisible()
      const box = await element.boundingBox()
      if (!box) throw new Error('element must be laid out to check it for overflow')
      expect(box.x, 'element starts inside the viewport').toBeGreaterThanOrEqual(-0.5)
      expect(box.x + box.width, 'element ends inside the viewport').toBeLessThanOrEqual(
        viewport.width + 0.5
      )
      const content = await element.evaluate(measureHorizontalExtent)
      expect(content.scrollWidth, 'element content is not clipped').toBeLessThanOrEqual(
        content.clientWidth
      )
    }
  }

  /**
   * Asserts the unverified-site gate on one approval surface: the compact
   * warning and its Retry control are visible, the primary action stays
   * disabled until the footer acknowledgement is checked, and Retry only
   * restarts the check (clearing the acknowledgement) without enabling the
   * action. Leaves the surface acknowledged so the caller can proceed.
   */
  async expectUnverifiedGate(surface: UnverifiedApprovalSurface): Promise<void> {
    const warning = this.websiteCheckWarning(surface)
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('Warning')
    const retry = this.websiteCheckRetry(surface)
    await expect(retry).toHaveRole('button')
    await expect(retry).toHaveText('Try again')

    const action = this.primaryAction(surface)
    await expect(action).toBeVisible()
    await expect(action).toHaveAttribute('aria-disabled', 'true')

    const confirmation = this.unverifiedConfirmation(surface)
    await expect(confirmation).toBeVisible()
    await expect(confirmation).not.toBeChecked()
    await confirmation.check()
    await expect(action).toHaveAttribute('aria-disabled', 'false')

    // Retry re-runs the check through the loading screen; wait for the
    // re-rendered unverified surface before asserting the cleared gate.
    await retry.click()
    await expect(this.primaryAction(surface)).toHaveAttribute('aria-disabled', 'true')
    await expect(this.unverifiedConfirmation(surface)).not.toBeChecked()
    await this.unverifiedConfirmation(surface).check()
    await expect(this.primaryAction(surface)).toHaveAttribute('aria-disabled', 'false')
  }

  async reject(surface: UnverifiedApprovalSurface): Promise<void> {
    await this.clickAndWaitForClose(
      this.page.getByText(SURFACE_REJECT_LABEL[surface], { exact: true })
    )
  }

  private async acknowledgeUnverified(testId: string): Promise<void> {
    const checkbox = this.byTestId(`${testId}-input`)
    if (await checkbox.isVisible()) await checkbox.check()
  }

  private async visibleText(testId: string): Promise<string> {
    const locator = this.byTestId(testId)
    await expect(locator).toBeVisible()
    return (await locator.innerText()).replace(/\s+/g, ' ').trim()
  }

  private async clickAndWaitForClose(locator: Locator, timeout = 30_000): Promise<void> {
    await expect(locator).toBeVisible()
    await Promise.all([this.page.waitForEvent('close', { timeout }), locator.click()])
  }
}
