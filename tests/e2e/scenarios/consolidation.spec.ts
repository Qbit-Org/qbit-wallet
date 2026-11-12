import { ConsolidationPage, refusedAccountStatus, SendPage } from '../pages'
import { expect, test } from '../fixtures/test'
import { dropBrowserHttpCache } from '../support/browser-cache'
import type { RegtestController } from '../support/regtest'
import { provisionDeterministicRegtestWallet } from '../support/wallet-setup'

/** Chooses the plan below: `short` or `full`. */
const PLAN_VARIABLE = 'QBIT_E2E_CONSOLIDATION_PLAN'

/**
 * The most inputs a batch of this account carries, and the default size:
 * 106 single-key P2MR inputs to one output (398,827 bytes) fit qbit Core's
 * 400,000-byte standard size, and 107 do not.
 */
const MAX_BATCH_INPUTS = 106
const MIN_BATCH_INPUTS = 2

/** The regtest explorer's listing limit, electrs' default `--utxos-limit`. */
const EXPLORER_UTXO_LIMIT = 500
/** electrs' answer to a listing past its limit (`src/rest.rs`, `TooManyUtxos`). */
const EXPLORER_REFUSAL_STATUS = 400
const EXPLORER_REFUSAL_BODY = `Too many unspent transaction outputs (>${EXPLORER_UTXO_LIMIT}). Contact support to raise limits.`

/**
 * The auto-lock time of one hour (`getAutoLockTimes`, @qbit/wallet-shared).
 * An auto-lock that falls due during a signing waits for it, then locks a
 * minute after it ends, whatever the screen does meanwhile: a batch signing
 * for longer than the 3-minute default on a slow runner would lock the
 * wallet during the next batch. An hour outlasts each plan's budget.
 */
const AUTO_LOCK_ONE_HOUR_ID = 6
const AUTO_LOCK_ONE_HOUR_MS = 60 * 60_000

const FINAL_SEND_QBT = '1'

interface ConsolidationPlan {
  name: 'short' | 'full'
  /** Mature coinbase outputs the account holds before the first batch, one per block. */
  fundedOutputs: number
  /** The inputs of each batch, in order: the maximum, then the plan's smaller size last. */
  batchSizes: readonly number[]
  /** The inputs the batches consolidate together. */
  inputsConsolidated: number
}

// Each batch of n inputs removes n - 1 outputs, so both plans end under the
// explorer's limit (610 - 105 - 8 = 497; 940 - 4 * 105 - 29 = 491): an account
// the explorer keeps refusing, since it once held more.
const PLANS: readonly ConsolidationPlan[] = [
  { name: 'short', fundedOutputs: 610, batchSizes: [106, 9], inputsConsolidated: 115 },
  {
    name: 'full',
    fundedOutputs: 940,
    batchSizes: [106, 106, 106, 106, 30],
    inputsConsolidated: 454,
  },
]

/**
 * The plan `QBIT_E2E_CONSOLIDATION_PLAN` names. Unset or empty, it is
 * `short` in CI (`CI=true`, the switch playwright.config.ts reads) and
 * `full` otherwise; any other value names no plan.
 */
function chooseConsolidationPlan(): { plan: ConsolidationPlan } | { refusal: string } {
  const requested = process.env[PLAN_VARIABLE] || ''
  const name = requested || (process.env['CI'] === 'true' ? 'short' : 'full')
  const plan = PLANS.find(candidate => candidate.name === name)
  if (plan) return { plan }
  return {
    refusal: `${PLAN_VARIABLE}=${JSON.stringify(requested)} names no consolidation plan: use "short" or "full", or leave it unset`,
  }
}

const choice = chooseConsolidationPlan()

// One budget per plan, for the setup, the funding, every batch and the
// final send. A batch's signing takes about 0.9 s per input on the test VM;
// its bound allows 3 s per input for slower runners.
const SETUP_AND_SEND_BUDGET_MS = 5 * 60_000
const BATCH_BUDGET_MS = 90_000
const PREPARE_TIMEOUT_MS = 90_000

function signingBudgetMs(inputs: number): number {
  return 30_000 + inputs * 3_000
}

function planBudgetMs(plan: ConsolidationPlan): number {
  return plan.batchSizes.reduce(
    (budget, size) => budget + BATCH_BUDGET_MS + signingBudgetMs(size),
    SETUP_AND_SEND_BUDGET_MS
  )
}

interface VerboseTransaction {
  txid: string
  vin: { txid: string; vout: number }[]
  vout: { value: number; scriptPubKey: { address?: string } }[]
}

