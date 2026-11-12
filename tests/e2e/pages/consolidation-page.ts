import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'
import type { PqcSignResult } from './send-page'

/** What the consolidation screen's status lines show. */
export interface ConsolidationStatus {
  /** The confirmed outputs the status line names (`$1 confirmed outputs`). */
  confirmedOutputs: number
  /** The limit it says the explorer lists up to (`lists up to $2`), or null when it names none. */
  statedLimit: number | null
  /** Whether the line saying the explorer keeps refusing is shown. */
  refusalShown: boolean
  /** The outputs pending transactions spend, as the pending line names them; 0 without that line. */
  pendingSpent: number
}

/** The status of an account the explorer refuses, as the screen should show it. */
export function refusedAccountStatus(
  confirmedOutputs: number,
  statedLimit: number,
  pendingSpent = 0
): ConsolidationStatus {
  return { confirmedOutputs, statedLimit, refusalShown: true, pendingSpent }
}

/** A prepared batch, as its summary names it. */
export interface ConsolidationBatchSummary {
  inputCount: number
  feeBaseUnits: number
}

/** What a Prepare ended with: the batch, or the error that says why there is none. */
export interface ConsolidationPrepareOutcome {
  batch: ConsolidationBatchSummary | undefined
  error: string | undefined
}

/** The fee of a full batch at the chosen size, as the screen previews it before Prepare. */
export interface ConsolidationFeePreview {
  batchSize: number
  feeBaseUnits: number
}

/** The integers `text` names, in order. */
function integersIn(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map(match => Number(match[0]))
}

/** The integer before `unit` in `text`, such as the 106 of "106 outputs". */
function integerBefore(text: string, unit: string, what: string): number {
  const match = text.match(new RegExp(`(\\d+)\\s*${unit}\\b`, 'i'))
  if (!match?.[1]) throw new Error(`unable to read ${what} from: ${text}`)
  return Number(match[1])
}

/**
 * The consolidation screen (`/wallet/tx/consolidate`) of an account the
 * explorer refuses to list, its entry on the send screen, and the confirm
 * and success screens of its batches. Its lines are read for the numbers
 * they name.
 */
