import type { Locator, Page, TestInfo } from '@playwright/test'

import { SendPage, SendPlanPage, WalletHomePage } from '../pages'
import { expect, test } from '../fixtures/test'
import type { ExtensionSession } from '../support/extension-session'
import type { RegtestController } from '../support/regtest'
import { onboardNewRegtestWallet } from '../support/wallet-setup'

// 214 equal outputs, two more than two full merges carry (2 x 106). Sending
// them all takes two merges of 106 inputs each and a payment of 4 inputs:
// both merges' outputs and the 2 outputs left over. One signature per input:
// 216.
const OUTPUT_COUNT = 214
const OUTPUT_BITS = 1_000_000
const MERGE_INPUTS = 106
const PAYMENT_INPUTS = 4
const SIGNATURES = 2 * MERGE_INPUTS + PAYMENT_INPUTS

// The popup's size (Responsive.tsx): every screen of the flow is shown, and
// photographed, at it.
const POPUP_VIEWPORT = { width: 357, height: 600 }

// The longest auto-lock (4 hours). The default 3 minutes falls due about when
// signing the 216 signatures ends: just after it at the pace measured here,
// during it on a slower machine, where the plan holds the auto-lock until
// signing ends. Either way the wallet then locks, and the progress screen
// gives way to the unlock screen at a point that depends on the machine. The
// scenario follows the one confirmation through the progress screen, so it
// chooses the longest auto-lock first, as a user may.
const LONGEST_AUTO_LOCK_ID = 7

interface PlanStepView {
  kind: 'merge' | 'payment'
  txid: string
  inputCount: number
  fee: number
  status: string
}

interface PlanView {
  amount: number
  totalFee: number
  feeRate: number
  phase: string
  steps: PlanStepView[]
  signaturesDone: number
  signaturesTotal: number
  paymentTxid: string
}

interface VerboseTransaction {
  txid: string
  blockhash?: string
  vin: { txid: string; vout: number }[]
  vout: { n: number; value: number; scriptPubKey: { address?: string } }[]
}

interface UtxoProbe {
  txid: string
}

interface ElectrsTransaction {
  txid: string
}

function bits(coins: number): number {
  return Math.round(coins * 100_000_000)
}

async function planView(extension: ExtensionSession, page: Page): Promise<PlanView> {
  const view = await extension.requestWalletController<PlanView | null>(page, 'getQbitSendPlan')
  if (!view) throw new Error('the account has no send plan')
  return view
}

/** What the transaction paid in fees: what it spent less what it pays. */
async function feeOf(
  regtest: RegtestController,
  transaction: VerboseTransaction,
  parents: Map<string, VerboseTransaction>
): Promise<number> {
  let spent = 0
  for (const input of transaction.vin) {
    let parent = parents.get(input.txid)
    if (!parent) {
      parent = await regtest.rpc<VerboseTransaction>('getrawtransaction', [input.txid, true])
      parents.set(input.txid, parent)
    }
    const output = parent.vout[input.vout]
    if (!output) throw new Error(`spent output ${input.txid}:${input.vout} is missing`)
    spent += bits(output.value)
  }
  return spent - transaction.vout.reduce((sum, output) => sum + bits(output.value), 0)
}

function outputsTo(transaction: VerboseTransaction, address: string): VerboseTransaction['vout'] {
  return transaction.vout.filter(output => output.scriptPubKey.address === address)
}

/**
 * The screen's key elements are whole in the popup-sized page without
 * scrolling; the screen is attached for review, as on every run.
 */