/** The address each input of `transaction` spends from, read from its funding transaction. */
async function inputAddresses(
  regtest: RegtestController,
  transaction: VerboseTransaction
): Promise<(string | undefined)[]> {
  const funding = new Map<string, VerboseTransaction>()
  const addresses: (string | undefined)[] = []
  for (const input of transaction.vin) {
    let source = funding.get(input.txid)
    if (!source) {
      source = await regtest.rpc<VerboseTransaction>('getrawtransaction', [input.txid, true])
      funding.set(input.txid, source)
    }
    addresses.push(source.vout[input.vout]?.scriptPubKey.address)
  }
  return addresses
}

async function confirmedAndPending(
  regtest: RegtestController,
  address: string
): Promise<{ confirmedOutputs: number; pendingTransactions: number; pendingSpent: number }> {
  const stats = await regtest.electrsAddressStats(address)
  return {
    confirmedOutputs: stats.chain_stats.funded_txo_count - stats.chain_stats.spent_txo_count,
    pendingTransactions: stats.mempool_stats.tx_count,
    pendingSpent: stats.mempool_stats.spent_txo_count,
  }
}

/** The regtest explorer's own answer: it refuses the listing, stating its limit. */
async function expectExplorerRefusal(regtest: RegtestController, address: string): Promise<void> {
  const listing = await regtest.electrsUtxoListing(address)
  expect(listing.status).toBe(EXPLORER_REFUSAL_STATUS)
  expect(listing.contentType).toMatch(/^text\/plain\b/)
  expect(listing.body.trim()).toBe(EXPLORER_REFUSAL_BODY)
}

test.beforeAll(() => {
  // A value that names no plan fails here, before the harness is reset.
  if ('refusal' in choice) throw new Error(choice.refusal)
})

const planTitle = 'plan' in choice ? `${choice.plan.name} plan` : `invalid ${PLAN_VARIABLE}`