export class ConsolidationPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  /** The send screen's note on an account the explorer refuses. */
  get sendNote(): Locator {
    return this.byTestId('consolidation-send-note')
  }

  /** The send screen's "Consolidate outputs". */
  get sendConsolidateButton(): Locator {
    return this.byTestId('tx-consolidate-button')
  }

  get status(): Locator {
    return this.byTestId('consolidation-status')
  }

  get refusal(): Locator {
    return this.byTestId('consolidation-refusal')
  }

  get pending(): Locator {
    return this.byTestId('consolidation-pending')
  }

  get batchSizeInput(): Locator {
    return this.byTestId('consolidation-batch-size-input')
  }

  get batchSizeMax(): Locator {
    return this.byTestId('consolidation-batch-size-max')
  }

  get batchSizeRange(): Locator {
    return this.byTestId('consolidation-batch-size-range')
  }

  get batchSizeError(): Locator {
    return this.byTestId('consolidation-batch-size-error')
  }

  get feePreview(): Locator {
    return this.byTestId('consolidation-fee-preview')
  }

  get costNote(): Locator {
    return this.byTestId('consolidation-cost-note')
  }

  get batchSummary(): Locator {
    return this.byTestId('consolidation-batch')
  }

  get error(): Locator {
    return this.byTestId('consolidation-error')
  }

  get prepareButton(): Locator {
    return this.byTestId('consolidation-prepare-button')
  }

  get nextButton(): Locator {
    return this.byTestId('consolidation-confirm-button')
  }

  /** From the send screen, which offers it for an account the explorer refuses. */
  async openFromSend(): Promise<void> {
    await this.waitForHashRoute('/wallet/tx/create')
    await expect(this.sendConsolidateButton).toBeVisible()
    await this.sendConsolidateButton.click()
    await this.waitUntilReady()
  }

  /** The screen has opened and read the account's status. */
  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/wallet/tx/consolidate')
    await expect(this.status).toBeVisible()
  }

  async readStatus(): Promise<ConsolidationStatus> {
    await expect(this.status).toBeVisible()
    const text = await this.status.innerText()
    const limit = text.match(/\blists up to (\d+)/i)?.[1]
    let pendingSpent = 0
    if ((await this.pending.count()) > 0) {
      const pendingText = await this.pending.innerText()
      const pendingNumbers = integersIn(pendingText)
      if (pendingNumbers.length !== 1) {
        throw new Error(`the pending line should name one count: ${pendingText}`)
      }
      pendingSpent = pendingNumbers[0]!
    }
    return {
      confirmedOutputs: integerBefore(text, 'confirmed outputs', 'the confirmed-output count'),
      statedLimit: limit === undefined ? null : Number(limit),
      refusalShown: await this.refusal.isVisible(),
      pendingSpent,
    }
  }

  /**
   * The screen, as it opened, shows `expected`: one read, no retry. The
   * caller drops the browser's HTTP cache after each change to the chain
   * (`dropBrowserHttpCache`), so the screen's read cannot be an earlier reply.
   */
  async expectStatus(expected: ConsolidationStatus): Promise<void> {
    await this.waitUntilReady()
    expect(await this.readStatus(), 'the consolidation screen status').toEqual(expected)
  }

  /**
   * Opens the screen again, as a reload does: it reads the account's status
   * as it opens, and keeps its route state, so the batch size it opened at.
   */
  async reopen(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    await this.waitUntilReady()
  }

  /** The integers the range hint names: the smallest and the largest batch size. */
  async rangeNumbers(): Promise<number[]> {
    await expect(this.batchSizeRange).toBeVisible()
    return integersIn(await this.batchSizeRange.innerText())
  }

  /** The integers the cost note names, such as the chosen size, the extra percent and the maximum. */
  async costNoteNumbers(): Promise<number[]> {
    await expect(this.costNote).toBeVisible()
    return integersIn(await this.costNote.innerText())
  }

  /**
   * Prepare is a wallet `Button`, a `<div>` with no disabled attribute; a
   * disabled one has no click handler and shows the not-allowed cursor.
   */
  async expectPrepareEnabled(enabled: boolean): Promise<void> {
    await expect(this.prepareButton).toBeVisible()
    await expect(this.prepareButton).toHaveCSS('cursor', enabled ? 'pointer' : 'not-allowed')
  }

  async setBatchSize(text: string): Promise<void> {
    await this.batchSizeInput.fill(text)
    await expect(this.batchSizeInput).toHaveValue(text)
  }

  /**
   * Types `text` as the batch size and expects it refused with an error that
   * names `range`, in place of the range hint, with no fee preview and
   * Prepare disabled.
   */
  async expectBatchSizeRefused(text: string, range: readonly [number, number]): Promise<void> {
    await this.setBatchSize(text)
    await expect(this.batchSizeError).toBeVisible()
    expect(integersIn(await this.batchSizeError.innerText())).toEqual([...range])
    await expect(this.batchSizeRange).toHaveCount(0)
    await expect(this.feePreview).toHaveCount(0)
    await this.expectPrepareEnabled(false)
  }

  /** Max, a real `<button>` next to the field. */
  async chooseMaxBatchSize(): Promise<void> {
    await this.batchSizeMax.click()
  }

  async readFeePreview(): Promise<ConsolidationFeePreview> {
    await expect(this.feePreview).toBeVisible()
    const text = await this.feePreview.innerText()
    return {
      batchSize: integerBefore(text, 'outputs', 'the previewed batch size'),
      feeBaseUnits: integerBefore(text, 'bits', 'the previewed fee'),
    }
  }

  /**
   * Prepare, and wait within `timeout` for its outcome: the batch's summary,
   * the error line, or both. The error line also carries a status read that
   * failed after the batch was built, so it can show beside a batch; each is
   * read on its own and both are returned, for the caller to assert. A
   * Prepare that read part of the history without finding a batch asks to be
   * repeated in that error line too.
   */
  async prepare(timeout: number): Promise<ConsolidationPrepareOutcome> {
    await this.expectPrepareEnabled(true)
    // An error line already shown would be read as this Prepare's.
    await expect(this.error).toHaveCount(0)
    await this.prepareButton.click()
    await expect(
      this.batchSummary.or(this.error).first(),
      'the prepared batch or its error'
    ).toBeVisible({ timeout })
    const error = (await this.error.isVisible()) ? (await this.error.innerText()).trim() : undefined
    if (!(await this.batchSummary.isVisible())) return { batch: undefined, error }
    const text = await this.batchSummary.innerText()
    await expect(this.nextButton).toBeVisible()
    return {
      batch: {
        inputCount: integerBefore(text, 'outputs', 'the batch input count'),
        feeBaseUnits: integerBefore(text, 'bits', 'the batch fee'),
      },
      error,
    }
  }

  /** Next: the prepared batch goes to the confirm screen. */
  async continueToReview(): Promise<void> {
    await this.nextButton.click()
    await this.waitForHashRoute('/wallet/tx/confirm')
    await expect(this.byTestId('psbt-network-fee-base-units')).toBeVisible()
  }

  /**
   * Sign on the batch's confirm screen and wait, within `timeout`, for its
   * broadcast to reach the success screen, and return its txid. A batch of
   * 4 inputs or more signs one input at a time behind the signing progress
   * panel, whose Sign stays `aria-disabled` until the screen is left, so the
   * caller sizes `timeout` to the batch. A batch pays only the account itself
   * at the fee bar's rate, so no risk confirmation may come before its
   * signing. The wait ends at once on the failure screen, on the lock
   * screen, and on the confirm screen's Sign enabled again, where a refused
   * signing returns with an error toast.
   */
  async signAndBroadcast(timeout: number): Promise<PqcSignResult> {
    const signButton = this.byTestId('sign-psbt-button')
    await expect(signButton).toHaveAttribute('aria-disabled', 'false')
    const startedAt = performance.now()
    await signButton.click()

    const riskInput = this.byTestId('risk-confirmation-input')
    const progress = this.byTestId('signing-progress')
    const successTxid = this.byTestId('tx-success-txid')
    const failTxid = this.byTestId('tx-fail-txid')
    const unlockInput = this.byTestId('unlock-password-input')
    const signEnabledAgain = this.page.locator(
      '[data-testid="sign-psbt-button"][aria-disabled="false"]'
    )
    await expect(
      riskInput.or(progress).or(successTxid).first(),
      'the batch signing to start'
    ).toBeAttached()
    if (await riskInput.isVisible()) {
      throw new Error('a consolidation batch asked for a risk confirmation before signing')
    }
    await expect(
      successTxid.or(failTxid).or(unlockInput).or(signEnabledAgain).first(),
      'the batch to be signed and broadcast'
    ).toBeAttached({ timeout })
    if (await unlockInput.isVisible()) {
      throw new Error('the wallet locked before the batch was signed and broadcast')
    }
    if ((await failTxid.count()) > 0) {
      const title = (await this.byTestId('tx-fail-title').innerText()).trim()
      const reason = (await this.byTestId('tx-fail-reason').innerText()).trim()
      const txid = await failTxid.getAttribute('data-txid')
      throw new Error(`the batch ended on the failure screen: ${title}: ${reason} (txid ${txid})`)
    }
    if ((await successTxid.count()) === 0) {
      const toasts = (await this.page.getByRole('alert').allInnerTexts())
        .map(text => text.trim())
        .filter(Boolean)
      throw new Error(
        `the batch signing was refused and the confirm screen offers Sign again: ${toasts.join(' | ') || 'no error toast'}`
      )
    }
    const durationMs = performance.now() - startedAt
    const transactionId = await this.requiredAttribute(successTxid, 'data-txid')
    if (!/^[0-9a-f]{64}$/i.test(transactionId)) {
      throw new Error(`transaction success screen exposed an invalid txid: ${transactionId}`)
    }
    return { durationMs, transactionId }
  }

  /** "Consolidate next batch" on the success screen, which opens this screen again. */
  async continueWithNextBatch(): Promise<void> {
    await this.clickTestId('tx-success-consolidate-button')
    await this.waitUntilReady()
  }
}