async function expectAboveTheFold(
  testInfo: TestInfo,
  page: Page,
  name: string,
  keys: readonly Locator[]
): Promise<void> {
  for (const key of keys) await expect(key).toBeInViewport({ ratio: 1 })
  await testInfo.attach(`send-plan-${name}.png`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
}

test('G3 send plan: one confirmation combines 214 outputs in two merges, then pays them all in one payment', async ({
  extension,
  pqcMetrics,
  regtest,
}, testInfo) => {
  // Measured in three local runs: 207-243 s, of which signing the 216
  // signatures took 174-204 s and funding 9-11 s. The gate's runners sign
  // at about 1.25 s a signature (QBIT_SEND_PLAN_SECONDS_PER_SIGNATURE), so
  // signing alone takes about 4.5 min there; twice the expected 6 min.
  test.setTimeout(12 * 60_000)
  const testStartedAt = performance.now()

  const setup = await onboardNewRegtestWallet(extension)
  regtest.trackAccount(setup.address)
  await extension.requestWalletController<void>(setup.page, 'setAutoLockTimeId', [
    LONGEST_AUTO_LOCK_ID,
  ])

  const fundingStartedAt = performance.now()
  const funding = await regtest.fundOutputs(setup.address, OUTPUT_COUNT, OUTPUT_BITS)
  const fundingMs = performance.now() - fundingStartedAt
  const recipient = await regtest.rpc<string>(
    'getnewaddress',
    ['send-plan-recipient'],
    process.env['QBIT_FUNDING_WALLET'] || 'qbit-funding'
  )
  regtest.trackAccount(recipient)
  await expect
    .poll(
      async () =>
        (await extension.requestWalletController<UtxoProbe[]>(setup.page, 'getQbitUtxos')).filter(
          utxo => utxo.txid === funding.txid
        ).length,
      { timeout: 60_000, intervals: [250, 500, 1_000] }
    )
    .toBe(OUTPUT_COUNT)

  // Send everything: the recipient, then MAX.
  const page = setup.page
  await page.setViewportSize(POPUP_VIEWPORT)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await setup.home.waitUntilReady()
  await setup.home.openSend()
  const send = new SendPage(page)
  await send.waitForCreate()
  await send.recipientInput.fill(recipient)
  await send.pressMax()

  const plan = new SendPlanPage(page)
  const notice = await plan.readNotice()
  expect(notice.title).toBe('Sending your whole balance needs 3 transactions')
  expect(notice.steps).toBe('2 to combine your funds, then the payment.')
  expect(notice.signing).toMatch(new RegExp(`^${SIGNATURES} signatures · `))
  // Nothing stays behind: every output is worth more than its own input's
  // fee, so what the outputs hold reaches the recipient or pays a fee.
  expect(notice.leftBehind).toBeUndefined()
  expect(notice.receives + notice.totalFee).toBe(OUTPUT_COUNT * OUTPUT_BITS)
  // Next follows the form's other fields, below the fold at this size as for
  // any send; the notice above it is whole.
  await expectAboveTheFold(testInfo, page, 'send-notice', [plan.notice])

  // One review, one confirmation. From here on the test presses nothing in
  // the wallet but the home screen's way back to the progress screen.
  await plan.openReview()
  const review = await plan.readReview()
  expect(review.recipient).toBe(recipient)
  expect(review.receives).toBe(notice.receives)
  expect(review.totalFee).toBe(notice.totalFee)
  expect(review.transactions).toBe(notice.steps)
  expect(review.change).toBeUndefined()
  expect(review.signing).toBe(notice.signing)
  await expectAboveTheFold(testInfo, page, 'review', [
    page.getByTestId('qbit-send-plan-review-recipient'),
    page.getByTestId('qbit-send-plan-review-receives'),
    page.getByTestId('qbit-send-plan-review-total-fee'),
    page.getByTestId('qbit-send-plan-review-signing'),
    plan.reviewConfirmButton,
  ])
  const confirmedAt = performance.now()
  await plan.confirm()
  await plan.waitForPhase('signing')

  const started = await planView(extension, page)
  expect(started.steps.map(step => [step.kind, step.inputCount])).toEqual([
    ['merge', MERGE_INPUTS],
    ['merge', MERGE_INPUTS],
    ['payment', PAYMENT_INPUTS],
  ])
  expect(started.amount).toBe(notice.receives)
  expect(started.totalFee).toBe(notice.totalFee)
  expect(started.signaturesTotal).toBe(SIGNATURES)
  const mergeTxids = started.steps.filter(step => step.kind === 'merge').map(step => step.txid)
  const paymentTxid = started.paymentTxid
  expect(started.steps[2]?.txid).toBe(paymentTxid)
  mergeTxids.forEach(txid => regtest.trackTransaction(txid))
  regtest.trackTransaction(paymentTxid)

  // Leave while it signs: close the page, open the wallet again, and follow
  // the home screen's card back to the progress screen.
  await expect
    .poll(async () => (await plan.signatureCounts()).done, { timeout: 60_000 })
    .toBeGreaterThan(0)
  await expectAboveTheFold(testInfo, page, 'signing', [
    page.getByTestId('qbit-send-plan-amount'),
    plan.signingCount,
    page.getByTestId('qbit-send-plan-stages'),
  ])
  const signedWhenClosed = (await planView(extension, page)).signaturesDone
  await page.close()

  const reopened = await extension.openWallet('/main')
  await reopened.setViewportSize(POPUP_VIEWPORT)
  const home = new WalletHomePage(reopened)
  await home.waitUntilReady()
  const resumed = new SendPlanPage(reopened)
  // Signing went on with no wallet page open: past the one signature that
  // may have been under way when the page closed.
  await expect
    .poll(async () => (await resumed.resumeSignatureCounts()).done, { timeout: 60_000 })
    .toBeGreaterThan(signedWhenClosed + 1)
  await expectAboveTheFold(testInfo, reopened, 'home-card', [resumed.resumeCard, home.balanceCard])
  await resumed.openFromHome()
  await resumed.waitForPhase('signing')

  // Every merge is sent as soon as it is signed; the payment is signed
  // last, and then the plan waits for the merges to confirm.
  await resumed.waitForPhase('waiting', { timeout: 10 * 60_000 })
  const signingMs = performance.now() - confirmedAt
  pqcMetrics.record({
    accountId: setup.address,
    durationMs: signingMs,
    inputCount: SIGNATURES,
    operation: 'wallet-send-plan-sign',
    transactionId: paymentTxid,
  })
  await expectAboveTheFold(testInfo, reopened, 'waiting', [
    reopened.getByTestId('qbit-send-plan-amount'),
    reopened.getByTestId('qbit-send-plan-stages'),
    reopened.getByTestId('qbit-send-plan-note'),
  ])
  const mempool = await regtest.rpc<string[]>('getrawmempool')
  expect([...mempool].sort()).toEqual([...mergeTxids].sort())
  for (const txid of mempool) {
    const transaction = await regtest.rpc<VerboseTransaction>('getrawtransaction', [txid, true])
    expect(outputsTo(transaction, recipient)).toHaveLength(0)
  }
  expect(
    await regtest.electrsJson<ElectrsTransaction[]>(`/address/${encodeURIComponent(recipient)}/txs`)
  ).toEqual([])

  // One block confirms both merges; the wallet sends the payment by itself.
  const [mergeBlock] = await regtest.mine(1)
  const minedAt = performance.now()
  await expect
    .poll(() => regtest.rpc<string[]>('getrawmempool'), {
      timeout: 90_000,
      intervals: [250, 500, 1_000],
    })
    .toEqual([paymentTxid])
  const paymentSentMs = performance.now() - minedAt
  expect(await resumed.successTxid({ timeout: 60_000 })).toBe(paymentTxid)
  await expectAboveTheFold(testInfo, reopened, 'success', [
    reopened.getByText('Transaction Sent', { exact: true }),
    reopened.getByTestId('tx-success-done-button'),
  ])
  const [paymentBlock] = await regtest.mine(1)

  // On chain: each merge spends 106 of the funding outputs and pays the
  // account's own address in one output.
  const parents = new Map<string, VerboseTransaction>()
  const merges: VerboseTransaction[] = []
  for (const txid of mergeTxids) {
    const merge = await regtest.rpc<VerboseTransaction>('getrawtransaction', [txid, true])
    expect(merge.blockhash).toBe(mergeBlock)
    expect(merge.vin).toHaveLength(MERGE_INPUTS)
    expect(merge.vin.every(input => input.txid === funding.txid)).toBe(true)
    expect(merge.vout).toHaveLength(1)
    expect(merge.vout[0]?.scriptPubKey.address).toBe(setup.address)
    merges.push(merge)
  }

  // The payment spends output 0 of both merges and the 2 funding outputs
  // left over, and pays the recipient exactly the amount shown, in its one
  // output.
  const payment = await regtest.rpc<VerboseTransaction>('getrawtransaction', [paymentTxid, true])
  expect(payment.blockhash).toBe(paymentBlock)
  expect(payment.vin).toHaveLength(PAYMENT_INPUTS)
  expect(
    payment.vin
      .filter(input => mergeTxids.includes(input.txid))
      .map(input => `${input.txid}:${input.vout}`)
      .sort()
  ).toEqual(mergeTxids.map(txid => `${txid}:0`).sort())
  expect(payment.vin.filter(input => input.txid === funding.txid)).toHaveLength(
    PAYMENT_INPUTS - mergeTxids.length
  )
  // Between them the three transactions spend every funding output once.
  expect(
    [...merges, payment]
      .flatMap(transaction => transaction.vin)
      .filter(input => input.txid === funding.txid)
      .map(input => input.vout)
      .sort((a, b) => a - b)
  ).toEqual(funding.vouts)
  expect(payment.vout).toHaveLength(1)
  const paid = outputsTo(payment, recipient)
  expect(paid).toHaveLength(1)
  expect(bits(paid[0]?.value ?? 0)).toBe(notice.receives)

  // The recipient received this one transaction and nothing else.
  expect(
    (
      await regtest.electrsJson<ElectrsTransaction[]>(
        `/address/${encodeURIComponent(recipient)}/txs`
      )
    ).map(transaction => transaction.txid)
  ).toEqual([paymentTxid])

  // The three transactions paid exactly the total fee shown.
  let fees = 0
  for (const transaction of [...merges, payment]) {
    fees += await feeOf(regtest, transaction, parents)
  }
  expect(fees).toBe(notice.totalFee)

  // The plan said nothing stays behind, and nothing does.
  expect(
    await regtest.electrsJson<unknown[]>(`/address/${encodeURIComponent(setup.address)}/utxo`)
  ).toEqual([])

  await testInfo.attach('send-plan-timings.json', {
    body: JSON.stringify(
      {
        fundingMs: Math.round(fundingMs),
        signingMs: Math.round(signingMs),
        paymentSentAfterBlockMs: Math.round(paymentSentMs),
        testMs: Math.round(performance.now() - testStartedAt),
        feeRate: started.feeRate,
      },
      null,
      2
    ),
    contentType: 'application/json',
  })
})
