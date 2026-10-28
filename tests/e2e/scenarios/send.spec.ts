import { HistoryPage, ReceivePage, SendPage } from '../pages'
import { expect, test } from '../fixtures/test'
import {
  provisionDeterministicRegtestWallet,
  waitForAddressUsed,
  waitForWalletTransactions,
} from '../support/wallet-setup'

interface VerboseTransaction {
  txid: string
  vin: { txid: string; vout: number; sequence: number }[]
  vout: { value: number; scriptPubKey: { address?: string } }[]
}

interface AddressHistoryProbe {
  detail: { txid: string; confirmations: number }[]
}

function recipientAmount(transaction: VerboseTransaction, recipient: string): number | undefined {
  return transaction.vout.find(output => output.scriptPubKey.address === recipient)?.value
}

test('G3 send: rejects dust and proves single/multi-input fees plus RBF replacement', async ({
  extension,
  pqcMetrics,
  regtest,
}) => {
  test.setTimeout(10 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  regtest.trackAccount(setup.address)
  regtest.trackAccount(setup.temporaryAddress)

  const singleFunding = await regtest.fund(setup.address, '0.005')
  await waitForWalletTransactions(extension, setup.page, [singleFunding])
  await setup.page.reload({ waitUntil: 'domcontentloaded' })
  await setup.home.waitUntilReady()
  await setup.home.openSend()

  let send = new SendPage(setup.page)
  await send.enterTransfer(setup.temporaryAddress, '0.00000001')
  await send.expectDustRejected()
  await send.enterTransfer(setup.temporaryAddress, '0.001')
  await send.chooseFeeRateOption(1)
  await send.setRbf(true)
  expect(await send.estimatedInputCount()).toBe(1)
  await send.continueToReview()

  const singleDisplayedFee = await send.exactFeeBaseUnits()
  expect(await send.reviewedInputCount()).toBe(1)
  expect(await send.signatureBudgetText()).toContain('Signatures: 1 new')
  const single = await send.signAndBroadcast()
  pqcMetrics.record({
    accountId: setup.address,
    durationMs: single.durationMs,
    inputCount: 1,
    operation: 'wallet-send-sign',
    transactionId: single.transactionId,
  })
  regtest.trackTransaction(single.transactionId)
  await regtest.waitForMempoolTransaction(single.transactionId)
  expect(await regtest.mempoolFeeBaseUnits(single.transactionId)).toBe(singleDisplayedFee)

  const singleVerbose = await regtest.rpc<VerboseTransaction>('getrawtransaction', [
    single.transactionId,
    true,
  ])
  const singleRaw = await regtest.rpc<string>('getrawtransaction', [single.transactionId, false])
  expect(recipientAmount(singleVerbose, setup.temporaryAddress)).toBe(0.001)
  expect(singleVerbose.vin.every(input => input.sequence < 0xfffffffe)).toBe(true)

  await send.finishSuccess()
  await regtest.mine(1)
  await waitForAddressUsed(extension, setup.page, setup.address)
  await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/wallet/history`, {
    waitUntil: 'domcontentloaded',
  })
  let history = new HistoryPage(setup.page)
  await history.waitUntilReady()
  expect(await history.rowStatus(single.transactionId)).toBe('Confirmed')
  await history.openTransaction(single.transactionId)
  await history.expectTransactionIoCounts(singleVerbose.vin.length, singleVerbose.vout.length)
  await history.expectRawTransactionPreview(singleRaw)
  expect(Math.round(Number(await history.detailNetworkFeeQbt()) * 100_000_000)).toBe(
    singleDisplayedFee
  )

  await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`, {
    waitUntil: 'domcontentloaded',
  })
  await setup.home.waitUntilReady()
  await setup.home.openReceive()
  const receive = new ReceivePage(setup.page)
  const multiInputAddress = await receive.currentAddress()
  expect(multiInputAddress).not.toBe(setup.address)
  regtest.trackAccount(multiInputAddress)

  const multiFunding: string[] = []
  for (let index = 0; index < 3; index += 1) {
    multiFunding.push(await regtest.fund(multiInputAddress, '0.001'))
  }
  await waitForWalletTransactions(extension, setup.page, multiFunding)
  await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`, {
    waitUntil: 'domcontentloaded',
  })
  await setup.home.waitUntilReady()
  await setup.home.openSend()

  send = new SendPage(setup.page)
  await send.enterTransfer(setup.temporaryAddress, '0.0025')
  await send.chooseFeeRateOption(0)
  await send.setRbf(true)
  expect(await send.estimatedInputCount()).toBe(3)
  await send.expandAdvancedMemo('G3 multi-input RBF')
  await send.continueToReview()

  const originalDisplayedFee = await send.exactFeeBaseUnits()
  expect(await send.reviewedInputCount()).toBe(3)
  expect(await send.signatureBudgetText()).toContain('Signatures: 3 new')
  const original = await send.signAndBroadcast()
  pqcMetrics.record({
    accountId: multiInputAddress,
    durationMs: original.durationMs,
    inputCount: 3,
    operation: 'wallet-send-sign',
    transactionId: original.transactionId,
  })
  regtest.trackTransaction(original.transactionId)
  await regtest.waitForMempoolTransaction(original.transactionId)
  expect(await regtest.mempoolFeeBaseUnits(original.transactionId)).toBe(originalDisplayedFee)
  const originalVerbose = await regtest.rpc<VerboseTransaction>('getrawtransaction', [
    original.transactionId,
    true,
  ])
  const originalRaw = await regtest.rpc<string>('getrawtransaction', [
    original.transactionId,
    false,
  ])
  await send.finishSuccess()

  await setup.home.openHistory()
  history = new HistoryPage(setup.page)
  await history.waitUntilReady()
  expect(await history.rowStatus(original.transactionId)).toBe('Pending')
  await history.openTransaction(original.transactionId)
  await history.expectTransactionIoCounts(originalVerbose.vin.length, originalVerbose.vout.length)
  await history.expectRawTransactionPreview(originalRaw)
  const addresslessOutputIndex = originalVerbose.vout.findIndex(
    output => !output.scriptPubKey.address
  )
  expect(addresslessOutputIndex).toBeGreaterThanOrEqual(0)
  await history.expectOutputAddressUnavailable(addresslessOutputIndex)
  await history.bumpFee()

  send = new SendPage(setup.page)
  const replacementDisplayedFee = await send.exactFeeBaseUnits()
  expect(replacementDisplayedFee).toBeGreaterThan(originalDisplayedFee)
  expect(await send.reviewedInputCount()).toBe(3)
  const replacement = await send.signAndBroadcast()
  pqcMetrics.record({
    accountId: multiInputAddress,
    durationMs: replacement.durationMs,
    inputCount: 3,
    operation: 'wallet-rbf-sign',
    transactionId: replacement.transactionId,
  })
  regtest.trackTransaction(replacement.transactionId)
  expect(replacement.transactionId).not.toBe(original.transactionId)
  await regtest.waitForMempoolTransaction(replacement.transactionId)
  expect(await regtest.mempoolFeeBaseUnits(replacement.transactionId)).toBe(replacementDisplayedFee)

  const mempool = await regtest.rpc<string[]>('getrawmempool')
  expect(mempool).toContain(replacement.transactionId)
  expect(mempool).not.toContain(original.transactionId)
  const replacementVerbose = await regtest.rpc<VerboseTransaction>('getrawtransaction', [
    replacement.transactionId,
    true,
  ])
  expect(recipientAmount(replacementVerbose, setup.temporaryAddress)).toBe(0.0025)
  expect(recipientAmount(replacementVerbose, setup.temporaryAddress)).toBe(
    recipientAmount(originalVerbose, setup.temporaryAddress)
  )
  expect(replacementVerbose.vin.map(input => `${input.txid}:${input.vout}`).sort()).toEqual(
    originalVerbose.vin.map(input => `${input.txid}:${input.vout}`).sort()
  )

  await send.finishSuccess()
  await expect
    .poll(
      async () => {
        const result = await extension.requestWalletController<AddressHistoryProbe>(
          setup.page,
          'getAddressHistory',
          [{ address: multiInputAddress, start: 0, limit: 20 }]
        )
        return {
          original: result.detail.some(item => item.txid === original.transactionId),
          replacement: result.detail.some(item => item.txid === replacement.transactionId),
        }
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toEqual({ original: false, replacement: true })
  await setup.home.openHistory()
  history = new HistoryPage(setup.page)
  await history.waitUntilReady()
  // electrs can transiently keep serving an evicted tx, in which case the
  // mount-time probe leaves the row pending and the history auto-refresh
  // re-verifies it one 60s block cadence later; span two full cadences.
  await history.waitForStatus(original.transactionId, 'Replaced', { timeout: 150_000 })
  expect(await history.rowStatus(replacement.transactionId)).toBe('Pending')
  await regtest.mine(1)
  await expect
    .poll(
      async () => {
        const result = await extension.requestWalletController<AddressHistoryProbe>(
          setup.page,
          'getAddressHistory',
          [{ address: multiInputAddress, start: 0, limit: 20 }]
        )
        return result.detail.find(item => item.txid === replacement.transactionId)?.confirmations
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBeGreaterThan(0)
  await setup.page.reload({ waitUntil: 'domcontentloaded' })
  await history.waitUntilReady()
  await history.waitForStatus(replacement.transactionId, 'Confirmed')
})
