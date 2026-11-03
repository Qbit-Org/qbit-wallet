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
  // A used address stays on screen, flagged, until New Address moves on.
  expect(await receive.currentAddress()).toBe(rotation.current)
  await receive.expectCurrentAddressUsed()
  const nextRotation = await receive.rotateAddress()
  expect(nextRotation.previous).toBe(rotation.current)
  const nextAddress = nextRotation.current
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
  // New Address has moved the wallet on to nextAddress. Each funding shows
  // under the account it paid and not under the other. Receive shows the
  // selected account's own address and keeps that account selected.
  const history = new HistoryPage(setup.page)
  const selectedAddress = async () =>
    (await extension.requestWalletController<{ address: string }>(setup.page, 'getCurrentAccount'))
      .address
  for (const { address, funding, other } of [
    { address: rotation.previous, funding: firstFundingTxid, other: secondFundingTxid },
    { address: rotation.current, funding: secondFundingTxid, other: firstFundingTxid },
  ]) {
    await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`, {
      waitUntil: 'domcontentloaded',
    })
    await setup.home.waitUntilReady()
    await setup.home.switchAccount(address)
    expect(await selectedAddress()).toBe(address)
    await setup.home.openReceive()
    expect(await receive.currentAddress()).toBe(address)
    await receive.expectCurrentAddressUsed()
    expect(await selectedAddress()).toBe(address)
    await setup.page.goBack()
    await setup.home.waitUntilReady()
    await setup.home.openHistory()
    await history.waitUntilReady()
    expect(await history.rowStatus(funding)).toBe('Confirmed')
    expect(await history.transactionIds()).not.toContain(other)
  }
})
