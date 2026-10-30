import { HistoryPage, ReceivePage } from '../pages'
import { expect, test } from '../fixtures/test'
import { provisionDeterministicRegtestWallet, waitForAddressUsed } from '../support/wallet-setup'

test('G3 receive/fund/rotate: tracks funded addresses and preserves safety state', async ({
  extension,
  regtest,
}) => {
  const setup = await provisionDeterministicRegtestWallet(extension)
  regtest.trackAccount(setup.address)
  await setup.home.openReceive()

  const receive = new ReceivePage(setup.page)
  expect(await receive.currentAddress()).toBe(setup.address)
  await receive.expectNoSafetyWarnings()
  await receive.setPaymentDetails('0.00125', 'G3 deterministic receive')

  const rotation = await receive.rotateAddress()
  expect(rotation.previous).toBe(setup.address)
  expect(rotation.current).not.toBe(rotation.previous)
  expect(await receive.previousAddresses()).toContain(rotation.previous)
  regtest.trackAccount(rotation.current)

  const firstFundingTxid = await regtest.fund(rotation.previous, '0.005')
  await waitForAddressUsed(extension, setup.page, rotation.previous)
  await setup.page.reload({ waitUntil: 'domcontentloaded' })
  await receive.waitUntilReady()
  expect(await receive.currentAddress()).toBe(rotation.current)
  await receive.expectPreviousAddressUsed(rotation.previous)
  await receive.expectNoSafetyWarnings()

  const secondFundingTxid = await regtest.fund(rotation.current, '0.002')
  await waitForAddressUsed(extension, setup.page, rotation.current)
  await setup.page.reload({ waitUntil: 'domcontentloaded' })
  await receive.waitUntilReady()
  const nextAddress = await receive.currentAddress()
  expect(nextAddress).not.toBe(rotation.current)
  expect(await receive.previousAddresses()).toEqual(
    expect.arrayContaining([rotation.previous, rotation.current])
  )
  await receive.expectPreviousAddressUsed(rotation.previous)
  await receive.expectPreviousAddressUsed(rotation.current)
  await receive.expectNoSafetyWarnings()
  regtest.trackAccount(nextAddress)

  const snapshot = await regtest.snapshot()
  expect(snapshot.trackedTransactionIds).toEqual(
    expect.arrayContaining([firstFundingTxid, secondFundingTxid])
  )
  expect(snapshot.trackedAccountIds).toEqual(
    expect.arrayContaining([rotation.previous, rotation.current])
  )

  // History covers the selected account only, as the balance card does, and
  // Receive has moved the wallet on to nextAddress. Each funding shows under
  // the account it paid and not under the other.
  const history = new HistoryPage(setup.page)
  for (const { address, funding, other } of [
    { address: rotation.previous, funding: firstFundingTxid, other: secondFundingTxid },
    { address: rotation.current, funding: secondFundingTxid, other: firstFundingTxid },
  ]) {
    await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`, {
      waitUntil: 'domcontentloaded',
    })
    await setup.home.waitUntilReady()
    await setup.home.switchAccount(address)
    const selected = await extension.requestWalletController<{ address: string }>(
      setup.page,
      'getCurrentAccount'
    )
    expect(selected.address).toBe(address)
    await setup.home.openHistory()
    await history.waitUntilReady()
    expect(await history.rowStatus(funding)).toBe('Confirmed')
    expect(await history.transactionIds()).not.toContain(other)
  }
})
