import { ReceivePage, SettingsPage, WalletHomePage } from '../pages'
import { expect, test } from '../fixtures/test'
import {
  E2E_PASSWORD,
  E2E_WRONG_PASSWORD,
  provisionDeterministicRegtestWallet,
  waitForAddressUsed,
  waitForWalletTransactions,
} from '../support/wallet-setup'

interface AddressBalanceProbe {
  amount: string
  confirm_amount: string
  pending_amount: string
}

interface WalletKeyringProbe {
  index: number
}

const AUTO_LOCKED_METHOD = 'walletAutoLocked'
const ONBOARDING_GRACE_PERIOD_MS = 10 * 60 * 1000

test('G3 lock: rejects a wrong password and survives unlock plus browser restart', async ({
  extension,
  regtest,
}) => {
  const setup = await provisionDeterministicRegtestWallet(extension)
  const extensionId = extension.extensionId
  const fundingTxid = await regtest.fund(setup.address, '0.001')
  await waitForWalletTransactions(extension, setup.page, [fundingTxid])
  // Rotation is driven by the receive ledger marking the address used, which
  // lags the UTXO index; wait for it before asserting the address rotated.
  await waitForAddressUsed(extension, setup.page, setup.address)
  const expectedBalance = await extension.requestWalletController<AddressBalanceProbe>(
    setup.page,
    'getAddressBalance',
    [setup.address]
  )

  await setup.home.openReceive()
  const fundedReceive = new ReceivePage(setup.page)
  const safeReceiveAddress = await fundedReceive.currentAddress()
  expect(safeReceiveAddress).not.toBe(setup.address)
  expect(await fundedReceive.previousAddresses()).toContain(setup.address)
  await setup.page.goto(`chrome-extension://${extensionId}/index.html#/main`, {
    waitUntil: 'domcontentloaded',
  })
  await setup.home.waitUntilReady()

  await setup.home.openSettings()
  let settings = new SettingsPage(setup.page)
  await settings.lockWallet()
  await settings.submitWrongPassword(E2E_WRONG_PASSWORD)
  await settings.unlock(E2E_PASSWORD)

  await setup.home.waitUntilReady()
  await setup.home.openReceive()
  expect(await new ReceivePage(setup.page).currentAddress()).toBe(safeReceiveAddress)
  await setup.page.goto(`chrome-extension://${extensionId}/index.html#/settings`, {
    waitUntil: 'domcontentloaded',
  })
  settings = new SettingsPage(setup.page)
  await settings.lockWallet()

  await extension.restart()
  expect(extension.extensionId).toBe(extensionId)
  const restartedPage = await extension.openWallet('/main')
  settings = new SettingsPage(restartedPage)
  await settings.waitForUnlock()
  await settings.submitWrongPassword(E2E_WRONG_PASSWORD)
  await settings.unlock(E2E_PASSWORD)

  const restartedHome = new WalletHomePage(restartedPage)
  await restartedHome.waitUntilReady()
  expect(await restartedHome.networkLabel()).toContain('Regtest')
  await restartedHome.openReceive()
  expect(await new ReceivePage(restartedPage).currentAddress()).toBe(safeReceiveAddress)
  expect(
    await extension.requestWalletController<AddressBalanceProbe>(
      restartedPage,
      'getAddressBalance',
      [setup.address]
    )
  ).toEqual(expectedBalance)
})

test('P2 auto-lock: bounds onboarding keepalive across an MV3 restart', async ({ extension }) => {
  test.setTimeout(240_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  const extensionId = extension.extensionId
  const currentKeyring = await extension.requestWalletController<WalletKeyringProbe>(
    setup.page,
    'getCurrentKeyring'
  )
  expect(currentKeyring.index).toBeGreaterThanOrEqual(0)

  await setup.home.openWalletManagement()
  await setup.page.getByTestId('add-wallet-button').click()
  await setup.page.getByTestId('restore-from-mnemonics-option').click()
  await expect(setup.page).toHaveURL(/#\/account\/create-hd-wallet$/)
  await expect(setup.page.getByTestId('mnemonic-import-word-0')).toBeVisible()

  // Provisioning leaves the browser's initial about:blank page and the
  // onboarding page open. A focus or visibility flip on any wallet page fires
  // IdleTimerProvider onAction -> setLastActiveTime, which restarts the
  // background lock timer, so stray window focus ping-pong between those
  // pages can hold the 30-second auto-lock off past any poll budget. Close
  // everything but this test's page before arming the timer.
  for (const page of extension.context.pages()) {
    if (page !== setup.page) {
      await page.close()
    }
  }

  await extension.captureWalletBroadcasts(setup.page)
  // Advance only the UI's monotonic elapsed-time reading. The background's
  // 30-second auto-lock timer remains real, so this avoids a ten-minute test
  // without weakening or adding a test switch to production behavior.
  await setup.page.evaluate(gracePeriodMs => {
    const monotonicNow = performance.now.bind(performance)
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => monotonicNow() + gracePeriodMs,
    })
  }, ONBOARDING_GRACE_PERIOD_MS)
  await extension.requestWalletController<void>(setup.page, 'setAutoLockTimeId', [0])

  // The lock fires 30 seconds after the last activity refresh; the budget
  // leaves room for a trailing activity burst from the clicks above.
  await expect
    .poll(() => extension.walletBroadcastMethods(setup.page), {
      timeout: 120_000,
      intervals: [250, 500, 1_000],
    })
    .toContain(AUTO_LOCKED_METHOD)
  await setup.page.evaluate(() => {
    delete (performance as unknown as { now?: () => number }).now
  })

  expect(await extension.requestWalletController<boolean>(setup.page, 'isUnlocked')).toBe(false)
  await expect(
    extension.requestWalletController(setup.page, 'getMnemonics', [E2E_PASSWORD, currentKeyring])
  ).rejects.toThrow()

  await extension.restart()
  expect(extension.extensionId).toBe(extensionId)
  const restartedPage = await extension.openWallet('/main')
  // The restarted service worker accepts port connections before its stores
  // finish rehydrating, so an immediate probe can throw ("Cannot read
  // properties of undefined (reading 'getState')"). Retry until the
  // background answers; later requests then see an initialized controller.
  await expect(async () => {
    expect(await extension.requestWalletController<boolean>(restartedPage, 'isUnlocked')).toBe(false)
  }).toPass({ timeout: 30_000 })
  await expect(
    extension.requestWalletController(restartedPage, 'getMnemonics', [E2E_PASSWORD, currentKeyring])
  ).rejects.toThrow()
})
