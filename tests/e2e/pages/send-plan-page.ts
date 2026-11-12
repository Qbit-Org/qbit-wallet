import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/** What the send screen's card says a send plan will do. */
export interface SendPlanNotice {
  title: string
  steps: string
  /** Exactly what the recipient receives, in bits. */
  receives: number
  /** Every fee of the plan, in bits. */
  totalFee: number
  /** The signatures it uses and about how long signing takes. */
  signing: string
  /** What stays in the account; undefined when the card names nothing. */
  leftBehind: string | undefined
}

/** What the one review of a send plan shows before its confirmation. */
export interface SendPlanReview {
  recipient: string
  receives: number
  totalFee: number
  transactions: string
  signing: string
  budget: string
  /** What comes back to the account, in bits; undefined without change. */
  change: number | undefined
}

export type SendPlanPhase =
  | 'signing'
  | 'waiting'
  | 'sending'
  | 'completed'
  | 'paused'
  | 'cancelling'

/**
 * An amount as the send plan screens print it, in bits: the coin with eight
 * decimals, then the unit. Read from the text, never through a float.
 */
export function sendPlanAmountBits(text: string): number {
  const match = text.trim().match(/^(\d+)\.(\d{8})\s+\S+$/)
  if (!match?.[1] || !match[2]) throw new Error(`unable to parse a send plan amount from: ${text}`)
  const bits = Number(`${match[1]}${match[2]}`)
  if (!Number.isSafeInteger(bits)) throw new Error(`send plan amount out of range: ${text}`)
  return bits
}

/** "N of M signatures", with the counts grouped as the UI language groups them. */
function signatureCounts(text: string): { done: number; total: number } {
  const match = text.match(/([\d.,\s]+)\s+of\s+([\d.,\s]+)\s+signatures/i)
  const done = match?.[1]?.replace(/\D/g, '')
  const total = match?.[2]?.replace(/\D/g, '')
  if (!done || !total) throw new Error(`unable to parse signature counts from: ${text}`)
  return { done: Number(done), total: Number(total) }
}

async function textOf(locator: Locator): Promise<string> {
  await expect(locator).toBeVisible()
  return (await locator.innerText()).replace(/\s+/g, ' ').trim()
}

/**
 * A payment that needs several transactions (#188): the send screen's card,
 * the one review, the progress screen, the home screen's card that leads
 * back to it, and the success screen it hands over to.
 */
export class SendPlanPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  get notice(): Locator {
    return this.byTestId('tx-send-plan-notice')
  }

  get nextButton(): Locator {
    return this.byTestId('tx-next-button')
  }

  get reviewConfirmButton(): Locator {
    return this.byTestId('qbit-send-plan-review-confirm')
  }

  /** The progress screen's content. */
  get progress(): Locator {
    return this.byTestId('qbit-send-plan')
  }

  /** The progress screen's phase and pause reason, as hidden attributes. */
  get state(): Locator {
    return this.byTestId('qbit-send-plan-state')
  }

  get signingCount(): Locator {
    return this.byTestId('qbit-send-plan-signing-count')
  }

  get resumeCard(): Locator {
    return this.byTestId('qbit-send-plan-resume')
  }

  get resumeStatus(): Locator {
    return this.byTestId('qbit-send-plan-resume-status')
  }

  get successTxidMarker(): Locator {
    return this.byTestId('tx-success-txid')
  }

  async readNotice(): Promise<SendPlanNotice> {
    await expect(this.notice).toBeVisible()
    const leftBehind = this.byTestId('tx-send-plan-left-behind')
    return {
      title: await textOf(this.byTestId('tx-send-plan-title')),
      steps: await textOf(this.byTestId('tx-send-plan-steps')),
      receives: sendPlanAmountBits(await textOf(this.byTestId('tx-send-plan-receives'))),
      totalFee: sendPlanAmountBits(await textOf(this.byTestId('tx-send-plan-total-fee'))),
      signing: await textOf(this.byTestId('tx-send-plan-signing')),
      leftBehind: (await leftBehind.count()) > 0 ? await textOf(leftBehind) : undefined,
    }
  }

  /** Next on the send screen, which prices the plan in the background and opens its review. */
  async openReview(): Promise<void> {
    await expect(this.nextButton).toHaveCSS('cursor', 'pointer')
    await this.nextButton.click()
    await this.waitForHashRoute('/wallet/tx/plan/review')
    await expect(this.reviewConfirmButton).toBeVisible()
  }

  async readReview(): Promise<SendPlanReview> {
    await this.waitForHashRoute('/wallet/tx/plan/review')
    const change = this.byTestId('qbit-send-plan-review-change')
    return {
      recipient: await textOf(this.byTestId('qbit-send-plan-review-recipient')),
      receives: sendPlanAmountBits(await textOf(this.byTestId('qbit-send-plan-review-receives'))),
      totalFee: sendPlanAmountBits(await textOf(this.byTestId('qbit-send-plan-review-total-fee'))),
      transactions: await textOf(this.byTestId('qbit-send-plan-review-transactions')),
      signing: await textOf(this.byTestId('qbit-send-plan-review-signing')),
      budget: await textOf(this.byTestId('qbit-send-plan-review-budget')),
      change: (await change.count()) > 0 ? sendPlanAmountBits(await textOf(change)) : undefined,
    }
  }

  /** The review's one confirmation, which hands over to the progress screen. */
  async confirm(): Promise<void> {
    // The wallet's buttons are not <button> elements: disabled shows as the cursor.
    await expect(this.reviewConfirmButton).toHaveCSS('cursor', 'pointer')
    await this.reviewConfirmButton.click()
    await this.waitForHashRoute('/wallet/tx/plan')
    await expect(this.progress).toBeVisible()
  }

  async waitForPhase(phase: SendPlanPhase, options: { timeout?: number } = {}): Promise<void> {
    await expect(this.state).toHaveAttribute('data-phase', phase, options)
  }

  /** Signatures done and needed, from the progress screen while it signs. */
  async signatureCounts(): Promise<{ done: number; total: number }> {
    return signatureCounts(await textOf(this.signingCount))
  }

  /** Signatures done and needed, from the home screen's card while the plan signs. */
  async resumeSignatureCounts(): Promise<{ done: number; total: number }> {
    return signatureCounts(await textOf(this.resumeStatus))
  }

  /** The home screen's card, which leads back to the progress screen. */
  async openFromHome(): Promise<void> {
    await this.clickTestId('qbit-send-plan-resume-button')
    await this.waitForHashRoute('/wallet/tx/plan')
    await expect(this.progress).toBeVisible()
  }

  /** The success screen's transaction id, once the progress screen hands over to it. */
  async successTxid(options: { timeout?: number } = {}): Promise<string> {
    await expect(this.page).toHaveURL(/#\/wallet\/tx\/success(?:$|\?)/, options)
    await expect(this.successTxidMarker).toHaveAttribute('data-txid', /^[0-9a-f]{64}$/)
    return this.requiredAttribute(this.successTxidMarker, 'data-txid')
  }
}