test(`G3 consolidation (${planTitle}): merges a refused account batch by batch, then sends from its history`, async ({
  extension,
  pqcMetrics,
  regtest,
}) => {
  if ('refusal' in choice) throw new Error(choice.refusal)
  const { plan } = choice
  expect(plan.batchSizes.reduce((sum, size) => sum + size, 0)).toBe(plan.inputsConsolidated)
  expect(plan.batchSizes.every(size => size >= MIN_BATCH_INPUTS && size <= MAX_BATCH_INPUTS)).toBe(
    true
  )
  const budgetMs = planBudgetMs(plan)
  expect(budgetMs).toBeLessThan(AUTO_LOCK_ONE_HOUR_MS)
  test.setTimeout(budgetMs)

  const setup = await provisionDeterministicRegtestWallet(extension)
  const account = setup.address
  regtest.trackAccount(account)
  regtest.trackAccount(setup.temporaryAddress)
  await extension.requestWalletController<void>(setup.page, 'setAutoLockTimeId', [
    AUTO_LOCK_ONE_HOUR_ID,
  ])
  expect(await extension.requestWalletController<number>(setup.page, 'getAutoLockTimeId')).toBe(
    AUTO_LOCK_ONE_HOUR_ID
  )
  // Under xvfb-run, Xvfb's screen saver starts 10 minutes after the server last
  // reset, since Playwright's input is no X input; Chrome then reports the
  // computer locked, and the wallet locks on that by default (Security).
  await extension.requestWalletController<void>(setup.page, 'setLockOnComputerLock', [false])
  expect(
    await extension.requestWalletController<boolean>(setup.page, 'getLockOnComputerLock')
  ).toBe(false)

  // A miner's payout address: one coinbase output per block, all mature.
  await test.step(`fund ${plan.fundedOutputs} coinbase outputs`, async () => {
    await regtest.mineMatureCoinbaseOutputs(account, plan.fundedOutputs)
  })

  // The explorer itself refuses the listing, while its statistics count
  // every output.
  const funded = await regtest.electrsAddressStats(account)
  expect(funded.chain_stats).toMatchObject({
    funded_txo_count: plan.fundedOutputs,
    spent_txo_count: 0,
    tx_count: plan.fundedOutputs,
  })
  expect(funded.mempool_stats.tx_count).toBe(0)
  await expectExplorerRefusal(regtest, account)
  // The wallet read the account before the funding, while the explorer still
  // listed it, and on a fast runner the funding ends within the 10 s such a
  // reply may be reused: without this the send screen reads that listing.
  await dropBrowserHttpCache(setup.page)

  const consolidation = new ConsolidationPage(setup.page)
  await test.step('the send screen offers consolidation', async () => {
    await setup.page.reload({ waitUntil: 'domcontentloaded' })
    await setup.home.waitUntilReady()
    await setup.home.openSend()
    await expect(consolidation.sendConsolidateButton).toBeVisible()
    await expect(consolidation.sendNote).toBeVisible()
    await consolidation.openFromSend()
  })

  await test.step('the consolidation screen before any batch', async () => {
    // Its first read since the funding and the cache drop: the explorer's
    // current answer, read once.
    await consolidation.expectStatus(refusedAccountStatus(plan.fundedOutputs, EXPLORER_UTXO_LIMIT))
    await expect(consolidation.batchSizeInput).toHaveValue(String(MAX_BATCH_INPUTS))
    expect(await consolidation.rangeNumbers()).toEqual([MIN_BATCH_INPUTS, MAX_BATCH_INPUTS])
    const openingPreview = await consolidation.readFeePreview()
    expect(openingPreview.batchSize).toBe(MAX_BATCH_INPUTS)
    await expect(consolidation.costNote).toHaveCount(0)
    for (const refused of [MIN_BATCH_INPUTS - 1, MAX_BATCH_INPUTS + 1]) {
      await consolidation.expectBatchSizeRefused(String(refused), [
        MIN_BATCH_INPUTS,
        MAX_BATCH_INPUTS,
      ])
    }
    await consolidation.chooseMaxBatchSize()
    await expect(consolidation.batchSizeInput).toHaveValue(String(MAX_BATCH_INPUTS))
    await expect(consolidation.batchSizeError).toHaveCount(0)
    expect(await consolidation.rangeNumbers()).toEqual([MIN_BATCH_INPUTS, MAX_BATCH_INPUTS])
    expect(await consolidation.readFeePreview()).toEqual(openingPreview)
    await consolidation.expectPrepareEnabled(true)
  })

  // Each batch is mined before the next is prepared, in both plans, so the
  // screen's count follows the work. An unmined batch's inputs still count
  // as confirmed outputs, shown as pending, and the send guard holds them:
  // with the batches left unmined the count would move only at the end.
  let confirmedOutputs = plan.fundedOutputs
  const consolidatedOutpoints = new Set<string>()
  for (const [index, size] of plan.batchSizes.entries()) {
    await test.step(`batch ${index + 1} of ${plan.batchSizes.length}: ${size} inputs`, async () => {
      // The first batch goes at 106, which Max restored after the refused
      // sizes above; each later one opens at the size of the batch before it,
      // and only a size that differs is typed. A size under the maximum has
      // the cost note.
      const openingSize = index === 0 ? MAX_BATCH_INPUTS : plan.batchSizes[index - 1]!
      await expect(consolidation.batchSizeInput).toHaveValue(String(openingSize))
      if (size !== openingSize) await consolidation.setBatchSize(String(size))
      if (size < MAX_BATCH_INPUTS) {
        expect(await consolidation.costNoteNumbers()).toEqual(
          expect.arrayContaining([size, MAX_BATCH_INPUTS])
        )
      } else {
        await expect(consolidation.costNote).toHaveCount(0)
      }
      const preview = await consolidation.readFeePreview()
      expect(preview.batchSize).toBe(size)

      // Every funded output is mature and worth far more than the fee its
      // input adds, so the history walk fills a batch from its newest pages
      // (25 rows each), well within its page budget: no Prepare is asked
      // to be repeated.
      const { batch, error } = await consolidation.prepare(PREPARE_TIMEOUT_MS)
      expect(error, 'Prepare should build the batch at once').toBeUndefined()
      expect(batch?.inputCount, 'the prepared batch').toBe(size)
      if (!batch) throw new Error('Prepare showed no batch')
      expect(batch.feeBaseUnits).toBe(preview.feeBaseUnits)

      await consolidation.continueToReview()
      const review = new SendPage(setup.page)
      expect(await review.exactFeeBaseUnits()).toBe(batch.feeBaseUnits)
      expect(await review.reviewedInputCount()).toBe(size)
      const signed = await consolidation.signAndBroadcast(signingBudgetMs(size))
      regtest.trackTransaction(signed.transactionId)
      pqcMetrics.record({
        accountId: account,
        durationMs: signed.durationMs,
        inputCount: size,
        operation: 'wallet-consolidation-sign',
        transactionId: signed.transactionId,
      })
      await regtest.waitForMempoolTransaction(signed.transactionId)
      expect(await regtest.mempoolFeeBaseUnits(signed.transactionId)).toBe(batch.feeBaseUnits)

      const transaction = await regtest.rpc<VerboseTransaction>('getrawtransaction', [
        signed.transactionId,
        true,
      ])
      expect(transaction.vin).toHaveLength(size)
      expect(transaction.vin.length).toBeLessThanOrEqual(MAX_BATCH_INPUTS)
      expect(await inputAddresses(regtest, transaction)).toEqual(transaction.vin.map(() => account))
      expect(transaction.vout.map(output => output.scriptPubKey.address)).toEqual([account])
      for (const input of transaction.vin) {
        const outpoint = `${input.txid}:${input.vout}`
        expect(consolidatedOutpoints.has(outpoint), `${outpoint} spent by two batches`).toBe(false)
        consolidatedOutpoints.add(outpoint)
      }

      await expect
        .poll(() => confirmedAndPending(regtest, account), {
          message: `the explorer to show batch ${signed.transactionId} pending`,
          timeout: 30_000,
        })
        .toEqual({ confirmedOutputs, pendingTransactions: 1, pendingSpent: size })
      // After every batch, the last included: the screen opens again at the
      // size just sent, with the batch pending until its block. The cache
      // drop keeps it from reading a reply from before the broadcast.
      await dropBrowserHttpCache(setup.page)
      await consolidation.continueWithNextBatch()
      await expect(consolidation.batchSizeInput).toHaveValue(String(size))
      await consolidation.expectStatus(
        refusedAccountStatus(confirmedOutputs, EXPLORER_UTXO_LIMIT, size)
      )

      await regtest.mine(1)
      confirmedOutputs -= size - 1
      await expect
        .poll(() => confirmedAndPending(regtest, account), {
          message: `the explorer to show batch ${signed.transactionId} confirmed`,
          timeout: 30_000,
        })
        .toEqual({ confirmedOutputs, pendingTransactions: 0, pendingSpent: 0 })
      // The explorer shows the block: no reply from before it may answer the
      // screen, which reads the counts once as it opens again.
      await dropBrowserHttpCache(setup.page)
      await consolidation.reopen()
      await consolidation.expectStatus(refusedAccountStatus(confirmedOutputs, EXPLORER_UTXO_LIMIT))
      await expect(consolidation.batchSizeInput).toHaveValue(String(size))
    })
  }
  expect(consolidatedOutpoints.size).toBe(plan.inputsConsolidated)

  // electrs never lists an address again once its outputs passed the limit,
  // so the account is refused under the limit: the wallet must still offer
  // consolidation and read the outputs a send spends from the history.
  await test.step('below the limit, the explorer still refuses, and a send reads the history', async () => {
    expect(await confirmedAndPending(regtest, account)).toEqual({
      confirmedOutputs,
      pendingTransactions: 0,
      pendingSpent: 0,
    })
    expect(confirmedOutputs).toBeLessThanOrEqual(EXPLORER_UTXO_LIMIT)
    await expectExplorerRefusal(regtest, account)

    // From the consolidation screen the last batch reopened, to Send by way
    // of the home screen, and a fresh consolidation screen from there: one
    // with no route state opens at the maximum. The chain has not changed
    // since the last cache drop, so its one read shows the final counts.
    await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`, {
      waitUntil: 'domcontentloaded',
    })
    await setup.home.waitUntilReady()
    await setup.home.openSend()
    await expect(consolidation.sendNote).toBeVisible()
    await consolidation.openFromSend()
    await expect(consolidation.batchSizeInput).toHaveValue(String(MAX_BATCH_INPUTS))
    await consolidation.expectStatus(refusedAccountStatus(confirmedOutputs, EXPLORER_UTXO_LIMIT))
    // The explorer's answer decides, not the count: a batch is still built
    // under the limit. It is left unsigned, which holds none of its inputs.
    const underLimit = await consolidation.prepare(PREPARE_TIMEOUT_MS)
    expect(underLimit.error, 'Prepare under the limit should build a batch').toBeUndefined()
    expect(underLimit.batch?.inputCount).toBe(MAX_BATCH_INPUTS)
    await setup.page.goBack()

    const send = new SendPage(setup.page)
    await send.enterTransfer(setup.temporaryAddress, FINAL_SEND_QBT)
    await expect(consolidation.sendConsolidateButton).toBeVisible()
    await expect(consolidation.sendNote).toBeVisible()
    const inputCount = await send.estimatedInputCount()
    await send.continueToReview()
    const displayedFee = await send.exactFeeBaseUnits()
    expect(await send.reviewedInputCount()).toBe(inputCount)
    const sent = await send.signAndBroadcast()
    regtest.trackTransaction(sent.transactionId)
    pqcMetrics.record({
      accountId: account,
      durationMs: sent.durationMs,
      inputCount,
      operation: 'wallet-send-sign',
      transactionId: sent.transactionId,
    })
    await regtest.waitForMempoolTransaction(sent.transactionId)
    expect(await regtest.mempoolFeeBaseUnits(sent.transactionId)).toBe(displayedFee)
    const transaction = await regtest.rpc<VerboseTransaction>('getrawtransaction', [
      sent.transactionId,
      true,
    ])
    expect(transaction.vin).toHaveLength(inputCount)
    expect(await inputAddresses(regtest, transaction)).toEqual(transaction.vin.map(() => account))
    expect(
      transaction.vout.find(output => output.scriptPubKey.address === setup.temporaryAddress)?.value
    ).toBe(Number(FINAL_SEND_QBT))
    await send.finishSuccess()
  })
})
